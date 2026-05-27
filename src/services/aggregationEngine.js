// src/services/aggregationEngine.js
// -------------------------------------------------------------------
// Combines local heuristic analysis with Google Safe Browsing results.
// -------------------------------------------------------------------
import { RISK_THRESHOLDS, AGGREGATION_WEIGHT } from '../constants.js';
import { LOG } from '../utils/logger.js';

/**
 * Convert Safe Browsing threat types to a numeric cloud score.
 * The mapping is deliberately aggressive – any threat type pushes the
 * cloud score high enough to dominate the final verdict.
 */
function cloudThreatScore(threatTypes) {
  if (!threatTypes || threatTypes.length === 0) return 0; // no threat
  // Assign a base of 80 for any detection; add 10 per distinct type.
  return Math.min(100, 80 + threatTypes.length * 10);
}

/**
 * Merge localResult (from analyseUrl) with cloudResult (Safe Browsing).
 * Returns a new result object with updated `score`, `label`, and an
 * extended `checks` array that contains a synthetic "Safe Browsing"
 * entry.
 *
 * @param {Object} localResult – output of analyseUrl()
 * @param {Object} cloudResult – { url, threatTypes, cacheDurationMs }
 * @returns {Object} merged result ready for storage/UI.
 */
export function aggregate(localResult, cloudResult) {
  const cloudScore = cloudThreatScore(cloudResult.threatTypes);
  const weightedScore = Math.round(
    localResult.score * AGGREGATION_WEIGHT.LOCAL +
    cloudScore * AGGREGATION_WEIGHT.CLOUD,
  );

  // If any cloud threat is present, we force Dangerous regardless of numeric score.
  const finalScore = cloudResult.threatTypes.length > 0 ? Math.max(weightedScore, 70) : weightedScore;

  // Determine label using unified thresholds.
  let finalLabel;
  if (finalScore <= RISK_THRESHOLDS.SAFE) finalLabel = 'Safe';
  else if (finalScore <= RISK_THRESHOLDS.LOW) finalLabel = 'Low Risk';
  else if (finalScore <= RISK_THRESHOLDS.MODERATE) finalLabel = 'Moderate Risk';
  else finalLabel = 'Dangerous';

  // Clone checks and add cloud entry.
  const mergedChecks = [...localResult.checks];
  if (cloudResult.threatTypes.length > 0) {
    mergedChecks.push({
      label: `Safe Browsing: ${cloudResult.threatTypes.join(', ')}`,
      passed: false,
      isCloud: true,
    });
  } else {
    mergedChecks.push({
      label: 'Safe Browsing: no threats detected',
      passed: true,
      isCloud: true,
    });
  }

  LOG.info('Aggregation completed – finalScore', finalScore, 'label', finalLabel);

  return {
    ...localResult,
    score: finalScore,
    label: finalLabel,
    checks: mergedChecks,
    cloud: {
      threatTypes: cloudResult.threatTypes,
      cacheExpires: cloudResult.cacheDurationMs,
    },
  };
}
