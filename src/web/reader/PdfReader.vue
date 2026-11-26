<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
// 宿主只加载打包后的 dist/client/client.js，独立 worker 文件不会作为静态资源提供，因此内联 worker。
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline'
import { pdfjsDocumentOptions } from '../../core/pdfjs-assets'

/**
 * PDF 原版阅读器：单页渲染，支持翻页、跳页、缩放与适应宽度。
 * 原版页面不生成文字层，选词与搜索请切到文本模式（见底部提示条）。
 */
const props = defineProps<{
  src: string
  title?: string
  /** 上次阅读页，0 起。 */
  initialPage?: number
  /** 上次缩放百分比，50–300。 */
  initialZoom?: number
  /** 上次是否处于适应宽度。 */
  initialFitWidth?: boolean
}>()

const emit = defineEmits<{
  (e: 'page', payload: { page: number; total: number; zoom: number; fitWidth: boolean }): void
  (e: 'switch-text'): void
  (e: 'close'): void
}>()

const ZOOM_MIN = 50
const ZOOM_MAX = 300
const ZOOM_STEP = 10

/** 内联 worker 推迟到第一次打开 PDF 时再创建，避免没读过 PDF 的会话白起一个 worker。 */
let pdfWorker: Worker | null = null

function ensurePdfWorker(): void {
  if (pdfWorker) return
  pdfWorker = new PdfWorker()
  pdfjsLib.GlobalWorkerOptions.workerPort = pdfWorker
}

const scroller = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const documentProxy = shallowRef<any>(null)
const total = ref(0)
const page = ref(0)
const pageInput = ref(1)
const zoom = ref(clampZoom(Number(props.initialZoom ?? 100)))
// 适应宽度时按容器算出的实际缩放，供缩放按钮从这里继续加减。
const fitZoom = ref(zoom.value)
const fitWidth = ref(Boolean(props.initialFitWidth))
const loading = ref(true)
const error = ref('')

const zoomLabel = computed(() => `${zoom.value}%`)

let loadingTask: any = null
let renderTask: any = null
let renderSeq = 0
let loadSeq = 0
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let resizeObserver: ResizeObserver | null = null

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 100
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value)))
}

function clampPage(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(0, Math.floor(value)), Math.max(0, total.value - 1))
}

function errorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause ?? '')
  const normalized = text.trim()
  return normalized ? normalized : '未知错误'
}

/** 页面基础尺寸（scale=1）；适应宽度时按容器宽度换算缩放。 */
function renderScale(pageProxy: any): number {
  if (!fitWidth.value) return zoom.value / 100
  const available = Math.max(120, (scroller.value?.clientWidth ?? 640) - 32)
  const baseWidth = pageProxy.getViewport({ scale: 1 }).width || 1
  const scale = available / baseWidth
  return Math.max(0.05, Math.min(3, scale))
}

function syncPageInput() {
  pageInput.value = page.value + 1
}

async function render(): Promise<void> {
  const doc = documentProxy.value
  const el = canvas.value
  if (!doc || !el || total.value <= 0) return
  const seq = ++renderSeq
  if (renderTask) {
    try {
      renderTask.cancel()
    } catch {
      // 取消旧渲染任务失败不影响新任务。
    }
    renderTask = null
  }
  try {
    const proxy = await doc.getPage(page.value + 1)
    if (seq !== renderSeq) return
    const scale = renderScale(proxy)
    if (fitWidth.value) fitZoom.value = clampZoom(Math.round(scale * 100))
    // 按设备像素比放大画布再缩回 CSS 尺寸，避免高分屏发虚。
    const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    const viewport = proxy.getViewport({ scale: scale * ratio })
    const cssViewport = proxy.getViewport({ scale })
    el.width = Math.max(1, Math.floor(viewport.width))
    el.height = Math.max(1, Math.floor(viewport.height))
    el.style.width = `${Math.max(1, Math.floor(cssViewport.width))}px`
    el.style.height = `${Math.max(1, Math.floor(cssViewport.height))}px`
    // pdfjs 6 需要显式传 canvas，内部自行取 2D 上下文。
    renderTask = proxy.render({ canvas: el, viewport })
    await renderTask.promise
    renderTask = null
    if (seq !== renderSeq) return
    error.value = ''
    emit('page', {
      page: page.value,
      total: total.value,
      zoom: fitWidth.value ? fitZoom.value : zoom.value,
      fitWidth: fitWidth.value,
    })
  } catch (cause: any) {
    if (seq !== renderSeq) return
    const name = String(cause?.name ?? '')
    const message = String(cause?.message ?? '')
    if (name === 'RenderingCancelledException' || /cancel/i.test(message)) return
    error.value = `第 ${page.value + 1} 页渲染失败：${errorMessage(cause)}`
  }
}

async function openDocument(): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  if (loadingTask) {
    try {
      loadingTask.destroy()
    } catch {
      // 旧文档销毁失败不阻塞重新加载。
    }
    loadingTask = null
  }
  documentProxy.value = null
  total.value = 0
  if (!props.src) {
    loading.value = false
    error.value = '没有可用的原版 PDF 地址'
    return
  }
  try {
    ensurePdfWorker()
    // cmaps / standard_fonts 由服务端从已安装的 pdfjs-dist 提供，缺了它们未嵌入中文字形的 PDF 会缺字。
    const task = pdfjsLib.getDocument(pdfjsDocumentOptions(props.src))
    loadingTask = task
    const doc = await task.promise
    if (seq !== loadSeq) {
      try {
        doc.destroy()
      } catch {
        // 卸载竞态：忽略。
      }
      return
    }
    documentProxy.value = doc
    total.value = doc.numPages
    page.value = clampPage(Number(props.initialPage ?? 0))
    syncPageInput()
    await nextTick()
    await render()
  } catch (cause) {
    if (seq !== loadSeq) return
    error.value = `原版 PDF 加载失败：${errorMessage(cause)}`
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

function setPage(value: number) {
  if (!total.value) return
  const next = clampPage(value)
  syncPageInput()
  if (next === page.value) return
  page.value = next
  void render()
}

function stepPage(delta: number) {
  setPage(page.value + delta)
}

function jumpToInput() {
  setPage(Number(pageInput.value) - 1)
  syncPageInput()
}

function setZoom(value: number) {
  fitWidth.value = false
  zoom.value = clampZoom(value)
  void render()
}

function stepZoom(delta: number) {
  setZoom((fitWidth.value ? fitZoom.value : zoom.value) + delta)
}

function toggleFitWidth() {
  fitWidth.value = !fitWidth.value
  void render()
}

function retry() {
  void openDocument()
}

function scheduleFitRender() {
  if (!fitWidth.value) return
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    void render()
  }, 150)
}

onMounted(() => {
  void openDocument()
  if (typeof ResizeObserver === 'function' && scroller.value) {
    resizeObserver = new ResizeObserver(scheduleFitRender)
    resizeObserver.observe(scroller.value)
  }
})

onBeforeUnmount(() => {
  loadSeq += 1
  renderSeq += 1
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  resizeObserver = null
  if (renderTask) {
    try {
      renderTask.cancel()
    } catch {
      // 卸载时取消渲染失败可忽略。
    }
    renderTask = null
  }
  if (loadingTask) {
    try {
      loadingTask.destroy()
    } catch {
      // 卸载时销毁文档失败可忽略。
    }
    loadingTask = null
  }
  documentProxy.value = null
})

// 同一本书换源/重新导入后地址会变，重新加载文档。
watch(
  () => props.src,
  () => {
    void openDocument()
  },
)
</script>

<template>
  <div class="mo-pdf" data-testid="pdf-reader">
    <div class="mo-pdf-bar">
      <button class="mo-pdf-icon" title="返回详情" data-testid="pdf-back" @click="emit('close')">‹</button>
      <div class="mo-pdf-title">
        <strong>{{ title || '原版 PDF' }}</strong>
        <span>{{ loading ? '加载中…' : `第 ${page + 1} / ${total || '—'} 页` }}</span>
      </div>
      <button class="mo-pdf-mode" data-testid="pdf-switch-text" @click="emit('switch-text')">文本模式</button>
    </div>

    <div class="mo-pdf-toolbar">
      <div class="mo-pdf-group">
        <button class="mo-pdf-btn" :disabled="page <= 0" data-testid="pdf-prev" @click="stepPage(-1)">上一页</button>
        <label class="mo-pdf-jump">
          <input
            v-model.number="pageInput"
            type="number"
            min="1"
            :max="total || 1"
            data-testid="pdf-page-input"
            @change="jumpToInput"
            @keyup.enter="jumpToInput"
          />
          <span>/ {{ total || '—' }}</span>
        </label>
        <button class="mo-pdf-btn" :disabled="page >= total - 1" data-testid="pdf-next" @click="stepPage(1)">下一页</button>
      </div>
      <div class="mo-pdf-group">
        <button class="mo-pdf-btn" :disabled="zoom <= ZOOM_MIN && !fitWidth" data-testid="pdf-zoom-out" @click="stepZoom(-ZOOM_STEP)">−</button>
        <span class="mo-pdf-zoom" data-testid="pdf-zoom-label">{{ fitWidth ? '适应宽度' : zoomLabel }}</span>
        <button class="mo-pdf-btn" :disabled="zoom >= ZOOM_MAX && !fitWidth" data-testid="pdf-zoom-in" @click="stepZoom(ZOOM_STEP)">＋</button>
        <button class="mo-pdf-btn" :class="{ on: fitWidth }" data-testid="pdf-fit-width" @click="toggleFitWidth">适应宽度</button>
      </div>
    </div>

    <p class="mo-pdf-hint" data-testid="pdf-original-hint">
      原版页面按原样显示，不支持选词与搜索；需要时
      <button class="mo-pdf-link" @click="emit('switch-text')">切到文本模式</button>
    </p>

    <div ref="scroller" class="mo-pdf-scroll">
      <div v-if="loading" class="mo-pdf-state">正在加载原版 PDF…</div>
      <div v-else-if="error" class="mo-pdf-state mo-pdf-error" data-testid="pdf-load-error" role="alert">
        <p>{{ error }}</p>
        <div class="mo-pdf-actions">
          <button class="mo-pdf-mode" @click="retry">重试</button>
          <button class="mo-pdf-mode" @click="emit('switch-text')">切到文本模式</button>
        </div>
      </div>
      <canvas v-show="!loading && !error" ref="canvas" class="mo-pdf-canvas" />
    </div>
  </div>
</template>

<style scoped>
.mo-pdf {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #26262a;
  color: #e8e4da;
}
.mo-pdf-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: #17181b;
  border-bottom: 1px solid #33343a;
}
.mo-pdf-icon {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
.mo-pdf-icon:hover {
  background: rgba(255, 255, 255, 0.08);
}
.mo-pdf-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  text-align: center;
}
.mo-pdf-title strong {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mo-pdf-title span {
  font-size: 11px;
  color: rgba(232, 228, 218, 0.6);
}
.mo-pdf-mode {
  padding: 5px 10px;
  border: 1px solid #4a4b52;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.mo-pdf-mode:hover {
  background: rgba(255, 255, 255, 0.08);
}
.mo-pdf-toolbar {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: #1d1e22;
  border-bottom: 1px solid #33343a;
}
.mo-pdf-group {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mo-pdf-btn {
  padding: 4px 9px;
  border: 1px solid #45464d;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.mo-pdf-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
}
.mo-pdf-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.mo-pdf-btn.on {
  background: #3d6b53;
  border-color: #3d6b53;
}
.mo-pdf-jump {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: rgba(232, 228, 218, 0.75);
}
.mo-pdf-jump input {
  width: 48px;
  padding: 3px 6px;
  border: 1px solid #45464d;
  border-radius: 6px;
  background: #26272c;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: center;
}
.mo-pdf-zoom {
  min-width: 64px;
  font-size: 12px;
  text-align: center;
}
.mo-pdf-hint {
  flex: 0 0 auto;
  margin: 0;
  padding: 6px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(232, 228, 218, 0.72);
  background: #232429;
  border-bottom: 1px solid #33343a;
}
.mo-pdf-link {
  padding: 0;
  border: 0;
  background: none;
  color: #8fc7a6;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.mo-pdf-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 16px;
}
.mo-pdf-canvas {
  display: block;
  flex: 0 0 auto;
  background: #fff;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
}
.mo-pdf-state {
  margin: auto;
  padding: 32px 16px;
  color: rgba(232, 228, 218, 0.75);
  font-size: 13px;
  text-align: center;
}
.mo-pdf-error p {
  margin: 0 0 12px;
  color: #ffb4a2;
}
.mo-pdf-actions {
  display: flex;
  justify-content: center;
  gap: 8px;
}
</style>
