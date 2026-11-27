import { appendDashboardHistory, getDashboard, updateDashboard } from './dashboard.js';
import { getSettings } from './settings.js';

export const HIGH_REDIRECT_COUNT = 3;

const sessionKey = tabId => `redirect_chain_${tabId}`;

async function getChain(tabId) {
  try {
    const key = sessionKey(tabId);
    const data = await chrome.storage.session.get(key);
    return data[key] || null;
  } catch (err) {
    console.error('[SentinelX] getChain error:', err);
    return null;
  }
}

async function setChain(tabId, chain) {
  try {
    const key = sessionKey(tabId);
    await chrome.storage.session.set({ [key]: chain });
  } catch (err) {
    console.error('[SentinelX] setChain error:', err);
  }
}

async function clearChain(tabId) {
  try {
    const key = sessionKey(tabId);
    await chrome.storage.session.remove(key);
  } catch (err) {
    console.error('[SentinelX] clearChain error:', err);
  }
}

/** Tracks server-side and client-side navigation redirect chains using webNavigation events. */
export function initialiseRedirectMonitor() {
  if (globalThis.__sentinelxRedirectMonitorReady || !chrome.webNavigation) return;
  globalThis.__sentinelxRedirectMonitorReady = true;

  chrome.webNavigation.onBeforeNavigate.addListener(async ({ tabId, frameId, url }) => {
    if (frameId !== 0 || !(await getSettings()).redirectMonitoring) return;
    const existing = await getChain(tabId);
    // Only initialize if no active chain exists for this tab — do NOT overwrite originalUrl on intermediate hops
    if (!existing) {
      await setChain(tabId, {
        originalUrl: url,
        lastUrl: url,
        count: 0,
        startedAt: Date.now()
      });
    }
  });

  chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId, url, transitionQualifiers }) => {
    if (frameId !== 0 || !(await getSettings()).redirectMonitoring) return;
    const chain = await getChain(tabId);
    if (!chain) return;

    const isRedirectQualifier = transitionQualifiers?.includes('server_redirect') || transitionQualifiers?.includes('client_redirect');
    const isUrlChanged = url !== chain.lastUrl;

    if (isRedirectQualifier || isUrlChanged) {
      chain.count += 1;
    }
    chain.lastUrl = url;
    await setChain(tabId, chain);
  });

  chrome.webNavigation.onCompleted.addListener(async ({ tabId, frameId, url }) => {
    if (frameId !== 0 || !(await getSettings()).redirectMonitoring) return;
    const chain = await getChain(tabId);
    if (!chain) return;

    chain.lastUrl = url;
    if (chain.count > 0 || chain.originalUrl !== url) {
      const finalCount = chain.count > 0 ? chain.count : 1;
      const isHighRedirect = finalCount >= HIGH_REDIRECT_COUNT;
      const entry = {
        original: chain.originalUrl,
        final: url,
        count: finalCount,
        highRedirect: isHighRedirect,
        timestamp: Date.now()
      };

      await updateDashboard(dashboard => {
        dashboard.redirects.unshift(entry);
        dashboard.redirects = dashboard.redirects.slice(0, 100);
        dashboard.statistics.redirects += 1;
        appendDashboardHistory(dashboard, {
          timestamp: entry.timestamp,
          eventType: 'redirect',
          url: entry.final,
          score: null,
          label: isHighRedirect ? 'Dangerous' : 'Redirect',
          original: entry.original,
          redirectCount: entry.count,
          highRedirect: entry.highRedirect
        });
      });
    }

    await clearChain(tabId);
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    await clearChain(tabId);
  });
}

/** Returns the latest completed redirect record associated with a URL. */
export async function getRedirectForUrl(url) {
  const dashboard = await getDashboard();
  const norm = u => (u || '').replace(/\/+$/, '');
  const target = norm(url);
  return dashboard.redirects.find(item => norm(item.final) === target || norm(item.original) === target) || null;
}
