// Hierarchy helpers: dedup the DAG declared by universe.js + children.js
// into a single node map, and offer convenience queries.
//
// Tier convention:
//   0 = macro anchor (SPY, QQQ, GLD, TLT)
//   1 = primary (one of the 100)
//   2 = child-only (appears as a substock but never as a primary)

import { ANCHORS, PRIMARIES } from './universe.js'
import { CHILDREN } from './children.js'

function buildMeta() {
  const meta = new Map()

  for (const a of ANCHORS) {
    meta.set(a.symbol, {
      symbol: a.symbol, name: a.name, group: a.group, tier: 0,
      parents: [], children: [],
    })
  }
  for (const p of PRIMARIES) {
    meta.set(p.symbol, {
      symbol: p.symbol, name: p.name, group: p.group, tier: 1,
      parents: [], children: [],
    })
  }

  // Pull children from the CHILDREN map. If a child isn't already a
  // primary/anchor, mint a tier-2 entry for it on the fly.
  for (const [parentSym, kids] of Object.entries(CHILDREN)) {
    const parentEntry = meta.get(parentSym)
    if (!parentEntry) continue // shouldn't happen
    for (const k of kids) {
      let childEntry = meta.get(k.symbol)
      if (!childEntry) {
        childEntry = {
          symbol: k.symbol,
          name: k.name ?? k.symbol,
          group: parentEntry.group + '-sub',
          tier: 2,
          parents: [],
          children: [],
        }
        meta.set(k.symbol, childEntry)
      }
      parentEntry.children.push({ symbol: k.symbol, relation: k.relation, weight: k.weight })
      childEntry.parents.push({ symbol: parentSym, relation: k.relation, weight: k.weight })
    }
  }

  return meta
}

export const NODE_META = buildMeta()
export const ALL_SYMBOLS = Array.from(NODE_META.keys())

export function getNode(sym) { return NODE_META.get(sym) }
export function isAnchor(sym) { return NODE_META.get(sym)?.tier === 0 }
export function isPrimary(sym) { return NODE_META.get(sym)?.tier === 1 }
export function isChild(sym) { return NODE_META.get(sym)?.tier === 2 }

// All direct children of a node (for expanding clusters).
export function childrenOf(sym) {
  return NODE_META.get(sym)?.children ?? []
}

// All direct parents of a node (a child may have several).
export function parentsOf(sym) {
  return NODE_META.get(sym)?.parents ?? []
}

// Count stats useful for the HUD.
export const UNIVERSE_STATS = {
  anchors: ANCHORS.length,
  primaries: PRIMARIES.length,
  childOnly: ALL_SYMBOLS.length - ANCHORS.length - PRIMARIES.length,
  total: ALL_SYMBOLS.length,
  edges: Object.values(CHILDREN).reduce((a, b) => a + b.length, 0),
}
