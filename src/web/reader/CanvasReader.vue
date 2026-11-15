<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { paginate } from '../../core/reader/paginate'

type Theme = 'light' | 'sepia' | 'dark'
type Turn = 'none' | 'cover' | 'slide'

const props = withDefaults(
  defineProps<{
    text: string
    title?: string
    fontSize?: number
    lineHeight?: number
    initialPage?: number
    theme?: Theme
    animation?: Turn
  }>(),
  { title: '', fontSize: 22, lineHeight: 1.9, initialPage: 0, theme: 'light', animation: 'cover' },
)

const emit = defineEmits<{
  page: [payload: { page: number; total: number }]
  centerTap: []
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const pages = ref<string[][]>([['']])
const page = ref(0)
const total = computed(() => pages.value.length)

let ctx: CanvasRenderingContext2D | null = null
let observer: ResizeObserver | null = null
let dpr = 1
let width = 0
let height = 0
let animating = false

const SERIF = "'Noto Serif SC', 'Songti SC', 'Noto Sans SC', serif"

const palette = computed(() => {
  if (props.theme === 'dark') {
    return { bg: '#141518', text: '#d8d4c8', muted: '#8f897b', line: 'rgba(255,255,255,0.14)' }
  }
  if (props.theme === 'sepia') {
    return { bg: '#f1e5c9', text: '#4a3b28', muted: '#8a7657', line: 'rgba(74,59,40,0.2)' }
  }
  return { bg: '#f6f1e7', text: '#2b2a26', muted: '#7c7567', line: 'rgba(43,42,38,0.14)' }
})

const ACCENT = '#3d6b53'

function measureFont() {
  return `${props.fontSize}px ${SERIF}`
}

function paddingX() {
  return Math.max(22, Math.round(width * 0.055))
}

function layout() {
  const canvas = canvasRef.value
  const host = canvas?.parentElement
  if (!canvas || !host || !ctx) return
  const rect = host.getBoundingClientRect()
  if (!rect.width || !rect.height) return

  dpr = Math.min(window.devicePixelRatio || 1, 2)
  width = rect.width
  height = rect.height
  canvas.width = Math.round(rect.width * dpr)
  canvas.height = Math.round(rect.height * dpr)
  canvas.style.width = `${rect.width}px`
  canvas.style.height = `${rect.height}px`
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.font = measureFont()

  const result = paginate(props.text, {
    width: rect.width - paddingX() * 2,
    height: rect.height - 118,
    fontSize: props.fontSize,
    lineHeight: props.fontSize * props.lineHeight,
    measure: (value) => ctx?.measureText(value).width ?? 0,
  })
  pages.value = result.pages
  page.value = Math.min(page.value, result.pages.length - 1)
  render()
}

function fillBackground() {
  const canvas = canvasRef.value
  if (!canvas || !ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = palette.value.bg
  ctx.fillRect(0, 0, width, height)
}

function render() {
  const canvas = canvasRef.value
  if (!canvas || !ctx) return
  fillBackground()
  const { text: color, muted, line } = palette.value
  const pad = paddingX()
  const lineHeight = props.fontSize * props.lineHeight

  // 页眉：章名 + 细分隔线
  ctx.fillStyle = muted
  ctx.font = `${Math.max(11, props.fontSize - 9)}px ${SERIF}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const header = props.title.length > 24 ? `${props.title.slice(0, 24)}…` : props.title
  ctx.fillText(header, width / 2, 20, width - pad * 2)
  ctx.strokeStyle = line
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(pad, 46)
  ctx.lineTo(width - pad, 46)
  ctx.stroke()

  // 正文
  ctx.fillStyle = color
  ctx.textAlign = 'left'
  ctx.font = measureFont()
  const lines = pages.value[page.value] ?? []
  let y = 66
  for (const value of lines) {
    if (value) ctx.fillText(value, pad, y)
    y += lineHeight
  }

  // 页脚：页码 + 进度线
  ctx.fillStyle = muted
  ctx.font = `${Math.max(10, props.fontSize - 10)}px ${SERIF}`
  ctx.textAlign = 'right'
  ctx.fillText(`${page.value + 1} / ${pages.value.length}`, width - pad, height - 34)
  ctx.textAlign = 'left'
  ctx.fillStyle = line
  ctx.fillRect(pad, height - 18, width - pad * 2, 1)
  const ratio = pages.value.length <= 1 ? 1 : (page.value + 1) / pages.value.length
  ctx.fillStyle = ACCENT
  ctx.fillRect(pad, height - 18, (width - pad * 2) * ratio, 1)

  emit('page', { page: page.value, total: pages.value.length })
}

function snapshot(): HTMLCanvasElement | null {
  const canvas = canvasRef.value
  if (!canvas) return null
  const copy = document.createElement('canvas')
  copy.width = canvas.width
  copy.height = canvas.height
  copy.getContext('2d')?.drawImage(canvas, 0, 0)
  return copy
}

function restore(image: HTMLCanvasElement) {
  const canvas = canvasRef.value
  const context = canvas?.getContext('2d')
  if (!canvas || !context) return
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0)
}

function overlayWith(image: HTMLCanvasElement): HTMLCanvasElement | null {
  const host = canvasRef.value?.parentElement
  if (!host) return null
  const layer = document.createElement('canvas')
  layer.width = image.width
  layer.height = image.height
  layer.getContext('2d')?.drawImage(image, 0, 0)
  Object.assign(layer.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    willChange: 'transform',
  })
  host.appendChild(layer)
  return layer
}

function turn(direction: 1 | -1) {
  if (animating) return
  const nextPage = page.value + direction
  if (nextPage < 0 || nextPage >= pages.value.length) return

  if (props.animation === 'none' || !canvasRef.value) {
    page.value = nextPage
    render()
    return
  }

  const before = snapshot()
  if (!before) return
  page.value = nextPage
  render()
  const after = snapshot()
  if (!after) return

  animating = true
  const finish = () => {
    layer?.remove()
    animating = false
    render()
  }

  let layer: HTMLCanvasElement | null = null
  if (props.animation === 'cover') {
    // 旧页留在底层，新页从右侧盖上来
    restore(before)
    layer = overlayWith(after)
    if (!layer) {
      finish()
      return
    }
    layer.style.transform = 'translateX(100%)'
    requestAnimationFrame(() => {
      layer!.style.transition = 'transform 240ms ease-out'
      layer!.style.transform = 'translateX(0)'
    })
  } else {
    // 新页在底层，旧页向左滑走
    restore(after)
    layer = overlayWith(before)
    if (!layer) {
      finish()
      return
    }
    layer.style.transform = 'translateX(0)'
    requestAnimationFrame(() => {
      layer!.style.transition = 'transform 240ms ease-out'
      layer!.style.transform = 'translateX(-100%)'
    })
  }
  window.setTimeout(finish, 280)
}

function next() {
  turn(1)
}

function prev() {
  turn(-1)
}

function onCanvasClick(event: MouseEvent) {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const ratio = (event.clientX - rect.left) / rect.width
  if (ratio < 0.3) prev()
  else if (ratio > 0.7) next()
  else emit('centerTap')
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
  () => props.text,
  () => {
    page.value = Math.min(props.initialPage, Math.max(0, pages.value.length - 1))
    layout()
  },
)

watch(
  () => [props.title, props.fontSize, props.lineHeight, props.theme],
  () => layout(),
)

defineExpose({ next, prev, total, page })
</script>

<template>
  <div class="mo-canvas-host" data-testid="canvas-reader" :style="{ background: palette.bg }">
    <canvas ref="canvasRef" class="mo-canvas" @click="onCanvasClick" />
  </div>
</template>

<style>
.mo-canvas-host {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.mo-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: pointer;
}
</style>
