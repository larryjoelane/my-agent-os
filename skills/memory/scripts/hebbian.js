// Single responsibility: pure edge-weight math for co-retrieval
// strengthening ("fire together, wire together") and time-based decay.
// No I/O, no SQLite, no CLI concerns — see edgeStore.js for storage and
// sessionIndex.js for how these are wired into search/save.
//
// Design note: plain Hebbian growth (w += eta) is unbounded and unstable
// (see docs/hebbian-edges.md). To avoid that, strengthening here is
// asymptotic — each reinforcement moves the weight a fraction of the
// remaining distance to a fixed ceiling, so weak edges grow fast and
// strong edges plateau instead of climbing forever.

const CEILING = 1; // max edge weight, asymptote for strengthen()
const DEFAULT_RATE = 0.3; // fraction of remaining distance to ceiling per co-retrieval
const DEFAULT_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// currentWeight -> new weight, moved a fraction `rate` of the way to
// CEILING. Saturating: approaches but never exceeds CEILING.
function strengthen(currentWeight, rate = DEFAULT_RATE) {
  const w = currentWeight || 0;
  return w + (CEILING - w) * rate;
}

// (weight, elapsedMs, halfLifeMs) -> decayed weight. Standard exponential
// decay so unused edges fade smoothly rather than via a hard cutoff.
function decay(weight, elapsedMs, halfLifeMs = DEFAULT_HALF_LIFE_MS) {
  if (elapsedMs <= 0) return weight;
  const factor = Math.pow(0.5, elapsedMs / halfLifeMs);
  return weight * factor;
}

// ids ([]) -> [[a,b], ...] every unordered pair, a < b. Used to turn a
// set of co-retrieved memory ids into the edges to strengthen.
function pairs(ids) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      out.push([sorted[i], sorted[j]]);
    }
  }
  return out;
}

module.exports = { strengthen, decay, pairs, CEILING, DEFAULT_RATE, DEFAULT_HALF_LIFE_MS };
