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

document.addEventListener('DOMContentLoaded', initPopup);

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

    chrome.runtime.sendMessage({ type: 'ANALYSE_URL', url: tab.url }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[SentinelX Popup] Message error:', chrome.runtime.lastError);
        renderError('Background script unavailable.');
        return;
      }
      if (response && response.result) {
        renderResults(response.result);
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
    li.innerHTML = `<span class="check-icon">${svgIcon}</span><span class="check-text">${label}</span>`;
    list.appendChild(li);
  });
}

// ───────────────────────────────────────────────────────
// RENDER: SCAN HISTORY
// ───────────────────────────────────────────────────────

async function loadScanHistory() {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  try {
    const data = await chrome.storage.local.get('sentinelx_history');
    renderHistoryList(data.sentinelx_history || []);
  } catch (err) {
    console.error('[SentinelX Popup] Error loading scan history:', err);
  }
}

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
    let displayDomain = item.url;
    try { displayDomain = new URL(item.url).hostname; } catch { /* fallback */ }

    const li = document.createElement('li');
    li.className = 'history-item';

    const info     = document.createElement('div');
    info.className = 'history-info';

    const urlSpan        = document.createElement('span');
    urlSpan.className    = 'history-url';
    urlSpan.textContent  = displayDomain;
    urlSpan.title        = item.url;

    const timeSpan       = document.createElement('span');
    timeSpan.className   = 'history-time';
    timeSpan.textContent = formatRelativeTime(item.timestamp);

    info.appendChild(urlSpan);
    info.appendChild(timeSpan);

    const badgeWrapper     = document.createElement('div');
    badgeWrapper.className = 'history-badge-wrapper';

    const badge       = document.createElement('span');
    badge.className   = `history-badge ${labelToCSSClass(item.label)}`;
    badge.textContent = item.label;

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
    list.innerHTML = `
      <li class="check-item check-fail">
        <span class="check-icon">
          <svg class="check-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </span>
        <span class="check-text">${message}</span>
      </li>`;
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
    const list = reasons.map(r => `<li>${r}</li>`).join('');
    return `Low risk indicators:<ul style="margin: 4px 0 0 16px; padding: 0;">${list}</ul>`;
  }

  if (score <= 45) {
    if (reasons.length === 0) return 'Moderate risk detected. Proceed with caution.';
    const list = reasons.map(r => `<li>${r}</li>`).join('');
    return `This site requires caution because:<ul style="margin: 4px 0 0 16px; padding: 0;">${list}</ul>`;
  }

  if (reasons.length === 0) return 'High threat level detected! Avoid entering personal information.';
  const list = reasons.map(r => `<li>${r}</li>`).join('');
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
