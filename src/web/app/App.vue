<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import CanvasReader from '../reader/CanvasReader.vue'
import ComicReader from '../reader/ComicReader.vue'
import AudioReader from '../reader/AudioReader.vue'
import VideoReader from '../reader/VideoReader.vue'
import { simulatedChapterCount, simulatedProgress } from '../../core/reader/simulate'
import {
  DEFAULT_MENU_ITEMS,
  DEFAULT_TAP_ZONES,
  MENU_ITEMS,
  READER_PRESETS,
  TAP_ACTIONS,
  TAP_ZONE_NAMES,
  TIP_MODES,
  tapActionLabel,
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

const props = defineProps<{ remote?: any; layout?: any }>()

type View = 'shelf' | 'sources' | 'search' | 'detail' | 'reader'
type Theme = 'light' | 'sepia' | 'dark'
type Turn = 'none' | 'cover' | 'slide' | 'simulate' | 'scroll'

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
const sourceTypeNames: Record<number, string> = { 0: '文本', 1: '音频', 2: '图片', 3: '文件', 4: '视频' }

const shelfBooks = ref<any[]>([])
const shelfSort = ref<'recent' | 'name' | 'progress'>('recent')
const shelfGroup = ref('')
const shelfGroupInput = ref('')
const shelfSelecting = ref(false)
const selectedBookIds = ref<Set<string>>(new Set())
const localInput = ref<HTMLInputElement | null>(null)
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

const currentBook = ref<any>(null)
const introText = computed(() => plainText(currentBook.value?.intro))
const chapters = ref<any[]>([])
const currentChapter = ref<any>(null)
const content = ref('')
const readerKind = ref<'text' | 'images' | 'audio' | 'video'>('text')
const readerImages = ref<string[]>([])
const readerMedia = ref('')
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
const settings = ref({
  fontSize: 22,
  fontId: '',
  lineSpacing: 1.9,
  paragraphSpacing: 6,
  indent: 2,
  padding: { left: 22, top: 5, right: 22, bottom: 4 },
  theme: 'light' as string,
  customThemes: [] as CustomTheme[],
  pageAnimation: 'cover' as Turn,
  headerMode: 1,
  footerMode: 6,
  showHeaderLine: true,
  showFooterLine: true,
  tapZones: [...DEFAULT_TAP_ZONES] as number[],
  menuItems: [...DEFAULT_MENU_ITEMS] as string[],
  replaceRules: [] as Array<{
    id: string
    pattern: string
    replacement: string
    regex: boolean
    enabled: boolean
  }>,
})
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
const speaking = ref(false)
const highlightText = ref('')
let speechSegments: Array<{ text: string; start: number }> = []
let speechIndex = 0
let pageTimer: ReturnType<typeof setTimeout> | undefined

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
function hostOf(url?: string) {
  try {
    return new URL(String(url ?? '')).host
  } catch {
    return ''
  }
}
const sourceGroups = computed(() =>
  [...new Set(sources.value.map((source) => source.bookSourceGroup).filter((group): group is string => typeof group === 'string' && group.length > 0))].sort((a, b) => a.localeCompare(b, 'zh')),
)
const sourceDomains = computed(() => [...new Set(sources.value.map((source) => hostOf(source.bookSourceUrl)).filter(Boolean))].sort())
const filteredSortedSources = computed(() => {
  const key = sourceFilter.value.trim().toLowerCase()
  let list = sources.value
  if (key) {
    list = list.filter((source) =>
      `${source.bookSourceName ?? ''} ${source.bookSourceUrl ?? ''} ${source.bookSourceGroup ?? ''}`.toLowerCase().includes(key),
    )
  }
  if (sourceGroup.value) list = list.filter((source) => source.bookSourceGroup === sourceGroup.value)
  if (sourceDomain.value) list = list.filter((source) => hostOf(source.bookSourceUrl) === sourceDomain.value)
  const sorted = [...list]
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
watch([sourceFilter, sourceGroup, sourceDomain, sourceSort], () => {
  sourcePage.value = 1
})
watch(
  () => filteredSortedSources.value.length,
  () => {
    if (sourcePage.value > sourcePageCount.value) sourcePage.value = sourcePageCount.value
  },
)
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
    try {
      const stored = await call('getSettings')
      if (stored?.settings) settings.value = { ...settings.value, ...stored.settings }
    } catch {
      // 设置读取失败不阻塞主流程
    }
    try {
      const fontResult = await call('listFonts')
      customFonts.value = fontResult?.fonts ?? []
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

async function exportBook(format: 'txt' | 'epub') {
  const book = currentBook.value as any
  if (!book?.id) return
  exportBusy.value = true
  try {
    const result: any = await call('exportBook', { bookId: book.id, limit: 50, format })
    const binary = atob(result.dataBase64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const mime = format === 'epub' ? 'application/epub+zip' : 'text/plain;charset=utf-8'
    const blob = new Blob([bytes], { type: mime })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = result.fileName || `book.${format}`
    link.click()
    URL.revokeObjectURL(url)
    status.value = `已导出 ${result.chapters} 章（${format.toUpperCase()}）`
  } catch (error) {
    status.value = errorText(error)
  } finally {
    exportBusy.value = false
  }
}

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

async function loadToc(book: any, tocUrlFallback: string) {
  const toc = await call('getToc', {
    sourceUrl: book.origin,
    tocUrl: book.tocUrl || tocUrlFallback,
  })
  chapters.value = toc.chapters ?? []
}

async function openBook(book: any) {
  busy.value = true
  try {
    const info = await call('getBookInfo', { sourceUrl: book.origin, bookUrl: book.bookUrl })
    currentBook.value = { ...book, ...info.info, tocUrl: info.info.tocUrl || book.bookUrl }
    await loadToc(currentBook.value, book.bookUrl)
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
  currentBook.value = { ...book }
  chapters.value = []
  try {
    await loadToc(currentBook.value, book.bookUrl)
    await loadBookmarks()
    await loadNotes()
    const result = await call('getProgress', { bookId: book.id })
    progress.value = result?.progress ?? null
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
    fontMessage.value = `已删除「${font.name}」`
  } catch (error) {
    fontMessage.value = `字体删除失败：${errorText(error)}`
  } finally {
    busy.value = false
  }
}

async function commitThemeState(themeId: string, themes: CustomTheme[], message: string) {
  try {
    await call('saveSettings', { settings: { theme: themeId, customThemes: themes } })
    settings.value.theme = themeId
    settings.value.customThemes = themes
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
  if (shelfSelecting.value) toggleShelfSelect(book)
  else void openShelfBook(book)
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

async function addToShelf() {
  if (!currentBook.value) return
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
  } catch (error) {
    status.value = errorText(error)
  }
}

async function openChapter(chapter: any, page?: number) {
  if (!chapter || chapter.isVolume || !chapter.url) return
  tocOpen.value = false
  bookmarksOpen.value = false
  stopSpeech()
  busy.value = true
  chrome.value = false
  initialPage.value =
    typeof page === 'number'
      ? page
      : progress.value?.chapterUrl === chapter.url
        ? Number(progress.value.position ?? 0)
        : 0
  try {
    const result = await call('getContent', {
      sourceUrl: currentBook.value.origin,
      chapterUrl: chapter.url,
    })
    const index = chapters.value.indexOf(chapter)
    const kind = (result.kind ?? 'text') as 'text' | 'images' | 'audio' | 'video'
    currentChapter.value = chapter
    readerKind.value = kind
    content.value = kind === 'text' ? (result.content ?? '') : ''
    readerImages.value = kind === 'images' ? (result.images ?? []) : []
    readerMedia.value =
      kind === 'audio' || kind === 'video' ? (result.mediaUrl ?? chapter.url) : ''
    readerTitle.value = chapter.title
    view.value = 'reader'
    if (currentBook.value?.id) {
      call('saveProgress', {
        bookId: currentBook.value.id,
        chapterIndex: index,
        chapterTitle: chapter.title,
        chapterUrl: chapter.url,
        position: initialPage.value,
      }).catch(() => undefined)
    }
  } catch (error) {
    status.value = errorText(error)
  } finally {
    busy.value = false
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

function continueReading() {
  if (!chapters.value.length) return
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

function onPage(payload: { page: number; total: number }) {
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

function splitSpeech(text: string) {
  const list: Array<{ text: string; start: number }> = []
  const pattern = /[^。！？!?…\n]+[。！？!?…]*/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    const value = match[0].trim()
    if (value) list.push({ text: value, start: match.index })
  }
  return list
}

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices?.() ?? []
  return voices.find((voice) => voice.lang?.toLowerCase().startsWith('zh')) ?? null
}

function speakNext() {
  if (!speaking.value) return
  if (speechIndex >= speechSegments.length) {
    stopSpeech()
    return
  }
  const segment = speechSegments[speechIndex]
  const synth = window.speechSynthesis
  if (!synth) {
    stopSpeech()
    status.value = '当前浏览器不支持朗读'
    return
  }
  const utterance = new SpeechSynthesisUtterance(segment.text)
  utterance.lang = 'zh-CN'
  utterance.rate = 1
  const voice = pickVoice()
  if (voice) utterance.voice = voice
  utterance.onstart = () => {
    highlightText.value = segment.text
    const target = readerRef.value?.findPageFor?.(segment.text)
    if (typeof target === 'number' && target >= 0) readerRef.value?.goto?.(target)
  }
  utterance.onend = () => {
    if (!speaking.value) return
    speechIndex += 1
    speakNext()
  }
  utterance.onerror = () => {
    if (!speaking.value) return
    speechIndex += 1
    speakNext()
  }
  synth.speak(utterance)
}

function startSpeech() {
  if (!('speechSynthesis' in window)) {
    status.value = '当前浏览器不支持朗读'
    return
  }
  if (!replacedContent.value.trim()) return
  window.speechSynthesis.cancel()
  speechSegments = splitSpeech(replacedContent.value)
  if (speechSegments.length === 0) return
  speechIndex = 0
  speaking.value = true
  speakNext()
}

function stopSpeech() {
  speaking.value = false
  highlightText.value = ''
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}

function toggleSpeech() {
  if (speaking.value) stopSpeech()
  else startSpeech()
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
  if (code === 13) {
    toggleSpeech()
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

async function persistSettings() {
  try {
    await call('saveSettings', {
      settings: {
        fontSize: settings.value.fontSize,
        fontId: settings.value.fontId,
        lineSpacing: settings.value.lineSpacing,
        paragraphSpacing: settings.value.paragraphSpacing,
        indent: settings.value.indent,
        padding: settings.value.padding,
        theme: settings.value.theme,
        customThemes: settings.value.customThemes,
        pageAnimation: settings.value.pageAnimation,
        headerMode: settings.value.headerMode,
        footerMode: settings.value.footerMode,
        showHeaderLine: settings.value.showHeaderLine,
        showFooterLine: settings.value.showFooterLine,
        tapZones: settings.value.tapZones,
        menuItems: settings.value.menuItems,
      },
    })
  } catch (error) {
    status.value = errorText(error)
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
        <button :class="{ on: view === 'sources' }" data-testid="nav-sources" @click="view = 'sources'">书源</button>
        <button :class="{ on: view === 'rss' }" data-testid="nav-rss" @click="view = 'rss'">订阅</button>
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
            </p>
            <div class="mo-hero-actions">
              <button class="mo-btn primary" data-testid="read-start" @click="continueReading">
                {{ progress ? '继续阅读' : '开始阅读' }}
              </button>
              <button v-if="!currentBook.id" class="mo-btn" data-testid="add-shelf" @click="addToShelf">加入书架</button>
              <span v-else class="mo-tag">已在书架</span>
              <button class="mo-btn" data-testid="simulate" @click="openSimulate">模拟阅读</button>
              <button class="mo-btn" :disabled="cacheBusy" data-testid="cache-book" @click="cacheBookChapters">{{ cacheBusy ? '缓存中…' : '缓存 20 章' }}</button>
              <button class="mo-btn" :disabled="exportBusy" data-testid="export-book" @click="exportBook('txt')">{{ exportBusy ? '导出中…' : '导出 TXT' }}</button>
              <button class="mo-btn" :disabled="exportBusy" data-testid="export-epub" @click="exportBook('epub')">{{ exportBusy ? '导出中…' : '导出 EPUB' }}</button>
              <span v-if="currentBook.simulateEnabled" class="mo-tag soft">模拟至 {{ simulatedChapterCount(currentBook) }} 章</span>
              <span v-if="progress" class="muted">
                {{ progress.chapterTitle || `第 ${progress.chapterIndex + 1} 章` }}
              </span>
            </div>
          </div>
        </div>

        <p v-if="introText" class="mo-intro">{{ introText }}</p>

        <div class="mo-toc-block">
          <div class="mo-section-head">
            <h3>目录</h3>
            <input v-model="tocFilter" class="mo-toc-filter" placeholder="搜索章节" />
          </div>
          <p v-if="tocHasMore" class="muted">已显示 {{ filteredChapters.length }} / {{ tocTotal }} 章</p>
          <ol class="mo-toc" data-testid="toc">
            <li v-for="chapter in filteredChapters" :key="chapter.url || chapter.title" :class="{ volume: chapter.isVolume }">
              <button v-if="!chapter.isVolume" data-testid="chapter" @click="openChapter(chapter)">{{ chapter.title }}</button>
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
            <button class="mo-btn" data-testid="source-check" @click="runSourceCheck">检查</button>
          </div>
          <div class="mo-source-bulk">
            <label class="mo-switch"><input type="checkbox" :checked="allPageSelected" @change="toggleSelectPage" />本页全选</label>
            <span class="muted">已选 {{ selectedCount }} 个</span>
            <button class="mo-btn" :disabled="selectedCount === 0 || busy" data-testid="batch-enable" @click="batchSetEnabled(true)">批量启用</button>
            <button class="mo-btn" :disabled="selectedCount === 0 || busy" data-testid="batch-disable" @click="batchSetEnabled(false)">批量禁用</button>
          </div>
          <div v-if="checkReport" class="mo-check-report" data-testid="source-check-report">
            <p>检查 {{ checkReport.total }} 个：通过 {{ checkReport.ok }}，问题 {{ checkReport.problems.length }}</p>
            <ul v-if="checkReport.problems.length">
              <li v-for="item in checkReport.problems.slice(0, 8)" :key="item.name">{{ item.name }}：{{ item.message }}</li>
              <li v-if="checkReport.problems.length > 8" class="muted">…另有 {{ checkReport.problems.length - 8 }} 个</li>
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
              <span v-if="source.enabledExplore" class="mo-tag soft">发现</span>
              <span v-if="source.loginUrl" class="mo-tag warn">需登录</span>
              <span v-else-if="source.enabledCookieJar" class="mo-tag soft">Cookie</span>
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

      <section v-if="view === 'reader'" class="mo-reader">
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
            :indent="settings.indent"
            :padding="settings.padding"
            :initial-page="initialPage"
            :highlight="highlightText"
            :underlines="underlineQuotes"
            :theme="theme"
            :theme-colors="activeThemeColors"
            :animation="settings.pageAnimation"
            :header-mode="settings.headerMode"
            :footer-mode="settings.footerMode"
            :show-header-line="settings.showHeaderLine"
            :show-footer-line="settings.showFooterLine"
            :tap-zones="settings.tapZones"
            :book-percent="bookPercent"
            :battery-percent="batteryPercent"
            @page="onPage"
            @tap-action="onTapAction"
          />
          <ComicReader
            v-else-if="readerKind === 'images'"
            :images="readerImages"
            :title="readerTitle"
            :initial-page="initialPage"
            @page="onPage"
          />
          <AudioReader
            v-else-if="readerKind === 'audio'"
            :src="readerMedia"
            :title="readerTitle"
            :book-name="currentBook?.name || ''"
            :initial-position="initialPage"
            @progress="onMediaProgress"
            @ended="openAdjacent(1)"
          />
          <VideoReader
            v-else-if="readerKind === 'video'"
            :src="readerMedia"
            :title="readerTitle"
            :book-name="currentBook?.name || ''"
            :initial-position="initialPage"
            @progress="onMediaProgress"
            @ended="openAdjacent(1)"
          />
          <p v-else class="muted mo-reader-loading">{{ busy ? '加载中…' : '（空章节）' }}</p>
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
              <button class="mo-icon-btn" title="目录" data-testid="reader-toc" @click="tocOpen = true">☰</button>
            </div>
            <div class="mo-chrome-bottom">
              <button v-if="settings.menuItems.includes('prev')" class="mo-chrome-btn" :disabled="chapterIndex <= 0" @click="openAdjacent(-1)">上一章</button>
              <button v-if="settings.menuItems.includes('settings') && readerKind === 'text'" class="mo-chrome-btn" data-testid="reader-settings" @click="settingsOpen = true">Aa</button>
              <button v-if="readerKind === 'text'" class="mo-chrome-btn" data-testid="reader-speak" @click="toggleSpeech">{{ speaking ? '暂停' : '朗读' }}</button>
              <button v-if="settings.menuItems.includes('toc')" class="mo-chrome-btn" @click="tocOpen = true">目录</button>
              <button v-if="settings.menuItems.includes('next')" class="mo-chrome-btn" :disabled="chapterIndex >= chapters.length - 1" @click="openAdjacent(1)">下一章</button>
            </div>
          </div>
        </transition>

        <transition name="mo-fade">
          <div v-if="settingsOpen" class="mo-sheet-mask" @click.self="settingsOpen = false">
            <div class="mo-sheet mo-sheet-scroll">
              <div class="mo-sheet-head">
                <strong>阅读设置</strong>
                <button class="mo-icon-btn" @click="settingsOpen = false">✕</button>
              </div>
              <div class="mo-theme-row">
                <span>预设</span>
                <button v-for="preset in READER_PRESETS" :key="preset.key" @click="applyPreset(preset)">{{ preset.name }}</button>
              </div>
              <label class="mo-slider">
                <span>字号</span>
                <input v-model.number="settings.fontSize" type="range" min="14" max="34" step="1" @change="persistSettings" />
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
                <input v-model.number="settings.lineSpacing" type="range" min="1.2" max="2.6" step="0.1" @change="persistSettings" />
                <b>{{ settings.lineSpacing.toFixed(1) }}</b>
              </label>
              <label class="mo-slider">
                <span>段距</span>
                <input v-model.number="settings.paragraphSpacing" type="range" min="0" max="20" step="1" @change="persistSettings" />
                <b>{{ settings.paragraphSpacing }}</b>
              </label>
              <div class="mo-theme-row">
                <span>缩进</span>
                <button :class="{ on: settings.indent === 2 }" @click="settings.indent = 2; persistSettings()">两字</button>
                <button :class="{ on: settings.indent === 0 }" @click="settings.indent = 0; persistSettings()">无</button>
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
              <div class="mo-zone-grid">
                <div v-for="(zone, index) in settings.tapZones" :key="index" class="mo-zone-cell">
                  <span>{{ TAP_ZONE_NAMES[index] }}</span>
                  <select :value="zone" class="mo-select" @change="setTapZone(index, $event)">
                    <option v-for="action in TAP_ACTIONS" :key="action.code" :value="action.code">{{ action.label }}{{ action.available ? '' : '（未开放）' }}</option>
                  </select>
                </div>
              </div>
              <div class="mo-theme-row">
                <span>底栏</span>
                <label v-for="item in MENU_ITEMS" :key="item.key" class="mo-switch">
                  <input type="checkbox" :checked="settings.menuItems.includes(item.key)" @change="toggleMenuItem(item.key)" />{{ item.label }}
                </label>
              </div>
              <div class="mo-theme-row">
                <span>替换</span>
                <button class="mo-btn" data-testid="replace-add" @click="addReplaceRule">加规则</button>
                <span class="muted">按顺序作用于正文</span>
              </div>
              <div v-for="rule in settings.replaceRules" :key="rule.id" class="mo-replace-rule">
                <input v-model="rule.pattern" class="mo-input" placeholder="查找内容" @change="persistSettings" />
                <input v-model="rule.replacement" class="mo-input" placeholder="替换为" @change="persistSettings" />
                <label class="mo-switch"><input v-model="rule.regex" type="checkbox" @change="persistSettings" />正则</label>
                <label class="mo-switch"><input v-model="rule.enabled" type="checkbox" @change="persistSettings" />启用</label>
                <button class="mo-icon-btn" @click="removeReplaceRule(rule)">✕</button>
              </div>
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
</style>
