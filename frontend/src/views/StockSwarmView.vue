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
import { correlationEmbedding, correlationMatrix } from '../utils/swarmMath.js'

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

    nodes.push({
      symbol: t.symbol, tier: t.tier, mesh, trail, trailGeom,
      trailPositions, normSeries,
      x: gridX, z: gridZ,
      targetX, targetZ,
    })
  })
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
}

function animate(t) {
  rafId = requestAnimationFrame(animate)
  if (!lastT) lastT = t
  const dt = (t - lastT) / 1000
  lastT = t

  easeLayout()

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
    scene.remove(n.mesh); scene.remove(n.trail)
    n.mesh.geometry.dispose(); n.mesh.material.dispose()
    n.trailGeom.dispose(); n.trail.material.dispose()
  }
  nodes = []
}

async function loadData() {
  try {
    loaded.value = false
    loadError.value = ''
    clearScene()
    const payload = source.value === 'real' ? await fetchReal() : await fetchStub()
    buildScene(payload)
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
  for (const n of nodes) {
    n.mesh.geometry.dispose()
    n.mesh.material.dispose()
    n.trailGeom.dispose()
    n.trail.material.dispose()
  }
  nodes = []
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
</style>
