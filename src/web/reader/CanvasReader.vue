<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { paginate } from '../../core/reader/paginate'

const props = withDefaults(
  defineProps<{
    text: string
    title?: string
    fontSize?: number
    lineHeight?: number
  }>(),
  { title: '', fontSize: 19, lineHeight: 1.8 },
)

const canvasRef = ref<HTMLCanvasElement | null>(null)
const pages = ref<string[][]>([['']])
const page = ref(0)
const total = computed(() => pages.value.length)

let ctx: CanvasRenderingContext2D | null = null
let observer: ResizeObserver | null = null
let dpr = 1

function measureFont() {
  return `${props.fontSize}px 'Noto Serif SC', 'Songti SC', 'Noto Sans SC', serif`
}

function layout() {
  const canvas = canvasRef.value
  const host = canvas?.parentElement
  if (!canvas || !host || !ctx) return
  const rect = host.getBoundingClientRect()
  if (!rect.width || !rect.height) return

  dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(rect.width * dpr)
  canvas.height = Math.round(rect.height * dpr)
  canvas.style.width = `${rect.width}px`
  canvas.style.height = `${rect.height}px`
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.font = measureFont()

  const result = paginate(props.text, {
    width: rect.width,
    height: rect.height,
    fontSize: props.fontSize,
    lineHeight: props.fontSize * props.lineHeight,
    measure: (value) => ctx?.measureText(value).width ?? 0,
  })
  pages.value = result.pages
  page.value = Math.min(page.value, result.pages.length - 1)
  render()
}

function render() {
  const canvas = canvasRef.value
  if (!canvas || !ctx) return
  const width = canvas.width / dpr
  const height = canvas.height / dpr
  ctx.clearRect(0, 0, width, height)

  const color = getComputedStyle(canvas).color || '#24292f'
  ctx.fillStyle = color
  ctx.textBaseline = 'top'
  ctx.font = measureFont()

  const padding = 24
  const lineHeight = props.fontSize * props.lineHeight
  const title = props.title ?? ''
  if (title) {
    ctx.font = `${props.fontSize - 3}px 'Noto Serif SC', 'Songti SC', serif`
    ctx.textAlign = 'center'
    ctx.fillText(title, width / 2, padding, width - padding * 2)
  }
  ctx.textAlign = 'left'
  ctx.font = measureFont()

  const lines = pages.value[page.value] ?? []
  let y = padding + 36
  for (const line of lines) {
    if (line) ctx.fillText(line, padding, y)
    y += lineHeight
  }

  ctx.font = `${props.fontSize - 5}px -apple-system, sans-serif`
  ctx.fillStyle = color
  ctx.globalAlpha = 0.55
  ctx.textAlign = 'right'
  ctx.fillText(`${page.value + 1} / ${pages.value.length}`, width - padding, height - padding)
  ctx.globalAlpha = 1
  ctx.textAlign = 'left'
}

function next() {
  if (page.value < pages.value.length - 1) {
    page.value += 1
    render()
  }
}

function prev() {
  if (page.value > 0) {
    page.value -= 1
    render()
  }
}

function onCanvasClick(event: MouseEvent) {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const ratio = (event.clientX - rect.left) / rect.width
  if (ratio < 0.33) prev()
  else if (ratio > 0.67) next()
  else next()
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
    event.preventDefault()
    next()
  } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    event.preventDefault()
    prev()
  }
}

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return
  ctx = canvas.getContext('2d')
  layout()
  observer = new ResizeObserver(() => layout())
  if (canvas.parentElement) observer.observe(canvas.parentElement)
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('keydown', onKey)
})

watch(
  () => [props.text, props.title, props.fontSize, props.lineHeight],
  () => {
    page.value = 0
    layout()
  },
)
</script>

<template>
  <div class="mo-canvas-host" data-testid="canvas-reader">
    <canvas ref="canvasRef" class="mo-canvas" @click="onCanvasClick" />
  </div>
</template>

<style>
.mo-canvas-host {
  position: relative;
  width: 100%;
  height: calc(100dvh - 280px);
  min-height: 360px;
}
.mo-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: pointer;
}
</style>
