// src/constants.js
// -------------------------------------------------------------------
// Shared constants for SentinelX Phase 3.
// -------------------------------------------------------------------

export const RISK_THRESHOLDS = {
  SAFE: 5,
  LOW: 20,
  MODERATE: 45,
  DANGEROUS: 100,
};

// Cache TTL for Safe Browsing results (default 12 hours).
export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

// Aggregation weighting – how much the cloud result influences the final score.
export const AGGREGATION_WEIGHT = {
  LOCAL: 0.5,
  CLOUD: 0.5,
};

// Retry settings for API calls.
export const API_RETRY_COUNT = 2;
export const API_RETRY_DELAY_MS = 500; // simple back‑off
