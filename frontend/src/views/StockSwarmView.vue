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
      <button class="ctrl-btn" @click="togglePlay">
        {{ playing ? '❙❙' : '▶' }}
      </button>
      <input
        class="ctrl-scrub"
        type="range"
        :min="0"
        :max="totalDays - 1"
        :value="cursor"
        @input="onScrub"
      />
      <div class="ctrl-dates">
        <span>{{ datesRef[0] }}</span>
        <span class="ctrl-now">{{ currentDate }}</span>
        <span>{{ datesRef[totalDays - 1] }}</span>
      </div>
      <label class="ctrl-speed">
        speed
        <input type="range" min="0.1" max="10" step="0.1" v-model.number="playSpeed" />
        <span>{{ playSpeed.toFixed(1) }}x</span>
      </label>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as THREE from 'three'
import { ar1Fit, correlationEmbedding, correlationMatrix, seriesStats } from '../utils/swarmMath.js'

const canvasRef = ref(null)
const loaded = ref(false)
const loadError = ref('')
const cursor = ref(0)
const totalDays = ref(0)
const tickerCount = ref(0)
const datesRef = ref([])
const playing = ref(true)
const playSpeed = ref(1.2)
const source = ref('stub')
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

function onScrub(ev) {
  const next = parseInt(ev.target.value, 10)
  jumpCursor(next)
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

  // Compute correlation matrix once, then a 2D embedding via PCA.
  const symbols = payload.tickers.map(t => t.symbol)
  const corr = correlationMatrix(symbols, payload.prices)
  const embedding = correlationEmbedding(corr, LAYOUT_SPAN)

  // Market breadth per day: 2 * fraction-positive - 1, in [-1, +1].
  breadthSeries = computeBreadth(symbols, payload.prices, payload.dates.length)

  payload.tickers.forEach((t, idx) => {
    const col = idx % GRID_COLS
    const row = Math.floor(idx / GRID_COLS)
    const gridX = originX + col * COL_SPACING
    const gridZ = originZ + row * ROW_SPACING
    const [targetX, targetZ] = embedding[idx]

    const normSeries = normalizeZScore(payload.prices[t.symbol])
    const color = TIER_COLORS[t.tier] ?? 0xffffff
    // Tier scales node size: mega-caps and anchors read as "larger waves".
    const size = 1.4 - Math.min(0.8, (t.tier - 1) * 0.06)

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

function buildWindField() {
  disposeWindField()
  const positions = new Float32Array(WIND_PARTICLES * 3)
  const colors = new Float32Array(WIND_PARTICLES * 3)
  const velocities = new Float32Array(WIND_PARTICLES)
  for (let i = 0; i < WIND_PARTICLES; i++) {
    positions[i * 3]     = (Math.random() * 2 - 1) * WIND_BOUNDS
    positions[i * 3 + 1] = WIND_Y_MIN + Math.random() * (WIND_Y_MAX - WIND_Y_MIN)
    positions[i * 3 + 2] = (Math.random() * 2 - 1) * WIND_BOUNDS
    velocities[i] = 0.6 + Math.random() * 0.8
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({
    size: 0.9, vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false,
  })
  const points = new THREE.Points(geom, mat)
  scene.add(points)
  windField = { points, positions, colors, velocities, geom, mat }
}

function disposeWindField() {
  if (!windField) return
  scene.remove(windField.points)
  windField.geom.dispose()
  windField.mat.dispose()
  windField = null
}

function updateWind(c, dt) {
  if (!breadthSeries || !windField) return
  const raw = breadthSeries[c] ?? 0
  // One more pass of smoothing against the reactive value so the HUD also eases.
  wind.value = wind.value * 0.9 + raw * 0.1
  const w = wind.value
  const speedScale = 22  // units per second at |w|=1
  const { positions, colors, velocities } = windField
  const gR = w < 0 ? 1 : (1 - w) * 0.3 + 0.1
  const gG = w > 0 ? 1 : (1 + w) * 0.3 + 0.1
  const gB = 0.25
  for (let i = 0; i < WIND_PARTICLES; i++) {
    const dx = w * velocities[i] * speedScale * dt
    let nx = positions[i * 3] + dx
    if (nx > WIND_BOUNDS) nx -= WIND_BOUNDS * 2
    else if (nx < -WIND_BOUNDS) nx += WIND_BOUNDS * 2
    positions[i * 3] = nx

    colors[i * 3]     = gR
    colors[i * 3 + 1] = gG
    colors[i * 3 + 2] = gB
  }
  windField.geom.attributes.position.needsUpdate = true
  windField.geom.attributes.color.needsUpdate = true
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

function applyCursor(c) {
  for (const n of nodes) {
    const y = n.normSeries[c] * Y_SCALE
    n.mesh.position.y = y

    const p = n.trailPositions
    p.copyWithin(0, 3)
    const last = (TRAIL_LEN - 1) * 3
    p[last] = n.x
    p[last + 1] = y
    p[last + 2] = n.z
    n.trailGeom.attributes.position.needsUpdate = true
  }
  updateEvents(c)
}

function updateCursor(delta) {
  cursor.value = (cursor.value + delta) % totalDays.value
  if (cursor.value < 0) cursor.value += totalDays.value
  applyCursor(cursor.value)
}

// Jumping (scrub) rebuilds the trail from the preceding TRAIL_LEN bars so
// the wave shape looks correct immediately rather than animating in.
function jumpCursor(next) {
  cursor.value = Math.max(0, Math.min(totalDays.value - 1, next))
  const c = cursor.value
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
  updateWind(cursor.value, dt)
  if (predict.value) updateGhosts(cursor.value)

  if (playing.value) {
    animate._acc = (animate._acc ?? 0) + dt * playSpeed.value
    while (animate._acc >= 1) {
      updateCursor(1)
      animate._acc -= 1
    }
  } else {
    animate._acc = 0
  }

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
  // Backend may redirect us back to the stub if yfinance isn't available;
  // in that case we fetch the stub ourselves and mark the source accordingly.
  const res = await fetch('/api/stock-swarm/prices?period=2y')
  if (!res.ok) throw new Error(`api HTTP ${res.status}`)
  const p = await res.json()
  if (p.source === 'stub' || !p.prices) {
    const stub = await fetchStub()
    stub.source = 'stub (fallback: ' + (p.fallback_reason || 'no-data') + ')'
    return stub
  }
  return p
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
    buildWindField()
    buildEvents(eventsJson, payload.dates)
    sourceLabel.value = payload.source || source.value
    cursor.value = 0
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
  renderer.setClearColor(0x05080f, 1)

  scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x05080f, 120, 260)
  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000)
  camera.position.set(0, 55, 110)
  camera.lookAt(0, 0, 0)

  // Subtle reference grid on the seafloor plane for scale.
  const grid = new THREE.GridHelper(200, 20, 0x0a2340, 0x0a1628)
  grid.position.y = -22
  scene.add(grid)

  handleResize()
  resizeObserver = new ResizeObserver(handleResize)
  resizeObserver.observe(canvas.parentElement)

  await loadData()
  animate(0)
})

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
  if (resizeObserver) resizeObserver.disconnect()
  clearScene()
  if (renderer) renderer.dispose()
})
</script>

<style scoped>
.stock-swarm-root {
  position: fixed;
  inset: 0;
  background: #05080f;
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
.ctrl-scrub {
  width: 100%;
  accent-color: #6fd6ff;
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
