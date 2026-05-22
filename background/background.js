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
// 2. DEBOUNCE TRACKER & TAB MONITORING
// ───────────────────────────────────────────────────────

const activeScans = new Map();
const SCAN_COOLDOWN_MS = 2000;

/**
 * shouldThrottleScan(url)
 * Prevents redundant concurrent scans on the same URL within cooldown.
 */
function shouldThrottleScan(url) {
  const now = Date.now();
  if (activeScans.has(url)) {
    const lastScanTime = activeScans.get(url);
    if (now - lastScanTime < SCAN_COOLDOWN_MS) {
      return true;
    }
  }
  activeScans.set(url, now);
  if (activeScans.size > 100) {
    for (const [k, v] of activeScans.entries()) {
      if (now - v > SCAN_COOLDOWN_MS) {
        activeScans.delete(k);
      }
    }
  }
  return false;
}

/**
 * onActivated fires when the user switches to a different tab.
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
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
 * onUpdated fires when a tab finishes navigation.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && isAnalysableUrl(tab.url)) {
    console.log('[SentinelX BG] Tab updated:', tab.url);
    await analyseAndStore(tab.url, tabId);
  }
});

// ───────────────────────────────────────────────────────
// 3. MESSAGE LISTENER
// ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[SentinelX BG] Message received:', message.type, 'from:', sender.tab?.url ?? 'popup');

  switch (message.type) {
    case 'ANALYSE_URL': {
      handleAnalyseRequest(message.url)
        .then((result) => sendResponse({ result }))
        .catch((err) => {
          console.error('[SentinelX BG] Analysis error:', err);
          sendResponse({ error: err.message });
        });
      return true;
    }

    case 'PAGE_INFO': {
      console.log('[SentinelX BG] Page info from content script:', message.data);
      handlePageInfo(message.data, sender)
        .then(() => sendResponse({ received: true }))
        .catch((err) => {
          console.error('[SentinelX BG] handlePageInfo error:', err);
          sendResponse({ error: err.message });
        });
      return true;
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
 * Called by popup.js when opening the popup.
 */
async function handleAnalyseRequest(url) {
  const cached = await getCachedResult(url);
  if (cached) {
    console.log('[SentinelX BG] Returning cached result for:', url);
    return cached;
  }

  const result = analyseUrl(url);
  await storeResult(url, result);

  if (result.score >= 51) {
    await notifyContentScript(result);
  }

  return result;
}

/**
 * analyseAndStore(url, tabId)
 * Performs baseline scans on page update.
 */
async function analyseAndStore(url, tabId) {
  try {
    if (shouldThrottleScan(url)) {
      console.log('[SentinelX BG] Throttling redundant scan for:', url);
      return;
    }
    const result = analyseUrl(url);
    await storeResult(url, result);

    if (result.score >= 51) {
      chrome.tabs.sendMessage(tabId, {
        type: 'SHOW_WARNING',
        data: result,
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[SentinelX BG] analyseAndStore error:', err);
  }
}

/**
 * handlePageInfo(data, sender)
 * Merges content-based findings reported by content.js DOM scanner.
 */
async function handlePageInfo(data, sender) {
  const { url, hasPasswordInput, insecureAction, actionDomainMismatch, hasExcessiveHiddenInputs, hasSuspiciousButtons } = data;
  if (!url) return;

  // Retrieve existing baseline URL scan or generate new
  let result = await getCachedResult(url);
  if (!result) {
    result = analyseUrl(url);
  }

  // Clear previous content checks (to avoid duplicates on reload)
  result.checks = result.checks.filter(c => !c.isContentCheck);

  let scoreAdjustment = 0;
  const contentChecks = [];

  if (hasPasswordInput) {
    if (!result.isHttps) {
      scoreAdjustment += 25;
      contentChecks.push({ label: 'Insecure password field detected on HTTP page', passed: false, isContentCheck: true });
    } else {
      contentChecks.push({ label: 'Password field detected (HTTPS secured)', passed: true, isContentCheck: true });
    }
  }

  if (insecureAction) {
    scoreAdjustment += 25;
    contentChecks.push({ label: 'Insecure HTTP form submission target', passed: false, isContentCheck: true });
  }

  if (actionDomainMismatch) {
    scoreAdjustment += 20;
    contentChecks.push({ label: 'Form action target domain mismatch', passed: false, isContentCheck: true });
  }

  if (hasExcessiveHiddenInputs) {
    scoreAdjustment += 15;
    contentChecks.push({ label: 'Excessive hidden input fields detected', passed: false, isContentCheck: true });
  }

  if (hasSuspiciousButtons) {
    if (result.score >= 35) {
      scoreAdjustment += 15;
      contentChecks.push({ label: 'Suspicious call-to-action button keywords', passed: false, isContentCheck: true });
    }
  }

  if (contentChecks.length > 0) {
    result.checks = [...result.checks, ...contentChecks];
    result.score = Math.min(100, result.score + scoreAdjustment);

    // Re-evaluate risk label using unified thresholds
    if (result.score <= 20)      result.label = 'Safe';
    else if (result.score <= 50) result.label = 'Moderate Risk';
    else                         result.label = 'Dangerous';
  }

  await storeResult(url, result);

  // Trigger warning banner update if threat rating is elevated
  if (result.score >= 51 && sender.tab?.id) {
    chrome.tabs.sendMessage(sender.tab.id, {
      type: 'SHOW_WARNING',
      data: result
    }).catch(() => {});
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
/**
 * detectBrandImpersonation(hostname)
 * Checks if the hostname resembles a popular brand but is not hosted on an official domain.
 * Supports character substitutions (leetspeak homoglyphs).
 */
function detectBrandImpersonation(hostname) {
  const brands = [
    { name: 'paypal', official: ['paypal.com', 'paypal.co.uk'] },
    { name: 'google', official: ['google.com', 'google.co.in', 'google.net', 'google.org'] },
    { name: 'microsoft', official: ['microsoft.com', 'microsoftonline.com'] },
    { name: 'apple', official: ['apple.com'] },
    { name: 'amazon', official: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.in'] },
    { name: 'netflix', official: ['netflix.com'] },
    { name: 'facebook', official: ['facebook.com'] },
    { name: 'instagram', official: ['instagram.com'] },
    { name: 'github', official: ['github.com'] },
    { name: 'chase', official: ['chase.com'] }
  ];

  const hostLower = hostname.toLowerCase();

  // Normalize typical leetspeak translations
  const normalized = hostLower
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/8/g, 'b')
    .replace(/vv/g, 'w');

  for (const brand of brands) {
    if (hostLower.includes(brand.name) || normalized.includes(brand.name)) {
      const isOfficial = brand.official.some(officialDomain => {
        return hostLower === officialDomain || hostLower.endsWith('.' + officialDomain);
      });
      if (!isOfficial) {
        return { impersonated: true, brand: brand.name };
      }
    }
  }
  return { impersonated: false };
}

/**
 * analyseUrl(url)
 * Runs advanced heuristics on a URL to evaluate its threat level.
 *
 * @param {string} url - Full URL string
 * @returns {Object} { score, label, isHttps, checks, url, timestamp }
 */
function analyseUrl(url) {
  let score = 0;
  const checks = [];

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return buildResult(url, 50, [{ label: 'Invalid URL format', passed: false }]);
  }

  const { protocol, hostname, pathname, href } = parsedUrl;

  // ── 1. Protocol Check (HTTP vs HTTPS) ──
  const isHttps = protocol === 'https:';
  if (!isHttps) {
    score += 35;
    checks.push({ label: 'Protocol: HTTP (unencrypted connection)', passed: false });
  } else {
    checks.push({ label: 'Protocol: HTTPS (encrypted)', passed: true });
  }

  // ── 2. IP-based URL Check ──
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipRegex.test(hostname)) {
    score += 30;
    checks.push({ label: 'IP-based host (no domain name)', passed: false });
  } else {
    checks.push({ label: 'Domain-based host', passed: true });
  }

  // ── 3. Suspicious Keywords Check ──
  const suspiciousKeywords = [
    'login', 'signin', 'verify', 'secure', 'account',
    'update', 'confirm', 'banking', 'paypal', 'ebay',
    'password', 'credential', 'free-gift', 'prize'
  ];
  const lowerHref = href.toLowerCase();
  const matchedKeywords = suspiciousKeywords.filter(kw => lowerHref.includes(kw));

  if (matchedKeywords.length > 0) {
    const penalty = Math.min(matchedKeywords.length * 10, 25);
    score += penalty;
    checks.push({
      label: `Suspicious keywords: ${matchedKeywords.slice(0, 3).join(', ')}`,
      passed: false
    });
  } else {
    checks.push({ label: 'No suspicious URL keywords', passed: true });
  }

  // ── 4. Domain Length Check ──
  if (hostname.length > 40) {
    score += 15;
    checks.push({ label: `Excessive domain length (${hostname.length} chars)`, passed: false });
  } else if (hostname.length > 25) {
    score += 5;
    checks.push({ label: `Moderate domain length (${hostname.length} chars)`, passed: false, warn: true });
  } else {
    checks.push({ label: 'Domain length normal', passed: true });
  }

  // ── 5. Subdomain Depth Check ──
  const subdomainParts = hostname.split('.');
  let depthThreshold = 4;
  const isDoubleTld = subdomainParts.length > 2 && 
    ['co', 'com', 'org', 'net', 'gov', 'edu'].includes(subdomainParts[subdomainParts.length - 2]);
  if (isDoubleTld) {
    depthThreshold = 5;
  }

  if (subdomainParts.length > depthThreshold) {
    score += 15;
    checks.push({ label: `Deep subdomain chain (${subdomainParts.length} levels)`, passed: false });
  } else {
    checks.push({ label: 'Normal subdomain depth', passed: true });
  }

  // ── 6. Suspicious TLD Check ──
  const suspiciousTLDs = ['.tk', '.ml', '.ga', '.cf', '.gq', '.xyz', '.top', '.click', '.loan', '.link', '.zip', '.mov'];
  const hasSuspiciousTLD = suspiciousTLDs.some(tld => hostname.endsWith(tld));
  if (hasSuspiciousTLD) {
    score += 15;
    checks.push({ label: 'High-risk TLD detected', passed: false });
  } else {
    checks.push({ label: 'Standard TLD', passed: true });
  }

  // ── 7. URL Shorteners Check ──
  const shorteners = [
    'bit.ly', 'tinyurl.com', 't.co', 'cutt.ly', 'is.gd',
    'buff.ly', 'ow.ly', 'bl.ink', 'v.gd', 'shorturl.at', 'tiny.cc'
  ];
  const isShortener = shorteners.some(s => hostname === s || hostname.endsWith('.' + s));
  if (isShortener) {
    score += 25;
    checks.push({ label: 'URL shortener domain detected', passed: false, warn: true });
  }

  // ── 8. Excessive Hyphens Check ──
  const hyphenCount = (hostname.match(/-/g) || []).length;
  if (hyphenCount > 2) {
    score += 15;
    checks.push({ label: `Excessive domain hyphens (${hyphenCount})`, passed: false });
  }

  // ── 9. Suspicious Brand Impersonation Check ──
  const brandImpersonation = detectBrandImpersonation(hostname);
  if (brandImpersonation.impersonated) {
    score += 30;
    checks.push({ label: `Brand impersonation: resembles official ${brandImpersonation.brand} domain`, passed: false });
  } else {
    checks.push({ label: 'No brand impersonation detected', passed: true });
  }

  // ── 10. Suspicious Characters/Encoding Check ──
  const encodedSymbols = (url.match(/%/g) || []).length;
  const containsAtSymbol = hostname.includes('@');
  const containsBackslash = pathname.includes('\\');

  if (encodedSymbols > 3 || containsAtSymbol || containsBackslash) {
    score += 15;
    let reason = 'Suspicious URL encoding / symbols';
    if (containsAtSymbol) reason += ' (@ credentials)';
    if (containsBackslash) reason += ' (backslash obfuscation)';
    checks.push({ label: reason, passed: false });
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
  // Unified risk thresholds: 0-20 Safe | 21-50 Moderate Risk | 51-100 Dangerous
  let label;
  if (score <= 20)      label = 'Safe';
  else if (score <= 50) label = 'Moderate Risk';
  else                  label = 'Dangerous';

  // Structured debug log — visible in the background service worker console
  const failedChecks = checks.filter(c => !c.passed).map(c => c.label);
  console.group(`%c[SentinelX] Risk Analysis`, 'color:#6366f1;font-weight:bold');
  console.log(`URL:        ${url}`);
  console.log(`Risk Score: ${score}/100`);
  console.log(`Label:      ${label}`);
  if (failedChecks.length > 0) {
    console.log(`Penalties:`);
    failedChecks.forEach(r => console.log(`  ✗ ${r}`));
  } else {
    console.log('Penalties:  none — site is clean');
  }
  console.groupEnd();

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
/**
 * storeResult(url, result)
 * Saves the analysis result to chrome.storage.local.
 */
async function storeResult(url, result) {
  const key = `sentinelx_scan:${encodeURIComponent(url).slice(0, 100)}`;
  await chrome.storage.local.set({ [key]: result });

  // Update rolling log scan history
  await addToHistory(result);

  const { sentinelx_scan_count = 0 } = await chrome.storage.local.get('sentinelx_scan_count');
  await chrome.storage.local.set({
    sentinelx_scan_count: sentinelx_scan_count + 1,
    sentinelx_last_scan: Date.now(),
  });

  console.log('[SentinelX BG] Result stored. Total scans:', sentinelx_scan_count + 1);
}

/**
 * addToHistory(result)
 * Updates the rolling log history of up to 10 unique scans.
 */
async function addToHistory(result) {
  try {
    const data = await chrome.storage.local.get('sentinelx_history');
    let history = data.sentinelx_history || [];

    // Filter out previous entry of the same URL to keep it unique
    history = history.filter(h => h.url !== result.url);

    // Prepend the new scan
    history.unshift({
      url: result.url,
      score: result.score,
      label: result.label,
      timestamp: Date.now()
    });

    // Cap at 10 items
    if (history.length > 10) {
      history = history.slice(0, 10);
    }

    await chrome.storage.local.set({ sentinelx_history: history });
  } catch (err) {
    console.error('[SentinelX BG] addToHistory error:', err);
  }
}

/**
 * getCachedResult(url)
 * Returns a cached result if it's less than 5 minutes old.
 */
async function getCachedResult(url) {
  const key = `sentinelx_scan:${encodeURIComponent(url).slice(0, 100)}`;
  const data = await chrome.storage.local.get(key);
  const cached = data[key];

  if (!cached) return null;

  const age = Date.now() - (cached.timestamp || 0);
  if (age < 300_000) return cached;

  return null;
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
