import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

export interface CustomFont {
  id: string
  name: string
  fileName: string
  format: string
  size: number
  createdAt: string
}

const MAX_FONT_BYTES = 20 * 1024 * 1024
const MANIFEST = 'fonts.json'
const FONT_FORMATS: Record<string, string> = {
  '.ttf': 'truetype',
  '.otf': 'opentype',
  '.woff': 'woff',
  '.woff2': 'woff2',
}

export function fontRoot(): string {
  return process.env.MO_READER_FONT_ROOT || join(homedir(), '.dsh', 'reader', 'fonts')
}

function manifestPath(): string {
  return join(fontRoot(), MANIFEST)
}

function safeId(id: string): boolean {
  return /^font-[a-f0-9]{24}$/.test(id)
}

function fontFile(id: string, format: string): string {
  const ext = Object.keys(FONT_FORMATS).find((key) => FONT_FORMATS[key] === format) ?? '.ttf'
  return join(fontRoot(), `${id}${ext}`)
}

function signatureOf(buffer: Uint8Array): string {
  if (buffer.length < 4) return ''
  const head = Buffer.from(buffer.subarray(0, 4)).toString('latin1')
  if (head === 'wOFF') return 'woff'
  if (head === 'wOF2') return 'woff2'
  if (head === 'OTTO') return 'opentype'
  if (head === 'true' || head === 'typ1') return 'truetype'
  if (buffer[0] === 0 && buffer[1] === 1 && buffer[2] === 0 && buffer[3] === 0) return 'truetype'
  if (head === 'ttcf') return 'truetype'
  return ''
}

async function readManifest(): Promise<CustomFont[]> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is CustomFont =>
        Boolean(item) &&
        typeof item.id === 'string' &&
        safeId(item.id) &&
        typeof item.name === 'string' &&
        typeof item.fileName === 'string' &&
        typeof item.format === 'string' &&
        typeof item.size === 'number' &&
        typeof item.createdAt === 'string',
    )
  } catch {
    return []
  }
}

async function writeManifest(fonts: CustomFont[]): Promise<void> {
  await mkdir(fontRoot(), { recursive: true })
  const target = manifestPath()
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, JSON.stringify(fonts, null, 2), 'utf8')
  await rename(temp, target)
}

export async function listCustomFonts(): Promise<CustomFont[]> {
  const fonts = await readManifest()
  return [...fonts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function saveCustomFont(
  fileName: string,
  buffer: Uint8Array,
): Promise<{ font: CustomFont; created: boolean }> {
  const ext = extname(fileName).toLowerCase()
  const format = FONT_FORMATS[ext]
  if (!format) throw new Error('字体格式不支持（支持 TTF、OTF、WOFF、WOFF2）')
  if (buffer.length === 0) throw new Error('字体文件为空')
  if (buffer.length > MAX_FONT_BYTES) throw new Error('字体文件不能超过 20MB')
  if (signatureOf(buffer) !== format) throw new Error('文件内容不是有效的字体文件')

  const id = `font-${createHash('sha1').update(Buffer.from(buffer)).digest('hex').slice(0, 24)}`
  const fonts = await readManifest()
  const existed = fonts.find((font) => font.id === id)
  if (existed) return { font: existed, created: false }

  const rawName = basename(fileName, ext).trim().replace(/[\u0000-\u001f]/g, '')
  const font: CustomFont = {
    id,
    name: (rawName || '自定义字体').slice(0, 60),
    fileName: basename(fileName).slice(0, 120),
    format,
    size: buffer.length,
    createdAt: new Date().toISOString(),
  }
  await mkdir(fontRoot(), { recursive: true })
  await writeFile(fontFile(id, format), buffer)
  await writeManifest([font, ...fonts])
  return { font, created: true }
}

export async function readCustomFont(
  id: string,
): Promise<{ font: CustomFont; data: Buffer; mime: string }> {
  if (!safeId(id)) throw new Error('字体不存在')
  const font = (await readManifest()).find((item) => item.id === id)
  if (!font) throw new Error('字体不存在')
  try {
    const data = await readFile(fontFile(id, font.format))
    const mime = font.format === 'woff2' ? 'font/woff2' : font.format === 'woff' ? 'font/woff' : font.format === 'opentype' ? 'font/otf' : 'font/ttf'
    return { font, data, mime }
  } catch {
    throw new Error('字体文件不存在，已回退默认字体')
  }
}

export async function removeCustomFont(id: string): Promise<{ deleted: boolean }> {
  if (!safeId(id)) return { deleted: false }
  const fonts = await readManifest()
  const font = fonts.find((item) => item.id === id)
  if (!font) return { deleted: false }
  await rm(fontFile(id, font.format), { force: true })
  await writeManifest(fonts.filter((item) => item.id !== id))
  return { deleted: true }
}
