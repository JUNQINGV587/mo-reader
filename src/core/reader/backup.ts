/**
 * 备份格式（#130 只实现导出，导入 #132 复用这里的常量与校验/合并扩展点）。
 *
 * 备份是单个 zip：根目录 manifest.json，其余文件与「阅读」备份同名；
 * 封面放 covers/<bookId>.<ext>。不含章节正文、媒体缓存与字体。
 * 本模块只放纯函数，服务端构建 zip 与 Web 端展示都从这里取约定。
 */

/** 备份格式标识，写进 manifest，导入时据此拒绝别的文件。 */
export const BACKUP_FORMAT = 'mo-reader-backup'
/** 当前格式版本；只增不改，导入按版本做兼容。 */
export const BACKUP_VERSION = 1
/** 下载文件名的日期前缀。 */
export const BACKUP_FILE_PREFIX = 'mo-reader-backup'
/** 封面单张上限：与导出 EPUB 的封面限制一致。 */
export const BACKUP_MAX_COVER_BYTES = 2 * 1024 * 1024
/** 封面总量上限；超过后剩余封面一律跳过，备份照常完成。 */
export const BACKUP_MAX_COVERS_TOTAL_BYTES = 200 * 1024 * 1024
/** 一次性下载链接有效期：10 分钟。 */
export const BACKUP_TOKEN_TTL_MS = 10 * 60 * 1000
/** zip 里的清单文件名。 */
export const BACKUP_MANIFEST_FILE = 'manifest.json'
/** 封面目录名。 */
export const BACKUP_COVERS_DIR = 'covers'

/** 备份里的数据文件；顺序即打包与 manifest 里的文件顺序。 */
export const FULL_BACKUP_SECTIONS = [
  'bookshelf',
  'bookSource',
  'bookGroup',
  'bookmark',
  'note',
  'readRecord',
  'readConfig',
  'settings',
  'themeConfig',
  'replaceRule',
  'dictRule',
  'rssSource',
  'subscription',
] as const

export type BackupSection = (typeof FULL_BACKUP_SECTIONS)[number]

/** 「只导书目与进度」的轻量备份：只含这两类数据，封面与设置都不打包。 */
export const LIGHT_BACKUP_SECTIONS = ['bookshelf', 'readRecord'] as const

/** 数据文件在 zip 根目录的名字，与「阅读」备份保持同名，便于互导。 */
export const BACKUP_SECTION_FILES: Record<BackupSection, string> = {
  bookshelf: 'bookshelf.json',
  bookSource: 'bookSource.json',
  bookGroup: 'bookGroup.json',
  bookmark: 'bookmark.json',
  note: 'note.json',
  readRecord: 'readRecord.json',
  readConfig: 'readConfig.json',
  settings: 'settings.json',
  themeConfig: 'themeConfig.json',
  replaceRule: 'replaceRule.json',
  dictRule: 'dictRule.json',
  rssSource: 'rssSource.json',
  subscription: 'subscription.json',
}

export type BackupSectionCounts = Partial<Record<BackupSection, number>>

export interface BackupCoverSummary {
  /** 实际写入 zip 的封面张数。 */
  total: number
  /** 实际写入 zip 的封面总字节数。 */
  bytes: number
  /** 因超过单张/总量上限、取不到或格式不支持而跳过的封面张数。 */
  skipped: number
  /** 单张上限，写进 manifest 让导入端复用同一套阈值。 */
  maxBytes: number
  /** 总量上限。 */
  maxTotalBytes: number
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  version: number
  /** ISO 时间；文件名里的日期按本地时区生成。 */
  exportedAt: string
  app: { name: string; version: string }
  /** true 表示轻量备份，只有书目与进度。 */
  light: boolean
  /** 每类数据条数；轻量备份只列实际导出的两类。 */
  counts: BackupSectionCounts
  covers: BackupCoverSummary
  /** zip 里的文件名（含 manifest 与封面），导入端可据此判断缺了哪些文件。 */
  files: string[]
}

export interface BackupManifestInput {
  exportedAt?: string
  appVersion: string
  light: boolean
  counts: BackupSectionCounts
  covers?: Partial<BackupCoverSummary>
  files: string[]
}

export type BackupManifestParseResult =
  | { ok: true; manifest: BackupManifest }
  | { ok: false; error: string }

/** 按本地时区生成带日期的下载名；服务端落盘用 jobId.zip，展示名用它。 */
export function backupFileName(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${BACKUP_FILE_PREFIX}-${year}-${month}-${day}.zip`
}

/** 某次备份包含哪些数据文件；轻量备份只含书目与进度。 */
export function backupSectionsFor(light: boolean): readonly BackupSection[] {
  return light ? LIGHT_BACKUP_SECTIONS : FULL_BACKUP_SECTIONS
}

/** 轻量备份里没有的文件，界面与测试都按它判断。 */
export function backupSectionIncluded(light: boolean, section: BackupSection): boolean {
  return backupSectionsFor(light).includes(section)
}

/** 生成 manifest；计数缺省按 0 处理，避免导入端因为少一个键就判坏。 */
export function buildBackupManifest(input: BackupManifestInput): BackupManifest {
  const counts: BackupSectionCounts = {}
  for (const section of backupSectionsFor(input.light)) {
    counts[section] = Math.max(0, Math.trunc(Number(input.counts[section] ?? 0)))
  }
  const covers = input.covers ?? {}
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    app: { name: '墨读', version: input.appVersion },
    light: input.light,
    counts,
    covers: {
      total: Math.max(0, Math.trunc(Number(covers.total ?? 0))),
      bytes: Math.max(0, Math.trunc(Number(covers.bytes ?? 0))),
      skipped: Math.max(0, Math.trunc(Number(covers.skipped ?? 0))),
      maxBytes: Number(covers.maxBytes ?? BACKUP_MAX_COVER_BYTES),
      maxTotalBytes: Number(covers.maxTotalBytes ?? BACKUP_MAX_COVERS_TOTAL_BYTES),
    },
    files: input.files.filter((name) => typeof name === 'string' && name.length > 0),
  }
}

/** 可读 JSON：两空格缩进并以换行收尾，解压后用编辑器看不会挤成一行。 */
export function serializeBackupJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** 图片类型到备份里的扩展名；不认识的类型返回空串（跳过该封面）。 */
export function backupCoverExtension(mediaType: string): 'jpg' | 'png' | 'webp' | '' {
  const normalized = String(mediaType ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase()
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg'
  if (normalized === 'image/png') return 'png'
  if (normalized === 'image/webp') return 'webp'
  return ''
}

/**
 * 封面在 zip 里的路径：covers/<bookId>.<ext>。
 * bookId 只允许单段安全字符，文件名不能穿出 covers/ 目录。
 */
export function backupCoverEntry(bookId: string, extension: string): string {
  const id = String(bookId ?? '').trim()
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(id)) return ''
  const ext = String(extension ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
  if (ext === 'jpeg') return `${BACKUP_COVERS_DIR}/${id}.jpg`
  if (ext === 'jpg' || ext === 'png' || ext === 'webp') return `${BACKUP_COVERS_DIR}/${id}.${ext}`
  return ''
}

/** 单张与总量阈值判断；调用方据此决定跳过封面而不是让备份失败。 */
export function coverBudgetAllows(
  usedBytes: number,
  nextBytes: number,
  maxTotalBytes: number = BACKUP_MAX_COVERS_TOTAL_BYTES,
): boolean {
  const used = Math.max(0, Number(usedBytes) || 0)
  const next = Math.max(0, Number(nextBytes) || 0)
  const max = Math.max(0, Number(maxTotalBytes) || 0)
  if (next > BACKUP_MAX_COVER_BYTES) return false
  return used + next <= max
}

/**
 * 校验 manifest；导入 #132 在解压后先调它。
 * 只接受当前或更旧的版本，避免把新格式当旧格式读坏。
 */
export function parseBackupManifest(input: unknown): BackupManifestParseResult {
  let value: unknown = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { ok: false, error: 'manifest.json 不是合法的 JSON' }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'manifest.json 内容不是对象' }
  }
  const record = value as Record<string, unknown>
  if (record.format !== BACKUP_FORMAT) return { ok: false, error: '不是墨读备份文件' }
  const version = Number(record.version)
  if (!Number.isInteger(version) || version < 1) return { ok: false, error: '备份格式版本无效' }
  if (version > BACKUP_VERSION) return { ok: false, error: '备份来自更新版本的墨读，请先升级' }
  if (typeof record.exportedAt !== 'string' || !record.exportedAt) {
    return { ok: false, error: '备份缺少导出时间' }
  }
  if (!record.counts || typeof record.counts !== 'object' || Array.isArray(record.counts)) {
    return { ok: false, error: '备份缺少数据计数' }
  }
  return { ok: true, manifest: record as unknown as BackupManifest }
}

/**
 * 导入合并扩展点：按 key 去重，后到的记录覆盖先到的，未知字段随对象原样保留。
 * #132 决定按书/按条目的合并策略后直接复用它。
 */
export function mergeBackupRecords<T extends Record<string, unknown>>(
  existing: readonly T[],
  incoming: readonly T[],
  keyOf: (record: T) => string,
): T[] {
  const merged = new Map<string, T>()
  for (const record of existing) merged.set(keyOf(record), { ...record })
  for (const record of incoming) {
    const key = keyOf(record)
    merged.set(key, { ...(merged.get(key) ?? {}), ...record })
  }
  return [...merged.values()]
}
