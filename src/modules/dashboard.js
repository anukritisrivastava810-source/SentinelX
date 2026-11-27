/**
 * The single persisted state document used by all Phase 3A dashboard features.
 * Legacy per-URL scan records remain untouched for backwards compatibility.
 */
export const DASHBOARD_KEY = 'dashboard';

export const DEFAULT_DASHBOARD = Object.freeze({
  downloads: [],
  redirects: [],
  permissions: [],
  history: [],
  reports: [],
  statistics: { totalScans: 0, dangerousSites: 0, downloads: 0, redirects: 0 },
});

let updateQueue = Promise.resolve();

/** Returns a complete dashboard object, including fields added after installation. */
export async function getDashboard() {
  const data = await chrome.storage.local.get(DASHBOARD_KEY);
  const saved = data[DASHBOARD_KEY] || {};
  return {
    ...DEFAULT_DASHBOARD,
    ...saved,
    downloads: saved.downloads || [], redirects: saved.redirects || [], permissions: saved.permissions || [],
    history: saved.history || [], reports: saved.reports || [],
    statistics: { ...DEFAULT_DASHBOARD.statistics, ...(saved.statistics || {}) },
  };
}

/** Serially updates and persists dashboard state so simultaneous browser events cannot overwrite each other. */
export function updateDashboard(mutator) {
  updateQueue = updateQueue.catch(() => {}).then(async () => {
    const dashboard = await getDashboard();
    await mutator(dashboard);
    await chrome.storage.local.set({ [DASHBOARD_KEY]: dashboard });
    return dashboard;
  });
  return updateQueue;
}

/** Adds one bounded, newest-first activity item to dashboard history. */
export function appendDashboardHistory(dashboard, item) {
  dashboard.history.unshift(item);
  dashboard.history = dashboard.history.slice(0, 100);
}
