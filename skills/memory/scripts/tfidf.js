// Single responsibility: TF-IDF vector math. Each function does exactly
// one step of the pipeline (term frequency -> corpus IDF -> TF-IDF vector
// -> cosine similarity) and is pure — no I/O, no SQLite, no CLI concerns.
// No native modules, no model downloads: this is the whole "semantic"
// layer, and it is lexical-overlap, not true semantic matching.

// tokens (string[]) -> { term: count }
function termFrequencies(tokens) {
  const tf = Object.create(null);
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

// termFreqMaps ({term: count}[]) -> { term: idf }
// Standard smoothed IDF: log((1 + N) / (1 + docsContainingTerm)) + 1.
// The +1 smoothing avoids a zero/negative IDF for terms in every
// document and avoids division by zero for a term in zero documents.
function buildIdf(termFreqMaps) {
  const docCount = termFreqMaps.length;
  const docsContaining = Object.create(null);
  for (const tf of termFreqMaps) {
    for (const term of Object.keys(tf)) {
      docsContaining[term] = (docsContaining[term] || 0) + 1;
    }
  }
  const idf = Object.create(null);
  for (const term of Object.keys(docsContaining)) {
    idf[term] = Math.log((1 + docCount) / (1 + docsContaining[term])) + 1;
  }
  return idf;
}

// (termFreqs, idf) -> { term: weight } — a sparse TF-IDF vector.
function tfidfVector(termFreqs, idf) {
  const vec = Object.create(null);
  for (const term of Object.keys(termFreqs)) {
    const weight = idf[term];
    if (weight) vec[term] = termFreqs[term] * weight;
  }
  return vec;
}

// (sparseVecA, sparseVecB) -> number in [0, 1] (given non-negative
// weights). Iterates the smaller vector's keys for efficiency.
function cosineSimilarity(a, b) {
  const [small, large] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
  let dot = 0;
  for (const term of Object.keys(small)) {
    if (term in large) dot += small[term] * large[term];
  }
  if (dot === 0) return 0;
  const normA = Math.sqrt(Object.values(a).reduce((s, w) => s + w * w, 0));
  const normB = Math.sqrt(Object.values(b).reduce((s, w) => s + w * w, 0));
  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}

module.exports = { termFrequencies, buildIdf, tfidfVector, cosineSimilarity };
