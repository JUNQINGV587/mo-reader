/**
 * Sources shipped with the plugin. They are ordinary sources: users can switch
 * them off, but they are re-seeded only when the builtin set changes.
 *
 * builtinSince lets existing installs receive newly added sources without
 * reviving sources the user deleted earlier (see migrateBuiltinSources).
 */
export const BUILTIN_SOURCES_VERSION = 2

export const BUILTIN_SOURCES = [
  {
    bookSourceName: '维基文库',
    bookSourceUrl: 'https://zh.wikisource.org',
    bookSourceGroup: '公版',
    builtinSince: 1,
    search: {
      url: 'https://zh.wikisource.org/w/api.php?action=query&list=search&srsearch={{key}}&srlimit=10&format=json&formatversion=2',
      bookList: '@Json:$.query.search[*]',
      name: '@Json:$.title',
      intro: '@Json:$.snippet',
      bookUrl: 'https://zh.wikisource.org/wiki/{{name}}',
    },
    toc: {
      url: 'https://zh.wikisource.org/w/api.php?action=query&list=allpages&apprefix={{bookName}}/&aplimit=500&format=json&formatversion=2',
      chapterList: '@Json:$.query.allpages[*]',
      chapterName: '@Json:$.title',
      chapterUrl: 'https://zh.wikisource.org/wiki/{{title}}',
    },
    content: {
      url: 'https://zh.wikisource.org/w/api.php?action=parse&page={{chapterTitle}}&prop=text&format=json&formatversion=2',
      content: '@Json:$.parse.text',
      contentSelector: '.mw-parser-output > p',
    },
  },
  {
    bookSourceName: '品书斋',
    bookSourceUrl: 'https://www.pinshuzhai.com',
    bookSourceGroup: '网文',
    builtinSince: 2,
    search: {
      url: 'https://www.pinshuzhai.com/page/{{page}}?s={{key}}',
      bookList: '.catdanlist ul li',
      name: '.bookinfo h4 a@text',
      author: '.bookinfo .author a@text',
      bookUrl: '.bookinfo h4 a@href',
      intro: '.bookinfo p:last-of-type@text',
    },
    toc: {
      url: '{{!bookUrl}}',
      chapterList: '.newzxzj .zjlist a',
      chapterName: '@text',
      chapterUrl: '@href',
    },
    content: {
      url: '{{!chapterUrl}}',
      content: '#chapter p',
    },
  },
  {
    bookSourceName: 'MangaDex 漫画',
    bookSourceUrl: 'https://api.mangadex.org',
    bookSourceGroup: '漫画',
    bookSourceType: 2,
    builtinSince: 2,
    headers: { 'User-Agent': 'ModuReader/1.0 (comic source)' },
    search: {
      url: 'https://api.mangadex.org/manga?title={{key}}&limit=5&availableTranslatedLanguage[]=zh&includes[]=cover_art',
      bookList: '@Json:$.data[*]',
      name: '@Json:$.attributes.title@js:var t=JSON.parse(result); t.zh || t.en || Object.values(t)[0] || "未命名"',
      bookUrl: '@Json:$.id@js:"https://api.mangadex.org/manga/"+result',
      coverUrl: '@js:var item=JSON.parse(src); var c=(item.relationships||[]).find(function(x){return x.type==="cover_art"}); c&&c.attributes&&c.attributes.fileName ? "https://uploads.mangadex.org/covers/"+item.id+"/"+c.attributes.fileName+".256.jpg" : ""',
    },
    toc: {
      url: '{{!bookUrl}}/feed?translatedLanguage[]=zh&limit=500&order[chapter]=asc',
      chapterList: '@Json:$.data[*]',
      chapterName: '@Json:$.attributes@js:var a=JSON.parse(result); a.chapter ? ("第 "+a.chapter+" 话"+(a.title?" "+a.title:"")) : (a.title || "无标题")',
      chapterUrl: '@Json:$.id@js:"https://api.mangadex.org/at-home/server/"+result',
    },
    content: {
      url: '{{!chapterUrl}}',
      content: '@js:var j=JSON.parse(src); var base=j.baseUrl+"/data/"+j.chapter.hash+"/"; (j.chapter.data||[]).map(function(f){return \'<img src="\'+base+f+\'">\'}).join("")',
    },
  },
]

/** Builtins retired in a later version; migrated off existing installs. */
export const RETIRED_BUILTIN_SOURCE_NAMES = ['17K 小说']

export const BUILTIN_SOURCE_NAMES = BUILTIN_SOURCES.map(source => source.bookSourceName)
