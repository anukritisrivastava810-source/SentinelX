// src/utils/logger.js
// -------------------------------------------------------------------
// Centralised logger for SentinelX.
// Provides colour‑coded console methods with a common tag.
// -------------------------------------------------------------------

const PREFIX = '%c[SentinelX]';
const STYLE = 'color:#6366f1;font-weight:bold';

export const LOG = {
  info: (...args) => console.log(PREFIX, STYLE, ...args),
  warn: (...args) => console.warn(PREFIX, STYLE, ...args),
  error: (...args) => console.error(PREFIX, STYLE, ...args),
};
