// src/services/safeBrowsingService.js
// -------------------------------------------------------------------
// Google Safe Browsing v4 lookup service.
// -------------------------------------------------------------------
import { SAFE_BROWSING_ENDPOINT, getSafeBrowsingApiKey } from '../config/safeBrowsingConfig.js';
import { LOG } from '../utils/logger.js';
import { API_RETRY_COUNT, API_RETRY_DELAY_MS } from '../constants.js';

/**
 * Helper: delay for back‑off retries.
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Performs a Safe Browsing lookup for a batch of URLs.
 * The API expects a POST body with a `client` and `threatInfo` object.
 *
 * @param {string[]} urls - array of full URLs to check (max 500 per API spec).
 * @returns {Promise<Object[]>} - resolves to an array of results:
 *   [{ url, threatTypes: ['PHISHING','MALWARE',...], cacheDurationMs }]
 */
export async function lookupUrls(urls) {
  const apiKey = await getSafeBrowsingApiKey();
  if (!apiKey) {
    LOG.warn('Safe Browsing API key unavailable – skipping cloud lookup.');
    return [];
  }

  const body = {
    client: {
      clientId: 'sentinelx',
      clientVersion: '1.0.0',
    },
    threatInfo: {
      threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
      platformTypes: ['ANY_PLATFORM'],
      threatEntryTypes: ['URL'],
      threatEntries: urls.map(url => ({ url })),
    },
  };

  const endpoint = `${SAFE_BROWSING_ENDPOINT}?key=${apiKey}`;

  for (let attempt = 0; attempt <= API_RETRY_COUNT; attempt++) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });

      if (!resp.ok) {
        LOG.warn(`Safe Browsing request failed (status ${resp.status}), attempt ${attempt + 1}`);
        throw new Error(`HTTP ${resp.status}`);
      }

      const data = await resp.json();
      // The response contains matches array; if empty, no threats.
      const matches = data.matches || [];
      // Build map of url -> threatTypes
      const resultMap = {};
      for (const match of matches) {
        const url = match.threatEntry.url;
        if (!resultMap[url]) resultMap[url] = [];
        resultMap[url].push(match.threatType);
      }
      // Attach cache duration from response metadata if present.
      const cacheDurationMs = (data['cacheDuration'] && typeof data['cacheDuration'] === 'string')
        ? parseInt(data['cacheDuration'].replace('s', ''), 10) * 1000
        : null;

      const results = urls.map(u => ({
        url: u,
        threatTypes: resultMap[u] || [],
        cacheDurationMs,
      }));
      return results;
    } catch (e) {
      LOG.error('Safe Browsing lookup error:', e);
      if (attempt < API_RETRY_COUNT) {
        await delay(API_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      // after retries, return empty results (treated as no threat).
      return urls.map(u => ({ url: u, threatTypes: [], cacheDurationMs: null }));
    }
  }
}
