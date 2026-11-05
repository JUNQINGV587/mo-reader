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
  mode: 'scroll',
  flipStyle: 'slide',
  animations: true,
  motionQuality: 'auto',
  ambience: 'full',
  shelfMotion: true,
  reducedMotion: 'system',
})

export const READER_MODES = Object.freeze(['paged', 'scroll'])
export const FLIP_STYLES = Object.freeze(['slide', 'curl', 'flip', 'fade'])
export const AMBIENCE_MODES = Object.freeze(['full', 'paper', 'off'])
export const READER_PREF_KEYS = Object.freeze(['mode', 'flipStyle', 'ambience'])

const MOTION_QUALITIES = Object.freeze(['auto', 'high', 'low'])
const REDUCED_MOTION_MODES = Object.freeze(['system', 'on', 'off'])

function booleanSetting(value, name) {
  if (typeof value !== 'boolean') {
    throw new ReaderError('reader/invalid-settings', `${name} 必须是 true 或 false。`)
  }
  return value
}

function enumSetting(value, name, allowed) {
  if (!allowed.includes(value)) {
    throw new ReaderError('reader/invalid-settings', `${name} 必须是 ${allowed.join('、')} 之一。`)
  }
  return value
}

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
    mode: enumSetting(value('mode', 'scroll'), 'mode', READER_MODES),
    flipStyle: enumSetting(value('flipStyle', 'slide'), 'flipStyle', FLIP_STYLES),
    animations: booleanSetting(value('animations', true), 'animations'),
    motionQuality: enumSetting(value('motionQuality', 'auto'), 'motionQuality', MOTION_QUALITIES),
    ambience: enumSetting(value('ambience', 'full'), 'ambience', AMBIENCE_MODES),
    shelfMotion: booleanSetting(value('shelfMotion', true), 'shelfMotion'),
    reducedMotion: enumSetting(value('reducedMotion', 'system'), 'reducedMotion', REDUCED_MOTION_MODES),
  }
}

// Per-book overrides are deliberately narrower than global settings: only the
// three reading-time choices can differ per book; typography stays global.
export function normalizeReaderPrefs(partial = {}) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new ReaderError('reader/invalid-settings', 'readerPrefs 必须是对象。')
  const unknown = Object.keys(partial).filter(key => !READER_PREF_KEYS.includes(key))
  if (unknown.length) throw new ReaderError('reader/invalid-settings', `readerPrefs 仅支持 ${READER_PREF_KEYS.join('、')}。`)
  const prefs = {}
  if (partial.mode !== undefined) prefs.mode = enumSetting(partial.mode, 'readerPrefs.mode', READER_MODES)
  if (partial.flipStyle !== undefined) prefs.flipStyle = enumSetting(partial.flipStyle, 'readerPrefs.flipStyle', FLIP_STYLES)
  if (partial.ambience !== undefined) prefs.ambience = enumSetting(partial.ambience, 'readerPrefs.ambience', AMBIENCE_MODES)
  return prefs
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
