// src/config/safeBrowsingConfig.js
// -------------------------------------------------------------------
// Safe Browsing configuration module
// -------------------------------------------------------------------
// This module centralises configuration for the Google Safe Browsing API.
// It deliberately avoids hard‑coding the API key in source code – the key
// should be provided via the extension's managed storage (Chrome's
// `chrome.storage.managed`), which is only accessible to the extension
// and cannot be read by web pages. This respects the requirement to keep
// secrets out of the client bundle.

export const SAFE_BROWSING_ENDPOINT = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';

/**
 * Retrieves the API key from managed storage.
 * The key must be set by the extension admin (e.g. via enterprise policy).
 * If the key is missing, the service will gracefully fail and the
 * extension will continue using local heuristics.
 */
export async function getSafeBrowsingApiKey() {
  try {
    const { safeBrowsingApiKey } = await chrome.storage.managed.get('safeBrowsingApiKey');
    if (safeBrowsingApiKey) {
      return safeBrowsingApiKey;
    }
    console.warn('[SentinelX] Safe Browsing API key not configured in managed storage.');
    return null;
  } catch (e) {
    console.error('[SentinelX] Error reading managed storage for API key:', e);
    return null;
  }
}
