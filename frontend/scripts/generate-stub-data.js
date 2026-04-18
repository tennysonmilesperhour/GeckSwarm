#!/usr/bin/env node
// Deterministic synthetic prices for the full 438-node stock-swarm
// universe. Uses a factor model so correlations are plausible at scale:
//
//   daily_log_return[ticker] = sum( loading_k * factor_k_return )
//                            + sum over declared parents( w * parent_return )
//                            + idiosyncratic_noise
//
// Factors: MARKET, RATES, GOLD, plus one per sector group. Sector
// loading is derived from the ticker's group in universe.js; children
// inherit their strongest primary parent's group as their sector.
// Parent blending (weighted from children.js) adds the explicit
// ticker-level ties on top of the sector factor.
//
// Run: node frontend/scripts/generate-stub-data.js

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ANCHORS, PRIMARIES } from '../src/data/universe.js'
import { CHILDREN } from '../src/data/children.js'
import { NODE_META, ALL_SYMBOLS, UNIVERSE_STATS } from '../src/data/hierarchy.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../public/stock-swarm/stub.json')

// ---------- Config ----------
const SEED = 0xC0FFEE
const DAYS = 504
const START_PRICE = 100
const END_DATE = new Date('2026-04-17T00:00:00Z')

// ---------- Seeded RNG ----------
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
function gauss() {
  let u = 0, v = 0
  while (u === 0) u = rand()
  while (v === 0) v = rand()
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
}

// ---------- Date series (weekdays, ending at END_DATE) ----------
function buildDates(count, end) {
  const out = []
  const d = new Date(end)
  while (out.length < count) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() - 1)
  }
  return out.reverse()
}

// ---------- Factor definitions (one per sector + macro) ----------
// Maps a ticker's `group` to a sector factor name. Anchors get macro factors.
const GROUP_TO_FACTOR = {
  'anchor': null,             // anchors defined separately below
  'tech-mega': 'TECH',
  'semis': 'SEMIS',
  'software': 'TECH',
  'media': 'MEDIA',
  'banks': 'FIN',
  'insurance': 'FIN',
  'payments': 'FIN',
  'assetmgr': 'FIN',
  'pharma': 'HEALTH',
  'health-svc': 'HEALTH',
  'medtech': 'HEALTH',
  'energy': 'ENERGY',
  'staples': 'STAPLES',
  'discretionary': 'DISCR',
  'transport': 'TRANSP',
  'industrials': 'INDUST',
  'materials': 'MATER',
  'telecom': 'TELECOM',
  'utilities': 'UTIL',
  'reits': 'REIT',
  'gold': 'GOLD',
  'tobacco': 'STAPLES',
}

const FACTOR_NAMES = [
  'MARKET', 'RATES', 'GOLD',
  'TECH', 'SEMIS', 'MEDIA',
  'FIN', 'HEALTH', 'ENERGY', 'STAPLES', 'DISCR', 'TRANSP',
  'INDUST', 'MATER', 'TELECOM', 'UTIL', 'REIT',
]

// Factor annualized vol (daily stdev after sqrt conversion). Market is the
// broadest so a bit tighter; sector factors are higher to create sector
// clustering; gold and rates have their own dynamics.
const FACTOR_VOL_ANNUAL = {
  MARKET:  0.14,  RATES:   0.08,  GOLD:    0.14,
  TECH:    0.17,  SEMIS:   0.22,  MEDIA:   0.16,
  FIN:     0.16,  HEALTH:  0.13,  ENERGY:  0.22,
  STAPLES: 0.10,  DISCR:   0.15,  TRANSP:  0.17,
  INDUST:  0.14,  MATER:   0.18,  TELECOM: 0.12,
  UTIL:    0.11,  REIT:    0.14,
}

const FACTOR_DRIFT_ANNUAL = {
  MARKET: 0.08,  RATES: -0.01, GOLD: 0.06,
  TECH: 0.14, SEMIS: 0.22, MEDIA: 0.02,
  FIN: 0.06, HEALTH: 0.07, ENERGY: 0.06, STAPLES: 0.04,
  DISCR: 0.08, TRANSP: 0.04, INDUST: 0.06, MATER: 0.02,
  TELECOM: 0.01, UTIL: 0.03, REIT: 0.02,
}

// Cross-factor couplings: sector factors are partially correlated with the
// broad MARKET factor. Energy / Gold / Rates less so.
const FACTOR_MARKET_BETA = {
  MARKET: 0, RATES: -0.15, GOLD: -0.25,
  TECH: 0.55, SEMIS: 0.50, MEDIA: 0.50,
  FIN: 0.50, HEALTH: 0.35, ENERGY: 0.30, STAPLES: 0.30,
  DISCR: 0.50, TRANSP: 0.45, INDUST: 0.45, MATER: 0.35,
  TELECOM: 0.25, UTIL: 0.20, REIT: 0.35,
}

// ---------- Generate factor return series ----------
const dailyFrom = annual => annual / 252
const dailyVol = annual => annual / Math.sqrt(252)

const factorReturns = {}
// Step 1: generate "raw" factor returns as independent random walks.
for (const f of FACTOR_NAMES) {
  const vol = dailyVol(FACTOR_VOL_ANNUAL[f] ?? 0.12)
  const mu = dailyFrom(FACTOR_DRIFT_ANNUAL[f] ?? 0.04)
  const r = new Array(DAYS)
  for (let i = 0; i < DAYS; i++) r[i] = mu + vol * gauss()
  factorReturns[f] = r
}
// Step 2: infuse each non-MARKET factor with a MARKET beta so sectors move
// with the broad market + their own sector idiosyncrasies.
for (const f of FACTOR_NAMES) {
  if (f === 'MARKET') continue
  const beta = FACTOR_MARKET_BETA[f] ?? 0
  for (let i = 0; i < DAYS; i++) {
    factorReturns[f][i] += beta * factorReturns.MARKET[i]
  }
}

// Step 3: intra-cluster coupling so sub-sectors correlate more tightly
// with their sector peers than with the broad market alone (e.g. SEMIS
// moves with TECH, ENERGY <-> TRANSP inverse via oil-cost channel).
const CLUSTER_COUPLING = [
  // [target, source, beta] — target += beta * source
  ['SEMIS',  'TECH',   0.55],
  ['MEDIA',  'TECH',   0.35],
  ['DISCR',  'STAPLES', 0.20],
  ['TRANSP', 'ENERGY', -0.35],
  ['MATER',  'ENERGY', 0.25],
  ['UTIL',   'RATES',   0.35],
  ['REIT',   'RATES',   0.35],
  ['TELECOM','RATES',   0.25],
  ['GOLD',   'RATES',   0.20],
  ['FIN',    'RATES',  -0.30],
]
for (const [target, source, beta] of CLUSTER_COUPLING) {
  for (let i = 0; i < DAYS; i++) {
    factorReturns[target][i] += beta * factorReturns[source][i]
  }
}

// ---------- Per-symbol factor loadings + volatility ----------
// Anchors: SPY = MARKET, QQQ = MARKET + TECH, GLD = GOLD, TLT = RATES
// Primaries: their group factor + MARKET
// Child-only: inherit primary's factor via parents; plus lighter MARKET
function loadingsFor(sym) {
  const node = NODE_META.get(sym)
  if (!node) return { MARKET: 1 }

  if (node.tier === 0) {
    if (sym === 'SPY') return { MARKET: 1.0 }
    if (sym === 'QQQ') return { MARKET: 0.7, TECH: 0.55 }
    if (sym === 'GLD') return { GOLD: 1.0 }
    if (sym === 'TLT') return { RATES: 1.0 }
    return { MARKET: 1.0 }
  }

  const sector = GROUP_TO_FACTOR[node.group]
  const L = { MARKET: 0.45 }
  if (sector) L[sector] = (L[sector] ?? 0) + 0.55
  if (node.tier === 2) {
    // Child-only — soften MARKET exposure, let parent blending drive ties.
    L.MARKET = 0.35
    if (sector) L[sector] = 0.45
  }
  return L
}

// Idiosyncratic vol per tier — higher for smaller / newer names.
function idioVol(sym) {
  const node = NODE_META.get(sym)
  if (!node) return 0.01
  if (node.tier === 0) return 0.002
  if (node.tier === 1) return 0.007
  return 0.010
}

// ---------- Generate per-symbol log returns ----------
// For primaries + anchors we can generate directly (factor model). For
// child-only nodes, we additionally blend in the strongest-weighted
// primary parent's return. That primary has already been computed.
const logReturns = {}

// Pass 1: anchors + primaries (factor-model only).
for (const sym of ALL_SYMBOLS) {
  const node = NODE_META.get(sym)
  if (node.tier > 1) continue
  const L = loadingsFor(sym)
  const iv = idioVol(sym)
  const r = new Array(DAYS)
  for (let i = 0; i < DAYS; i++) {
    let v = 0
    for (const [f, w] of Object.entries(L)) v += w * factorReturns[f][i]
    r[i] = v + iv * gauss()
  }
  logReturns[sym] = r
}

// Pass 2: child-only nodes. Blend factor component with the single strongest
// parent relationship so the explicit ticker-level ties in children.js are
// reflected in the correlation structure.
for (const sym of ALL_SYMBOLS) {
  const node = NODE_META.get(sym)
  if (node.tier < 2) continue

  // Strongest absolute-weight parent
  let best = null
  for (const p of node.parents) {
    if (!best || Math.abs(p.weight) > Math.abs(best.weight)) best = p
  }
  const parentR = best && logReturns[best.symbol] ? logReturns[best.symbol] : null
  const parentGain = best ? Math.max(-0.85, Math.min(0.85, best.weight * 0.9)) : 0

  const L = loadingsFor(sym)
  const iv = idioVol(sym)
  // Scale down the factor loadings proportionally when we're using a parent,
  // so total variance stays roughly bounded.
  const factorScale = parentR ? 0.55 : 1.0

  const r = new Array(DAYS)
  for (let i = 0; i < DAYS; i++) {
    let v = 0
    for (const [f, w] of Object.entries(L)) v += factorScale * w * factorReturns[f][i]
    if (parentR) v += parentGain * parentR[i]
    r[i] = v + iv * gauss()
  }
  logReturns[sym] = r
}

// ---------- Integrate log-returns into prices ----------
const prices = {}
for (const sym of ALL_SYMBOLS) {
  // Start prices in a plausible range so they look like real dollars. Base
  // is derived from group so e.g. anchors sit around 400 and a random semi
  // around 120.
  const node = NODE_META.get(sym)
  const startBias = node.tier === 0 ? 380 : (node.tier === 1 ? 140 : 65)
  const jitter = 0.6 + rand() * 1.8
  const startPrice = startBias * jitter

  const p = new Array(DAYS)
  let logP = Math.log(startPrice)
  const r = logReturns[sym]
  for (let i = 0; i < DAYS; i++) {
    logP += r[i]
    p[i] = +Math.exp(logP).toFixed(4)
  }
  prices[sym] = p
}

// ---------- Emit tickers with hierarchy ----------
const tickersOut = []
for (const sym of ALL_SYMBOLS) {
  const n = NODE_META.get(sym)
  tickersOut.push({
    symbol: sym,
    name: n.name,
    tier: n.tier,
    group: n.group,
    parents: n.parents.map(p => ({ symbol: p.symbol, relation: p.relation, weight: p.weight })),
    children: n.children.map(c => ({ symbol: c.symbol, relation: c.relation, weight: c.weight })),
  })
}

const payload = {
  generated_at: new Date().toISOString(),
  seed: SEED,
  days: DAYS,
  dates: buildDates(DAYS, END_DATE),
  stats: UNIVERSE_STATS,
  tickers: tickersOut,
  prices,
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(payload))
const bytes = JSON.stringify(payload).length
console.log(
  `wrote ${OUT} (${ALL_SYMBOLS.length} tickers × ${DAYS} days, ${(bytes / 1024).toFixed(1)} KB)`
)
