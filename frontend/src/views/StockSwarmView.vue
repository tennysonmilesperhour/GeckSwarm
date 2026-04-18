<template>
  <div class="stock-swarm-root">
    <canvas ref="canvasRef" class="stock-swarm-canvas" />
    <div class="stock-swarm-hud">
      <div class="hud-title">Stock Swarm · Wave Field</div>
      <div class="hud-sub">
        <span v-if="!loaded">loading…</span>
        <span v-else>
          {{ tickerCount }} nodes · {{ currentDate }} ({{ cursor + 1 }}/{{ totalDays }})
        </span>
      </div>
    </div>
    <div ref="labelLayerRef" class="stock-swarm-labels" aria-hidden="true" />

    <div v-if="loadError" class="stock-swarm-error">{{ loadError }}</div>

    <div v-if="activeEvent" class="stock-swarm-event">
      <span class="evt-dot" :style="{ background: activeEvent.color }" />
      <span class="evt-date">{{ activeEvent.date }}</span>
      <span class="evt-label">{{ activeEvent.label }}</span>
    </div>

    <div
      v-if="loaded"
      class="stock-swarm-wind"
      :style="windHudStyle"
      :data-wind-sign="wind >= 0 ? 'pos' : 'neg'"
    >
      <span>wind</span>
      <span class="wind-bar">
        <span class="wind-fill" :style="{ width: windFillPct + '%' }" />
      </span>
      <span class="wind-val">{{ windLabel }}</span>
    </div>

    <div class="stock-swarm-source">
      <label>
        <input type="radio" value="stub" v-model="source" @change="reload" />
        stub
      </label>
      <label>
        <input type="radio" value="real" v-model="source" @change="reload" />
        real (yfinance)
      </label>
      <span v-if="sourceLabel" class="source-label">{{ sourceLabel }}</span>
      <span class="source-sep" />
      <label title="Show AR(1) forecast ghost nodes (expected position {{ horizon }} bars ahead)">
        <input type="checkbox" v-model="predict" @change="onPredictToggle" />
        predict +{{ horizon }}d
      </label>
    </div>

    <div v-if="loaded" class="stock-swarm-controls">
      <button class="ctrl-btn" @click="togglePlay" :title="playing ? 'Pause' : 'Play'">
        {{ playing ? '❙❙' : '▶' }}
      </button>

      <div
        ref="trackRef"
        class="ctrl-track"
        @pointerdown="onTrackPointerDown"
        @pointermove="onTrackHover"
        @pointerleave="hoverPct = -1"
      >
        <div class="track-fill" :style="{ width: cursorPct + '%' }" />

        <div
          v-for="ev in eventMarkers"
          :key="ev.date"
          class="track-event"
          :style="{ left: ev.pct + '%', background: ev.color }"
          :title="ev.date + ' — ' + ev.label"
        />

        <div class="track-thumb" :style="{ left: cursorPct + '%' }" />

        <div
          v-if="hoverPct >= 0"
          class="track-preview"
          :style="{ left: hoverPct + '%' }"
        >
          {{ hoverDate }}
        </div>
      </div>

      <div class="ctrl-dates">
        <span>{{ datesRef[0] }}</span>
        <span class="ctrl-now">{{ currentDate }}</span>
        <span>{{ datesRef[totalDays - 1] }}</span>
      </div>

      <label class="ctrl-speed">
        speed
        <input type="range" min="0.1" max="20" step="0.1" v-model.number="playSpeed" />
        <span>{{ playSpeed.toFixed(1) }}x</span>
      </label>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as THREE from 'three'
import { ar1Fit, correlationEmbedding, leadLagMatrix, seriesStats } from '../utils/swarmMath.js'
import { Delaunay } from 'd3-delaunay'

const canvasRef = ref(null)
const trackRef = ref(null)
const labelLayerRef = ref(null)
const hoverPct = ref(-1)
const loaded = ref(false)
const loadError = ref('')
const cursor = ref(0)
const totalDays = ref(0)
const tickerCount = ref(0)
const datesRef = ref([])
const playing = ref(true)
const playSpeed = ref(1.2)
// Auto-select "real" when a backend is configured at build time.
const defaultSource = (import.meta.env.VITE_API_BASE_URL || '').trim() ? 'real' : 'stub'
const source = ref(defaultSource)
const sourceLabel = ref('')
const activeEvent = ref(null)
const wind = ref(0)   // smoothed breadth in [-1, +1]
const predict = ref(false)
const horizon = ref(20)

const windFillPct = computed(() => Math.min(100, Math.abs(wind.value) * 100))
const windLabel = computed(() => (wind.value >= 0 ? '+' : '−') + Math.abs(wind.value).toFixed(2))
const windHudStyle = computed(() => ({
  '--wind-color': wind.value >= 0 ? '#50fa7b' : '#ff5555',
}))

const currentDate = computed(() => datesRef.value[cursor.value] ?? '')

function togglePlay() {
  playing.value = !playing.value
}

const cursorPct = computed(() =>
  totalDays.value > 1 ? (cursor.value / (totalDays.value - 1)) * 100 : 0
)
const hoverDate = computed(() => {
  if (hoverPct.value < 0 || totalDays.value === 0) return ''
  const idx = Math.round((hoverPct.value / 100) * (totalDays.value - 1))
  return datesRef.value[idx] ?? ''
})
const eventMarkers = computed(() => {
  if (totalDays.value < 2) return []
  return events.map(e => ({
    date: e.date,
    label: e.label,
    color: e.color,
    pct: (e.dayIndex / (totalDays.value - 1)) * 100,
  }))
})

function pctFromPointer(evt) {
  const el = trackRef.value
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  const x = (evt.clientX - rect.left) / rect.width
  return Math.max(0, Math.min(1, x)) * 100
}

function onTrackHover(evt) {
  hoverPct.value = pctFromPointer(evt)
}

function onTrackPointerDown(evt) {
  const el = trackRef.value
  if (!el) return
  el.setPointerCapture?.(evt.pointerId)
  const wasPlaying = playing.value
  playing.value = false

  const drag = ev => {
    const pct = pctFromPointer(ev)
    const idx = Math.round((pct / 100) * (totalDays.value - 1))
    jumpCursor(idx)
    hoverPct.value = pct
  }
  const up = ev => {
    el.removeEventListener('pointermove', drag)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    el.releasePointerCapture?.(ev.pointerId)
    playing.value = wasPlaying
  }
  el.addEventListener('pointermove', drag)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  drag(evt)
}

function onKeydown(evt) {
  if (!loaded.value) return
  const tag = document.activeElement?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  const step = evt.shiftKey ? 20 : 1
  if (evt.key === 'ArrowRight') {
    jumpCursor(cursor.value + step); evt.preventDefault()
  } else if (evt.key === 'ArrowLeft') {
    jumpCursor(cursor.value - step); evt.preventDefault()
  } else if (evt.key === ' ') {
    togglePlay(); evt.preventDefault()
  } else if (evt.key === 'Home') {
    jumpCursor(0); evt.preventDefault()
  } else if (evt.key === 'End') {
    jumpCursor(totalDays.value - 1); evt.preventDefault()
  }
}

// Visual config
const TRAIL_LEN = 80            // samples of history visible as the wave's trail
const GRID_COLS = 10
const GRID_ROWS = 5
const COL_SPACING = 14
const ROW_SPACING = 14
const LAYOUT_SPAN = 140          // width/depth of the correlation embedding
const LAYOUT_EASE = 0.04         // per-frame lerp toward target XZ (0..1)
const Y_SCALE = 6               // visual amplitude per normalized stdev
const BLANKET_SIZE = 200         // world units covered by the water surface
const BLANKET_SEGMENTS = 72      // per-axis plane subdivision
const BLANKET_SIGMA = 13.0       // gaussian falloff in world units
const BLANKET_Y_SCALE = 0.92     // how tall the blanket ripples relative to node Y
const NODE_COUNT = 104           // anchors (4) + primaries (100) — tier 0 + tier 1
const GROUP_COLORS = {
  'anchor':        0xffffff,
  'tech-mega':     0x6fd6ff,
  'semis':         0xffb86c,
  'software':      0x7dd3fc,
  'media':         0xff79c6,
  'banks':         0xffd166,
  'insurance':     0xfde68a,
  'payments':      0xfacc15,
  'assetmgr':      0xe4a11b,
  'pharma':        0x50fa7b,
  'health-svc':    0x4ade80,
  'medtech':       0x86efac,
  'energy':        0xff5555,
  'staples':       0xfca5a5,
  'discretionary': 0xf472b6,
  'transport':     0xffa24c,
  'industrials':   0xa3a3a3,
  'materials':     0xb45309,
  'telecom':       0xa78bfa,
  'utilities':     0x38bdf8,
  'reits':         0x8be9fd,
  'gold':          0xf1fa8c,
  'tobacco':       0xc084fc,
}
// Keep TIER_COLORS around as a fallback (tier-2 substocks use a tier gray).
const TIER_COLORS = {
  1: 0x6fd6ff, 2: 0xa0f0ff, 3: 0xffb86c, 4: 0xff79c6,
  5: 0xffd166, 6: 0xff5555, 7: 0xffa24c, 8: 0x50fa7b,
  9: 0x8be9fd, 10: 0xbd93f9, 11: 0xf1fa8c,
}

let renderer = null
let scene = null
let camera = null
let rafId = null
let resizeObserver = null
let lastT = 0
let nodes = []       // { symbol, tier, mesh, trail, trailPositions, normSeries, x, z, targetX, targetZ }
let nodeBySymbol = new Map()
let events = []      // [{ date, dayIndex, label, color, magnitude, tickers, rings: [Mesh] }]
const EVENT_WINDOW_DAYS = 18   // how many bars on each side of the event show rings
const RING_MAX_RADIUS = 12

let blanket = null          // { mesh, uniforms, nodeVecs }
let edgeMesh = null         // LineSegments connecting neighboring tickers
let edgePairs = []          // Array<[nodeIdxA, nodeIdxB]>
let cursorF = 0             // fractional bar position (smooth)
let lastBarIdx = 0          // last integer bar the trails saw

let breadthSeries = null     // Float32Array: per-day breadth in [-1, +1]
let windField = null         // { points, positions, colors, velocities }
const WIND_PARTICLES = 260
const WIND_BOUNDS = 150       // half-extent of the wind box
const WIND_Y_MIN = 18
const WIND_Y_MAX = 34

function handleResize() {
  if (!renderer || !camera || !canvasRef.value) return
  const parent = canvasRef.value.parentElement
  const width = parent.clientWidth
  const height = parent.clientHeight
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

function normalizeZScore(series) {
  const n = series.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += series[i]
  mean /= n
  let varSum = 0
  for (let i = 0; i < n; i++) {
    const d = series[i] - mean
    varSum += d * d
  }
  const std = Math.sqrt(varSum / n) || 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const z = (series[i] - mean) / std
    out[i] = Math.max(-3, Math.min(3, z))
  }
  return out
}

function buildScene(payload) {
  datesRef.value = payload.dates
  totalDays.value = payload.dates.length
  tickerCount.value = payload.tickers.length

  const originX = -((GRID_COLS - 1) * COL_SPACING) / 2
  const originZ = -((GRID_ROWS - 1) * ROW_SPACING) / 2

  // Restrict the current render to tier 0 (anchors) + tier 1 (primaries)
  // only — tier-2 children render in a later pass. Accept legacy stubs
  // that predate tier=0/1/2 (treat undefined tier as tier 1).
  const primaryTickers = payload.tickers.filter(t => (t.tier ?? 1) <= 1)

  // Compute correlation matrix once, then a 2D embedding via PCA.
  const symbols = primaryTickers.map(t => t.symbol)
  // Lead-lag similarity: for each pair we keep the max-|corr| over ±5-day
  // shifts, sign preserved. Nodes that lead, follow, or inversely follow
  // each other all end up near each other; strength governs distance.
  const simMatrix = leadLagMatrix(symbols, payload.prices, 5)
  const embedding = correlationEmbedding(simMatrix, LAYOUT_SPAN)

  // Market breadth per day: 2 * fraction-positive - 1, in [-1, +1].
  breadthSeries = computeBreadth(symbols, payload.prices, payload.dates.length)

  primaryTickers.forEach((t, idx) => {
    const col = idx % GRID_COLS
    const row = Math.floor(idx / GRID_COLS)
    const gridX = originX + col * COL_SPACING
    const gridZ = originZ + row * ROW_SPACING
    const [targetX, targetZ] = embedding[idx]

    const normSeries = normalizeZScore(payload.prices[t.symbol])
    const color = GROUP_COLORS[t.group] ?? TIER_COLORS[t.tier] ?? 0xffffff
    // Anchors bigger than primaries, primaries bigger than tier-2 children.
    const size = t.tier === 0 ? 2.3 : (t.tier === 1 ? 1.7 : 1.0)

    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 16, 12),
      new THREE.MeshBasicMaterial({ color })
    )
    mesh.position.set(gridX, normSeries[0] * Y_SCALE, gridZ)
    scene.add(mesh)

    const trailPositions = new Float32Array(TRAIL_LEN * 3)
    for (let i = 0; i < TRAIL_LEN; i++) {
      trailPositions[i * 3] = gridX
      trailPositions[i * 3 + 1] = normSeries[0] * Y_SCALE
      trailPositions[i * 3 + 2] = gridZ
    }
    const trailGeom = new THREE.BufferGeometry()
    trailGeom.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3))
    const trailMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 })
    const trail = new THREE.Line(trailGeom, trailMat)
    scene.add(trail)

    // AR(1) parameters on log-returns + price-series stats for z-scoring
    // predicted prices with the same mean/std as the historical series.
    const rawPrices = payload.prices[t.symbol]
    const { phi, drift } = ar1Fit(rawPrices)
    const { mean: priceMean, std: priceStd } = seriesStats(rawPrices)

    // Ghost sphere (hidden unless `predict` is enabled).
    const ghost = new THREE.Mesh(
      new THREE.SphereGeometry(size * 0.85, 12, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32, depthWrite: false }),
    )
    ghost.visible = false
    scene.add(ghost)

    const node = {
      symbol: t.symbol, tier: t.tier, mesh, trail, trailGeom,
      trailPositions, normSeries, rawPrices,
      phi, drift, priceMean, priceStd,
      ghost,
      x: gridX, z: gridZ,
      targetX, targetZ,
    }
    nodes.push(node)
    nodeBySymbol.set(t.symbol, node)
  })
}

function predictY(node, c, H) {
  if (c < 1) return node.normSeries[c] * Y_SCALE
  let r = Math.log(node.rawPrices[c] / node.rawPrices[c - 1])
  let logSum = 0
  for (let h = 0; h < H; h++) {
    r = node.phi * r + node.drift
    logSum += r
  }
  const predPrice = node.rawPrices[c] * Math.exp(logSum)
  let z = (predPrice - node.priceMean) / node.priceStd
  if (z > 3) z = 3; else if (z < -3) z = -3
  return z * Y_SCALE
}

function updateGhosts(c) {
  const visible = predict.value
  const H = horizon.value
  for (const n of nodes) {
    if (!visible) {
      if (n.ghost.visible) n.ghost.visible = false
      continue
    }
    n.ghost.visible = true
    n.ghost.position.set(n.x, predictY(n, c, H), n.z + 2.2)
  }
}

function onPredictToggle() {
  updateGhosts(cursor.value)
}

function computeBreadth(symbols, prices, days) {
  const out = new Float32Array(days)
  // day 0 has no prior bar; leave at 0.
  for (let d = 1; d < days; d++) {
    let pos = 0
    for (const s of symbols) {
      const p = prices[s]
      if (!p || p.length <= d) continue
      if (p[d] > p[d - 1]) pos++
    }
    out[d] = (pos / symbols.length) * 2 - 1
  }
  // Smooth with a short EMA so the wind doesn't jitter every frame.
  const alpha = 0.2
  for (let d = 1; d < days; d++) out[d] = alpha * out[d] + (1 - alpha) * out[d - 1]
  return out
}

// Wind particle field removed — the top HUD already shows breadth;
// particles floating over the scene were visual noise against black.
function buildWindField() {}
function disposeWindField() {}

function updateWind(c) {
  if (!breadthSeries) return
  const raw = breadthSeries[c] ?? 0
  wind.value = wind.value * 0.9 + raw * 0.1
}

// Continuous water surface: plane whose vertex heights are a gaussian-weighted
// sum of every node's current XYZ, computed on the GPU every frame.
function buildBlanket() {
  disposeBlanket()
  const geom = new THREE.PlaneGeometry(
    BLANKET_SIZE, BLANKET_SIZE, BLANKET_SEGMENTS, BLANKET_SEGMENTS
  )
  geom.rotateX(-Math.PI / 2)

  const nodeVecs = []
  for (let i = 0; i < NODE_COUNT; i++) nodeVecs.push(new THREE.Vector3())
  const uniforms = {
    uNodes:   { value: nodeVecs },
    uSigma:   { value: BLANKET_SIGMA },
    uYScale:  { value: BLANKET_Y_SCALE },
    uTime:    { value: 0 },
  }

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      uniform vec3 uNodes[${NODE_COUNT}];
      uniform float uSigma;
      uniform float uYScale;
      varying float vHeight;
      varying vec3 vWorld;

      void main() {
        float y = 0.0;
        float wsum = 0.0;
        float inv2s2 = 1.0 / (2.0 * uSigma * uSigma);
        for (int i = 0; i < ${NODE_COUNT}; i++) {
          vec3 n = uNodes[i];
          float dx = position.x - n.x;
          float dz = position.z - n.z;
          float d2 = dx * dx + dz * dz;
          float w = exp(-d2 * inv2s2);
          y += n.y * w;
          wsum += w;
        }
        y = (wsum > 0.0001) ? (y / wsum) * uYScale : 0.0;
        vHeight = y;
        vec3 p = vec3(position.x, y, position.z);
        vWorld = p;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying float vHeight;
      varying vec3 vWorld;
      uniform float uTime;

      void main() {
        // Heat map: crests are bullish amber, midline is near-black void,
        // troughs are bearish crimson-magenta. The surface is a visible
        // record of where money is pushing and where it is retreating.
        float t = clamp((vHeight + 6.0) / 12.0, 0.0, 1.0);
        vec3 deep = vec3(0.28, 0.03, 0.09);   // trough - crimson
        vec3 calm = vec3(0.02, 0.02, 0.05);   // zero - near black
        vec3 peak = vec3(1.00, 0.70, 0.20);   // crest - amber gold
        vec3 col = (t < 0.5)
          ? mix(deep, calm, smoothstep(0.0, 0.5, t))
          : mix(calm, peak, smoothstep(0.5, 1.0, t));

        // Slightly boost the crest glow so peaks read as hot/luminous.
        float glow = smoothstep(0.7, 1.0, t);
        col += vec3(0.35, 0.20, 0.06) * glow;

        // Edge fade so the plane dissolves at its border.
        float r = length(vec2(vWorld.x, vWorld.z));
        float edge = smoothstep(${(BLANKET_SIZE / 2.4).toFixed(1)}, ${(BLANKET_SIZE / 2).toFixed(1)}, r);
        float alpha = mix(0.42, 0.0, edge);

        gl_FragColor = vec4(col, alpha);
      }
    `,
  })
  const mesh = new THREE.Mesh(geom, mat)
  scene.add(mesh)
  blanket = { mesh, uniforms, nodeVecs }
}

function disposeBlanket() {
  if (!blanket) return
  scene.remove(blanket.mesh)
  blanket.mesh.geometry.dispose()
  blanket.mesh.material.dispose()
  blanket = null
}

function updateBlanket(elapsed) {
  if (!blanket) return
  const vecs = blanket.nodeVecs
  for (let i = 0; i < nodes.length && i < NODE_COUNT; i++) {
    const n = nodes[i]
    vecs[i].set(n.x, n.mesh.position.y, n.z)
  }
  blanket.uniforms.uTime.value = elapsed
}

// Delaunay triangulation of the target-XZ positions gives each node its
// natural planar neighbors — denser where nodes cluster, sparser at the
// edges, and always providing 360° coverage around each node.
function buildEdges() {
  disposeEdges()
  if (nodes.length < 3) return
  const pts = new Float64Array(nodes.length * 2)
  for (let i = 0; i < nodes.length; i++) {
    pts[i * 2] = nodes[i].targetX
    pts[i * 2 + 1] = nodes[i].targetZ
  }
  const delaunay = new Delaunay(pts)
  const seen = new Set()
  edgePairs = []
  const tri = delaunay.triangles
  for (let k = 0; k < tri.length; k += 3) {
    const a = tri[k], b = tri[k + 1], c = tri[k + 2]
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const lo = Math.min(u, v), hi = Math.max(u, v)
      const key = lo * 1024 + hi
      if (!seen.has(key)) { seen.add(key); edgePairs.push([lo, hi]) }
    }
  }

  const positions = new Float32Array(edgePairs.length * 2 * 3)
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const mat = new THREE.LineBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false,
  })
  edgeMesh = new THREE.LineSegments(geom, mat)
  scene.add(edgeMesh)
}

function disposeEdges() {
  if (!edgeMesh) return
  scene.remove(edgeMesh)
  edgeMesh.geometry.dispose()
  edgeMesh.material.dispose()
  edgeMesh = null
  edgePairs = []
}

function updateEdges() {
  if (!edgeMesh) return
  const pos = edgeMesh.geometry.attributes.position.array
  for (let i = 0; i < edgePairs.length; i++) {
    const [a, b] = edgePairs[i]
    const na = nodes[a], nb = nodes[b]
    const o = i * 6
    pos[o]     = na.x
    pos[o + 1] = na.mesh.position.y
    pos[o + 2] = na.z
    pos[o + 3] = nb.x
    pos[o + 4] = nb.mesh.position.y
    pos[o + 5] = nb.z
  }
  edgeMesh.geometry.attributes.position.needsUpdate = true
}

// HTML ticker labels as a DOM overlay. We keep one div per node and
// just update its `transform` every frame with the 3D-to-screen
// projected position. Cheaper than recreating Vue nodes per frame.
function buildLabels() {
  disposeLabels()
  const layer = labelLayerRef.value
  if (!layer) return
  for (const n of nodes) {
    const el = document.createElement('div')
    el.className = 'ss-label'
    el.textContent = n.symbol
    layer.appendChild(el)
    n.labelEl = el
    n.labelPriceEl = null
    n.labelPrevPrice = null
  }
}

function disposeLabels() {
  for (const n of nodes) {
    if (n.labelEl) { n.labelEl.remove(); n.labelEl = null; n.labelPriceEl = null }
  }
  if (labelLayerRef.value) labelLayerRef.value.innerHTML = ''
}

const tmpVec = new THREE.Vector3()
function updateLabels() {
  const canvas = renderer?.domElement
  if (!canvas) return
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  for (const n of nodes) {
    if (!n.labelEl) continue
    tmpVec.set(n.x, n.mesh.position.y, n.z).project(camera)
    if (tmpVec.z > 1) { n.labelEl.style.opacity = '0'; continue }
    const x = (tmpVec.x * 0.5 + 0.5) * w
    const y = (-tmpVec.y * 0.5 + 0.5) * h
    // Centered on the dot's projected position so the label always sits
    // inside the sphere regardless of camera yaw.
    n.labelEl.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`
    n.labelEl.style.opacity = '1'
  }
}

function buildEvents(eventsJson, dates) {
  const dateIndex = new Map(dates.map((d, i) => [d, i]))
  events = []
  for (const ev of eventsJson.events || []) {
    const dayIndex = dateIndex.get(ev.date)
    if (dayIndex === undefined) continue
    const color = new THREE.Color(ev.color || '#6fd6ff')
    const rings = []
    for (const sym of ev.tickers) {
      const node = nodeBySymbol.get(sym)
      if (!node) continue
      const geom = new THREE.RingGeometry(0.1, 0.18, 48)
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
      })
      const mesh = new THREE.Mesh(geom, mat)
      mesh.rotation.x = -Math.PI / 2
      mesh.visible = false
      scene.add(mesh)
      rings.push({ mesh, node })
    }
    events.push({
      date: ev.date, dayIndex,
      label: ev.label,
      color: ev.color || '#6fd6ff',
      magnitude: ev.magnitude ?? 0.7,
      rings,
    })
  }
}

function updateEvents(c) {
  let nearest = null
  let nearestDist = Infinity
  for (const ev of events) {
    const dist = c - ev.dayIndex
    const ad = Math.abs(dist)
    if (ad < nearestDist) { nearestDist = ad; nearest = ev }
    const visible = ad <= EVENT_WINDOW_DAYS
    for (const { mesh, node } of ev.rings) {
      mesh.visible = visible
      if (!visible) continue
      // Rings are born at the event date and expand outward after it; before
      // it, they pulse inward (a "premonition" shimmer). Works either way.
      const t = dist / EVENT_WINDOW_DAYS // [-1..1]
      const phase = Math.max(0, Math.min(1, Math.abs(t)))
      const radius = 0.4 + phase * RING_MAX_RADIUS * ev.magnitude
      const thickness = 0.15 + (1 - phase) * 0.5
      mesh.geometry.dispose()
      mesh.geometry = new THREE.RingGeometry(radius, radius + thickness, 64)
      mesh.material.opacity = (1 - phase) * 0.9 * ev.magnitude
      mesh.position.set(node.x, node.mesh.position.y, node.z)
    }
  }
  activeEvent.value = (nearest && nearestDist <= EVENT_WINDOW_DAYS) ? {
    date: nearest.date, label: nearest.label, color: nearest.color,
  } : null
}

function easeLayout() {
  for (const n of nodes) {
    n.x += (n.targetX - n.x) * LAYOUT_EASE
    n.z += (n.targetZ - n.z) * LAYOUT_EASE
    n.mesh.position.x = n.x
    n.mesh.position.z = n.z
  }
}

function sampleY(series, cf) {
  const n = series.length
  if (n === 0) return 0
  let c = Math.floor(cf)
  if (c < 0) c = 0
  if (c >= n) c = n - 1
  const next = Math.min(c + 1, n - 1)
  const frac = cf - c
  return series[c] + (series[next] - series[c]) * frac
}

// Per-frame tick: smoothly advances each node's Y with fractional-bar
// interpolation and shifts the trail one slot every time we cross an
// integer bar. Between crossings the trail's leading vertex tracks the
// interpolated Y so the wave tip never jitters.
function applySmoothCursor() {
  const cf = cursorF
  const c = Math.floor(cf)
  const crossed = c !== lastBarIdx
  for (const n of nodes) {
    const y = sampleY(n.normSeries, cf) * Y_SCALE
    n.mesh.position.y = y
    const p = n.trailPositions
    const last = (TRAIL_LEN - 1) * 3
    if (crossed) {
      p.copyWithin(0, 3)
    }
    p[last] = n.x
    p[last + 1] = y
    p[last + 2] = n.z
    n.trailGeom.attributes.position.needsUpdate = true
  }
  if (crossed) {
    lastBarIdx = c
    cursor.value = c
    updateEvents(c)
  }
}

// Jumping (scrub) rebuilds the trail from the preceding TRAIL_LEN bars so
// the wave shape looks correct immediately rather than animating in.
function jumpCursor(next) {
  const clamped = Math.max(0, Math.min(totalDays.value - 1, next))
  cursor.value = clamped
  cursorF = clamped
  lastBarIdx = clamped
  const c = clamped
  for (const n of nodes) {
    const y = n.normSeries[c] * Y_SCALE
    n.mesh.position.y = y
    const p = n.trailPositions
    for (let i = 0; i < TRAIL_LEN; i++) {
      const srcIdx = Math.max(0, c - (TRAIL_LEN - 1 - i))
      const yi = n.normSeries[srcIdx] * Y_SCALE
      p[i * 3] = n.x
      p[i * 3 + 1] = yi
      p[i * 3 + 2] = n.z
    }
    n.trailGeom.attributes.position.needsUpdate = true
  }
  updateEvents(c)
}

function animate(t) {
  rafId = requestAnimationFrame(animate)
  if (!lastT) lastT = t
  const dt = (t - lastT) / 1000
  lastT = t

  easeLayout()

  if (playing.value && totalDays.value > 0) {
    cursorF += dt * playSpeed.value
    // wrap
    const total = totalDays.value
    if (cursorF >= total) cursorF -= total
    if (cursorF < 0) cursorF += total
  }

  if (loaded.value) applySmoothCursor()
  updateEdges()
  updateBlanket(t * 0.001)
  updateWind(cursor.value)
  if (predict.value) updateGhosts(cursor.value)
  if (loaded.value) updateLabels()

  // Slow camera yaw for god's-eye feel
  const camR = 110
  const camY = 55
  const theta = t * 0.00006
  camera.position.x = Math.sin(theta) * camR
  camera.position.z = Math.cos(theta) * camR
  camera.position.y = camY
  camera.lookAt(0, 0, 0)

  renderer.render(scene, camera)
}

async function fetchStub() {
  const res = await fetch('/stock-swarm/stub.json', { cache: 'force-cache' })
  if (!res.ok) throw new Error(`stub HTTP ${res.status}`)
  const p = await res.json()
  p.source = 'stub'
  return p
}

async function fetchReal() {
  // Backend may be missing (frontend-only Vercel deploy), return a stub-fallback;
  // may also redirect us back to the stub if yfinance isn't available.
  let reason = null
  let payload = null
  try {
    const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')
    const res = await fetch(`${apiBase}/api/stock-swarm/prices?period=2y`)
    if (!res.ok) {
      reason = `api_http_${res.status}`
    } else {
      payload = await res.json()
      if (payload.source === 'stub' || !payload.prices) {
        reason = payload.fallback_reason || 'no-data'
        payload = null
      }
    }
  } catch (e) {
    reason = 'api_unreachable'
  }
  if (payload) return payload
  const stub = await fetchStub()
  stub.source = `stub (fallback: ${reason || 'unknown'})`
  return stub
}

function clearScene() {
  for (const n of nodes) {
    scene.remove(n.mesh); scene.remove(n.trail); scene.remove(n.ghost)
    n.mesh.geometry.dispose(); n.mesh.material.dispose()
    n.trailGeom.dispose(); n.trail.material.dispose()
    n.ghost.geometry.dispose(); n.ghost.material.dispose()
  }
  nodes = []
  nodeBySymbol = new Map()
  for (const ev of events) {
    for (const { mesh } of ev.rings) {
      scene.remove(mesh)
      mesh.geometry.dispose(); mesh.material.dispose()
    }
  }
  events = []
  activeEvent.value = null
  disposeWindField()
  disposeBlanket()
  disposeEdges()
  disposeLabels()
  breadthSeries = null
}

async function loadEvents() {
  try {
    const res = await fetch('/stock-swarm/events.json', { cache: 'force-cache' })
    if (!res.ok) return { events: [] }
    return await res.json()
  } catch {
    return { events: [] }
  }
}

async function loadData() {
  try {
    loaded.value = false
    loadError.value = ''
    clearScene()
    const [payload, eventsJson] = await Promise.all([
      source.value === 'real' ? fetchReal() : fetchStub(),
      loadEvents(),
    ])
    buildScene(payload)
    buildEdges()
    buildBlanket()
    buildWindField()
    buildEvents(eventsJson, payload.dates)
    buildLabels()
    sourceLabel.value = payload.source || source.value
    cursor.value = 0
    cursorF = 0
    lastBarIdx = 0
    loaded.value = true
  } catch (e) {
    loadError.value = `Failed to load data: ${e.message}`
  }
}

function reload() {
  loadData()
}

onMounted(async () => {
  const canvas = canvasRef.value
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x000000, 1)

  scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x000000, 140, 260)
  camera = new THREE.PerspectiveCamera(52, 1, 0.1, 2000)
  camera.position.set(0, 52, 115)
  camera.lookAt(0, 0, 0)

  handleResize()
  resizeObserver = new ResizeObserver(handleResize)
  resizeObserver.observe(canvas.parentElement)

  window.addEventListener('keydown', onKeydown)

  await loadData()
  animate(0)
})

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
  if (resizeObserver) resizeObserver.disconnect()
  window.removeEventListener('keydown', onKeydown)
  clearScene()
  if (renderer) renderer.dispose()
})
</script>

<style scoped>
.stock-swarm-root {
  position: fixed;
  inset: 0;
  background: #000;
  overflow: hidden;
}
.stock-swarm-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.stock-swarm-hud {
  position: absolute;
  top: 16px;
  left: 20px;
  color: #9fd2ff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  pointer-events: none;
  text-shadow: 0 0 8px rgba(0, 0, 0, 0.8);
}
.hud-title {
  font-size: 14px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  opacity: 0.9;
}
.hud-sub {
  font-size: 11px;
  opacity: 0.7;
  margin-top: 2px;
}
.stock-swarm-labels {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}
.ss-label {
  position: absolute;
  top: 0;
  left: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 8px;
  font-weight: 800;
  letter-spacing: 0.02em;
  line-height: 1;
  color: #39ff14;
  white-space: nowrap;
  transform: translate(-9999px, -9999px);
  pointer-events: none;
  will-change: transform;
  text-shadow:
    0 0 1px #000,
    0 0 3px rgba(0, 0, 0, 0.95),
    0 0 6px #39ff14;
}
.stock-swarm-error {
  position: absolute;
  bottom: 20px;
  left: 20px;
  color: #ff6b6b;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.6);
  padding: 6px 10px;
  border-radius: 4px;
}
.stock-swarm-controls {
  position: absolute;
  left: 20px;
  right: 20px;
  bottom: 18px;
  display: grid;
  grid-template-columns: auto 1fr auto;
  grid-template-rows: auto auto;
  column-gap: 12px;
  row-gap: 6px;
  align-items: center;
  padding: 10px 14px;
  background: rgba(5, 8, 15, 0.72);
  border: 1px solid rgba(111, 214, 255, 0.18);
  border-radius: 6px;
  color: #9fd2ff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  backdrop-filter: blur(4px);
}
.ctrl-btn {
  grid-row: 1 / span 2;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  border: 1px solid rgba(111, 214, 255, 0.4);
  background: rgba(111, 214, 255, 0.08);
  color: #9fd2ff;
  font-size: 14px;
  cursor: pointer;
}
.ctrl-btn:hover { background: rgba(111, 214, 255, 0.18); }
.ctrl-track {
  position: relative;
  height: 28px;
  width: 100%;
  cursor: pointer;
  touch-action: none;
  user-select: none;
  background: linear-gradient(90deg, rgba(111, 214, 255, 0.08), rgba(111, 214, 255, 0.02));
  border: 1px solid rgba(111, 214, 255, 0.2);
  border-radius: 4px;
}
.track-fill {
  position: absolute;
  top: 0; left: 0; bottom: 0;
  background: linear-gradient(90deg, rgba(111, 214, 255, 0.18), rgba(111, 214, 255, 0.35));
  pointer-events: none;
}
.track-event {
  position: absolute;
  top: 4px; bottom: 4px;
  width: 2px;
  margin-left: -1px;
  opacity: 0.85;
  box-shadow: 0 0 6px currentColor;
  pointer-events: auto;
  cursor: help;
}
.track-thumb {
  position: absolute;
  top: -3px; bottom: -3px;
  width: 3px;
  margin-left: -1.5px;
  background: #a0f0ff;
  border-radius: 2px;
  box-shadow: 0 0 10px #6fd6ff, 0 0 2px #fff;
  pointer-events: none;
}
.track-preview {
  position: absolute;
  bottom: calc(100% + 4px);
  transform: translateX(-50%);
  padding: 2px 6px;
  background: rgba(5, 8, 15, 0.92);
  color: #a0f0ff;
  font-size: 10px;
  border: 1px solid rgba(111, 214, 255, 0.3);
  border-radius: 3px;
  pointer-events: none;
  white-space: nowrap;
}
.ctrl-dates {
  display: flex;
  justify-content: space-between;
  opacity: 0.7;
  font-size: 10px;
}
.ctrl-now {
  color: #a0f0ff;
  opacity: 1;
}
.ctrl-speed {
  grid-row: 1 / span 2;
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0.85;
  white-space: nowrap;
}
.ctrl-speed input {
  width: 90px;
  accent-color: #6fd6ff;
}
.stock-swarm-source {
  position: absolute;
  top: 16px;
  right: 20px;
  color: #9fd2ff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(5, 8, 15, 0.55);
  padding: 6px 10px;
  border: 1px solid rgba(111, 214, 255, 0.18);
  border-radius: 4px;
}
.stock-swarm-source label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.source-label {
  opacity: 0.6;
  font-size: 10px;
}
.source-sep {
  display: inline-block;
  width: 1px;
  height: 14px;
  background: rgba(111, 214, 255, 0.25);
}
.stock-swarm-event {
  position: absolute;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  color: #fff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  padding: 6px 12px;
  background: rgba(5, 8, 15, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 10px;
  pointer-events: none;
  backdrop-filter: blur(4px);
}
.evt-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-shadow: 0 0 12px currentColor;
}
.evt-date {
  opacity: 0.7;
  font-size: 11px;
}
.evt-label {
  color: #fff;
  letter-spacing: 0.03em;
}
.stock-swarm-wind {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  color: #9fd2ff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: rgba(5, 8, 15, 0.55);
  border: 1px solid rgba(111, 214, 255, 0.18);
  border-radius: 4px;
  pointer-events: none;
}
.wind-bar {
  position: relative;
  display: inline-block;
  width: 140px;
  height: 6px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 3px;
  overflow: hidden;
}
.wind-fill {
  position: absolute;
  top: 0; bottom: 0;
  left: 50%;
  width: 0;
  background: var(--wind-color);
  transform: translateX(0);
  transition: width 0.2s linear, background 0.2s linear;
  box-shadow: 0 0 8px var(--wind-color);
}
/* Negative wind shows on the left half of the bar */
.stock-swarm-wind .wind-fill {
  transform-origin: left;
}
.stock-swarm-wind[data-wind-sign="neg"] .wind-fill {
  left: auto;
  right: 50%;
}
.wind-val {
  color: var(--wind-color);
  min-width: 44px;
  text-align: right;
}
</style>
