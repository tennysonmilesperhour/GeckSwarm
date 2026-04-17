<template>
  <div class="stock-swarm-root">
    <canvas ref="canvasRef" class="stock-swarm-canvas" />
    <div class="stock-swarm-hud">
      <div class="hud-title">Stock Swarm · Wave Field</div>
      <div class="hud-sub">scaffold v0 — blank canvas</div>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as THREE from 'three'

const canvasRef = ref(null)

let renderer = null
let scene = null
let camera = null
let rafId = null
let resizeObserver = null

function handleResize() {
  if (!renderer || !camera || !canvasRef.value) return
  const parent = canvasRef.value.parentElement
  const width = parent.clientWidth
  const height = parent.clientHeight
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

function animate() {
  rafId = requestAnimationFrame(animate)
  renderer.render(scene, camera)
}

onMounted(() => {
  const canvas = canvasRef.value
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x05080f, 1)

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000)
  camera.position.set(0, 0, 120)

  handleResize()
  resizeObserver = new ResizeObserver(handleResize)
  resizeObserver.observe(canvas.parentElement)

  animate()
})

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
  if (resizeObserver) resizeObserver.disconnect()
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
  opacity: 0.55;
  margin-top: 2px;
}
</style>
