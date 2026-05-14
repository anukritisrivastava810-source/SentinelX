/**
 * ═══════════════════════════════════════════════════════
 * SentinelX — background.js  (Manifest V3 Service Worker)
 *
 * PURPOSE:
 *   This is the persistent "brain" of the extension. It runs
 *   as a background service worker — meaning it:
 *     - Has NO access to the DOM
 *     - Runs in its own isolated JS context
 *     - Can be terminated by Chrome when idle (MV3 behaviour)
 *     - Restarts on the next event (like a message or tab change)
 *
 *   Responsibilities:
 *     1. Listen for tab activation / URL changes
 *     2. Receive "ANALYSE_URL" messages from popup.js
 *     3. Run URL risk analysis
 *     4. Store scan results in chrome.storage.local
 *     5. Communicate results back to popup.js
 *     6. Forward high-risk verdicts to content.js as warnings
 *
 * WHY SERVICE WORKER?
 *   Manifest V3 replaced persistent background pages with
 *   service workers for better performance and resource usage.
 *   A service worker is event-driven: it wakes up when needed,
 *   does its job, and can be suspended again.
 *
 * COMMUNICATION FLOW:
 *   [popup.js] --sendMessage--> [background.js] --sendResponse--> [popup.js]
 *   [background.js] --sendMessage--> [content.js]  (for warnings)
 * ═══════════════════════════════════════════════════════
 */

'use strict';

// ───────────────────────────────────────────────────────
// 1. INSTALL / STARTUP EVENTS
// ───────────────────────────────────────────────────────

/**
 * onInstalled fires when:
 *   - The extension is first installed
 *   - The extension is updated to a new version
 *   - Chrome is updated
 * Good place to set default storage values.
 */
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[SentinelX BG] Extension installed/updated:', details.reason);

  // Initialise storage with default values
  chrome.storage.local.set({
    sentinelx_version: '1.0.0',
    sentinelx_scan_count: 0,
    sentinelx_last_scan: null,
  });
});

/**
 * onStartup fires when Chrome starts with the extension already installed.
 */
chrome.runtime.onStartup.addListener(() => {
  console.log('[SentinelX BG] Browser started. Extension ready.');
});

// ───────────────────────────────────────────────────────
// 2. TAB MONITORING
// ───────────────────────────────────────────────────────

/**
 * onActivated fires when the user switches to a different tab.
 * We use this to pre-analyse the new active tab so results are
 * ready when the user opens the popup.
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    // Fetch full tab info to get the URL
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && isAnalysableUrl(tab.url)) {
      console.log('[SentinelX BG] Tab activated:', tab.url);
      await analyseAndStore(tab.url, tab.id);
    }
  } catch (err) {
    console.error('[SentinelX BG] onActivated error:', err);
  }
});

/**
 * onUpdated fires when a tab's state changes — including when a
 * navigation completes (status === 'complete').
 * This catches page navigations within the same tab.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only act when the page has finished loading AND has a URL
  if (changeInfo.status === 'complete' && tab.url && isAnalysableUrl(tab.url)) {
    console.log('[SentinelX BG] Tab updated:', tab.url);
    await analyseAndStore(tab.url, tabId);
  }
});

// ───────────────────────────────────────────────────────
// 3. MESSAGE LISTENER (from popup.js and content.js)
// ───────────────────────────────────────────────────────

/**
 * onMessage is the central message bus for the extension.
 * All chrome.runtime.sendMessage() calls are handled here.
 *
 * IMPORTANT: To use sendResponse asynchronously (after an await),
 * the listener MUST return `true`. This keeps the message channel
 * open until sendResponse is called.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[SentinelX BG] Message received:', message.type, 'from:', sender.tab?.url ?? 'popup');

  // Route messages by type
  switch (message.type) {

    // ── Popup requests a URL analysis ──
    case 'ANALYSE_URL': {
      handleAnalyseRequest(message.url)
        .then((result) => sendResponse({ result }))
        .catch((err) => {
          console.error('[SentinelX BG] Analysis error:', err);
          sendResponse({ error: err.message });
        });
      return true; // ← keeps channel open for async sendResponse
    }

    // ── Content script reports page info ──
    case 'PAGE_INFO': {
      console.log('[SentinelX BG] Page info from content script:', message.data);
      sendResponse({ received: true });
      break;
    }

    default:
      console.warn('[SentinelX BG] Unknown message type:', message.type);
  }
});

// ───────────────────────────────────────────────────────
// 4. ANALYSIS ORCHESTRATOR
// ───────────────────────────────────────────────────────

/**
 * handleAnalyseRequest(url)
 * Called when popup.js asks for a URL analysis.
 * Checks storage for a cached result first; otherwise runs fresh analysis.
 *
 * @param {string} url
 * @returns {Promise<Object>} result object
 */
async function handleAnalyseRequest(url) {
  // Check cache first (avoid re-running analysis for the same URL)
  const cached = await getCachedResult(url);
  if (cached) {
    console.log('[SentinelX BG] Returning cached result for:', url);
    return cached;
  }

  // Run full analysis
  const result = analyseUrl(url);

  // Persist to storage
  await storeResult(url, result);

  // If high-risk, tell the content script to show a warning banner
  if (result.score >= 60) {
    await notifyContentScript(result);
  }

  return result;
}

/**
 * analyseAndStore(url, tabId)
 * Background pre-analysis called on tab changes.
 * Results are stored so the popup can retrieve them instantly.
 */
async function analyseAndStore(url, tabId) {
  try {
    const result = analyseUrl(url);
    await storeResult(url, result);

    // Notify content script if suspicious
    if (result.score >= 60) {
      chrome.tabs.sendMessage(tabId, {
        type: 'SHOW_WARNING',
        data: result,
      }).catch(() => {
        // Content script may not be ready yet — silently ignore
      });
    }
  } catch (err) {
    console.error('[SentinelX BG] analyseAndStore error:', err);
  }
}

// ───────────────────────────────────────────────────────
// 5. CORE URL RISK ANALYSIS ENGINE
// ───────────────────────────────────────────────────────

/**
 * analyseUrl(url)
 * Runs all security checks on a URL and returns a structured result.
 *
 * Each check contributes a penalty to the total risk score (0-100).
 * The checks array is also returned for display in the popup UI.
 *
 * @param {string} url - The full URL string to analyse
 * @returns {Object} { score, label, isHttps, checks, url, timestamp }
 */
function analyseUrl(url) {
  let score = 0;
  const checks = [];

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    // Unparseable URL — give it a moderate risk score
    return buildResult(url, 50, [{ label: 'Invalid URL format', passed: false }]);
  }

  const { protocol, hostname, pathname, href } = parsedUrl;

  // ── Check 1: HTTPS ───────────────────────────────────
  const isHttps = protocol === 'https:';
  if (!isHttps) {
    score += 35; // Heavy penalty for plain HTTP
    checks.push({ label: 'Protocol: HTTP (unencrypted traffic)', passed: false });
  } else {
    checks.push({ label: 'Protocol: HTTPS (encrypted)', passed: true });
  }

  // ── Check 2: IP-based URL ────────────────────────────
  // Legitimate sites use domain names; IP URLs are suspicious
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipRegex.test(hostname)) {
    score += 30;
    checks.push({ label: 'IP-based URL (no domain name)', passed: false });
  } else {
    checks.push({ label: 'Domain-based URL', passed: true });
  }

  // ── Check 3: Suspicious keywords in URL ──────────────
  const suspiciousKeywords = [
    'login', 'signin', 'verify', 'secure', 'account',
    'update', 'confirm', 'banking', 'paypal', 'ebay',
    'password', 'credential', 'free-gift', 'prize',
  ];
  const lowerHref = href.toLowerCase();
  const matchedKeywords = suspiciousKeywords.filter(kw => lowerHref.includes(kw));

  if (matchedKeywords.length > 0) {
    const penalty = Math.min(matchedKeywords.length * 10, 25); // cap at 25
    score += penalty;
    checks.push({
      label: `Suspicious keywords found: ${matchedKeywords.slice(0, 3).join(', ')}`,
      passed: false,
    });
  } else {
    checks.push({ label: 'No suspicious keywords detected', passed: true });
  }

  // ── Check 4: Excessively long domain ─────────────────
  // Long hostnames are a phishing tactic (e.g., paypal.com.secure-update.xyz)
  if (hostname.length > 40) {
    score += 15;
    checks.push({ label: `Very long domain name (${hostname.length} chars)`, passed: false });
  } else if (hostname.length > 25) {
    score += 5;
    checks.push({ label: `Moderately long domain (${hostname.length} chars)`, passed: false, warn: true });
  } else {
    checks.push({ label: `Domain length normal (${hostname.length} chars)`, passed: true });
  }

  // ── Check 5: Subdomain depth ─────────────────────────
  // Many subdomains can indicate phishing (e.g., secure.paypal.verify.evil.com)
  const subdomainParts = hostname.split('.');
  if (subdomainParts.length > 4) {
    score += 15;
    checks.push({ label: `Deep subdomain chain (${subdomainParts.length} levels)`, passed: false });
  } else {
    checks.push({ label: `Normal subdomain depth`, passed: true });
  }

  // ── Check 6: Suspicious TLDs ─────────────────────────
  const suspiciousTLDs = ['.tk', '.ml', '.ga', '.cf', '.gq', '.xyz', '.top', '.click', '.loan'];
  const hasSuspiciousTLD = suspiciousTLDs.some(tld => hostname.endsWith(tld));
  if (hasSuspiciousTLD) {
    score += 15;
    checks.push({ label: `High-risk TLD detected`, passed: false });
  } else {
    checks.push({ label: 'Standard TLD', passed: true });
  }

  // ── Check 7: Special / non-HTTP protocols ────────────
  if (protocol !== 'http:' && protocol !== 'https:') {
    // e.g., ftp:, data:, javascript:
    score += 10;
    checks.push({ label: `Non-standard protocol: ${protocol}`, passed: false, warn: true });
  }

  // Cap score at 100
  score = Math.min(score, 100);

  return buildResult(url, score, checks, isHttps);
}

/**
 * buildResult(url, score, checks, isHttps)
 * Assembles the final result object with a human-readable label.
 */
function buildResult(url, score, checks, isHttps = true) {
  let label;
  if (score < 40)      label = 'Safe';
  else if (score < 70) label = 'Moderate Risk';
  else                 label = 'Dangerous';

  return {
    url,
    score,
    label,
    isHttps,
    checks,
    timestamp: Date.now(),
  };
}

// ───────────────────────────────────────────────────────
// 6. STORAGE HELPERS
// ───────────────────────────────────────────────────────

/**
 * storeResult(url, result)
 * Saves the analysis result to chrome.storage.local.
 *
 * WHY chrome.storage.local?
 *   Unlike localStorage (which doesn't exist in service workers),
 *   chrome.storage.local is async, persists across browser restarts,
 *   and works in both service workers and content scripts.
 *
 * Key format: sentinelx_scan:<encoded-url>
 */
async function storeResult(url, result) {
  // Use URL as part of the key (encode to avoid special chars)
  const key = `sentinelx_scan:${encodeURIComponent(url).slice(0, 100)}`;

  await chrome.storage.local.set({ [key]: result });

  // Also update the global scan count
  const { sentinelx_scan_count = 0 } = await chrome.storage.local.get('sentinelx_scan_count');
  await chrome.storage.local.set({
    sentinelx_scan_count: sentinelx_scan_count + 1,
    sentinelx_last_scan: Date.now(),
  });

  console.log('[SentinelX BG] Result stored. Total scans:', sentinelx_scan_count + 1);
}

/**
 * getCachedResult(url)
 * Returns a cached result if it's less than 5 minutes old.
 * Prevents redundant re-analysis of the same URL.
 */
async function getCachedResult(url) {
  const key = `sentinelx_scan:${encodeURIComponent(url).slice(0, 100)}`;
  const data = await chrome.storage.local.get(key);
  const cached = data[key];

  if (!cached) return null;

  // Cache TTL: 5 minutes (300,000 ms)
  const age = Date.now() - (cached.timestamp || 0);
  if (age < 300_000) return cached;

  return null; // Cache expired
}

// ───────────────────────────────────────────────────────
// 7. CONTENT SCRIPT NOTIFIER
// ───────────────────────────────────────────────────────

/**
 * notifyContentScript(result)
 * Sends a SHOW_WARNING message to the content script of the active tab.
 * The content script will then inject a warning banner into the page DOM.
 */
async function notifyContentScript(result) {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) return;

    chrome.tabs.sendMessage(activeTab.id, {
      type: 'SHOW_WARNING',
      data: result,
    }).catch(() => {
      // The content script might not have loaded yet on this tab — safe to ignore
      console.log('[SentinelX BG] Content script not yet ready on this tab.');
    });
  } catch (err) {
    console.error('[SentinelX BG] notifyContentScript error:', err);
  }
}

// ───────────────────────────────────────────────────────
// 8. UTILITIES
// ───────────────────────────────────────────────────────

/**
 * isAnalysableUrl(url)
 * Returns true if this URL should be analysed.
 * We skip Chrome internal pages (chrome://, about:, etc.)
 */
function isAnalysableUrl(url) {
  if (!url) return false;
  const nonAnalysable = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'moz-extension://'];
  return !nonAnalysable.some(prefix => url.startsWith(prefix));
}

console.log('[SentinelX BG] Service worker initialised ✓');
