/**
 * ChronicleDB — LLM call monitor
 *
 * In-memory ring buffer of recent LLM call records for the debug surface.
 * Capacity 200, newest first. Memory-only: cleared on process restart.
 *
 * This module is intentionally standalone and must never throw from record():
 * a bad caller must not be able to break an extraction or other hot path.
 * All fields except `status` are optional and default to null.
 *
 * Wiring is a deliberate follow-up step — extractor.js is not edited here to
 * avoid conflicting with parallel work on that file. Until wired, list()
 * returns an empty buffer, which the /debug/llm-calls route and settings UI
 * both handle cleanly.
 */

const MAX = 200;
const buffer = [];

/**
 * Record a single LLM call. All fields optional except `status`.
 *
 * @param {object} entry
 * @param {string=} entry.provider        "gemini" | "vertex" | "openai" | "other"
 * @param {string=} entry.model           model id, e.g. "gemini-2.5-flash-lite"
 * @param {string=} entry.purpose         "extract" | "situating-blurb" | "verify-trait" | "name-arc" | "embed" | ...
 * @param {string=} entry.promptPreview   prompt text, truncated to 500 chars
 * @param {string=} entry.responsePreview response text, truncated to 500 chars
 * @param {number=} entry.latencyMs       wall-clock latency in ms
 * @param {string}  entry.status          "ok" | "error"
 * @param {string=} entry.error           error message string, if status === "error"
 * @param {number=} entry.inputSize       chars or tokens in the input (whichever we know)
 * @param {number=} entry.outputSize      chars or tokens in the output
 */
function record(entry) {
  try {
    const e = entry || {};
    const rec = {
      timestamp: new Date().toISOString(),
      provider: e.provider ?? null,
      model: e.model ?? null,
      purpose: e.purpose ?? null,
      promptPreview: e.promptPreview != null ? String(e.promptPreview).slice(0, 500) : null,
      responsePreview: e.responsePreview != null ? String(e.responsePreview).slice(0, 500) : null,
      latencyMs: typeof e.latencyMs === "number" ? e.latencyMs : null,
      status: e.status ?? null,
      error: e.error ?? null,
      inputSize: typeof e.inputSize === "number" ? e.inputSize : null,
      outputSize: typeof e.outputSize === "number" ? e.outputSize : null,
    };
    buffer.unshift(rec);
    if (buffer.length > MAX) buffer.length = MAX;
  } catch (_err) {
    // Never throw from a monitor record — a bad call must not break extraction.
  }
}

/** Return a shallow copy of the buffer (newest first). */
function list() {
  return buffer.slice();
}

/** Drop all records. Used by tests; currently no HTTP endpoint calls this. */
function clear() {
  buffer.length = 0;
}

module.exports = { record, list, clear };
