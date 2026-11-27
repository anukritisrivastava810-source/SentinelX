/**
 * ═══════════════════════════════════════════════════════
 * SentinelX — aiExplainerService.js
 *
 * On-device AI Threat Explainer using Chrome's built-in
 * Prompt API (LanguageModel / Gemini Nano).
 *
 * Gracefully degrades to { available: false } on any
 * browser/device that does not support the API.
 * ═══════════════════════════════════════════════════════
 */

// System prompt fed to the on-device model for every session.
const SYSTEM_PROMPT = `You are a concise cybersecurity analyst embedded in a browser security extension.
You receive structured scan data about a webpage and must return a plain-language threat explanation.
Always be factual, brief, and actionable. Never hallucinate URLs or threat types not present in the data.
Your entire response MUST be valid JSON matching the requested schema.`;

// Singleton session — reuse across multiple calls within the same popup lifecycle.
let _session = null;

/**
 * Checks whether Chrome's built-in LanguageModel API is present and usable.
 *
 * Returns one of:
 *   'available'     — model is ready to use on this device
 *   'downloadable'  — model exists but needs a download first
 *   'unavailable'   — API not present or model not supported
 */
export async function isAiAvailable() {
  try {
    if (!('LanguageModel' in self)) return 'unavailable';
    const status = await LanguageModel.availability();
    // 'available' | 'downloadable' | 'downloading' | 'unavailable'
    if (status === 'available') return 'available';
    if (status === 'downloadable' || status === 'downloading') return 'downloadable';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * Returns (or lazily creates) a reusable LanguageModel session.
 * Returns null if session creation fails.
 */
async function getSession() {
  if (_session) return _session;
  try {
    _session = await LanguageModel.create({
      systemPrompt: SYSTEM_PROMPT,
      expectedInputs:  [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
    return _session;
  } catch (err) {
    console.warn('[SentinelX AI] Session creation failed:', err);
    _session = null;
    return null;
  }
}

/**
 * Destroys the cached session so the next call creates a fresh one.
 * Call this if a prompt errors out with a non-recoverable failure.
 */
function resetSession() {
  if (_session) {
    try { _session.destroy(); } catch { /* ignore */ }
  }
  _session = null;
}

/**
 * explainThreat(scanResult)
 *
 * Sends the scan result to the on-device LanguageModel and returns a
 * structured explanation object:
 *   { available: true, summary, riskReason, recommendedAction }
 *
 * On any failure, returns { available: false }.
 *
 * @param {Object} scanResult - The result object from analyseUrl / aggregate.
 *   Expected fields: url, score, label, checks[], contentFindings (optional).
 * @returns {Promise<Object>}
 */
export async function explainThreat(scanResult) {
  try {
    const avail = await isAiAvailable();
    if (avail !== 'available') {
      return { available: false, reason: avail === 'downloadable' ? 'downloading' : 'unsupported' };
    }

    const session = await getSession();
    if (!session) return { available: false, reason: 'session_failed' };

    // Build a compact, structured prompt from scan data
    const failedChecks = (scanResult.checks || [])
      .filter(c => !c.passed && !c.warn)
      .map(c => c.label)
      .slice(0, 6);

    const warnChecks = (scanResult.checks || [])
      .filter(c => c.warn)
      .map(c => c.label)
      .slice(0, 4);

    const contentFindings = scanResult.contentFindings
      ? JSON.stringify(scanResult.contentFindings)
      : 'none';

    const userMessage = `Analyse this URL scan result and explain the threat in plain English.

URL: ${scanResult.url || 'unknown'}
Risk Score: ${scanResult.score ?? 0}/100
Verdict: ${scanResult.label || 'Unknown'}
HTTPS: ${scanResult.isHttps ? 'Yes' : 'No'}
Failed Security Checks: ${failedChecks.length > 0 ? failedChecks.join('; ') : 'none'}
Warning Checks: ${warnChecks.length > 0 ? warnChecks.join('; ') : 'none'}
Page Content Findings: ${contentFindings}

Respond ONLY with valid JSON in this exact format:
{
  "summary": "One sentence overview of the threat level (max 25 words)",
  "riskReason": "Plain-English explanation of why this risk score was assigned (max 40 words)",
  "recommendedAction": "Specific action the user should take right now (max 20 words)"
}`;

    // Define the response constraint schema to enforce structured JSON output
    const responseConstraint = {
      type: 'object',
      properties: {
        summary:           { type: 'string' },
        riskReason:        { type: 'string' },
        recommendedAction: { type: 'string' },
      },
      required: ['summary', 'riskReason', 'recommendedAction'],
      additionalProperties: false,
    };

    let rawText;
    try {
      // Use responseConstraint if the API supports it; fall back to plain prompt
      if (typeof session.prompt === 'function') {
        try {
          rawText = await session.prompt(userMessage, { responseConstraint });
        } catch (constraintErr) {
          // Some builds don't support responseConstraint yet — fall back gracefully
          console.warn('[SentinelX AI] responseConstraint not supported, falling back:', constraintErr);
          rawText = await session.prompt(userMessage);
        }
      } else {
        return { available: false, reason: 'api_unsupported' };
      }
    } catch (promptErr) {
      console.error('[SentinelX AI] Prompt failed:', promptErr);
      resetSession();
      return { available: false, reason: 'prompt_failed' };
    }

    // Parse JSON — strip any markdown fences the model may have added
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    // Validate required fields
    if (
      typeof parsed.summary !== 'string' ||
      typeof parsed.riskReason !== 'string' ||
      typeof parsed.recommendedAction !== 'string'
    ) {
      throw new Error('Response schema mismatch');
    }

    return {
      available:         true,
      summary:           parsed.summary.trim(),
      riskReason:        parsed.riskReason.trim(),
      recommendedAction: parsed.recommendedAction.trim(),
    };

  } catch (err) {
    console.warn('[SentinelX AI] explainThreat error:', err);
    return { available: false, reason: 'parse_error' };
  }
}
