/**
 * Tokenizer + tsquery builder shared by retriever.js and cdb-client.ts.
 *
 * Both retrieval paths (plugin live path + eval) previously duplicated a
 * 21-term stopword set and the OR-tokenizer verbatim. See REVIEW.md §2a:
 * the drift between them is what caused the `plainto_tsquery` (AND) vs
 * `to_tsquery` (OR) behavior split. One canonical copy lives here now.
 *
 * CJS so the plugin can `require()` it; the eval-side TS imports via
 * Node interop (`moduleResolution: "bundler"` + `esModuleInterop: true`).
 */

const LEXICAL_STOP = new Set([
  "the", "and", "but", "for", "with", "this", "that", "these", "those",
  "what", "who", "when", "where", "why", "how", "which", "whose",
  "does", "did", "is", "are", "was", "were", "be", "been", "being",
  "him", "her", "his", "she", "they", "them", "their", "you", "your",
  "from", "into", "about", "over", "after", "before", "between",
  "say", "said", "says", "saying", "tell", "told", "telling",
  "one", "two", "three", "some", "any", "all", "more", "most",
]);

/**
 * Tokenize a query string and build an ORed to_tsquery expression.
 * Drops stopwords and tokens <= 2 chars, dedupes, joins with ` | `.
 * Returns null when nothing remains (caller short-circuits the search).
 */
function buildOrTsquery(query) {
  if (!query) return null;
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !LEXICAL_STOP.has(t));
  if (terms.length === 0) return null;
  return [...new Set(terms)].join(" | ");
}

module.exports = { LEXICAL_STOP, buildOrTsquery };
