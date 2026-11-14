# ADR-0007: 订阅源走作品承载与条目载荷

- Status: Accepted
- Date: 2026-11-14
- Deciders: JUNQINGV587, DSH agent
- Related: [#66](https://github.com/JUNQINGV587/mo-reader/issues/66), [#68](https://github.com/JUNQINGV587/mo-reader/issues/68), [#69](https://github.com/JUNQINGV587/mo-reader/issues/69)
- Amends: [ADR-0006](0006-multi-media-sources-and-cache.md) §1、§2

## Context

墨读原本把 Legado 的「订阅源（RssSource）」当成书源拒绝导入。用户要求支持 RSS 订阅，且希望与现有书架、阅读器、进度、缓存和备份共用同一套链路，而不是再维护一套独立的订阅阅读器。

Legado 订阅源不是标准 RSS/Atom XML：它用 `sortUrl` 描述分类列表，用 `ruleArticles` / `ruleTitle` / `ruleLink` / `ruleImage` / `rulePubDate` / `ruleContent` 抓网页。订阅源产出的是一条条文章（条目），不是一本书的章节；条目可能需要 Cookie、登录或注入脚本才能在 Legado 的 WebView 里打开。

#66 已确认的产品边界：

- 一个「源 × 分类」是一部作品；导入时列出分类，用户勾选后每类生成一张作品卡；
- 条目按发布时间倒序，只增不删，保留阅读进度与已读标记；
- 正文先是文本或摘要，图文块与视频播放后续补；
- 不保存/发送 Cookie，不执行 `injectJs`，不内嵌 WebView；缺能力时明确提示。

## Decision

### 1. 订阅是作品，不新建订阅表

- `books` 增加 `contentType=subscription`；订阅与小说/漫画/音频/视频共用作品、章节、进度、笔记、备份表。
- 作品来源是 `sources` 中 `kind=rss` 的记录；同一订阅源按分类拆成多部作品，作品元数据保存 `subscription: { sourceId, sourceName, categoryName, sortUrl, anchorUrl }`。
- 书架增加「订阅」分类，位于网页之后；导入入口与书源共用，按 JSON 形状自动识别，不要求用户先选类型。
- 网站源仍是站点入口，不写 `books`；订阅源与网站源的区别是前者产出条目流。

### 2. 条目是章节，文字先行为主

- 条目落成 `chapters`：标题、链接、封面、发布时间、摘要；打开条目记录 `readAt`。
- 条目顺序按可解析的发布时间倒序；没有可用时间时保持列表原序。刷新只追加/更新，不删除已有条目，避免阅读进度和缓存丢失。
- 本 ADR 落地时条目载荷是文本：详情页正文规则抽出的纯文本，或列表摘要。图文块（段落/标题/引用/代码/列表/图片的有序数组）由后续票实现，届时替换文本载荷，不改变作品/章节模型。
- 视频条目仍按「章节 → 播放地址」演进，不在本 ADR 内引入 WebView 或 `injectJs`。

### 3. 抓取规则沿用书源执行器，但保留订阅语义

- `RssSource` 的列表/正文规则映射为现有规则字段：`chapterList`、`chapterName`、`chapterUrl`、`chapterCover`、`chapterDate`、`chapterDescription`、`nextPage`、`content`。
- 复用 CSS/JSONPath/XPath/`@js` 子集和 `{{...}}` 模板；`ruleNextPage=page` 是 Legado 的页码哨兵，分类地址含 `{{page}}` 时页码递增重请求；也接受 URL 模板或下一页选择器。
- 分页到 `maxTocPages` 停止；重复链接按绝对 URL 去重；分页循环报 `reader/pagination-loop`，不静默返回半页。
- 订阅抓取不因为源声明了 Cookie/登录/注入脚本就整源拒绝——这些能力在导入时已列为「不可用」，公开页面仍可能成功；如果最终没有解析到条目/正文，错误里必须点名被丢弃的能力，不能只报空页。
- 正文规则失败但条目有摘要时，回退到摘要；两者都没有才报 `reader/parse-error`，并带章节上下文。

### 4. 与 ADR-0006 的关系

- ADR-0006 的四种作品类型扩展为五种：新增 `subscription`；书架左侧由五类变为六类（小说、漫画、音频、视频、网页、订阅）。
- ADR-0006 的章节载荷联合类型增加「`subscription`：文本（后续为图文块）」；漫画/音频/视频载荷与缓存规则不变。
- ADR-0006 的「不导入 Cookie、不 WebView、网站源不是作品」继续有效；本 ADR 不放开这些边界。

## Consequences

Positive:

- 订阅复用现有书架、阅读进度、笔记、追更、备份和按需下载的限制逻辑，减少第二套模型。
- 只增不删的目录同步保护阅读进度；条目 URL 作为稳定主键，重复抓取不会产生重复章节。
- 导入时就告诉用户哪些能力被丢弃；抓取失败时错误能指向缺少的能力，而不是空白页。

Negative:

- 订阅条目和小说章节共用表，必须在服务层持续区分「书源目录」与「订阅条目」的同步语义。
- 纯文本先行的载荷会让图文/视频条目在后续票之前只能读到摘要；这是刻意的分期。
- 需要处理不同站点的时间格式与分页形态；无法解析时间时只能退回列表原序。

## Amendments

### 2026-11-14 — 500 条上限与运行期诊断（#73）

- §2「刷新只追加/更新，不删除已有条目」修订为：常规刷新只追加/更新；超过 500 条时，允许清理同时满足「已读、未离线下载、不是当前进度、不是追更锚点」的最旧条目。阅读时缓存正文产生的 `downloadedAt` 不算「已下载」，不能因此永久保留。
- 作品元数据允许出现运行期字段 `subscription.anchorError`，只在锚点滚出首页且时间无法判定时写入；它不进入备份，成功刷新后删除。

### 2026-11-14 — RSS 2.0 适配器（#74）

- 标准 RSS 2.0 feed 已从同一个导入入口接入：一个 feed URL 建一部订阅，条目复用章节模型，`description` / `content:encoded` 作为条目载荷；有摘要的 feed 可以只靠 feed 内容阅读。没有摘要/正文的条目会被跳过，不生成打不开的死条目。
- Atom 仍不支持，导入时明确报错；非 feed 地址不会建空作品。
- 安全边界不变：不保存或发送 Cookie、不执行 `injectJs`、不内嵌 WebView；feed 的条目链接只作为展示地址，不在服务端抓取文章页。

## Alternatives considered

- **单独的 feeds/articles 表**：拒绝。会复制书架、进度、笔记、备份和追更逻辑，且用户看到两套阅读入口。
- **只支持标准 RSS/Atom XML**：拒绝。用户给的样本是 Legado 订阅源，不是 feed；只做 XML 无法覆盖现有生态。标准 RSS 2.0 作为同一作品模型的适配器已在 #74 接入。
- **内嵌 WebView 执行 `injectJs`**：拒绝。无法隔离第三方 Cookie，且与 ADR-0006 的安全边界冲突。
- **按条目单独建作品**：拒绝。条目会淹没书架，且无法表达「一个分类的连续信息流」。

## Non-goals

- 不保存或代理浏览器 Cookie，不做登录/验证码。
- 不执行 `injectJs`，不内嵌 WebView。
- 本 ADR 不定义图文块载荷、视频抽址和播放器；由后续票补齐。
- 不做 Atom 解析；RSS 2.0 适配器已在 #74 接入（见 Amendments）。
