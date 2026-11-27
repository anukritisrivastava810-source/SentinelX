import { appendDashboardHistory, updateDashboard } from './dashboard.js';
import { getSettings } from './settings.js';

export const RISKY_EXTENSIONS = Object.freeze([
  'exe', 'msi', 'bat', 'cmd', 'scr', 'ps1', 'jar', 'apk', 'zip', 'vbs', 'iso'
]);

function extensionOf(filename = '') {
  return filename.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() || '';
}

function isRiskyExtension(extension = '') {
  return RISKY_EXTENSIONS.includes(extension.toLowerCase());
}

/** Starts non-blocking Downloads API monitoring. Downloads are never modified or cancelled. */
export function initialiseDownloadMonitor() {
  if (globalThis.__sentinelxDownloadMonitorReady) return;
  globalThis.__sentinelxDownloadMonitorReady = true;

  chrome.downloads.onCreated.addListener(async (download) => {
    if (!(await getSettings()).downloadMonitoring) return;

    const extension = extensionOf(download.filename || download.url);
    const risky = isRiskyExtension(extension);
    const danger = (download.danger && download.danger !== 'safe')
      ? download.danger
      : (risky ? 'file_type' : 'safe');

    const entry = {
      id: download.id,
      url: download.url,
      referrer: download.referrer || '',
      filename: download.filename || '',
      extension,
      mime: download.mime || '',
      danger,
      risky,
      state: download.state || 'in_progress',
      timestamp: Date.now()
    };

    await updateDashboard(dashboard => {
      const existing = dashboard.downloads.find(item => item.id === download.id);
      if (!existing) {
        dashboard.downloads.unshift(entry);
        dashboard.downloads = dashboard.downloads.slice(0, 100);
        dashboard.statistics.downloads += 1;
        appendDashboardHistory(dashboard, {
          timestamp: entry.timestamp,
          eventType: 'download',
          url: entry.url,
          score: null,
          label: entry.danger !== 'safe' || entry.risky ? 'Dangerous' : 'Download',
          filename: entry.filename,
          downloadId: entry.id
        });
      }
    });
  });

  chrome.downloads.onChanged.addListener(async (delta) => {
    if (!(await getSettings()).downloadMonitoring) return;
    if (!delta.filename && !delta.state && !delta.danger && !delta.mime) return;

    await updateDashboard(dashboard => {
      let matched = false;
      dashboard.downloads = dashboard.downloads.map(item => {
        if (item.id !== delta.id) return item;
        matched = true;

        const resolvedFilename = delta.filename?.current || item.filename || '';
        const resolvedExtension = extensionOf(resolvedFilename) || item.extension || '';
        const risky = item.risky || isRiskyExtension(resolvedExtension);

        let danger = delta.danger?.current || item.danger || 'safe';
        if (danger === 'safe' && risky) {
          danger = 'file_type';
        }

        const state = delta.state?.current || item.state;
        const mime = delta.mime?.current || item.mime;

        return {
          ...item,
          filename: resolvedFilename,
          extension: resolvedExtension,
          risky,
          danger,
          state,
          mime,
          updatedAt: Date.now()
        };
      });

      // Update corresponding entry in history if filename or danger changed
      dashboard.history = dashboard.history.map(hist => {
        if (hist.downloadId === delta.id || (hist.eventType === 'download' && delta.filename?.previous && hist.filename === delta.filename.previous)) {
          const resolvedFilename = delta.filename?.current || hist.filename;
          const ext = extensionOf(resolvedFilename);
          const isDanger = (delta.danger?.current && delta.danger.current !== 'safe') || isRiskyExtension(ext);
          return {
            ...hist,
            filename: resolvedFilename,
            label: isDanger ? 'Dangerous' : hist.label
          };
        }
        return hist;
      });

      // If onCreated was missed for this download, create record once without duplicate counting
      if (!matched && delta.filename?.current) {
        const resolvedFilename = delta.filename.current;
        const resolvedExtension = extensionOf(resolvedFilename);
        const risky = isRiskyExtension(resolvedExtension);
        const danger = (delta.danger?.current && delta.danger.current !== 'safe')
          ? delta.danger.current
          : (risky ? 'file_type' : 'safe');

        const newEntry = {
          id: delta.id,
          url: '',
          referrer: '',
          filename: resolvedFilename,
          extension: resolvedExtension,
          mime: delta.mime?.current || '',
          danger,
          risky,
          state: delta.state?.current || 'in_progress',
          timestamp: Date.now()
        };

        dashboard.downloads.unshift(newEntry);
        dashboard.downloads = dashboard.downloads.slice(0, 100);
        dashboard.statistics.downloads += 1;
        appendDashboardHistory(dashboard, {
          timestamp: newEntry.timestamp,
          eventType: 'download',
          url: newEntry.url,
          score: null,
          label: newEntry.danger !== 'safe' || newEntry.risky ? 'Dangerous' : 'Download',
          filename: newEntry.filename,
          downloadId: newEntry.id
        });
      }
    });
  });
}
