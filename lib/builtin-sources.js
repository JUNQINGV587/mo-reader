/**
 * Sources shipped with the plugin. They are ordinary sources: users can switch
 * them off, but they are re-seeded only when the builtin set changes.
 */
export const BUILTIN_SOURCES = [
  {
    bookSourceName: '维基文库',
    bookSourceUrl: 'https://zh.wikisource.org',
    bookSourceGroup: '公版',
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
    bookSourceName: '17K 小说',
    bookSourceUrl: 'https://www.17k.com',
    bookSourceGroup: '网文',
    search: {
      url: 'https://search.17k.com/search.xhtml?c.q={{key}}',
      bookList: '.search-list dl',
      name: 'dt a@text',
      author: 'li.bq span.ls a@text',
      bookUrl: 'dt a@href##/book/(\\d+)\\.html###/list/$1.html',
    },
    bookInfo: {
      detailUrl: '##/list/(\\d+)\\.html###/book/$1.html',
      name: 'h1 a@text',
      intro: 'p.intro@text',
      coverUrl: 'img.book@src',
    },
    toc: {
      url: '{{!bookUrl}}',
      chapterList: 'dl.Volume dd a',
      chapterName: '@text',
      chapterUrl: '@href',
    },
    content: {
      url: '{{!chapterUrl}}',
      content: '#readArea .p p',
    },
  },
]

export const BUILTIN_SOURCE_NAMES = BUILTIN_SOURCES.map(source => source.bookSourceName)
