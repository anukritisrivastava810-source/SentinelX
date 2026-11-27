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
 * If the cloud lookup was skipped or unavailable (e.g. unconfigured API key or network failure),
 * localResult.score is used at 100% weight without dilution.
 *
 * @param {Object} localResult – output of analyseUrl()
 * @param {Object} cloudResult – { url, threatTypes, cacheDurationMs, skipped, cloudAvailable }
 * @returns {Object} merged result ready for storage/UI.
 */
export function aggregate(localResult, cloudResult) {
  const isCloudAvailable = Boolean(cloudResult && !cloudResult.skipped && cloudResult.cloudAvailable !== false);

  let finalScore;
  let finalLabel;
  const mergedChecks = [...localResult.checks];

  if (!isCloudAvailable) {
    // Cloud lookup was skipped/unavailable – use 100% local score directly without dilution
    finalScore = localResult.score;
    mergedChecks.push({
      label: 'Safe Browsing: skipped (API key not configured or service unavailable)',
      passed: true,
      isCloud: true,
      skipped: true,
    });
  } else {
    const cloudScore = cloudThreatScore(cloudResult.threatTypes);
    const weightedScore = Math.round(
      localResult.score * AGGREGATION_WEIGHT.LOCAL +
      cloudScore * AGGREGATION_WEIGHT.CLOUD,
    );

    // If any cloud threat is present, we force Dangerous regardless of numeric score.
    finalScore = cloudResult.threatTypes.length > 0 ? Math.max(weightedScore, 70) : weightedScore;

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
  }

  // Determine label using unified thresholds.
  if (finalScore <= RISK_THRESHOLDS.SAFE) finalLabel = 'Safe';
  else if (finalScore <= RISK_THRESHOLDS.LOW) finalLabel = 'Low Risk';
  else if (finalScore <= RISK_THRESHOLDS.MODERATE) finalLabel = 'Moderate Risk';
  else finalLabel = 'Dangerous';

  LOG.info('Aggregation completed – finalScore', finalScore, 'label', finalLabel);

  return {
    ...localResult,
    score: finalScore,
    label: finalLabel,
    checks: mergedChecks,
    cloud: {
      threatTypes: cloudResult?.threatTypes || [],
      cacheExpires: cloudResult?.cacheDurationMs || null,
      cloudAvailable: isCloudAvailable,
      skipped: !isCloudAvailable,
    },
  };
}
