<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import CanvasReader from '../reader/CanvasReader.vue'
import ComicReader from '../reader/ComicReader.vue'
import PdfReader from '../reader/PdfReader.vue'
import AudioReader from '../reader/AudioReader.vue'
import VideoReader from '../reader/VideoReader.vue'
import { simulatedChapterCount, simulatedProgress } from '../../core/reader/simulate'
import {
  buildSpeechPlan,
  classifySpeechError,
  segmentIndexForOffset,
  speechBlockedMessage,
  speechErrorNotice,
  SpeechCursor,
  SPEECH_NO_VOICE_MESSAGE,
  SPEECH_NOT_ALLOWED_NOTICE,
  SPEECH_UNSUPPORTED_MESSAGE,
  type SpeechPlan,
} from '../../core/reader/speech'
import { chapterForPdfPage, pdfPageOfChapterTitle } from '../../core/pdf-pages'
import {
  DEFAULT_MENU_ITEMS,
  DEFAULT_TAP_ZONES,
  MENU_ITEMS,
  READER_PRESETS,
  TAP_ZONE_NAMES,
  TIP_MODES,
  sanitizeTapZones,
  tapActionLabel,
  visibleTapActions,
} from '../../core/reader/reader-config'
import {
  BUILTIN_THEMES,
  createCustomTheme,
  exportFullThemes,
  exportLegadoThemes,
  isBuiltinThemeName,
  parseThemeImport,
  resolveThemeColors,
  toHexColor,
  type CustomTheme,
  type ThemeColors,
} from '../../core/reader/theme'
import { exportFullShelf, exportLegadoShelf } from '../../core/reader/shelf-transfer'
import {
  defaultReaderSettings,
  type ReaderSettings,
  type SettingsGroupKey,
} from '../../core/reader/settings'
import { AutoPageController } from '../../core/reader/auto-page'
import { KeepAwake } from '../../core/reader/wake-lock'
import { enabledDictRules, lookupAll, type DictLookupOutcome } from '../../core/dict/lookup-all'
import { swapDictOrder } from '../../core/dict/order'
import { filterSources, hasExplore, needsLogin, sourceHost } from '../../core/source/filter'
import { groupExploreBySourceGroup } from '../../core/source/group'

const props = defineProps<{ remote?: any; layout?: any }>()

type View = 'shelf' | 'sources' | 'search' | 'explore' | 'detail' | 'reader' | 'storage'
type Theme = 'light' | 'sepia' | 'dark'
type Turn = 'none' | 'cover' | 'slide' | 'simulate' | 'scroll'
type DictResult = DictLookupOutcome

/** 旧数据里存的是原始 HTML 简介，展示前转成纯文本。 */
function plainText(input?: string | null): string {
  if (!input) return ''
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lrm;|&rlm;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const view = ref<View>('shelf')
const version = ref('')
const status = ref('')
const busy = ref(false)
const cacheBusy = ref(false)
const exportBusy = ref(false)

const sources = ref<any[]>([])
const importText = ref('')
const rssSources = ref<any[]>([])
const rssImportText = ref('')
const rssMessage = ref('')
const rssBusy = ref(false)
const rssActive = ref<any>(null)
const rssFeed = ref<any>(null)
const rssArticles = ref<any[]>([])
const article = ref<any>(null)
const importMessage = ref('')
const sourceFilter = ref('')
const sourceGroup = ref('')
const sourceDomain = ref('')
const sourceSort = ref<'name' | 'url' | 'updated' | 'enabled'>('name')
const SOURCE_PAGE_SIZE = 50
const sourcePage = ref(1)
const selectedSourceIds = ref<Set<string>>(new Set())
const checkReport = ref<{ total: number; ok: number; problems: Array<{ name: string; message: string }> } | null>(null)
const sourceLogin = ref<'all' | 'required' | 'none'>('all')
const sourceExploreOnly = ref(false)
const sourceMessage = ref('')
const onlineCheckBusy = ref(false)
const onlineCheckReport = ref<{
  scope: 'selected' | 'page'
  total: number
  ok: number
  results: Array<{ url: string; ok: boolean; status: number | null; elapsedMs: number; error: string }>
} | null>(null)
const sourceTypeNames: Record<number, string> = { 0: '文本', 1: '音频', 2: '图片', 3: '文件', 4: '视频' }

const dictRules = ref<any[]>([])
const dictEditing = ref<any>(null)
const dictImportText = ref('')
const dictMessage = ref('')
const dictQuery = ref('')
const dictTrialBusy = ref(false)
const dictResults = ref<DictResult[]>([])
const dictActiveTab = ref('')
const dictEnabledCount = computed(() => dictRules.value.filter((item) => item.enabled !== false).length)
const dictActiveResult = computed(
  () => dictResults.value.find((item) => item.id === dictActiveTab.value) ?? dictResults.value[0] ?? null,
)

// 阅读页长按选词：独立于「书源 → 字典规则」的试查，互不覆盖。
const dictCardRef = ref<HTMLElement | null>(null)
const dictPanelOpen = ref(false)
const dictPanelText = ref('')
const dictPanelLine = ref('')
const dictPanelFallback = ref(false)
const dictPanelBusy = ref(false)
const dictPanelError = ref('')
const dictPanelCopied = ref('')
const dictPanelResults = ref<DictResult[]>([])
const dictPanelActive = ref('')
const dictPanelActiveResult = computed(
  () => dictPanelResults.value.find((item) => item.id === dictPanelActive.value) ?? dictPanelResults.value[0] ?? null,
)
let dictPanelToken = 0

const shelfBooks = ref<any[]>([])
const shelfSort = ref<'recent' | 'name' | 'progress'>('recent')
const shelfGroup = ref('')
const shelfGroupInput = ref('')
const shelfSelecting = ref(false)
const selectedBookIds = ref<Set<string>>(new Set())
const localInput = ref<HTMLInputElement | null>(null)
const shelfInput = ref<HTMLInputElement | null>(null)
const shelfMessage = ref('')
let longPressTimer: ReturnType<typeof setTimeout> | undefined
let longPressFired = false

const searchKey = ref('')
const searching = ref(false)
const books = ref<any[]>([])
const searchErrors = ref<any[]>([])
const searchScope = ref('')
const searchExact = ref(false)
const searchHistory = ref<string[]>([])
const SEARCH_HISTORY_KEY = 'mo-reader-search-history'

const exploreSources = ref<any[]>([])
const exploreGroups = ref<Array<{ source: any; categories: any[]; error: string }>>([])
const exploreSections = computed(() =>
  groupExploreBySourceGroup(exploreGroups.value, (group) => group.source?.bookSourceGroup),
)
const exploreLoading = ref(false)
const exploreActive = ref<any>(null)
const exploreBooks = ref<any[]>([])
const explorePage = ref(0)
const exploreHasMore = ref(false)
const exploreBusy = ref(false)
const exploreError = ref('')

const currentBook = ref<any>(null)
const introText = computed(() => plainText(currentBook.value?.intro))
const chapters = ref<any[]>([])
const currentChapter = ref<any>(null)
const content = ref('')
const readerKind = ref<'text' | 'images' | 'audio' | 'video' | 'pdf'>('text')
const readerImages = ref<string[]>([])
const readerMedia = ref('')
/** 当前章节是否来自本地离线缓存；播放器据此显示「本地 / 在线」。 */
const readerLocal = ref(false)
/** 本地文件损坏/缺失时回退在线的提示，留在阅读页不解散。 */
const readerMediaNotice = ref('')
/** 本地播放失败后最多手动重下本章一次，避免「删→下→删」循环。 */
let readerMediaRetryUsed = false
const readerMediaRetryAvailable = ref(false)
const readerMediaRetryBusy = ref(false)
const readerMediaRetryChapter = ref<number | null>(null)
let mediaFallbackBusy = false
const replacedContent = computed(() => {
  let text = content.value
  for (const rule of settings.value.replaceRules) {
    if (!rule.enabled || !rule.pattern) continue
    try {
      if (rule.regex) text = text.replace(new RegExp(rule.pattern, 'g'), rule.replacement ?? '')
      else text = text.split(rule.pattern).join(rule.replacement ?? '')
    } catch {
      // 非法正则跳过
    }
  }
  return text
})
const readerTitle = ref('')
const progress = ref<any>(null)
const localPdfStatus = ref<any>(null)
// PDF 原版阅读：地址、初始页/缩放与加载错误都由阅读页接管。
const pdfOriginalUrl = ref('')
const pdfInitialPage = ref(0)
const pdfInitialZoom = ref(100)
const pdfInitialFitWidth = ref(false)
const pdfError = ref('')
let pdfTimer: ReturnType<typeof setTimeout> | undefined
const isPdfBook = computed(() => Boolean(localPdfStatus.value?.isPdf))
const isPdfReadable = computed(() => Boolean(localPdfStatus.value?.isPdf && localPdfStatus.value?.hasOriginal && localPdfStatus.value?.originalUrl))
const hasPdfProgress = computed(() => progress.value?.pdfPage !== undefined || progress.value?.pdfZoom !== undefined)
const batteryPercent = ref<number | null>(null)
const bookPercent = computed(() => {
  const total = chapters.value.length
  if (!total) return 0
  const chapter = currentChapter.value
  const index = chapter ? chapters.value.findIndex((item: any) => item.url && item.url === chapter.url) : -1
  const done = index >= 0 ? index : Number(progress.value?.chapterIndex ?? 0)
  return Math.min(100, Math.max(0, ((done + 1) / total) * 100))
})

async function loadBattery() {
  const getBattery = (navigator as any).getBattery
  if (typeof getBattery !== 'function') return
  try {
    const battery = await getBattery.call(navigator)
    batteryPercent.value = Math.round(Number(battery.level) * 100)
    battery.addEventListener?.('levelchange', () => {
      batteryPercent.value = Math.round(Number(battery.level) * 100)
    })
  } catch {
    batteryPercent.value = null
  }
}
/** 全局设置与「本书覆盖」合并后的当前生效值；面板里的控件都绑它。 */
const settings = ref<ReaderSettings>(defaultReaderSettings())
type SettingsScope = 'global' | 'book'
/** 作用域是用户选择，记在本机，刷新后仍停在同一层。 */
const SETTINGS_SCOPE_KEY = 'mo-reader-settings-scope'
/** Chrome 的音色列表常异步到达：最多等这么久，仍为空即认定没有中文音色 */
const SPEECH_VOICE_WAIT_MS = 1200
function storedSettingsScope(): SettingsScope {
  try {
    return localStorage.getItem(SETTINGS_SCOPE_KEY) === 'book' ? 'book' : 'global'
  } catch {
    // 隐私模式下 localStorage 可能不可用
    return 'global'
  }
}
function storeSettingsScope(scope: SettingsScope): void {
  try {
    localStorage.setItem(SETTINGS_SCOPE_KEY, scope)
  } catch {
    // 存不了就不存，作用域只在本次会话有效
  }
}
const settingsScope = ref<SettingsScope>(storedSettingsScope())
const bookOverridden = ref(false)
const settingsError = ref('')
/** 最近一次读取/保存后的基准值，用于算出「只提交改过的字段」。 */
const settingsBaseline = ref<ReaderSettings>(defaultReaderSettings())
const settingsSheetRef = ref<HTMLElement | null>(null)
const settingsTrigger = ref<HTMLElement | null>(null)
const canUseBookScope = computed(() => Boolean(currentBook.value?.id))
let settingsPersistTimer: ReturnType<typeof setTimeout> | null = null
const readerRef = ref<any>(null)
const initialPage = ref(0)
const tocFilter = ref('')
const tocOpen = ref(false)
const chrome = ref(true)
const settingsOpen = ref(false)
const customFonts = ref<Array<{ id: string; name: string; fileName: string; size: number }>>([])
const activeFontFamily = ref('')
const fontMessage = ref('')
const themeMessage = ref('')
const themeDraft = ref<{
  id: string
  name: string
  bg: string
  text: string
  muted: string
  line: string
} | null>(null)
const loadedFonts = new Map<string, FontFace>()
const bookmarksOpen = ref(false)
const bookmarks = ref<any[]>([])
const notesOpen = ref(false)
const notes = ref<any[]>([])
const noteDraft = ref('')
const underlineOpen = ref(false)
const underlineLines = ref<string[]>([])
const selectedUnderlines = ref<string[]>([])
const speechStatus = ref<'idle' | 'speaking' | 'paused'>('idle')
const speechNotice = ref('')
const speechLoading = ref(false)
const speechHighlight = ref<{ start: number; end: number } | null>(null)
const speechSegmentIndex = ref(0)
const speechSegmentTotal = ref(0)
const speechChapterTitle = ref('')
const speechVoices = ref<SpeechSynthesisVoice[]>([])
const speechVoicesLoaded = ref(false)
let speechVoiceWaitTimer = 0
/** 搜索高亮：关键词命中的原文绝对范围（与朗读高亮分开，朗读优先） */
const highlightText = ref<{ start: number; end: number } | null>(null)
let speechPlan: SpeechPlan | null = null
let speechCursor: SpeechCursor | null = null
let speechUtterance: SpeechSynthesisUtterance | null = null
let speechToken = 0
let speechResumeTimer: ReturnType<typeof setTimeout> | undefined
let speechBusyRetried = false
let speechUserCancel = false
/** 上次失败是 not-allowed：只有用户手势里的 speak 才可能恢复 */
let speechNotAllowed = false
let pageTimer: ReturnType<typeof setTimeout> | undefined

// 阅读页「书内搜索」：跨批自动推进，令牌用于停止后丢弃在途批次。
const readerSearchOpen = ref(false)
const readerSearchKey = ref('')
const readerSearchUsedKey = ref('')
const readerSearchBusy = ref(false)
const readerSearchStarted = ref(false)
const readerSearchDone = ref(true)
const readerSearchStopped = ref(false)
const readerSearchScanned = ref(0)
const readerSearchTotal = ref(0)
const readerSearchNextIndex = ref(0)
const readerSearchResults = ref<
  Array<{ chapterIndex: number; chapterTitle: string; count: number; snippet: string; pageHint: number }>
>([])
const readerSearchErrors = ref<Array<{ chapterIndex: number; chapterTitle: string; message: string }>>([])
const readerSearchHint = ref('')
const readerHint = ref('')
let readerSearchToken = 0
let readerHintTimer: ReturnType<typeof setTimeout> | undefined

// ---- 自动翻页（#126）：控制器、章末续章、常亮与状态条 ----
const autoPage = new AutoPageController()
const autoPageStatus = ref<'idle' | 'running' | 'paused'>('idle')
const autoPageLabel = ref('')
const autoPageNotice = ref('')
const tapActionChoices = computed(() => visibleTapActions())
const readerTotalPages = ref(0)
const boundaryLoading = ref(false)
const boundaryDirection = ref<1 | -1>(1)
let autoPageTimer: ReturnType<typeof setInterval> | undefined
let autoPagePendingChapter = false
let autoPageChapterFailed = false
let keepAwake: KeepAwake | null = null
let tapZonesRevertedNotified = false

function refreshAutoPageState() {
  autoPageStatus.value = autoPage.status
  autoPageLabel.value = autoPage.label
  autoPageNotice.value = autoPage.notice
}

function autoPageHasNextChapter(): boolean {
  return chapterIndex.value >= 0 && chapterIndex.value < chapters.value.length - 1
}

function syncAutoPagePosition(page = initialPage.value, pages = readerTotalPages.value) {
  autoPage.setPosition({ page, pages, hasNextChapter: autoPageHasNextChapter() })
}

function ensureKeepAwake(): KeepAwake {
  if (!keepAwake) {
    keepAwake = new KeepAwake({
      request: async () => {
        const api = (navigator as Navigator & { wakeLock?: { request?: (type: 'screen') => Promise<any> } }).wakeLock
        if (!api?.request) throw new Error('wakeLock unavailable')
        return await api.request('screen')
      },
      onNotice: (message) => {
        if (view.value === 'reader') showReaderHint(message)
      },
    })
  }
  return keepAwake
}

function releaseKeepAwake() {
  if (!keepAwake) return
  void keepAwake.release()
}

async function startAutoPage() {
  if (view.value !== 'reader' || readerKind.value !== 'text') {
    showReaderHint('仅文字阅读支持自动翻页')
    return
  }
  if (settingsOpen.value) closeSettings()
  chrome.value = false
  // 自动翻页与朗读互斥：暂停朗读但保留游标，之后再继续。
  if (speechStatus.value === 'speaking') pauseSpeech()
  autoPage.setSeconds(settings.value.autoPageSeconds)
  syncAutoPagePosition()
  autoPage.start()
  autoPageChapterFailed = false
  autoPagePendingChapter = false
  refreshAutoPageState()
  void ensureKeepAwake().acquire()
}

function pauseAutoPage() {
  autoPage.pause()
  refreshAutoPageState()
}

async function resumeAutoPage() {
  autoPage.resume()
  refreshAutoPageState()
  if (autoPageChapterFailed) {
    autoPageChapterFailed = false
    await loadAutoPageChapter()
    return
  }
  void ensureKeepAwake().acquire()
}

function stopAutoPage() {
  autoPage.stop()
  autoPageChapterFailed = false
  autoPagePendingChapter = false
  refreshAutoPageState()
  releaseKeepAwake()
}

/** 章末续章：先加载，成功后才由 onReaderPageState 恢复计时。 */
async function loadAutoPageChapter() {
  if (view.value !== 'reader' || boundaryLoading.value) return
  const target = chapters.value[chapterIndex.value + 1]
  if (!target) {
    autoPageChapterFailed = true
    autoPage.failedChapter('没有下一章可续')
    refreshAutoPageState()
    releaseKeepAwake()
    return
  }
  boundaryDirection.value = 1
  boundaryLoading.value = true
  try {
    const ok = await openChapter(target, 0)
    if (!ok) {
      autoPageChapterFailed = true
      autoPage.failedChapter('下一章加载失败，点「继续」重试')
      releaseKeepAwake()
    } else {
      autoPagePendingChapter = true
    }
  } finally {
    boundaryLoading.value = false
    refreshAutoPageState()
  }
}

function runAutoPageTick() {
  if (view.value !== 'reader' || autoPage.status !== 'running') return
  if (chrome.value || tocOpen.value || settingsOpen.value) return
  const action = autoPage.tick()
  if (action.kind === 'turn') {
    readerRef.value?.goto?.(action.page)
    refreshAutoPageState()
    return
  }
  if (action.kind === 'load-chapter') {
    refreshAutoPageState()
    void loadAutoPageChapter()
    return
  }
  if (action.kind === 'book-end') {
    refreshAutoPageState()
    showReaderHint(action.message)
    releaseKeepAwake()
  }
}

/** 翻页到章边界：先加载相邻章，成功后再落到新章首页/末页。 */
async function onChapterBoundary(payload: { direction: 1 | -1 }) {
  if (boundaryLoading.value || busy.value) return
  const target = chapters.value[chapterIndex.value + payload.direction]
  if (!target) {
    showReaderHint(payload.direction > 0 ? '已到全书末尾' : '已是第一章')
    return
  }
  boundaryDirection.value = payload.direction
  boundaryLoading.value = true
  autoPage.addPauseReason('loading')
  refreshAutoPageState()
  try {
    const page = payload.direction > 0 ? 0 : Number.MAX_SAFE_INTEGER
    const ok = await openChapter(target, page)
    if (!ok) {
      showReaderHint(payload.direction > 0 ? '下一章加载失败，请重试' : '上一章加载失败，请重试')
      if (autoPage.status !== 'idle') {
        autoPageChapterFailed = true
        autoPage.failedChapter('相邻章节加载失败，点「继续」重试')
      }
    } else if (autoPage.status !== 'idle') {
      autoPage.removePauseReason('loading')
      autoPage.notifyTurn()
    }
  } finally {
    boundaryLoading.value = false
    refreshAutoPageState()
  }
}

function onReaderTurnState(animating: boolean) {
  if (animating) autoPage.addPauseReason('turn')
  else autoPage.removePauseReason('turn')
  refreshAutoPageState()
}

function onReaderPageState(payload: { page: number; total: number }) {
  readerTotalPages.value = Math.max(0, payload.total)
  syncAutoPagePosition(payload.page, payload.total)
  if (autoPagePendingChapter) {
    autoPagePendingChapter = false
    autoPage.loadedChapter({ pages: payload.total })
    autoPage.setPosition({ page: payload.page })
    void ensureKeepAwake().acquire()
  } else {
    autoPage.notifyTurn()
  }
  refreshAutoPageState()
}

function setAutoPause(reason: 'menu' | 'toc' | 'settings' | 'hidden' | 'loading', active: boolean) {
  if (active) autoPage.addPauseReason(reason)
  else autoPage.removePauseReason(reason)
  refreshAutoPageState()
}

function onReaderVisibilityChange() {
  const hidden = document.hidden
  setAutoPause('hidden', hidden)
  if (keepAwake) void keepAwake.visibilityChanged(!hidden)
  if (hidden) return
  // 后台朗读可能被系统打断：回前台发现已不在 speaking 就显示「朗读已暂停」，位置保留可继续。
  if (speechStatus.value === 'speaking' && !window.speechSynthesis?.speaking) {
    speechStatus.value = 'paused'
    speechNotice.value = '朗读已暂停'
    showReaderHint('朗读已暂停')
  }
  if (speechHighlight.value) alignSpeechPage(speechHighlight.value.start)
}

/** Esc：依次收起设置、目录、各类面板、朗读条与菜单。 */
function closeReaderOverlays(): boolean {
  if (settingsOpen.value) {
    closeSettings()
    return true
  }
  if (tocOpen.value) {
    tocOpen.value = false
    return true
  }
  if (bookmarksOpen.value) {
    bookmarksOpen.value = false
    return true
  }
  if (notesOpen.value) {
    notesOpen.value = false
    return true
  }
  if (readerSearchOpen.value) {
    readerSearchOpen.value = false
    return true
  }
  if (dictPanelOpen.value) {
    dictPanelOpen.value = false
    return true
  }
  if (underlineOpen.value) {
    underlineOpen.value = false
    return true
  }
  if (speechStatus.value !== 'idle') {
    stopSpeech()
    return true
  }
  if (chrome.value) {
    chrome.value = false
    return true
  }
  return false
}

function onReaderEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  if (view.value !== 'reader') return
  if (closeReaderOverlays()) event.preventDefault()
}

watch(
  [chrome, bookmarksOpen, notesOpen, readerSearchOpen, dictPanelOpen, underlineOpen],
  ([bar, bookmarks, notes, search, dict, underline]) => {
    if (view.value === 'reader') setAutoPause('menu', Boolean(bar || bookmarks || notes || search || dict || underline))
  },
)
watch(busy, (loading) => {
  if (view.value === 'reader') setAutoPause('loading', loading)
})
watch(tocOpen, (open) => {
  if (view.value === 'reader') setAutoPause('toc', open)
})
watch(settingsOpen, (open) => {
  if (view.value === 'reader') setAutoPause('settings', open)
})
watch(
  () => settings.value.autoPageSeconds,
  (value) => {
    autoPage.setSeconds(value)
    refreshAutoPageState()
  },
)
watch(
  () => [settings.value.ttsVoice, settings.value.ttsRate],
  () => {
    if (speechStatus.value === 'idle') return
    // 立即按新音色/语速重念当前段；暂停中只作废旧 utterance，继续时重念
    cancelSpeechUtterance()
    if (speechStatus.value === 'speaking') {
      speechBusyRetried = false
      speechNotAllowed = false
      speakCurrentSegment()
    }
  },
)
watch(view, (next, prev) => {
  if (prev === 'reader' && next !== 'reader') {
    stopSpeech()
    stopAutoPage()
    flushReaderProgress()
  }
})
const editing = ref<any>(null)
const editingJson = ref('')
const debugType = ref('search')
const debugInput = ref('')
const debugBusy = ref(false)
const debugResult = ref<any>(null)

const enabledCount = computed(() => sources.value.filter((source) => source.enabled !== false).length)
const chapterIndex = computed(() =>
  currentChapter.value ? chapters.value.indexOf(currentChapter.value) : -1,
)
const chapterNotes = computed(() =>
  notes.value.filter((item) => Number(item.chapterIndex) === chapterIndex.value),
)
const underlineQuotes = computed(() =>
  chapterNotes.value
    .filter((item) => item.type === 'underline')
    .map((item) => String(item.quote ?? ''))
    .filter(Boolean),
)
const theme = computed<Theme>(() => {
  const value = settings.value.theme === 'system' ? 'light' : settings.value.theme
  return isBuiltinThemeName(value) ? value : 'light'
})
const activeThemeColors = computed<ThemeColors>(() =>
  resolveThemeColors(settings.value.theme, settings.value.customThemes),
)
const activeCustomTheme = computed<CustomTheme | undefined>(() =>
  settings.value.customThemes.find((item) => item.id === settings.value.theme),
)
const sourceGroups = computed(() =>
  [...new Set(sources.value.map((source) => source.bookSourceGroup).filter((group): group is string => typeof group === 'string' && group.length > 0))].sort((a, b) => a.localeCompare(b, 'zh')),
)
const sourceDomains = computed(() => [...new Set(sources.value.map((source) => sourceHost(source.bookSourceUrl)).filter(Boolean))].sort())
const filteredSortedSources = computed(() => {
  const filtered = filterSources(sources.value, {
    key: sourceFilter.value,
    group: sourceGroup.value,
    domain: sourceDomain.value,
    login: sourceLogin.value,
    exploreOnly: sourceExploreOnly.value,
  })
  const sorted = [...filtered]
  if (sourceSort.value === 'url') {
    sorted.sort((a, b) => String(a.bookSourceUrl ?? '').localeCompare(String(b.bookSourceUrl ?? '')))
  } else if (sourceSort.value === 'updated') {
    sorted.sort((a, b) => Number(b.lastUpdateTime ?? 0) - Number(a.lastUpdateTime ?? 0))
  } else if (sourceSort.value === 'enabled') {
    sorted.sort((a, b) => Number(b.enabled !== false) - Number(a.enabled !== false) || String(a.bookSourceName ?? '').localeCompare(String(b.bookSourceName ?? ''), 'zh'))
  } else {
    sorted.sort((a, b) => String(a.bookSourceName ?? '').localeCompare(String(b.bookSourceName ?? ''), 'zh'))
  }
  return sorted
})
const sourcePageCount = computed(() => Math.max(1, Math.ceil(filteredSortedSources.value.length / SOURCE_PAGE_SIZE)))
const pagedSources = computed(() =>
  filteredSortedSources.value.slice((sourcePage.value - 1) * SOURCE_PAGE_SIZE, sourcePage.value * SOURCE_PAGE_SIZE),
)
const allPageSelected = computed(
  () => pagedSources.value.length > 0 && pagedSources.value.every((source) => selectedSourceIds.value.has(source.id)),
)
const selectedCount = computed(() => selectedSourceIds.value.size)
/** 在线检查范围：已选优先，否则本页可见；空地址不检查。 */
const onlineCheckTargets = computed(() => {
  const base =
    selectedCount.value > 0
      ? sources.value.filter((source) => selectedSourceIds.value.has(source.id))
      : pagedSources.value
  return base.filter(
    (source) => typeof source.bookSourceUrl === 'string' && source.bookSourceUrl.trim().length > 0,
  )
})
const onlineCheckScope = computed(() =>
  selectedCount.value > 0 ? `已选 ${onlineCheckTargets.value.length} 个` : `本页 ${onlineCheckTargets.value.length} 个`,
)
watch([sourceFilter, sourceGroup, sourceDomain, sourceSort, sourceLogin, sourceExploreOnly], () => {
  sourcePage.value = 1
})
watch(
  () => filteredSortedSources.value.length,
  () => {
    if (sourcePage.value > sourcePageCount.value) sourcePage.value = sourcePageCount.value
  },
)
watch(view, (value) => {
  if (value !== 'reader') closeReaderDict()
})
const enabledSources = computed(() => sources.value.filter((source) => source.enabled !== false))
const scopedSourceUrls = computed<string[] | null>(() => {
  if (searchScope.value.startsWith('group:')) {
    const group = searchScope.value.slice(6)
    return enabledSources.value.filter((source) => source.bookSourceGroup === group).map((source) => source.bookSourceUrl)
  }
  if (searchScope.value.startsWith('source:')) return [searchScope.value.slice(7)]
  return null
})
const searchScopeLabel = computed(() => {
  if (searchScope.value.startsWith('group:')) return `分组「${searchScope.value.slice(6)}」`
  if (searchScope.value.startsWith('source:')) {
    const url = searchScope.value.slice(7)
    const source = sources.value.find((item) => item.bookSourceUrl === url)
    return source?.bookSourceName || url
  }
  return `${enabledSources.value.length} 个启用源`
})

const TOC_PAGE_SIZE = 200
const tocPage = ref(1)
const tocFiltered = computed(() => {
  const key = tocFilter.value.trim()
  return key ? chapters.value.filter((chapter) => chapter.title.includes(key)) : chapters.value
})
const filteredChapters = computed(() => tocFiltered.value.slice(0, tocPage.value * TOC_PAGE_SIZE))
const tocHasMore = computed(() => filteredChapters.value.length < tocFiltered.value.length)
const tocTotal = computed(() => tocFiltered.value.length)
watch(tocFilter, () => {
  tocPage.value = 1
})

async function call(method: string, args?: any) {
  const fn = props.remote?.[method]
  if (typeof fn !== 'function') throw new Error(`Remote 未就绪：${method}`)
  const result = args === undefined ? await fn.call(props.remote) : await fn.call(props.remote, args)
  // DSH Remote 成功时返回 { ok: true, value }，失败时返回 { ok: false, error }。
  if (result && result.ok === false) {
    const error = result.error
    throw new Error(typeof error === 'string' ? error : error?.message || '操作失败')
  }
  return result && result.ok === true ? result.value : result
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function refresh() {
  busy.value = true
  try {
    const state = await call('state')
    version.value = state?.version ?? ''
    const [sourceResult, bookResult] = await Promise.all([call('listSources'), call('listBooks')])
    sources.value = sourceResult?.sources ?? []
    shelfBooks.value = bookResult?.books ?? []
    await loadDictRules()
    // 设置读取失败只在面板里提示，不阻塞书源/书架加载。
    await loadSettings()
    try {
      const fontResult = await call('listFonts')
      customFonts.value = fontResult?.fonts ?? []
      syncExportFont()
      if (settings.value.fontId) await applyCustomFont(settings.value.fontId)
    } catch (error) {
      fontMessage.value = `字体加载失败：${errorText(error)}`
    }
    status.value = `书源 ${sources.value.length} 个（启用 ${enabledCount.value}） · 书架 ${shelfBooks.value.length} 本`
  } catch (error) {
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

function bookStatus(book: any) {
  const kind = String(book?.kind ?? '')
  if (kind.includes('完结')) return '已完结'
  if (kind.includes('连载')) return '连载中'
  return ''
}

function shelfProgress(book: any) {
  if (book?.localMissing) return { percent: 0, text: '本地文件缺失' }
  if (book?.metadataOnly) return { percent: 0, text: '仅书目' }
  const record = book?.progress
  if (!record) return null
  const simulated = Boolean(book?.simulateEnabled)
  const percent = Math.round(simulatedProgress(book, Number(record.chapterIndex ?? 0)) * 100)
  const text = record.chapterTitle ? `读至 ${record.chapterTitle}` : `第 ${record.chapterIndex + 1} 章`
  return { percent, text: simulated ? `${text} · 模拟` : text }
}

const simulateOpen = ref(false)
const simulateDraft = ref({ enabled: false, startDate: '', startChapter: 0, dailyChapters: 3 })

function openSimulate() {
  const book = currentBook.value as any
  simulateDraft.value = {
    enabled: Boolean(book?.simulateEnabled),
    startDate: typeof book?.simulateStartDate === 'string' ? book.simulateStartDate : new Date().toISOString().slice(0, 10),
    startChapter: Number(book?.simulateStartChapter ?? 0),
    dailyChapters: Number(book?.simulateDailyChapters ?? 3),
  }
  simulateOpen.value = true
}

async function saveSimulate() {
  const book = currentBook.value as any
  if (!book?.id) return
  const patch = {
    simulateEnabled: Boolean(simulateDraft.value.enabled),
    simulateStartDate: simulateDraft.value.startDate,
    simulateStartChapter: Math.max(0, Number(simulateDraft.value.startChapter) || 0),
    simulateDailyChapters: Math.max(1, Number(simulateDraft.value.dailyChapters) || 1),
    totalChapterNum: Math.max(Number(book.totalChapterNum) || 0, chapters.value.length),
  }
  try {
    const result = await call('updateBook', { id: book.id, patch })
    Object.assign(currentBook.value as any, result.book ?? patch)
    simulateOpen.value = false
    status.value = patch.simulateEnabled ? `模拟阅读已开启，当前模拟至第 ${simulatedChapterCount(currentBook.value as any)} 章` : '模拟阅读已关闭'
    await refresh()
  } catch (error) {
    status.value = errorText(error)
  }
}

async function cacheBookChapters() {
  const book = currentBook.value as any
  if (!book?.id) return
  cacheBusy.value = true
  try {
    const result: any = await call('cacheBook', { bookId: book.id, limit: 20 })
    status.value = result?.message || `已缓存 ${result?.cached ?? 0} 章，失败 ${result?.failed ?? 0} 章`
  } catch (error) {
    status.value = errorText(error)
  } finally {
    cacheBusy.value = false
  }
}

const exportJob = ref<any>(null)
const exportDownload = ref<{ url: string; fileName: string } | null>(null)
/** 失败章节超过界面展示上限时的完整清单（服务端生成，可下载）。 */
const exportFailedDownload = ref<{ url: string; fileName: string } | null>(null)
/** PDF 导出用的中文字体 id；空值交给服务端提示「请先上传中文字体」。 */
const exportFontId = ref('')
const exportMessage = ref('')
let exportTimer: ReturnType<typeof setInterval> | null = null

function isExportRunning(job: any) {
  return job?.status === 'running' || job?.status === 'queued'
}

function exportStatusText(job: any) {
  if (!job) return ''
  if (job.status === 'paused') return job.error === '宿主重启' ? '已暂停（宿主重启）' : '已暂停'
  if (job.status === 'queued') return '排队中'
  if (job.status === 'running') return '导出中'
  if (job.status === 'done') return '已完成'
  if (job.status === 'cancelled') return '已取消'
  return job.status === 'failed' ? '失败' : String(job.status)
}

function exportFailedChapters(job: any) {
  const list = Array.isArray(job?.failedChapters) ? job.failedChapters : []
  // 总数以 job.failed 为准：超过上限时列表被截断，但失败数量始终是真实值。
  const total = Number(job?.failed) || list.length
  if (!total) return ''
  if (!list.length) return `共 ${total} 章`
  const shown = list.slice(0, 8).join('、')
  return total > 8 ? `${shown} 等 ${total} 章` : shown
}

const storageQuotaWarning = computed(() => {
  const used = Number(storageUsage.value?.media?.bytes ?? 0)
  const quota = Number(storageUsage.value?.quota?.bytes ?? 0)
  if (!quota || used / quota < 0.8) return ''
  return `媒体缓存已用 ${Math.round((used / quota) * 100)}%，接近配额，建议按书清理`
})

function exportPercent(job: any) {
  const total = Number(job?.total) || 0
  if (!total) return 0
  const handled = Number(job.completed) + Number(job.failed) + Number(job.skipped)
  return Math.max(0, Math.min(100, Math.round((handled / total) * 100)))
}

function stopExportTimer() {
  if (exportTimer !== null) {
    clearInterval(exportTimer)
    exportTimer = null
  }
}

function syncExportTimer() {
  if (isExportRunning(exportJob.value)) {
    if (exportTimer === null) exportTimer = setInterval(refreshExportJob, 600)
  } else {
    stopExportTimer()
  }
}

/** 导出收尾的两种终态：只有它们才有可下载的东西（产物或失败清单）。 */
function isExportFinished(job: any): boolean {
  return job?.status === 'done' || job?.status === 'failed'
}

async function loadExportDownload() {
  const job = exportJob.value
  if (!job?.id || !isExportFinished(job)) {
    exportDownload.value = null
    exportFailedDownload.value = null
    return
  }
  if (job.status === 'done') {
    try {
      const result: any = await call('getExportDownload', { jobId: job.id })
      exportDownload.value = { url: String(result?.url ?? ''), fileName: String(result?.fileName ?? '') }
    } catch (error) {
      exportDownload.value = null
      status.value = errorText(error)
    }
  } else {
    // 整本失败没有主产物，但失败清单照样值得给：它就是定位「哪几章没导出」的材料。
    exportDownload.value = null
  }
  await loadExportFailedDownload()
}

/** 只有失败数超过展示上限时才有清单可下；取不到就当没有，不影响主产物。 */
async function loadExportFailedDownload() {
  const job = exportJob.value
  if (!job?.id || !job.failedTruncated || !job.failedListFile) {
    exportFailedDownload.value = null
    return
  }
  try {
    const result: any = await call('getExportFailedDownload', { jobId: job.id })
    exportFailedDownload.value = { url: String(result?.url ?? ''), fileName: String(result?.fileName ?? '') }
  } catch {
    exportFailedDownload.value = null
  }
}

async function refreshExportJob() {
  const job = exportJob.value
  if (!job?.id) return
  try {
    const result: any = await call('getJob', { id: job.id })
    exportJob.value = result?.job ?? exportJob.value
  } catch (error) {
    status.value = errorText(error)
  }
  if (isExportFinished(exportJob.value)) await loadExportDownload()
  syncExportTimer()
}

async function loadActiveExport() {
  exportJob.value = null
  exportDownload.value = null
  exportFailedDownload.value = null
  exportBusy.value = false
  const book = currentBook.value as any
  if (!book?.id) {
    stopExportTimer()
    return
  }
  try {
    const result: any = await call('listJobs', { bookId: book.id, kind: 'export' })
    const jobs: any[] = Array.isArray(result?.jobs) ? result.jobs : []
    const active = jobs.find((job) => ['queued', 'running', 'paused'].includes(job.status))
    exportJob.value = active ?? jobs[0] ?? null
  } catch {
    exportJob.value = null
  }
  if (isExportFinished(exportJob.value)) await loadExportDownload()
  syncExportTimer()
}

/** 导出字体默认跟随阅读字体，没设过就用列表第一个；是否可嵌入由服务端开工前校验。 */
function syncExportFont() {
  if (exportFontId.value && customFonts.value.some((font) => font.id === exportFontId.value)) return
  const preferred = settings.value.fontId
  exportFontId.value =
    preferred && customFonts.value.some((font) => font.id === preferred)
      ? preferred
      : (customFonts.value[0]?.id ?? '')
}

async function startExport(format: 'txt' | 'epub' | 'pdf' = 'txt', fontId = '') {
  const book = currentBook.value as any
  if (!book?.id) return
  exportBusy.value = true
  exportDownload.value = null
  exportFailedDownload.value = null
  exportMessage.value = ''
  try {
    const payload: Record<string, unknown> = { bookId: book.id, format }
    if (format === 'pdf') {
      payload.fontId = fontId || exportFontId.value || settings.value.fontId || customFonts.value[0]?.id || ''
    }
    const result: any = await call('startExport', payload)
    exportJob.value = result?.job ?? null
    status.value = result?.existing ? '已有进行中的导出' : '已开始导出'
    syncExportTimer()
  } catch (error) {
    const message = errorText(error)
    status.value = message
    // 面板里也要能看到缺字体一类的失败原因。
    if (format === 'pdf') exportMessage.value = message
  } finally {
    exportBusy.value = false
  }
}

async function cancelExport() {
  const job = exportJob.value
  if (!job?.id) return
  exportBusy.value = true
  try {
    const result: any = await call('cancelJob', { id: job.id })
    exportJob.value = result?.job ?? exportJob.value
    exportDownload.value = null
    exportFailedDownload.value = null
    status.value = '已取消导出'
  } catch (error) {
    status.value = errorText(error)
  } finally {
    exportBusy.value = false
    syncExportTimer()
  }
}


type DownloadScope = 'rest' | 'all' | 'range'
const downloadScope = ref<DownloadScope>('rest')
const downloadFrom = ref(1)
const downloadTo = ref(1)
const downloadJob = ref<any>(null)
const downloadSummary = ref<any>(null)
const downloadBusy = ref(false)
const downloadDeleting = ref(false)
const deleteConfirmOpen = ref(false)
const chapterError = ref('')
let downloadTimer: ReturnType<typeof setInterval> | null = null
let downloadSummaryAt = 0

function formatBytes(value: number) {
  const size = Number(value) || 0
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 ** 3) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size < 1024 ** 4) return `${(size / 1024 ** 3).toFixed(1)} GB`
  return `${(size / 1024 ** 4).toFixed(2)} TB`
}

// 存储页：三类缓存用量、媒体配额与按书清理。
const storageUsage = ref<any>(null)
const storageBusy = ref(false)
const storageMessage = ref('')
const quotaDraft = ref(0)
const quotaSaving = ref(false)
const storageClearBook = ref('')
const storageClearing = ref('')
const storageClearAllOpen = ref(false)
const storageClearAllBusy = ref(false)
const storageClearAllCachesOpen = ref(false)
const storageClearAllCachesBusy = ref(false)

const storageBooks = computed<any[]>(() =>
  Array.isArray(storageUsage.value?.books) ? storageUsage.value.books : [],
)

const quotaSourceText = computed(() => {
  const source = storageUsage.value?.quota?.source
  if (source === 'env') return '环境变量'
  if (source === 'settings') return '设置'
  return '默认'
})

async function loadStorageUsage() {
  storageBusy.value = true
  try {
    const result = await call('getStorageUsage')
    storageUsage.value = result
    // 设置里存 0 表示跟随默认，界面也回填 0。
    const settingsBytes = Number(result?.quota?.settingsBytes ?? 0)
    quotaDraft.value = Math.round((settingsBytes / 1024 ** 3) * 10) / 10
    storageMessage.value = ''
  } catch (error) {
    storageMessage.value = `统计失败：${errorText(error)}`
  } finally {
    storageBusy.value = false
  }
}

async function saveMediaQuota() {
  const gb = Number(quotaDraft.value)
  if (!Number.isFinite(gb) || gb < 0) {
    storageMessage.value = '配额要填 0 或更大的数'
    return
  }
  quotaSaving.value = true
  try {
    await call('setMediaQuota', { bytes: Math.round(gb * 1024 ** 3) })
    storageMessage.value = gb > 0 ? `配额已设为 ${gb} GB` : '已改用默认配额'
    await loadStorageUsage()
  } catch (error) {
    storageMessage.value = `保存失败：${errorText(error)}`
  } finally {
    quotaSaving.value = false
  }
}

async function clearStorageForBook(bookId: string) {
  storageClearing.value = bookId
  try {
    const result = await call('clearBookStorage', { bookId })
    const textBytes = formatBytes(Number(result?.text?.bytes ?? 0))
    const mediaBytes = formatBytes(Number(result?.media?.bytes ?? 0))
    storageMessage.value = `已清理文字 ${textBytes}、媒体 ${mediaBytes}`
    await loadStorageUsage()
  } catch (error) {
    storageMessage.value = `清理失败：${errorText(error)}`
  } finally {
    storageClearing.value = ''
    storageClearBook.value = ''
  }
}

async function clearAllMediaStorage() {
  storageClearAllBusy.value = true
  try {
    const result = await call('clearAllMedia')
    const bytes = formatBytes(Number(result?.bytes ?? 0))
    storageMessage.value = `已清空媒体 ${bytes}（${Number(result?.removed ?? 0)} 章）`
    await loadStorageUsage()
  } catch (error) {
    storageMessage.value = `清理失败：${errorText(error)}`
  } finally {
    storageClearAllBusy.value = false
    storageClearAllOpen.value = false
  }
}

async function clearAllCachesStorage() {
  storageClearAllCachesBusy.value = true
  try {
    const result = await call('clearAllCaches')
    const text = formatBytes(Number(result?.text?.bytes ?? 0))
    const media = formatBytes(Number(result?.media?.bytes ?? 0))
    storageMessage.value = `已清空全部缓存（文字 ${text}、媒体 ${media}）`
    await loadStorageUsage()
  } catch (error) {
    storageMessage.value = `清理失败：${errorText(error)}`
  } finally {
    storageClearAllCachesBusy.value = false
    storageClearAllCachesOpen.value = false
  }
}

// 切到存储页时刷新一次，配额或清理改动后也会再刷。
watch(view, (next) => {
  if (next === 'storage') void loadStorageUsage()
})

function isDownloadRunning(job: any) {
  return job?.status === 'running' || job?.status === 'queued'
}

function downloadStatusText(job: any) {
  if (!job) return ''
  if (job.status === 'paused') return job.error === '宿主重启' ? '已暂停（宿主重启）' : '已暂停'
  if (job.status === 'queued') return '排队中'
  if (job.status === 'running') return '下载中'
  if (job.status === 'done') return '已完成'
  if (job.status === 'cancelled') return '已取消'
  return job.status === 'failed' ? '失败' : String(job.status)
}

function downloadPercent(job: any) {
  const total = Number(job?.total) || 0
  if (!total) return 0
  const handled = Number(job.completed) + Number(job.failed) + Number(job.skipped)
  return Math.max(0, Math.min(100, Math.round((handled / total) * 100)))
}

function stopDownloadTimer() {
  if (downloadTimer !== null) {
    clearInterval(downloadTimer)
    downloadTimer = null
  }
}

function syncDownloadTimer() {
  if (isDownloadRunning(downloadJob.value)) {
    if (downloadTimer === null) downloadTimer = setInterval(refreshDownloadJob, 600)
  } else {
    stopDownloadTimer()
  }
}

async function refreshDownloadJob() {
  const job = downloadJob.value
  if (!job?.id) return
  try {
    const result: any = await call('getJob', { id: job.id })
    downloadJob.value = result?.job ?? downloadJob.value
  } catch (error) {
    status.value = errorText(error)
  }
  // 下载中每 5 秒刷新一次聚合（索引随完成章增长）；结束/暂停时立即刷新。
  if (!isDownloadRunning(downloadJob.value) || Date.now() - downloadSummaryAt > 5000) {
    void refreshDownloadSummary()
  }
  syncDownloadTimer()
}

/** 详情页的下载统计：索引聚合在服务端算好，这里只负责显示。 */
async function refreshDownloadSummary() {
  const book = currentBook.value as any
  if (!book?.id) {
    downloadSummary.value = null
    return
  }
  try {
    const result: any = await call('getDownloadSummary', {
      bookId: book.id,
      total: chapters.value.length,
    })
    downloadSummary.value = result?.summary ?? null
    downloadSummaryAt = Date.now()
  } catch {
    // 统计失败不影响下载/阅读，按无索引显示。
    downloadSummary.value = null
  }
}

async function loadActiveDownload() {
  downloadJob.value = null
  downloadSummary.value = null
  deleteConfirmOpen.value = false
  const book = currentBook.value as any
  downloadFrom.value = 1
  downloadTo.value = Math.max(1, chapters.value.length)
  if (!book?.id) {
    syncDownloadTimer()
    return
  }
  void refreshDownloadSummary()
  try {
    const result: any = await call('listJobs', { bookId: book.id, kind: 'download' })
    const jobs: any[] = Array.isArray(result?.jobs) ? result.jobs : []
    const active = jobs.find((job) => ['queued', 'running', 'paused'].includes(job.status))
    downloadJob.value = active ?? jobs[0] ?? null
  } catch {
    downloadJob.value = null
  }
  syncDownloadTimer()
}

/** 按书删除已下载：只清文字缓存与索引，书、进度、书签、笔记都在。 */
async function deleteDownloaded() {
  const book = currentBook.value as any
  if (!book?.id) return
  deleteConfirmOpen.value = false
  downloadDeleting.value = true
  try {
    const result: any = await call('deleteDownloads', { bookId: book.id })
    status.value = `已删除 ${result?.removed ?? 0} 章的下载`
    await loadActiveDownload()
  } catch (error) {
    status.value = errorText(error)
  } finally {
    downloadDeleting.value = false
  }
}

async function startDownload() {
  const book = currentBook.value as any
  if (!book?.id) return
  const args: any = { bookId: book.id }
  if (downloadScope.value === 'all') {
    args.all = true
  } else if (downloadScope.value === 'range') {
    const last = Math.max(1, chapters.value.length)
    const from = Math.max(1, Math.min(last, Number(downloadFrom.value) || 1))
    const to = Math.max(from, Math.min(last, Number(downloadTo.value) || last))
    args.fromIndex = from - 1
    args.toIndex = to - 1
  } else {
    args.fromIndex = Math.max(0, Number(progress.value?.chapterIndex ?? 0) || 0)
  }
  downloadBusy.value = true
  try {
    const result: any = await call('startDownload', args)
    downloadJob.value = result?.job ?? null
    status.value = result?.existing ? '已有进行中的下载' : '已开始下载'
    void refreshDownloadSummary()
    syncDownloadTimer()
  } catch (error) {
    status.value = errorText(error)
  } finally {
    downloadBusy.value = false
  }
}

async function controlDownload(method: string, message: string) {
  const job = downloadJob.value
  if (!job?.id) return
  downloadBusy.value = true
  try {
    const result: any = await call(method, { id: job.id })
    downloadJob.value = result?.job ?? downloadJob.value
    status.value = message
  } catch (error) {
    status.value = errorText(error)
  } finally {
    downloadBusy.value = false
    void refreshDownloadSummary()
    syncDownloadTimer()
  }
}

function pauseDownload() {
  void controlDownload('pauseJob', '已暂停下载')
}

function resumeDownload() {
  void controlDownload('resumeJob', '继续下载')
}

function cancelDownload() {
  void controlDownload('cancelJob', '已取消下载')
}

function retryDownload() {
  void controlDownload('retryDownload', '重试失败章节')
}

type MediaScope = 'current' | 'all' | 'range'
const mediaScope = ref<MediaScope>('current')
const mediaFrom = ref(1)
const mediaTo = ref(1)
const mediaJob = ref<any>(null)
const mediaQuotaWarning = ref('')
const mediaSummary = ref<any>(null)
const mediaBusy = ref(false)
const mediaDeleting = ref(false)
const mediaDeleteConfirmOpen = ref(false)
let mediaTimer: ReturnType<typeof setInterval> | null = null
let mediaSummaryAt = 0

function mediaUnit() {
  return mediaSummary.value?.kind === 'image' ? '章' : '个'
}

function stopMediaTimer() {
  if (mediaTimer !== null) {
    clearInterval(mediaTimer)
    mediaTimer = null
  }
}

function syncMediaTimer() {
  if (isDownloadRunning(mediaJob.value)) {
    if (mediaTimer === null) mediaTimer = setInterval(refreshMediaJob, 600)
  } else {
    stopMediaTimer()
  }
}

/** 媒体作业与文字作业共用 jobs 表结构，进度文案复用同一套函数。 */
async function refreshMediaJob() {
  const job = mediaJob.value
  if (!job?.id) return
  try {
    const result: any = await call('getJob', { id: job.id })
    mediaJob.value = result?.job ?? mediaJob.value
  } catch (error) {
    status.value = errorText(error)
  }
  if (!isDownloadRunning(mediaJob.value) || Date.now() - mediaSummaryAt > 5000) {
    void refreshMediaSummary()
  }
  syncMediaTimer()
  if (!isDownloadRunning(mediaJob.value)) void reopenReaderAfterMediaRetry()
}

/** 媒体离线统计：服务端按书聚合条目，kind 为空表示不是媒体书。 */
async function refreshMediaSummary() {
  const book = currentBook.value as any
  if (!book?.id) {
    mediaSummary.value = null
    return
  }
  try {
    const result: any = await call('getMediaDownloadSummary', {
      bookId: book.id,
      total: chapters.value.length,
    })
    mediaSummary.value = result?.summary ?? null
    mediaSummaryAt = Date.now()
  } catch {
    mediaSummary.value = null
  }
}

async function loadActiveMedia() {
  mediaJob.value = null
  mediaSummary.value = null
  mediaDeleteConfirmOpen.value = false
  mediaScope.value = 'current'
  mediaFrom.value = 1
  mediaTo.value = Math.max(1, chapters.value.length)
  const book = currentBook.value as any
  if (!book?.id) {
    syncMediaTimer()
    return
  }
  void refreshMediaSummary()
  try {
    const result: any = await call('listJobs', { bookId: book.id, kind: 'media-download' })
    const jobs: any[] = Array.isArray(result?.jobs) ? result.jobs : []
    const active = jobs.find((job) => ['queued', 'running', 'paused'].includes(job.status))
    mediaJob.value = active ?? jobs[0] ?? null
  } catch {
    mediaJob.value = null
  }
  syncMediaTimer()
}

async function startMediaDownload() {
  const book = currentBook.value as any
  if (!book?.id) return
  const args: any = { bookId: book.id }
  if (mediaScope.value === 'all') {
    args.all = true
  } else if (mediaScope.value === 'range') {
    const last = Math.max(1, chapters.value.length)
    const from = Math.max(1, Math.min(last, Number(mediaFrom.value) || 1))
    const to = Math.max(from, Math.min(last, Number(mediaTo.value) || last))
    args.fromIndex = from - 1
    args.toIndex = to - 1
  } else {
    // 当前章：起止都钉在同一章，避免只给起点被当作「从这章到末尾」。
    const index = Math.max(0, Number(progress.value?.chapterIndex ?? 0) || 0)
    args.fromIndex = index
    args.toIndex = index
  }
  mediaBusy.value = true
  mediaQuotaWarning.value = ''
  try {
    const result: any = await call('startMediaDownload', args)
    mediaJob.value = result?.job ?? null
    mediaQuotaWarning.value = String(result?.warning ?? '')
    status.value = result?.existing ? '已有进行中的离线下载' : '已开始离线下载'
    void refreshMediaSummary()
    syncMediaTimer()
  } catch (error) {
    status.value = errorText(error)
  } finally {
    mediaBusy.value = false
  }
}

async function controlMediaDownload(method: string, message: string) {
  const job = mediaJob.value
  if (!job?.id) return
  mediaBusy.value = true
  try {
    const result: any = await call(method, { id: job.id })
    mediaJob.value = result?.job ?? mediaJob.value
    status.value = message
  } catch (error) {
    status.value = errorText(error)
  } finally {
    mediaBusy.value = false
    void refreshMediaSummary()
    syncMediaTimer()
  }
}

function pauseMediaDownload() {
  void controlMediaDownload('pauseJob', '已暂停离线下载')
}

function resumeMediaDownload() {
  void controlMediaDownload('resumeJob', '继续离线下载')
}

function cancelMediaDownload() {
  void controlMediaDownload('cancelJob', '已取消离线下载')
}

function retryMediaDownload() {
  void controlMediaDownload('retryDownload', '重试失败章节')
}

/** 阅读页「重新下载本章」：只重下当前章，完成后自动重开本章；不静默、不循环。 */
async function retryReaderMedia() {
  const book = currentBook.value as any
  const index = readerMediaRetryChapter.value
  const chapter = index === null ? null : chapters.value[index]
  if (!book?.id || !chapter?.url || index === null || readerMediaRetryBusy.value || readerMediaRetryUsed || !readerMediaRetryAvailable.value) return
  readerMediaRetryUsed = true
  readerMediaRetryBusy.value = true
  try {
    const result: any = await call('startMediaDownload', {
      bookId: book.id,
      fromIndex: index,
      toIndex: index,
      // 索引可能仍然自洽（同长度损坏），必须让服务端跳过续跑，真正重抓这一章。
      forceChapterIndex: index,
    })
    mediaJob.value = result?.job ?? null
    mediaQuotaWarning.value = String(result?.warning ?? '')
    if (result?.existing) {
      // 已有作业不会带上强制重下标记；不消耗这一次额度，让用户等它收尾后再点。
      readerMediaRetryUsed = false
      readerMediaRetryAvailable.value = true
      readerMediaNotice.value = `已有离线下载在进行，完成后再重下第 ${index + 1} 章。`
      status.value = '已有进行中的离线下载'
      void refreshMediaSummary()
      syncMediaTimer()
      return
    }
    readerMediaRetryAvailable.value = false
    readerMediaNotice.value = `已开始重新下载第 ${index + 1} 章，完成后会重新打开本章。`
    status.value = '已开始重新下载本章'
    void refreshMediaSummary()
    syncMediaTimer()
    if (!isDownloadRunning(mediaJob.value)) void reopenReaderAfterMediaRetry()
  } catch (error) {
    readerMediaRetryUsed = false
    readerMediaRetryAvailable.value = true
    readerMediaNotice.value = `重新下载第 ${index + 1} 章失败：${errorText(error)}`
    status.value = errorText(error)
  } finally {
    readerMediaRetryBusy.value = false
  }
}

let readerMediaReopening = false
/** 重下结束后只重开仍停留在阅读页的同一章；用户已离开就只清掉等待目标。 */
async function reopenReaderAfterMediaRetry() {
  const index = readerMediaRetryChapter.value
  if (index === null || readerMediaReopening || isDownloadRunning(mediaJob.value)) return
  const jobStatus = String(mediaJob.value?.status ?? '')
  if (jobStatus === 'failed' || jobStatus === 'cancelled') {
    readerMediaNotice.value = `重新下载第 ${index + 1} 章失败：${String(mediaJob.value?.error ?? '未知错误').slice(0, 120)}`
    readerMediaRetryChapter.value = null
    return
  }
  if (jobStatus !== 'done') return
  const chapter = chapters.value[index]
  if (!chapter || view.value !== 'reader' || currentChapter.value !== chapter) {
    readerMediaRetryChapter.value = null
    return
  }
  readerMediaReopening = true
  try {
    const page = progress.value?.chapterUrl === chapter.url ? Number(progress.value.position ?? 0) || 0 : 0
    await openChapter(chapter, page, { afterMediaRetry: true })
  } finally {
    readerMediaReopening = false
    readerMediaRetryChapter.value = null
  }
}

/** 按书删除媒体离线文件与索引；文字缓存、书与进度保留。 */
async function deleteMediaDownloaded() {
  const book = currentBook.value as any
  if (!book?.id) return
  mediaDeleteConfirmOpen.value = false
  mediaDeleting.value = true
  try {
    const result: any = await call('deleteMediaDownloads', { bookId: book.id })
    status.value = `已删除 ${result?.removed ?? 0} ${mediaUnit()}离线媒体`
    await loadActiveMedia()
  } catch (error) {
    status.value = errorText(error)
  } finally {
    mediaDeleting.value = false
  }
}

watch(view, (next) => {
  if (next === 'detail') {
    void loadActiveDownload()
    void loadActiveMedia()
    void loadActiveExport()
  } else {
    stopDownloadTimer()
    stopMediaTimer()
    stopExportTimer()
  }
})

onUnmounted(() => {
  stopDownloadTimer()
  stopMediaTimer()
  stopExportTimer()
  if (settingsPersistTimer) clearTimeout(settingsPersistTimer)
  if (autoPageTimer) {
    clearInterval(autoPageTimer)
    autoPageTimer = undefined
  }
  window.removeEventListener('keydown', onReaderEscape)
  document.removeEventListener('visibilitychange', onReaderVisibilityChange)
  window.speechSynthesis?.removeEventListener?.('voiceschanged', loadSpeechVoices)
  clearSpeechVoiceWait()
  stopSpeech()
  if (readerHintTimer) clearTimeout(readerHintTimer)
  releaseKeepAwake()
})

const reviewOpen = ref(false)
const reviewBusy = ref(false)
const reviewRows = ref<Array<{ index: number; count: number; data: string }>>([])
const reviewMessage = ref('')

async function openReview() {
  const book = currentBook.value as any
  if (!book) return
  if (String(book.origin ?? '').startsWith('local')) {
    status.value = '本地书没有段评'
    return
  }
  const chapter = chapters.value[chapterIndex.value]
  if (!chapter) return
  reviewOpen.value = true
  reviewBusy.value = true
  reviewRows.value = []
  reviewMessage.value = ''
  try {
    const result = await call('getReviewSummary', {
      sourceUrl: book.origin,
      bookUrl: book.bookUrl,
      bookName: book.name,
      bookAuthor: book.author,
      chapterUrl: chapter.url,
      chapterTitle: chapter.title,
      chapterIndex: chapter.index ?? chapterIndex.value,
    })
    if (!result?.supported) {
      reviewMessage.value = result?.reason || '该源未配置段评'
    } else {
      const counts = (result.counts ?? {}) as Record<string, number>
      const keys = (result.keys ?? {}) as Record<string, string>
      reviewRows.value = Object.keys(counts)
        .map((key) => Number(key))
        .filter((index) => Number(counts[index]) > 0)
        .sort((a, b) => a - b)
        .map((index) => ({ index, count: Number(counts[index]), data: String(keys[index] ?? '') }))
      if (reviewRows.value.length === 0) reviewMessage.value = '本章没有段评'
    }
  } catch (error) {
    reviewMessage.value = errorText(error)
  } finally {
    reviewBusy.value = false
  }
}

const shelfGroups = computed(() => {
  const groups = new Set<string>()
  for (const book of shelfBooks.value) {
    const group = String(book.group ?? '').trim()
    if (group) groups.add(group)
  }
  return [...groups]
})
function sortTime(book: any): number {
  const raw = Number(book?.lastReadAt) || (typeof book?.updatedAt === 'string' ? Date.parse(book.updatedAt) : Number(book?.updatedAt)) || 0
  return Number.isFinite(raw) ? raw : 0
}

const shelfSortedBooks = computed(() => {
  let list = [...shelfBooks.value]
  if (shelfGroup.value) list = list.filter((book) => String(book.group ?? '') === shelfGroup.value)
  if (shelfSort.value === 'name') {
    list.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh'))
  } else if (shelfSort.value === 'progress') {
    list.sort((a, b) => Number(b.progress?.chapterIndex ?? -1) - Number(a.progress?.chapterIndex ?? -1))
  } else {
    list.sort((a, b) => sortTime(b) - sortTime(a))
  }
  list.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
  return list
})
const selectedBookCount = computed(() => selectedBookIds.value.size)

function coverStyle(book: any) {
  const name = String(book?.name ?? '')
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  const hue = hash % 360
  return {
    background: `linear-gradient(150deg, hsl(${hue} 24% 44%), hsl(${(hue + 46) % 360} 26% 26%))`,
  }
}

async function importSources() {
  if (!importText.value.trim()) return
  busy.value = true
  importMessage.value = ''
  try {
    const result = await call('importSources', { payload: importText.value })
    importMessage.value =
      `导入 ${result.total} 条：新增 ${result.added}，更新 ${result.updated}` +
      (result.errors?.length ? `，失败 ${result.errors.length}（${result.errors[0].message}）` : '')
    importText.value = ''
    await refresh()
  } catch (error) {
    importMessage.value = errorText(error)
  } finally {
    busy.value = false
  }
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    importText.value = await file.text()
    await importSources()
  } catch (error) {
    importMessage.value = errorText(error)
  } finally {
    input.value = ''
  }
}

async function loadDictRules() {
  try {
    const result = await call('listDictRules')
    dictRules.value = result?.rules ?? []
  } catch (error) {
    dictMessage.value = `字典加载失败：${errorText(error)}`
  }
}

function beginDictEdit(rule?: any) {
  const draft = rule
    ? JSON.parse(JSON.stringify(rule))
    : { name: '', url: '', rule: '', group: '', enabled: true, header: '' }
  if (draft.header && typeof draft.header !== 'string') draft.header = JSON.stringify(draft.header)
  dictEditing.value = draft
  dictMessage.value = ''
}

async function saveDict() {
  if (!dictEditing.value) return
  busy.value = true
  try {
    await call('saveDictRule', { rule: { ...dictEditing.value } })
    dictEditing.value = null
    await loadDictRules()
    dictMessage.value = '字典已保存'
  } catch (error) {
    dictMessage.value = errorText(error)
  } finally {
    busy.value = false
  }
}

async function toggleDictRule(rule: any) {
  try {
    await call('saveDictRule', { rule: { ...rule, enabled: rule.enabled === false } })
    await loadDictRules()
  } catch (error) {
    dictMessage.value = errorText(error)
  }
}

async function removeDictRule(rule: any) {
  try {
    await call('deleteDictRules', { ids: [rule.id] })
    dictResults.value = dictResults.value.filter((item) => item.id !== rule.id)
    if (dictActiveTab.value === rule.id) dictActiveTab.value = dictResults.value[0]?.id ?? ''
    await loadDictRules()
  } catch (error) {
    dictMessage.value = errorText(error)
  }
}

async function moveDictRule(rule: any, delta: number) {
  const list = dictRules.value
  const index = list.findIndex((item) => item.id === rule.id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= list.length) return
  const current = list[index]
  const other = list[target]
  const swap = swapDictOrder(current, other, index, target)
  try {
    await call('saveDictRule', { rule: { ...current, customOrder: swap.currentOrder } })
    await call('saveDictRule', { rule: { ...other, customOrder: swap.otherOrder } })
    await loadDictRules()
  } catch (error) {
    dictMessage.value = errorText(error)
  }
}

async function importDicts() {
  if (!dictImportText.value.trim()) return
  busy.value = true
  dictMessage.value = ''
  try {
    const result = await call('importDictRules', { payload: dictImportText.value })
    dictMessage.value =
      `导入 ${result.total} 条：新增 ${result.added}，更新 ${result.updated}` +
      (result.errors?.length ? `，失败 ${result.errors.length}（${result.errors[0].message}）` : '')
    dictImportText.value = ''
    await loadDictRules()
  } catch (error) {
    dictMessage.value = errorText(error)
  } finally {
    busy.value = false
  }
}

async function onImportDictFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    dictImportText.value = await file.text()
    await importDicts()
  } catch (error) {
    dictMessage.value = errorText(error)
  } finally {
    input.value = ''
  }
}

async function exportDicts() {
  try {
    const rules = await call('exportDictRules')
    if (!Array.isArray(rules) || rules.length === 0) {
      dictMessage.value = '还没有字典，先新增或导入'
      return
    }
    const suffix = new Date().toISOString().slice(0, 10)
    downloadJson(`mo-reader-dicts-${suffix}.json`, rules)
    dictMessage.value = `已导出 ${rules.length} 条字典`
  } catch (error) {
    dictMessage.value = errorText(error)
  }
}

/** 单本字典查询：把 Remote 的错误统一成 Error，交给 lookupAll 做隔离。 */
function lookupOne(ruleId: string, key: string) {
  return call('lookupDict', { ruleId, key }).catch((error: unknown) => {
    throw new Error(errorText(error))
  })
}

async function runDictLookup() {
  const key = dictQuery.value.trim()
  if (!key) {
    dictMessage.value = '请输入要查的词'
    return
  }
  const enabled = enabledDictRules(dictRules.value)
  if (enabled.length === 0) {
    dictMessage.value = '还没有可用的字典'
    return
  }
  dictTrialBusy.value = true
  dictMessage.value = ''
  try {
    dictResults.value = await lookupAll(enabled, key, lookupOne)
    dictActiveTab.value = dictResults.value[0]?.id ?? ''
  } catch (error) {
    dictMessage.value = errorText(error)
  } finally {
    dictTrialBusy.value = false
  }
}

async function writeClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  area.remove()
}

async function copyDictResult(result: DictResult) {
  if (!result?.text) return
  try {
    await writeClipboard(result.text)
    dictMessage.value = `已复制「${result.name}」的释义`
  } catch (error) {
    dictMessage.value = `复制失败：${errorText(error)}`
  }
}

function openDictResult(result: DictResult) {
  if (result?.url) window.open(result.url, '_blank', 'noopener')
}

/** 阅读页长按选词：打开查词面板，有启用字典时立即并发查询。 */
function onReaderSelect(payload: any) {
  if (readerKind.value !== 'text') return
  dictPanelOpen.value = true
  dictPanelText.value = String(payload?.text || '').trim()
  dictPanelLine.value = String(payload?.line || '').trim()
  dictPanelFallback.value = Boolean(payload?.fallback)
  dictPanelError.value = ''
  dictPanelCopied.value = ''
  dictPanelResults.value = []
  dictPanelActive.value = ''
  if (!dictPanelText.value) {
    dictPanelError.value = '没有选中文字，请输入要查的词'
    return
  }
  void runReaderLookup()
}

async function runReaderLookup() {
  const key = dictPanelText.value.trim()
  dictPanelCopied.value = ''
  dictPanelError.value = ''
  if (!key) {
    dictPanelError.value = '请输入要查的词'
    return
  }
  const enabled = enabledDictRules(dictRules.value)
  if (enabled.length === 0) {
    dictPanelResults.value = []
    dictPanelActive.value = ''
    return
  }
  const token = ++dictPanelToken
  dictPanelBusy.value = true
  try {
    const results = await lookupAll(enabled, key, lookupOne)
    if (token !== dictPanelToken) return
    dictPanelResults.value = results
    dictPanelActive.value = results[0]?.id ?? ''
  } catch (error) {
    if (token === dictPanelToken) dictPanelError.value = errorText(error)
  } finally {
    if (token === dictPanelToken) dictPanelBusy.value = false
  }
}

function closeReaderDict() {
  dictPanelOpen.value = false
  dictPanelToken += 1
  dictPanelBusy.value = false
}

async function copyReaderDict(result: DictResult) {
  if (!result?.text) return
  try {
    await writeClipboard(result.text)
    dictPanelCopied.value = `已复制「${result.name}」`
  } catch (error) {
    dictPanelError.value = `复制失败：${errorText(error)}`
  }
}

/** 没有可用字典时，把读者带到「书源 → 字典规则」。 */
function openDictManage() {
  closeReaderDict()
  view.value = 'sources'
  nextTick(() => dictCardRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

async function toggleSource(source: any) {
  try {
    const result = await call('saveSource', {
      source: { ...source, enabled: source.enabled === false },
    })
    Object.assign(source, result.source)
  } catch (error) {
    status.value = errorText(error)
  }
}

async function removeSource(source: any) {
  try {
    await call('deleteSources', { urls: [source.bookSourceUrl] })
    await refresh()
  } catch (error) {
    status.value = errorText(error)
  }
}

function toggleSelectSource(source: any) {
  const next = new Set(selectedSourceIds.value)
  if (next.has(source.id)) next.delete(source.id)
  else next.add(source.id)
  selectedSourceIds.value = next
}

function toggleSelectPage() {
  const next = new Set(selectedSourceIds.value)
  if (allPageSelected.value) {
    for (const source of pagedSources.value) next.delete(source.id)
  } else {
    for (const source of pagedSources.value) next.add(source.id)
  }
  selectedSourceIds.value = next
}

async function batchSetEnabled(enabled: boolean) {
  const ids = [...selectedSourceIds.value]
  if (ids.length === 0) return
  busy.value = true
  try {
    const result = await call('setSourcesEnabled', { ids, enabled })
    selectedSourceIds.value = new Set()
    await refresh()
    status.value = `已${enabled ? '启用' : '禁用'} ${result.updated} 个书源`
  } catch (error) {
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

function sourceNameOf(url: string): string {
  return sources.value.find((source) => source.bookSourceUrl === url)?.bookSourceName || url
}

function safeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 40) || 'source'
}

function exportStamp(): string {
  return new Date().toISOString().slice(0, 10)
}

async function exportSource(source: any) {
  try {
    const result = await call('exportSources', { ids: [source.id] })
    downloadJson(
      `mo-reader-source-${safeFileName(source.bookSourceName || 'source')}-${exportStamp()}.json`,
      JSON.parse(result.json),
    )
    sourceMessage.value = `已导出「${source.bookSourceName || '书源'}」`
  } catch (error) {
    sourceMessage.value = errorText(error)
  }
}

async function exportSelectedSources() {
  const ids = [...selectedSourceIds.value]
  if (ids.length === 0) return
  try {
    const result = await call('exportSources', { ids })
    downloadJson(`mo-reader-sources-${exportStamp()}.json`, JSON.parse(result.json))
    sourceMessage.value = `已导出 ${result.count} 个书源`
  } catch (error) {
    sourceMessage.value = errorText(error)
  }
}

/** 在线可达性：只查地址能不能打开，与静态结构检查（checkReport）分开显示。 */
async function runOnlineSourceCheck() {
  const list = onlineCheckTargets.value
  if (list.length === 0) {
    sourceMessage.value = '没有可检查的地址'
    return
  }
  const scope = selectedCount.value > 0 ? 'selected' : 'page'
  const urls = list.map((source) => String(source.bookSourceUrl).trim())
  onlineCheckBusy.value = true
  try {
    const result = await call('checkSources', { urls })
    const results = result.results as Array<{
      url: string
      ok: boolean
      status: number | null
      elapsedMs: number
      error: string
    }>
    const ok = results.filter((item) => item.ok).length
    onlineCheckReport.value = { scope, total: results.length, ok, results }
    sourceMessage.value = `在线可达 ${ok}/${results.length}`
  } catch (error) {
    sourceMessage.value = errorText(error)
  } finally {
    onlineCheckBusy.value = false
  }
}

function runSourceCheck() {
  const list = filteredSortedSources.value
  const problems: Array<{ name: string; message: string }> = []
  for (const source of list) {
    const messages: string[] = []
    if (!source.bookSourceUrl) messages.push('缺少地址')
    if (!source.bookSourceName) messages.push('缺少名称')
    if (!source.searchUrl && !source.ruleSearch?.bookList) messages.push('缺少搜索地址/规则')
    if (!source.ruleToc?.chapterList) messages.push('缺少目录规则')
    if (!source.ruleContent?.content) messages.push('缺少正文规则')
    if (messages.length > 0) {
      problems.push({ name: source.bookSourceName || source.bookSourceUrl, message: messages.join('、') })
    }
  }
  checkReport.value = { total: list.length, ok: list.length - problems.length, problems }
  status.value = `检查 ${list.length} 个：通过 ${list.length - problems.length}，问题 ${problems.length}`
}

function beginEdit(source: any) {
  editing.value = JSON.parse(JSON.stringify(source))
  editingJson.value = JSON.stringify(source, null, 2)
  debugResult.value = null
  debugInput.value = ''
}

async function saveEditing() {
  if (!editing.value) return
  try {
    const parsed = JSON.parse(editingJson.value)
    const merged = {
      ...parsed,
      bookSourceName: editing.value.bookSourceName,
      bookSourceUrl: editing.value.bookSourceUrl,
      bookSourceGroup: editing.value.bookSourceGroup,
      bookSourceType: editing.value.bookSourceType,
      enabled: editing.value.enabled,
      enabledExplore: editing.value.enabledExplore,
    }
    const result = await call('saveSource', { source: merged })
    editing.value = JSON.parse(JSON.stringify(result.source))
    editingJson.value = JSON.stringify(result.source, null, 2)
    await refresh()
    status.value = '书源已保存'
  } catch (error) {
    status.value = errorText(error)
  }
}

async function runDebug() {
  if (!editing.value) return
  debugBusy.value = true
  debugResult.value = null
  try {
    const args: any = { sourceUrl: editing.value.bookSourceUrl, type: debugType.value }
    if (debugType.value === 'search') args.key = debugInput.value.trim() || '测试'
    else args.url = debugInput.value.trim()
    debugResult.value = await call('debugSource', args)
  } catch (error) {
    debugResult.value = { error: errorText(error) }
  } finally {
    debugBusy.value = false
  }
}

async function search() {
  const key = searchKey.value.trim()
  if (!key) return
  searching.value = true
  books.value = []
  searchErrors.value = []
  try {
    const args: any = { key, page: 1 }
    if (scopedSourceUrls.value) args.sourceUrls = scopedSourceUrls.value
    const result = await call('searchBooks', args)
    let list = result.books ?? []
    if (searchExact.value) list = list.filter((book: any) => String(book.name ?? '').trim() === key.trim())
    books.value = list
    searchErrors.value = result.errors ?? []
    rememberSearch(key)
    status.value = `搜索到 ${books.value.length} 本，失败 ${searchErrors.value.length} 个源`
  } catch (error) {
    status.value = errorText(error)
  } finally {
    searching.value = false
  }
}

function rememberSearch(key: string) {
  const next = [key, ...searchHistory.value.filter((item) => item !== key)].slice(0, 10)
  searchHistory.value = next
  try {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式下 localStorage 可能不可用
  }
}

function useHistory(key: string) {
  searchKey.value = key
  void search()
}

function openExplore() {
  view.value = 'explore'
  void loadExploreGroups()
}

async function loadExploreGroups(force = false) {
  if (exploreLoading.value) return
  if (!force && exploreGroups.value.length) return
  exploreLoading.value = true
  if (force) exploreGroups.value = []
  exploreActive.value = null
  exploreBooks.value = []
  explorePage.value = 0
  exploreHasMore.value = false
  exploreError.value = ''
  try {
    const result = await call('listExploreSources')
    const list: any[] = result?.sources ?? []
    exploreSources.value = list
    const settled = await Promise.allSettled(
      list.map(async (source) => {
        const res = await call('getExploreCategories', { sourceUrl: source.bookSourceUrl })
        return { source, categories: res?.categories ?? [], error: '' }
      }),
    )
    exploreGroups.value = settled.map((item, index) => {
      if (item.status === 'fulfilled') return item.value
      const source = list[index]
      return {
        source,
        categories: [],
        error: `${source?.bookSourceName || source?.bookSourceUrl || '未知书源'}：${errorText(item.reason)}`,
      }
    })
    status.value = `发现 ${list.length} 个书源`
  } catch (error) {
    exploreGroups.value = []
    exploreError.value = errorText(error)
    status.value = exploreError.value
  } finally {
    exploreLoading.value = false
  }
}

function isActiveCategory(group: any, category: any) {
  return (
    exploreActive.value?.sourceUrl === group.source.bookSourceUrl &&
    exploreActive.value?.url === category.url
  )
}

async function selectExploreCategory(group: any, category: any) {
  exploreActive.value = {
    sourceUrl: group.source.bookSourceUrl,
    sourceName: group.source.bookSourceName,
    name: category.name,
    url: category.url,
  }
  exploreError.value = ''
  await loadExplorePage(1, true)
}

async function loadExplorePage(page: number, replace: boolean) {
  if (!exploreActive.value) return
  exploreBusy.value = true
  exploreError.value = ''
  if (replace) {
    exploreBooks.value = []
    explorePage.value = 0
    exploreHasMore.value = false
  }
  try {
    const result = await call('exploreBooks', {
      sourceUrl: exploreActive.value.sourceUrl,
      categoryUrl: exploreActive.value.url,
      page,
    })
    const list = result?.books ?? []
    if (replace) {
      exploreBooks.value = list
    } else {
      // 有的源会忽略页码返回同一页，追加时按书目去重，避免重复行。
      const seen = new Set(exploreBooks.value.map((book: any) => `${book.origin}|${book.bookUrl}`))
      const fresh = list.filter((book: any) => {
        const key = `${book.origin}|${book.bookUrl}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      exploreBooks.value = [...exploreBooks.value, ...fresh]
    }
    explorePage.value = Number(result?.page ?? page)
    exploreHasMore.value = Boolean(result?.hasMore)
    status.value = `${exploreActive.value.name} · ${exploreBooks.value.length} 本`
  } catch (error) {
    exploreError.value = errorText(error)
    exploreHasMore.value = false
    status.value = exploreError.value
  } finally {
    exploreBusy.value = false
  }
}

async function loadToc(book: any, tocUrlFallback: string) {
  const toc = await call('getToc', {
    sourceUrl: book.origin,
    tocUrl: book.tocUrl || tocUrlFallback,
  })
  chapters.value = toc.chapters ?? []
  if (currentBook.value?.id && view.value === 'detail') void refreshDownloadSummary()
}

/** 本地书详情页的 PDF 状态：旧版本导入的 PDF 没有原文件，需要提示重新导入补齐。 */
async function loadLocalPdfStatus(book: any) {
  localPdfStatus.value = null
  if (!book || book.origin !== 'local' || !book.id) return
  try {
    localPdfStatus.value = await call('getLocalPdfStatus', { bookId: book.id })
  } catch {
    localPdfStatus.value = null
  }
}

async function openBook(book: any) {
  busy.value = true
  chapterError.value = ''
  downloadSummary.value = null
  localPdfStatus.value = null
  try {
    const info = await call('getBookInfo', { sourceUrl: book.origin, bookUrl: book.bookUrl })
    currentBook.value = { ...book, ...info.info, tocUrl: info.info.tocUrl || book.bookUrl }
    if (settingsScope.value === 'book') await loadSettings()
    await loadToc(currentBook.value, book.bookUrl)
    await loadLocalPdfStatus(currentBook.value)
    await loadBookmarks()
    await loadNotes()
    progress.value = null
    tocFilter.value = ''
    tocPage.value = 1
    view.value = 'detail'
    status.value = `${currentBook.value.name} · ${chapters.value.length} 章`
  } catch (error) {
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

async function openShelfBook(book: any) {
  busy.value = true
  chapterError.value = ''
  downloadSummary.value = null
  currentBook.value = { ...book }
  if (settingsScope.value === 'book') await loadSettings()
  chapters.value = []
  try {
    await loadToc(currentBook.value, book.bookUrl)
    await loadBookmarks()
    await loadNotes()
    const result = await call('getProgress', { bookId: book.id })
    progress.value = result?.progress ?? null
    await loadLocalPdfStatus(book)
    tocFilter.value = ''
    tocPage.value = 1
    view.value = 'detail'
    status.value = `${book.name} · ${chapters.value.length} 章`
  } catch (error) {
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

function toggleShelfSelect(book: any) {
  const next = new Set(selectedBookIds.value)
  if (next.has(book.id)) next.delete(book.id)
  else next.add(book.id)
  selectedBookIds.value = next
}

async function applyGroupToSelected() {
  const ids = [...selectedBookIds.value]
  if (!ids.length) return
  busy.value = true
  try {
    for (const id of ids) await call('updateBook', { id, patch: { group: shelfGroupInput.value.trim() } })
    status.value = `已分组 ${ids.length} 本`
    exitShelfSelect()
    await refresh()
  } catch (error: any) {
    status.value = `分组失败：${error?.message ?? error}`
  } finally {
    busy.value = false
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function fontFaceName(id: string): string {
  return `MoReaderFont_${id.replace(/[^a-zA-Z0-9]/g, '')}`
}

async function applyCustomFont(id: string) {
  if (!id) {
    activeFontFamily.value = ''
    return
  }
  const cached = loadedFonts.get(id)
  if (cached) {
    activeFontFamily.value = cached.family
    return
  }
  try {
    const result = await call('getFont', { id })
    const bytes = fromBase64(result.dataBase64)
    const face = new FontFace(fontFaceName(id), bytes.buffer as ArrayBuffer)
    await face.load()
    document.fonts.add(face)
    loadedFonts.set(id, face)
    activeFontFamily.value = face.family
    fontMessage.value = ''
  } catch (error) {
    activeFontFamily.value = ''
    settings.value.fontId = ''
    fontMessage.value = `字体加载失败，已回退默认字体：${errorText(error)}`
  }
}

async function selectFont(event: Event) {
  const id = (event.target as HTMLSelectElement).value
  settings.value.fontId = id
  await applyCustomFont(id)
  await persistSettings()
}

async function uploadFontFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 20 * 1024 * 1024) {
    fontMessage.value = '字体文件不能超过 20MB'
    return
  }
  busy.value = true
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const result = await call('uploadFont', { fileName: file.name, dataBase64: toBase64(bytes) })
    const list = await call('listFonts')
    customFonts.value = list?.fonts ?? []
    exportFontId.value = result.font.id
    settings.value.fontId = result.font.id
    await applyCustomFont(settings.value.fontId)
    await persistSettings()
    fontMessage.value = result.created ? `已上传并应用「${result.font.name}」` : `字体已存在，直接应用「${result.font.name}」`
  } catch (error) {
    fontMessage.value = `字体上传失败：${errorText(error)}`
  } finally {
    busy.value = false
  }
}

async function deleteFont(font: { id: string; name: string }) {
  busy.value = true
  try {
    await call('deleteFont', { id: font.id })
    const loaded = loadedFonts.get(font.id)
    if (loaded) document.fonts.delete(loaded)
    loadedFonts.delete(font.id)
    if (settings.value.fontId === font.id) {
      settings.value.fontId = ''
      activeFontFamily.value = ''
      await persistSettings()
    }
    const list = await call('listFonts')
    customFonts.value = list?.fonts ?? []
    syncExportFont()
    fontMessage.value = `已删除「${font.name}」`
  } catch (error) {
    fontMessage.value = `字体删除失败：${errorText(error)}`
  } finally {
    busy.value = false
  }
}

async function commitThemeState(themeId: string, themes: CustomTheme[], message: string) {
  try {
    // 主题列表只存全局；选中的主题按当前作用域写入（本书可单独换主题）。
    if (!deepEqualValue(themes, settings.value.customThemes)) {
      await call('saveSettings', { settings: { customThemes: themes } })
      settings.value.customThemes = themes
      settingsBaseline.value.customThemes = themes
    }
    settings.value.theme = themeId
    await persistSettings()
    themeMessage.value = message
    return true
  } catch (error) {
    themeMessage.value = `主题保存失败：${errorText(error)}`
    return false
  }
}

async function selectTheme(themeId: string) {
  if (settings.value.theme === themeId) return
  const name = isBuiltinThemeName(themeId)
    ? BUILTIN_THEMES[themeId].name
    : settings.value.customThemes.find((item) => item.id === themeId)?.name ?? '主题'
  await commitThemeState(themeId, settings.value.customThemes, `已应用「${name}」`)
}

function startThemeCreate() {
  const colors = activeThemeColors.value
  themeDraft.value = {
    id: '',
    name: '我的主题',
    bg: toHexColor(colors.bg, '#f6f1e7'),
    text: toHexColor(colors.text, '#2b2a26'),
    muted: toHexColor(colors.muted, '#7c7567'),
    line: toHexColor(colors.line, '#d6cec0'),
  }
  themeMessage.value = ''
}

function startThemeEdit() {
  if (!activeCustomTheme.value) return
  const theme = activeCustomTheme.value
  themeDraft.value = {
    id: theme.id,
    name: theme.name,
    bg: toHexColor(theme.bg, '#f6f1e7'),
    text: toHexColor(theme.text, '#2b2a26'),
    muted: toHexColor(theme.muted, '#7c7567'),
    line: toHexColor(theme.line, '#d6cec0'),
  }
  themeMessage.value = ''
}

async function saveThemeDraft() {
  if (!themeDraft.value) return
  try {
    const existing = settings.value.customThemes.find((item) => item.id === themeDraft.value?.id)
    const theme = createCustomTheme(
      {
        name: themeDraft.value.name,
        bg: themeDraft.value.bg,
        text: themeDraft.value.text,
        muted: themeDraft.value.muted,
        line: themeDraft.value.line,
      },
      existing ? { id: existing.id, createdAt: existing.createdAt } : {},
    )
    const themes = existing
      ? settings.value.customThemes.map((item) => (item.id === theme.id ? theme : item))
      : [theme, ...settings.value.customThemes]
    if (await commitThemeState(theme.id, themes, `已保存并应用「${theme.name}」`)) themeDraft.value = null
  } catch (error) {
    themeMessage.value = `主题保存失败：${errorText(error)}`
  }
}

async function deleteActiveTheme() {
  if (!activeCustomTheme.value) return
  const theme = activeCustomTheme.value
  const themes = settings.value.customThemes.filter((item) => item.id !== theme.id)
  const nextTheme = settings.value.theme === theme.id ? 'light' : settings.value.theme
  if (await commitThemeState(nextTheme, themes, `已删除「${theme.name}」`)) themeDraft.value = null
}

async function importThemeFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 1024 * 1024) {
    themeMessage.value = '主题文件不能超过 1MB'
    return
  }
  try {
    const result = parseThemeImport(await file.text())
    const existingIds = new Set(settings.value.customThemes.map((item) => item.id))
    const imported = result.themes.map((theme) =>
      existingIds.has(theme.id) ? createCustomTheme(theme) : theme,
    )
    const themes = [...imported, ...settings.value.customThemes]
    if (await commitThemeState(imported[0].id, themes, `已导入并应用「${imported[0].name}」，共 ${imported.length} 个主题`)) {
      themeDraft.value = null
    }
  } catch (error) {
    themeMessage.value = errorText(error)
  }
}

function downloadJson(fileName: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function exportThemes(kind: 'legado' | 'full') {
  const themes = settings.value.customThemes
  if (!themes.length) {
    themeMessage.value = '还没有自定义主题，先新建或导入'
    return
  }
  const suffix = new Date().toISOString().slice(0, 10)
  if (kind === 'legado') {
    downloadJson(`mo-reader-themes-legado-${suffix}.json`, exportLegadoThemes(themes))
    themeMessage.value = `已导出 Legado 兼容版（${themes.length} 个主题）`
  } else {
    downloadJson(`mo-reader-themes-${suffix}.json`, exportFullThemes(themes))
    themeMessage.value = `已导出墨读全量版（${themes.length} 个主题）`
  }
}

async function importLocalFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const result = await call('importLocalBook', {
      fileName: file.name,
      dataBase64: toBase64(bytes),
    })
    await refresh()
    status.value = `已导入《${result.book?.name ?? file.name}》${result.chapters} 章`
    if (result.book) await openShelfBook(result.book)
  } catch (error) {
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

async function importShelfFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  shelfMessage.value = ''
  try {
    const result = await call('importBooks', { payload: await file.text() })
    await refresh()
    const extras = [
      result.skipped ? `跳过重复 ${result.skipped} 本` : '',
      result.localMissing ? `${result.localMissing} 本本地文件缺失` : '',
    ].filter(Boolean)
    shelfMessage.value =
      `导入 ${result.total} 本：新增 ${result.added} 本` + (extras.length ? `，${extras.join('，')}` : '')
  } catch (error) {
    shelfMessage.value = errorText(error)
  } finally {
    busy.value = false
  }
}

function exportShelf(kind: 'legado' | 'full') {
  if (!shelfBooks.value.length) {
    shelfMessage.value = '书架还是空的，没有可导出的书目'
    return
  }
  const suffix = new Date().toISOString().slice(0, 10)
  if (kind === 'legado') {
    downloadJson(`mo-reader-books-legado-${suffix}.json`, exportLegadoShelf(shelfBooks.value))
    shelfMessage.value = `已导出 Legado 兼容版（${shelfBooks.value.length} 本，仅书目与进度）`
  } else {
    downloadJson(`mo-reader-books-${suffix}.json`, exportFullShelf(shelfBooks.value))
    shelfMessage.value = `已导出墨读全量版（${shelfBooks.value.length} 本，仅书目与进度）`
  }
}

function startShelfSelect() {
  shelfSelecting.value = true
  selectedBookIds.value = new Set()
}

function exitShelfSelect() {
  shelfSelecting.value = false
  selectedBookIds.value = new Set()
}

function onShelfBookClick(book: any) {
  if (longPressFired) {
    longPressFired = false
    return
  }
  if (shelfSelecting.value) {
    toggleShelfSelect(book)
    return
  }
  if (book?.localMissing) {
    status.value = '本地文件缺失，仅保留书目信息'
    return
  }
  if (book?.metadataOnly) {
    status.value = '仅导入了书目信息，不能直接阅读'
    return
  }
  void openShelfBook(book)
}

async function removeSelectedBooks() {
  const ids = [...selectedBookIds.value]
  if (!ids.length) return
  busy.value = true
  try {
    await call('removeBooks', { ids })
    exitShelfSelect()
    await refresh()
    status.value = `移出书架 ${ids.length} 本`
  } catch (error) {
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

function onShelfPointerDown(book: any) {
  longPressFired = false
  if (longPressTimer) clearTimeout(longPressTimer)
  longPressTimer = setTimeout(() => {
    longPressFired = true
    if (!shelfSelecting.value) startShelfSelect()
    toggleShelfSelect(book)
  }, 520)
}

function onShelfPointerUp() {
  if (longPressTimer) clearTimeout(longPressTimer)
  longPressTimer = undefined
}

async function updateSelected(patch: (book: any) => Record<string, unknown>, message: string) {
  const ids = [...selectedBookIds.value]
  if (!ids.length) return
  busy.value = true
  try {
    for (const id of ids) {
      const book = shelfBooks.value.find((item) => item.id === id)
      if (!book) continue
      await call('updateBook', { id, patch: patch(book) })
    }
    exitShelfSelect()
    await refresh()
    status.value = message
  } catch (error) {
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

function pinSelected(pinned: boolean) {
  return updateSelected(() => ({ pinned }), pinned ? `已置顶 ${selectedBookCount.value} 本` : '已取消置顶')
}

async function refreshSelectedToc() {
  const ids = [...selectedBookIds.value]
  if (!ids.length) return
  busy.value = true
  let ok = 0
  try {
    for (const id of ids) {
      const book = shelfBooks.value.find((item) => item.id === id)
      if (!book) continue
      try {
        const info = await call('getBookInfo', { sourceUrl: book.origin, bookUrl: book.bookUrl })
        const tocUrl = info?.tocUrl || book.tocUrl || book.bookUrl
        const toc = await call('getToc', { sourceUrl: book.origin, tocUrl })
        const list = toc?.chapters ?? []
        const last = [...list].reverse().find((chapter: any) => !chapter.isVolume)
        await call('updateBook', {
          id,
          patch: { totalChapterNum: list.length, latestChapterTitle: last?.title ?? '', tocUrl },
        })
        ok += 1
      } catch {
        // 单本失败继续
      }
    }
    exitShelfSelect()
    await refresh()
    status.value = `已更新目录 ${ok}/${ids.length} 本`
  } catch (error) {
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

async function addToShelf(): Promise<boolean> {
  if (!currentBook.value) return false
  try {
    const result = await call('addBook', {
      book: {
        origin: currentBook.value.origin,
        originName: currentBook.value.originName,
        bookUrl: currentBook.value.bookUrl,
        tocUrl: currentBook.value.tocUrl,
        name: currentBook.value.name,
        author: currentBook.value.author,
        kind: currentBook.value.kind,
        coverUrl: currentBook.value.coverUrl,
        intro: currentBook.value.intro,
        type: currentBook.value.type,
      },
    })
    currentBook.value.id = result.book.id
    await refresh()
    status.value = '已加入书架'
    return true
  } catch (error) {
    status.value = errorText(error)
    return false
  }
}

async function openChapter(
  chapter: any,
  page?: number,
  options: { afterMediaRetry?: boolean; keepSpeech?: boolean } = {},
) {
  if (!chapter || chapter.isVolume || !chapter.url) return false
  if (!options.afterMediaRetry) {
    // 用户重新打开章节时重置「本章只重下一次」额度；重下后的自动重开不重置。
    readerMediaRetryUsed = false
    readerMediaRetryChapter.value = null
    readerMediaRetryAvailable.value = false
  }
  readerMediaRetryBusy.value = false
  tocOpen.value = false
  bookmarksOpen.value = false
  closeReaderDict()
  // 换章、换书停止朗读；自动翻页续章（keepSpeech）不打断其状态。
  if (!options.keepSpeech) stopSpeech('', { keepAutoPage: autoPageStatus.value === 'running' })
  busy.value = true
  chrome.value = false
  chapterError.value = ''
  pdfError.value = ''
  initialPage.value =
    typeof page === 'number'
      ? page
      : progress.value?.chapterUrl === chapter.url
        ? Number(progress.value.position ?? 0)
        : 0
  const index = chapters.value.indexOf(chapter)
  try {
    const result = await call('getContent', {
      sourceUrl: currentBook.value.origin,
      chapterUrl: chapter.url,
      bookId: currentBook.value?.id,
      chapterIndex: index,
      chapterTitle: chapter.title,
    })
    const kind = (result.kind ?? 'text') as 'text' | 'images' | 'audio' | 'video'
    currentChapter.value = chapter
    readerKind.value = kind
    content.value = kind === 'text' ? (result.content ?? '') : ''
    readerImages.value = kind === 'images' ? (result.images ?? []) : []
    readerMedia.value =
      kind === 'audio' || kind === 'video' ? (result.mediaUrl ?? chapter.url) : ''
    readerLocal.value = result.local === true
    const retryable = result.localMissing === true && Number.isInteger(index) && index >= 0
    readerMediaNotice.value = retryable
      ? `第 ${index + 1} 章本地文件已失效，已改用在线内容。`
      : ''
    readerMediaRetryChapter.value = retryable ? index : null
    readerMediaRetryAvailable.value = retryable && !readerMediaRetryUsed
    readerTitle.value = chapter.title
    view.value = 'reader'
    if (currentBook.value?.id) {
      call('saveProgress', {
        bookId: currentBook.value.id,
        chapterIndex: index,
        chapterTitle: chapter.title,
        chapterUrl: chapter.url,
        // 跳章末时是 MAX_SAFE_INTEGER，先按 0 记，等页面渲染后由 onPage 写入真实页码。
        position: initialPage.value === Number.MAX_SAFE_INTEGER ? 0 : initialPage.value,
      }).catch(() => undefined)
    }
    return true
  } catch (error) {
    const message = errorText(error)
    chapterError.value = `本章暂不可读：${message}。未下载的章节需要联网后阅读。`
    status.value = message
    return false
  } finally {
    busy.value = false
  }
}

/** 本地文件被删/损坏：同一章改用在线代理重取，只回退一次，失败只提示。 */
async function onReaderMediaError(payload?: { reason?: string; permanent?: boolean }) {
  if (!readerLocal.value || mediaFallbackBusy) return
  const book = currentBook.value as any
  const chapter = currentChapter.value
  if (!book?.id || !chapter?.url) return
  mediaFallbackBusy = true
  try {
    const index = chapters.value.indexOf(chapter)
    const reason = String(payload?.reason ?? '').trim().slice(0, 60) || '播放器报错'
    const permanent = payload?.permanent === true
    const retryable = Number.isInteger(index) && index >= 0
    readerMediaRetryChapter.value = retryable ? index : null
    // 编码/格式不支持、DRM、4xx 属永久失败：提示里不给「重新下载」入口。
    readerMediaRetryAvailable.value = retryable && !readerMediaRetryUsed && !permanent
    const result: any = await call('getContent', {
      sourceUrl: book.origin,
      chapterUrl: chapter.url,
      bookId: book.id,
      chapterIndex: index,
      chapterTitle: chapter.title,
      preferOnline: true,
    })
    const kind = result?.kind ?? 'text'
    if (kind === 'images') readerImages.value = result?.images ?? []
    else if (kind === 'audio' || kind === 'video') readerMedia.value = result?.mediaUrl ?? chapter.url
    readerLocal.value = false
    readerMediaNotice.value = permanent
      ? `第 ${index + 1} 章本地文件不可用（${reason}，无法通过重新下载修复），已切换到在线播放。`
      : `第 ${index + 1} 章本地文件不可用（${reason}），已切换到在线播放。`
  } catch (error) {
    readerMediaNotice.value = `本地文件不可用，在线回退也失败了：${errorText(error)}`
  } finally {
    mediaFallbackBusy = false
  }
}

async function loadBookmarks() {
  if (!currentBook.value?.id) {
    bookmarks.value = []
    return
  }
  try {
    const result = await call('listBookmarks', { bookId: currentBook.value.id })
    bookmarks.value = result.bookmarks ?? []
  } catch {
    bookmarks.value = []
  }
}

async function loadNotes() {
  if (!currentBook.value?.id) {
    notes.value = []
    return
  }
  try {
    const result = await call('listNotes', { bookId: currentBook.value.id })
    notes.value = result.notes ?? []
  } catch {
    notes.value = []
  }
}

const bookmarkedHere = computed(() =>
  bookmarks.value.some(
    (item) =>
      (item.type ?? 'bookmark') === 'bookmark' &&
      Number(item.chapterIndex) === chapterIndex.value &&
      Number(item.page) === initialPage.value,
  ),
)

async function toggleBookmark() {
  if (!currentBook.value?.id || !currentChapter.value) return
  try {
    const existing = bookmarks.value.find(
      (item) =>
        (item.type ?? 'bookmark') === 'bookmark' &&
        Number(item.chapterIndex) === chapterIndex.value &&
        Number(item.page) === initialPage.value,
    )
    if (existing) {
      await call('deleteBookmark', { id: existing.id })
      status.value = '已删除书签'
    } else {
      await call('saveBookmark', {
        bookId: currentBook.value.id,
        chapterIndex: chapterIndex.value,
        chapterTitle: currentChapter.value.title,
        chapterUrl: currentChapter.value.url,
        page: initialPage.value,
      })
      status.value = '已加书签'
    }
    await loadBookmarks()
    await loadNotes()
  } catch (error) {
    status.value = errorText(error)
  }
}

async function removeBookmark(bookmark: any) {
  try {
    await call('deleteBookmark', { id: bookmark.id })
    await loadBookmarks()
    await loadNotes()
    status.value = '已删除书签'
  } catch (error) {
    status.value = errorText(error)
  }
}

async function addNote() {
  const text = noteDraft.value.trim()
  if (!text || !currentBook.value?.id) return
  try {
    await call('saveNote', {
      bookId: currentBook.value.id,
      chapterIndex: chapterIndex.value,
      chapterTitle: currentChapter.value?.title ?? '',
      chapterUrl: currentChapter.value?.url ?? '',
      page: initialPage.value,
      type: 'note',
      quote: (readerRef.value?.currentPageLines?.() ?? [])[0] ?? '',
      content: text,
    })
    noteDraft.value = ''
    await loadNotes()
    status.value = '笔记已保存'
  } catch (error) {
    status.value = errorText(error)
  }
}

async function removeNote(note: any) {
  try {
    await call('deleteNote', { id: note.id })
    await loadNotes()
    status.value = '已删除笔记'
  } catch (error) {
    status.value = errorText(error)
  }
}

async function jumpNote(note: any) {
  const chapter = chapters.value[Number(note.chapterIndex)]
  if (!chapter) return
  notesOpen.value = false
  underlineOpen.value = false
  await openChapter(chapter, Number(note.page ?? 0))
}

function openUnderlines() {
  underlineLines.value = (readerRef.value?.currentPageLines?.() ?? []).slice(0, 40)
  selectedUnderlines.value = []
  underlineOpen.value = true
}

async function saveUnderlines() {
  if (!currentBook.value?.id || selectedUnderlines.value.length === 0) return
  try {
    for (const line of selectedUnderlines.value) {
      await call('saveNote', {
        bookId: currentBook.value.id,
        chapterIndex: chapterIndex.value,
        chapterTitle: currentChapter.value?.title ?? '',
        chapterUrl: currentChapter.value?.url ?? '',
        page: initialPage.value,
        type: 'underline',
        quote: line,
        content: '',
      })
    }
    selectedUnderlines.value = []
    await loadNotes()
    underlineOpen.value = false
    status.value = '已加划线'
  } catch (error) {
    status.value = errorText(error)
  }
}

async function jumpBookmark(bookmark: any) {
  const chapter = chapters.value[Number(bookmark.chapterIndex)]
  if (!chapter) return
  bookmarksOpen.value = false
  await openChapter(chapter, Number(bookmark.page ?? 0))
}

/** 详情页主按钮：PDF 有原文件时默认进原版，其余走文本模式。 */
function continueReading() {
  if (isPdfReadable.value) {
    void openPdfReader()
    return
  }
  continueReadingText()
}

/** 文本模式：沿用原有「继续阅读」逻辑，PDF 书也复用。 */
function continueReadingText() {
  if (!chapters.value.length) {
    status.value = '这本书还没有可读章节'
    return
  }
  const record = progress.value
  let target = chapters.value.find((chapter) => !chapter.isVolume && chapter.url)
  if (record) {
    target =
      chapters.value.find((chapter) => chapter.url === record.chapterUrl) ||
      chapters.value[Math.min(Number(record.chapterIndex) || 0, chapters.value.length - 1)] ||
      target
  }
  if (target) openChapter(target)
}

/** 详情目录点章节：PDF 有原文件、标题又能取回页码时进原版对应页，其余仍进文本模式。 */
async function openTocChapter(chapter: any) {
  const page = pdfPageOfChapterTitle(chapter?.title)
  if (isPdfReadable.value && page !== null) {
    await openPdfReader(page)
    return
  }
  await openChapter(chapter)
}

/** 打开 PDF 原版视图：指定页优先，否则从阅读进度里恢复页码与缩放。 */
async function openPdfReader(page?: number) {
  const book = currentBook.value as any
  if (!book?.id) {
    status.value = '请先把这本书加入书架'
    return
  }
  if (!localPdfStatus.value) await loadLocalPdfStatus(book)
  stopSpeech()
  closeReaderDict()
  tocOpen.value = false
  bookmarksOpen.value = false
  chapterError.value = ''
  pdfError.value = ''
  const info = localPdfStatus.value
  if (!info?.isPdf) pdfError.value = '这本书没有 PDF 原文件，只能阅读文本模式'
  else if (!info.hasOriginal || !info.originalUrl) pdfError.value = '原文件缺失，重新导入同一个 PDF 即可恢复原版阅读'
  const requested = typeof page === 'number' && Number.isFinite(page) ? Math.floor(page) : 0
  if (requested > 0) {
    // 立即并入本地进度：原版首帧渲染前就切回文本时，也能落到同一页对应的章节。
    progress.value = { ...(progress.value ?? {}), bookId: book.id, pdfPage: requested - 1 }
  }
  readerKind.value = 'pdf'
  readerTitle.value = '原版 PDF'
  pdfOriginalUrl.value = info?.isPdf && info?.hasOriginal ? String(info.originalUrl ?? '') : ''
  pdfInitialPage.value =
    requested > 0 ? requested - 1 : Math.max(0, Math.floor(Number(progress.value?.pdfPage ?? 0) || 0))
  pdfInitialZoom.value = Math.min(300, Math.max(50, Number(progress.value?.pdfZoom ?? 100) || 100))
  pdfInitialFitWidth.value = Boolean(progress.value?.pdfFitWidth)
  view.value = 'reader'
  chrome.value = false
  status.value = `${book.name} · 原版 PDF`
}

/** 记录原版阅读进度：本地先合并进 progress，服务端按同一字段名保存。 */
function onPdfPage(payload: { page: number; total: number; zoom: number; fitWidth: boolean }) {
  progress.value = {
    ...(progress.value ?? {}),
    bookId: currentBook.value?.id,
    pdfPage: payload.page,
    pdfZoom: payload.zoom,
    pdfFitWidth: payload.fitWidth,
  }
  if (!currentBook.value?.id) return
  if (pdfTimer) clearTimeout(pdfTimer)
  pdfTimer = setTimeout(() => {
    if (!currentBook.value?.id) return
    call('saveProgress', {
      bookId: currentBook.value.id,
      pdfPage: payload.page,
      pdfZoom: payload.zoom,
      pdfFitWidth: payload.fitWidth,
    }).catch(() => undefined)
  }, 300)
}

function closePdfReader() {
  view.value = 'detail'
  chrome.value = true
}

/** 从原版切到文本：先落到当前页所在章节（空文字页落回上一页），再退回上次的文本进度。 */
async function switchToTextFromPdf() {
  const readable = chapters.value.filter((chapter: any) => !chapter.isVolume && chapter.url)
  if (!readable.length) {
    showReaderHint('没有可读文本，请先缓存或重新导入')
    return
  }
  const page = Math.max(1, Math.floor(Number(progress.value?.pdfPage ?? 0) || 0) + 1)
  const byPage = chapterForPdfPage(readable, page)
  if (byPage) {
    await openChapter(byPage)
    return
  }
  // 章节标题不是页码的旧数据：回到上次读的文本章节。
  const recorded = progress.value?.chapterUrl
    ? chapters.value.find((chapter: any) => !chapter.isVolume && chapter.url === progress.value.chapterUrl)
    : null
  if (recorded) {
    await openChapter(recorded)
    return
  }
  const index = Math.min(page - 1, readable.length - 1)
  await openChapter(readable[index])
}

/** 阅读页的原版 / 文本切换入口。 */
async function togglePdfMode() {
  if (readerKind.value === 'pdf') {
    await switchToTextFromPdf()
    return
  }
  if (!isPdfReadable.value) {
    showReaderHint('没有可用的 PDF 原文件')
    return
  }
  // 从文本进原版：先落到当前章的页，来回切换才不会互相丢位置。
  await openPdfReader(pdfPageOfChapterTitle(currentChapter.value?.title) ?? undefined)
}

const switchOpen = ref(false)
const switchLoading = ref(false)
const switchBusy = ref(false)
const switchPreviewBusy = ref(false)
const switchCandidates = ref<any[]>([])
const switchErrors = ref<Array<{ sourceUrl: string; message: string }>>([])
const switchPreview = ref<any>(null)
const switchPreviewKey = ref('')
const switchError = ref('')

const switchErrorText = computed(() =>
  switchErrors.value.map((item) => `${item.sourceUrl}：${item.message}`).join('；'),
)

function switchCandidateKey(candidate: any) {
  return `${candidate?.sourceUrl ?? ''}|${candidate?.bookUrl ?? ''}`
}

async function openSwitchPanel() {
  const book = currentBook.value as any
  if (!book || String(book.origin ?? '') === 'local') {
    status.value = '本地书不支持换源'
    return
  }
  if (!currentBook.value.id) {
    status.value = '正在加入书架…'
    const added = await addToShelf()
    if (!added) {
      switchOpen.value = false
      return
    }
    if (!currentBook.value?.id) {
      switchOpen.value = false
      status.value = '加入书架失败，无法换源'
      return
    }
    status.value = '已加入书架，正在搜索候选'
  }
  switchOpen.value = true
  switchLoading.value = true
  switchBusy.value = false
  switchPreviewBusy.value = false
  switchCandidates.value = []
  switchErrors.value = []
  switchPreview.value = null
  switchPreviewKey.value = ''
  switchError.value = ''
  try {
    const result: any = await call('findSourceCandidates', { bookId: book.id })
    switchCandidates.value = result?.candidates ?? []
    switchErrors.value = result?.errors ?? []
  } catch (error) {
    switchError.value = errorText(error)
  } finally {
    switchLoading.value = false
  }
}

function closeSwitchPanel() {
  switchOpen.value = false
}

async function previewCandidate(candidate: any) {
  if (!candidate) return
  const key = switchCandidateKey(candidate)
  switchPreviewKey.value = key
  switchPreview.value = null
  switchPreviewBusy.value = true
  switchError.value = ''
  try {
    const result: any = await call('previewSourceCandidate', {
      sourceUrl: candidate.sourceUrl,
      bookUrl: candidate.bookUrl,
    })
    if (switchPreviewKey.value !== key) return
    switchPreview.value = result
    const row = switchCandidates.value.find((item) => switchCandidateKey(item) === key)
    if (row) row.chapterCount = result?.chapterCount ?? 0
  } catch (error) {
    if (switchPreviewKey.value === key) switchError.value = errorText(error)
  } finally {
    if (switchPreviewKey.value === key) switchPreviewBusy.value = false
  }
}

async function confirmSwitch() {
  const book = currentBook.value as any
  const candidate = switchCandidates.value.find(
    (item) => switchCandidateKey(item) === switchPreviewKey.value,
  )
  if (!book?.id || !candidate || !switchPreview.value) return
  const wasReader = view.value === 'reader'
  switchBusy.value = true
  switchError.value = ''
  try {
    const result: any = await call('switchBookSource', {
      bookId: book.id,
      sourceUrl: candidate.sourceUrl,
      bookUrl: candidate.bookUrl,
    })
    Object.assign(currentBook.value as any, result.book ?? {})
    chapters.value = result.chapters ?? []
    progress.value = result.progress ?? null
    switchOpen.value = false
    await loadBookmarks()
    await loadNotes()
    await refresh()
    status.value = `已换源 · ${chapters.value.length} 章`
    if (wasReader) {
      const record = result.progress
      const readable = chapters.value.filter((chapter: any) => !chapter.isVolume && chapter.url)
      const target =
        (record && readable.find((chapter: any) => chapter.url === record.chapterUrl)) ||
        (record && readable[Math.min(Number(record.chapterIndex) || 0, readable.length - 1)]) ||
        readable[0]
      if (target) await openChapter(target, Number(record?.position ?? 0))
    }
  } catch (error) {
    switchError.value = errorText(error)
  } finally {
    switchBusy.value = false
  }
}

function onPage(payload: { page: number; total: number }) {
  onReaderPageState(payload)
  initialPage.value = payload.page
  if (!currentBook.value?.id) return
  if (pageTimer) clearTimeout(pageTimer)
  pageTimer = setTimeout(() => {
    if (!currentBook.value?.id || !currentChapter.value) return
    call('saveProgress', {
      bookId: currentBook.value.id,
      chapterIndex: chapterIndex.value,
      chapterTitle: currentChapter.value.title,
      chapterUrl: currentChapter.value.url,
      position: payload.page,
    }).catch(() => undefined)
  }, 600)
}

const speechSupported = computed(
  () =>
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined',
)

const chineseSpeechVoices = computed(() =>
  speechVoices.value.filter((voice) => voice.lang?.toLowerCase().startsWith('zh')),
)

/** 入口禁用原因；音色列表还没结论时为空，避免首屏误判，等过一次 voiceschanged 仍为空则禁用 */
const speechBlockedReason = computed(() =>
  speechBlockedMessage({
    supported: speechSupported.value,
    loaded: speechVoicesLoaded.value,
    voiceLangs: speechVoices.value.map((voice) => voice.lang),
  }),
)

/** 阅读页高亮：朗读范围优先，其次搜索命中范围 */
const readerHighlight = computed(() => speechHighlight.value ?? highlightText.value)

function clearSpeechVoiceWait() {
  if (speechVoiceWaitTimer) {
    window.clearTimeout(speechVoiceWaitTimer)
    speechVoiceWaitTimer = 0
  }
}

/**
 * 读取音色列表：一次拿不到（Chrome 常见）就等 voiceschanged；
 * 等待窗口结束仍为空即认定为「没有中文音色」，禁用朗读入口并说明原因。
 */
function loadSpeechVoices() {
  if (!speechSupported.value) return
  let voices: SpeechSynthesisVoice[] = []
  try {
    voices = window.speechSynthesis?.getVoices?.() ?? []
  } catch {
    voices = []
  }
  if (voices.length > 0) {
    speechVoices.value = voices
    speechVoicesLoaded.value = true
    clearSpeechVoiceWait()
    return
  }
  if (speechVoicesLoaded.value || speechVoiceWaitTimer) return
  speechVoiceWaitTimer = window.setTimeout(() => {
    speechVoiceWaitTimer = 0
    speechVoicesLoaded.value = true
  }, SPEECH_VOICE_WAIT_MS)
}

function pickSpeechVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices?.() ?? []
  const wanted = settings.value.ttsVoice
  if (wanted) {
    const matched = voices.find((voice) => voice.voiceURI === wanted)
    if (matched) return matched
  }
  return voices.find((voice) => voice.lang?.toLowerCase().startsWith('zh')) ?? null
}

function syncSpeechSegment() {
  speechSegmentIndex.value = speechCursor?.index ?? 0
  speechSegmentTotal.value = speechCursor?.total ?? 0
}

function currentSpeechRate(): number {
  const rate = Number(settings.value.ttsRate)
  if (!Number.isFinite(rate)) return 1
  return Math.min(2, Math.max(0.5, rate))
}

/** 高亮越屏时静默切页（goto 会取消翻页动画），不做子串匹配 */
function alignSpeechPage(offset: number) {
  if (readerKind.value !== 'text' || document.hidden) return
  const reader = readerRef.value
  const target = reader?.pageForOffset?.(offset)
  if (typeof target !== 'number' || target < 0) return
  if (target === Number(reader?.page)) return
  reader?.goto?.(target)
}

function cancelSpeechUtterance() {
  speechToken += 1
  try {
    window.speechSynthesis?.cancel()
  } catch {
    // 取消失败不影响后续重建
  }
  speechUtterance = null
  if (speechResumeTimer) {
    clearTimeout(speechResumeTimer)
    speechResumeTimer = undefined
  }
}

/** 念当前段从游标位置开始的剩余文本；boundary 用绝对偏移，不做子串匹配 */
function speakCurrentSegment() {
  const cursor = speechCursor
  if (!cursor) return
  const synth = window.speechSynthesis
  if (!synth || !speechSupported.value) {
    stopSpeech(SPEECH_UNSUPPORTED_MESSAGE)
    return
  }
  const text = cursor.remainingText()
  if (!text.trim()) {
    advanceSpeechSegment()
    return
  }
  const token = ++speechToken
  speechUserCancel = false
  const utterance = new SpeechSynthesisUtterance(text)
  speechUtterance = utterance
  const voice = pickSpeechVoice()
  utterance.lang = voice?.lang || 'zh-CN'
  utterance.rate = currentSpeechRate()
  if (voice) utterance.voice = voice
  const baseOffset = cursor.charOffset
  utterance.onstart = () => {
    if (token !== speechToken) return
    const range = cursor.highlightRange()
    speechHighlight.value = range
    if (range) alignSpeechPage(range.start)
  }
  utterance.onboundary = (event: SpeechSynthesisEvent) => {
    if (token !== speechToken || speechStatus.value === 'idle') return
    if (typeof event.charIndex !== 'number') return
    cursor.setBoundary(baseOffset + event.charIndex)
    const range = cursor.highlightRange()
    speechHighlight.value = range
    if (range) alignSpeechPage(range.start)
  }
  utterance.onend = () => {
    if (token !== speechToken || speechStatus.value === 'idle') return
    speechHighlight.value = null
    advanceSpeechSegment()
  }
  utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
    if (token !== speechToken || speechStatus.value === 'idle') return
    const action = classifySpeechError(event?.error, speechUserCancel)
    if (action === 'ignore') return
    if (action === 'retry' && !speechBusyRetried) {
      speechBusyRetried = true
      cancelSpeechUtterance()
      speakCurrentSegment()
      return
    }
    if (action === 'not-allowed') {
      speechNotAllowed = true
      speechStatus.value = 'paused'
      speechNotice.value = SPEECH_NOT_ALLOWED_NOTICE
      showReaderHint(SPEECH_NOT_ALLOWED_NOTICE)
      return
    }
    stopSpeech(speechErrorNotice(event?.error))
  }
  synth.speak(utterance)
}

/** 当前段念完：有下一段继续，否则走章末续章/停止 */
function advanceSpeechSegment() {
  const cursor = speechCursor
  if (!cursor) return
  if (cursor.advance() === 'next') {
    speechBusyRetried = false
    syncSpeechSegment()
    speakCurrentSegment()
    return
  }
  void finishSpeechChapter()
}

/** 章末：连续朗读开则加载下一章并从标题后第一段继续，否则停在章末 */
async function finishSpeechChapter() {
  const hasNext = chapterIndex.value >= 0 && chapterIndex.value < chapters.value.length - 1
  if (!settings.value.ttsContinuous) {
    stopSpeech()
    showReaderHint('已读完本章')
    return
  }
  if (!hasNext) {
    stopSpeech('已到全书末尾')
    return
  }
  const target = chapters.value[chapterIndex.value + 1]
  if (!target) {
    stopSpeech('已到全书末尾')
    return
  }
  speechLoading.value = true
  speechNotice.value = '正在加载下一章…'
  const ok = await openChapter(target, 0, { keepSpeech: true })
  speechLoading.value = false
  if (speechStatus.value === 'idle') return
  if (!ok) {
    stopSpeech('下一章加载失败，朗读已停止')
    return
  }
  await nextTick()
  speechPlan = buildSpeechPlan(readerTitle.value, replacedContent.value)
  speechCursor = new SpeechCursor(speechPlan)
  speechChapterTitle.value = readerTitle.value
  if (speechCursor.segment?.kind === 'title') speechCursor.setIndex(1)
  syncSpeechSegment()
  if (!speechCursor.segment || speechCursor.segment.kind === 'title') {
    stopSpeech('下一章没有可朗读的正文')
    return
  }
  speechNotice.value = ''
  speechNotAllowed = false
  speechBusyRetried = false
  if (speechStatus.value === 'paused') {
    speechHighlight.value = speechCursor.highlightRange()
    return
  }
  speechStatus.value = 'speaking'
  speakCurrentSegment()
}

function startSpeech() {
  if (!speechSupported.value) {
    showReaderHint(SPEECH_UNSUPPORTED_MESSAGE)
    return
  }
  if (view.value !== 'reader' || readerKind.value !== 'text') return
  loadSpeechVoices()
  const reason = speechBlockedReason.value
  if (reason) {
    speechVoicesLoaded.value = true
    showReaderHint(reason)
    return
  }
  if (!pickSpeechVoice()) {
    speechVoicesLoaded.value = true
    showReaderHint(SPEECH_NO_VOICE_MESSAGE)
    return
  }
  if (!replacedContent.value.trim()) {
    showReaderHint('本章没有可朗读的内容')
    return
  }
  cancelSpeechUtterance()
  speechBusyRetried = false
  speechUserCancel = false
  speechNotAllowed = false
  speechPlan = buildSpeechPlan(readerTitle.value, replacedContent.value)
  speechCursor = new SpeechCursor(speechPlan)
  speechChapterTitle.value = readerTitle.value
  if (speechPlan.segments.length === 0) {
    stopSpeech('本章没有可朗读的内容')
    return
  }
  if (autoPageStatus.value !== 'idle') {
    autoPage.addPauseReason('tts')
    refreshAutoPageState()
  }
  void ensureKeepAwake().acquire()
  const reader = readerRef.value
  const range = reader?.currentPageRange?.() ?? null
  const pageStart = range && range.start >= 0 ? range.start : 0
  if (pageStart <= 0) {
    speechCursor.setIndex(0)
  } else {
    const index = segmentIndexForOffset(speechPlan, pageStart)
    if (index >= 0) {
      speechCursor.setIndex(index)
      const segment = speechCursor.segment
      if (segment && segment.kind === 'paragraph' && pageStart > segment.start) {
        speechCursor.setBoundary(pageStart - segment.start)
      }
    }
  }
  syncSpeechSegment()
  speechNotice.value = ''
  speechStatus.value = 'speaking'
  speakCurrentSegment()
}

function pauseSpeech() {
  if (speechStatus.value !== 'speaking') return
  const synth = window.speechSynthesis
  if (!synth) return
  speechUserCancel = true
  speechStatus.value = 'paused'
  speechNotice.value = '已暂停'
  if (speechResumeTimer) {
    clearTimeout(speechResumeTimer)
    speechResumeTimer = undefined
  }
  try {
    synth.pause()
  } catch {
    // 忽略：恢复时统一兜底
  }
}

/** 继续：400ms 内没恢复 speaking 就取消当前 utterance，从最后 boundary 偏移重读该段 */
function resumeSpeech() {
  if (speechStatus.value !== 'paused') return
  const synth = window.speechSynthesis
  if (!synth) return
  speechUserCancel = false
  speechNotice.value = ''
  if (autoPageStatus.value === 'running') {
    autoPage.addPauseReason('tts')
    refreshAutoPageState()
  }
  if (!speechUtterance || speechNotAllowed) {
    speechNotAllowed = false
    speechBusyRetried = false
    cancelSpeechUtterance()
    speechStatus.value = 'speaking'
    speakCurrentSegment()
    return
  }
  speechStatus.value = 'speaking'
  try {
    synth.resume()
  } catch {
    // 恢复失败走下面的兜底
  }
  if (speechResumeTimer) clearTimeout(speechResumeTimer)
  speechResumeTimer = setTimeout(() => {
    speechResumeTimer = undefined
    if (speechStatus.value !== 'speaking') return
    if (synth.speaking) return
    cancelSpeechUtterance()
    speakCurrentSegment()
  }, 400)
}

function toggleSpeechPlay() {
  if (speechStatus.value === 'idle') startSpeech()
  else if (speechStatus.value === 'speaking') pauseSpeech()
  else resumeSpeech()
}

/** 上一段/下一段：暂停中只移动位置，播放中立即从新段开头念 */
function moveSpeechSegment(direction: -1 | 1) {
  if (speechStatus.value === 'idle') {
    showReaderHint('先点「朗读」开始')
    return
  }
  const cursor = speechCursor
  if (!cursor) return
  if (direction > 0 && cursor.isLast) {
    cancelSpeechUtterance()
    void finishSpeechChapter()
    return
  }
  const wasPaused = speechStatus.value === 'paused'
  speechNotAllowed = false
  speechBusyRetried = false
  cancelSpeechUtterance()
  const moved = direction > 0 ? cursor.next() : cursor.prev()
  if (!moved) cursor.setBoundary(0)
  syncSpeechSegment()
  speechHighlight.value = cursor.highlightRange()
  if (wasPaused) {
    speechStatus.value = 'paused'
    return
  }
  speechStatus.value = 'speaking'
  speakCurrentSegment()
}

function stopSpeech(
  notice = '',
  options: { keepAutoPage?: boolean } = {},
) {
  const wasActive = speechStatus.value !== 'idle' || speechLoading.value || speechCursor !== null
  speechUserCancel = true
  cancelSpeechUtterance()
  speechStatus.value = 'idle'
  speechNotAllowed = false
  speechLoading.value = false
  speechHighlight.value = null
  speechNotice.value = ''
  speechCursor = null
  speechPlan = null
  speechSegmentIndex.value = 0
  speechSegmentTotal.value = 0
  speechChapterTitle.value = ''
  if (!wasActive) return
  // 只处理「因朗读而暂停」的自动翻页：先补一个暂停原因再摘掉 tts，避免摘掉后自动重启；
  // 自动翻页本来就在跑/暂停时不因停止朗读而改变它。
  if (autoPage.pausedReasons.includes('tts')) {
    if (!options.keepAutoPage) autoPage.pause()
    autoPage.removePauseReason('tts')
    refreshAutoPageState()
  }
  if (autoPage.status !== 'running') releaseKeepAwake()
  // 停止朗读立即落一次阅读进度，不等 600ms 防抖
  flushReaderProgress()
  if (notice) showReaderHint(notice)
}

/** 离开阅读页立即落一次进度，避免 600ms 防抖丢掉最后一次翻页 */
function flushReaderProgress() {
  if (pageTimer) {
    clearTimeout(pageTimer)
    pageTimer = undefined
  }
  if (!currentBook.value?.id || !currentChapter.value) return
  if (readerKind.value === 'pdf') return
  const raw = Number(initialPage.value)
  const position = Number.isFinite(raw) && raw >= 0 && raw !== Number.MAX_SAFE_INTEGER ? raw : 0
  call('saveProgress', {
    bookId: currentBook.value.id,
    chapterIndex: chapterIndex.value,
    chapterTitle: currentChapter.value.title,
    chapterUrl: currentChapter.value.url,
    position,
  }).catch(() => undefined)
}

function showReaderHint(text: string) {
  readerHint.value = text
  if (readerHintTimer) clearTimeout(readerHintTimer)
  readerHintTimer = setTimeout(() => {
    readerHint.value = ''
  }, 4000)
}

function openReaderSearch() {
  if (readerKind.value !== 'text') return
  if (!currentBook.value?.id) {
    showReaderHint('加入书架后可搜索')
    return
  }
  readerSearchOpen.value = true
  readerSearchHint.value = ''
}

function closeReaderSearch() {
  readerSearchOpen.value = false
}

async function runReaderSearch(fromIndex: number, reset: boolean) {
  const key = readerSearchKey.value.trim()
  if (!key) {
    readerSearchHint.value = '请输入关键词'
    return
  }
  const bookId = currentBook.value?.id
  if (!bookId) {
    readerSearchHint.value = '加入书架后可搜索'
    return
  }
  const token = ++readerSearchToken
  readerSearchStarted.value = true
  readerSearchBusy.value = true
  readerSearchStopped.value = false
  readerSearchHint.value = ''
  if (reset) {
    readerSearchUsedKey.value = key
    readerSearchResults.value = []
    readerSearchErrors.value = []
    readerSearchScanned.value = 0
    readerSearchDone.value = false
    readerSearchTotal.value = chapters.value.length
  }
  try {
    const result = await call('searchInBook', {
      bookId,
      key: readerSearchUsedKey.value,
      fromIndex,
      maxChapters: 200,
    })
    if (token !== readerSearchToken) return
    readerSearchResults.value.push(...(result?.results ?? []))
    readerSearchErrors.value.push(...(result?.errors ?? []))
    const next = Number(result?.nextIndex ?? fromIndex)
    readerSearchNextIndex.value = next
    readerSearchScanned.value = next
    readerSearchTotal.value = Math.max(readerSearchTotal.value, next)
    readerSearchDone.value = Boolean(result?.done)
    if (readerSearchDone.value) {
      if (readerSearchResults.value.length) {
        readerSearchHint.value = `已搜完，共 ${readerSearchResults.value.length} 章命中`
      }
    } else if (!readerSearchResults.value.length && !readerSearchErrors.value.length) {
      readerSearchHint.value = '本批没有找到，可继续'
    }
  } catch (error) {
    if (token === readerSearchToken) readerSearchHint.value = errorText(error)
  } finally {
    if (token === readerSearchToken) readerSearchBusy.value = false
  }
}

function startReaderSearch() {
  if (readerSearchBusy.value) return
  void runReaderSearch(0, true)
}

function continueReaderSearch() {
  void runReaderSearch(readerSearchNextIndex.value, false)
}

function stopReaderSearch() {
  if (!readerSearchBusy.value) return
  readerSearchToken += 1
  readerSearchBusy.value = false
  readerSearchStopped.value = true
  readerSearchHint.value = '已停止，可继续搜索'
}

const readerSearchCanContinue = computed(
  () =>
    readerSearchStarted.value &&
    !readerSearchBusy.value &&
    !readerSearchDone.value &&
    readerSearchKey.value.trim() === readerSearchUsedKey.value,
)

const readerSearchEmpty = computed(
  () =>
    readerSearchStarted.value &&
    !readerSearchBusy.value &&
    (readerSearchDone.value || readerSearchStopped.value) &&
    readerSearchResults.value.length === 0 &&
    readerSearchErrors.value.length === 0,
)

async function jumpToSearchResult(item: { chapterIndex: number }) {
  const chapter = chapters.value[item.chapterIndex]
  const key = readerSearchUsedKey.value
  if (!chapter || chapter.isVolume || !chapter.url) {
    readerSearchHint.value = '章节已变化，请重搜'
    return
  }
  readerSearchOpen.value = false
  readerSearchHint.value = ''
  highlightText.value = ''
  await openChapter(chapter, 0)
  if (currentChapter.value !== chapter) {
    showReaderHint('章节打开失败')
    return
  }
  await nextTick()
  const range = readerRef.value?.findRangeFor?.(key)
  if (range) {
    const target = readerRef.value?.pageForOffset?.(range.start)
    readerRef.value?.goto?.(typeof target === 'number' ? target : 0)
    highlightText.value = { start: range.start, end: range.end }
  } else {
    readerRef.value?.goto?.(0)
    showReaderHint('未定位到关键词')
  }
}

function addReplaceRule() {
  settings.value.replaceRules.push({
    id: `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    pattern: '',
    replacement: '',
    regex: false,
    enabled: true,
  })
  persistSettings()
}

function removeReplaceRule(rule: { id: string }) {
  settings.value.replaceRules = settings.value.replaceRules.filter((item) => item.id !== rule.id)
  persistSettings()
}

function onMediaProgress(seconds: number) {
  initialPage.value = seconds
  if (!currentBook.value?.id || !currentChapter.value) return
  if (pageTimer) clearTimeout(pageTimer)
  pageTimer = setTimeout(() => {
    if (!currentBook.value?.id || !currentChapter.value) return
    call('saveProgress', {
      bookId: currentBook.value.id,
      chapterIndex: chapterIndex.value,
      chapterTitle: currentChapter.value.title,
      chapterUrl: currentChapter.value.url,
      position: seconds,
    }).catch(() => undefined)
  }, 1200)
}

function onTapAction(code: number) {
  if (code === -1) return
  if (code === 0) {
    chrome.value = !chrome.value
    return
  }
  if (code === 1) {
    readerRef.value?.next()
    return
  }
  if (code === 2) {
    readerRef.value?.prev()
    return
  }
  if (code === 3) {
    openAdjacent(1)
    return
  }
  if (code === 4) {
    openAdjacent(-1)
    return
  }
  if (code === 7) {
    void toggleBookmark()
    return
  }
  if (code === 5) {
    moveSpeechSegment(-1)
    return
  }
  if (code === 6) {
    moveSpeechSegment(1)
    return
  }
  if (code === 13) {
    toggleSpeechPlay()
    return
  }
  if (code === 10) {
    tocOpen.value = true
    return
  }
  status.value = `「${tapActionLabel(code)}」暂未开放`
}

function applyPreset(preset: (typeof READER_PRESETS)[number]) {
  settings.value.fontSize = preset.fontSize
  settings.value.lineSpacing = preset.lineSpacing
  settings.value.paragraphSpacing = preset.paragraphSpacing
  settings.value.indent = preset.indent
  settings.value.padding = { ...preset.padding }
  persistSettings()
}

function setTapZone(index: number, event: Event) {
  const value = Number((event.target as HTMLSelectElement).value)
  settings.value.tapZones[index] = value
  persistSettings()
}

function scrollToCurrentChapter() {
  nextTick(() => {
    const node = document.querySelector('.mo-drawer-list li.on')
    node?.scrollIntoView({ block: 'center' })
  })
}

function toggleMenuItem(key: string) {
  const list = settings.value.menuItems
  if (list.includes(key) && list.length <= 1) {
    status.value = '底栏至少保留一项'
    return
  }
  settings.value.menuItems = list.includes(key) ? list.filter((item) => item !== key) : [...list, key]
  persistSettings()
}

/** 滑杆连续拖动时合并保存，避免每移动一格就写一次。 */
function schedulePersistSettings() {
  if (settingsPersistTimer) clearTimeout(settingsPersistTimer)
  settingsPersistTimer = setTimeout(() => {
    settingsPersistTimer = null
    void persistSettings()
  }, 120)
}

const deepEqualValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

/** 只提交与基准不同的字段；自定义主题与媒体配额属全局层，不随面板保存。 */
function settingsDiff(base: ReaderSettings, current: ReaderSettings): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(current) as Array<keyof ReaderSettings>) {
    if (!deepEqualValue(current[key], base[key])) patch[key] = current[key]
  }
  delete patch.customThemes
  delete patch.mediaQuotaBytes
  return patch
}

const cloneSettings = (value: ReaderSettings): ReaderSettings => JSON.parse(JSON.stringify(value)) as ReaderSettings

/** 读取当前作用域的设置：无书写全局，有书读合并值并带上「本书是否覆盖」。 */
async function loadSettings() {
  await settingsSaveChain
  const bookId = currentBook.value?.id ?? ''
  // 打开一本书时恢复用户上次选的作用域；没有书就只能是全局。
  if (bookId) settingsScope.value = storedSettingsScope()
  const scope: SettingsScope = bookId ? settingsScope.value : 'global'
  if (!bookId) settingsScope.value = 'global'
  try {
    const stored = scope === 'book' ? await call('getSettings', { bookId }) : await call('getSettings')
    if (!stored?.settings) return
    settings.value = { ...defaultReaderSettings(), ...stored.settings } as ReaderSettings
    // 旧配置里可能存着已隐藏的点击动作（8/9/11/12）：回退为无动作并保存一次。
    const sanitizedZones = sanitizeTapZones(settings.value.tapZones)
    if (sanitizedZones.changed) {
      settings.value.tapZones = sanitizedZones.zones
      if (!tapZonesRevertedNotified) {
        tapZonesRevertedNotified = true
        const message = '部分点击区域的功能未开放，已改为无动作'
        if (view.value === 'reader') showReaderHint(message)
        else status.value = message
      }
      void persistSettings()
    }
    settingsBaseline.value = cloneSettings(settings.value)
    bookOverridden.value = scope === 'book' ? Boolean(stored.bookOverridden) : false
    settingsError.value = ''
  } catch (error) {
    settingsError.value = `设置读取失败：${errorText(error)}`
  }
}

/** 串行保存队列：先发后到的响应不能把后来的改动覆盖掉。 */
let settingsSaveChain: Promise<void> = Promise.resolve()

/**
 * 保存设置：只提交本次改动字段，按当前作用域写到全局或本书。
 * 失败时保留用户当前值，在面板内提示原因，可重试。
 */
function persistSettings(): Promise<void> {
  if (settingsPersistTimer) {
    clearTimeout(settingsPersistTimer)
    settingsPersistTimer = null
  }
  const run = () => runPersistSettings()
  settingsSaveChain = settingsSaveChain.then(run, run)
  return settingsSaveChain
}

async function runPersistSettings() {
  const bookId = settingsScope.value === 'book' ? currentBook.value?.id ?? '' : ''
  const patch = settingsDiff(settingsBaseline.value, settings.value)
  if (Object.keys(patch).length === 0) return
  const sent = JSON.parse(JSON.stringify(patch)) as Record<string, unknown>
  try {
    const args: Record<string, unknown> = { settings: patch }
    if (bookId) args.bookId = bookId
    const result = await call('saveSettings', args)
    if (result?.settings) {
      const normalized = { ...defaultReaderSettings(), ...result.settings } as ReaderSettings
      const merged = cloneSettings(normalized)
      for (const key of Object.keys(sent)) {
        const local = (settings.value as unknown as Record<string, unknown>)[key]
        // 保存途中用户又改过这个字段：保留本地新值，等下一轮再提交。
        if (!deepEqualValue(local, sent[key])) (merged as unknown as Record<string, unknown>)[key] = local
      }
      settings.value = merged
      settingsBaseline.value = cloneSettings(normalized)
    } else {
      settingsBaseline.value = cloneSettings(settings.value)
    }
    bookOverridden.value = bookId ? Boolean(result?.bookOverridden ?? true) : false
    settingsError.value = ''
    status.value = bookId ? '已保存到本书' : '已保存全局设置'
  } catch (error) {
    settingsError.value = `保存失败：${errorText(error)}`
  }
}

function openSettings(event?: Event) {
  settingsTrigger.value = (event?.currentTarget as HTMLElement | null) ?? (document.activeElement as HTMLElement | null)
  settingsOpen.value = true
  settingsError.value = ''
  void loadSettings()
  nextTick(() => {
    settingsSheetRef.value?.querySelector<HTMLElement>('button, select, input, summary')?.focus()
  })
}

function closeSettings() {
  settingsOpen.value = false
  const trigger = settingsTrigger.value
  settingsTrigger.value = null
  nextTick(() => trigger?.focus())
}

async function switchSettingsScope(scope: SettingsScope) {
  if (scope === 'book' && !canUseBookScope.value) return
  if (scope === settingsScope.value) return
  settingsScope.value = scope
  storeSettingsScope(scope)
  await loadSettings()
}

/** 恢复全局：清掉本书覆盖层，面板立即显示继承后的值。 */
async function restoreGlobalSettings() {
  const bookId = currentBook.value?.id
  if (!bookId) return
  await settingsSaveChain
  try {
    await call('resetBookSettings', { bookId })
    bookOverridden.value = false
    await loadSettings()
    status.value = '已恢复全局设置'
  } catch (error) {
    settingsError.value = `恢复失败：${errorText(error)}`
  }
}

/** 恢复本节默认：全局层回默认值，本书层删掉该分区覆盖、改为跟随全局。 */
async function resetSettingsSection(group: SettingsGroupKey) {
  const bookId = settingsScope.value === 'book' ? currentBook.value?.id ?? '' : ''
  await settingsSaveChain
  try {
    const args: Record<string, unknown> = { group }
    if (bookId) args.bookId = bookId
    await call('resetSettingsGroup', args)
    await loadSettings()
    status.value = bookId ? '已恢复本节，改为跟随全局' : '已恢复本节默认'
  } catch (error) {
    settingsError.value = `恢复失败：${errorText(error)}`
  }
}

/** 面板内 Tab 循环，焦点不跑到后面的阅读页。 */
function trapSettingsFocus(event: KeyboardEvent) {
  const root = settingsSheetRef.value
  if (!root) return
  const focusable = Array.from(
    root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'),
  ).filter((node) => !node.hasAttribute('disabled') && node.offsetParent !== null)
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function openAdjacent(delta: number) {
  const next = chapters.value[chapterIndex.value + delta]
  if (next) openChapter(next)
}

function backFromDetail() {
  view.value = searchKey.value ? 'search' : 'shelf'
  refresh()
}

async function loadRssSources() {
  try {
    const result = await call('listRssSources')
    rssSources.value = result.rssSources ?? []
  } catch {
    rssSources.value = []
  }
}

async function onRssImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  rssImportText.value = await file.text()
  input.value = ''
}

async function importRssSources() {
  if (!rssImportText.value.trim()) return
  rssBusy.value = true
  try {
    const result = await call('importRssSources', { sources: rssImportText.value })
    rssMessage.value = `导入 ${Number(result.added ?? 0) + Number(result.updated ?? 0)} 个：新增 ${result.added ?? 0}，更新 ${result.updated ?? 0}`
    rssImportText.value = ''
    await loadRssSources()
  } catch (error) {
    rssMessage.value = errorText(error)
  } finally {
    rssBusy.value = false
  }
}

async function removeRssSource(source: any) {
  try {
    await call('deleteRssSource', { id: source.id })
    if (rssActive.value?.id === source.id) {
      rssActive.value = null
      rssArticles.value = []
    }
    await loadRssSources()
    rssMessage.value = '已删除订阅源'
  } catch (error) {
    rssMessage.value = errorText(error)
  }
}

async function openRssSource(source: any) {
  rssActive.value = source
  rssBusy.value = true
  try {
    const result = await call('getRssArticles', { id: source.id })
    rssFeed.value = result.feed ?? null
    rssArticles.value = result.feed?.articles ?? []
  } catch (error) {
    rssFeed.value = null
    rssArticles.value = []
    rssMessage.value = errorText(error)
  } finally {
    rssBusy.value = false
  }
}

function openArticle(item: any) {
  article.value = item
}

onMounted(async () => {
  window.addEventListener('keydown', onReaderEscape)
  document.addEventListener('visibilitychange', onReaderVisibilityChange)
  loadSpeechVoices()
  window.speechSynthesis?.addEventListener?.('voiceschanged', loadSpeechVoices)
  autoPage.setSeconds(settings.value.autoPageSeconds)
  if (!autoPageTimer) autoPageTimer = setInterval(runAutoPageTick, 250)
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        searchHistory.value = parsed.filter((item): item is string => typeof item === 'string').slice(0, 10)
      }
    }
  } catch {
    // 隐私模式下 localStorage 可能不可用
  }
  void loadBattery()
  await refresh()
  void loadRssSources()
})
</script>

<template>
  <div class="mo" :class="{ 'mo-reading-mode': view === 'reader' }">
    <template v-if="view !== 'reader'">
      <header class="mo-head">
        <div class="mo-brand">
          <span class="mo-brand-cn">墨读</span>
          <span class="mo-brand-en">MOREAD · DSH READER</span>
        </div>
        <div class="mo-status">{{ status || (busy ? '加载中…' : '') }}</div>
        <button class="mo-icon-btn" title="刷新" data-testid="refresh" @click="refresh">↻</button>
      </header>

      <nav class="mo-nav">
        <button :class="{ on: view === 'shelf' }" data-testid="nav-shelf" @click="view = 'shelf'">书架</button>
        <button :class="{ on: view === 'search' || view === 'detail' }" data-testid="nav-search" @click="view = 'search'">搜索</button>
        <button :class="{ on: view === 'explore' }" data-testid="nav-explore" @click="openExplore">发现</button>
        <button :class="{ on: view === 'sources' }" data-testid="nav-sources" @click="view = 'sources'">书源</button>
        <button :class="{ on: view === 'rss' }" data-testid="nav-rss" @click="view = 'rss'">订阅</button>
        <button :class="{ on: view === 'storage' }" data-testid="nav-storage" @click="view = 'storage'">存储</button>
        <span class="mo-version">v{{ version }}</span>
      </nav>
    </template>

    <main class="mo-body" :class="{ 'mo-body-reader': view === 'reader' }">
      <section v-if="view === 'shelf'" class="mo-pane">
        <div class="mo-section-head">
          <h2>书架</h2>
          <span class="muted">{{ shelfBooks.length }} 本 · {{ enabledCount }} 个书源启用</span>
          <div class="mo-shelf-tools">
            <select v-model="shelfSort" class="mo-select" aria-label="书架排序">
              <option value="recent">最近阅读</option>
              <option value="name">按书名</option>
              <option value="progress">按进度</option>
            </select>
            <input
              ref="localInput"
              type="file"
              accept=".txt,.epub,.pdf,.mobi,.azw,.azw3"
              style="display: none"
              @change="importLocalFile"
            />
            <button v-if="!shelfSelecting" class="mo-btn" data-testid="shelf-manage" @click="startShelfSelect">管理</button>
            <button v-if="!shelfSelecting" class="mo-btn" data-testid="shelf-import" @click="localInput?.click()">导入本地</button>
            <template v-else>
              <span class="muted">已选 {{ selectedBookCount }} 本</span>
              <input v-model="shelfGroupInput" class="mo-group-input" placeholder="分组名" />
              <button class="mo-btn" :disabled="selectedBookCount === 0 || busy" @click="applyGroupToSelected">设分组</button>
              <button class="mo-btn" :disabled="selectedBookCount === 0 || busy" @click="pinSelected(true)">置顶</button>
              <button class="mo-btn" :disabled="selectedBookCount === 0 || busy" @click="pinSelected(false)">取消置顶</button>
              <button class="mo-btn" :disabled="selectedBookCount === 0 || busy" @click="refreshSelectedToc">更新目录</button>
              <button
                class="mo-btn danger"
                data-testid="shelf-remove"
                :disabled="selectedBookCount === 0 || busy"
                @click="removeSelectedBooks"
              >
                移出书架
              </button>
              <button class="mo-btn" @click="exitShelfSelect">取消</button>
            </template>
          </div>
        </div>

        <div class="mo-shelf-transfer">
          <span class="muted">书架迁移</span>
          <input
            ref="shelfInput"
            type="file"
            accept=".json,application/json"
            style="display: none"
            data-testid="shelf-import-input"
            @change="importShelfFile"
          />
          <button class="mo-btn" :disabled="busy" data-testid="shelf-import-meta" @click="shelfInput?.click()">
            导入书目
          </button>
          <button class="mo-btn" :disabled="busy" data-testid="shelf-export-legado" @click="exportShelf('legado')">
            导出兼容版
          </button>
          <button class="mo-btn" :disabled="busy" data-testid="shelf-export-full" @click="exportShelf('full')">
            导出全量版
          </button>
          <span v-if="shelfMessage" class="muted mo-shelf-message" data-testid="shelf-transfer-status">
            {{ shelfMessage }}
          </span>
        </div>

        <div v-if="shelfGroups.length" class="mo-shelf-groups">
          <button :class="{ on: shelfGroup === '' }" @click="shelfGroup = ''">全部</button>
          <button v-for="group in shelfGroups" :key="group" :class="{ on: shelfGroup === group }" @click="shelfGroup = group">
            {{ group }}
          </button>
        </div>

        <div v-if="shelfBooks.length === 0" class="mo-empty">
          <div class="mo-empty-glyph">书</div>
          <p class="mo-empty-title">书架还是空的</p>
          <p class="muted">先在「书源」导入书源，再去「搜索」找一本想读的书。</p>
          <button class="mo-btn" @click="view = 'sources'">去导入书源</button>
        </div>

        <div v-else class="mo-shelf" data-testid="shelf">
          <button
            v-for="book in shelfSortedBooks"
            :key="book.id"
            class="mo-cover-card"
            :class="{ selected: selectedBookIds.has(book.id) }"
            data-testid="shelf-book"
            @pointerdown="onShelfPointerDown(book)"
            @pointerup="onShelfPointerUp"
            @pointerleave="onShelfPointerUp"
            @click="onShelfBookClick(book)"
          >
            <span class="mo-cover" :style="coverStyle(book)">
              <img v-if="book.coverUrl" :src="book.coverUrl" alt="" loading="lazy" />
              <span v-else class="mo-cover-glyph">{{ String(book.name || '书').slice(0, 1) }}</span>
              <span v-if="book.originName" class="mo-cover-origin">{{ book.originName }}</span>
              <span v-if="book.download?.downloaded" class="mo-cover-badge" data-testid="shelf-download-badge">已下 {{ book.download.downloaded }} 章</span>
              <span v-if="shelfSelecting" class="mo-cover-check" :class="{ on: selectedBookIds.has(book.id) }">
                {{ selectedBookIds.has(book.id) ? '✓' : '' }}
              </span>
            </span>
            <span class="mo-cover-name">{{ book.name }}</span>
            <span class="mo-cover-meta">{{ book.author || '未知作者' }}</span>
            <span class="mo-cover-progress">
              <i :style="{ width: `${shelfProgress(book)?.percent ?? 0}%` }" />
            </span>
            <span class="mo-cover-status">{{ shelfProgress(book)?.text ?? '未读' }}</span>
          </button>
        </div>
      </section>

      <section v-if="view === 'search'" class="mo-pane">
        <div class="mo-section-head">
          <h2>搜索</h2>
          <span class="muted">在 {{ searchScopeLabel }} 里找书</span>
        </div>
        <div class="mo-searchbar">
          <input
            v-model="searchKey"
            data-testid="search-key"
            placeholder="书名 / 作者"
            @keyup.enter="search"
          />
          <button class="mo-btn primary" :disabled="searching || !searchKey.trim()" data-testid="search" @click="search">
            {{ searching ? '搜索中…' : '搜索' }}
          </button>
        </div>
        <div class="mo-search-scope">
          <select v-model="searchScope" class="mo-select" aria-label="搜索范围">
            <option value="">全部启用源</option>
            <optgroup label="按分组">
              <option v-for="group in sourceGroups" :key="`g-${group}`" :value="`group:${group}`">分组：{{ group }}</option>
            </optgroup>
            <optgroup label="按书源">
              <option v-for="source in enabledSources" :key="`s-${source.id}`" :value="`source:${source.bookSourceUrl}`">
                书源：{{ source.bookSourceName || source.bookSourceUrl }}
              </option>
            </optgroup>
          </select>
          <label class="mo-switch"><input v-model="searchExact" type="checkbox" />精确书名</label>
          <span class="muted">范围：{{ searchScopeLabel }}</span>
        </div>
        <div v-if="searchHistory.length" class="mo-history">
          <span class="muted">最近：</span>
          <button v-for="item in searchHistory" :key="item" class="mo-chip" @click="useHistory(item)">{{ item }}</button>
        </div>

        <div v-if="books.length" class="mo-results">
          <button v-for="book in books" :key="book.origin + book.bookUrl" class="mo-result" data-testid="book" @click="openBook(book)">
            <span class="mo-result-cover" :style="coverStyle(book)">
              <img v-if="book.coverUrl" :src="book.coverUrl" alt="" loading="lazy" />
              <span v-else>{{ String(book.name || '书').slice(0, 1) }}</span>
            </span>
            <span class="mo-result-main">
              <span class="mo-result-name">{{ book.name }}</span>
              <span class="muted">{{ book.author || '未知作者' }} · {{ book.kind || '小说' }}</span>
              <span class="muted">{{ book.originName || book.origin }}</span>
            </span>
            <span class="mo-result-arrow">›</span>
          </button>
        </div>

        <div v-if="searchErrors.length" class="mo-errors">
          <p class="muted">{{ searchErrors.length }} 个书源检索失败</p>
          <p v-for="error in searchErrors.slice(0, 5)" :key="error.sourceUrl" class="muted">
            {{ error.sourceUrl }}：{{ error.message }}
          </p>
        </div>
      </section>

      <section v-if="view === 'explore'" class="mo-pane">
        <div class="mo-section-head">
          <h2>发现</h2>
          <span class="muted">{{ exploreSources.length }} 个书源可发现</span>
          <button class="mo-btn" :disabled="exploreLoading" data-testid="explore-refresh" @click="loadExploreGroups(true)">
            {{ exploreLoading ? '加载中…' : '刷新分类' }}
          </button>
        </div>

        <p v-if="exploreError && exploreSources.length > 0 && !exploreActive" class="muted mo-explore-error">
          发现加载失败：{{ exploreError }}
        </p>

        <div v-if="exploreLoading && exploreGroups.length === 0" class="mo-empty small">
          <p class="muted">正在加载分类…</p>
        </div>

        <div v-else-if="exploreSources.length === 0" class="mo-empty">
          <div class="mo-empty-glyph">源</div>
          <p class="mo-empty-title">还没有可发现的源</p>
          <p class="muted">书源开启「发现」并填写发现地址后，这里就能按分类找书。</p>
          <p v-if="exploreError" class="muted mo-explore-error">{{ exploreError }}</p>
          <button class="mo-btn" data-testid="explore-goto-sources" @click="view = 'sources'">去书源</button>
        </div>

        <template v-else>
          <div v-for="section in exploreSections" :key="section.name" class="mo-explore-section">
            <h3 class="mo-explore-section-title">{{ section.name }}</h3>
            <div v-for="group in section.items" :key="group.source.bookSourceUrl" class="mo-explore-group">
              <div class="mo-explore-head">
                <h3>{{ group.source.bookSourceName || group.source.bookSourceUrl }}</h3>
                <span class="muted">{{ group.categories.length }} 个分类</span>
              </div>
              <p v-if="group.error" class="muted mo-explore-error">{{ group.error }}</p>
              <p v-else-if="group.categories.length === 0" class="muted">这个源没有分类</p>
              <div v-else class="mo-explore-chips">
                <button
                  v-for="category in group.categories"
                  :key="category.url"
                  class="mo-chip"
                  :class="{ on: isActiveCategory(group, category) }"
                  @click="selectExploreCategory(group, category)"
                >
                  {{ category.name }}
                </button>
              </div>
            </div>
          </div>

          <div v-if="exploreActive" class="mo-explore-result">
            <div class="mo-section-head">
              <h3>{{ exploreActive.sourceName }} · {{ exploreActive.name }}</h3>
              <span class="muted">
                {{ exploreBooks.length }} 本<span v-if="explorePage"> · 第 {{ explorePage }} 页</span>
              </span>
            </div>

            <div v-if="exploreBusy && exploreBooks.length === 0" class="mo-empty small">
              <p class="muted">正在加载书目…</p>
            </div>
            <div v-else-if="exploreBooks.length" class="mo-results">
              <button
                v-for="book in exploreBooks"
                :key="book.origin + book.bookUrl"
                class="mo-result"
                data-testid="explore-book"
                @click="openBook(book)"
              >
                <span class="mo-result-cover" :style="coverStyle(book)">
                  <img v-if="book.coverUrl" :src="book.coverUrl" alt="" loading="lazy" />
                  <span v-else>{{ String(book.name || '书').slice(0, 1) }}</span>
                </span>
                <span class="mo-result-main">
                  <span class="mo-result-name">{{ book.name }}</span>
                  <span class="muted">{{ book.author || '未知作者' }} · {{ book.kind || '小说' }}</span>
                  <span v-if="book.lastChapter" class="muted">最新：{{ book.lastChapter }}</span>
                  <span class="muted">{{ book.originName || book.origin }}</span>
                </span>
                <span class="mo-result-arrow">›</span>
              </button>
            </div>
            <div v-else-if="!exploreBusy && !exploreError" class="mo-empty small">
              <p class="muted">这个分类暂时没有书</p>
            </div>

            <div v-if="exploreError" class="mo-errors">
              <p class="muted">加载失败：{{ exploreError }}</p>
            </div>

            <div v-if="exploreHasMore && !exploreError" class="mo-explore-more">
              <button class="mo-btn" :disabled="exploreBusy" data-testid="explore-more" @click="loadExplorePage(explorePage + 1, false)">
                {{ exploreBusy ? '加载中…' : '加载更多' }}
              </button>
            </div>
            <p v-else-if="!exploreError && exploreBooks.length" class="muted mo-explore-note">没有更多了</p>
          </div>
        </template>
      </section>

      <section v-if="view === 'detail' && currentBook" class="mo-pane">
        <button class="mo-back" data-testid="detail-back" @click="backFromDetail">‹ 返回</button>

        <div class="mo-hero">
          <span class="mo-hero-cover" :style="coverStyle(currentBook)">
            <img v-if="currentBook.coverUrl" :src="currentBook.coverUrl" alt="" />
            <span v-else>{{ String(currentBook.name || '书').slice(0, 1) }}</span>
          </span>
          <div class="mo-hero-main">
            <h2>{{ currentBook.name }}</h2>
            <p class="muted">
              {{ currentBook.author || '未知作者' }} · {{ currentBook.kind || '小说' }}
              <span v-if="currentBook.rating" class="mo-score">{{ currentBook.rating }}</span>
            </p>
            <p class="muted">
              {{ currentBook.originName || currentBook.origin }} · {{ chapters.length }} 章
              <span v-if="currentBook.wordCount"> · {{ currentBook.wordCount }}</span>
              <span v-if="bookStatus(currentBook)" class="mo-tag soft">{{ bookStatus(currentBook) }}</span>
              <span v-if="isPdfBook" class="mo-tag soft" data-testid="pdf-tag">PDF · 原版</span>
            </p>
            <div class="mo-hero-actions">
              <button class="mo-btn primary" data-testid="read-start" @click="continueReading">
                {{ isPdfReadable ? (hasPdfProgress ? '继续原版' : '原版阅读') : progress ? '继续阅读' : '开始阅读' }}
              </button>
              <button v-if="isPdfReadable" class="mo-btn" data-testid="read-text" @click="continueReadingText">文本模式</button>
              <button v-if="!currentBook.id" class="mo-btn" data-testid="add-shelf" @click="addToShelf">加入书架</button>
              <span v-else class="mo-tag">已在书架</span>
              <button
                v-if="currentBook.origin !== 'local'"
                class="mo-btn"
                data-testid="switch-source"
                @click="openSwitchPanel"
              >
                换源
              </button>
              <button class="mo-btn" data-testid="simulate" @click="openSimulate">模拟阅读</button>
              <button class="mo-btn" :disabled="cacheBusy" data-testid="cache-book" @click="cacheBookChapters">{{ cacheBusy ? '缓存中…' : '缓存 20 章' }}</button>
              <button
                class="mo-btn"
                :disabled="exportBusy || isExportRunning(exportJob)"
                data-testid="export-start"
                @click="startExport('txt')"
              >
                {{ isExportRunning(exportJob) && exportJob?.format === 'txt' ? '导出中…' : '导出 TXT' }}
              </button>
              <button
                class="mo-btn"
                :disabled="exportBusy || isExportRunning(exportJob)"
                data-testid="export-epub"
                @click="startExport('epub')"
              >
                {{ isExportRunning(exportJob) && exportJob?.format === 'epub' ? '导出中…' : '导出 EPUB' }}
              </button>
              <span v-if="currentBook.simulateEnabled" class="mo-tag soft">模拟至 {{ simulatedChapterCount(currentBook) }} 章</span>
              <span v-if="progress" class="muted">
                {{ progress.chapterTitle || `第 ${progress.chapterIndex + 1} 章` }}
              </span>
            </div>
          </div>
        </div>

        <div v-if="currentBook.origin !== 'local'" class="mo-download" data-testid="download-panel">
          <div class="mo-download-head">
            <h3>离线下载</h3>
            <span v-if="downloadJob" class="mo-tag" data-testid="download-status">{{ downloadStatusText(downloadJob) }}</span>
          </div>
          <p class="mo-download-summary" data-testid="download-summary">
            已下载 {{ downloadSummary?.downloaded ?? 0 }}/{{ downloadSummary?.total || chapters.length }} 章 · 占用
            {{ formatBytes(downloadSummary?.bytes ?? 0) }}
            <template v-if="downloadSummary?.job"> · {{ downloadStatusText(downloadSummary.job) }}</template>
            <template v-if="downloadSummary?.failed"> · 失败 {{ downloadSummary.failed }}</template>
            <template v-if="downloadSummary?.skipped"> · 跳过 {{ downloadSummary.skipped }}</template>
          </p>
          <div v-if="!deleteConfirmOpen" class="mo-download-actions">
            <button
              class="mo-btn"
              data-testid="delete-downloads"
              :disabled="downloadDeleting || (!downloadSummary?.downloaded && !downloadSummary?.job)"
              @click="deleteConfirmOpen = true"
            >
              删除已下载
            </button>
          </div>
          <div v-else class="mo-download-actions">
            <span class="muted">只清文字缓存，书与进度保留</span>
            <button
              class="mo-btn danger"
              data-testid="delete-downloads-confirm"
              :disabled="downloadDeleting"
              @click="deleteDownloaded"
            >
              {{ downloadDeleting ? '删除中…' : '确认删除' }}
            </button>
            <button class="mo-btn" :disabled="downloadDeleting" @click="deleteConfirmOpen = false">取消</button>
          </div>
          <div class="mo-download-scope">
            <label><input v-model="downloadScope" type="radio" value="rest" />从当前章到末尾</label>
            <label><input v-model="downloadScope" type="radio" value="all" />整本</label>
            <label><input v-model="downloadScope" type="radio" value="range" />指定起止</label>
            <template v-if="downloadScope === 'range'">
              <input v-model.number="downloadFrom" type="number" min="1" :max="chapters.length" aria-label="起始章" />
              <span>至</span>
              <input v-model.number="downloadTo" type="number" min="1" :max="chapters.length" aria-label="结束章" />
            </template>
            <button
              class="mo-btn primary"
              data-testid="download-start"
              :disabled="downloadBusy || isDownloadRunning(downloadJob)"
              @click="startDownload"
            >
              开始下载
            </button>
          </div>
          <div v-if="downloadJob" class="mo-download-progress">
            <span class="mo-download-bar"><span :style="{ width: `${downloadPercent(downloadJob)}%` }" /></span>
            <span data-testid="download-done">已完成 {{ downloadJob.completed }} / {{ downloadJob.total }} 章</span>
            <span>失败 {{ downloadJob.failed }}</span>
            <span>跳过 {{ downloadJob.skipped }}</span>
            <span>{{ formatBytes(downloadJob.bytes) }}</span>
          </div>
          <p v-if="downloadJob?.error && downloadJob.status !== 'paused'" class="muted">{{ downloadJob.error }}</p>
          <div v-if="downloadJob" class="mo-download-actions">
            <button
              v-if="isDownloadRunning(downloadJob)"
              class="mo-btn"
              data-testid="download-pause"
              :disabled="downloadBusy"
              @click="pauseDownload"
            >
              暂停
            </button>
            <button
              v-if="downloadJob.status === 'paused'"
              class="mo-btn primary"
              data-testid="download-resume"
              :disabled="downloadBusy"
              @click="resumeDownload"
            >
              继续
            </button>
            <button
              v-if="['queued', 'running', 'paused'].includes(downloadJob.status)"
              class="mo-btn danger"
              data-testid="download-cancel"
              :disabled="downloadBusy"
              @click="cancelDownload"
            >
              取消
            </button>
            <button
              v-if="downloadJob.failed > 0 && !isDownloadRunning(downloadJob)"
              class="mo-btn"
              data-testid="download-retry"
              :disabled="downloadBusy"
              @click="retryDownload"
            >
              重试失败章
            </button>
          </div>
        </div>

        <div
          v-if="currentBook.origin !== 'local' && mediaSummary?.kind"
          class="mo-download"
          data-testid="media-download-panel"
        >
          <div class="mo-download-head">
            <h3>离线媒体</h3>
            <span v-if="mediaJob" class="mo-tag" data-testid="media-download-status">{{ downloadStatusText(mediaJob) }}</span>
          </div>
          <p class="mo-download-summary" data-testid="media-download-summary">
            已离线 {{ mediaSummary?.downloaded ?? 0 }}/{{ mediaSummary?.total || chapters.length }} {{ mediaUnit() }} · 占用
            {{ formatBytes(mediaSummary?.bytes ?? 0) }}
            <template v-if="mediaSummary?.job"> · {{ downloadStatusText(mediaSummary.job) }}</template>
            <template v-if="mediaSummary?.failed"> · 失败 {{ mediaSummary.failed }}</template>
            <template v-if="mediaSummary?.skipped"> · 跳过 {{ mediaSummary.skipped }}</template>
          </p>
          <p v-if="mediaQuotaWarning" class="muted" data-testid="media-quota-warning">{{ mediaQuotaWarning }}</p>
          <div v-if="!mediaDeleteConfirmOpen" class="mo-download-actions">
            <button
              class="mo-btn"
              data-testid="media-delete-downloads"
              :disabled="mediaDeleting || (!mediaSummary?.downloaded && !mediaSummary?.job)"
              @click="mediaDeleteConfirmOpen = true"
            >
              删除离线文件
            </button>
          </div>
          <div v-else class="mo-download-actions">
            <span class="muted">只清媒体文件与索引，书与进度保留</span>
            <button
              class="mo-btn danger"
              data-testid="media-delete-downloads-confirm"
              :disabled="mediaDeleting"
              @click="deleteMediaDownloaded"
            >
              {{ mediaDeleting ? '删除中…' : '确认删除' }}
            </button>
            <button class="mo-btn" :disabled="mediaDeleting" @click="mediaDeleteConfirmOpen = false">取消</button>
          </div>
          <div class="mo-download-scope">
            <label><input v-model="mediaScope" type="radio" value="current" data-testid="media-scope-current" />当前章</label>
            <label><input v-model="mediaScope" type="radio" value="all" data-testid="media-scope-all" />整本</label>
            <label><input v-model="mediaScope" type="radio" value="range" data-testid="media-scope-range" />指定起止</label>
            <template v-if="mediaScope === 'range'">
              <input v-model.number="mediaFrom" type="number" min="1" :max="chapters.length" aria-label="起始章" />
              <span>至</span>
              <input v-model.number="mediaTo" type="number" min="1" :max="chapters.length" aria-label="结束章" />
            </template>
            <button
              class="mo-btn primary"
              data-testid="media-download-start"
              :disabled="mediaBusy || isDownloadRunning(mediaJob)"
              @click="startMediaDownload"
            >
              开始离线下载
            </button>
          </div>
          <p class="muted">漫画按章保存整章图片；音频与视频保存当个媒体文件。HLS 会按最高码率整章下载；受版权保护（DRM）的会提示无法离线。</p>
          <div v-if="mediaJob" class="mo-download-progress">
            <span class="mo-download-bar"><span :style="{ width: `${downloadPercent(mediaJob)}%` }" /></span>
            <span data-testid="media-download-done">已完成 {{ mediaJob.completed }} / {{ mediaJob.total }} {{ mediaUnit() }}</span>
            <span>失败 {{ mediaJob.failed }}</span>
            <span>跳过 {{ mediaJob.skipped }}</span>
            <span>{{ formatBytes(mediaJob.bytes) }}</span>
          </div>
          <p v-if="mediaJob?.error && mediaJob.status !== 'paused'" class="muted" data-testid="media-download-error">{{ mediaJob.error }}</p>
          <div v-if="mediaJob" class="mo-download-actions">
            <button
              v-if="isDownloadRunning(mediaJob)"
              class="mo-btn"
              data-testid="media-download-pause"
              :disabled="mediaBusy"
              @click="pauseMediaDownload"
            >
              暂停
            </button>
            <button
              v-if="mediaJob.status === 'paused'"
              class="mo-btn primary"
              data-testid="media-download-resume"
              :disabled="mediaBusy"
              @click="resumeMediaDownload"
            >
              继续
            </button>
            <button
              v-if="['queued', 'running', 'paused'].includes(mediaJob.status)"
              class="mo-btn danger"
              data-testid="media-download-cancel"
              :disabled="mediaBusy"
              @click="cancelMediaDownload"
            >
              取消
            </button>
            <button
              v-if="mediaJob.failed > 0 && !isDownloadRunning(mediaJob)"
              class="mo-btn"
              data-testid="media-download-retry"
              :disabled="mediaBusy"
              @click="retryMediaDownload"
            >
              重试失败章
            </button>
          </div>
        </div>

        <div v-if="currentBook.origin !== 'local'" class="mo-download" data-testid="export-panel">
          <div class="mo-download-head">
            <h3>导出全本</h3>
            <span v-if="exportJob" class="mo-tag" data-testid="export-status">{{ exportStatusText(exportJob) }}</span>
          </div>
          <p class="mo-download-summary">导出 TXT、EPUB 或 PDF 全本，目录多少章都导完；生成的文件保留 24 小时。</p>
          <div class="mo-download-actions">
            <label class="mo-export-font">
              <span>中文字体</span>
              <select v-model="exportFontId" class="mo-select" data-testid="export-font">
                <option value="">未选择</option>
                <option v-for="font in customFonts" :key="font.id" :value="font.id">{{ font.name }}</option>
              </select>
            </label>
            <button
              class="mo-btn"
              data-testid="export-pdf"
              :disabled="exportBusy || isExportRunning(exportJob)"
              @click="startExport('pdf')"
            >
              {{ isExportRunning(exportJob) && exportJob?.format === 'pdf' ? '导出中…' : '导出 PDF' }}
            </button>
          </div>
          <p v-if="!customFonts.length" class="muted">PDF 需要使用中文字体，请先在阅读设置里上传。</p>
          <p v-if="exportMessage" class="muted" data-testid="export-error">{{ exportMessage }}</p>
          <div v-if="exportJob" class="mo-download-progress">
            <span class="mo-download-bar"><span :style="{ width: `${exportPercent(exportJob)}%` }" /></span>
            <span>已完成 {{ exportJob.completed }} / {{ exportJob.total }} 章</span>
            <span>失败 {{ exportJob.failed }}</span>
            <span>{{ formatBytes(exportJob.bytes) }}</span>
          </div>
          <p v-if="exportFailedChapters(exportJob)" class="muted" data-testid="export-failed-chapters">
            未导出章节：{{ exportFailedChapters(exportJob) }}
          </p>
          <p v-if="exportJob?.error && exportJob.status !== 'paused'" class="muted">{{ exportJob.error }}</p>
          <div v-if="exportJob" class="mo-download-actions">
            <a
              v-if="exportDownload?.url"
              class="mo-btn primary"
              data-testid="export-download"
              :href="exportDownload.url"
              :download="exportDownload.fileName"
            >
              下载文件
            </a>
            <a
              v-if="exportFailedDownload?.url"
              class="mo-btn"
              data-testid="export-failed-download"
              :href="exportFailedDownload.url"
              :download="exportFailedDownload.fileName"
            >
              下载失败清单
            </a>
            <button
              v-if="['queued', 'running', 'paused'].includes(exportJob.status)"
              class="mo-btn danger"
              data-testid="export-cancel"
              :disabled="exportBusy"
              @click="cancelExport"
            >
              取消
            </button>
            <button
              v-if="!isExportRunning(exportJob) && exportJob.status !== 'done'"
              class="mo-btn"
              :disabled="exportBusy"
              @click="startExport(exportJob.format, exportJob.fontId)"
            >
              重新导出
            </button>
          </div>
        </div>

        <p
          v-if="localPdfStatus?.isPdf && localPdfStatus?.needsReimport"
          class="muted mo-local-pdf-hint"
          data-testid="pdf-reimport-hint"
        >
          这是旧版本导入的 PDF，缺少原文件；重新导入同一文件即可补齐，文字与阅读进度不受影响
        </p>

        <p v-if="introText" class="mo-intro">{{ introText }}</p>

        <div class="mo-toc-block">
          <div class="mo-section-head">
            <h3>目录</h3>
            <input v-model="tocFilter" class="mo-toc-filter" placeholder="搜索章节" />
          </div>
          <p v-if="tocHasMore" class="muted">已显示 {{ filteredChapters.length }} / {{ tocTotal }} 章</p>
          <p v-if="chapterError" class="muted mo-chapter-error" data-testid="chapter-error">{{ chapterError }}</p>
          <ol class="mo-toc" data-testid="toc">
            <li v-for="chapter in filteredChapters" :key="chapter.url || chapter.title" :class="{ volume: chapter.isVolume }">
              <button v-if="!chapter.isVolume" data-testid="chapter" @click="openTocChapter(chapter)">{{ chapter.title }}</button>
              <span v-else>{{ chapter.title }}</span>
            </li>
          </ol>
          <button v-if="tocHasMore" class="mo-btn" data-testid="toc-more" @click="tocPage += 1">加载更多</button>
        </div>
      </section>

      <section v-if="view === 'sources'" class="mo-pane">
        <div class="mo-section-head">
          <h2>书源</h2>
          <span class="muted">{{ sources.length }} 个 · 启用 {{ enabledCount }}</span>
        </div>

        <div class="mo-card">
          <h3 class="mo-card-title">导入书源</h3>
          <p class="muted">粘贴「阅读」书源 JSON，或选择书源文件（.json，单个或数组）。</p>
          <textarea v-model="importText" data-testid="import-text" rows="5" placeholder='[{"bookSourceUrl":"https://…","bookSourceName":"…"}]' />
          <div class="mo-row">
            <label class="mo-file" title="选择 Legado 书源 JSON 文件">
              <input type="file" accept=".json,application/json" data-testid="import-file" @change="onImportFile" />
              <span class="mo-btn">选择文件</span>
            </label>
            <button class="mo-btn primary" :disabled="busy || !importText.trim()" data-testid="import" @click="importSources">导入</button>
            <span class="muted">{{ importMessage }}</span>
          </div>
        </div>

        <div class="mo-card">
          <div class="mo-card-head">
            <h3 class="mo-card-title">书源列表</h3>
            <span class="muted">{{ filteredSortedSources.length }} 个 · 启用 {{ enabledCount }}</span>
          </div>
          <div class="mo-source-tools">
            <input v-model="sourceFilter" class="mo-filter" placeholder="筛选名称 / 地址 / 分组" />
            <select v-model="sourceGroup" class="mo-select" aria-label="分组筛选">
              <option value="">全部分组</option>
              <option v-for="group in sourceGroups" :key="group" :value="group">{{ group }}</option>
            </select>
            <select v-model="sourceDomain" class="mo-select" aria-label="域名筛选">
              <option value="">全部域名</option>
              <option v-for="domain in sourceDomains" :key="domain" :value="domain">{{ domain }}</option>
            </select>
            <select v-model="sourceSort" class="mo-select" aria-label="排序">
              <option value="name">按名称</option>
              <option value="url">按地址</option>
              <option value="updated">按更新时间</option>
              <option value="enabled">按启用状态</option>
            </select>
            <select v-model="sourceLogin" class="mo-select" aria-label="登录要求">
              <option value="all">全部</option>
              <option value="required">需登录</option>
              <option value="none">免登录</option>
            </select>
            <label class="mo-switch" title="只看开启发现且有发现地址的书源">
              <input v-model="sourceExploreOnly" type="checkbox" data-testid="source-explore-only" />
              有发现
            </label>
            <button class="mo-btn" data-testid="source-check" @click="runSourceCheck">结构检查</button>
          </div>
          <div class="mo-source-bulk">
            <label class="mo-switch"><input type="checkbox" :checked="allPageSelected" @change="toggleSelectPage" />本页全选</label>
            <span class="muted">已选 {{ selectedCount }} 个</span>
            <button class="mo-btn" :disabled="selectedCount === 0 || busy" data-testid="batch-enable" @click="batchSetEnabled(true)">批量启用</button>
            <button class="mo-btn" :disabled="selectedCount === 0 || busy" data-testid="batch-disable" @click="batchSetEnabled(false)">批量禁用</button>
            <button class="mo-btn" :disabled="selectedCount === 0 || busy" data-testid="batch-export" @click="exportSelectedSources">导出选中</button>
            <span v-if="sourceMessage" class="muted" data-testid="source-message">{{ sourceMessage }}</span>
          </div>
          <div v-if="checkReport" class="mo-check-report" data-testid="source-check-report">
            <p>检查 {{ checkReport.total }} 个：通过 {{ checkReport.ok }}，问题 {{ checkReport.problems.length }}</p>
            <ul v-if="checkReport.problems.length">
              <li v-for="item in checkReport.problems.slice(0, 8)" :key="item.name">{{ item.name }}：{{ item.message }}</li>
              <li v-if="checkReport.problems.length > 8" class="muted">…另有 {{ checkReport.problems.length - 8 }} 个</li>
            </ul>
          </div>
          <div class="mo-source-online">
            <button
              class="mo-btn"
              :disabled="onlineCheckBusy || onlineCheckTargets.length === 0"
              data-testid="source-online-check"
              @click="runOnlineSourceCheck"
            >
              {{ onlineCheckBusy ? '检查中' : '在线检查' }}
            </button>
            <span class="muted">{{ onlineCheckScope }}，检查能否打开</span>
          </div>
          <div v-if="onlineCheckReport" class="mo-check-report" data-testid="source-online-report">
            <p>
              在线检查（{{ onlineCheckReport.scope === 'selected' ? '已选' : '本页' }}）
              {{ onlineCheckReport.total }} 个：可达 {{ onlineCheckReport.ok }}
            </p>
            <ul>
              <li v-for="item in onlineCheckReport.results" :key="item.url" data-testid="source-online-row">
                <span>{{ sourceNameOf(item.url) }}</span>
                <span class="mo-tag soft">{{ item.ok ? '可达' : '不可达' }}</span>
                <span v-if="item.status !== null" class="muted">HTTP {{ item.status }}</span>
                <span class="muted">{{ item.elapsedMs }}ms</span>
                <span v-if="item.error" class="muted">{{ item.error }}</span>
              </li>
            </ul>
          </div>
          <div v-if="filteredSortedSources.length === 0" class="mo-empty small">没有匹配的书源。</div>
          <ul class="mo-sources">
            <li v-for="source in pagedSources" :key="source.id || source.bookSourceUrl" data-testid="source-row">
              <input
                type="checkbox"
                class="mo-pick"
                :checked="selectedSourceIds.has(source.id)"
                aria-label="选择书源"
                @change="toggleSelectSource(source)"
              />
              <label class="mo-switch">
                <input type="checkbox" :checked="source.enabled !== false" @change="toggleSource(source)" />
                <span class="mo-source-name">{{ source.bookSourceName || source.bookSourceUrl }}</span>
              </label>
              <span class="mo-url">{{ source.bookSourceUrl }}</span>
              <span v-if="source.bookSourceGroup" class="mo-tag soft">{{ source.bookSourceGroup }}</span>
              <span class="mo-tag soft">{{ sourceTypeNames[source.bookSourceType ?? 0] ?? '文本' }}</span>
              <span v-if="hasExplore(source)" class="mo-tag soft">发现</span>
              <span v-if="needsLogin(source)" class="mo-tag warn">需登录</span>
              <span v-else-if="source.enabledCookieJar" class="mo-tag soft">Cookie</span>
              <button class="mo-btn tiny" :disabled="busy" title="导出为 Legado JSON" data-testid="source-export" @click="exportSource(source)">导出</button>
              <button class="mo-icon-btn" title="编辑" data-testid="source-edit" @click="beginEdit(source)">✎</button>
              <button class="mo-icon-btn danger" title="删除" @click="removeSource(source)">✕</button>
            </li>
          </ul>
          <div v-if="sourcePageCount > 1" class="mo-pager">
            <button class="mo-btn" :disabled="sourcePage <= 1" @click="sourcePage -= 1">上一页</button>
            <span class="muted">第 {{ sourcePage }} / {{ sourcePageCount }} 页</span>
            <button class="mo-btn" :disabled="sourcePage >= sourcePageCount" @click="sourcePage += 1">下一页</button>
          </div>
        </div>

        <div ref="dictCardRef" class="mo-card" data-testid="dict-card">
          <div class="mo-card-head">
            <h3 class="mo-card-title">字典规则</h3>
            <span class="muted">{{ dictRules.length }} 条 · 启用 {{ dictEnabledCount }}</span>
            <div class="mo-dict-actions">
              <button class="mo-btn tiny" data-testid="dict-add" @click="beginDictEdit()">新增</button>
              <button class="mo-btn tiny" :disabled="busy" data-testid="dict-export" @click="exportDicts">导出</button>
            </div>
          </div>
          <p v-pre class="muted">网址里用 {{key}} 占位，试查时替换成要查的词。</p>

          <div v-if="dictRules.length" class="mo-dict-list">
            <div v-for="(item, index) in dictRules" :key="item.id" class="mo-dict-row" data-testid="dict-row">
              <label class="mo-switch">
                <input type="checkbox" :checked="item.enabled !== false" @change="toggleDictRule(item)" />
                <span class="mo-source-name">{{ item.name || '未命名字典' }}</span>
              </label>
              <span v-if="item.group" class="mo-tag soft">{{ item.group }}</span>
              <span class="mo-url">{{ item.url }}</span>
              <button class="mo-btn tiny" :disabled="index === 0" title="上移" @click="moveDictRule(item, -1)">上移</button>
              <button class="mo-btn tiny" :disabled="index === dictRules.length - 1" title="下移" @click="moveDictRule(item, 1)">下移</button>
              <button class="mo-btn tiny" :disabled="busy" @click="beginDictEdit(item)">编辑</button>
              <button class="mo-btn tiny danger" :disabled="busy" @click="removeDictRule(item)">删除</button>
            </div>
          </div>
          <div v-else class="mo-empty small">
            <p>还没有字典规则</p>
            <p class="muted">导入阅读的字典 JSON，或新增一条试试。</p>
            <button class="mo-btn tiny primary" @click="beginDictEdit()">新增字典</button>
          </div>

          <textarea
            v-model="dictImportText"
            class="mo-json"
            rows="3"
            data-testid="dict-import-text"
            placeholder='粘贴字典 JSON，如 [{"name":"…","url":"https://…/{{key}}","rule":"class.…@text"}]'
          />
          <div class="mo-row">
            <label class="mo-file" title="选择字典 JSON 文件">
              <input type="file" accept=".json,application/json" data-testid="dict-import-file" @change="onImportDictFile" />
              <span class="mo-btn tiny">选择文件</span>
            </label>
            <button class="mo-btn tiny" :disabled="busy || !dictImportText.trim()" data-testid="dict-import" @click="importDicts">导入</button>
            <span class="muted">{{ dictMessage }}</span>
          </div>

          <div class="mo-dict-trial">
            <div class="mo-row">
              <input v-model="dictQuery" placeholder="输入要查的词" data-testid="dict-query" @keyup.enter="runDictLookup" />
              <button
                class="mo-btn primary"
                :disabled="dictTrialBusy || !dictQuery.trim()"
                data-testid="dict-lookup"
                @click="runDictLookup"
              >
                {{ dictTrialBusy ? '查询中…' : '试查' }}
              </button>
              <span class="muted">{{ dictEnabledCount ? `同时查询 ${dictEnabledCount} 本字典` : '先新增并启用字典' }}</span>
            </div>
            <div v-if="dictEnabledCount === 0" class="mo-empty small">
              <p>还没有启用的字典</p>
              <p class="muted">新增一条字典后，这里会同时查询所有启用的字典。</p>
              <button class="mo-btn tiny primary" @click="beginDictEdit()">新增字典</button>
            </div>
            <template v-else-if="dictResults.length">
              <div class="mo-dict-tabs" role="tablist">
                <button
                  v-for="item in dictResults"
                  :key="item.id"
                  :class="{ on: item.id === dictActiveResult?.id }"
                  role="tab"
                  @click="dictActiveTab = item.id"
                >
                  {{ item.name }}<span v-if="!item.ok" class="mo-dict-fail">失败</span>
                </button>
              </div>
              <div v-if="dictActiveResult" class="mo-dict-result" data-testid="dict-result">
                <template v-if="dictActiveResult.ok">
                  <pre class="mo-dict-text" data-testid="dict-result-text">{{ dictActiveResult.text || '（没有提取到释义）' }}</pre>
                  <div class="mo-row">
                    <button class="mo-btn tiny" @click="copyDictResult(dictActiveResult)">复制</button>
                    <button class="mo-btn tiny" :disabled="!dictActiveResult.url" @click="openDictResult(dictActiveResult)">打开</button>
                    <span class="mo-url">{{ dictActiveResult.url }}</span>
                  </div>
                </template>
                <p v-else class="muted">查询失败：{{ dictActiveResult.error }}</p>
              </div>
            </template>
          </div>
        </div>

        <div v-if="dictEditing" class="mo-card" data-testid="dict-editor">
          <h3 class="mo-card-title">编辑字典：{{ dictEditing.name || '新字典' }}</h3>
          <div class="mo-row">
            <input v-model="dictEditing.name" placeholder="名称" data-testid="dict-name" />
            <input v-model="dictEditing.group" placeholder="分组（可选）" />
            <label class="mo-switch"><input type="checkbox" v-model="dictEditing.enabled" />启用</label>
          </div>
          <div class="mo-row">
            <input v-model="dictEditing.url" placeholder="地址，必须含 {{key}}" data-testid="dict-url" />
          </div>
          <div class="mo-row">
            <input v-model="dictEditing.rule" placeholder="提取规则，如 class.meaning@text" data-testid="dict-rule" />
          </div>
          <textarea
            v-model="dictEditing.header"
            class="mo-json"
            rows="2"
            placeholder='请求头 JSON（可选），如 {"Referer":"https://…"}'
          />
          <div class="mo-row">
            <button class="mo-btn primary" :disabled="busy" data-testid="dict-save" @click="saveDict">保存</button>
            <button class="mo-btn" @click="dictEditing = null">取消</button>
          </div>
        </div>

        <div v-if="editing" class="mo-card" data-testid="source-editor">
          <h3 class="mo-card-title">编辑书源：{{ editing.bookSourceName || editing.bookSourceUrl }}</h3>
          <div class="mo-row">
            <input v-model="editing.bookSourceName" placeholder="名称" data-testid="source-name" />
            <input v-model="editing.bookSourceUrl" placeholder="地址" />
          </div>
          <div class="mo-row">
            <input v-model="editing.bookSourceGroup" placeholder="分组" />
            <select v-model.number="editing.bookSourceType">
              <option :value="0">文本</option>
              <option :value="1">音频</option>
              <option :value="2">图片</option>
              <option :value="3">文件</option>
              <option :value="4">视频</option>
            </select>
            <label class="mo-switch"><input type="checkbox" v-model="editing.enabled" />启用</label>
            <label class="mo-switch"><input type="checkbox" v-model="editing.enabledExplore" />发现</label>
          </div>
          <textarea v-model="editingJson" class="mo-json" rows="14" data-testid="source-json" />
          <div class="mo-row">
            <button class="mo-btn primary" data-testid="source-save" @click="saveEditing">保存</button>
            <button class="mo-btn" @click="editing = null">收起</button>
            <span class="muted">全字段可改 JSON；名称/地址/分组/类型以表单为准。</span>
          </div>
          <div class="mo-debug">
            <div class="mo-row">
              <select v-model="debugType">
                <option value="search">搜索</option>
                <option value="bookInfo">详情</option>
                <option value="toc">目录</option>
                <option value="content">正文</option>
              </select>
              <input v-model="debugInput" :placeholder="debugType === 'search' ? '搜索词（默认「测试」）' : '页面 URL'" data-testid="debug-input" />
              <button class="mo-btn" :disabled="debugBusy" data-testid="debug-run" @click="runDebug">{{ debugBusy ? '调试中…' : '调试' }}</button>
            </div>
            <p class="muted">调试使用已保存的书源，改完先保存。</p>
            <pre v-if="debugResult" class="mo-debug-out" data-testid="debug-output">{{ JSON.stringify(debugResult, null, 2).slice(0, 20000) }}</pre>
          </div>
        </div>
      </section>

      <section v-if="view === 'rss'" class="mo-pane">
        <div class="mo-section-head">
          <h2>订阅</h2>
          <span class="muted">{{ rssSources.length }} 个</span>
        </div>

        <div class="mo-card">
          <h3 class="mo-card-title">导入订阅源</h3>
          <p class="muted">粘贴「阅读」RssSource JSON，或选择文件；当前支持 RSS 2.0 / Atom。</p>
          <textarea v-model="rssImportText" rows="4" placeholder='[{"sourceUrl":"https://…/rss.xml","sourceName":"…"}]' />
          <div class="mo-row">
            <label class="mo-file" title="选择订阅源 JSON">
              <input type="file" accept=".json,application/json" data-testid="rss-import-file" @change="onRssImportFile" />
              <span class="mo-btn">选择文件</span>
            </label>
            <button class="mo-btn primary" :disabled="rssBusy || !rssImportText.trim()" data-testid="rss-import" @click="importRssSources">导入</button>
            <span class="muted">{{ rssMessage }}</span>
          </div>
        </div>

        <div class="mo-card">
          <h3 class="mo-card-title">订阅源</h3>
          <p v-if="rssSources.length === 0" class="muted">还没有订阅源。</p>
          <ul v-else class="mo-sources">
            <li v-for="source in rssSources" :key="source.id" data-testid="rss-source">
              <button class="mo-source-name" @click="openRssSource(source)">{{ source.sourceName }}</button>
              <span class="muted">{{ source.sourceGroup || '未分组' }}</span>
              <button class="mo-icon-btn" title="删除" @click="removeRssSource(source)">✕</button>
            </li>
          </ul>
        </div>

        <div v-if="rssActive" class="mo-card">
          <div class="mo-card-head">
            <h3 class="mo-card-title">{{ rssFeed?.title || rssActive.sourceName }}</h3>
            <span class="muted">{{ rssArticles.length }} 篇</span>
            <button class="mo-btn" @click="openRssSource(rssActive)">刷新</button>
          </div>
          <p v-if="rssBusy" class="muted">加载中…</p>
          <p v-else-if="rssArticles.length === 0" class="muted">没有解析到文章。</p>
          <ul v-else class="mo-articles">
            <li v-for="(item, index) in rssArticles" :key="index">
              <button class="mo-article-title" @click="openArticle(item)">{{ item.title || '（无标题）' }}</button>
              <span class="muted">{{ item.date }}</span>
            </li>
          </ul>
        </div>

        <transition name="mo-fade">
          <div v-if="article" class="mo-sheet-mask" @click.self="article = null">
            <div class="mo-sheet mo-sheet-scroll">
              <div class="mo-sheet-head">
                <strong>{{ article.title || '（无标题）' }}</strong>
                <button class="mo-icon-btn" @click="article = null">✕</button>
              </div>
              <p class="muted">{{ article.date }}<span v-if="article.author"> · {{ article.author }}</span></p>
              <p class="mo-article-body">{{ article.summary || '（无摘要）' }}</p>
              <a v-if="article.link" class="mo-btn" :href="article.link" target="_blank" rel="noreferrer">原文</a>
            </div>
          </div>
        </transition>
      </section>

      <section v-if="view === 'storage'" class="mo-pane" data-testid="storage-pane">
        <div class="mo-section-head">
          <h2>存储</h2>
          <span class="muted">文字缓存 · 媒体缓存 · 导出文件</span>
          <button class="mo-btn" :disabled="storageBusy" data-testid="storage-refresh" @click="loadStorageUsage">刷新</button>
        </div>
        <p v-if="storageBusy && !storageUsage" class="muted">统计中…</p>
        <p v-if="storageMessage" class="muted" data-testid="storage-message">{{ storageMessage }}</p>
        <p v-if="storageQuotaWarning" class="muted" data-testid="quota-warning">{{ storageQuotaWarning }}</p>

        <div class="mo-card" data-testid="storage-overview">
          <h3 class="mo-card-title">占用</h3>
          <div class="mo-storage-grid">
            <div class="mo-storage-item">
              <span class="muted">总量</span>
              <strong>{{ formatBytes(storageUsage?.total?.bytes || 0) }}</strong>
              <span class="muted">{{ storageUsage?.total?.files || 0 }} 个文件</span>
            </div>
            <div class="mo-storage-item">
              <span class="muted">文字缓存</span>
              <strong>{{ formatBytes(storageUsage?.text?.bytes || 0) }}</strong>
              <span class="muted">{{ storageUsage?.text?.files || 0 }} 个文件</span>
            </div>
            <div class="mo-storage-item">
              <span class="muted">媒体缓存</span>
              <strong>{{ formatBytes(storageUsage?.media?.bytes || 0) }}</strong>
              <span class="muted">{{ storageUsage?.media?.entries || 0 }} 章 · {{ storageUsage?.media?.books || 0 }} 本</span>
            </div>
            <div class="mo-storage-item">
              <span class="muted">导出文件</span>
              <strong>{{ formatBytes(storageUsage?.exports?.bytes || 0) }}</strong>
              <span class="muted">{{ storageUsage?.exports?.files || 0 }} 个文件</span>
            </div>
          </div>
        </div>

        <div class="mo-card" data-testid="storage-quota">
          <div class="mo-card-head">
            <h3 class="mo-card-title">媒体配额</h3>
            <span class="mo-tag" data-testid="quota-source">{{ quotaSourceText }}</span>
          </div>
          <p class="muted">当前生效 {{ formatBytes(storageUsage?.quota?.bytes || 0) }}，超过后按最久未读整本清理。</p>
          <div class="mo-row">
            <input v-model.number="quotaDraft" type="number" min="0" step="1" data-testid="quota-input" aria-label="媒体配额（GB）" />
            <span class="muted">GB</span>
            <button class="mo-btn primary" :disabled="quotaSaving" data-testid="quota-save" @click="saveMediaQuota">
              {{ quotaSaving ? '保存中…' : '保存' }}
            </button>
            <span class="muted">填 0 用默认或环境变量</span>
          </div>
        </div>

        <div class="mo-card" data-testid="storage-books">
          <div class="mo-card-head">
            <h3 class="mo-card-title">按书清理</h3>
            <span class="muted">{{ storageBooks.length }} 本有缓存</span>
          </div>
          <p v-if="storageBooks.length === 0" class="muted">还没有缓存内容。</p>
          <div
            v-for="book in storageBooks"
            :key="book.bookId"
            class="mo-storage-book"
            :data-testid="`storage-book-${book.bookId}`"
          >
            <span class="mo-storage-name">
              {{ book.name }}
              <span v-if="book.pinned" class="mo-tag soft">置顶</span>
            </span>
            <span class="muted">文字 {{ formatBytes(book.textBytes) }} · {{ book.textCount }} 章</span>
            <span class="muted">媒体 {{ formatBytes(book.mediaBytes) }} · {{ book.mediaCount }} 章</span>
            <template v-if="storageClearBook === book.bookId">
              <button
                class="mo-btn danger"
                :disabled="storageClearing === book.bookId"
                :data-testid="`clear-book-confirm-${book.bookId}`"
                @click="clearStorageForBook(book.bookId)"
              >
                {{ storageClearing === book.bookId ? '清理中…' : '确认清理' }}
              </button>
              <button class="mo-btn" :disabled="storageClearing === book.bookId" @click="storageClearBook = ''">取消</button>
            </template>
            <button
              v-else
              class="mo-btn"
              :data-testid="`clear-book-${book.bookId}`"
              @click="storageClearBook = book.bookId"
            >
              清理
            </button>
          </div>
        </div>

        <div class="mo-card" data-testid="storage-clear-all">
          <div class="mo-card-head">
            <h3 class="mo-card-title">全部缓存</h3>
            <span class="muted">文字与媒体一起清空，书架不受影响</span>
          </div>
          <div v-if="storageClearAllCachesOpen" class="mo-row">
            <span class="muted">会删掉全部文字与媒体缓存，包括没有索引的旧文件，确认吗？</span>
            <button
              class="mo-btn danger"
              :disabled="storageClearAllCachesBusy"
              data-testid="clear-all-caches-confirm"
              @click="clearAllCachesStorage"
            >
              {{ storageClearAllCachesBusy ? '清理中…' : '确认清空' }}
            </button>
            <button class="mo-btn" :disabled="storageClearAllCachesBusy" @click="storageClearAllCachesOpen = false">取消</button>
          </div>
          <button v-else class="mo-btn danger" data-testid="clear-all-caches" @click="storageClearAllCachesOpen = true">清空全部</button>
        </div>

        <div class="mo-card" data-testid="storage-clear-media">
          <div class="mo-card-head">
            <h3 class="mo-card-title">清空媒体</h3>
            <span class="muted">文字缓存与书架不受影响</span>
          </div>
          <div v-if="storageClearAllOpen" class="mo-row">
            <span class="muted">会删掉全部媒体文件与索引，确认吗？</span>
            <button
              class="mo-btn danger"
              :disabled="storageClearAllBusy"
              data-testid="clear-all-media-confirm"
              @click="clearAllMediaStorage"
            >
              {{ storageClearAllBusy ? '清理中…' : '确认清空' }}
            </button>
            <button class="mo-btn" :disabled="storageClearAllBusy" @click="storageClearAllOpen = false">取消</button>
          </div>
          <button v-else class="mo-btn danger" data-testid="clear-all-media" @click="storageClearAllOpen = true">清空媒体</button>
        </div>
      </section>
      <section v-if="view === 'reader'" class="mo-reader">
        <p
          v-if="readerMediaNotice"
          class="mo-media-notice"
          data-testid="media-fallback-notice"
          role="status"
        >
          <span>{{ readerMediaNotice }}</span>
          <button
            v-if="readerMediaRetryAvailable"
            class="mo-media-retry"
            data-testid="media-retry-current"
            :disabled="readerMediaRetryBusy"
            @click="retryReaderMedia"
          >
            {{ readerMediaRetryBusy ? '重下中…' : '重下本章' }}
          </button>
        </p>
        <div class="mo-reader-canvas" data-testid="reader-content">
          <CanvasReader
            v-if="readerKind === 'text' && content"
            ref="readerRef"
            :text="replacedContent"
            :title="readerTitle"
            :book-name="currentBook?.name || ''"
            :font-size="settings.fontSize"
            :font-family="activeFontFamily"
            :line-height="settings.lineSpacing"
            :paragraph-spacing="settings.paragraphSpacing"
            :letter-spacing="settings.letterSpacing"
            :bold="settings.bold"
            :title-mode="settings.titleMode"
            :title-size="settings.titleSize"
            :align="settings.align"
            :compress-punctuation="settings.compressPunctuation"
            :kinsoku="settings.kinsoku"
            :dual-column="settings.dualColumn"
            :ink-mode="settings.inkMode"
            :indent="settings.indent"
            :padding="settings.padding"
            :initial-page="initialPage"
            :highlight="readerHighlight"
            :underlines="underlineQuotes"
            :theme="theme"
            :theme-colors="activeThemeColors"
            :animation="settings.pageAnimation"
            :keys-enabled="!settingsOpen && !tocOpen && !bookmarksOpen && !notesOpen && !readerSearchOpen && !dictPanelOpen && !underlineOpen"
            :header-mode="settings.headerMode"
            :footer-mode="settings.footerMode"
            :show-header-line="settings.showHeaderLine"
            :show-footer-line="settings.showFooterLine"
            :tap-zones="settings.tapZones"
            :book-percent="bookPercent"
            :battery-percent="batteryPercent"
            @page="onPage"
            @tap-action="onTapAction"
            @select="onReaderSelect"
            @chapter-boundary="onChapterBoundary"
            @turn-state="onReaderTurnState"
          />
          <PdfReader
            v-else-if="readerKind === 'pdf' && pdfOriginalUrl && !pdfError"
            :src="pdfOriginalUrl"
            :title="currentBook?.name || '原版 PDF'"
            :initial-page="pdfInitialPage"
            :initial-zoom="pdfInitialZoom"
            :initial-fit-width="pdfInitialFitWidth"
            @page="onPdfPage"
            @switch-text="switchToTextFromPdf"
            @close="closePdfReader"
          />
          <div v-else-if="readerKind === 'pdf'" class="mo-pdf-unavailable" data-testid="pdf-error">
            <p>{{ pdfError || '原版 PDF 不可用' }}</p>
            <div class="mo-row">
              <button class="mo-btn primary" data-testid="pdf-error-text" @click="switchToTextFromPdf">切到文本模式</button>
              <button class="mo-btn" data-testid="pdf-error-back" @click="closePdfReader">返回详情</button>
            </div>
          </div>
          <ComicReader
            v-else-if="readerKind === 'images'"
            :images="readerImages"
            :title="readerTitle"
            :initial-page="initialPage"
            :local="readerLocal"
            @page="onPage"
            @media-error="onReaderMediaError"
          />
          <AudioReader
            v-else-if="readerKind === 'audio'"
            :src="readerMedia"
            :title="readerTitle"
            :book-name="currentBook?.name || ''"
            :initial-position="initialPage"
            :local="readerLocal"
            @progress="onMediaProgress"
            @ended="openAdjacent(1)"
            @media-error="onReaderMediaError"
          />
          <VideoReader
            v-else-if="readerKind === 'video'"
            :src="readerMedia"
            :title="readerTitle"
            :book-name="currentBook?.name || ''"
            :initial-position="initialPage"
            :local="readerLocal"
            @progress="onMediaProgress"
            @ended="openAdjacent(1)"
            @media-error="onReaderMediaError"
          />
          <p v-else class="muted mo-reader-loading">{{ chapterError || (busy ? '加载中…' : '（空章节）') }}</p>
        </div>

        <p v-if="boundaryLoading" class="mo-reader-hint" data-testid="chapter-boundary-loading">
          {{ boundaryDirection > 0 ? '正在加载下一章…' : '正在加载上一章…' }}
        </p>

        <p v-if="speechStatus === 'idle' && speechBlockedReason" class="mo-reader-hint" data-testid="speech-blocked">
          {{ speechBlockedReason }}
        </p>

        <div
          v-if="speechStatus !== 'idle'"
          class="mo-auto-page"
          data-testid="speech-bar"
          :style="autoPageStatus !== 'idle' ? 'bottom: 64px' : ''"
        >
          <span class="mo-auto-page-label">朗读 · 第 {{ speechSegmentIndex + 1 }}/{{ speechSegmentTotal }} 段</span>
          <span class="mo-auto-page-notice">{{ speechNotice || speechChapterTitle }}</span>
          <button class="mo-btn tiny" data-testid="speech-prev" @click="moveSpeechSegment(-1)">上一段</button>
          <button class="mo-btn tiny" data-testid="speech-play" @click="toggleSpeechPlay">{{ speechStatus === 'speaking' ? '暂停' : '继续' }}</button>
          <button class="mo-btn tiny" data-testid="speech-next" @click="moveSpeechSegment(1)">下一段</button>
          <button class="mo-btn tiny" data-testid="speech-stop" @click="stopSpeech()">关闭</button>
        </div>

        <div v-if="autoPageStatus !== 'idle'" class="mo-auto-page" data-testid="auto-page-bar">
          <span class="mo-auto-page-label">{{ autoPageLabel }}</span>
          <span v-if="autoPageNotice" class="mo-auto-page-notice">{{ autoPageNotice }}</span>
          <button v-if="autoPageStatus === 'running'" class="mo-btn tiny" data-testid="auto-page-pause" @click="pauseAutoPage">暂停</button>
          <button v-else class="mo-btn tiny" data-testid="auto-page-resume" @click="resumeAutoPage">继续</button>
          <button class="mo-btn tiny" data-testid="auto-page-stop" @click="stopAutoPage">停止</button>
        </div>

        <transition name="mo-fade">
          <div v-if="chrome" class="mo-chrome">
            <div class="mo-chrome-top">
              <button class="mo-icon-btn" data-testid="reader-back" @click="view = 'detail'">‹</button>
              <div class="mo-chrome-title">
                <strong>{{ currentBook?.name }}</strong>
                <span>{{ readerTitle }}</span>
              </div>
              <button class="mo-icon-btn" :title="bookmarkedHere ? '删除书签' : '加书签'" data-testid="reader-bookmark" @click="toggleBookmark">{{ bookmarkedHere ? '★' : '☆' }}</button>
              <button class="mo-icon-btn" title="书签列表" data-testid="reader-bookmarks" @click="bookmarksOpen = true">🔖</button>
              <button v-if="readerKind === 'text'" class="mo-icon-btn" title="笔记与划线" data-testid="reader-notes" @click="notesOpen = true">✎</button>
              <button v-if="readerKind === 'text'" class="mo-icon-btn" title="段评" data-testid="reader-review" @click="openReview">💬</button>
              <button v-if="readerKind === 'text'" class="mo-icon-btn" title="书内搜索" aria-label="书内搜索" data-testid="reader-search" @click="openReaderSearch">🔍</button>
              <button class="mo-icon-btn" title="目录" data-testid="reader-toc" @click="tocOpen = true">☰</button>
              <button
                v-if="isPdfBook && isPdfReadable"
                class="mo-chrome-btn"
                data-testid="reader-pdf-toggle"
                @click="togglePdfMode"
              >
                {{ readerKind === 'pdf' ? '文本' : '原版' }}
              </button>
            </div>
            <div class="mo-chrome-bottom">
              <button v-if="settings.menuItems.includes('prev')" class="mo-chrome-btn" :disabled="chapterIndex <= 0" @click="openAdjacent(-1)">上一章</button>
              <button v-if="settings.menuItems.includes('settings') && readerKind === 'text'" class="mo-chrome-btn" data-testid="reader-settings" @click="openSettings($event)">Aa</button>
              <button
                v-if="readerKind === 'text'"
                class="mo-chrome-btn"
                data-testid="reader-speak"
                :disabled="speechStatus === 'idle' && speechBlockedReason !== ''"
                :title="speechBlockedReason || '朗读'"
                @click="toggleSpeechPlay"
              >{{ speechStatus === 'idle' ? '朗读' : speechStatus === 'speaking' ? '暂停' : '继续' }}</button>
              <button v-if="settings.menuItems.includes('toc')" class="mo-chrome-btn" @click="tocOpen = true">目录</button>
              <button
                v-if="currentBook && currentBook.origin !== 'local'"
                class="mo-chrome-btn"
                data-testid="reader-switch"
                @click="openSwitchPanel"
              >
                换源
              </button>
              <button v-if="settings.menuItems.includes('next')" class="mo-chrome-btn" :disabled="chapterIndex >= chapters.length - 1" @click="openAdjacent(1)">下一章</button>
            </div>
          </div>
        </transition>

        <div v-if="readerHint" class="mo-reader-hint" data-testid="reader-hint">{{ readerHint }}</div>

        <transition name="mo-fade">
          <div v-if="dictPanelOpen" class="mo-sheet-mask" data-testid="reader-dict-mask" @click.self="closeReaderDict">
            <div class="mo-sheet mo-sheet-scroll mo-reader-dict" data-testid="reader-dict-panel" @pointerdown.stop @click.stop>
              <div class="mo-sheet-head">
                <strong>查字典</strong>
                <span v-if="dictPanelFallback" class="muted">未定位到词，已取整行</span>
                <button class="mo-icon-btn" data-testid="reader-dict-close" title="关闭" @click="closeReaderDict">✕</button>
              </div>
              <p v-if="dictPanelLine" class="muted mo-dict-line">「{{ dictPanelLine }}」</p>
              <div class="mo-row">
                <input
                  v-model="dictPanelText"
                  placeholder="要查的词"
                  data-testid="reader-dict-query"
                  @keyup.enter="runReaderLookup"
                />
                <button
                  class="mo-btn primary"
                  :disabled="dictPanelBusy || !dictPanelText.trim()"
                  data-testid="reader-dict-lookup"
                  @click="runReaderLookup"
                >
                  {{ dictPanelBusy ? '查询中…' : '查询' }}
                </button>
              </div>
              <p v-if="dictPanelError" class="muted" data-testid="reader-dict-error">{{ dictPanelError }}</p>
              <div v-if="dictEnabledCount === 0" class="mo-empty small" data-testid="reader-dict-empty">
                <p>还没有启用的字典</p>
                <p class="muted">添加并启用字典后，长按选词会同时查询所有字典。</p>
                <button class="mo-btn tiny primary" data-testid="reader-dict-manage" @click="openDictManage">去添加字典</button>
              </div>
              <template v-else-if="dictPanelResults.length">
                <div class="mo-dict-tabs" role="tablist">
                  <button
                    v-for="item in dictPanelResults"
                    :key="item.id"
                    :class="{ on: item.id === dictPanelActiveResult?.id }"
                    role="tab"
                    data-testid="reader-dict-tab"
                    @click="dictPanelActive = item.id"
                  >
                    {{ item.name }}<span v-if="!item.ok" class="mo-dict-fail">失败</span>
                  </button>
                </div>
                <div v-if="dictPanelActiveResult" class="mo-dict-result" data-testid="reader-dict-result">
                  <template v-if="dictPanelActiveResult.ok">
                    <pre class="mo-dict-text" data-testid="reader-dict-result-text">{{ dictPanelActiveResult.text || '（没有提取到释义）' }}</pre>
                    <div class="mo-row">
                      <button class="mo-btn tiny" data-testid="reader-dict-copy" @click="copyReaderDict(dictPanelActiveResult)">复制</button>
                      <button class="mo-btn tiny" :disabled="!dictPanelActiveResult.url" data-testid="reader-dict-open" @click="openDictResult(dictPanelActiveResult)">打开原页</button>
                      <span class="mo-url">{{ dictPanelActiveResult.url }}</span>
                    </div>
                  </template>
                  <p v-else class="muted">查询失败：{{ dictPanelActiveResult.error }}</p>
                </div>
              </template>
              <p v-else-if="!dictPanelBusy && !dictPanelError" class="muted">输入词后查询。</p>
              <p v-if="dictPanelCopied" class="muted" data-testid="reader-dict-copied">{{ dictPanelCopied }}</p>
            </div>
          </div>
        </transition>

        <transition name="mo-fade">
          <div v-if="readerSearchOpen" class="mo-sheet-mask" data-testid="reader-search-mask" @click.self="closeReaderSearch">
            <div class="mo-sheet mo-sheet-scroll mo-reader-search" data-testid="reader-search-panel" @pointerdown.stop @click.stop>
              <div class="mo-sheet-head">
                <strong>书内搜索</strong>
                <span class="muted">逐章查找正文</span>
                <button class="mo-icon-btn" data-testid="reader-search-close" title="关闭" @click="closeReaderSearch">✕</button>
              </div>
              <div class="mo-row">
                <input
                  v-model="readerSearchKey"
                  placeholder="输入关键词"
                  data-testid="reader-search-input"
                  @keyup.enter="startReaderSearch"
                />
                <button
                  class="mo-btn primary"
                  :disabled="readerSearchBusy || !readerSearchKey.trim()"
                  data-testid="reader-search-run"
                  @click="startReaderSearch"
                >
                  搜索
                </button>
                <button v-if="readerSearchBusy" class="mo-btn tiny" data-testid="reader-search-stop" @click="stopReaderSearch">停止</button>
                <button
                  v-else-if="readerSearchCanContinue"
                  class="mo-btn tiny"
                  data-testid="reader-search-continue"
                  @click="continueReaderSearch"
                >
                  继续搜索
                </button>
              </div>
              <p v-if="readerSearchStarted" class="muted mo-search-hint" data-testid="reader-search-progress">
                已搜 {{ readerSearchScanned }}/{{ readerSearchTotal }} · 命中 {{ readerSearchResults.length }}
              </p>
              <p v-if="readerSearchHint" class="muted mo-search-hint" data-testid="reader-search-hint">{{ readerSearchHint }}</p>
              <ul v-if="readerSearchResults.length" class="mo-search-list" data-testid="reader-search-results">
                <li v-for="item in readerSearchResults" :key="item.chapterIndex">
                  <button class="mo-search-item" data-testid="reader-search-result" @click="jumpToSearchResult(item)">
                    <span class="mo-search-title">{{ item.chapterTitle }}</span>
                    <span class="mo-search-count">{{ item.count }} 处</span>
                    <span class="mo-search-snippet">{{ item.snippet }}</span>
                  </button>
                </li>
              </ul>
              <details v-if="readerSearchErrors.length" class="mo-search-errors" data-testid="reader-search-errors">
                <summary>失败 {{ readerSearchErrors.length }} 章</summary>
                <p v-for="error in readerSearchErrors" :key="error.chapterIndex" class="muted">
                  {{ error.chapterTitle || `第 ${error.chapterIndex + 1} 章` }}：{{ error.message }}
                </p>
              </details>
              <div v-if="readerSearchEmpty" class="mo-empty small" data-testid="reader-search-empty">
                <p>{{ readerSearchDone ? '没有找到相关章节' : '暂未找到相关章节' }}</p>
                <p class="muted">{{ readerSearchDone ? '换个关键词试试。' : '可继续搜索后面的章节。' }}</p>
              </div>
              <p v-else-if="!readerSearchStarted" class="muted">输入关键词，逐章查找正文。</p>
            </div>
          </div>
        </transition>

                <transition name="mo-fade">
          <div
            v-if="settingsOpen"
            class="mo-sheet-mask mo-settings-mask"
            data-testid="settings-mask"
            @click.self="closeSettings"
          >
            <div
              ref="settingsSheetRef"
              class="mo-sheet mo-sheet-scroll mo-settings-sheet"
              data-testid="settings-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="mo-settings-title"
              tabindex="-1"
              @pointerdown.stop
              @click.stop
              @keydown.esc="closeSettings"
              @keydown.tab="trapSettingsFocus"
            >
              <div class="mo-sheet-head">
                <strong id="mo-settings-title">阅读设置</strong>
                <button class="mo-icon-btn" data-testid="settings-close" title="关闭" @click="closeSettings">✕</button>
              </div>
              
              <div class="mo-scope-row">
                <div class="mo-scope-tabs" role="tablist" aria-label="设置作用范围">
                  <button
                    class="mo-scope-tab"
                    :class="{ on: settingsScope === 'global' }"
                    role="tab"
                    :aria-selected="settingsScope === 'global'"
                    data-testid="settings-scope-global"
                    @click="switchSettingsScope('global')"
                  >全局</button>
                  <button
                    class="mo-scope-tab"
                    :class="{ on: settingsScope === 'book' }"
                    role="tab"
                    :aria-selected="settingsScope === 'book'"
                    :disabled="!canUseBookScope"
                    data-testid="settings-scope-book"
                    @click="switchSettingsScope('book')"
                  >本书</button>
                </div>
                <span v-if="settingsScope === 'book' && bookOverridden" class="mo-scope-badge" data-testid="settings-book-overridden">本书已自定义</span>
                <button
                  v-if="settingsScope === 'book' && bookOverridden"
                  class="mo-btn tiny"
                  data-testid="settings-restore-global"
                  @click="restoreGlobalSettings"
                >恢复全局</button>
              </div>
              <p v-if="settingsScope === 'book' && !bookOverridden" class="mo-settings-tip">本书跟随全局设置</p>
              <p v-else-if="!canUseBookScope" class="mo-settings-tip">打开一本书后可单独设置本书</p>
              
              <div v-if="settingsError" class="mo-settings-error" role="status" data-testid="settings-error">
                <span>{{ settingsError }}</span>
                <button class="mo-btn tiny" data-testid="settings-retry" @click="persistSettings">重试</button>
                <button class="mo-btn tiny" data-testid="settings-reload" @click="loadSettings">还原</button>
              </div>
              
              <div class="mo-theme-row">
                <span>预设</span>
                <button v-for="preset in READER_PRESETS" :key="preset.key" @click="applyPreset(preset)">{{ preset.name }}</button>
              </div>
              
              <details class="mo-settings-group" open>
                <summary>排版</summary>
                <div class="mo-group-bar">
                  <span class="muted">字号、行距与文字样式</span>
                  <button class="mo-btn tiny" data-testid="settings-reset-layout" @click="resetSettingsSection('layout')">恢复本节默认</button>
                </div>
                <label class="mo-slider">
                  <span>字号</span>
                  <input v-model.number="settings.fontSize" type="range" min="12" max="48" step="1" @input="schedulePersistSettings" />
                  <b>{{ settings.fontSize }}</b>
                </label>
                <div class="mo-theme-row">
                  <span>字体</span>
                  <select class="mo-select" data-testid="font-select" :value="settings.fontId" @change="selectFont">
                    <option value="">默认宋体</option>
                    <option v-for="font in customFonts" :key="font.id" :value="font.id">{{ font.name }}</option>
                  </select>
                  <label class="mo-font-upload" data-testid="font-upload">
                    上传
                    <input type="file" accept=".ttf,.otf,.woff,.woff2" @change="uploadFontFile" />
                  </label>
                </div>
                <div v-if="customFonts.length" class="mo-font-list" data-testid="font-list">
                  <div v-for="font in customFonts" :key="font.id" class="mo-font-item">
                    <span>{{ font.name }}</span>
                    <small>{{ (font.size / 1024 / 1024).toFixed(1) }} MB</small>
                    <button class="mo-icon-btn" data-testid="font-delete" title="删除字体" @click="deleteFont(font)">✕</button>
                  </div>
                </div>
                <p v-if="fontMessage" class="mo-font-status" data-testid="font-status">{{ fontMessage }}</p>
                <label class="mo-slider">
                  <span>行距</span>
                  <input v-model.number="settings.lineSpacing" type="range" min="1.2" max="2.6" step="0.1" @input="schedulePersistSettings" />
                  <b>{{ settings.lineSpacing.toFixed(1) }}</b>
                </label>
                <label class="mo-slider">
                  <span>段距</span>
                  <input v-model.number="settings.paragraphSpacing" type="range" min="0" max="24" step="1" @input="schedulePersistSettings" />
                  <b>{{ settings.paragraphSpacing }}</b>
                </label>
                <label class="mo-slider">
                  <span>字距</span>
                  <input v-model.number="settings.letterSpacing" type="range" min="0" max="4" step="0.5" @input="schedulePersistSettings" />
                  <b>{{ settings.letterSpacing.toFixed(1) }}</b>
                </label>
                <div class="mo-theme-row">
                  <span>缩进</span>
                  <button :class="{ on: settings.indent === 2 }" @click="settings.indent = 2; persistSettings()">两字</button>
                  <button :class="{ on: settings.indent === 0 }" @click="settings.indent = 0; persistSettings()">无</button>
                </div>
                <label class="mo-switch"><input v-model="settings.bold" type="checkbox" @change="persistSettings" />加粗正文</label>
                <div class="mo-theme-row">
                  <span>标题位置</span>
                  <button
                    v-for="mode in [{ value: 0, label: '靠左' }, { value: 1, label: '居中' }, { value: 2, label: '隐藏' }, { value: 3, label: '靠右' }]"
                    :key="mode.value"
                    :class="{ on: settings.titleMode === mode.value }"
                    @click="settings.titleMode = mode.value; persistSettings()"
                  >{{ mode.label }}</button>
                </div>
                <label class="mo-slider">
                  <span>标题字号</span>
                  <input v-model.number="settings.titleSize" type="range" min="0" max="8" step="1" @input="schedulePersistSettings" />
                  <b>+{{ settings.titleSize * 2 }}px</b>
                </label>
                <div class="mo-theme-row">
                  <span>对齐</span>
                  <button :class="{ on: settings.align === 'left' }" @click="settings.align = 'left'; persistSettings()">左齐</button>
                  <button :class="{ on: settings.align === 'justify' }" @click="settings.align = 'justify'; persistSettings()">两端</button>
                </div>
                <label class="mo-switch"><input v-model="settings.compressPunctuation" type="checkbox" @change="persistSettings" />标点压缩</label>
                <label class="mo-switch"><input v-model="settings.kinsoku" type="checkbox" @change="persistSettings" />避头尾</label>
              </details>
              
              <details class="mo-settings-group">
                <summary>页面</summary>
                <div class="mo-group-bar">
                  <span class="muted">主题、边距与页眉页脚</span>
                  <button class="mo-btn tiny" data-testid="settings-reset-page" @click="resetSettingsSection('page')">恢复本节默认</button>
                </div>
                <div class="mo-theme-row">
                  <span>主题</span>
                  <button v-for="item in [{ value: 'light', label: '纸白' }, { value: 'sepia', label: '米黄' }, { value: 'dark', label: '夜读' }]" :key="item.value" :class="{ on: settings.theme === item.value }" @click="selectTheme(item.value)">{{ item.label }}</button>
                </div>
                <div v-if="settings.customThemes.length" class="mo-theme-row mo-theme-wrap">
                  <span>自定义</span>
                  <button v-for="item in settings.customThemes" :key="item.id" data-testid="theme-custom" :class="{ on: settings.theme === item.id }" @click="selectTheme(item.id)">{{ item.name }}</button>
                </div>
                <div class="mo-theme-row">
                  <span>管理</span>
                  <button data-testid="theme-new" @click="startThemeCreate">新建</button>
                  <button v-if="activeCustomTheme" data-testid="theme-edit" @click="startThemeEdit">编辑</button>
                  <button v-if="activeCustomTheme" data-testid="theme-delete" @click="deleteActiveTheme">删除</button>
                </div>
                <div class="mo-theme-row">
                  <span>迁移</span>
                  <label class="mo-font-upload" data-testid="theme-import">
                    导入
                    <input type="file" accept=".json,application/json" @change="importThemeFile" />
                  </label>
                  <button data-testid="theme-export-legado" @click="exportThemes('legado')">兼容版</button>
                  <button data-testid="theme-export-full" @click="exportThemes('full')">全量版</button>
                </div>
                <p v-if="themeMessage" class="mo-font-status" data-testid="theme-status">{{ themeMessage }}</p>
                <div v-if="themeDraft" class="mo-theme-editor" data-testid="theme-editor">
                  <div class="mo-theme-editor-head">
                    <strong>{{ themeDraft.id ? '编辑主题' : '新建主题' }}</strong>
                    <button class="mo-icon-btn" data-testid="theme-cancel" title="取消" @click="themeDraft = null">✕</button>
                  </div>
                  <label class="mo-theme-field">
                    <span>名称</span>
                    <input v-model="themeDraft.name" class="mo-input" data-testid="theme-name" maxlength="32" placeholder="主题名称" />
                  </label>
                  <div class="mo-color-grid">
                    <label class="mo-color-field"><span>背景</span><input v-model="themeDraft.bg" type="color" data-testid="theme-bg" /></label>
                    <label class="mo-color-field"><span>正文</span><input v-model="themeDraft.text" type="color" data-testid="theme-text" /></label>
                    <label class="mo-color-field"><span>辅助</span><input v-model="themeDraft.muted" type="color" data-testid="theme-muted" /></label>
                    <label class="mo-color-field"><span>分隔</span><input v-model="themeDraft.line" type="color" data-testid="theme-line" /></label>
                  </div>
                  <div class="mo-theme-editor-actions">
                    <button class="mo-btn primary" data-testid="theme-save" @click="saveThemeDraft">保存</button>
                    <button class="mo-btn" @click="themeDraft = null">取消</button>
                  </div>
                </div>
                <label class="mo-slider">
                  <span>左距</span>
                  <input v-model.number="settings.padding.left" type="range" min="8" max="48" step="1" @input="schedulePersistSettings" />
                  <b>{{ settings.padding.left }}</b>
                </label>
                <label class="mo-slider">
                  <span>右距</span>
                  <input v-model.number="settings.padding.right" type="range" min="8" max="48" step="1" @input="schedulePersistSettings" />
                  <b>{{ settings.padding.right }}</b>
                </label>
                <label class="mo-slider">
                  <span>上距</span>
                  <input v-model.number="settings.padding.top" type="range" min="0" max="32" step="1" @input="schedulePersistSettings" />
                  <b>{{ settings.padding.top }}</b>
                </label>
                <label class="mo-slider">
                  <span>下距</span>
                  <input v-model.number="settings.padding.bottom" type="range" min="0" max="32" step="1" @input="schedulePersistSettings" />
                  <b>{{ settings.padding.bottom }}</b>
                </label>
                <div class="mo-theme-row">
                  <span>翻页</span>
                  <button v-for="item in [{ value: 'cover', label: '覆盖' }, { value: 'slide', label: '平移' }, { value: 'simulate', label: '仿真' }, { value: 'scroll', label: '滚动' }, { value: 'none', label: '无动画' }]" :key="item.value" :class="{ on: settings.pageAnimation === item.value }" @click="settings.pageAnimation = item.value as any; persistSettings()">{{ item.label }}</button>
                </div>
                <div class="mo-theme-row">
                  <span>页眉</span>
                  <select v-model.number="settings.headerMode" class="mo-select" @change="persistSettings">
                    <option v-for="mode in TIP_MODES" :key="mode.code" :value="mode.code">{{ mode.label }}</option>
                  </select>
                </div>
                <div class="mo-theme-row">
                  <span>页脚</span>
                  <select v-model.number="settings.footerMode" class="mo-select" @change="persistSettings">
                    <option v-for="mode in TIP_MODES" :key="mode.code" :value="mode.code">{{ mode.label }}</option>
                  </select>
                </div>
                <div class="mo-theme-row">
                  <span>分隔线</span>
                  <label class="mo-switch"><input v-model="settings.showHeaderLine" type="checkbox" @change="persistSettings" />页眉</label>
                  <label class="mo-switch"><input v-model="settings.showFooterLine" type="checkbox" @change="persistSettings" />页脚</label>
                </div>
                <label class="mo-switch"><input v-model="settings.dualColumn" type="checkbox" @change="persistSettings" />双栏</label>
                <label class="mo-switch"><input v-model="settings.inkMode" type="checkbox" @change="persistSettings" />墨水屏</label>
                <p class="muted" style="font-size: 12px; line-height: 1.6; margin: 4px 0 0">
                  双栏在屏幕可用宽度不足 480px 时自动改单栏，滚动翻页只支持单栏。墨水屏下自动关掉翻页动画，退出后恢复原来的选择。
                </p>
              </details>
              
              <details class="mo-settings-group">
                <summary>操作</summary>
                <div class="mo-group-bar">
                  <span class="muted">点击区域与底栏</span>
                  <button class="mo-btn tiny" data-testid="settings-reset-operate" @click="resetSettingsSection('operate')">恢复本节默认</button>
                </div>
                <div class="mo-zone-grid">
                  <div v-for="(zone, index) in settings.tapZones" :key="index" class="mo-zone-cell">
                    <span>{{ TAP_ZONE_NAMES[index] }}</span>
                    <select :value="zone" class="mo-select" @change="setTapZone(index, $event)">
                      <option v-for="action in tapActionChoices" :key="action.code" :value="action.code">{{ action.label }}</option>
                    </select>
                  </div>
                </div>
                <div class="mo-theme-row">
                  <span>底栏</span>
                  <label v-for="item in MENU_ITEMS" :key="item.key" class="mo-switch">
                    <input type="checkbox" :checked="settings.menuItems.includes(item.key)" @change="toggleMenuItem(item.key)" />{{ item.label }}
                  </label>
                </div>
                <label class="mo-slider">
                  <span>自动翻页</span>
                  <input v-model.number="settings.autoPageSeconds" type="range" min="1" max="60" step="1" @input="schedulePersistSettings" />
                  <b>{{ settings.autoPageSeconds }} 秒</b>
                </label>
                <div class="mo-theme-row">
                  <span>自动翻页</span>
                  <button class="mo-btn tiny" data-testid="auto-page-start" :disabled="view !== 'reader' || readerKind !== 'text'" @click="startAutoPage">
                    {{ autoPageStatus === 'idle' ? '开始' : autoPageStatus === 'running' ? '重新计时' : '继续' }}
                  </button>
                </div>
              </details>
              
              <details class="mo-settings-group">
                <summary>朗读</summary>
                <div class="mo-group-bar">
                  <span class="muted">音色与语速</span>
                  <button class="mo-btn tiny" data-testid="settings-reset-speak" @click="resetSettingsSection('speak')">恢复本节默认</button>
                </div>
                <label class="mo-theme-row">
                  <span>音色</span>
                  <select v-model="settings.ttsVoice" class="mo-select" @change="persistSettings">
                    <option value="">系统默认</option>
                    <option
                      v-for="voice in (chineseSpeechVoices.length ? chineseSpeechVoices : speechVoices)"
                      :key="voice.voiceURI"
                      :value="voice.voiceURI"
                    >{{ voice.name }}（{{ voice.lang }}）</option>
                  </select>
                </label>
                <p v-if="speechVoices.length === 0" class="muted">音色列表加载中…</p>
                <p v-else-if="speechBlockedReason" class="muted">{{ speechBlockedReason }}</p>
                <label class="mo-slider">
                  <span>语速</span>
                  <input v-model.number="settings.ttsRate" type="range" min="0.5" max="2" step="0.1" @input="schedulePersistSettings" />
                  <b>{{ settings.ttsRate.toFixed(1) }}×</b>
                </label>
                <label class="mo-switch"><input v-model="settings.ttsContinuous" type="checkbox" @change="persistSettings" />连续朗读</label>
              </details>
              
              <details class="mo-settings-group">
                <summary>替换</summary>
                <div class="mo-group-bar">
                  <span class="muted">按顺序作用于正文</span>
                  <button class="mo-btn tiny" data-testid="settings-reset-replace" @click="resetSettingsSection('replace')">恢复本节默认</button>
                </div>
                <div class="mo-theme-row">
                  <button class="mo-btn" data-testid="replace-add" @click="addReplaceRule">加规则</button>
                </div>
                <div v-for="rule in settings.replaceRules" :key="rule.id" class="mo-replace-rule">
                  <input v-model="rule.pattern" class="mo-input" placeholder="查找内容" @change="persistSettings" />
                  <input v-model="rule.replacement" class="mo-input" placeholder="替换为" @change="persistSettings" />
                  <label class="mo-switch"><input v-model="rule.regex" type="checkbox" @change="persistSettings" />正则</label>
                  <label class="mo-switch"><input v-model="rule.enabled" type="checkbox" @change="persistSettings" />启用</label>
                  <button class="mo-icon-btn" @click="removeReplaceRule(rule)">✕</button>
                </div>
              </details>
            </div>
          </div>
        </transition>

        <transition name="mo-fade">
          <div v-if="bookmarksOpen" class="mo-sheet-mask" @click.self="bookmarksOpen = false">
            <div class="mo-sheet mo-sheet-scroll">
              <div class="mo-sheet-head">
                <strong>书签</strong>
                <span class="muted">{{ bookmarks.length }} 个</span>
                <button class="mo-icon-btn" @click="bookmarksOpen = false">✕</button>
              </div>
              <p v-if="bookmarks.length === 0" class="muted">还没有书签。阅读时点右上角 ☆，或把九宫格某个区域设为「加书签」。</p>
              <ul v-else class="mo-bookmarks">
                <li v-for="item in bookmarks" :key="item.id">
                  <button class="mo-bookmark-jump" @click="jumpBookmark(item)">
                    {{ item.chapterTitle || `第 ${Number(item.chapterIndex) + 1} 章` }}
                    <span class="muted">· 第 {{ Number(item.page) + 1 }} 页</span>
                  </button>
                  <button class="mo-icon-btn" title="删除" @click="removeBookmark(item)">✕</button>
                </li>
              </ul>
            </div>
          </div>
        </transition>

        <transition name="mo-fade">
          <div v-if="notesOpen" class="mo-sheet-mask" @click.self="notesOpen = false">
            <div class="mo-sheet mo-sheet-scroll">
              <div class="mo-sheet-head">
                <strong>笔记</strong>
                <span class="muted">{{ chapterNotes.length }} 条</span>
                <button class="mo-icon-btn" @click="notesOpen = false">✕</button>
              </div>
              <div class="mo-note-form">
                <textarea v-model="noteDraft" placeholder="写点什么…"></textarea>
                <div class="mo-note-actions">
                  <button class="mo-btn" data-testid="note-save" :disabled="!noteDraft.trim()" @click="addNote">保存笔记</button>
                  <button class="mo-btn" data-testid="note-underline" @click="openUnderlines">划线本页</button>
                </div>
              </div>
              <p v-if="chapterNotes.length === 0" class="muted">本章还没有笔记或划线。</p>
              <ul v-else class="mo-bookmarks">
                <li v-for="item in chapterNotes" :key="item.id">
                  <button class="mo-bookmark-jump" @click="jumpNote(item)">
                    <template v-if="item.type === 'underline'">划线：{{ item.quote }}</template>
                    <template v-else>{{ item.quote || '笔记' }}<span class="muted"> · {{ item.content }}</span></template>
                    <span class="muted"> · 第 {{ Number(item.page) + 1 }} 页</span>
                  </button>
                  <button class="mo-icon-btn" title="删除" @click="removeNote(item)">✕</button>
                </li>
              </ul>
            </div>
          </div>
        </transition>

        <transition name="mo-fade">
          <div v-if="underlineOpen" class="mo-sheet-mask" @click.self="underlineOpen = false">
            <div class="mo-sheet mo-sheet-scroll">
              <div class="mo-sheet-head">
                <strong>划线本页</strong>
                <span class="muted">已选 {{ selectedUnderlines.length }} 行</span>
                <button class="mo-icon-btn" @click="underlineOpen = false">✕</button>
              </div>
              <p v-if="underlineLines.length === 0" class="muted">当前页没有可划线的文字。</p>
              <ul v-else class="mo-underline-lines">
                <li v-for="(line, index) in underlineLines" :key="index">
                  <label class="mo-switch"><input v-model="selectedUnderlines" type="checkbox" :value="line" />{{ line }}</label>
                </li>
              </ul>
              <button class="mo-btn" :disabled="selectedUnderlines.length === 0" @click="saveUnderlines">保存划线</button>
            </div>
          </div>
        </transition>

        <transition name="mo-fade">
          <div v-if="reviewOpen" class="mo-sheet-mask" @click.self="reviewOpen = false">
            <div class="mo-sheet mo-sheet-scroll">
              <div class="mo-sheet-head">
                <strong>段评</strong>
                <span class="muted">{{ reviewRows.length }} 段</span>
                <button class="mo-icon-btn" @click="reviewOpen = false">✕</button>
              </div>
              <p v-if="reviewBusy" class="muted">加载中…</p>
              <p v-else-if="reviewMessage" class="muted">{{ reviewMessage }}</p>
              <ul v-else class="mo-bookmarks">
                <li v-for="row in reviewRows" :key="row.index">
                  <span class="mo-tag soft">第 {{ row.index }} 段 · {{ row.count }} 条</span>
                  <span class="muted"> {{ row.data }}</span>
                </li>
              </ul>
            </div>
          </div>
        </transition>

        <transition name="mo-fade">
          <aside v-if="tocOpen" class="mo-drawer" data-testid="reader-toc-drawer">
            <div class="mo-sheet-head">
              <strong>目录</strong>
              <span class="muted">{{ chapters.length }} 章</span>
              <button class="mo-btn" data-testid="toc-current" @click="scrollToCurrentChapter">当前章</button>
              <button class="mo-icon-btn" @click="tocOpen = false">✕</button>
            </div>
            <input v-model="tocFilter" class="mo-filter" placeholder="搜索章节" />
            <ol class="mo-drawer-list">
              <li v-for="chapter in filteredChapters" :key="chapter.url || chapter.title" :class="{ volume: chapter.isVolume, on: chapter === currentChapter }">
                <button v-if="!chapter.isVolume" @click="openChapter(chapter)">{{ chapter.title }}</button>
                <span v-else>{{ chapter.title }}</span>
              </li>
            </ol>
            <button v-if="tocHasMore" class="mo-btn" @click="tocPage += 1">加载更多（{{ filteredChapters.length }}/{{ tocTotal }}）</button>
          </aside>
        </transition>
      </section>
        <transition name="mo-fade">
          <div v-if="simulateOpen" class="mo-sheet-mask" @click.self="simulateOpen = false">
            <div class="mo-sheet mo-sheet-scroll">
              <div class="mo-sheet-head">
                <strong>模拟阅读</strong>
                <button class="mo-icon-btn" @click="simulateOpen = false">✕</button>
              </div>
              <label class="mo-switch"><input v-model="simulateDraft.enabled" type="checkbox" />启用模拟阅读（按日期解锁章节）</label>
              <div class="mo-form-row"><span>起始日期</span><input v-model="simulateDraft.startDate" type="date" /></div>
              <div class="mo-form-row"><span>起始章节（0 起）</span><input v-model.number="simulateDraft.startChapter" type="number" min="0" /></div>
              <div class="mo-form-row"><span>每日章节数</span><input v-model.number="simulateDraft.dailyChapters" type="number" min="1" /></div>
              <button class="mo-btn primary" data-testid="simulate-save" @click="saveSimulate">保存</button>
            </div>
          </div>
        </transition>

        <transition name="mo-fade">
          <div v-if="switchOpen" class="mo-sheet-mask" data-testid="switch-mask" @click.self="closeSwitchPanel">
            <div class="mo-sheet mo-sheet-scroll" data-testid="switch-panel">
              <div class="mo-sheet-head">
                <strong>换源</strong>
                <span class="muted">
                  {{ switchLoading ? '搜索中…' : switchCandidates.length + ' 个候选' }}
                </span>
                <button class="mo-icon-btn" title="关闭" @click="closeSwitchPanel">✕</button>
              </div>

              <p v-if="switchLoading" class="muted">正在搜索其他书源…</p>
              <div v-else class="mo-switch-body">
                <div class="mo-switch-list">
                  <p v-if="switchCandidates.length === 0" class="muted">没有找到候选</p>
                  <button
                    v-for="candidate in switchCandidates"
                    :key="switchCandidateKey(candidate)"
                    class="mo-switch-row"
                    :class="{ on: switchCandidateKey(candidate) === switchPreviewKey }"
                    data-testid="switch-candidate"
                    @click="previewCandidate(candidate)"
                  >
                    <span class="mo-switch-title">{{ candidate.name }}</span>
                    <span class="muted">{{ candidate.author || '未知作者' }} · {{ candidate.sourceName }}</span>
                    <span v-if="candidate.latestChapter" class="muted">最新：{{ candidate.latestChapter }}</span>
                    <span class="mo-switch-tags">
                      <span v-if="candidate.sameAuthor" class="mo-tag soft">同作者</span>
                      <span v-if="candidate.possiblyNotSameBook" class="mo-tag soft">可能不是同一本</span>
                      <span v-if="candidate.chapterCount" class="mo-tag soft">{{ candidate.chapterCount }} 章</span>
                    </span>
                  </button>
                </div>

                <div class="mo-switch-preview">
                  <p v-if="switchPreviewBusy" class="muted">加载预览…</p>
                  <p v-else-if="!switchPreview" class="muted">点候选预览目标目录</p>
                  <template v-if="switchPreview">
                    <h3>{{ switchPreview.book.name }}</h3>
                    <p class="muted">
                      {{ switchPreview.book.author || '未知作者' }} · {{ switchPreview.book.sourceName }}
                    </p>
                    <p class="muted">
                      {{ switchPreview.chapterCount }} 章 · 最新：{{ switchPreview.latestChapter || '未知' }}
                    </p>
                    <p v-if="switchPreview.book.intro" class="mo-switch-intro">{{ switchPreview.book.intro }}</p>
                    <p class="muted">目录预览</p>
                    <ol class="mo-switch-toc">
                      <li v-for="chapter in switchPreview.chapters" :key="chapter.url || chapter.title">
                        {{ chapter.title }}
                      </li>
                    </ol>
                  </template>
                </div>
              </div>

              <p v-if="switchError" class="muted" data-testid="switch-error">{{ switchError }}</p>
              <p v-if="switchErrors.length" class="muted">部分书源失败：{{ switchErrorText }}</p>

              <div class="mo-row">
                <button class="mo-btn" @click="closeSwitchPanel">取消</button>
                <button
                  class="mo-btn primary"
                  data-testid="switch-confirm"
                  :disabled="switchBusy || !switchPreview"
                  @click="confirmSwitch"
                >
                  {{ switchBusy ? '切换中…' : '确认换源' }}
                </button>
              </div>
            </div>
          </div>
        </transition>

    </main>
  </div>
</template>

<style>
.mo {
  --mo-paper: #f8f5ee;
  --mo-paper-2: #fffdf7;
  --mo-ink: #26231d;
  --mo-ink-2: #6f6759;
  --mo-ink-3: #9a927f;
  --mo-line: #e7e0d1;
  --mo-accent: #3d6b53;
  --mo-accent-soft: #e9efe9;
  display: flex;
  flex-direction: column;
  position: relative;
  height: 100%;
  min-height: 480px;
  color: var(--mo-ink);
  background: var(--mo-paper);
  font: 14px/1.65 -apple-system, 'Noto Sans SC', 'PingFang SC', sans-serif;
}
.mo-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 22px 10px;
}
.mo-brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.mo-brand-cn {
  font: 700 22px/1 'Songti SC', 'Noto Serif SC', serif;
  letter-spacing: 0.18em;
}
.mo-brand-en {
  font: 500 9px/1 -apple-system, sans-serif;
  letter-spacing: 0.32em;
  color: var(--mo-ink-3);
}
.mo-status {
  flex: 1;
  color: var(--mo-ink-3);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
.mo-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--mo-ink-2);
  font-size: 16px;
  cursor: pointer;
}
.mo-icon-btn:hover {
  background: rgba(0, 0, 0, 0.05);
}
.mo-icon-btn.danger {
  color: #a8402e;
}
.mo-nav {
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 0 22px;
  border-bottom: 1px solid var(--mo-line);
}
.mo-nav button {
  position: relative;
  border: 0;
  background: none;
  padding: 9px 0 11px;
  color: var(--mo-ink-2);
  font-size: 14px;
  cursor: pointer;
}
.mo-nav button.on {
  color: var(--mo-ink);
  font-weight: 600;
}
.mo-nav button.on::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background: var(--mo-accent);
}
.mo-version {
  margin-left: auto;
  font-size: 11px;
  color: var(--mo-ink-3);
}
.mo-body {
  flex: 1;
  overflow: auto;
}
.mo-body-reader {
  overflow: hidden;
}
.mo-pane {
  padding: 20px 22px 40px;
  max-width: 960px;
}
.mo-section-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 4px 0 16px;
}
.mo-section-head h2 {
  margin: 0;
  font: 700 26px/1.2 'Songti SC', 'Noto Serif SC', serif;
  letter-spacing: 0.06em;
}
.mo-section-head h3 {
  margin: 0;
  font: 700 19px/1.2 'Songti SC', 'Noto Serif SC', serif;
}
.mo-section-head .muted {
  margin-left: auto;
}
.muted {
  color: var(--mo-ink-2);
  font-size: 12px;
}
.mo-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 56px 0 40px;
  text-align: center;
}
.mo-empty.small {
  padding: 20px 0;
}
.mo-empty-glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border: 1px solid var(--mo-line);
  border-radius: 50%;
  color: var(--mo-ink-3);
  font: 28px/1 'Songti SC', serif;
}
.mo-empty-title {
  margin: 6px 0 0;
  font: 600 17px/1.3 'Songti SC', 'Noto Serif SC', serif;
}
.mo-empty .mo-btn {
  margin-top: 10px;
}
.mo-shelf {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 22px 18px;
}
.mo-shelf-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.mo-shelf-transfer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  margin: 10px 0 2px;
  border: 1px solid var(--mo-line);
  border-radius: 10px;
  background: var(--mo-paper-2);
  font-size: 12px;
}
.mo-shelf-message {
  min-width: 0;
  overflow-wrap: anywhere;
}
.mo-cover-card.selected .mo-cover {
  outline: 2px solid var(--mo-accent);
  outline-offset: 2px;
}
.mo-cover-check {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid rgba(255, 255, 255, 0.75);
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.28);
  color: #fff;
  font-size: 13px;
  line-height: 1;
}
.mo-cover-check.on {
  border-color: var(--mo-accent);
  background: var(--mo-accent);
}
.mo-btn.danger {
  border-color: #a8402e;
  color: #a8402e;
}
.mo-btn.danger:hover {
  background: #a8402e;
  color: #fff;
}
.mo-cover-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  cursor: pointer;
  color: inherit;
}
.mo-cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 3 / 4;
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 6px 18px rgba(60, 50, 30, 0.16);
  transition: transform 0.18s ease;
}
.mo-cover-card:hover .mo-cover {
  transform: translateY(-3px);
}
.mo-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.mo-cover-glyph {
  color: rgba(255, 251, 240, 0.9);
  font: 700 40px/1 'Songti SC', serif;
}
.mo-cover-origin {
  position: absolute;
  left: 6px;
  bottom: 6px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.35);
  color: rgba(255, 255, 255, 0.88);
  font-size: 9px;
  letter-spacing: 0.04em;
}
.mo-cover-badge {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 5px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 9px;
  letter-spacing: 0.04em;
}
.mo-cover-name {
  margin-top: 2px;
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mo-cover-meta {
  font-size: 11px;
  color: var(--mo-ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mo-cover-progress {
  display: block;
  height: 2px;
  border-radius: 1px;
  background: var(--mo-line);
  overflow: hidden;
}
.mo-cover-progress i {
  display: block;
  height: 100%;
  background: var(--mo-accent);
}
.mo-cover-status {
  font-size: 10px;
  color: var(--mo-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mo-searchbar {
  display: flex;
  gap: 10px;
  margin-bottom: 18px;
}
.mo-searchbar input {
  flex: 1;
  padding: 11px 14px;
  border: 1px solid var(--mo-line);
  border-radius: 8px;
  background: var(--mo-paper-2);
  color: inherit;
  font: inherit;
}
.mo-search-scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin: -6px 0 12px;
  color: var(--mo-ink-2);
  font-size: 12px;
}
.mo-history {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0 0 16px;
  font-size: 12px;
}
.mo-chip {
  padding: 4px 10px;
  border: 1px solid var(--mo-line);
  border-radius: 999px;
  background: var(--mo-paper-2);
  color: var(--mo-ink-2);
  font: inherit;
  cursor: pointer;
}
.mo-chip:hover {
  border-color: var(--mo-accent);
  color: var(--mo-accent);
}
.mo-results {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--mo-line);
}
.mo-result {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 4px;
  border: 0;
  border-bottom: 1px solid var(--mo-line);
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.mo-result:hover {
  background: rgba(61, 107, 83, 0.04);
}
.mo-result-cover {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 56px;
  flex-shrink: 0;
  border-radius: 3px;
  overflow: hidden;
  color: rgba(255, 251, 240, 0.9);
  font: 600 18px/1 'Songti SC', serif;
}
.mo-result-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.mo-result-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.mo-result-name {
  font-weight: 600;
  font-size: 15px;
}
.mo-result-arrow {
  margin-left: auto;
  color: var(--mo-ink-3);
  font-size: 20px;
}
.mo-errors {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px dashed var(--mo-line);
}
.mo-explore-section {
  padding-top: 14px;
}
.mo-explore-section:first-child {
  padding-top: 0;
}
.mo-explore-section-title {
  margin: 0;
  font: 600 13px/1.4 -apple-system, 'Noto Sans SC', 'PingFang SC', sans-serif;
  color: var(--mo-ink-3);
  letter-spacing: 0.04em;
}
.mo-explore-group {
  padding: 12px 0;
  border-bottom: 1px solid var(--mo-line);
}
.mo-explore-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.mo-explore-head h3 {
  margin: 0;
  font: 600 16px/1.3 'Songti SC', 'Noto Serif SC', serif;
}
.mo-explore-head .muted {
  margin-left: auto;
}
.mo-explore-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.mo-chip.on {
  border-color: var(--mo-accent);
  background: var(--mo-accent-soft);
  color: var(--mo-accent);
}
.mo-explore-error {
  margin: 4px 0;
  color: #a33;
}
.mo-explore-result {
  margin-top: 22px;
}
.mo-explore-more {
  display: flex;
  justify-content: center;
  margin: 16px 0;
}
.mo-explore-note {
  margin: 10px 0;
  text-align: center;
}
.mo-back {
  border: 0;
  background: none;
  padding: 4px 0;
  color: var(--mo-ink-2);
  cursor: pointer;
  font-size: 13px;
}
.mo-hero {
  display: flex;
  gap: 22px;
  margin: 10px 0 20px;
}
.mo-hero-cover {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 118px;
  height: 158px;
  flex-shrink: 0;
  border-radius: 5px;
  overflow: hidden;
  color: rgba(255, 251, 240, 0.9);
  font: 700 40px/1 'Songti SC', serif;
  box-shadow: 0 10px 24px rgba(60, 50, 30, 0.2);
}
.mo-hero-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.mo-hero-main {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  min-width: 0;
}
.mo-hero-main h2 {
  margin: 0 0 4px;
  font: 700 27px/1.25 'Songti SC', 'Noto Serif SC', serif;
  letter-spacing: 0.03em;
}
.mo-hero-main p {
  margin: 0;
}
.mo-hero-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.mo-btn {
  padding: 8px 16px;
  border: 1px solid var(--mo-line);
  border-radius: 6px;
  background: var(--mo-paper-2);
  color: var(--mo-ink);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.mo-btn.primary {
  border-color: var(--mo-accent);
  background: var(--mo-accent);
  color: #f6f2e6;
}
.mo-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.mo-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--mo-accent-soft);
  color: var(--mo-accent);
  font-size: 11px;
}
.mo-tag.soft {
  background: transparent;
  border: 1px solid var(--mo-line);
  color: var(--mo-ink-2);
}
.mo-score {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--mo-accent-soft);
  color: var(--mo-accent);
  font-size: 12px;
}
.mo-group-input {
  width: 80px;
  padding: 5px 8px;
  border: 1px solid var(--mo-line);
  border-radius: 8px;
  background: transparent;
  color: var(--mo-ink);
  font-size: 12px;
}
.mo-local-pdf-hint {
  margin: 0 0 20px;
  padding: 10px 14px;
  border: 1px solid var(--mo-line);
  border-radius: 10px;
  background: var(--mo-accent-soft);
  line-height: 1.8;
}
.mo-intro {
  line-height: 1.9;
  letter-spacing: 0.01em;
  text-align: justify;
  max-width: 720px;
  margin: 0 0 24px;
  color: var(--mo-ink-2);
  white-space: pre-wrap;
  line-height: 1.8;
}
.mo-toc-block {
  border-top: 1px solid var(--mo-line);
  padding-top: 16px;
}
.mo-toc-filter,
.mo-filter {
  width: 180px;
  padding: 6px 10px;
  border: 1px solid var(--mo-line);
  border-radius: 6px;
  background: var(--mo-paper-2);
  color: inherit;
  font: inherit;
  font-size: 12px;
}
.mo-toc {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  columns: 2 260px;
  column-gap: 32px;
}
.mo-toc li {
  break-inside: avoid;
  padding: 2px 0;
  font-size: 13px;
  color: var(--mo-ink-2);
}
.mo-toc li.volume {
  margin-top: 10px;
  color: var(--mo-ink);
  font-weight: 600;
}
.mo-toc button {
  border: 0;
  background: none;
  padding: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.mo-toc button:hover {
  color: var(--mo-accent);
}
.mo-card {
  margin-bottom: 22px;
  padding: 16px 18px;
  border: 1px solid var(--mo-line);
  border-radius: 10px;
  background: var(--mo-paper-2);
}
.mo-card-title {
  margin: 0 0 10px;
  font: 600 16px/1.3 'Songti SC', 'Noto Serif SC', serif;
}
/* 存储页：分项与按书明细用网格对齐，窄屏自动折行。 */
.mo-storage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  margin: 8px 0 0;
}
.mo-storage-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mo-storage-item strong {
  font-size: 15px;
}
.mo-storage-book {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid var(--mo-line);
}
.mo-storage-name {
  flex: 1 1 160px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.mo-card-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.mo-card-head .mo-card-title {
  margin: 0;
}
.mo-card-head .mo-filter {
  margin-left: auto;
}
.mo-source-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
.mo-source-tools .mo-filter {
  flex: 1 1 220px;
  width: auto;
}
.mo-select {
  width: auto;
  font-size: 12px;
}
.mo-source-bulk {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin: 2px 0 10px;
  color: var(--mo-ink-2);
  font-size: 12px;
}
.mo-pick {
  accent-color: var(--mo-accent);
}
.mo-tag.warn {
  color: #8a4b1e;
  border-color: #d8b28d;
}
.mo-source-online {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin: 2px 0 10px;
  color: var(--mo-ink-2);
  font-size: 12px;
}
.mo-check-report {
  margin: 6px 0 10px;
  padding: 10px 12px;
  border: 1px solid var(--mo-line);
  border-radius: 8px;
  font-size: 13px;
  color: var(--mo-ink-2);
}
.mo-check-report p {
  margin: 0;
}
.mo-check-report ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.mo-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 12px;
}
.mo-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0;
}
.mo-row input {
  flex: 1;
  min-width: 120px;
}
input,
textarea,
select {
  box-sizing: border-box;
  padding: 7px 9px;
  border: 1px solid var(--mo-line);
  border-radius: 6px;
  background: var(--mo-paper-2);
  color: inherit;
  font: inherit;
  font-size: 13px;
}
textarea {
  width: 100%;
  resize: vertical;
}
.mo-file {
  display: inline-flex;
  cursor: pointer;
}
.mo-file input {
  display: none;
}
.mo-sources {
  list-style: none;
  margin: 0;
  padding: 0;
}
.mo-sources li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--mo-line);
}
.mo-sources li:last-child {
  border-bottom: 0;
}
.mo-form-row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin: 10px 0;
}
.mo-form-row span {
  width: 132px;
  flex-shrink: 0;
  color: var(--mo-muted);
  font-size: 14px;
}
.mo-form-row input {
  flex: 1;
  padding: 6px 9px;
  border: 1px solid var(--mo-line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 14px;
}
.mo-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.mo-switch input {
  width: auto;
  flex-shrink: 0;
  accent-color: var(--mo-accent);
}
.mo-source-name {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}
.mo-url {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--mo-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mo-json {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
}
.mo-debug {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--mo-line);
}
.mo-debug-out {
  max-height: 320px;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--mo-line);
  border-radius: 6px;
  background: var(--mo-paper);
  font-size: 11px;
  white-space: pre-wrap;
}

/* 字典规则 */
.mo-btn.tiny {
  padding: 3px 9px;
  font-size: 12px;
}
.mo-dict-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
.mo-dict-list {
  margin: 4px 0 10px;
}
.mo-dict-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 7px 2px;
  border-bottom: 1px solid var(--mo-line);
}
.mo-dict-row:last-child {
  border-bottom: 0;
}
.mo-dict-row .mo-url {
  flex: 1 1 180px;
}
.mo-dict-trial {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--mo-line);
}
.mo-dict-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 6px 0 8px;
}
.mo-dict-tabs button {
  padding: 4px 12px;
  border: 1px solid var(--mo-line);
  border-radius: 999px;
  background: var(--mo-paper);
  color: var(--mo-ink-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.mo-dict-tabs button.on {
  border-color: var(--mo-accent);
  background: var(--mo-accent-soft);
  color: var(--mo-accent);
}
.mo-dict-fail {
  margin-left: 5px;
  color: #a8402e;
  font-size: 11px;
}
.mo-dict-result {
  padding: 10px 12px;
  border: 1px solid var(--mo-line);
  border-radius: 8px;
  background: var(--mo-paper);
}
.mo-dict-text {
  margin: 0 0 8px;
  max-height: 280px;
  overflow: auto;
  font: 13px/1.8 -apple-system, 'Noto Sans SC', 'PingFang SC', sans-serif;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.mo-reader-dict .mo-dict-line {
  margin: 4px 0 10px;
  overflow-wrap: anywhere;
}
.mo-reader-dict .mo-dict-text {
  max-height: 180px;
}

/* 书内搜索 */
.mo-search-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
}
.mo-search-list li + li {
  border-top: 1px solid var(--mo-line);
}
.mo-search-item {
  display: block;
  width: 100%;
  padding: 10px 2px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.mo-search-title {
  font-size: 14px;
}
.mo-search-count {
  margin-left: 8px;
  color: var(--mo-accent);
  font-size: 12px;
}
.mo-search-snippet {
  display: block;
  margin-top: 4px;
  color: var(--mo-ink-2);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.mo-search-hint {
  margin: 8px 0 0;
  font-size: 12px;
}
.mo-search-errors {
  margin-top: 10px;
  color: var(--mo-ink-2);
  font-size: 12px;
}
.mo-search-errors summary {
  cursor: pointer;
}
.mo-search-errors p {
  margin: 4px 0 0;
}
.mo-media-notice {
  position: absolute;
  top: 12px;
  left: 50%;
  z-index: 5;
  transform: translateX(-50%);
  max-width: 82%;
  margin: 0;
  padding: 8px 14px;
  border-radius: 8px;
  background: rgba(20, 21, 24, 0.86);
  color: #d8d4c8;
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
}
.mo-media-retry {
  margin-left: 8px;
  padding: 2px 8px;
  border: 1px solid currentColor;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.mo-media-retry:disabled {
  opacity: 0.6;
  cursor: default;
}
.mo-reader-hint {
  position: absolute;
  left: 50%;
  bottom: 84px;
  transform: translateX(-50%);
  max-width: 82%;
  padding: 8px 14px;
  border-radius: 8px;
  background: rgba(20, 21, 24, 0.86);
  color: #d8d4c8;
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
  z-index: 5;
  pointer-events: none;
}
.mo-auto-page {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(20, 21, 24, 0.86);
  color: #d8d4c8;
  font-size: 12px;
  z-index: 6;
}
.mo-auto-page-notice {
  max-width: 42vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #e6a23c;
}
.mo-auto-page .mo-btn.tiny {
  padding: 2px 8px;
  font-size: 12px;
}

/* 阅读页 */
.mo-reading-mode {
  background: #141518;
}
.mo-reader {
  position: relative;
  height: 100%;
  overflow: hidden;
}
.mo-reader-canvas {
  position: absolute;
  inset: 0;
}
.mo-reader-loading {
  padding: 40px;
  color: #8f897b;
}
/* 原版 PDF 缺失或加载失败时的兜底面板：不白屏，并给文本模式入口。 */
.mo-pdf-unavailable {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  height: 100%;
  padding: 40px 24px;
  color: #d8d4c8;
  text-align: center;
  background: #1b1d22;
}
.mo-pdf-unavailable p {
  margin: 0;
  max-width: 420px;
  line-height: 1.6;
}
.mo-chrome {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  pointer-events: none;
}
.mo-chrome-top,
.mo-chrome-bottom {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(20, 21, 24, 0.72);
  color: #d8d4c8;
  pointer-events: auto;
  backdrop-filter: blur(6px);
}
.mo-chrome-title {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  text-align: center;
}
.mo-chrome-title strong {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mo-chrome-title span {
  font-size: 11px;
  color: rgba(216, 212, 200, 0.65);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mo-chrome-bottom {
  justify-content: space-around;
  padding: 12px 14px;
}
.mo-chrome-btn {
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.mo-chrome-btn:disabled {
  opacity: 0.35;
}
.mo-chrome .mo-icon-btn {
  color: #d8d4c8;
}
.mo-sheet-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.35);
  z-index: 3;
}
.mo-sheet {
  width: 100%;
  padding: 18px 22px 26px;
  border-radius: 14px 14px 0 0;
  background: var(--mo-paper-2);
  color: var(--mo-ink);
}
.mo-sheet-scroll {
  max-height: 78vh;
  overflow-y: auto;
}
/* 设置面板：移动端底部、桌面右侧；分区可折叠 */
.mo-settings-mask {
  z-index: 5;
}
.mo-settings-sheet {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: calc(26px + env(safe-area-inset-bottom));
}
.mo-settings-sheet:focus-visible {
  outline: 2px solid var(--mo-accent);
  outline-offset: -2px;
}
.mo-settings-group {
  border-top: 1px solid var(--mo-line);
  padding: 4px 0;
}
.mo-settings-group > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 6px 0;
  font-size: 14px;
  font-weight: 600;
  list-style: none;
  cursor: pointer;
}
.mo-settings-group > summary::-webkit-details-marker {
  display: none;
}
.mo-settings-group > summary::before {
  content: '▸';
  color: var(--mo-muted);
  font-size: 12px;
}
.mo-settings-group[open] > summary::before {
  content: '▾';
}
.mo-group-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.mo-group-bar .muted,
.mo-settings-tip {
  font-size: 12px;
}
.mo-settings-tip {
  margin: 0 0 6px;
}
.mo-scope-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 4px 0 10px;
}
.mo-scope-tabs {
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--mo-line);
  border-radius: 999px;
}
.mo-scope-tab {
  min-height: 36px;
  padding: 8px 16px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.mo-scope-tab.on {
  background: var(--mo-accent);
  color: #fff;
}
.mo-scope-tab:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.mo-scope-badge {
  padding: 2px 8px;
  border: 1px solid var(--mo-accent);
  border-radius: 999px;
  color: var(--mo-accent);
  font-size: 12px;
}
.mo-settings-error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid #d9534f;
  border-radius: 8px;
  font-size: 13px;
}
.mo-settings-sheet .mo-slider,
.mo-settings-sheet .mo-theme-row,
.mo-settings-sheet .mo-switch {
  min-height: 44px;
}
@media (min-width: 721px) {
  .mo-settings-mask {
    justify-content: flex-end;
    align-items: stretch;
  }
  .mo-settings-sheet {
    width: 420px;
    max-width: 92vw;
    height: 100%;
    max-height: none;
    border-radius: 14px 0 0 14px;
    padding-bottom: 26px;
  }
}
@media (max-width: 720px) {
  .mo-settings-sheet {
    max-height: 82vh;
  }
  .mo-settings-sheet .mo-slider input,
  .mo-settings-sheet .mo-theme-row button,
  .mo-settings-sheet .mo-theme-row select,
  .mo-settings-sheet .mo-input {
    min-height: 44px;
  }
  .mo-settings-sheet .mo-input {
    font-size: 16px;
  }
}
.mo-switch-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 14px;
  min-height: 200px;
}
@media (max-width: 720px) {
  .mo-switch-body {
    grid-template-columns: minmax(0, 1fr);
  }
}
.mo-switch-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
}
.mo-switch-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--mo-line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.mo-switch-row:hover {
  border-color: var(--mo-accent);
}
.mo-switch-row.on {
  border-color: var(--mo-accent);
  background: var(--mo-accent-soft);
}
.mo-switch-title {
  font-weight: 600;
}
.mo-switch-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.mo-switch-preview {
  min-width: 0;
}
.mo-switch-preview h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.mo-switch-intro {
  max-height: 72px;
  overflow-y: auto;
  color: var(--mo-ink-2);
  font-size: 12px;
}
.mo-switch-toc {
  max-height: 140px;
  margin: 4px 0 0;
  padding-left: 18px;
  overflow-y: auto;
  color: var(--mo-ink-2);
  font-size: 12px;
}
.mo-shelf-groups {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 4px 0 18px;
}
.mo-shelf-groups button {
  padding: 5px 12px;
  border: 1px solid var(--mo-line);
  border-radius: 999px;
  background: transparent;
  color: var(--mo-ink-2);
  font-size: 12px;
  cursor: pointer;
}
.mo-shelf-groups button.on {
  border-color: var(--mo-accent);
  background: var(--mo-accent-soft);
  color: var(--mo-accent);
}
.mo-zone-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 10px 0;
}
.mo-zone-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--mo-ink-3);
}
.mo-zone-cell .mo-select {
  width: 100%;
  padding: 4px 6px;
  font-size: 12px;
}
.mo-sheet-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.mo-sheet-head strong {
  flex: 1;
  font: 600 16px/1.3 'Songti SC', 'Noto Serif SC', serif;
}
.mo-slider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0;
  font-size: 13px;
  color: var(--mo-ink-2);
}
.mo-slider input {
  flex: 1;
  accent-color: var(--mo-accent);
}
.mo-slider b {
  width: 32px;
  text-align: right;
  color: var(--mo-ink);
  font-weight: 500;
}
.mo-theme-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 0;
  font-size: 13px;
  color: var(--mo-ink-2);
}
.mo-theme-row > span {
  width: 34px;
}
.mo-theme-row button {
  padding: 6px 16px;
  border: 1px solid var(--mo-line);
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.mo-theme-row button.on {
  border-color: var(--mo-accent);
  background: var(--mo-accent);
  color: #f6f2e6;
}
.mo-theme-row .mo-select {
  min-width: 130px;
}
.mo-theme-wrap {
  flex-wrap: wrap;
}
.mo-theme-editor {
  margin: 12px 0 0 44px;
  padding: 12px;
  border: 1px solid var(--mo-line);
  border-radius: 12px;
  background: var(--mo-paper-2);
}
.mo-theme-editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  font-size: 14px;
}
.mo-theme-field {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0;
  font-size: 13px;
  color: var(--mo-ink-2);
}
.mo-theme-field > span {
  width: 34px;
}
.mo-theme-field .mo-input {
  flex: 1;
}
.mo-color-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 10px 0;
}
.mo-color-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--mo-line);
  border-radius: 10px;
  font-size: 13px;
  color: var(--mo-ink-2);
}
.mo-color-field input[type='color'] {
  width: 42px;
  height: 28px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}
.mo-theme-editor-actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}
.mo-font-upload {
  padding: 6px 14px;
  border: 1px solid var(--mo-line);
  border-radius: 999px;
  cursor: pointer;
  font-size: 13px;
}
.mo-font-upload input {
  display: none;
}
.mo-font-list {
  margin: 8px 0 0 44px;
  border-top: 1px solid var(--mo-line);
}
.mo-font-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--mo-line);
  font-size: 13px;
}
.mo-font-item span {
  flex: 1;
  color: var(--mo-ink);
}
.mo-font-item small {
  color: var(--mo-ink-2);
}
.mo-font-status {
  margin: 8px 0 0 44px;
  font-size: 12px;
  color: var(--mo-ink-2);
}
.mo-replace-rule {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 4px 0;
}
.mo-replace-rule .mo-input {
  flex: 1;
  min-width: 120px;
}

.mo-bookmarks {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mo-bookmarks li {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px dashed var(--mo-line);
}
.mo-bookmark-jump {
  flex: 1;
  text-align: left;
  border: 0;
  background: transparent;
  color: var(--mo-ink);
  padding: 10px 4px;
  cursor: pointer;
}

.mo-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(420px, 88vw);
  padding: 18px 20px;
  background: var(--mo-paper-2);
  color: var(--mo-ink);
  box-shadow: -16px 0 40px rgba(0, 0, 0, 0.24);
  z-index: 4;
  display: flex;
  flex-direction: column;
}
.mo-drawer-list {
  flex: 1;
  overflow: auto;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.mo-drawer-list li {
  padding: 3px 0;
  font-size: 13px;
  color: var(--mo-ink-2);
}
.mo-drawer-list li.volume {
  margin-top: 10px;
  color: var(--mo-ink);
  font-weight: 600;
}
.mo-drawer-list li.on button {
  color: var(--mo-accent);
  font-weight: 600;
}
.mo-drawer-list button {
  border: 0;
  background: none;
  padding: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.mo-fade-enter-active,
.mo-fade-leave-active {
  transition: opacity 0.16s ease;
}
.mo-fade-enter-from,
.mo-fade-leave-to {
  opacity: 0;
}
.mo-note-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.mo-note-form textarea {
  width: 100%;
  min-height: 72px;
  resize: vertical;
  border: 1px solid rgba(0, 0, 0, 0.14);
  border-radius: 8px;
  padding: 8px 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1.7;
}
.mo-note-actions {
  display: flex;
  gap: 8px;
}
.mo-underline-lines {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 46vh;
  overflow: auto;
}
.mo-underline-lines label {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  line-height: 1.7;
  font-size: 14px;
}
.mo-articles {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mo-articles li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}
.mo-article-title {
  border: 0;
  background: none;
  padding: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.mo-article-body {
  white-space: pre-wrap;
  line-height: 1.9;
  font-size: 15px;
}
.mo-download {
  margin: 16px 0 4px;
  padding: 14px 16px;
  border: 1px solid var(--mo-line);
  border-radius: 10px;
}
.mo-download-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.mo-download-head h3 {
  margin: 0;
  font: 600 15px/1.3 'Songti SC', 'Noto Serif SC', serif;
}
.mo-download-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0 0 10px;
  font-size: 13px;
}
.mo-chapter-error {
  margin: 8px 0;
  font-size: 13px;
}
.mo-download-scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 14px;
}
.mo-download-scope label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.mo-download-scope input[type='number'] {
  width: 64px;
  padding: 4px 6px;
  border: 1px solid var(--mo-line);
  border-radius: 6px;
  background: var(--mo-paper);
  color: inherit;
  font: inherit;
}
.mo-download-progress {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 10px 0 0;
  font-size: 13px;
}
.mo-download-bar {
  flex: 1 1 120px;
  min-width: 120px;
  height: 6px;
  border-radius: 999px;
  background: var(--mo-line);
  overflow: hidden;
}
.mo-download-bar > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--mo-accent);
}
.mo-download-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.mo-export-font {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

</style>
