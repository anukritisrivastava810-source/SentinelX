/**
 * ═══════════════════════════════════════════════════════
 * SentinelX — content.js  (Content Script)
 *
 * PURPOSE:
 *   Content scripts are JavaScript files that run in the context
 *   of a web page — they CAN access and modify the page's DOM,
 *   but they run in an isolated "sandbox" so they cannot directly
 *   access the page's JavaScript variables.
 *
 *   This script:
 *     1. Listens for SHOW_WARNING messages from background.js
 *     2. Injects a dismissable warning banner at the top of the page
 *     3. Removes the banner if the user dismisses it
 *     4. Reports basic page info back to background.js
 *
 * WHEN IT RUNS:
 *   Injected into every page matching <all_urls> in manifest.json,
 *   at "document_idle" (after the page's DOM has finished loading).
 *
 * ISOLATION:
 *   Content scripts share the DOM with the page, but live in a
 *   separate JS world. window.myVar set by the page is NOT visible
 *   here. This is a security feature.
 *
 * COMMUNICATION:
 *   [background.js] --sendMessage--> [content.js] via chrome.runtime.onMessage
 *   [content.js] --sendMessage--> [background.js] via chrome.runtime.sendMessage
 * ═══════════════════════════════════════════════════════
 */

'use strict';

// ── Guard: prevent double-injection if script runs twice ──
if (window.__sentinelx_loaded) {
  // Already loaded — do nothing
} else {
  window.__sentinelx_loaded = true;
  initContentScript();
}

/**
 * initContentScript()
 * Entry point. Sets up message listener and sends initial page info.
 */
function initContentScript() {
  console.log('[SentinelX Content] Loaded on:', window.location.href);

  // ── 1. Report page info to background.js ──────────────
  // Sends metadata about this page so background can use it.
  // This demonstrates content → background communication.
  reportPageInfo();

  // ── 2. Listen for messages from background.js ─────────
  // When background.js calls chrome.tabs.sendMessage(), this fires.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[SentinelX Content] Message received:', message.type);

    switch (message.type) {

      // Background.js sends this when a site has a high risk score
      case 'SHOW_WARNING': {
        showWarningBanner(message.data);
        sendResponse({ shown: true });
        break;
      }

      // Background could ask us to remove the banner (future use)
      case 'HIDE_WARNING': {
        removeWarningBanner();
        sendResponse({ hidden: true });
        break;
      }

      default:
        console.warn('[SentinelX Content] Unknown message type:', message.type);
    }
  });
}

// ───────────────────────────────────────────────────────
// PAGE INFO REPORTER
// ───────────────────────────────────────────────────────

/**
 * reportPageInfo()
 * Gathers basic metadata from the current page and sends it to
 * background.js. In Phase 2 this data will feed the AI analyser.
 */
function reportPageInfo() {
  const info = {
    url:       window.location.href,
    title:     document.title,
    isHttps:   window.location.protocol === 'https:',
    hasPasswordInput: document.querySelector('input[type="password"]') !== null,
    formCount: document.querySelectorAll('form').length,
    linkCount:  document.querySelectorAll('a[href]').length,
    loadTime:   performance.now().toFixed(0) + 'ms',
  };

  // Send to background service worker
  // Note: chrome.runtime.sendMessage from content scripts sends to background.js
  chrome.runtime.sendMessage({ type: 'PAGE_INFO', data: info }, (response) => {
    if (chrome.runtime.lastError) {
      // Background may not be listening yet — benign error
      console.log('[SentinelX Content] Background not ready:', chrome.runtime.lastError.message);
    }
  });
}

// ───────────────────────────────────────────────────────
// WARNING BANNER — DOM INJECTION
// ───────────────────────────────────────────────────────

const BANNER_ID = 'sentinelx-warning-banner';

/**
 * showWarningBanner(result)
 * Creates and injects a dismissable warning bar at the top of the page.
 * This is pure DOM manipulation — safe and contained.
 *
 * @param {Object} result - { score, label, url }
 */
function showWarningBanner(result) {
  // Don't show duplicate banners
  if (document.getElementById(BANNER_ID)) return;

  const { score, label } = result;

  // Choose visual style based on risk label
  const style = getBannerStyle(label);

  // ── Build the banner element ───────────────────────────
  const banner = document.createElement('div');
  banner.id = BANNER_ID;

  // All styles are inlined to avoid conflicts with the page's CSS
  Object.assign(banner.style, {
    position:         'fixed',
    top:              '0',
    left:             '0',
    right:            '0',
    zIndex:           '2147483647', // Highest possible z-index
    display:          'flex',
    alignItems:       'center',
    justifyContent:   'space-between',
    padding:          '10px 16px',
    background:       style.background,
    borderBottom:     `2px solid ${style.borderColor}`,
    fontFamily:       "'JetBrains Mono', 'Courier New', monospace",
    fontSize:         '13px',
    color:            style.textColor,
    boxShadow:        '0 2px 16px rgba(0,0,0,0.4)',
    backdropFilter:   'blur(8px)',
    transition:       'transform 0.3s ease',
    transform:        'translateY(-100%)', // Start hidden above viewport
  });

  // ── Left side: Icon + message ──────────────────────────
  const left = document.createElement('div');
  Object.assign(left.style, {
    display:    'flex',
    alignItems: 'center',
    gap:        '10px',
  });

  const icon = document.createElement('span');
  icon.textContent = style.icon;
  icon.style.fontSize = '18px';

  const msg = document.createElement('span');
  msg.innerHTML = `<strong>SentinelX:</strong> ${style.message} &nbsp;
    <span style="opacity:0.7;font-size:11px;">(Risk Score: ${score}/100)</span>`;

  left.appendChild(icon);
  left.appendChild(msg);

  // ── Right side: Dismiss button ─────────────────────────
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕ Dismiss';

  Object.assign(closeBtn.style, {
    background:   'rgba(255,255,255,0.12)',
    border:       '1px solid rgba(255,255,255,0.2)',
    borderRadius: '4px',
    color:        style.textColor,
    cursor:       'pointer',
    fontSize:     '11px',
    fontFamily:   'inherit',
    padding:      '4px 10px',
    flexShrink:   '0',
    transition:   'background 0.2s',
  });

  closeBtn.addEventListener('mouseenter', () => {
    closeBtn.style.background = 'rgba(255,255,255,0.22)';
  });
  closeBtn.addEventListener('mouseleave', () => {
    closeBtn.style.background = 'rgba(255,255,255,0.12)';
  });

  // Dismiss: slide banner back up, then remove from DOM
  closeBtn.addEventListener('click', () => {
    banner.style.transform = 'translateY(-100%)';
    setTimeout(() => banner.remove(), 350);
  });

  // ── Assemble and inject ───────────────────────────────
  banner.appendChild(left);
  banner.appendChild(closeBtn);

  // Prepend to body (before all other content)
  document.body.prepend(banner);

  // Push page content down so banner doesn't overlap it
  // We use a margin shim instead of modifying body.margin (safer)
  injectBodyPadding(banner);

  // Animate in: slide down from top
  requestAnimationFrame(() => {
    banner.style.transform = 'translateY(0)';
  });

  console.log('[SentinelX Content] Warning banner shown for label:', label);
}

/**
 * injectBodyPadding(banner)
 * Adds a top padding shim to the page body so the banner
 * doesn't overlap page content.
 */
function injectBodyPadding(banner) {
  const shimId = 'sentinelx-body-shim';
  if (document.getElementById(shimId)) return;

  const shim = document.createElement('div');
  shim.id = shimId;

  // Wait for the banner to render so we can measure its height
  requestAnimationFrame(() => {
    const height = banner.getBoundingClientRect().height;
    shim.style.height = height + 'px';
    shim.style.width  = '100%';
    document.body.prepend(shim);
  });
}

/**
 * removeWarningBanner()
 * Removes the warning banner and body shim from the page.
 */
function removeWarningBanner() {
  const banner = document.getElementById(BANNER_ID);
  const shim   = document.getElementById('sentinelx-body-shim');

  if (banner) {
    banner.style.transform = 'translateY(-100%)';
    setTimeout(() => banner.remove(), 350);
  }
  if (shim) shim.remove();
}

// ───────────────────────────────────────────────────────
// STYLE HELPER
// ───────────────────────────────────────────────────────

/**
 * getBannerStyle(label)
 * Returns colour + messaging config based on the safety label.
 */
function getBannerStyle(label) {
  const styles = {
    'Moderate Risk': {
      background:  'rgba(30, 20, 0, 0.92)',
      borderColor: '#ffb300',
      textColor:   '#ffe082',
      icon:        '⚠️',
      message:     'This site has <strong>moderate risk indicators</strong>. Proceed with caution.',
    },
    'Dangerous': {
      background:  'rgba(30, 0, 5, 0.95)',
      borderColor: '#ff3d5a',
      textColor:   '#ffcdd2',
      icon:        '🛑',
      message:     '<strong>WARNING:</strong> This site shows signs of a phishing or malicious page.',
    },
  };

  // Default (should not normally display for Safe, but just in case)
  return styles[label] ?? {
    background:  'rgba(0, 20, 30, 0.92)',
    borderColor: '#00d4ff',
    textColor:   '#e0f7ff',
    icon:        'ℹ️',
    message:     'SentinelX flagged this page for review.',
  };
}
