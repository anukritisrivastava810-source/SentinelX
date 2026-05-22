/**
 * ═══════════════════════════════════════════════════════
 * SentinelX — content.js  (Content Script)
 *
 * PURPOSE:
 *   Runs in the context of the page DOM.
 *     1. Performs modular DOM scanning (forms, buttons, inputs).
 *     2. Reports DOM security markers back to background.js.
 *     3. Receives warning messages and renders an expandable warning banner.
 * ═══════════════════════════════════════════════════════
 */

'use strict';

// ── Guard: prevent double-injection ──
if (window.__sentinelx_loaded) {
  // Already loaded
} else {
  window.__sentinelx_loaded = true;
  initContentScript();
}

/**
 * initContentScript()
 * Entry point. Sets up message listener and triggers initial DOM scan.
 */
function initContentScript() {
  console.log('[SentinelX Content] Loaded on:', window.location.href);

  // 1. Scan page DOM and report findings to background.js
  reportPageInfo();

  // 2. Listen for security notifications from background.js
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[SentinelX Content] Message received:', message.type);

    switch (message.type) {
      case 'SHOW_WARNING': {
        showWarningBanner(message.data);
        sendResponse({ shown: true });
        break;
      }
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
// MODULAR DOM THREAT SCANNERS
// ───────────────────────────────────────────────────────

/**
 * scanForms()
 * Scans forms to detect password/credential transmission risks.
 */
function scanForms() {
  const forms = document.querySelectorAll('form');
  let insecureAction = false;
  let actionDomainMismatch = false;

  const currentDomain = window.location.hostname;

  forms.forEach(form => {
    const action = form.getAttribute('action');
    if (action) {
      try {
        const actionUrl = new URL(action, window.location.href);
        if (window.location.protocol === 'https:' && actionUrl.protocol === 'http:') {
          insecureAction = true;
        }
        const actionHost = actionUrl.hostname;
        if (actionHost && actionHost !== currentDomain && !actionHost.endsWith('.' + currentDomain)) {
          actionDomainMismatch = true;
        }
      } catch (e) {
        // relative or invalid paths resolve locally on the safe domain
      }
    }
  });
  return { insecureAction, actionDomainMismatch };
}

/**
 * scanSuspiciousButtons()
 * Flags suspicious keywords on buttons or anchor links.
 */
function scanSuspiciousButtons() {
  const buttons = document.querySelectorAll('button, input[type="submit"], input[type="button"], a');
  const suspiciousTexts = ['login', 'sign in', 'verify', 'update account', 'claim', 'unlock', 'access'];
  let foundSuspiciousButton = false;
  
  for (const btn of buttons) {
    const text = (btn.textContent || btn.value || '').toLowerCase().trim();
    if (suspiciousTexts.some(st => text.includes(st))) {
      foundSuspiciousButton = true;
      break;
    }
  }
  return foundSuspiciousButton;
}

/**
 * reportPageInfo()
 * Gathers DOM analysis metrics and sends them to background.js.
 */
function reportPageInfo() {
  const formScan = scanForms();
  const info = {
    url:       window.location.href,
    title:     document.title,
    isHttps:   window.location.protocol === 'https:',
    hasPasswordInput: document.querySelector('input[type="password"]') !== null,
    formCount: document.querySelectorAll('form').length,
    linkCount:  document.querySelectorAll('a[href]').length,
    loadTime:   performance.now().toFixed(0) + 'ms',
    
    // Content-based threat features
    insecureAction: formScan.insecureAction,
    actionDomainMismatch: formScan.actionDomainMismatch,
    hasExcessiveHiddenInputs: document.querySelectorAll('input[type="hidden"]').length > 15,
    hasSuspiciousButtons: scanSuspiciousButtons()
  };

  chrome.runtime.sendMessage({ type: 'PAGE_INFO', data: info }, (response) => {
    if (chrome.runtime.lastError) {
      console.log('[SentinelX Content] Background not ready:', chrome.runtime.lastError.message);
    }
  });
}

// ───────────────────────────────────────────────────────
// WARNING BANNER — DOM INJECTION (Redesigned)
// ───────────────────────────────────────────────────────

const BANNER_ID = 'sentinelx-warning-banner';

/**
 * showWarningBanner(result)
 * Creates and injects a modern, expandable warning bar at the top of the viewport.
 *
 * @param {Object} result - { score, label, checks, url }
 */
function showWarningBanner(result) {
  if (document.getElementById(BANNER_ID)) return; // prevent duplicate banners

  const { score, label, checks = [] } = result;
  const style = getBannerStyle(label);

  // ── 1. Create Main Container ──
  const banner = document.createElement('div');
  banner.id = BANNER_ID;

  // Apply clean, native-feeling inline styles to prevent page stylesheet overrides
  Object.assign(banner.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    zIndex: '2147483647',
    background: style.background,
    borderBottom: `3px solid ${style.borderColor}`,
    color: style.textColor,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontSize: '13px',
    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.02)',
    transition: 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
    transform: 'translateY(-100%)', // start hidden
    boxSizing: 'border-box'
  });

  // ── 2. Create Header Row (Visually Compact) ──
  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 16px',
    boxSizing: 'border-box',
    width: '100%'
  });

  // Left Section (Branding + Message)
  const left = document.createElement('div');
  Object.assign(left.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '8px'
  });

  const icon = document.createElement('span');
  icon.textContent = style.icon;
  icon.style.fontSize = '16px';
  icon.style.lineHeight = '1';

  const textNode = document.createElement('span');
  textNode.innerHTML = `<strong>SentinelX:</strong> ${style.message} &nbsp;<span style="font-size: 11px; font-weight: 500; opacity: 0.85;">(Risk: ${score}/100)</span>`;

  left.appendChild(icon);
  left.appendChild(textNode);

  // Right Section (Actions)
  const right = document.createElement('div');
  Object.assign(right.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '10px'
  });

  // Toggle Details Button
  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = 'Show Details ▾';
  Object.assign(toggleBtn.style, {
    background: 'none',
    border: 'none',
    color: style.textColor,
    fontFamily: 'inherit',
    fontSize: '11px',
    fontWeight: '600',
    cursor: 'pointer',
    padding: '4px 6px',
    textDecoration: 'underline',
    outline: 'none'
  });

  // Dismiss Button
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Dismiss';
  Object.assign(closeBtn.style, {
    background: 'rgba(0, 0, 0, 0.05)',
    border: '1px solid rgba(0, 0, 0, 0.1)',
    borderRadius: '4px',
    color: style.textColor,
    fontFamily: 'inherit',
    fontSize: '11px',
    fontWeight: '500',
    cursor: 'pointer',
    padding: '4px 10px',
    transition: 'background 0.2s',
    outline: 'none'
  });

  closeBtn.addEventListener('mouseenter', () => {
    closeBtn.style.background = 'rgba(0, 0, 0, 0.08)';
  });
  closeBtn.addEventListener('mouseleave', () => {
    closeBtn.style.background = 'rgba(0, 0, 0, 0.05)';
  });

  right.appendChild(toggleBtn);
  right.appendChild(closeBtn);
  header.appendChild(left);
  header.appendChild(right);

  // ── 3. Create Expandable Details Drawer ──
  const detailsDrawer = document.createElement('div');
  Object.assign(detailsDrawer.style, {
    display: 'none',
    padding: '0 16px 14px 40px',
    borderTop: '1px solid rgba(0, 0, 0, 0.05)',
    boxSizing: 'border-box'
  });

  const detailsTitle = document.createElement('div');
  detailsTitle.textContent = 'Flagged Threat Indicators:';
  Object.assign(detailsTitle.style, {
    fontSize: '11px',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    color: style.detailColor,
    margin: '10px 0 6px'
  });

  const list = document.createElement('ul');
  Object.assign(list.style, {
    listStyleType: 'disc',
    margin: '0',
    paddingLeft: '16px',
    fontSize: '12px',
    lineHeight: '1.6',
    color: style.detailColor
  });

  // Extract failed checks to display
  const failedChecks = checks.filter(c => !c.passed);
  if (failedChecks.length > 0) {
    failedChecks.forEach(c => {
      const item = document.createElement('li');
      item.textContent = c.label;
      list.appendChild(item);
    });
  } else {
    const item = document.createElement('li');
    item.textContent = 'No rule-based heuristics flagged. Content-based scan pending.';
    list.appendChild(item);
  }

  detailsDrawer.appendChild(detailsTitle);
  detailsDrawer.appendChild(list);

  // Assemble Main Banner
  banner.appendChild(header);
  banner.appendChild(detailsDrawer);

  // ── 4. Toggle Interaction ──
  let isExpanded = false;
  toggleBtn.addEventListener('click', () => {
    isExpanded = !isExpanded;
    if (isExpanded) {
      detailsDrawer.style.display = 'block';
      toggleBtn.textContent = 'Hide Details ▴';
    } else {
      detailsDrawer.style.display = 'none';
      toggleBtn.textContent = 'Show Details ▾';
    }
    // Recalculate layout spacer height to match new size
    updateBodyPadding(banner);
  });

  // Dismiss Action
  closeBtn.addEventListener('click', () => {
    banner.style.transform = 'translateY(-100%)';
    const shim = document.getElementById('sentinelx-body-shim');
    if (shim) {
      shim.style.transition = 'height 0.35s ease';
      shim.style.height = '0px';
      setTimeout(() => shim.remove(), 350);
    }
    setTimeout(() => banner.remove(), 400);
  });

  // ── 5. Inject & Animate ──
  document.body.prepend(banner);
  injectBodyPadding(banner);

  requestAnimationFrame(() => {
    banner.style.transform = 'translateY(0)';
  });
}

/**
 * injectBodyPadding(banner)
 * Inserts a top padding container so the floating banner doesn't cover page content.
 */
function injectBodyPadding(banner) {
  const shimId = 'sentinelx-body-shim';
  if (document.getElementById(shimId)) return;

  const shim = document.createElement('div');
  shim.id = shimId;
  shim.style.width = '100%';
  shim.style.transition = 'height 0.2s ease';
  
  document.body.prepend(shim);
  updateBodyPadding(banner);
}

/**
 * updateBodyPadding(banner)
 * Recalculates and updates the spacer shim height based on current banner state.
 */
function updateBodyPadding(banner) {
  requestAnimationFrame(() => {
    const shim = document.getElementById('sentinelx-body-shim');
    if (shim && banner) {
      const height = banner.getBoundingClientRect().height;
      shim.style.height = height + 'px';
    }
  });
}

/**
 * removeWarningBanner()
 */
function removeWarningBanner() {
  const banner = document.getElementById(BANNER_ID);
  const shim = document.getElementById('sentinelx-body-shim');

  if (banner) {
    banner.style.transform = 'translateY(-100%)';
    setTimeout(() => banner.remove(), 400);
  }
  if (shim) {
    shim.style.height = '0px';
    setTimeout(() => shim.remove(), 400);
  }
}

/**
 * getBannerStyle(label)
 * Returns color tokens according to security state.
 */
function getBannerStyle(label) {
  const styles = {
    'Moderate Risk': {
      background: '#fffbeb', // amber-50
      borderColor: '#f59e0b', // amber-500
      textColor: '#78350f', // amber-900
      detailColor: '#92400e', // amber-800
      icon: '⚠️',
      message: 'Suspicious indicators detected on this domain.'
    },
    'Dangerous': {
      background: '#fef2f2', // red-50
      borderColor: '#ef4444', // red-500
      textColor: '#7f1d1d', // red-900
      detailColor: '#991b1b', // red-800
      icon: '🛑',
      message: 'Critical security threat flagged on this domain!'
    }
  };

  return styles[label] ?? {
    background: '#eff6ff',
    borderColor: '#3b82f6',
    textColor: '#1e3a8a',
    detailColor: '#1e40af',
    icon: 'ℹ️',
    message: 'Review flagged details on this domain.'
  };
}
