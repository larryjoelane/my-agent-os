// Single responsibility: turn a raw string into an array of normalized
// word tokens. No scoring, no I/O — just text -> tokens.

// Lowercase, strip anything that isn't a letter/digit into a separator,
// split on whitespace, drop empties. Deliberately simple (no stemming,
// no stopword list) — TF-IDF's IDF term already discounts words that
// appear in most documents.
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

module.exports = { tokenize };
