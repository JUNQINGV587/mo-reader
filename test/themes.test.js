import assert from 'node:assert/strict'
import test from 'node:test'

const {
  BUILTIN_THEMES,
  createCustomTheme,
  exportFullThemes,
  exportLegadoThemes,
  normalizeCustomThemes,
  parseThemeImport,
  resolveThemeColors,
  toHexColor,
} = await import('../dist/core/reader/theme.js')

test('内置主题保持独立，自定义主题可解析并应用', () => {
  const light = resolveThemeColors('light')
  assert.equal(light.bg, '#f6f1e7')
  const custom = createCustomTheme(
    { name: ' 我的纸色 ', bg: '#faf5e8', text: '#332f27', muted: '#7b7468', line: '#ddd3c1' },
    { id: 'theme-abc12345' },
  )
  assert.equal(custom.name, '我的纸色')
  assert.equal(custom.id, 'theme-abc12345')
  assert.deepEqual(resolveThemeColors(custom.id, [custom]), {
    bg: '#faf5e8',
    text: '#332f27',
    muted: '#7b7468',
    line: '#ddd3c1',
  })
  assert.equal(BUILTIN_THEMES.light.bg, '#f6f1e7')
})

test('颜色支持 rgba 转换、短十六进制和 Android 整数', () => {
  assert.equal(toHexColor('rgba(43,42,38,0.14)'), '#2b2a26')
  assert.equal(toHexColor('#abc'), '#aabbcc')
  assert.equal(toHexColor(0xff112233), '#112233')
  assert.throws(() => createCustomTheme({ name: '坏色', bg: 'not-a-color', text: '#fff' }), /颜色格式/)
})

test('导入 Legado themeConfig，支持整数颜色和包装对象', () => {
  const result = parseThemeImport(
    JSON.stringify({
      themeConfig: {
        themeName: '旧阅读主题',
        textColor: '#d8d4c8',
        textAccentColor: '#8f897b',
        background: 0xff141518,
        dividerColor: 0xff3a3b40,
      },
    }),
  )
  assert.equal(result.source, 'legado')
  assert.equal(result.themes.length, 1)
  assert.equal(result.themes[0].name, '旧阅读主题')
  assert.equal(result.themes[0].bg, '#141518')
  assert.equal(result.themes[0].text, '#d8d4c8')
  assert.equal(result.themes[0].line, '#3a3b40')
})

test('导入任意一项非法时整体拒绝，不返回半成品', () => {
  const valid = { themeName: '可用', textColor: '#222222', background: '#eeeeee' }
  assert.throws(
    () => parseThemeImport(JSON.stringify([valid, { themeName: '缺背景', textColor: '#222222' }])),
    /未写入任何主题.*第 2 个主题/,
  )
  assert.throws(() => parseThemeImport('不是 JSON'), /不是有效 JSON/)
  assert.throws(() => parseThemeImport(JSON.stringify([])), /没有主题/)
})

test('墨读全量导出与 Legado 兼容导出都能再次导入', () => {
  const theme = createCustomTheme({
    name: '松烟',
    bg: '#20231f',
    text: '#e3dfd3',
    muted: '#9e9a8e',
    line: '#3d423b',
  })
  const full = JSON.parse(JSON.stringify(exportFullThemes([theme])))
  const fullImported = parseThemeImport(JSON.stringify(full))
  assert.equal(fullImported.source, 'mo-reader')
  assert.equal(fullImported.themes[0].id, theme.id)
  assert.equal(fullImported.themes[0].bg, theme.bg)
  assert.equal(fullImported.themes[0].text, theme.text)

  const legado = exportLegadoThemes([theme])
  assert.equal(legado[0].themeName, '松烟')
  const legadoImported = parseThemeImport(JSON.stringify(legado))
  assert.equal(legadoImported.source, 'legado')
  assert.equal(legadoImported.themes[0].name, '松烟')
  assert.equal(legadoImported.themes[0].bg, theme.bg)
  assert.equal(legadoImported.themes[0].muted, theme.muted)
})

test('保存前规范化主题数组并拒绝重复 ID', () => {
  const one = createCustomTheme(
    { name: '甲', bg: '#111111', text: '#eeeeee' },
    { id: 'theme-aaaaaa11' },
  )
  assert.equal(normalizeCustomThemes([one])[0].id, one.id)
  assert.throws(
    () => normalizeCustomThemes([one, { ...one, name: '乙' }]),
    /第 2 个自定义主题：主题 ID 重复/,
  )
})

test('服务端保存设置时校验自定义主题，并在删除当前主题后回退', async () => {
  const { ReaderService } = await import('../dist/server/service.js')
  let settingsValue = { theme: 'light', customThemes: [] }
  const service = Object.create(ReaderService.prototype)
  service.db = {
    settings: {
      get: () => settingsValue,
      set: async (value) => {
        settingsValue = value
      },
    },
  }
  const theme = createCustomTheme(
    { name: '服务端主题', bg: '#123456', text: '#f0f0f0' },
    { id: 'theme-server01' },
  )
  await assert.rejects(
    service.saveSettings({ settings: { theme: 'theme-missing' } }),
    /主题不存在/,
  )
  await service.saveSettings({ settings: { theme: theme.id, customThemes: [theme] } })
  assert.equal(settingsValue.theme, theme.id)
  assert.equal(settingsValue.customThemes[0].id, theme.id)

  await service.saveSettings({ settings: { customThemes: [] } })
  assert.equal(settingsValue.theme, 'light')
  await assert.rejects(
    service.saveSettings({ settings: { customThemes: [{ name: '坏主题' }] } }),
    /自定义主题/,
  )
})
