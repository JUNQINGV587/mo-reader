<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { paginate } from '../../core/reader/paginate'
import { DEFAULT_TAP_ZONES, tapZoneIndex, tipText } from '../../core/reader/reader-config'

type Theme = 'light' | 'sepia' | 'dark'
type Turn = 'none' | 'cover' | 'slide' | 'simulate' | 'scroll'

const props = withDefaults(
  defineProps<{
    text: string
    title?: string
    bookName?: string
    fontSize?: number
    fontFamily?: string
    lineHeight?: number
    paragraphSpacing?: number
    indent?: number
    padding?: { left: number; top: number; right: number; bottom: number }
    initialPage?: number
    theme?: Theme
    animation?: Turn
    headerMode?: number
    footerMode?: number
    showHeaderLine?: boolean
    showFooterLine?: boolean
    tapZones?: number[]
    bookPercent?: number
    batteryPercent?: number | null
    highlight?: string
  underlines?: string[]
  }>(),
  {
    title: '',
    bookName: '',
    fontSize: 22,
    fontFamily: '',
    lineHeight: 1.9,
    paragraphSpacing: 6,
    indent: 2,
    padding: () => ({ left: 22, top: 5, right: 22, bottom: 4 }),
    initialPage: 0,
    theme: 'light',
    animation: 'cover',
    headerMode: 1,
    footerMode: 6,
    showHeaderLine: true,
    showFooterLine: true,
    tapZones: () => DEFAULT_TAP_ZONES,
    bookPercent: 0,
    batteryPercent: null,
    highlight: '',
    underlines: () => [],
  },
)

const emit = defineEmits<{
  page: [payload: { page: number; total: number }]
  tapAction: [code: number]
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
const ACCENT = '#3d6b53'

const palette = computed(() => {
  if (props.theme === 'dark') {
    return { bg: '#141518', text: '#d8d4c8', muted: '#8f897b', line: 'rgba(255,255,255,0.14)' }
  }
  if (props.theme === 'sepia') {
    return { bg: '#f1e5c9', text: '#4a3b28', muted: '#8a7657', line: 'rgba(74,59,40,0.2)' }
  }
  return { bg: '#f6f1e7', text: '#2b2a26', muted: '#7c7567', line: 'rgba(43,42,38,0.14)' }
})

const fontStack = computed(() => props.fontFamily ? `'${props.fontFamily.replace(/'/g, '')}', ${SERIF}` : SERIF)

function measureFont() {
  return `${props.fontSize}px ${fontStack.value}`
}

function lineHeightPx() {
  return props.fontSize * props.lineHeight
}

function headerHeight() {
  return props.headerMode === 0 && !props.showHeaderLine ? 18 : 48
}

function footerHeight() {
  return props.footerMode === 0 && !props.showFooterLine ? 18 : 44
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

  const pad = props.padding
  const result = paginate(props.text, {
    width: rect.width - pad.left - pad.right,
    height: rect.height - headerHeight() - footerHeight() - pad.top - pad.bottom,
    fontSize: props.fontSize,
    lineHeight: lineHeightPx(),
    indent: props.indent !== 0,
    paragraphSpacing: props.paragraphSpacing,
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

function tipContext() {
  return {
    bookName: props.bookName,
    chapterTitle: props.title,
    page: page.value + 1,
    totalPages: pages.value.length,
    bookPercent: props.bookPercent,
    batteryPercent: props.batteryPercent ?? undefined,
    time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
  }
}

function render() {
  const canvas = canvasRef.value
  if (!canvas || !ctx) return
  fillBackground()
  const { text: color, muted, line } = palette.value
  const pad = props.padding
  const lineHeight = lineHeightPx()
  const headerText = tipText(props.headerMode, tipContext())
  const footerText = tipText(props.footerMode, tipContext())

  // 页眉
  if (headerText) {
    ctx.fillStyle = muted
    ctx.font = `${Math.max(11, props.fontSize - 9)}px ${fontStack.value}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(headerText, width / 2, 18, width - pad.left - pad.right)
  }
  if (props.showHeaderLine) {
    ctx.strokeStyle = line
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(pad.left, 44)
    ctx.lineTo(width - pad.right, 44)
    ctx.stroke()
  }

  // 正文
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.font = measureFont()
  const lines = pages.value[page.value] ?? []
  const baseY = 44 + pad.top + 8

  // 朗读高亮：在当前页里按字符区间画底色
  if (props.highlight) {
    const pageText = lines.join('\n')
    const index = pageText.indexOf(props.highlight)
    if (index >= 0) {
      ctx.save()
      ctx.fillStyle = props.theme === 'dark' ? 'rgba(214,193,148,0.24)' : 'rgba(61,107,83,0.18)'
      let offset = 0
      lines.forEach((line, lineIndex) => {
        const start = offset
        const end = offset + line.length
        offset = end + 1
        const from = Math.max(index, start)
        const to = Math.min(index + (props.highlight ?? '').length, end)
        if (to > from && line) {
          const before = line.slice(0, from - start)
          const hit = line.slice(from - start, to - start)
          const x1 = ctx!.measureText(before).width
          const x2 = x1 + ctx!.measureText(hit).width
          ctx!.fillRect(pad.left + x1, baseY + lineIndex * lineHeight - 2, x2 - x1, lineHeight - 2)
        }
      })
      ctx.restore()
    }
  }

  ctx.fillStyle = color
  lines.forEach((value, lineIndex) => {
    if (value) ctx!.fillText(value, pad.left, baseY + lineIndex * lineHeight)
  })

  // 划线：按行文本匹配
  if (props.underlines?.length) {
    ctx.save()
    ctx.strokeStyle = props.theme === 'dark' ? 'rgba(214,193,148,0.55)' : 'rgba(61,107,83,0.45)'
    ctx.lineWidth = 2
    lines.forEach((value, lineIndex) => {
      if (!value) return
      if (!props.underlines!.some((quote) => quote && value.includes(quote))) return
      const textWidth = ctx!.measureText(value).width
      const y = baseY + lineIndex * lineHeight + lineHeight - 5
      ctx!.beginPath()
      ctx!.moveTo(pad.left, y)
      ctx!.lineTo(pad.left + textWidth, y)
      ctx!.stroke()
    })
    ctx.restore()
  }

  // 页脚
  if (footerText) {
    ctx.fillStyle = muted
    ctx.font = `${Math.max(10, props.fontSize - 10)}px ${fontStack.value}`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(footerText, width - pad.right, height - 20 - pad.bottom)
  }
  if (props.showFooterLine) {
    ctx.fillStyle = line
    ctx.fillRect(pad.left, height - 12 - pad.bottom, width - pad.left - pad.right, 1)
    const ratio = pages.value.length <= 1 ? 1 : (page.value + 1) / pages.value.length
    ctx.fillStyle = ACCENT
    ctx.fillRect(pad.left, height - 12 - pad.bottom, (width - pad.left - pad.right) * ratio, 1)
  }

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

function animate(mode: Turn, direction: 1 | -1, before: HTMLCanvasElement, after: HTMLCanvasElement) {
  let layer: HTMLCanvasElement | null = null
  const finish = () => {
    layer?.remove()
    animating = false
    render()
  }

  if (mode === 'cover' || mode === 'simulate') {
    restore(before)
    layer = overlayWith(after)
    if (!layer) return finish()
    if (mode === 'simulate') layer.style.filter = 'drop-shadow(-8px 0 14px rgba(0,0,0,0.25))'
    layer.style.transform = 'translateX(100%)'
    requestAnimationFrame(() => {
      layer!.style.transition = 'transform 260ms cubic-bezier(.25,.8,.25,1)'
      layer!.style.transform = 'translateX(0)'
    })
  } else if (mode === 'scroll') {
    restore(before)
    layer = overlayWith(after)
    if (!layer) return finish()
    layer.style.transform = direction > 0 ? 'translateY(100%)' : 'translateY(-100%)'
    requestAnimationFrame(() => {
      layer!.style.transition = 'transform 260ms ease-out'
      layer!.style.transform = 'translateY(0)'
    })
  } else {
    restore(after)
    layer = overlayWith(before)
    if (!layer) return finish()
    layer.style.transform = 'translateX(0)'
    requestAnimationFrame(() => {
      layer!.style.transition = 'transform 240ms ease-out'
      layer!.style.transform = `translateX(${direction > 0 ? '-100%' : '100%'})`
    })
  }
  window.setTimeout(finish, 300)
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
  animate(props.animation, direction, before, after)
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
  const x = (event.clientX - rect.left) / rect.width
  const y = (event.clientY - rect.top) / rect.height
  const index = tapZoneIndex(x, y)
  const zones = props.tapZones?.length === 9 ? props.tapZones : DEFAULT_TAP_ZONES
  emit('tapAction', zones[index] ?? 0)
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
  if (props.initialPage > 0) {
    page.value = Math.min(props.initialPage, Math.max(0, pages.value.length - 1))
    layout()
  }
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
  () => props.initialPage,
  (value) => {
    const target = Math.min(value, Math.max(0, pages.value.length - 1))
    if (target !== page.value) {
      page.value = target
      layout()
    }
  },
)

watch(
  () => [
    props.title,
    props.bookName,
    props.fontSize,
    props.fontFamily,
    props.lineHeight,
    props.paragraphSpacing,
    props.indent,
    props.theme,
    props.headerMode,
    props.footerMode,
    props.showHeaderLine,
    props.showFooterLine,
    props.padding,
  ],
  () => layout(),
  { deep: true },
)

function goto(target: number) {
  const nextPage = Math.max(0, Math.min(total.value - 1, target))
  if (nextPage === page.value) {
    render()
    return
  }
  page.value = nextPage
  render()
  emit('page', { page: nextPage, total: total.value })
}

function findPageFor(text: string): number {
  if (!text) return -1
  return pages.value.findIndex((lines) => lines.join('\n').includes(text))
}

watch(
  () => props.highlight,
  () => render(),
)

watch(
  () => props.underlines,
  () => render(),
  { deep: true },
)

function currentPageLines() {
  return (pages.value[page.value] ?? []).filter(Boolean)
}

defineExpose({ next, prev, total, page, goto, findPageFor, currentPageLines })
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
