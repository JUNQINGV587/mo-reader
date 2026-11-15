<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CanvasReader from '../reader/CanvasReader.vue'

const props = defineProps<{ remote?: any; layout?: any }>()

type View = 'shelf' | 'sources' | 'search' | 'detail' | 'reader'
const view = ref<View>('shelf')
const version = ref('')
const status = ref('')
const busy = ref(false)

const sources = ref<any[]>([])
const importText = ref('')
const importMessage = ref('')

const shelfBooks = ref<any[]>([])

const searchKey = ref('')
const searching = ref(false)
const books = ref<any[]>([])
const searchErrors = ref<any[]>([])

const currentBook = ref<any>(null)
const chapters = ref<any[]>([])
const currentChapter = ref<any>(null)
const content = ref('')
const readerTitle = ref('')
const progress = ref<any>(null)
const settings = ref({ fontSize: 24, lineSpacing: 1.8 })
const showSettings = ref(false)
const initialPage = ref(0)
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

async function call(method: string, args?: any) {
  const fn = props.remote?.[method]
  if (typeof fn !== 'function') throw new Error(`Remote 未就绪：${method}`)
  return args === undefined ? fn.call(props.remote) : fn.call(props.remote, args)
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
  if (chapter.isVolume || !chapter.url) return
  busy.value = true
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
        position: 0,
      }).catch(() => undefined)
    }
  } catch (error) {
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
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

onMounted(refresh)
</script>

<template>
  <div class="mo">
    <header class="mo-head">
      <div class="mo-brand">墨读</div>
      <div class="mo-status">{{ status || (busy ? '加载中…' : '') }}</div>
      <button class="mo-btn ghost" data-testid="refresh" @click="refresh">刷新</button>
    </header>

    <nav class="mo-nav">
      <button :class="{ on: view === 'shelf' }" data-testid="nav-shelf" @click="view = 'shelf'">书架</button>
      <button :class="{ on: view === 'sources' }" data-testid="nav-sources" @click="view = 'sources'">书源</button>
      <button :class="{ on: view === 'search' || view === 'detail' }" data-testid="nav-search" @click="view = 'search'">搜索</button>
      <span class="mo-version">v{{ version }}</span>
    </nav>

    <main class="mo-body">
      <section v-if="view === 'shelf'" class="mo-pane">
        <div v-if="shelfBooks.length === 0" class="mo-empty">
          <p>书架还是空的。</p>
          <p class="muted">先在「书源」导入书源，再在「搜索」里找书，详情页可以加入书架。</p>
        </div>
        <div v-else class="mo-shelf" data-testid="shelf">
          <button v-for="book in shelfBooks" :key="book.id" class="mo-shelf-book" data-testid="shelf-book" @click="openShelfBook(book)">
            <span class="mo-shelf-name">{{ book.name }}</span>
            <span class="muted">{{ book.author || '未知作者' }}</span>
            <span class="muted">{{ book.originName || '' }}</span>
          </button>
        </div>
      </section>

      <section v-if="view === 'sources'" class="mo-pane">
        <div class="mo-block">
          <h3>导入书源</h3>
          <p class="muted">粘贴「阅读」书源 JSON，或直接选择书源文件（.json，单个或数组）。</p>
          <textarea v-model="importText" data-testid="import-text" rows="5" placeholder='[{"bookSourceUrl":"https://…","bookSourceName":"…"}]' />
          <div class="mo-row">
            <label class="mo-file" title="选择 Legado 书源 JSON 文件">
              <input type="file" accept=".json,application/json" data-testid="import-file" @change="onImportFile" />
              <span class="mo-btn ghost">选择文件</span>
            </label>
            <button class="mo-btn" :disabled="busy || !importText.trim()" data-testid="import" @click="importSources">导入</button>
            <span class="muted">{{ importMessage }}</span>
          </div>
        </div>

        <div class="mo-block">
          <h3>书源（{{ sources.length }}）</h3>
          <div v-if="sources.length === 0" class="mo-empty">还没有书源。</div>
          <ul class="mo-sources">
            <li v-for="source in sources" :key="source.bookSourceUrl" data-testid="source-row">
              <label class="mo-switch">
                <input type="checkbox" :checked="source.enabled !== false" @change="toggleSource(source)" />
                <span>{{ source.bookSourceName || source.bookSourceUrl }}</span>
              </label>
              <span class="mo-url">{{ source.bookSourceUrl }}</span>
              <button class="mo-btn ghost" data-testid="source-edit" @click="beginEdit(source)">编辑</button>
              <button class="mo-btn ghost danger" @click="removeSource(source)">删除</button>
            </li>
          </ul>
        </div>

        <div v-if="editing" class="mo-block" data-testid="source-editor">
          <h3>编辑书源：{{ editing.bookSourceName || editing.bookSourceUrl }}</h3>
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
            <button class="mo-btn" data-testid="source-save" @click="saveEditing">保存</button>
            <button class="mo-btn ghost" @click="editing = null">收起</button>
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

      <section v-if="view === 'search'" class="mo-pane">
        <div class="mo-row">
          <input v-model="searchKey" data-testid="search-key" placeholder="书名 / 作者" @keyup.enter="search" />
          <button class="mo-btn" :disabled="searching || !searchKey.trim()" data-testid="search" @click="search">
            {{ searching ? '搜索中…' : '搜索' }}
          </button>
        </div>

        <div v-if="books.length" class="mo-results">
          <button v-for="book in books" :key="book.origin + book.bookUrl" class="mo-book" data-testid="book" @click="openBook(book)">
            <span class="mo-book-name">{{ book.name }}</span>
            <span class="muted">{{ book.author || '未知作者' }} · {{ book.originName || book.origin }}</span>
          </button>
        </div>

        <div v-if="searchErrors.length" class="mo-errors">
          <p v-for="error in searchErrors" :key="error.sourceUrl" class="muted">{{ error.sourceUrl }}：{{ error.message }}</p>
        </div>
      </section>

      <section v-if="view === 'detail' && currentBook" class="mo-pane">
        <div class="mo-row">
          <button class="mo-btn ghost" data-testid="detail-back" @click="view = searchKey ? 'search' : 'shelf'">返回</button>
          <button class="mo-btn" v-if="!currentBook.id" data-testid="add-shelf" @click="addToShelf">加入书架</button>
          <span v-else class="muted">已在书架</span>
          <span v-if="progress" class="muted">
            上次读到 {{ progress.chapterTitle || `第 ${progress.chapterIndex + 1} 章` }}
          </span>
        </div>
        <h3>{{ currentBook.name }}</h3>
        <p class="muted">{{ currentBook.author }} · {{ currentBook.kind }} · {{ chapters.length }} 章</p>
        <p v-if="currentBook.intro" class="mo-intro">{{ currentBook.intro }}</p>
        <ol class="mo-toc">
          <li v-for="chapter in chapters" :key="chapter.url || chapter.title" :class="{ volume: chapter.isVolume }">
            <button v-if="!chapter.isVolume" data-testid="chapter" @click="openChapter(chapter)">{{ chapter.title }}</button>
            <span v-else>{{ chapter.title }}</span>
          </li>
        </ol>
      </section>

      <section v-if="view === 'reader'" class="mo-pane reader">
        <div class="mo-row">
          <button class="mo-btn ghost" data-testid="reader-back" @click="view = 'detail'">返回</button>
          <button class="mo-btn ghost" :disabled="chapterIndex <= 0" @click="openAdjacent(-1)">上一章</button>
          <strong class="mo-reader-title">{{ readerTitle }}</strong>
          <button class="mo-btn ghost" @click="openAdjacent(1)">下一章</button>
          <button class="mo-btn ghost" data-testid="reader-settings" @click="showSettings = !showSettings">Aa</button>
        </div>
        <div v-if="showSettings" class="mo-settings">
          <label>
            字号
            <input v-model.number="settings.fontSize" type="range" min="14" max="32" step="1" @change="persistSettings" />
            <span>{{ settings.fontSize }}</span>
          </label>
          <label>
            行距
            <input v-model.number="settings.lineSpacing" type="range" min="1.2" max="2.6" step="0.1" @change="persistSettings" />
            <span>{{ settings.lineSpacing.toFixed(1) }}</span>
          </label>
        </div>
        <div data-testid="reader-content">
          <CanvasReader
            v-if="content"
            :text="content"
            :title="readerTitle"
            :font-size="settings.fontSize"
            :line-height="settings.lineSpacing"
            :initial-page="initialPage"
            @page="onPage"
          />
          <p v-else class="muted">（空）</p>
        </div>
      </section>
    </main>
  </div>
</template>

<style>
.mo {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 480px;
  color: var(--dsh-text-primary, #24292f);
  font: 14px/1.6 -apple-system, 'Noto Sans SC', 'PingFang SC', sans-serif;
}
.mo-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--dsh-border, #d8dee4);
}
.mo-brand {
  font: 700 18px/1 'Songti SC', 'Noto Serif SC', serif;
  letter-spacing: 0.12em;
}
.mo-status {
  flex: 1;
  color: var(--dsh-text-secondary, #57606a);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mo-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--dsh-border, #d8dee4);
}
.mo-nav button {
  border: 0;
  background: none;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--dsh-text-secondary, #57606a);
}
.mo-nav button.on {
  background: var(--dsh-fill, #eaeef2);
  color: var(--dsh-text-primary, #24292f);
  font-weight: 600;
}
.mo-version {
  margin-left: auto;
  font-size: 11px;
  color: var(--dsh-text-tertiary, #8c959f);
}
.mo-body {
  flex: 1;
  overflow: auto;
}
.mo-pane {
  padding: 16px;
  max-width: 880px;
}
.mo-block {
  margin-bottom: 20px;
}
.mo-block h3,
.mo-pane > h3 {
  margin: 8px 0;
  font-size: 16px;
}
.mo-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
.mo-row input {
  flex: 1;
}
input,
textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--dsh-border, #d0d7de);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
}
textarea {
  resize: vertical;
}
.mo-btn {
  padding: 7px 14px;
  border: 1px solid var(--dsh-border, #d0d7de);
  border-radius: 6px;
  background: var(--dsh-fill, #f6f8fa);
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.mo-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.mo-btn.ghost {
  background: transparent;
  border-color: transparent;
}
.mo-btn.danger {
  color: #b42318;
}
.mo-shelf {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}
.mo-shelf-book {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 12px;
  border: 1px solid var(--dsh-border, #d8dee4);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.mo-shelf-name {
  font-weight: 600;
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
  padding: 8px 0;
  border-bottom: 1px solid var(--dsh-border-subtle, #eaeef2);
}
.mo-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 150px;
}
.mo-switch input {
  width: auto;
}
.mo-url {
  flex: 1;
  font-size: 12px;
  color: var(--dsh-text-tertiary, #8c959f);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mo-empty {
  padding: 24px 0;
  color: var(--dsh-text-secondary, #57606a);
}
.mo-results {
  display: flex;
  flex-direction: column;
}
.mo-book {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 0;
  border: 0;
  border-bottom: 1px solid var(--dsh-border-subtle, #eaeef2);
  background: none;
  cursor: pointer;
  text-align: left;
  color: inherit;
}
.mo-book-name {
  font-weight: 600;
}
.muted {
  color: var(--dsh-text-secondary, #57606a);
  font-size: 12px;
}
.mo-intro {
  color: var(--dsh-text-secondary, #57606a);
  white-space: pre-wrap;
}
.mo-toc {
  margin: 12px 0 0;
  padding-left: 20px;
  columns: 2 220px;
}
.mo-toc li {
  padding: 3px 0;
}
.mo-toc li.volume {
  font-weight: 600;
  list-style: none;
  margin-left: -20px;
  margin-top: 8px;
}
.mo-toc button {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.mo-reader-title {
  flex: 1;
  text-align: center;
}
.mo-json {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
}
.mo-debug {
  margin-top: 12px;
}
.mo-settings {
  display: flex;
  gap: 24px;
  padding: 8px 0;
  font-size: 12px;
  color: var(--dsh-text-secondary, #57606a);
}
.mo-settings label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mo-settings input[type='range'] {
  width: 120px;
}
.mo-debug-out {
  max-height: 320px;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--dsh-border, #d8dee4);
  border-radius: 6px;
  font-size: 11px;
  white-space: pre-wrap;
}
select {
  padding: 7px 9px;
  border: 1px solid var(--dsh-border, #d0d7de);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
}
.mo-content {
  white-space: pre-wrap;
  font-size: 16px;
  line-height: 1.9;
  max-width: 720px;
}
.reader {
  max-width: 800px;
}

.mo-file {
  display: inline-flex;
  cursor: pointer;
}
.mo-file input {
  display: none;
}
</style>
