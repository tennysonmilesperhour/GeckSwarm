// Utilities for the stock-swarm viz: log-returns, correlation, and a
// 2D embedding via PCA of the correlation matrix (cheap kernel-PCA).

export function toLogReturns(series) {
  const n = series.length
  const out = new Float32Array(n - 1)
  for (let i = 1; i < n; i++) out[i - 1] = Math.log(series[i] / series[i - 1])
  return out
}

export function pearson(a, b) {
  const n = Math.min(a.length, b.length)
  let ma = 0, mb = 0
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i] }
  ma /= n; mb /= n
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb
    num += x * y; da += x * x; db += y * y
  }
  const d = Math.sqrt(da * db)
  return d === 0 ? 0 : num / d
}

export function correlationMatrix(tickerSymbols, prices) {
  const returns = tickerSymbols.map(s => toLogReturns(prices[s]))
  const n = tickerSymbols.length
  const M = Array.from({ length: n }, () => new Float32Array(n))
  for (let i = 0; i < n; i++) {
    M[i][i] = 1
    for (let j = i + 1; j < n; j++) {
      const c = pearson(returns[i], returns[j])
      M[i][j] = c
      M[j][i] = c
    }
  }
  return M
}

// Top-k eigenpairs of a symmetric matrix via power iteration with deflation.
// Good enough for small matrices (~50x50) where we only need the first few.
export function topKEigen(matrix, k = 2, iters = 300) {
  const n = matrix.length
  // Deep copy so we can deflate in place.
  const A = matrix.map(row => Float32Array.from(row))
  const eigs = []
  for (let p = 0; p < k; p++) {
    let v = new Float32Array(n)
    for (let i = 0; i < n; i++) v[i] = Math.random() - 0.5
    let lambda = 0
    for (let it = 0; it < iters; it++) {
      const Av = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        let s = 0
        const row = A[i]
        for (let j = 0; j < n; j++) s += row[j] * v[j]
        Av[i] = s
      }
      let norm = 0
      for (let i = 0; i < n; i++) norm += Av[i] * Av[i]
      norm = Math.sqrt(norm)
      if (norm < 1e-12) break
      let sign = 0
      for (let i = 0; i < n; i++) sign += Av[i] * v[i]
      lambda = (sign >= 0 ? 1 : -1) * norm
      for (let i = 0; i < n; i++) v[i] = Av[i] / norm
    }
    eigs.push({ value: lambda, vector: v })
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] -= lambda * v[i] * v[j]
    }
  }
  return eigs
}

// AR(1) fit on the log-returns of a price series: r_{t+1} = phi * r_t + drift.
// Constrains phi to [-0.99, 0.99] to keep recursive forecasts stable.
export function ar1Fit(series) {
  const r = toLogReturns(series)
  if (r.length < 2) return { phi: 0, drift: 0 }
  let mean = 0
  for (let i = 0; i < r.length; i++) mean += r[i]
  mean /= r.length
  let num = 0, den = 0
  for (let i = 1; i < r.length; i++) {
    const a = r[i - 1] - mean
    num += (r[i] - mean) * a
    den += a * a
  }
  let phi = den > 0 ? num / den : 0
  if (phi > 0.99) phi = 0.99
  if (phi < -0.99) phi = -0.99
  const drift = mean * (1 - phi)
  return { phi, drift }
}

// Mean/stdev of a numeric array.
export function seriesStats(arr) {
  const n = arr.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += arr[i]
  mean /= n
  let v = 0
  for (let i = 0; i < n; i++) { const d = arr[i] - mean; v += d * d }
  return { mean, std: Math.sqrt(v / n) || 1 }
}

// 2D embedding of tickers from the correlation matrix: coords = eigenvector
// scaled by sqrt(|eigenvalue|). Returns array of [x, z] pairs in the same
// order as the input symbol list.
export function correlationEmbedding(matrix, targetSpan = 130) {
  const [e1, e2] = topKEigen(matrix, 2)
  const s1 = Math.sqrt(Math.max(0, Math.abs(e1.value)))
  const s2 = Math.sqrt(Math.max(0, Math.abs(e2.value)))
  // Array.from so the pairs survive — Float32Array#map would coerce [x, y] to NaN.
  const raw = Array.from(e1.vector, (v, i) => [v * s1, e2.vector[i] * s2])
  // Normalize to targetSpan
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const [x, y] of raw) {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  const sx = (maxX - minX) || 1
  const sy = (maxY - minY) || 1
  return raw.map(([x, y]) => [
    ((x - minX) / sx - 0.5) * targetSpan,
    ((y - minY) / sy - 0.5) * targetSpan,
  ])
}
