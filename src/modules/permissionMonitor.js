import { appendDashboardHistory, updateDashboard } from './dashboard.js';
import { getSettings } from './settings.js';

const ALLOWED = new Set(['camera', 'microphone', 'clipboard-read', 'clipboard-write', 'notifications', 'geolocation']);

/** Stores a permission API request reported by the page-side content bridge. */
export async function recordPermissionRequest({ permission, url, timestamp = Date.now() }) {
  if (!ALLOWED.has(permission) || !(await getSettings()).permissionMonitoring) return null;
  const entry = { permission, url, timestamp };
  await updateDashboard(dashboard => {
    dashboard.permissions.unshift(entry);
    dashboard.permissions = dashboard.permissions.slice(0, 100);
    appendDashboardHistory(dashboard, { timestamp, eventType: 'permission', url, score: null, label: 'Permission', permission });
  });
  return entry;
}
