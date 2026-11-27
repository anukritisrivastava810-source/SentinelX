import { KEYS } from './storage.js';

/** Default Phase 3 monitoring preferences. */
export const DEFAULT_SETTINGS = Object.freeze({
  automaticScanning: true,
  downloadMonitoring: true,
  redirectMonitoring: true,
  permissionMonitoring: true,
  warningSensitivity: 'balanced',
  whitelistedDomains: [],
});

/** Normalizes hostname strings to lowercase without scheme, path, or port. */
export function normalizeHostname(hostname = '') {
  return String(hostname)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0];
}

/** Loads settings while safely filling in preferences added in later versions. */
export async function getSettings() {
  const data = await chrome.storage.local.get(KEYS.settings);
  const current = data[KEYS.settings] || {};
  return {
    ...DEFAULT_SETTINGS,
    ...current,
    whitelistedDomains: Array.isArray(current.whitelistedDomains)
      ? current.whitelistedDomains
      : [...DEFAULT_SETTINGS.whitelistedDomains],
  };
}

/** Persists a partial settings update and returns the complete setting set. */
export async function saveSettings(changes) {
  const settings = { ...(await getSettings()), ...changes };
  await chrome.storage.local.set({ [KEYS.settings]: settings });
  return settings;
}

/** Creates missing settings without overwriting existing user preferences. */
export async function initialiseSettings() {
  await saveSettings({});
}

/** Adds a domain to the whitelist, normalizing to lowercase hostname. */
export async function addWhitelistedDomain(hostname) {
  const norm = normalizeHostname(hostname);
  if (!norm) return (await getSettings()).whitelistedDomains;

  const settings = await getSettings();
  const current = new Set(settings.whitelistedDomains || []);
  current.add(norm);
  const updated = Array.from(current);
  await saveSettings({ whitelistedDomains: updated });
  return updated;
}

/** Removes a domain from the whitelist. */
export async function removeWhitelistedDomain(hostname) {
  const norm = normalizeHostname(hostname);
  const settings = await getSettings();
  const updated = (settings.whitelistedDomains || []).filter(d => d !== norm);
  await saveSettings({ whitelistedDomains: updated });
  return updated;
}

/** Checks whether a domain or its parent domain is whitelisted. */
export async function isDomainWhitelisted(hostname) {
  const norm = normalizeHostname(hostname);
  if (!norm) return false;
  const settings = await getSettings();
  const domains = settings.whitelistedDomains || [];
  return domains.some(d => norm === d || norm.endsWith('.' + d));
}
