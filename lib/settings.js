import { ReaderError } from './errors.js'
import { normalizeReplacements } from './replacements.js'
import { requiredString } from './utils.js'

export const DEFAULT_SETTINGS = Object.freeze({
  replacements: [],
  autoDownloadNewChapters: true,
  fontSize: 18,
  lineHeight: 1.8,
  fontFamily: 'system',
  readerTheme: 'paper',
  ttsRate: 1,
})

function numberSetting(value, name, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ReaderError('reader/invalid-settings', `${name} 必须是 ${minimum}–${maximum} 之间的数字。`)
  }
  return value
}

export function normalizeSettings(partial = {}, current = DEFAULT_SETTINGS) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new ReaderError('reader/invalid-settings', 'settings 必须是对象。')
  const value = (key, fallback) => partial[key] === undefined ? (current[key] === undefined ? fallback : current[key]) : partial[key]
  return {
    replacements: normalizeReplacements(value('replacements', [])),
    autoDownloadNewChapters: value('autoDownloadNewChapters', true),
    fontSize: numberSetting(value('fontSize', 18), 'fontSize', 12, 48),
    lineHeight: numberSetting(value('lineHeight', 1.8), 'lineHeight', 1, 3),
    fontFamily: requiredString(value('fontFamily', 'system'), 'fontFamily', 100),
    readerTheme: requiredString(value('readerTheme', 'paper'), 'readerTheme', 50),
    ttsRate: numberSetting(value('ttsRate', 1), 'ttsRate', 0.5, 4),
  }
}

export function assertSettingKeys(partial) {
  const allowed = new Set(Object.keys(DEFAULT_SETTINGS))
  if (Object.keys(partial).some(key => !allowed.has(key))) {
    throw new ReaderError('reader/invalid-settings', `仅支持 ${[...allowed].join('、')}。`)
  }
  if (typeof partial.autoDownloadNewChapters === 'boolean' === false && partial.autoDownloadNewChapters !== undefined) {
    throw new ReaderError('reader/invalid-settings', 'autoDownloadNewChapters must be boolean.')
  }
}
