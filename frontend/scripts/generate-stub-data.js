#!/usr/bin/env node
// Generate deterministic stub time-series for the stock-swarm viz.
// Run: node frontend/scripts/generate-stub-data.js
//
// Each ticker's daily log-return is a weighted blend of its parents'
// lagged log-returns plus idiosyncratic noise. Tier-1 anchors are pure
// random walks. The hierarchy is intentionally visible in the data so
// the correlation-graph derived in Task 4 should roughly recover it.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../public/stock-swarm/stub.json')

// ---------- Config ----------
const SEED = 0xC0FFEE
const DAYS = 504 // ~2 trading years
const START_PRICE = 100
const END_DATE = new Date('2026-04-17T00:00:00Z')

// ---------- Ticker registry ----------
// tier: 1 = macro anchor, higher = more downstream.
// parents: list of [symbol, weight] influence links. Weights need not sum to 1;
//   the generator normalizes the parent contribution per ticker.
// vol: idiosyncratic daily stdev (log-return scale).
// drift: annualized drift (log-return scale).
const TICKERS = [
  // Tier 1 — macro anchors
  { s: 'SPY',   tier: 1, name: 'S&P 500 ETF',            parents: [],                                          vol: 0.010, drift: 0.09 },
  { s: 'QQQ',   tier: 1, name: 'Nasdaq 100 ETF',         parents: [['SPY', 0.6]],                              vol: 0.012, drift: 0.13 },
  { s: 'XLF',   tier: 1, name: 'Financials ETF',         parents: [['SPY', 0.5]],                              vol: 0.011, drift: 0.06 },
  { s: 'TLT',   tier: 1, name: '20+yr Treasury ETF',     parents: [],                                          vol: 0.008, drift: -0.01 },

  // Tier 2 — mega-cap leaders
  { s: 'AAPL',  tier: 2, name: 'Apple',                  parents: [['QQQ', 0.55], ['SPY', 0.2]],               vol: 0.017, drift: 0.18 },
  { s: 'MSFT',  tier: 2, name: 'Microsoft',              parents: [['QQQ', 0.55], ['SPY', 0.2]],               vol: 0.016, drift: 0.20 },
  { s: 'GOOGL', tier: 2, name: 'Alphabet',               parents: [['QQQ', 0.55], ['SPY', 0.15]],              vol: 0.018, drift: 0.15 },
  { s: 'AMZN',  tier: 2, name: 'Amazon',                 parents: [['QQQ', 0.55], ['SPY', 0.15]],              vol: 0.020, drift: 0.17 },
  { s: 'META',  tier: 2, name: 'Meta Platforms',         parents: [['QQQ', 0.55], ['SPY', 0.1]],               vol: 0.023, drift: 0.20 },
  { s: 'NVDA',  tier: 2, name: 'NVIDIA',                 parents: [['QQQ', 0.5],  ['SPY', 0.1]],               vol: 0.030, drift: 0.45 },
  { s: 'TSLA',  tier: 2, name: 'Tesla',                  parents: [['QQQ', 0.4],  ['SPY', 0.1]],               vol: 0.035, drift: 0.10 },

  // Tier 3 — semis, downstream of NVDA/AAPL
  { s: 'TSM',   tier: 3, name: 'TSMC',                   parents: [['NVDA', 0.35], ['AAPL', 0.25], ['QQQ', 0.2]], vol: 0.022, drift: 0.18 },
  { s: 'AVGO',  tier: 3, name: 'Broadcom',               parents: [['NVDA', 0.35], ['AAPL', 0.2],  ['QQQ', 0.2]], vol: 0.022, drift: 0.25 },
  { s: 'AMD',   tier: 3, name: 'AMD',                    parents: [['NVDA', 0.55], ['QQQ', 0.2]],              vol: 0.030, drift: 0.20 },
  { s: 'INTC',  tier: 3, name: 'Intel',                  parents: [['NVDA', 0.25], ['QQQ', 0.25]],             vol: 0.025, drift: -0.05 },
  { s: 'MU',    tier: 3, name: 'Micron',                 parents: [['NVDA', 0.35], ['QQQ', 0.25]],             vol: 0.028, drift: 0.12 },
  { s: 'QCOM',  tier: 3, name: 'Qualcomm',               parents: [['AAPL', 0.35], ['QQQ', 0.25]],             vol: 0.022, drift: 0.10 },
  { s: 'ASML',  tier: 3, name: 'ASML',                   parents: [['NVDA', 0.3],  ['TSM', 0.3], ['QQQ', 0.2]], vol: 0.024, drift: 0.18 },

  // Tier 4 — enterprise software, downstream of MSFT / GOOGL
  { s: 'CRM',   tier: 4, name: 'Salesforce',             parents: [['MSFT', 0.35], ['QQQ', 0.25]],             vol: 0.021, drift: 0.12 },
  { s: 'ORCL',  tier: 4, name: 'Oracle',                 parents: [['MSFT', 0.3],  ['QQQ', 0.25]],             vol: 0.019, drift: 0.15 },
  { s: 'ADBE',  tier: 4, name: 'Adobe',                  parents: [['MSFT', 0.3],  ['GOOGL', 0.2], ['QQQ', 0.2]], vol: 0.021, drift: 0.10 },
  { s: 'NOW',   tier: 4, name: 'ServiceNow',             parents: [['MSFT', 0.35], ['QQQ', 0.25]],             vol: 0.023, drift: 0.18 },

  // Tier 5 — financials inside XLF
  { s: 'JPM',   tier: 5, name: 'JPMorgan Chase',         parents: [['XLF', 0.55], ['SPY', 0.15], ['TLT', -0.15]], vol: 0.016, drift: 0.08 },
  { s: 'BAC',   tier: 5, name: 'Bank of America',        parents: [['XLF', 0.6],  ['JPM', 0.2],  ['TLT', -0.15]], vol: 0.018, drift: 0.05 },
  { s: 'WFC',   tier: 5, name: 'Wells Fargo',            parents: [['XLF', 0.55], ['JPM', 0.2],  ['TLT', -0.15]], vol: 0.018, drift: 0.05 },
  { s: 'GS',    tier: 5, name: 'Goldman Sachs',          parents: [['XLF', 0.45], ['SPY', 0.2]],               vol: 0.020, drift: 0.10 },
  { s: 'MS',    tier: 5, name: 'Morgan Stanley',         parents: [['XLF', 0.45], ['GS',  0.25]],              vol: 0.020, drift: 0.09 },
  { s: 'C',     tier: 5, name: 'Citigroup',              parents: [['XLF', 0.55], ['JPM', 0.2],  ['TLT', -0.1]], vol: 0.020, drift: 0.04 },

  // Tier 6 — energy producers (macro: SPY, loose tie to TLT-inverse)
  { s: 'XOM',   tier: 6, name: 'Exxon Mobil',            parents: [['SPY', 0.25]],                             vol: 0.017, drift: 0.08 },
  { s: 'CVX',   tier: 6, name: 'Chevron',                parents: [['SPY', 0.2],  ['XOM', 0.5]],               vol: 0.017, drift: 0.07 },
  { s: 'COP',   tier: 6, name: 'ConocoPhillips',         parents: [['XOM', 0.5],  ['SPY', 0.2]],               vol: 0.020, drift: 0.10 },
  { s: 'SLB',   tier: 6, name: 'Schlumberger',           parents: [['XOM', 0.4],  ['CVX', 0.3]],               vol: 0.022, drift: 0.05 },

  // Tier 7 — transport, inversely sensitive to fuel (energy)
  { s: 'UPS',   tier: 7, name: 'UPS',                    parents: [['SPY', 0.3],  ['XOM', -0.25]],             vol: 0.016, drift: 0.03 },
  { s: 'FDX',   tier: 7, name: 'FedEx',                  parents: [['SPY', 0.3],  ['XOM', -0.25], ['UPS', 0.25]], vol: 0.018, drift: 0.04 },
  { s: 'DAL',   tier: 7, name: 'Delta Air Lines',        parents: [['SPY', 0.25], ['XOM', -0.45]],             vol: 0.028, drift: 0.06 },
  { s: 'UAL',   tier: 7, name: 'United Airlines',        parents: [['SPY', 0.25], ['XOM', -0.45], ['DAL', 0.35]], vol: 0.030, drift: 0.06 },

  // Tier 8 — healthcare (largely macro)
  { s: 'UNH',   tier: 8, name: 'UnitedHealth',           parents: [['SPY', 0.35]],                             vol: 0.014, drift: 0.08 },
  { s: 'JNJ',   tier: 8, name: 'Johnson & Johnson',      parents: [['SPY', 0.3]],                              vol: 0.011, drift: 0.04 },
  { s: 'LLY',   tier: 8, name: 'Eli Lilly',              parents: [['SPY', 0.25]],                             vol: 0.020, drift: 0.30 },
  { s: 'PFE',   tier: 8, name: 'Pfizer',                 parents: [['SPY', 0.3],  ['JNJ', 0.2]],               vol: 0.015, drift: -0.02 },

  // Tier 9 — consumer / retail
  { s: 'WMT',   tier: 9, name: 'Walmart',                parents: [['SPY', 0.35]],                             vol: 0.013, drift: 0.12 },
  { s: 'COST',  tier: 9, name: 'Costco',                 parents: [['SPY', 0.3],  ['WMT', 0.25]],              vol: 0.015, drift: 0.18 },
  { s: 'HD',    tier: 9, name: 'Home Depot',             parents: [['SPY', 0.3],  ['TLT', 0.15]],              vol: 0.018, drift: 0.10 },
  { s: 'TGT',   tier: 9, name: 'Target',                 parents: [['SPY', 0.3],  ['WMT', 0.35]],              vol: 0.022, drift: 0.04 },

  // Tier 10 — payments duopoly
  { s: 'V',     tier: 10, name: 'Visa',                  parents: [['SPY', 0.3],  ['QQQ', 0.2]],               vol: 0.014, drift: 0.12 },
  { s: 'MA',    tier: 10, name: 'Mastercard',            parents: [['V', 0.7],    ['SPY', 0.15]],              vol: 0.015, drift: 0.13 },
  { s: 'PYPL',  tier: 10, name: 'PayPal',                parents: [['V', 0.25],   ['QQQ', 0.3]],               vol: 0.025, drift: -0.05 },

  // Tier 11 — gold (risk-off, inverse to rates & equities)
  { s: 'GLD',   tier: 11, name: 'Gold ETF',              parents: [['SPY', -0.25], ['TLT', 0.2]],              vol: 0.012, drift: 0.08 },
  { s: 'NEM',   tier: 11, name: 'Newmont',               parents: [['GLD', 0.65], ['SPY', -0.1]],              vol: 0.022, drift: 0.03 },
  { s: 'GOLD',  tier: 11, name: 'Barrick Gold',          parents: [['GLD', 0.65], ['NEM', 0.2]],               vol: 0.024, drift: 0.02 },
]

if (TICKERS.length !== 50) {
  throw new Error(`Expected 50 tickers, got ${TICKERS.length}`)
}

// ---------- Seeded RNG (mulberry32) ----------
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(SEED)
// Box-Muller standard normal
function gauss() {
  let u = 0, v = 0
  while (u === 0) u = rand()
  while (v === 0) v = rand()
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
}

// ---------- Date series (weekdays only, ending at END_DATE) ----------
function buildDates(count, end) {
  const out = []
  const d = new Date(end)
  while (out.length < count) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) {
      out.push(d.toISOString().slice(0, 10))
    }
    d.setUTCDate(d.getUTCDate() - 1)
  }
  return out.reverse()
}

// ---------- Generate returns tier-by-tier so parents exist first ----------
// Topological order by tier, then by declaration order within tier
const ordered = [...TICKERS].sort((a, b) => a.tier - b.tier)

const logReturns = {}     // symbol -> array[DAYS] of log-returns
const dailyDrift = d => d / 252

for (const t of ordered) {
  const r = new Array(DAYS)
  const idioVol = t.vol
  const mu = dailyDrift(t.drift)

  // Normalize positive vs. negative parents separately so the *scale* of the
  // influence blend stays bounded regardless of sign mix.
  const parents = t.parents
  let absSum = 0
  for (const [, w] of parents) absSum += Math.abs(w)
  const parentGain = absSum > 0 ? Math.min(0.9, absSum) / absSum : 0 // cap total parent influence

  for (let i = 0; i < DAYS; i++) {
    let parentComponent = 0
    for (const [pSym, w] of parents) {
      const pr = logReturns[pSym]
      if (!pr) throw new Error(`parent ${pSym} missing for ${t.s}`)
      parentComponent += w * parentGain * pr[i]
    }
    r[i] = mu + parentComponent + idioVol * gauss()
  }
  logReturns[t.s] = r
}

// ---------- Integrate log-returns into prices ----------
const prices = {}
for (const t of TICKERS) {
  const p = new Array(DAYS)
  let logP = Math.log(START_PRICE)
  const r = logReturns[t.s]
  for (let i = 0; i < DAYS; i++) {
    logP += r[i]
    p[i] = +Math.exp(logP).toFixed(4)
  }
  prices[t.s] = p
}

// ---------- Write ----------
const payload = {
  generated_at: new Date().toISOString(),
  seed: SEED,
  days: DAYS,
  dates: buildDates(DAYS, END_DATE),
  tickers: TICKERS.map(t => ({
    symbol: t.s,
    name: t.name,
    tier: t.tier,
    parents: t.parents.map(([s, w]) => ({ symbol: s, weight: w })),
  })),
  prices,
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(payload))
const bytes = JSON.stringify(payload).length
console.log(`wrote ${OUT} (${TICKERS.length} tickers × ${DAYS} days, ${(bytes / 1024).toFixed(1)} KB)`)
