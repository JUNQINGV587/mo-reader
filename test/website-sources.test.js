import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSource, renderTemplate } from '../lib/rules.js'
import { serviceFixture } from './helpers.js'
import { parseBackup } from '../lib/backup.js'
import { sourcePermissionProfile, permissionExpansion } from '../lib/subscription-refresh.js'
import { SourceEngine } from '../lib/source-engine.js'

const website = {
  contentType: 'website',
  name: '示例网站',
  homeUrl: 'https://www.example.com/home',
  searchUrl: 'https://search.example.net/search?q={{key}}',
}

test('website source is a site entry with an encoded search template', () => {
  const source = normalizeSource(website)
  assert.equal(source.contentType, 'website')
  assert.equal(source.bookSourceUrl, website.homeUrl)
  assert.equal(source.homeUrl, website.homeUrl)
  assert.equal(source.searchUrl, website.searchUrl)
  assert.deepEqual(source.rules, {})
  assert.equal(renderTemplate(source.searchUrl, { key: '凡人 修仙' }), 'https://search.example.net/search?q=%E5%87%A1%E4%BA%BA%20%E4%BF%AE%E4%BB%99')
})

test('website source rejects missing home URLs and scraping rules', () => {
  assert.throws(() => normalizeSource({ contentType: 'website', name: '缺首页' }), /homeUrl|首页/)
  assert.throws(() => normalizeSource({ ...website, rules: { search: { bookList: '.book' } } }), /抓取规则|不支持/)
  assert.throws(() => normalizeSource({ ...website, ruleExplore: '<js>[]</js>' }), /抓取规则|不支持/)
  assert.throws(() => normalizeSource({ ...website, homeUrl: 'file:///tmp/site.html' }), /http|https|URL/i)
  assert.throws(() => normalizeSource({ ...website, bookSourceType: 3 }), /类型 3|网络文件/)
})

test('mixed source imports keep website type through state and backup', async () => {
  const { service } = await serviceFixture()
  const result = await service.importSource({ text: JSON.stringify([
    website,
    { bookSourceName: '小说源', bookSourceUrl: 'https://novel.example', rules: { search: { url: '/search?q={{key}}', bookList: '.book', name: '.name', bookUrl: 'a@href' } } },
  ]) })
  assert.equal(result.imported, 2)
  const state = await service.state()
  const site = state.sources.find(source => source.contentType === 'website')
  assert.ok(site)
  assert.equal(site.homeUrl, website.homeUrl)
  assert.equal(site.searchUrl, website.searchUrl)
  assert.equal(state.books.length, 0)
  await assert.rejects(new SourceEngine().search(site, { query: '关键词' }), /网站源|站点入口/)

  await service.setSourceEnabled({ id: site.id, enabled: false })
  assert.equal((await service.state()).sources.find(source => source.id === site.id).enabled, false)
  const restored = parseBackup(await service.exportBackup())
  const saved = restored.sources.find(source => source.id === site.id)
  assert.equal(saved.contentType, 'website')
  assert.equal(saved.enabled, false)
  assert.equal(saved.homeUrl, website.homeUrl)
  assert.equal(saved.searchUrl, website.searchUrl)
  await service.removeSource({ id: site.id })
  assert.ok(!(await service.state()).sources.some(source => source.id === site.id))
})

test('website home and search origins participate in permission expansion', () => {
  const site = normalizeSource(website)
  const profile = sourcePermissionProfile([site])
  assert.deepEqual(profile.origins, ['https://search.example.net', 'https://www.example.com'])
  const expansion = permissionExpansion([], [site])
  assert.deepEqual(expansion.origins, ['https://search.example.net', 'https://www.example.com'])
})

test('mixed subscription and website expansion wait for confirmation', async () => {
  let library = [website, { bookSourceName: '小说源', bookSourceUrl: 'https://novel.example', rules: {} }]
  const { service } = await serviceFixture({}, {
    fetchRemote: async () => ({ text: JSON.stringify(library) }),
  })
  const subscribed = await service.subscribeSourceLibrary({ url: 'https://library.example/sources.json' })
  assert.equal(subscribed.imported, 2)
  const subscriptionId = subscribed.subscription.id
  const before = await service.state()
  assert.ok(before.sources.some(source => source.contentType === 'website'))
  assert.equal(before.sources.filter(source => source.contentType === 'novel' && source.id !== 'local').length, 1)

  library = [{ ...website, homeUrl: 'https://new.example.org/start', searchUrl: null }]
  const refreshed = await service.refreshSubscription({ id: subscriptionId })
  assert.equal(refreshed.pending, true)
  const pendingState = await service.state()
  assert.equal(pendingState.subscriptions[0].status, 'pending')
  assert.ok(pendingState.subscriptions[0].pending.permissions.origins.includes('https://new.example.org'))
  assert.ok(pendingState.sources.some(source => source.homeUrl === website.homeUrl))
  assert.ok(!pendingState.sources.some(source => source.homeUrl === 'https://new.example.org/start'))

  await service.confirmSubscriptionUpdate({ id: subscriptionId })
  const confirmed = await service.state()
  assert.equal(confirmed.subscriptions[0].status, 'ready')
  assert.ok(confirmed.sources.some(source => source.homeUrl === 'https://new.example.org/start'))
  assert.ok(!confirmed.sources.some(source => source.homeUrl === website.homeUrl))
})
