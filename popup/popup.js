/**
 * ═══════════════════════════════════════════════════════
 * SentinelX — popup.js
 *
 * PURPOSE:
 *   This is the "brain" of the popup UI. It runs every time
 *   the user clicks the extension icon. It:
 *     1. Queries the active tab to get the current URL
 *     2. Sends that URL to background.js for analysis
 *     3. Receives the risk result back
 *     4. Updates all UI elements (score ring, bar, badges, checks)
 *
 * LIFECYCLE:
 *   Popup HTML loads → DOMContentLoaded fires → we query the
 *   active tab → we message background.js → we render results.
 *   The popup is a SHORT-LIVED page: it is destroyed when the
 *   user clicks away. It has NO persistent state.
 *
 * COMMUNICATION:
 *   popup.js → background.js via chrome.runtime.sendMessage()
 *   background.js → popup.js via the sendResponse() callback
 * ═══════════════════════════════════════════════════════
 */

// ── Ring constants ──────────────────────────────────────
// SVG circle r=34 → circumference = 2 × π × 34 ≈ 213.63
const RING_CIRCUMFERENCE = 2 * Math.PI * 34; // 213.63

// ── Entry point: runs when popup HTML is fully parsed ───
document.addEventListener('DOMContentLoaded', initPopup);

/**
 * initPopup()
 * Gets the active tab, then asks background.js to analyse its URL.
 */
async function initPopup() {
  try {
    // chrome.tabs.query returns tabs matching the given filter.
    // { active: true, currentWindow: true } = the tab the user is looking at.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url) {
      renderError('Could not detect active tab.');
      return;
    }

    // Display the raw URL immediately so the UI feels responsive
    renderUrlSection(tab.url);

    // ── Ask background.js to analyse this URL ──────────────
    // chrome.runtime.sendMessage sends a one-time message to the
    // background service worker.  The second argument is the payload.
    // The callback receives whatever background.js calls sendResponse() with.
    chrome.runtime.sendMessage(
      { type: 'ANALYSE_URL', url: tab.url },
      (response) => {
        // chrome.runtime.lastError is set if the background script
        // is not running or the message port closed unexpectedly.
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
      }
    );

  } catch (err) {
    console.error('[SentinelX Popup] Init error:', err);
    renderError(err.message);
  }
}

// ═══════════════════════════════════════════════════════
// RENDER HELPERS
// ═══════════════════════════════════════════════════════

/**
 * renderUrlSection(url)
 * Shows the URL + sets the domain label badge.
 * Called immediately, before analysis completes.
 */
function renderUrlSection(url) {
  const urlDisplay = document.getElementById('urlDisplay');
  // Truncate very long URLs so they don't overflow the card
  urlDisplay.textContent = url.length > 60 ? url.slice(0, 57) + '…' : url;
  urlDisplay.title = url; // Show full URL on hover

  // Show domain in the meta badge
  try {
    const { hostname } = new URL(url);
    document.getElementById('domainLabel').textContent = hostname;
  } catch {
    document.getElementById('domainLabel').textContent = 'Unknown';
  }
}

/**
 * renderResults(result)
 * Takes the analysis object from background.js and populates
 * every UI element: score ring, bar, badges, checks list, footer.
 *
 * @param {Object} result - { score, label, isHttps, checks, url, timestamp }
 */
function renderResults(result) {
  const { score, label, isHttps, checks, timestamp } = result;

  // ── 1. Status pill ────────────────────────────────────
  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  const pillClass = labelToCSSClass(label); // 'safe' | 'moderate' | 'danger'
  statusPill.className = `status-pill ${pillClass}`;
  statusText.textContent = label;

  // ── 2. HTTPS badge ────────────────────────────────────
  const httpsBadge  = document.getElementById('httpsBadge');
  const httpsLabel  = document.getElementById('httpsLabel');
  if (isHttps) {
    httpsBadge.className = 'badge badge-secure';
    httpsLabel.textContent = 'HTTPS Secure';
  } else {
    httpsBadge.className = 'badge badge-insecure';
    httpsLabel.textContent = 'HTTP — Insecure';
  }

  // ── 3. Risk score ring (SVG stroke-dashoffset) ────────
  // dashoffset = circumference × (1 - score/100)
  // score 0   → full offset (empty ring)
  // score 100 → 0 offset (full ring)
  const ringFill  = document.getElementById('riskRingFill');
  const offset    = RING_CIRCUMFERENCE * (1 - score / 100);
  ringFill.style.strokeDashoffset = offset;
  ringFill.style.stroke = riskColor(score);   // dynamic colour

  // ── 4. Score number ───────────────────────────────────
  const scoreNumber = document.getElementById('riskScore');
  scoreNumber.textContent = score;
  scoreNumber.style.color = riskColor(score);

  // ── 5. Safety label text + dot ────────────────────────
  const labelDot  = document.getElementById('labelDot');
  const labelText = document.getElementById('labelText');
  const color     = riskColor(score);
  labelDot.style.background   = color;
  labelDot.style.boxShadow    = `0 0 8px ${color}`;
  labelText.textContent       = label;
  labelText.style.color       = color;

  // ── 6. Score detail description ───────────────────────
  document.getElementById('scoreDetail').textContent = riskDescription(score);

  // ── 7. Risk bar fill width ────────────────────────────
  document.getElementById('riskBarFill').style.width = `${score}%`;

  // ── 8. Checks list ────────────────────────────────────
  renderChecks(checks);

  // ── 9. Footer timestamp ───────────────────────────────
  if (timestamp) {
    const time = new Date(timestamp).toLocaleTimeString();
    document.getElementById('scanTime').textContent = `Scanned at ${time}`;
  }
}

/**
 * renderChecks(checks)
 * Populates the security checks list from the checks array.
 * Each check: { label, passed, warn }
 */
function renderChecks(checks) {
  const list = document.getElementById('checksList');
  list.innerHTML = ''; // Clear the loading placeholder

  if (!checks || checks.length === 0) {
    list.innerHTML = '<li class="check-item check-pending"><span class="check-icon">ℹ️</span><span class="check-text">No checks available.</span></li>';
    return;
  }

  checks.forEach(({ label, passed, warn }) => {
    const li = document.createElement('li');

    // Determine check state: pass / warn / fail
    let cssClass, icon;
    if (warn) {
      cssClass = 'check-warn';
      icon = '⚠️';
    } else if (passed) {
      cssClass = 'check-pass';
      icon = '✅';
    } else {
      cssClass = 'check-fail';
      icon = '❌';
    }

    li.className = `check-item ${cssClass}`;
    li.innerHTML = `
      <span class="check-icon">${icon}</span>
      <span class="check-text">${label}</span>
    `;
    list.appendChild(li);
  });
}

/**
 * renderError(message)
 * Shown when something goes wrong — e.g., background script down.
 */
function renderError(message) {
  document.getElementById('statusText').textContent = 'Error';
  document.getElementById('urlDisplay').textContent = message;
  document.getElementById('riskScore').textContent = '?';
  document.getElementById('labelText').textContent = 'Unknown';
  document.getElementById('scoreDetail').textContent = 'Could not complete scan.';
  document.getElementById('checksList').innerHTML =
    `<li class="check-item check-fail"><span class="check-icon">❌</span><span class="check-text">${message}</span></li>`;
}

// ═══════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════

/**
 * riskColor(score)
 * Maps a 0-100 score to a CSS colour string.
 *   0-39  → green (safe)
 *   40-69 → amber (moderate)
 *   70+   → red   (danger)
 */
function riskColor(score) {
  if (score < 40) return '#00ff9d';   // green
  if (score < 70) return '#ffb300';   // amber
  return '#ff3d5a';                   // red
}

/**
 * riskDescription(score)
 * Returns a human-readable description of the risk level.
 */
function riskDescription(score) {
  if (score === 0)  return 'No threats detected. Site appears clean.';
  if (score < 20)  return 'Very low risk. Minor anomalies only.';
  if (score < 40)  return 'Low risk. Proceed with normal caution.';
  if (score < 60)  return 'Moderate risk detected. Stay alert.';
  if (score < 80)  return 'High risk! Treat with caution.';
  return 'Critical threat indicators found!';
}

/**
 * labelToCSSClass(label)
 * Maps a safety label string to a CSS class name for the status pill.
 */
function labelToCSSClass(label) {
  const map = {
    'Safe':           'safe',
    'Moderate Risk':  'moderate',
    'Dangerous':      'danger',
  };
  return map[label] ?? 'safe';
}
