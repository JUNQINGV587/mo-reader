import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

process.env.MO_READER_INSECURE_ALLOW_PRIVATE = '1'

function fakeTable() {
  const map = new Map()
  return {
    map,
    get: (key) => map.get(key),
    entries: () => map.entries(),
    put: async (key, value) => {
      map.set(key, value)
    },
    delete: async (key) => map.delete(key),
  }
}

async function makeService() {
  const { ReaderService } = await import('../dist/server/service.js')
  const subscriptions = fakeTable()
  const service = Object.create(ReaderService.prototype)
  service.db = { subscriptions }
  return { service, subscriptions }
}

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>示例 RSS</title>
    <link>https://example.com/</link>
    <description>频道说明</description>
    <item>
      <title>第一篇</title>
      <link>https://example.com/posts/1</link>
      <description><![CDATA[<p>第一段</p><p>第二段</p>]]></description>
      <pubDate>Mon, 16 Nov 2026 08:00:00 GMT</pubDate>
      <author>作者甲</author>
    </item>
    <item>
      <title>第二篇</title>
      <link>https://example.com/posts/2</link>
      <description>纯文本摘要</description>
    </item>
  </channel>
</rss>`

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>示例 Atom</title>
  <link rel="alternate" href="https://example.com/"/>
  <subtitle>Atom 说明</subtitle>
  <entry>
    <title>Atom 第一篇</title>
    <link rel="alternate" href="https://example.com/atom/1"/>
    <summary>Atom 摘要</summary>
    <updated>2026-11-16T08:00:00Z</updated>
    <author><name>作者乙</name></author>
  </entry>
</feed>`

test('RSS 2.0：频道与条目解析', async () => {
  const { parseFeed } = await import('../dist/core/rss/feed.js')
  const feed = parseFeed(RSS, 'https://example.com/rss.xml')
  assert.equal(feed.title, '示例 RSS')
  assert.equal(feed.link, 'https://example.com/')
  assert.equal(feed.articles.length, 2)
  assert.equal(feed.articles[0].title, '第一篇')
  assert.equal(feed.articles[0].link, 'https://example.com/posts/1')
  assert.equal(feed.articles[0].summary, '第一段\n第二段')
  assert.equal(feed.articles[1].summary, '纯文本摘要')
})

test('Atom：feed 与 entry 解析', async () => {
  const { parseFeed } = await import('../dist/core/rss/feed.js')
  const feed = parseFeed(ATOM, 'https://example.com/atom.xml')
  assert.equal(feed.title, '示例 Atom')
  assert.equal(feed.description, 'Atom 说明')
  assert.equal(feed.articles.length, 1)
  assert.equal(feed.articles[0].title, 'Atom 第一篇')
  assert.equal(feed.articles[0].link, 'https://example.com/atom/1')
  assert.equal(feed.articles[0].author, '作者乙')
})

test('订阅源：导入、列表、抓取文章、删除', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/rss+xml; charset=utf-8')
    res.end(RSS)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const url = `http://127.0.0.1:${port}/rss.xml`
  try {
    const { service } = await makeService()
    const imported = await service.importRssSources({
      sources: [{ sourceUrl: url, sourceName: '测试订阅' }],
    })
    assert.equal(imported.added, 1)

    const list = await service.listRssSources()
    assert.equal(list.rssSources.length, 1)
    assert.equal(list.rssSources[0].sourceName, '测试订阅')
    const id = list.rssSources[0].id

    const result = await service.getRssArticles({ id })
    assert.equal(result.feed.title, '示例 RSS')
    assert.equal(result.feed.articles.length, 2)

    const removed = await service.deleteRssSource({ id })
    assert.equal(removed.deleted, 1)
    assert.equal((await service.listRssSources()).rssSources.length, 0)
  } finally {
    server.close()
  }
})
