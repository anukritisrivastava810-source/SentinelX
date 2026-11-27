// src/utils/cache.js
// -------------------------------------------------------------------
// In‑memory + chrome.storage cache for API results.
// -------------------------------------------------------------------
import { CACHE_TTL_MS } from '../constants.js';
import { LOG } from './logger.js';

/**
 * Generates a cache key for a URL.
 * @param {string} url
 */
function makeKey(url) {
  return `sb_cache:${encodeURIComponent(url)}`;
}

/**
 * Retrieves a cached entry if it hasn't expired.
 * Returns null if missing or stale.
 * @param {string} url
 */
export async function getCache(url) {
  const key = makeKey(url);
  const data = await chrome.storage.local.get(key);
  const entry = data[key];
  if (!entry) return null;
  const now = Date.now();
  if (now - entry.timestamp > (entry.ttl ?? CACHE_TTL_MS)) {
    // stale – purge
    await chrome.storage.local.remove(key);
    LOG.info('Cache miss (stale) for', url);
    return null;
  }
  LOG.info('Cache hit for', url);
  return entry.value;
}

/**
 * Stores a value in the cache with an optional TTL.
 * @param {string} url
 * @param {*} value
 * @param {number} [ttlMs] – overrides default TTL if supplied.
 */
export async function setCache(url, value, ttlMs) {
  const key = makeKey(url);
  const entry = {
    value,
    timestamp: Date.now(),
    ttl: ttlMs ?? CACHE_TTL_MS,
  };
  await chrome.storage.local.set({ [key]: entry });
  LOG.info('Cache set for', url);
}

/**
 * Clears all Safe Browsing cache entries (useful for dev/testing).
 */
export async function clearAllCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith('sb_cache:'));
  if (keys.length) await chrome.storage.local.remove(keys);
  LOG.info('All Safe Browsing cache cleared');
}
