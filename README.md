# 🛡️ SentinelX — Phase 1: Extension Foundation

> AI-powered browser security extension · Chrome · Manifest V3

---

## 📁 Project Structure

```
sentinelx/
├── manifest.json          ← Extension config (MV3)
├── popup/
│   ├── popup.html         ← Extension popup UI
│   ├── popup.css          ← Dark cybersecurity theme
│   └── popup.js           ← Popup logic + messaging
├── background/
│   └── background.js      ← Service worker (URL analysis, storage)
├── content/
│   └── content.js         ← DOM injection (warning banners)
└── assets/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## 🚀 How to Load in Chrome

1. Open Chrome and go to: `chrome://extensions`
2. Toggle **Developer mode** ON (top-right switch)
3. Click **"Load unpacked"**
4. Select the **`sentinelx/`** folder (the one containing `manifest.json`)
5. The SentinelX icon appears in your extensions bar

> **To reload after code changes:** Click the ↺ refresh icon on the extension card at `chrome://extensions`

---

## 🐛 How to Debug Each Part

### Popup (popup.js / popup.html / popup.css)
1. Click the SentinelX icon to open the popup
2. **Right-click inside the popup → "Inspect"**
3. A DevTools window opens scoped to the popup page
4. You can view Console, Elements, Network, etc.

### Background Service Worker (background.js)
1. Go to `chrome://extensions`
2. Find SentinelX → click **"service worker"** (blue link)
3. A DevTools window opens for the background script
4. All `console.log('[SentinelX BG] ...')` messages appear here

### Content Script (content.js)
1. Open any webpage where the extension injects
2. Open the page's normal DevTools (F12)
3. Go to the **Console** tab
4. Look for `[SentinelX Content]` log messages
5. The injected warning banner appears in the **Elements** tab as `#sentinelx-warning-banner`

---

## 🔄 Extension Lifecycle & Communication

```
Chrome starts
     │
     ▼
background.js (service worker) initialises
     │
     ├── onInstalled → sets default chrome.storage values
     ├── onStartup   → logs browser start
     ├── tabs.onActivated  → pre-analyses active tab URL
     └── tabs.onUpdated    → analyses on navigation complete
          │
          ▼ (if risk score ≥ 60)
     tabs.sendMessage(tabId, { type: 'SHOW_WARNING', data })
          │
          ▼
     content.js receives message → injects warning banner into DOM

User clicks extension icon
     │
     ▼
popup.html loads → popup.js runs
     │
     ├── chrome.tabs.query → gets active tab URL
     ├── chrome.runtime.sendMessage({ type: 'ANALYSE_URL', url })
     │        │
     │        ▼
     │   background.js receives → runs analyseUrl() → returns result
     │        │
     │        ▼
     └── popup.js receives result → renders UI (score ring, badges, checks)
```

---

## 🔍 URL Risk Analysis: How Scores Work

Each check adds a **penalty** to the risk score (0–100):

| Check | Penalty |
|---|---|
| HTTP (not HTTPS) | +35 |
| IP-based URL (e.g. `http://192.168.1.1`) | +30 |
| Suspicious keywords (login, verify, paypal…) | +10 per keyword, max +25 |
| Domain name > 40 characters | +15 |
| Domain name > 25 characters | +5 |
| Subdomain depth > 4 levels | +15 |
| High-risk TLD (.tk, .ml, .xyz, .click…) | +15 |
| Non-HTTP/S protocol | +10 |

**Labels:**
- Score 0–39 → ✅ **Safe**
- Score 40–69 → ⚠️ **Moderate Risk**
- Score 70–100 → 🛑 **Dangerous**

---

## 💾 Storage Schema

Data is stored in `chrome.storage.local` with these keys:

```js
{
  "sentinelx_version": "1.0.0",
  "sentinelx_scan_count": 42,
  "sentinelx_last_scan": 1714000000000,   // Unix timestamp

  // Per-URL scan results (keyed by encoded URL):
  "sentinelx_scan:https%3A%2F%2Fexample.com": {
    url: "https://example.com",
    score: 0,
    label: "Safe",
    isHttps: true,
    checks: [ { label: "Protocol: HTTPS", passed: true }, ... ],
    timestamp: 1714000000000
  }
}
```

To inspect storage in DevTools:
- Open background service worker DevTools
- Go to **Application → Storage → Extension Storage → Local**

---

## 📜 Key Chrome APIs Used

| API | Why |
|---|---|
| `chrome.tabs.query` | Get the active tab and its URL |
| `chrome.tabs.onActivated` | Detect when user switches tabs |
| `chrome.tabs.onUpdated` | Detect page navigations |
| `chrome.tabs.sendMessage` | Background → content script |
| `chrome.runtime.sendMessage` | Popup/content → background |
| `chrome.runtime.onMessage` | Receive messages |
| `chrome.storage.local` | Persist scan results |
| `chrome.runtime.onInstalled` | Extension install/update hook |

---

## 🔮 What's Coming in Phase 2

- AI-powered risk analysis (Gemini/GPT API integration)
- Real-time phishing database lookup
- Threat intelligence feeds
- User dashboard with scan history
- Domain reputation scoring

---

*SentinelX Phase 1 — Built with Chrome Extension Manifest V3*
