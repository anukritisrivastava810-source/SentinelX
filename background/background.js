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

import { lookupUrls } from '../src/services/safeBrowsingService.js';
import { getCache, setCache } from '../src/utils/cache.js';
import { aggregate } from '../src/services/aggregationEngine.js';
import { LOG } from '../src/utils/logger.js';
import { initialiseSettings, getSettings, isDomainWhitelisted, addWhitelistedDomain } from '../src/modules/settings.js';
import { initialiseDownloadMonitor } from '../src/modules/downloadMonitor.js';
import { initialiseRedirectMonitor } from '../src/modules/redirectMonitor.js';
import { recordPermissionRequest } from '../src/modules/permissionMonitor.js';
import { createSecurityReport } from '../src/modules/reports.js';
import { appendDashboardHistory, getDashboard, updateDashboard, DEFAULT_DASHBOARD } from '../src/modules/dashboard.js';

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
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[SentinelX BG] Extension installed/updated:', details.reason);

  // Initialise storage with default values
  const existing = await chrome.storage.local.get(['sentinelx_version', 'sentinelx_scan_count', 'sentinelx_last_scan']);
  await chrome.storage.local.set({
    sentinelx_version: '1.0.0',
    sentinelx_scan_count: existing.sentinelx_scan_count ?? 0,
    sentinelx_last_scan: existing.sentinelx_last_scan ?? null,
  });
  await initialiseSettings();
});

/**
 * onStartup fires when Chrome starts with the extension already installed.
 */
chrome.runtime.onStartup.addListener(() => {
  console.log('[SentinelX BG] Browser started. Extension ready.');
});

initialiseDownloadMonitor();
initialiseRedirectMonitor();

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
    if (!(await getSettings()).automaticScanning) return;
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
  if ((await getSettings()).automaticScanning && changeInfo.status === 'complete' && tab.url && isAnalysableUrl(tab.url)) {
    console.log('[SentinelX BG] Tab updated:', tab.url);
    await analyseAndStore(tab.url, tabId);
  }
});

// ───────────────────────────────────────────────────────
// 3. MESSAGE LISTENER
// ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    console.warn('[SentinelX BG] Rejected unauthorized message from sender:', sender?.id);
    return;
  }

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

    case 'PERMISSION_REQUEST': {
      recordPermissionRequest(message.data)
        .then((entry) => sendResponse({ received: Boolean(entry) }))
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    case 'GET_DASHBOARD': {
      getDashboardData(message?.url)
        .then((dashboard) => sendResponse({ ok: true, dashboard }))
        .catch(async (err) => {
          console.error('[SentinelX BG] getDashboardData error:', err);
          const fallback = await getDashboard().catch(() => ({ ...DEFAULT_DASHBOARD }));
          sendResponse({
            ok: true,
            dashboard: {
              ...fallback,
              statistics: {
                ...DEFAULT_DASHBOARD.statistics,
                ...(fallback?.statistics || {})
              },
              siteSummary: {
                host: '',
                downloadCount: 0,
                redirectCount: 0,
                permissionCount: 0,
                downloads: [],
                redirects: [],
                permissions: []
              }
            }
          });
        });
      return true;
    }

    case 'WHITELIST_DOMAIN': {
      const hostname = message.hostname;
      if (!hostname) {
        sendResponse({ ok: false, error: 'Missing hostname' });
        return false;
      }
      addWhitelistedDomain(hostname)
        .then(async (updatedList) => {
          if (sender.tab?.id) {
            await chrome.tabs.sendMessage(sender.tab.id, { type: 'HIDE_WARNING' }).catch(() => {});
          }
          sendResponse({ ok: true, whitelistedDomains: updatedList });
        })
        .catch((err) => {
          console.error('[SentinelX BG] WHITELIST_DOMAIN error:', err);
          sendResponse({ ok: false, error: err.message });
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
 * Performs a full analysis combining local heuristics and Safe Browsing.
 * It first runs the existing local `analyseUrl`, then checks the cache for a
 * Safe Browsing result. If missing, it queries the Safe Browsing service,
 * stores the result in the cache, and finally merges both using the
 * aggregation engine.
 *
 * @param {string} url – the URL to analyse
 * @returns {Promise<Object>} – the merged result object ready for storage.
 */
async function performFullAnalysis(url) {
  // 1️⃣ Local analysis (unchanged from previous implementation)
  const localResult = analyseUrl(url);

  // 2️⃣ Cloud reputation – check cache first
  let cloudResult = await getCache(url);
  if (!cloudResult) {
    try {
      // Indicate loading state for popup UI
      await chrome.storage.session.set({ cloudLoading: true });
      const cloudResponses = await lookupUrls([url]);
      cloudResult = cloudResponses[0] || { url, threatTypes: [], cacheDurationMs: null, skipped: true, cloudAvailable: false };
      // Cache the result only if a valid cloud lookup was completed (do not cache skipped/unavailable results)
      if (cloudResult && !cloudResult.skipped && cloudResult.cloudAvailable !== false) {
        await setCache(url, cloudResult, cloudResult.cacheDurationMs);
      }
    } finally {
      await chrome.storage.session.set({ cloudLoading: false });
    }
  }

  // 3️⃣ Merge local and cloud data
  return aggregate(localResult, cloudResult);
}

/**
 * Updated request handler – now uses the full analysis flow.
 *
 * TEMPORARY: Cache lookup is disabled while detector bugs are being debugged.
 * Every popup scan will re-run performFullAnalysis() so that freshly-patched
 * detectors (shortener, encoding, brand impersonation) always execute and their
 * console logs are visible in the service-worker DevTools.
 * Re-enable the cache block once all detectors are confirmed working.
 */
async function handleAnalyseRequest(url) {
  // ── CACHE DISABLED FOR DEBUGGING ──────────────────────────────────────────
  // const cached = await getCachedResult(url);
  // if (cached) {
  //   LOG.info('[SentinelX BG] Returning cached local result for:', url);
  //   return cached;
  // }
  // ──────────────────────────────────────────────────────────────────────────
  console.log('[SentinelX BG] Cache bypassed — running fresh analysis for:', url);

  const result = await performFullAnalysis(url);
  await storeResult(url, result);
  await syncTabWarning(result);
  return result;
}

/**
 * Updated background scan for tab activation / navigation.
 */
async function analyseAndStore(url, tabId) {
  try {
    if (shouldThrottleScan(url)) {
      LOG.info('[SentinelX BG] Throttling redundant scan for:', url);
      return;
    }
    const result = await performFullAnalysis(url);
    await storeResult(url, result);
    if (tabId) {
      await syncTabWarning(result, tabId);
    }
  } catch (err) {
    LOG.error('[SentinelX BG] analyseAndStore error:', err);
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

    // Re-evaluate risk label using unified thresholds (4-tier)
    if (result.score <= 5)       result.label = 'Safe';
    else if (result.score <= 20) result.label = 'Low Risk';
    else if (result.score <= 45) result.label = 'Moderate Risk';
    else                         result.label = 'Dangerous';
  }

  await storeResult(url, result, { recordDashboardEvent: false });
  await createSecurityReport(result, data);

  // Trigger warning banner update if threat rating meets sensitivity threshold, or hide if below
  if (sender.tab?.id) {
    await syncTabWarning(result, sender.tab.id);
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
 * levenshtein(a, b)
 * Calculates the Levenshtein distance between two strings.
 * Used for lightweight fuzzy matching (typosquatting).
 */
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * detectBrandImpersonation(hostname)
 * Checks if the hostname resembles a popular brand but is not hosted on an official domain.
 * Supports character substitutions (leetspeak) and edit-distance typosquatting.
 */
function detectBrandImpersonation(hostname) {
  const brands = [
    { name: 'paypal', official: ['paypal.com', 'paypal.co.uk', 'paypal.com.au'] },
    { name: 'google', official: ['google.com', 'google.co.in', 'google.net', 'google.org', 'google.co.uk'] },
    { name: 'microsoft', official: ['microsoft.com', 'microsoftonline.com'] },
    { name: 'apple', official: ['apple.com'] },
    { name: 'amazon', official: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.in'] },
    { name: 'netflix', official: ['netflix.com'] },
    { name: 'facebook', official: ['facebook.com'] },
    { name: 'instagram', official: ['instagram.com'] },
    { name: 'github', official: ['github.com'] },
    { name: 'chase', official: ['chase.com'] },
    { name: 'whatsapp', official: ['whatsapp.com'] },
    { name: 'linkedin', official: ['linkedin.com'] },
    { name: 'bankofamerica', official: ['bankofamerica.com', 'bofa.com'] },
    { name: 'gmail', official: ['gmail.com'] },
    { name: 'outlook', official: ['outlook.com'] }
  ];

  const hostLower = hostname.toLowerCase();
  // BUG FIX #3a: `rootDomain` was re-declared with `const` inside the for-loop
  // body on the next block, causing the inner declaration to shadow the outer one
  // and making the outer variable effectively unused / misleading. Kept here as
  // the single source-of-truth; the inner duplicate has been removed.
  const rootDomain = hostLower.split('.')[0];

  // Normalise leetspeak substitutions so that g00gle → google, paypa1 → paypal, etc.
  const normalized = hostLower
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/!/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/@/g, 'a')
    .replace(/5/g, 's')
    .replace(/8/g, 'b')
    .replace(/vv/g, 'w')
    .replace(/rn/g, 'm')
    .replace(/q/g, 'g');

  // Debug: log the values that each comparison will use
  console.log(`[SentinelX] detectBrandImpersonation() called`);
  console.log(`  hostname   : ${hostname}`);
  console.log(`  hostLower  : ${hostLower}`);
  console.log(`  rootDomain : ${rootDomain}`);
  console.log(`  normalized : ${normalized}`);

  for (const brand of brands) {
    // Direct match: brand name appears literally anywhere in the hostname
    const isDirectMatch =
      hostLower.includes(brand.name) ||
      rootDomain.includes(brand.name);

    // Fuzzy match: brand name appears after leetspeak normalisation
    const isFuzzyMatch = normalized.includes(brand.name);

    // Typosquat match: edit distance of 1 on any hostname segment
    const hostParts = hostLower.split(/[.-]/);
    let isTyposquat = false;
    let typosquatPart = null;
    let typosquatDist = null;
    for (const part of hostParts) {
      if (part.length > 4) {
        const dist = levenshtein(part, brand.name);
        if (dist === 1) {
          isTyposquat = true;
          typosquatPart = part;
          typosquatDist = dist;
          break;
        }
      }
    }

    // Verbose detector logs — one entry per brand iteration
    console.log('[Brand Detector] Host:', hostname);
    console.log('[Brand Detector] Normalized:', normalized);
    console.log('[Brand Detector] Root Domain:', rootDomain);
    console.log('[Brand Detector] Brand:', brand.name);
    console.log('[Brand Detector] Direct:', isDirectMatch);
    console.log('[Brand Detector] Fuzzy:', isFuzzyMatch);
    console.log('[Brand Detector] Typosquat:', isTyposquat);
    if (typosquatPart !== null) {
      console.log(`[Brand Detector] Levenshtein: "${typosquatPart}" vs "${brand.name}" = ${typosquatDist}`);
    }

    if (isDirectMatch || isFuzzyMatch || isTyposquat) {
      const isOfficial = brand.official.some(officialDomain =>
        hostLower === officialDomain || hostLower.endsWith('.' + officialDomain)
      );

      // Log official-domain check for every brand that produced any match
      console.log(`[Brand Detector] MATCH — brand: ${brand.name} | isOfficial: ${isOfficial} | checked against:`, brand.official);

      if (!isOfficial) {
        const confidence = (isFuzzyMatch && !isDirectMatch) || isTyposquat ? 'high' : 'medium';
        console.log(`[SentinelX] Brand impersonation detected: ${hostLower} → ${brand.name} (Confidence: ${confidence})`);
        return { impersonated: true, brand: brand.name, confidence };
      }
    }
  }

  // BUG FIX #3c: the three console.log lines that appeared AFTER this return
  // statement were unreachable dead code and have been moved to BEFORE it so
  // that they actually execute when no brand is matched.
  console.log(`[SentinelX] detectBrandImpersonation: no match for ${hostLower} (normalized: ${normalized})`);
  return { impersonated: false };
}

/**
 * safeDecodeURIComponent(str)
 * Safely decodes a percent-encoded string. If str contains malformed
 * encoding sequences that would cause decodeURIComponent to throw a URIError,
 * it catches the error and returns the original string intact.
 */
function safeDecodeURIComponent(str) {
  if (typeof str !== 'string') return str;
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
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
  console.log('[SentinelX] Executing Check 1: Protocol');
  const isHttps = protocol === 'https:';
  if (!isHttps) {
    score += 35;
    checks.push({ label: 'Protocol: HTTP (unencrypted connection)', passed: false });
  } else {
    checks.push({ label: 'Protocol: HTTPS (encrypted)', passed: true });
  }

  // ── 2. IP-based URL Check ──
  console.log('[SentinelX] Executing Check 2: IP-based URL');
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipRegex.test(hostname)) {
    score += 30;
    checks.push({ label: 'IP-based host (no domain name)', passed: false });
  } else {
    checks.push({ label: 'Domain-based host', passed: true });
  }

  // ── 3. Suspicious Keywords Check ──
  console.log('[SentinelX] Executing Check 3: Suspicious Keywords');
  const suspiciousKeywords = [
    'login', 'signin', 'verify', 'secure', 'account',
    'update', 'confirm', 'banking', 'paypal', 'ebay',
    'password', 'credential', 'free-gift', 'prize',
    'admin', 'hack'
  ];
  const lowerHref = href.toLowerCase();
  const decodedHref = safeDecodeURIComponent(href).toLowerCase();
  const matchedKeywords = suspiciousKeywords.filter(
    kw => lowerHref.includes(kw) || decodedHref.includes(kw)
  );

  if (matchedKeywords.length > 0) {
    score += 20;
    checks.push({
      label: `Suspicious security/login keywords detected: ${matchedKeywords.slice(0, 3).join(', ')}`,
      passed: false
    });
  } else {
    checks.push({ label: 'No suspicious URL keywords', passed: true });
  }

  // ── 4. Domain Length Check ──
  console.log('[SentinelX] Executing Check 4: Domain Length');
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
  console.log('[SentinelX] Executing Check 5: Subdomain Depth');
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
  console.log('[SentinelX] Executing Check 6: Suspicious TLD');
  const suspiciousTLDs = ['.tk', '.ml', '.ga', '.cf', '.gq', '.xyz', '.top', '.click', '.loan', '.link', '.zip', '.mov'];
  const hasSuspiciousTLD = suspiciousTLDs.some(tld => hostname.endsWith(tld));
  if (hasSuspiciousTLD) {
    score += 25;
    checks.push({ label: 'High-risk TLD detected', passed: false });
  } else {
    checks.push({ label: 'Standard TLD', passed: true });
  }

  // ── 7. URL Shorteners Check ──
  console.log('[SentinelX] Executing Check 7: URL Shorteners');
  const shorteners = [
    'bit.ly', 'tinyurl.com', 't.co', 'cutt.ly', 'is.gd',
    'buff.ly', 'ow.ly', 'bl.ink', 'v.gd', 'shorturl.at', 'tiny.cc'
  ];
  const isShortener = shorteners.some(s => {
    const exactMatch   = hostname === s;
    const subdomMatch  = hostname.endsWith('.' + s);
    if (exactMatch || subdomMatch) {
      console.log(`[SentinelX] Shortener match: "${hostname}" matched "${s}" (exact=${exactMatch}, subdomain=${subdomMatch})`);
    }
    return exactMatch || subdomMatch;
  });
  // Verbose detector logs
  console.log('[Detector] Host:', hostname);
  console.log('[Detector] isShortener:', isShortener);
  if (isShortener) {
    score += 25;
    checks.push({ label: 'URL shortener domain detected', passed: false, warn: true });
  } else {
    checks.push({ label: 'Not a known URL shortener', passed: true });
  }

  // ── 8. Excessive Hyphens Check ──
  console.log('[SentinelX] Executing Check 8: Excessive Hyphens');
  const hyphenCount = (hostname.match(/-/g) || []).length;
  if (hyphenCount > 2) {
    score += 15;
    checks.push({ label: `Excessive domain hyphens (${hyphenCount})`, passed: false });
  }

  // ── 9. Suspicious Brand Impersonation Check ──
  console.log('[SentinelX] Executing Check 9: Brand Impersonation');
  const brandImpersonation = detectBrandImpersonation(hostname);
  const hasBrandImpersonation = brandImpersonation.impersonated;
  if (hasBrandImpersonation) {
    score += 40;
    const confidenceMarker = brandImpersonation.confidence === 'high' ? ' (High Confidence)' : '';
    checks.push({ label: `Brand impersonation${confidenceMarker}: domain mimics ${brandImpersonation.brand}`, passed: false });
  } else {
    checks.push({ label: 'No brand impersonation detected', passed: true });
  }

  // ── 9b. Context-Aware Threat Escalation ──
  console.log('[SentinelX] Executing Check 9b: Context-Aware Threat Escalation');
  // If multiple strong signals combine, dramatically increase the score.
  if (hasBrandImpersonation && matchedKeywords.length > 0) {
    console.log(`[SentinelX] Phishing escalation triggered: brand + keyword`);
    score += 30;
    checks.push({ label: 'Critical Escalation: Brand spoofing combined with security keywords', passed: false });
  }
  
  if (hasBrandImpersonation && hasSuspiciousTLD) {
    console.log(`[SentinelX] Phishing escalation triggered: brand + risky TLD`);
    score += 25;
    checks.push({ label: 'Critical Escalation: Brand spoofing hosted on high-risk TLD', passed: false });
  }
  // ── 10. Suspicious Characters/Encoding Check ──
  console.log('[SentinelX] Executing Check 10: Suspicious Characters/Encoding');
  // Match genuine percent-encoded byte sequences (%XX where XX = two hex digits).
  // Excludes standard space encodings (%20) from the suspicious byte count to prevent
  // false positives on legitimate search queries or multi-word parameters.
  const encodedMatches         = url.match(/(%[0-9A-Fa-f]{2})/g) || [];
  const suspiciousByteMatches  = encodedMatches.filter(m => m.toUpperCase() !== '%20');
  const encodedSymbols         = suspiciousByteMatches.length;

  // Specific high-risk encoded characters — checked independently of the
  // total count so a URL with only one %40 still surfaces the right label.
  const encodedAt          = /(%40)/i.test(url);           // encoded @
  const encodedSlash       = /(%2F)/i.test(url);           // encoded /
  const encodedBackslash   = /(%5C)/i.test(url);           // encoded \
  const encodedDot         = /(%2E)/i.test(url);           // encoded .
  // Also keep detecting literal special characters already in the parsed URL
  const containsAtSymbol   = hostname.includes('@');
  const containsBackslash  = pathname.includes('\\') || encodedBackslash;

  // Verbose detector logs
  console.log('[Detector] URL:', href);
  console.log('[Detector] Encoded count (suspicious bytes):', encodedSymbols);
  console.log('[Detector] Encoded matches:', encodedMatches);
  console.log('[Detector] Encoded slash (%2F):', encodedSlash);
  console.log('[Detector] Encoded @ (%40):', encodedAt);
  console.log('[Detector] Encoded dot (%2E):', encodedDot);
  console.log('[Detector] Encoded backslash (%5C):', encodedBackslash);
  console.log('[Detector] Contains @:', containsAtSymbol);
  console.log('[Detector] Contains backslash:', containsBackslash);

  // Trigger when: 3+ suspicious encoded bytes (excluding benign %20), or any specifically dangerous encoded char,
  // or literal @ / backslash already in hostname / path.
  const hasSuspiciousEncoding =
    encodedSymbols >= 3 ||
    encodedAt || encodedSlash || encodedBackslash || encodedDot ||
    containsAtSymbol || containsBackslash;

  if (hasSuspiciousEncoding) {
    score += 15;
    let reason = 'Suspicious URL encoding / symbols';
    if (encodedSymbols >= 1) {
      const sample = suspiciousByteMatches.slice(0, 5).join(' ');
      reason += ` (${encodedSymbols} percent-encoded bytes: ${sample})`;
    }
    if (encodedAt)           reason += ' [%40 encoded @]';
    if (encodedSlash)        reason += ' [%2F encoded /]';
    if (encodedBackslash)    reason += ' [%5C encoded \\]';
    if (encodedDot)          reason += ' [%2E encoded .]';
    if (containsAtSymbol)    reason += ' (@ credentials)';
    if (containsBackslash && !encodedBackslash) reason += ' (backslash obfuscation)';
    checks.push({ label: reason, passed: false });
  } else {
    checks.push({ label: 'No suspicious URL encoding or symbols', passed: true });
  }

  // ── 9c. Context-Aware Escalation: Encoded URL + Suspicious Keyword ──
  console.log('[SentinelX] Executing Check 9c: Escalation — Encoded URL + Keyword');
  if (hasSuspiciousEncoding && matchedKeywords.length > 0) {
    console.log(`[SentinelX] Phishing escalation triggered: encoded URL + keyword (${matchedKeywords[0]})`);
    score += 20;
    checks.push({ label: `Critical Escalation: Encoded URL combined with suspicious keyword (${matchedKeywords.slice(0, 2).join(', ')})`, passed: false });
  }

  console.log('[SentinelX] Hostname:', hostname);
  console.log('[SentinelX] Matched keywords:', matchedKeywords);
  console.log('[SentinelX] Encoded chars:', encodedSymbols);
  console.log('[SentinelX] Brand result:', brandImpersonation);
  console.log('[SentinelX] Is shortener:', isShortener);

  // Cap score at 100
  score = Math.min(score, 100);

  return buildResult(url, score, checks, isHttps);
}

/**
 * buildResult(url, score, checks, isHttps)
 * Assembles the final result object with a human-readable label.
 */
function buildResult(url, score, checks, isHttps = true) {
  // Unified risk thresholds: 0-5 Safe | 6-20 Low Risk | 21-45 Moderate Risk | 46-100 Dangerous
  let label;
  if (score <= 5)       label = 'Safe';
  else if (score <= 20) label = 'Low Risk';
  else if (score <= 45) label = 'Moderate Risk';
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
async function storeResult(url, result, { recordDashboardEvent = true } = {}) {
  const key = `sentinelx_scan:${encodeURIComponent(url).slice(0, 100)}`;
  await chrome.storage.local.set({ [key]: result });

  if (result && !result.url) {
    result.url = url;
  }

  if (recordDashboardEvent) {
    // Update Phase 3A history/statistics only for URL scans, not DOM enrichment.
    await addToHistory(result, url);
    await createSecurityReport(result);
  }

  const { sentinelx_scan_count = 0 } = await chrome.storage.local.get('sentinelx_scan_count');
  await chrome.storage.local.set({
    sentinelx_scan_count: sentinelx_scan_count + 1,
    sentinelx_last_scan: Date.now(),
  });

  console.log('[SentinelX BG] Result stored. Total scans:', sentinelx_scan_count + 1);
}

function extractHostnameFromUrl(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matchesTargetHost(itemUrl, targetHost) {
  if (!itemUrl || !targetHost) return false;
  const host = extractHostnameFromUrl(itemUrl);
  return host === targetHost || host.endsWith('.' + targetHost);
}

/** Returns the current site's monitoring data and local analytics for the popup dashboard. */
async function getDashboardData(url) {
  try {
    const dashboard = await getDashboard();
    const data = dashboard || { ...DEFAULT_DASHBOARD };
    const targetHost = extractHostnameFromUrl(url);

    const siteDownloads = targetHost
      ? (data.downloads || []).filter(item => matchesTargetHost(item?.url, targetHost) || matchesTargetHost(item?.referrer, targetHost))
      : (data.downloads || []);

    const siteRedirects = targetHost
      ? (data.redirects || []).filter(item => matchesTargetHost(item?.original, targetHost) || matchesTargetHost(item?.final, targetHost))
      : (data.redirects || []);

    const sitePermissions = targetHost
      ? (data.permissions || []).filter(item => matchesTargetHost(item?.url, targetHost))
      : (data.permissions || []);

    const siteSummary = {
      host: targetHost,
      downloadCount: siteDownloads.length,
      redirectCount: siteRedirects.length,
      permissionCount: sitePermissions.length,
      downloads: siteDownloads,
      redirects: siteRedirects,
      permissions: sitePermissions
    };

    return {
      ...data,
      statistics: {
        ...DEFAULT_DASHBOARD.statistics,
        ...(data?.statistics || {})
      },
      siteSummary
    };
  } catch (err) {
    console.error('[SentinelX BG] getDashboardData error:', err);
    return {
      ...DEFAULT_DASHBOARD,
      siteSummary: {
        host: '',
        downloadCount: 0,
        redirectCount: 0,
        permissionCount: 0,
        downloads: [],
        redirects: [],
        permissions: []
      }
    };
  }
}

/**
 * addToHistory(result)
 * Updates the rolling log history of up to 10 unique scans.
 */
async function addToHistory(result, scanUrl) {
  try {
    const finalUrl = result?.url || scanUrl;
    await updateDashboard(dashboard => {
      if (!dashboard.statistics) {
        dashboard.statistics = { totalScans: 0, dangerousSites: 0, downloads: 0, redirects: 0 };
      }
      dashboard.statistics.totalScans = (dashboard.statistics.totalScans || 0) + 1;
      if (result?.label === 'Dangerous') {
        dashboard.statistics.dangerousSites = (dashboard.statistics.dangerousSites || 0) + 1;
      }
      appendDashboardHistory(dashboard, {
        timestamp: Date.now(),
        eventType: 'scan',
        url: finalUrl,
        score: result?.score ?? 0,
        label: result?.label || 'Safe'
      });
    });
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
 * Resolves the score threshold for active warning banners
 * based on user's warningSensitivity setting.
 */
function getWarningThreshold(sensitivity = 'balanced') {
  switch (sensitivity) {
    case 'low':
      return 70;
    case 'high':
      return 21;
    case 'balanced':
    default:
      return 46;
  }
}

/**
 * syncTabWarning(result, tabId)
 * Dispatches SHOW_WARNING if score meets the active warningSensitivity threshold,
 * or HIDE_WARNING if score falls below it.
 */
async function syncTabWarning(result, tabId = null) {
  try {
    let targetTabId = tabId;
    if (!targetTabId) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTabId = activeTab?.id;
    }
    if (!targetTabId) return;

    const hostname = extractHostnameFromUrl(result?.url);
    const isWhitelisted = hostname ? await isDomainWhitelisted(hostname) : false;
    const settings = await getSettings();
    const threshold = getWarningThreshold(settings.warningSensitivity);
    const shouldWarn = !isWhitelisted && result.score >= threshold;

    if (shouldWarn) {
      await chrome.tabs.sendMessage(targetTabId, {
        type: 'SHOW_WARNING',
        data: result,
      }).catch(() => {
        console.log('[SentinelX BG] Content script not yet ready for SHOW_WARNING.');
      });
    } else {
      await chrome.tabs.sendMessage(targetTabId, {
        type: 'HIDE_WARNING',
      }).catch(() => {
        // Safe to ignore if banner not present
      });
    }
  } catch (err) {
    console.error('[SentinelX BG] syncTabWarning error:', err);
  }
}

/**
 * notifyContentScript(result)
 * Backward-compatible alias for syncTabWarning.
 */
async function notifyContentScript(result) {
  return syncTabWarning(result);
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

console.log('[SentinelX BG] Service worker initialised ✓')
