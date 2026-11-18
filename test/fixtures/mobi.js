/**
 * 合成最小 MOBI6 文件，仅用于本地导入测试。
 * 结构参考 Mobipocket 的 PalmDB + PalmDOC + MOBI 头；正文不压缩。
 */

function writeAscii(view, offset, value) {
  for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    result.set(new Uint8Array(part), offset)
    offset += part.byteLength
  }
  return result.buffer
}

function buildExth(author, language, description) {
  const encoder = new TextEncoder()
  const entries = [
    [100, author],
    [524, language],
  ]
  if (description) entries.push([103, description])
  let size = 12
  for (const [, data] of entries) size += 8 + encoder.encode(data).byteLength
  const padded = Math.ceil(size / 4) * 4
  const buffer = new ArrayBuffer(padded)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'EXTH')
  view.setUint32(4, padded)
  view.setUint32(8, entries.length)
  let offset = 12
  for (const [type, data] of entries) {
    const bytes = encoder.encode(data)
    view.setUint32(offset, type)
    view.setUint32(offset + 4, 8 + bytes.byteLength)
    new Uint8Array(buffer, offset + 8, bytes.byteLength).set(bytes)
    offset += 8 + bytes.byteLength
  }
  return buffer
}

/**
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.author]
 * @param {string} [options.language]
 * @param {string} [options.description]
 * @param {string[]} [options.sections] 每章一段 HTML
 * @returns {ArrayBuffer}
 */
export function createTestMobi(options = {}) {
  const title = options.title ?? '测试 MOBI'
  const author = options.author ?? '测试作者'
  const language = options.language ?? 'zh-CN'
  const sections = options.sections ?? [
    '<html><body><h1>第一章</h1><p>第一段正文。</p></body></html>',
    '<html><body><h1>第二章</h1><p>第二段正文。</p></body></html>',
  ]
  const fullHtml = sections.join('<mbp:pagebreak/>')
  const text = new TextEncoder().encode(fullHtml)
  const recordSize = 4096
  const records = []
  for (let offset = 0; offset < text.length; offset += recordSize) {
    records.push(text.subarray(offset, Math.min(offset + recordSize, text.length)))
  }
  if (records.length === 0) records.push(new Uint8Array(0))

  const exth = buildExth(author, language, options.description ?? '')
  const titleBytes = new TextEncoder().encode(title)
  const mobiHeaderLength = 0xe8
  const exthOffset = 16 + mobiHeaderLength
  const titleOffset = exthOffset + exth.byteLength
  const record0 = new ArrayBuffer(titleOffset + titleBytes.byteLength)
  const r0 = new DataView(record0)

  r0.setUint16(0, 1)
  r0.setUint32(4, text.byteLength)
  r0.setUint16(8, records.length)
  r0.setUint16(10, recordSize)
  writeAscii(r0, 16, 'MOBI')
  r0.setUint32(20, mobiHeaderLength)
  r0.setUint32(24, 2)
  r0.setUint32(28, 65001)
  r0.setUint32(32, 12345678)
  r0.setUint32(36, 6)
  r0.setUint32(84, titleOffset)
  r0.setUint32(88, titleBytes.byteLength)
  r0.setUint8(94, 0)
  r0.setUint8(95, 9)
  r0.setUint32(108, 1 + records.length)
  r0.setUint32(112, 0xffffffff)
  r0.setUint32(116, 0)
  r0.setUint32(128, 0b100_0000)
  r0.setUint32(240, 0)
  r0.setUint32(244, 0xffffffff)
  new Uint8Array(record0).set(new Uint8Array(exth), exthOffset)
  new Uint8Array(record0).set(titleBytes, titleOffset)

  const pageCount = 1 + records.length
  const pdb = new ArrayBuffer(78)
  const pdbView = new DataView(pdb)
  writeAscii(pdbView, 0, title.slice(0, 31).padEnd(32, '\0'))
  pdbView.setUint16(76, pageCount)
  writeAscii(pdbView, 60, 'BOOK')
  writeAscii(pdbView, 64, 'MOBI')

  const table = new ArrayBuffer(pageCount * 8)
  const tableView = new DataView(table)
  let offset = 78 + pageCount * 8
  tableView.setUint32(0, offset)
  offset += record0.byteLength
  records.forEach((record, index) => {
    tableView.setUint32((index + 1) * 8, offset)
    offset += record.byteLength
  })

  return concat([pdb, table, record0, ...records])
}
