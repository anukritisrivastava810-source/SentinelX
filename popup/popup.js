/**
 * ═══════════════════════════════════════════════════════
 * SentinelX — popup.js
 *
 * SCORING MODEL (unified):
 *   Risk Score  0–15   → Safe          (green)
 *   Risk Score 16–40   → Moderate Risk (amber)
 *   Risk Score 41–100  → Dangerous     (red)
 *
 * The score displayed is the RAW risk score from the engine.
 * Higher number = more dangerous. There is no "Trust Score" inversion.
 * ═══════════════════════════════════════════════════════
 */

import { isAiAvailable, explainThreat } from '../src/services/aiExplainerService.js';

document.addEventListener('DOMContentLoaded', initPopup);
let allHistory = [];
let activeUrl = '';
/** Holds the latest scan result so the AI button can reference it without a re-fetch. */
let currentScanResult = null;

// ───────────────────────────────────────────────────────
// ENTRY POINT
// ───────────────────────────────────────────────────────

async function initPopup() {
  try {
    // Fallback for local file:// browser testing (no chrome.* APIs)
    if (typeof chrome === 'undefined' || !chrome.tabs) {
      console.log('[SentinelX Popup] Dev mode — rendering mock results.');
      renderUrlSection('https://www.google.com');

      // Realistic safe-site mock: risk score of 2 → Safe
      const mockResult = {
        score: 2,
        label: 'Safe',
        isHttps: true,
        checks: [
          { label: 'Protocol: HTTPS (encrypted)', passed: true },
          { label: 'Domain-based host', passed: true },
          { label: 'No suspicious URL keywords', passed: true },
          { label: 'Domain length normal', passed: true },
          { label: 'Normal subdomain depth', passed: true },
          { label: 'Standard TLD', passed: true },
          { label: 'No brand impersonation detected', passed: true }
        ],
        timestamp: Date.now()
      };

      // Mock history with realistic risk scores
      const mockHistory = [
        { url: 'https://paypal.com',               score: 0,  label: 'Safe',          timestamp: Date.now() - 65000   },
        { url: 'http://example.com',               score: 35, label: 'Moderate Risk',  timestamp: Date.now() - 420000  },
        { url: 'https://paypa1-security.xyz',      score: 80, label: 'Dangerous',      timestamp: Date.now() - 2400000 }
      ];

      setTimeout(() => {
        renderResults(mockResult);
        renderHistoryList(mockHistory);
      }, 500);
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url) {
      renderError('Could not detect active tab.');
      return;
    }

    renderUrlSection(tab.url);
    activeUrl = tab.url;
    loadDashboard(tab.url);
    bindHistoryControls();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.dashboard) loadDashboard(activeUrl);
    });
    // Show loading indicator while cloud lookup may be in progress
    const { cloudLoading } = await chrome.storage.session.get('cloudLoading');
    if (cloudLoading) {
      const statusPill = document.getElementById('statusPill');
      const statusText = document.getElementById('statusText');
      if (statusPill && statusText) {
        statusPill.className = 'status-pill loading';
        statusText.textContent = 'Fetching cloud reputation...';
      }
    }
    chrome.runtime.sendMessage({ type: 'ANALYSE_URL', url: tab.url }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[SentinelX Popup] Message error:', chrome.runtime.lastError);
        renderError('Background script unavailable.');
        return;
      }
      if (response && response.result) {
        currentScanResult = response.result;
        renderResults(response.result);
        // Refresh dashboard and scan history now that analysis result has been stored
        loadDashboard(activeUrl || tab.url);
        // Wire AI button now that we have a result
        initAiSection(response.result);
      } else {
        renderError('No analysis data returned.');
      }
    });

    loadScanHistory();

  } catch (err) {
    console.error('[SentinelX Popup] Init error:', err);
    renderError(err.message);
  }
}

// ───────────────────────────────────────────────────────
// RENDER: URL SECTION
// ───────────────────────────────────────────────────────

function renderUrlSection(url) {
  const urlDisplay = document.getElementById('urlDisplay');
  if (urlDisplay) {
    urlDisplay.textContent = url.length > 60 ? url.slice(0, 57) + '…' : url;
    urlDisplay.title = url;
  }
  try {
    const domainLabel = document.getElementById('domainLabel');
    if (domainLabel) domainLabel.textContent = new URL(url).hostname;
  } catch {
    const domainLabel = document.getElementById('domainLabel');
    if (domainLabel) domainLabel.textContent = 'Unknown';
  }
}

// ───────────────────────────────────────────────────────
// RENDER: MAIN RESULTS
// ───────────────────────────────────────────────────────

/**
 * renderResults(result)
 *
 * Displays the RAW risk score directly — no inversion, no trust math.
 * Bar fill width = risk score percentage (0% = clean, 100% = max danger).
 */
function renderResults(result) {
  const { score, label, isHttps, checks, timestamp } = result;
  const pillClass = labelToCSSClass(label); // 'safe' | 'low' | 'moderate' | 'danger'

  console.log(`[SentinelX Popup] Rendering — Risk Score: ${score}, Label: ${label}`);

  // ── Status pill ──
  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  if (statusPill && statusText) {
    statusPill.className = `status-pill ${pillClass}`;
    statusText.textContent = label;
  }

  // ── HTTPS badge ──
  const httpsBadge  = document.getElementById('httpsBadge');
  const httpsLabel  = document.getElementById('httpsLabel');
  if (httpsBadge && httpsLabel) {
    if (isHttps) {
      httpsBadge.className   = 'badge badge-secure';
      httpsLabel.textContent = 'HTTPS Secure';
    } else {
      httpsBadge.className   = 'badge badge-insecure';
      httpsLabel.textContent = 'HTTP — Insecure';
    }
  }

  // ── Risk card state class ──
  const riskCard = document.getElementById('riskCard');
  if (riskCard) riskCard.className = `card risk-card state-${pillClass}`;

  // ── Risk Score number (raw, no inversion) ──
  const scoreNumber = document.getElementById('riskScore');
  if (scoreNumber) scoreNumber.textContent = score;

  // ── Risk label text ──
  const labelText = document.getElementById('labelText');
  if (labelText) labelText.textContent = label;

  // ── Explanation detail ──
  const scoreDetail = document.getElementById('scoreDetail');
  if (scoreDetail) scoreDetail.innerHTML = riskDescription(score, isHttps, checks);

  // ── Risk bar fill (higher score = longer bar = more danger) ──
  const barFill = document.getElementById('riskBarFill');
  if (barFill) barFill.style.width = `${score}%`;

  // ── Security checklist ──
  renderChecks(checks);

  // ── Footer timestamp ──
  if (timestamp) {
    const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const scanTime = document.getElementById('scanTime');
    if (scanTime) scanTime.textContent = `Scanned at ${time}`;
  }
}

// ───────────────────────────────────────────────────────
// RENDER: SECURITY CHECKS LIST
// ───────────────────────────────────────────────────────

function renderChecks(checks) {
  const list = document.getElementById('checksList');
  if (!list) return;
  list.innerHTML = '';

  if (!checks || checks.length === 0) {
    list.innerHTML = `
      <li class="check-item check-pending">
        <span class="check-icon">
          <svg class="check-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
        </span>
        <span class="check-text">No checks available.</span>
      </li>`;
    return;
  }

  checks.forEach(({ label, passed, warn }) => {
    const li = document.createElement('li');
    let cssClass, svgIcon;

    if (warn) {
      cssClass = 'check-warn';
      svgIcon = `<svg class="check-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>`;
    } else if (passed) {
      cssClass = 'check-pass';
      svgIcon = `<svg class="check-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>`;
    } else {
      cssClass = 'check-fail';
      svgIcon = `<svg class="check-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>`;
    }

    li.className = `check-item ${cssClass}`;

    const iconSpan = document.createElement('span');
    iconSpan.className = 'check-icon';
    iconSpan.innerHTML = svgIcon;

    const textSpan = document.createElement('span');
    textSpan.className = 'check-text';
    textSpan.textContent = label;

    li.appendChild(iconSpan);
    li.appendChild(textSpan);
    list.appendChild(li);
  });
}

// ───────────────────────────────────────────────────────
// AI THREAT EXPLAINER
// ───────────────────────────────────────────────────────

/**
 * initAiSection(result)
 *
 * Shows the AI Analysis button if on-device AI is available and wires up
 * the click handler.  Three states:
 *   'unavailable'  → hide the whole section
 *   'downloadable' → show section but disable button with info message
 *   'available'    → show section, enable button, wire click → explainThreat()
 */
async function initAiSection(result) {
  const section     = document.getElementById('aiSection');
  const btn         = document.getElementById('aiExplainBtn');
  const btnText     = document.getElementById('aiExplainBtnText');
  const panel       = document.getElementById('aiPanel');
  const panelInner  = document.getElementById('aiPanelInner');
  if (!section || !btn || !btnText || !panel || !panelInner) return;

  // Hide first while we check availability (avoids flicker)
  section.style.display = 'none';

  let avail;
  try {
    avail = await isAiAvailable();
  } catch (_) {
    avail = 'unavailable';
  }

  if (avail === 'unavailable') return;  // keep hidden

  section.style.display = 'block';

  if (avail === 'downloadable') {
    // Informational state — model is still downloading
    btn.disabled = true;
    btnText.textContent = 'AI Model Downloading…';
    panel.style.display = 'block';
    panelInner.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'ai-downloading';
    msg.textContent = 'On-device AI model is downloading in the background. Try again shortly.';
    panelInner.appendChild(msg);
    return;
  }

  // ── 'available' ────────────────────────────────────────
  // Guard against double-wiring if initAiSection is somehow called twice
  btn.replaceWith(btn.cloneNode(true));
  const freshBtn     = document.getElementById('aiExplainBtn');
  const freshBtnText = document.getElementById('aiExplainBtnText');

  freshBtn.addEventListener('click', async () => {
    if (freshBtn.disabled) return;

    // Enter loading state
    freshBtn.disabled = true;
    freshBtn.classList.add('ai-loading');
    freshBtnText.textContent = 'Analyzing…';
    panel.style.display = 'block';
    panelInner.innerHTML = '';

    let explanation;
    try {
      explanation = await explainThreat(result);
    } catch (_) {
      explanation = { available: false, reason: 'Unexpected error during analysis.' };
    }

    // Exit loading state
    freshBtn.classList.remove('ai-loading');
    freshBtn.disabled = false;
    freshBtnText.textContent = 'AI Analysis';
    panelInner.innerHTML = '';

    if (!explanation || !explanation.available) {
      const errDiv = document.createElement('div');
      errDiv.className = 'ai-error';
      errDiv.textContent = explanation?.reason || 'AI analysis unavailable on this device.';
      panelInner.appendChild(errDiv);
      return;
    }

    // ── Render result rows ──────────────────────────────
    const renderRow = (label, value, extraClass = '') => {
      const row = document.createElement('div');
      row.className = 'ai-row';

      const lbl = document.createElement('div');
      lbl.className = 'ai-row-label';
      lbl.textContent = label;

      const val = document.createElement('div');
      val.className = 'ai-row-value' + (extraClass ? ' ' + extraClass : '');
      val.textContent = value || '—';

      row.appendChild(lbl);
      row.appendChild(val);
      return row;
    };

    if (explanation.summary) {
      panelInner.appendChild(renderRow('Summary', explanation.summary));
    }
    if (explanation.riskReason) {
      panelInner.appendChild(renderRow('Why This Score', explanation.riskReason));
    }
    if (explanation.recommendedAction) {
      panelInner.appendChild(renderRow('Recommended Action', explanation.recommendedAction, 'ai-action'));
    }
  });
}

// ───────────────────────────────────────────────────────
// RENDER: SCAN HISTORY
// ───────────────────────────────────────────────────────

async function loadScanHistory() {
  const target = activeUrl || '';
  loadDashboard(target);
}

/** Requests current-site monitoring information and renders the compact dashboard. */
function loadDashboard(url) {
  const targetUrl = url || activeUrl || '';
  chrome.runtime.sendMessage({ type: 'GET_DASHBOARD', url: targetUrl }, response => {
    const statsElem = document.getElementById('statistics');

    if (chrome.runtime.lastError) {
      console.error('[SentinelX Popup] GET_DASHBOARD runtime error:', chrome.runtime.lastError.message);
      if (statsElem && statsElem.textContent.includes('Loading')) {
        statsElem.textContent = '0 scans · 0 dangerous · 0 downloads · 0 redirects';
      }
      return;
    }

    if (!response?.dashboard) {
      console.warn('[SentinelX Popup] No dashboard returned in response:', response);
      if (statsElem && statsElem.textContent.includes('Loading')) {
        statsElem.textContent = '0 scans · 0 dangerous · 0 downloads · 0 redirects';
      }
      return;
    }

    const { redirects = [], permissions = [], downloads = [], history = [], statistics = {}, siteSummary = {} } = response.dashboard;

    // Use scoped siteSummary counts for "Website Summary" card if available, falling back to full list lengths
    const redirectCount = siteSummary?.redirectCount ?? redirects.length;
    const permissionCount = siteSummary?.permissionCount ?? permissions.length;
    const downloadCount = siteSummary?.downloadCount ?? downloads.length;

    const redirectElem = document.getElementById('redirectCount');
    if (redirectElem) redirectElem.textContent = redirectCount;

    const permElem = document.getElementById('permissionCount');
    if (permElem) permElem.textContent = permissionCount;

    const dlElem = document.getElementById('downloadCount');
    if (dlElem) dlElem.textContent = downloadCount;

    const activity = document.getElementById('recentActivity');
    if (activity) {
      // Check for risky downloads in site scope if available, otherwise global downloads
      const relevantDownloads = siteSummary?.downloads?.length ? siteSummary.downloads : downloads;
      const riskyDownload = relevantDownloads.find(item => item?.danger && item?.danger !== 'safe');
      const warning = riskyDownload ? `<div class="download-warning">Risky download observed: ${escapeHtml(riskyDownload.filename || riskyDownload.url || '')}${riskyDownload.extension ? ` (.${escapeHtml(riskyDownload.extension)})` : ''}</div>` : '';
      activity.innerHTML = warning + (history.length ? history.slice(0, 5).map(item => `<div>${escapeHtml(item?.eventType || 'event')}: ${escapeHtml(item?.url || item?.filename || '')}</div>`).join('') : 'No monitoring activity yet.');
    }

    if (statsElem) {
      statsElem.textContent = `${statistics?.totalScans ?? 0} scans · ${statistics?.dangerousSites ?? 0} dangerous · ${statistics?.downloads ?? 0} downloads · ${statistics?.redirects ?? 0} redirects`;
    }

    allHistory = Array.isArray(history) ? history : [];
    applyHistoryFilters();
  });
}

/** Wires local history search, risk filtering, and clear controls. */
function bindHistoryControls() {
  document.getElementById('historySearch')?.addEventListener('input', applyHistoryFilters);
  document.getElementById('historyFilter')?.addEventListener('change', applyHistoryFilters);
  document.getElementById('historySort')?.addEventListener('change', applyHistoryFilters);
  document.getElementById('clearHistory')?.addEventListener('click', async () => {
    const { dashboard } = await chrome.storage.local.get('dashboard');
    await chrome.storage.local.set({ dashboard: { ...dashboard, history: [] } });
    allHistory = [];
    applyHistoryFilters();
  });
}

function applyHistoryFilters() {
  const term = document.getElementById('historySearch')?.value.toLowerCase() || '';
  const label = document.getElementById('historyFilter')?.value || 'all';
  const sort = document.getElementById('historySort')?.value || 'newest';
  const filtered = allHistory.filter(item => {
    if (!item) return false;
    const matchesLabel = label === 'all' || item.label === label;
    const itemUrl = (item.url || item.filename || '').toLowerCase();
    const matchesTerm = !term || itemUrl.includes(term);
    return matchesLabel && matchesTerm;
  });
  filtered.sort((a, b) => {
    if (sort === 'highest') return (b?.score ?? 0) - (a?.score ?? 0);
    if (sort === 'lowest') return (a?.score ?? 0) - (b?.score ?? 0);
    return (b?.timestamp ?? 0) - (a?.timestamp ?? 0);
  });
  renderHistoryList(filtered);
}

function escapeHtml(value = '') { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }

function renderHistoryList(history) {
  const historyList  = document.getElementById('historyList');
  const historyEmpty = document.getElementById('historyEmpty');
  if (!historyList || !historyEmpty) return;

  historyList.innerHTML = '';

  if (!history || history.length === 0) {
    historyEmpty.style.display = 'block';
    historyList.style.display  = 'none';
    return;
  }

  historyEmpty.style.display = 'none';
  historyList.style.display  = 'flex';

  history.forEach(item => {
    if (!item) return;
    let displayDomain = item.url || item.filename || 'Unknown';
    try {
      if (item.url) displayDomain = new URL(item.url).hostname || displayDomain;
    } catch { /* fallback */ }

    const li = document.createElement('li');
    li.className = 'history-item';

    const info     = document.createElement('div');
    info.className = 'history-info';

    const urlSpan        = document.createElement('span');
    urlSpan.className    = 'history-url';
    urlSpan.textContent  = displayDomain;
    urlSpan.title        = item.url || item.filename || '';

    const timeSpan       = document.createElement('span');
    timeSpan.className   = 'history-time';
    timeSpan.textContent = formatRelativeTime(item.timestamp);

    info.appendChild(urlSpan);
    info.appendChild(timeSpan);

    const badgeWrapper     = document.createElement('div');
    badgeWrapper.className = 'history-badge-wrapper';

    const badge       = document.createElement('span');
    badge.className   = `history-badge ${labelToCSSClass(item.label)}`;
    badge.textContent = item.label || 'Scanned';

    badgeWrapper.appendChild(badge);
    li.appendChild(info);
    li.appendChild(badgeWrapper);
    historyList.appendChild(li);
  });
}

// ───────────────────────────────────────────────────────
// RENDER: ERROR STATE
// ───────────────────────────────────────────────────────

function renderError(message) {
  const el = id => document.getElementById(id);

  if (el('statusText'))  el('statusText').textContent  = 'Error';
  if (el('urlDisplay'))  el('urlDisplay').textContent  = message;
  if (el('riskScore'))   el('riskScore').textContent   = '—';
  if (el('labelText'))   el('labelText').textContent   = 'Unknown';
  if (el('scoreDetail')) el('scoreDetail').textContent = 'Could not complete scan.';
  if (el('riskCard'))    el('riskCard').className       = 'card risk-card state-danger';

  const list = el('checksList');
  if (list) {
    list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'check-item check-fail';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'check-icon';
    iconSpan.innerHTML = `
      <svg class="check-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>`;

    const textSpan = document.createElement('span');
    textSpan.className = 'check-text';
    textSpan.textContent = message;

    li.appendChild(iconSpan);
    li.appendChild(textSpan);
    list.appendChild(li);
  }
}

// ───────────────────────────────────────────────────────
// UTILITIES
// ───────────────────────────────────────────────────────

/**
 * riskDescription(score, isHttps, checks)
 *
 * Generates a professional explanation aligned with the risk model.
 */
function riskDescription(score, isHttps, checks = []) {
  if (score <= 5) return 'No significant threats detected. This site appears safe.';

  // Collect human-readable reasons from failed checks
  const reasons = checks
    .filter(c => !c.passed && !c.warn)
    .map(c => c.label.toLowerCase())
    .slice(0, 3); // Get top 3 reasons

  if (score <= 20) {
    if (reasons.length === 0) return 'Minor anomalies detected. Generally safe.';
    const list = reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('');
    return `Low risk indicators:<ul style="margin: 4px 0 0 16px; padding: 0;">${list}</ul>`;
  }

  if (score <= 45) {
    if (reasons.length === 0) return 'Moderate risk detected. Proceed with caution.';
    const list = reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('');
    return `This site requires caution because:<ul style="margin: 4px 0 0 16px; padding: 0;">${list}</ul>`;
  }

  if (reasons.length === 0) return 'High threat level detected! Avoid entering personal information.';
  const list = reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('');
  return `This site appears dangerous because:<ul style="margin: 4px 0 0 16px; padding: 0;">${list}</ul>`;
}

/**
 * labelToCSSClass(label)
 * Maps the risk label string to a CSS modifier class.
 *
 * Safe          → 'safe'   (green)
 * Low Risk      → 'low'    (blue)
 * Moderate Risk → 'moderate' (amber)
 * Dangerous     → 'danger'  (red)
 */
function labelToCSSClass(label) {
  const map = {
    'Safe':          'safe',
    'Low Risk':      'low',
    'Moderate Risk': 'moderate',
    'Dangerous':     'danger'
  };
  return map[label] ?? 'safe';
}

/**
 * formatRelativeTime(timestamp)
 */
function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 60000)   return 'Just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60)      return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24)     return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
