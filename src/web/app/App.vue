<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import CanvasReader from '../reader/CanvasReader.vue'

const props = defineProps<{ remote?: any; layout?: any }>()

type View = 'shelf' | 'sources' | 'search' | 'detail' | 'reader'
type Theme = 'light' | 'sepia' | 'dark'
type Turn = 'none' | 'cover' | 'slide'

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

const sources = ref<any[]>([])
const importText = ref('')
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

const searchKey = ref('')
const searching = ref(false)
const books = ref<any[]>([])
const searchErrors = ref<any[]>([])

const currentBook = ref<any>(null)
const introText = computed(() => plainText(currentBook.value?.intro))
const chapters = ref<any[]>([])
const currentChapter = ref<any>(null)
const content = ref('')
const readerTitle = ref('')
const progress = ref<any>(null)
const settings = ref({
  fontSize: 22,
  lineSpacing: 1.9,
  theme: 'light' as Theme | 'system',
  pageAnimation: 'cover' as Turn,
})
const initialPage = ref(0)
const tocFilter = ref('')
const tocOpen = ref(false)
const chrome = ref(true)
const settingsOpen = ref(false)
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
const theme = computed<Theme>(() =>
  settings.value.theme === 'system' ? 'light' : (settings.value.theme as Theme),
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

const filteredChapters = computed(() => {
  const key = tocFilter.value.trim()
  const list = key ? chapters.value.filter((chapter) => chapter.title.includes(key)) : chapters.value
  return list.slice(0, 1200)
})

const tocTruncated = computed(() => filteredChapters.value.length >= 1200 && chapters.value.length > 1200)

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
    status.value = `书源 ${sources.value.length} 个（启用 ${enabledCount.value}） · 书架 ${shelfBooks.value.length} 本`
  } catch (error) {
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

function shelfProgress(book: any) {
  const record = book?.progress
  if (!record) return null
  const total = Number(book.totalChapterNum ?? 0)
  const percent = total > 0 ? Math.min(100, Math.round(((record.chapterIndex + 1) / total) * 100)) : 0
  return { percent, text: record.chapterTitle ? `读至 ${record.chapterTitle}` : `第 ${record.chapterIndex + 1} 章` }
}

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
    const result = await call('searchBooks', { key, page: 1 })
    books.value = result.books ?? []
    searchErrors.value = result.errors ?? []
    status.value = `搜索到 ${books.value.length} 本，失败 ${searchErrors.value.length} 个源`
  } catch (error) {
    status.value = errorText(error)
  } finally {
    searching.value = false
  }
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
    progress.value = null
    tocFilter.value = ''
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
    const result = await call('getProgress', { bookId: book.id })
    progress.value = result?.progress ?? null
    tocFilter.value = ''
    view.value = 'detail'
    status.value = `${book.name} · ${chapters.value.length} 章`
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

async function openChapter(chapter: any) {
  if (!chapter || chapter.isVolume || !chapter.url) return
  tocOpen.value = false
  busy.value = true
  chrome.value = false
  initialPage.value =
    progress.value?.chapterUrl === chapter.url ? Number(progress.value.position ?? 0) : 0
  try {
    const result = await call('getContent', {
      sourceUrl: currentBook.value.origin,
      chapterUrl: chapter.url,
    })
    const index = chapters.value.indexOf(chapter)
    currentChapter.value = chapter
    content.value = result.content ?? ''
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

async function persistSettings() {
  try {
    await call('saveSettings', {
      settings: {
        fontSize: settings.value.fontSize,
        lineSpacing: settings.value.lineSpacing,
        theme: settings.value.theme,
        pageAnimation: settings.value.pageAnimation,
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

onMounted(refresh)
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
        <span class="mo-version">v{{ version }}</span>
      </nav>
    </template>

    <main class="mo-body" :class="{ 'mo-body-reader': view === 'reader' }">
      <section v-if="view === 'shelf'" class="mo-pane">
        <div class="mo-section-head">
          <h2>书架</h2>
          <span class="muted">{{ shelfBooks.length }} 本 · {{ enabledCount }} 个书源启用</span>
        </div>

        <div v-if="shelfBooks.length === 0" class="mo-empty">
          <div class="mo-empty-glyph">书</div>
          <p class="mo-empty-title">书架还是空的</p>
          <p class="muted">先在「书源」导入书源，再去「搜索」找一本想读的书。</p>
          <button class="mo-btn" @click="view = 'sources'">去导入书源</button>
        </div>

        <div v-else class="mo-shelf" data-testid="shelf">
          <button
            v-for="book in shelfBooks"
            :key="book.id"
            class="mo-cover-card"
            data-testid="shelf-book"
            @click="openShelfBook(book)"
          >
            <span class="mo-cover" :style="coverStyle(book)">
              <img v-if="book.coverUrl" :src="book.coverUrl" alt="" loading="lazy" />
              <span v-else class="mo-cover-glyph">{{ String(book.name || '书').slice(0, 1) }}</span>
              <span v-if="book.originName" class="mo-cover-origin">{{ book.originName }}</span>
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
          <span class="muted">在 {{ enabledCount }} 个启用的书源里找书</span>
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
            <p class="muted">{{ currentBook.author || '未知作者' }} · {{ currentBook.kind || '小说' }}</p>
            <p class="muted">{{ currentBook.originName || currentBook.origin }} · {{ chapters.length }} 章</p>
            <div class="mo-hero-actions">
              <button class="mo-btn primary" data-testid="read-start" @click="continueReading">
                {{ progress ? '继续阅读' : '开始阅读' }}
              </button>
              <button v-if="!currentBook.id" class="mo-btn" data-testid="add-shelf" @click="addToShelf">加入书架</button>
              <span v-else class="mo-tag">已在书架</span>
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
          <p v-if="tocTruncated" class="muted">目录较长，仅显示前 1200 章，可用搜索定位。</p>
          <ol class="mo-toc" data-testid="toc">
            <li v-for="chapter in filteredChapters" :key="chapter.url || chapter.title" :class="{ volume: chapter.isVolume }">
              <button v-if="!chapter.isVolume" data-testid="chapter" @click="openChapter(chapter)">{{ chapter.title }}</button>
              <span v-else>{{ chapter.title }}</span>
            </li>
          </ol>
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

      <section v-if="view === 'reader'" class="mo-reader">
        <div class="mo-reader-canvas" data-testid="reader-content">
          <CanvasReader
            v-if="content"
            :text="content"
            :title="readerTitle"
            :font-size="settings.fontSize"
            :line-height="settings.lineSpacing"
            :initial-page="initialPage"
            :theme="theme"
            :animation="settings.pageAnimation"
            @page="onPage"
            @center-tap="chrome = !chrome"
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
              <button class="mo-icon-btn" title="目录" data-testid="reader-toc" @click="tocOpen = true">☰</button>
            </div>
            <div class="mo-chrome-bottom">
              <button class="mo-chrome-btn" :disabled="chapterIndex <= 0" @click="openAdjacent(-1)">上一章</button>
              <button class="mo-chrome-btn" data-testid="reader-settings" @click="settingsOpen = true">Aa</button>
              <button class="mo-chrome-btn" @click="tocOpen = true">目录</button>
              <button class="mo-chrome-btn" :disabled="chapterIndex >= chapters.length - 1" @click="openAdjacent(1)">下一章</button>
            </div>
          </div>
        </transition>

        <transition name="mo-fade">
          <div v-if="settingsOpen" class="mo-sheet-mask" @click.self="settingsOpen = false">
            <div class="mo-sheet">
              <div class="mo-sheet-head">
                <strong>阅读设置</strong>
                <button class="mo-icon-btn" @click="settingsOpen = false">✕</button>
              </div>
              <label class="mo-slider">
                <span>字号</span>
                <input v-model.number="settings.fontSize" type="range" min="14" max="34" step="1" @change="persistSettings" />
                <b>{{ settings.fontSize }}</b>
              </label>
              <label class="mo-slider">
                <span>行距</span>
                <input v-model.number="settings.lineSpacing" type="range" min="1.2" max="2.6" step="0.1" @change="persistSettings" />
                <b>{{ settings.lineSpacing.toFixed(1) }}</b>
              </label>
              <div class="mo-theme-row">
                <span>主题</span>
                <button v-for="item in [{ value: 'light', label: '纸白' }, { value: 'sepia', label: '米黄' }, { value: 'dark', label: '夜读' }]" :key="item.value" :class="{ on: theme === item.value }" @click="settings.theme = item.value as any; persistSettings()">{{ item.label }}</button>
              </div>
              <div class="mo-theme-row">
                <span>翻页</span>
                <button v-for="item in [{ value: 'cover', label: '覆盖' }, { value: 'slide', label: '平移' }, { value: 'none', label: '无动画' }]" :key="item.value" :class="{ on: settings.pageAnimation === item.value }" @click="settings.pageAnimation = item.value as any; persistSettings()">{{ item.label }}</button>
              </div>
            </div>
          </div>
        </transition>

        <transition name="mo-fade">
          <aside v-if="tocOpen" class="mo-drawer" data-testid="reader-toc-drawer">
            <div class="mo-sheet-head">
              <strong>目录</strong>
              <span class="muted">{{ chapters.length }} 章</span>
              <button class="mo-icon-btn" @click="tocOpen = false">✕</button>
            </div>
            <input v-model="tocFilter" class="mo-filter" placeholder="搜索章节" />
            <ol class="mo-drawer-list">
              <li v-for="chapter in filteredChapters" :key="chapter.url || chapter.title" :class="{ volume: chapter.isVolume, on: chapter === currentChapter }">
                <button v-if="!chapter.isVolume" @click="openChapter(chapter)">{{ chapter.title }}</button>
                <span v-else>{{ chapter.title }}</span>
              </li>
            </ol>
          </aside>
        </transition>
      </section>
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
.mo-intro {
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
</style>
