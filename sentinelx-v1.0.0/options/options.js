import { getSettings, saveSettings, removeWhitelistedDomain } from '../src/modules/settings.js';
import { DASHBOARD_KEY, DEFAULT_DASHBOARD, getDashboard } from '../src/modules/dashboard.js';

let cachedReports = [];

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await getSettings();
  document.querySelectorAll('[data-setting]').forEach(control => {
    const key = control.dataset.setting;
    if (control.type === 'checkbox') control.checked = settings[key]; else control.value = settings[key];
    control.addEventListener('change', async () => {
      await saveSettings({ [key]: control.type === 'checkbox' ? control.checked : control.value });
      showStatus('Saved');
    });
  });

  document.getElementById('clearStorage').addEventListener('click', clearStorage);
  document.getElementById('exportJson')?.addEventListener('click', handleExportJson);
  document.getElementById('exportCsv')?.addEventListener('click', handleExportCsv);

  await renderReports();
  await renderWhitelist();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.dashboard) {
        renderReports();
      }
      if (changes.sentinelx_settings) {
        renderWhitelist();
      }
    }
  });
});

async function renderWhitelist() {
  const settings = await getSettings();
  const domains = settings.whitelistedDomains || [];
  const list = document.getElementById('whitelistList');
  const empty = document.getElementById('whitelistEmpty');
  if (!list || !empty) return;

  if (domains.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'block';
    list.innerHTML = '';
    return;
  }

  list.style.display = 'block';
  empty.style.display = 'none';
  list.innerHTML = '';

  domains.forEach(domain => {
    const li = document.createElement('li');
    li.className = 'whitelist-item';

    const span = document.createElement('span');
    span.className = 'whitelist-domain';
    span.textContent = domain;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'remove-btn';
    btn.textContent = 'Remove';
    btn.addEventListener('click', async () => {
      await removeWhitelistedDomain(domain);
      await renderWhitelist();
      showStatus(`Removed ${domain}`);
    });

    li.appendChild(span);
    li.appendChild(btn);
    list.appendChild(li);
  });
}

async function renderReports() {
  const dashboard = await getDashboard();
  cachedReports = dashboard.reports || [];

  const table = document.getElementById('reportsTable');
  const tbody = document.getElementById('reportsTableBody');
  const empty = document.getElementById('reportsEmpty');
  if (!table || !tbody || !empty) return;

  if (cachedReports.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'block';
    tbody.innerHTML = '';
    return;
  }

  table.style.display = 'table';
  empty.style.display = 'none';
  tbody.innerHTML = '';

  cachedReports.forEach(r => {
    const tr = document.createElement('tr');

    const timeStr = r.timestamp
      ? new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
      : '—';

    const labelClass = getBadgeClass(r.riskLabel);

    tr.innerHTML = `
      <td style="white-space: nowrap;">${escapeHtml(timeStr)}</td>
      <td><div class="report-url" title="${escapeHtml(r.url)}">${escapeHtml(r.url)}</div></td>
      <td><span class="report-badge ${labelClass}">${escapeHtml(r.riskLabel)} (${r.riskScore})</span></td>
      <td><span class="${r.httpsStatus ? 'badge-secure' : 'badge-insecure'}">${r.httpsStatus ? 'HTTPS' : 'HTTP'}</span></td>
      <td style="text-align: center;">${r.redirectCount ?? 0}</td>
      <td style="text-align: center;">${r.permissionsRequested?.length ?? 0}</td>
      <td style="text-align: center;">${r.downloads?.length ?? 0}</td>
    `;
    tbody.appendChild(tr);
  });
}

function getBadgeClass(label = '') {
  switch (label) {
    case 'Safe':
      return 'badge-safe';
    case 'Low Risk':
      return 'badge-low';
    case 'Moderate Risk':
      return 'badge-moderate';
    case 'Dangerous':
    default:
      return 'badge-danger';
  }
}

function escapeHtml(str = '') {
  const span = document.createElement('span');
  span.textContent = str;
  return span.innerHTML;
}

function handleExportJson() {
  if (!cachedReports.length) {
    showStatus('No reports to export');
    return;
  }
  const jsonStr = JSON.stringify(cachedReports, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  downloadBlob(blob, `sentinelx-reports-${Date.now()}.json`);
  showStatus('JSON exported');
}

function handleExportCsv() {
  if (!cachedReports.length) {
    showStatus('No reports to export');
    return;
  }

  const headers = [
    'Timestamp',
    'Date Time',
    'URL',
    'Risk Score',
    'Risk Label',
    'HTTPS',
    'Redirect Count',
    'Permissions Count',
    'Downloads Count',
    'Permissions Requested',
    'Downloads Observed',
    'Content Findings'
  ];

  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '""';
    if (typeof val === 'object') {
      return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
    }
    return `"${String(val).replace(/"/g, '""')}"`;
  };

  const rows = cachedReports.map(r => [
    escapeCsv(r.timestamp),
    escapeCsv(r.timestamp ? new Date(r.timestamp).toISOString() : ''),
    escapeCsv(r.url),
    escapeCsv(r.riskScore),
    escapeCsv(r.riskLabel),
    escapeCsv(r.httpsStatus ? 'Yes' : 'No'),
    escapeCsv(r.redirectCount ?? 0),
    escapeCsv(r.permissionsRequested?.length ?? 0),
    escapeCsv(r.downloads?.length ?? 0),
    escapeCsv(r.permissionsRequested ? r.permissionsRequested.join('; ') : ''),
    escapeCsv(r.downloads ? r.downloads.map(d => d.filename || d.url).join('; ') : ''),
    escapeCsv(r.contentFindings ? JSON.stringify(r.contentFindings) : '')
  ].join(','));

  const csvContent = [headers.map(h => `"${h}"`).join(','), ...rows].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, `sentinelx-reports-${Date.now()}.csv`);
  showStatus('CSV exported');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Removes SentinelX-owned local storage while retaining the selected preferences. */
async function clearStorage() {
  const settings = await getSettings();
  const all = await chrome.storage.local.get(null);
  const keys = [...Object.keys(all).filter(key => key.startsWith('sentinelx_')), DASHBOARD_KEY];
  await chrome.storage.local.remove(keys);
  await chrome.storage.local.set({
    sentinelx_settings: settings,
    sentinelx_version: '1.0.0',
    sentinelx_scan_count: 0,
    sentinelx_last_scan: null,
    [DASHBOARD_KEY]: { ...DEFAULT_DASHBOARD }
  });
  showStatus('SentinelX storage cleared');
}

function showStatus(message) {
  const el = document.getElementById('status');
  if (el) el.textContent = message;
}
