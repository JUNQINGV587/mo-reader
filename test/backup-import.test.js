import assert from 'node:assert/strict'
import test from 'node:test'
import { crc32, deflateRawSync } from 'node:zlib'

const {
  BACKUP_MANIFEST_FILE,
  BACKUP_COVERS_DIR,
  buildBackupManifest,
  serializeBackupJson,
} = await import('../dist/core/reader/backup.js')
const {
  IMPORT_MAX_ENTRY_BYTES,
  IMPORT_MAX_TOTAL_BYTES,
  IMPORT_MAX_ENTRIES,
  parseBackupImport,
  mergeBackupImport,
  assertImportArchiveSize,
  backupImportSettingLabel,
} = await import('../dist/core/reader/backup-import.js')

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function crcOf(buffer) {
  return typeof crc32 === 'function' ? crc32(buffer) : 0
}

/** 手写 zip：可以自定义条目名、声明大小、加密位与外部属性，用来造恶意样本。 */
function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data ?? '', 'utf8')
    const method = file.method ?? 0
    const stored = method === 8 ? deflateRawSync(data) : data
    const flags = file.flags ?? 0x0800
    const declared = file.declaredSize ?? data.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crcOf(data), 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(declared, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const localBlock = Buffer.concat([local, name, stored])

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crcOf(data), 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(declared, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(file.attrs ?? 0, 38)
    central.writeUInt32LE(offset, 42)
    const centralBlock = Buffer.concat([central, name])

    locals.push(localBlock)
    centrals.push(centralBlock)
    offset += localBlock.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, directory, eocd])
}

const BOOK = {
  id: 'book-1',
  name: '三体',
  author: '刘慈欣',
  bookUrl: 'https://books.example.com/3body',
  origin: 'https://books.example.com',
  originName: '示例书城',
  type: 0,
  group: '科幻',
  coverUrl: 'https://img.example.com/3body.jpg',
  intro: '地球往事',
  totalChapterNum: 30,
  wordCount: '200000',
  rating: '9.0',
  pinned: false,
  latestChapterTitle: '第三十章',
  lastReadAt: 1700000000000,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-02-01T00:00:00.000Z',
}

const SOURCE = {
  bookSourceUrl: 'https://source.example.com',
  bookSourceName: '示例源',
  bookSourceType: 0,
  bookSourceGroup: '小说',
  enabled: true,
}

const GROUP = { id: 'g1', name: '科幻', sort: 1 }

const BOOKMARK = {
  id: 'bm1',
  bookId: 'book-1',
  type: 'bookmark',
  chapterIndex: 2,
  chapterTitle: '第二章',
  chapterUrl: 'https://books.example.com/3body/2',
  page: 3,
  text: '摘录',
  note: '想法',
  createdAt: '2025-03-01T00:00:00.000Z',
}

const NOTE = {
  id: 'n1',
  bookId: 'book-1',
  type: 'note',
  chapterIndex: 2,
  chapterTitle: '第二章',
  chapterUrl: 'https://books.example.com/3body/2',
  page: 3,
  quote: '引用',
  content: '笔记内容',
  createdAt: '2025-03-02T00:00:00.000Z',
}

const PROGRESS = {
  id: 'r1',
  bookId: 'book-1',
  chapterIndex: 5,
  chapterTitle: '第五章',
  chapterUrl: 'https://books.example.com/3body/5',
  position: 42,
  updatedAt: '2025-04-01T00:00:00.000Z',
}

const SETTINGS = {
  fontSize: 28,
  lineSpacing: 1.8,
  theme: 'sepia',
  customThemes: [
    { id: 't1', name: '护眼', bg: '#f1ead8', text: '#333333', muted: '#777777', line: '#dddddd', createdAt: '2025-01-01T00:00:00.000Z' },
    { id: 't2', name: '夜间', bg: '#111111', text: '#eeeeee', muted: '#888888', line: '#444444', createdAt: '2025-01-02T00:00:00.000Z' },
  ],
  replaceRules: [{ id: 'rp1', name: '去广告', pattern: '广告', replacement: '' }],
  webdavUrl: 'https://dav.example.com/reader',
  webdavUsername: 'me',
  webdavPassword: 'secret',
}

const SECTIONS = {
  bookshelf: [BOOK],
  bookSource: [SOURCE],
  bookGroup: [GROUP],
  bookmark: [BOOKMARK],
  note: [NOTE],
  readRecord: [PROGRESS],
  readConfig: [],
  settings: [SETTINGS],
  themeConfig: [SETTINGS],
  replaceRule: [SETTINGS.replaceRules[0]],
  dictRule: [{ id: 'd1', name: '词典', rules: [] }],
  rssSource: [{ id: 'rss1', name: '示例 RSS', sourceUrl: 'https://rss.example.com/feed' }],
  subscription: [{ id: 'sub1', name: '订阅', url: 'https://sub.example.com/a' }],
}

function moReaderZip(overrides = {}) {
  const light = overrides.light ?? false
  const sections = { ...SECTIONS, ...(overrides.sections ?? {}) }
  const sectionNames = overrides.sectionNames ?? Object.keys(sections)
  const files = []
  const counts = {}
  const manifestFiles = []
  for (const section of sectionNames) {
    const file = section + '.json'
    const data = sections[section]
    if (data === undefined) continue
    counts[section] = Array.isArray(data) ? data.length : 1
    if (overrides.skipManifestFiles?.includes(section)) continue
    files.push({ name: file, data: serializeBackupJson(data), method: overrides.store ? 0 : 8 })
    manifestFiles.push(file)
  }
  const manifest = buildBackupManifest({
    exportedAt: '2026-01-02T03:04:05.000Z',
    appVersion: '0.0.0-test',
    light,
    counts,
    files: [...manifestFiles],
  })
  if (overrides.covers !== false) {
    const entry = BACKUP_COVERS_DIR + '/book-1.png'
    files.push({ name: entry, data: PNG, method: 0 })
    manifest.files.push(entry)
    manifest.covers = { total: 1, bytes: PNG.length, skipped: 0, maxBytes: 2097152, maxTotalBytes: 209715200 }
  }
  const all = [{ name: BACKUP_MANIFEST_FILE, data: serializeBackupJson(manifest), method: 0 }, ...files]
  return makeZip(overrides.extraEntries ? [...all, ...overrides.extraEntries] : all)
}

function emptyExisting(settings = {}) {
  return {
    books: [],
    sources: [],
    groups: [],
    bookmarks: [],
    notes: [],
    progress: [],
    readConfigs: [],
    dictRules: [],
    subscriptions: [],
    settings,
  }
}

function mergeOf(zip, existing = emptyExisting()) {
  const backup = parseBackupImport({ data: zip, fileName: 'backup.zip' })
  return mergeBackupImport({ backup, existing })
}

function applyPlan(existing, plan) {
  const tables = {
    books: existing.books,
    sources: existing.sources,
    groups: existing.groups,
    bookmarks: existing.bookmarks,
    notes: existing.notes,
    readRecords: existing.progress,
    readConfigs: existing.readConfigs,
    dictRules: existing.dictRules,
    subscriptions: existing.subscriptions,
  }
  for (const op of plan.operations) {
    const list = tables[op.table]
    const index = list.findIndex((record) => record.id === op.key || record.bookId === op.key)
    if (index >= 0) list[index] = op.record
    else list.push(op.record)
  }
  return { ...existing, settings: plan.settings ?? existing.settings }
}

test('墨读备份 zip：读取清单声明的数据文件与封面', () => {
  const backup = parseBackupImport({ data: moReaderZip(), fileName: 'mo-reader-backup.zip' })
  assert.equal(backup.kind, 'mo-reader-backup')
  assert.equal(backup.version, 1)
  assert.equal(backup.exportedAt, '2026-01-02T03:04:05.000Z')
  assert.equal(backup.appName, '墨读')
  assert.equal(backup.books.length, 1)
  assert.equal(backup.books[0].name, '三体')
  assert.equal(backup.sources[0].bookSourceUrl, 'https://source.example.com')
  assert.equal(backup.bookmarks[0].bookId, 'book-1')
  assert.equal(backup.notes[0].content, '笔记内容')
  assert.equal(backup.progress[0].chapterIndex, 5)
  assert.equal(backup.themes.customThemes.length, 2)
  assert.equal(backup.replaceRules.length, 1)
  assert.equal(backup.dictRules.length, 1)
  assert.equal(backup.subscriptions.length, 2)
  assert.match(backup.covers['book-1'], /^data:image\/png;base64,/)
})

test('只解压清单声明的文件：不在清单里的数据文件被忽略', () => {
  const zip = moReaderZip({ skipManifestFiles: ['note'] })
  const backup = parseBackupImport({ data: zip, fileName: 'backup.zip' })
  assert.equal(backup.notes.length, 0)
})

test('清单声明了缺失的文件时明确报错', () => {
  const zip = moReaderZip({ sectionNames: ['bookshelf'] })
  const backup = parseBackupImport({ data: zip, fileName: 'backup.zip' })
  assert.equal(backup.books.length, 1)
  // 手工把清单改成声明了 note.json，但 zip 里没有这个文件。
  const entries = []
  const broken = moReaderZip({ sectionNames: ['bookshelf'] })
  assert.ok(broken.length > 0)
  const manifest = serializeBackupJson({
    ...buildBackupManifest({ appVersion: 'test', light: false, counts: { bookshelf: 1 }, files: ['bookshelf.json', 'note.json'] }),
  })
  entries.push({ name: BACKUP_MANIFEST_FILE, data: manifest })
  entries.push({ name: 'bookshelf.json', data: serializeBackupJson([BOOK]) })
  assert.throws(() => parseBackupImport({ data: makeZip(entries), fileName: 'backup.zip' }), /缺少 note\.json/)
  assert.equal(backup.kind, 'mo-reader-backup')
})

test('更高版本的墨读备份被拒绝并说明原因', () => {
  const manifest = serializeBackupJson({
    format: 'mo-reader-backup',
    version: 2,
    exportedAt: '2026-01-01T00:00:00.000Z',
    app: { name: '墨读', version: '9' },
    counts: {},
    files: [],
  })
  const zip = makeZip([
    { name: BACKUP_MANIFEST_FILE, data: manifest },
    { name: 'bookshelf.json', data: '[]' },
  ])
  assert.throws(() => parseBackupImport({ data: zip, fileName: 'new.zip' }), /更新版本/)
})

test('加密 zip 被明确拒绝', () => {
  const zip = moReaderZip({ extraEntries: [{ name: 'covers/book-2.png', data: PNG, flags: 1 }] })
  assert.throws(() => parseBackupImport({ data: zip, fileName: 'secret.zip' }), /加密/)
})

test('zip 路径穿越、绝对路径、盘符与符号链接都被拒绝', () => {
  assert.throws(
    () => parseBackupImport({ data: moReaderZip({ extraEntries: [{ name: '../evil.txt', data: 'x' }] }), fileName: 'a.zip' }),
    /越权|\.\./,
  )
  assert.throws(
    () => parseBackupImport({ data: moReaderZip({ extraEntries: [{ name: '/etc/passwd', data: 'x' }] }), fileName: 'a.zip' }),
    /绝对路径/,
  )
  assert.throws(
    () => parseBackupImport({ data: moReaderZip({ extraEntries: [{ name: 'C:/Windows/win.ini', data: 'x' }] }), fileName: 'a.zip' }),
    /盘符/,
  )
  assert.throws(
    () =>
      parseBackupImport({
        data: moReaderZip({ extraEntries: [{ name: 'covers/link.png', data: 'x', attrs: (0o120777 << 16) >>> 0 }] }),
        fileName: 'a.zip',
      }),
    /符号链接/,
  )
})

test('条目数、单条目大小与解压总量超限都被拒绝', () => {
  const many = []
  for (let index = 0; index < IMPORT_MAX_ENTRIES + 1; index += 1) {
    many.push({ name: 'covers/bulk-' + index + '.png', data: '' })
  }
  assert.throws(() => parseBackupImport({ data: makeZip(many), fileName: 'big.zip' }), /条目/)

  assert.throws(
    () =>
      parseBackupImport({
        data: makeZip([{ name: 'bookshelf.json', data: '[]', declaredSize: IMPORT_MAX_ENTRY_BYTES + 1 }]),
        fileName: 'big.zip',
      }),
    /单条目|64/,
  )

  const total = []
  for (let index = 0; index < 9; index += 1) {
    total.push({ name: 'covers/big-' + index + '.png', data: '', declaredSize: 60 * 1024 * 1024 })
  }
  assert.throws(() => parseBackupImport({ data: makeZip(total), fileName: 'big.zip' }), /512|解压总量/)
})

test('坏 zip 与非备份文件给出可读错误', () => {
  const zip = moReaderZip()
  assert.throws(() => parseBackupImport({ data: zip.subarray(0, zip.length - 30), fileName: 'bad.zip' }), /损坏|不完整|无法/)
  assert.throws(() => parseBackupImport({ data: Buffer.from('hello world'), fileName: 'x.txt' }), /无法识别|不是备份/)
  assert.throws(() => parseBackupImport({ data: Buffer.from('{'), fileName: 'x.json' }), /无法识别|不是备份|JSON/)
  assert.throws(() => assertImportArchiveSize(IMPORT_MAX_TOTAL_BYTES + 1), /过大|512/)
})

test('阅读（Legado）未加密 zip：尽力解析书目、书源、书签、笔记与进度', () => {
  const legadoBook = {
    name: '诡秘之主',
    author: '爱潜水的乌贼',
    bookUrl: 'https://legado.example.com/book/1',
    origin: 'https://legado.example.com',
    originName: '阅读源',
    type: 0,
    group: '玄幻',
    coverUrl: 'https://img.example.com/gm.jpg',
    intro: '',
    totalChapterNum: 100,
    latestChapterTitle: '第一百章',
    durChapterIndex: 12,
    durChapterTitle: '第十二章',
    durChapterPos: 88,
    durChapterTime: 1710000000000,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  }
  const zip = makeZip([
    { name: 'bookshelf.json', data: serializeBackupJson([legadoBook]), method: 8 },
    { name: 'bookSource.json', data: serializeBackupJson([SOURCE]), method: 8 },
    {
      name: 'bookmark.json',
      data: serializeBackupJson([
        {
          bookName: '诡秘之主',
          bookAuthor: '爱潜水的乌贼',
          chapterIndex: 3,
          chapterName: '第三章',
          chapterPos: 6,
          bookText: '原文',
          content: '批注',
          createdAt: 1710000000000,
        },
      ]),
      method: 8,
    },
    {
      name: 'note.json',
      data: serializeBackupJson([
        {
          bookName: '诡秘之主',
          bookAuthor: '爱潜水的乌贼',
          chapterIndex: 3,
          chapterName: '第三章',
          chapterPos: 6,
          bookText: '引用原文',
          content: '笔记正文',
          createdAt: 1710000000000,
        },
      ]),
      method: 8,
    },
    { name: 'readConfig.json', data: '[]', method: 8 },
  ])
  const backup = parseBackupImport({ data: zip, fileName: 'legado.zip' })
  assert.equal(backup.kind, 'legado-backup')
  assert.equal(backup.books.length, 1)
  assert.equal(backup.books[0].name, '诡秘之主')
  assert.equal(backup.progress[0].chapterIndex, 12)
  assert.equal(backup.progress[0].position, 88)
  assert.equal(backup.sources.length, 1)
  assert.equal(backup.bookmarks.length, 1)
  assert.equal(backup.bookmarks[0].page, 6)
  assert.equal(backup.notes.length, 1)
  assert.equal(backup.notes[0].content, '笔记正文')
})

test('旧书架 JSON：墨读全量书架与阅读 books.json 都能导入，更高版本被拒绝', () => {
  const shelf = {
    format: 'mo-reader-books',
    version: 1,
    exportedAt: '2025-01-01T00:00:00.000Z',
    books: [
      {
        ...BOOK,
        progress: { chapterIndex: 4, chapterTitle: '第四章', chapterUrl: 'u4', position: 10, updatedAt: '2025-01-02T00:00:00.000Z' },
      },
    ],
  }
  const backup = parseBackupImport({ data: Buffer.from(JSON.stringify(shelf)), fileName: 'shelf.json' })
  assert.equal(backup.kind, 'shelf-json')
  assert.equal(backup.books.length, 1)
  assert.equal(backup.progress[0].chapterIndex, 4)

  const legadoArray = [{ name: '三体', author: '刘慈欣', bookUrl: 'https://a.example.com/1', durChapterIndex: 1, durChapterPos: 2 }]
  const fromArray = parseBackupImport({ data: Buffer.from(JSON.stringify(legadoArray)), fileName: 'books.json' })
  assert.equal(fromArray.kind, 'shelf-json')
  assert.equal(fromArray.books.length, 1)

  const higher = { format: 'mo-reader-books', version: 2, books: [BOOK] }
  assert.throws(() => parseBackupImport({ data: Buffer.from(JSON.stringify(higher)), fileName: 'shelf.json' }), /版本/)
})

test('合并：空库导入生成新增计划、补设置、应用封面', () => {
  const plan = mergeOf(moReaderZip())
  assert.equal(plan.preview.books.total, 1)
  assert.equal(plan.preview.books.added, 1)
  assert.equal(plan.preview.books.updated, 0)
  assert.equal(plan.preview.sources.added, 1)
  assert.equal(plan.preview.bookmarks.added, 1)
  assert.equal(plan.preview.notes.added, 1)
  assert.equal(plan.preview.progress.added, 1)
  assert.ok(plan.preview.settings.added.includes('fontSize'))
  assert.ok(plan.preview.settings.added.includes('lineSpacing'))
  assert.ok(!plan.preview.settings.added.includes('webdavPassword'))
  assert.equal(plan.settings.webdavPassword, undefined)
  assert.equal(plan.settings.fontSize, 28)
  assert.equal(plan.settings.lineSpacing, 1.8)
  assert.equal(backupImportSettingLabel('fontSize'), '字号')
  const book = plan.operations.find((op) => op.table === 'books')
  assert.ok(book)
  assert.match(book.record.coverUrl, /^data:image\/png;base64,/)
  assert.equal(book.existed, false)
})

test('合并：同一本书按 bookUrl 更新，保留本机 id 与创建时间', () => {
  const existing = emptyExisting()
  existing.books.push({
    id: 'local-1',
    name: '三体',
    author: '刘慈欣',
    bookUrl: 'https://books.example.com/3body',
    origin: 'https://books.example.com',
    group: '我的',
    pinned: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  })
  const plan = mergeOf(moReaderZip(), existing)
  assert.equal(plan.preview.books.updated, 1)
  const book = plan.operations.find((op) => op.table === 'books')
  assert.equal(book.key, 'local-1')
  assert.equal(book.record.id, 'local-1')
  assert.equal(book.record.createdAt, '2024-01-01T00:00:00.000Z')
  assert.equal(book.record.group, '科幻')
  assert.equal(book.record.pinned, true)
  assert.match(book.record.coverUrl, /^data:image\/png;base64,/)
})

test('合并：没有 bookUrl 时按书名 + 作者匹配', () => {
  const existing = emptyExisting()
  existing.books.push({ id: 'local-2', name: '三体', author: '刘慈欣', bookUrl: '', createdAt: '2024-01-01T00:00:00.000Z' })
  const zip = moReaderZip({ sections: { bookshelf: [{ ...BOOK, bookUrl: '', origin: '' }] } })
  const plan = mergeOf(zip, existing)
  assert.equal(plan.preview.books.updated, 1)
  const book = plan.operations.find((op) => op.table === 'books')
  assert.equal(book.key, 'local-2')
})

test('合并：进度只取 updatedAt 较新的记录', () => {
  const newer = emptyExisting()
  newer.progress.push({ ...PROGRESS, chapterIndex: 9, updatedAt: '2025-05-01T00:00:00.000Z' })
  const skipPlan = mergeOf(moReaderZip(), newer)
  assert.equal(skipPlan.preview.progress.skipped, 1)
  assert.equal(skipPlan.preview.progress.updated, 0)
  assert.ok(!skipPlan.operations.some((op) => op.table === 'readRecords'))

  const older = emptyExisting()
  older.progress.push({ ...PROGRESS, id: 'book-1', chapterIndex: 1, updatedAt: '2025-01-01T00:00:00.000Z' })
  const updatePlan = mergeOf(moReaderZip(), older)
  assert.equal(updatePlan.preview.progress.updated, 1)
  const progress = updatePlan.operations.find((op) => op.table === 'readRecords')
  assert.equal(progress.record.chapterIndex, 5)
  assert.equal(progress.key, 'book-1')
})

test('合并：书签按 bookId + 章节 + 位置去重，笔记还要比对内容', () => {
  const existing = emptyExisting()
  existing.bookmarks.push({ ...BOOKMARK, id: 'local-bm', text: '本机摘录' })
  existing.notes.push({ ...NOTE, id: 'local-note', content: '笔记内容' })
  const plan = mergeOf(moReaderZip(), existing)
  assert.equal(plan.preview.bookmarks.skipped, 1)
  assert.equal(plan.preview.bookmarks.added, 0)
  assert.equal(plan.preview.notes.skipped, 1)
  assert.equal(plan.preview.notes.added, 0)

  const different = emptyExisting()
  different.notes.push({ ...NOTE, id: 'local-note', content: '另一条笔记' })
  const added = mergeOf(moReaderZip(), different)
  assert.equal(added.preview.notes.added, 1)
})

test('合并：自定义主题同名跳过并计数，设置只补缺、不覆盖本机值', () => {
  const existing = emptyExisting({
    fontSize: 30,
    theme: 'dark',
    customThemes: [{ id: 'local-theme', name: '护眼', bg: '#000000', text: '#ffffff', muted: '#999999', line: '#333333', createdAt: '2024-01-01T00:00:00.000Z' }],
  })
  const plan = mergeOf(moReaderZip(), existing)
  assert.equal(plan.preview.themes.added, 1)
  assert.equal(plan.preview.themes.skipped, 1)
  assert.equal(plan.settings.fontSize, 30)
  assert.equal(plan.settings.theme, 'dark')
  assert.equal(plan.settings.customThemes.length, 2)
  assert.equal(plan.settings.customThemes[1].name, '夜间')
  assert.equal(plan.preview.settings.added.includes('fontSize'), false)
  assert.ok(!plan.preview.settings.added.includes('theme'))
})

test('合并：不删本机独有数据，再次导入同一备份全部跳过', () => {
  const first = mergeOf(moReaderZip())
  const existing = emptyExisting()
  const applied = applyPlan(existing, first)
  applied.books.push({ id: 'keep-me', name: '本机独有', author: '', bookUrl: 'https://local.example.com/1' })
  applied.sources.push({ id: 'keep-source', bookSourceUrl: 'https://keep.example.com' })

  const second = mergeOf(moReaderZip(), applied)
  assert.equal(second.preview.books.added, 0)
  assert.equal(second.preview.books.updated, 0)
  assert.equal(second.preview.books.skipped, 1)
  assert.equal(second.preview.sources.skipped, 1)
  assert.equal(second.preview.bookmarks.skipped, 1)
  assert.equal(second.preview.notes.skipped, 1)
  assert.equal(second.preview.progress.skipped, 1)
  assert.equal(second.preview.themes.skipped, 2)
  assert.deepEqual(second.operations, [])
  assert.equal(second.settings, null)
  assert.ok(applied.books.some((book) => book.id === 'keep-me'))
  assert.ok(applied.sources.some((source) => source.id === 'keep-source'))
})

test('合并：书源按 bookSourceUrl 更新已有记录', () => {
  const existing = emptyExisting()
  existing.sources.push({ id: 'https://source.example.com', bookSourceUrl: 'https://source.example.com', bookSourceName: '旧名字', enabled: false })
  const plan = mergeOf(moReaderZip(), existing)
  assert.equal(plan.preview.sources.updated, 1)
  const source = plan.operations.find((op) => op.table === 'sources')
  assert.equal(source.key, 'https://source.example.com')
  assert.equal(source.record.bookSourceName, '示例源')
})
