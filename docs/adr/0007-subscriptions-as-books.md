# ADR-0007: 订阅源走作品承载与条目载荷

- Status: Accepted
- Date: 2026-11-14
- Deciders: JUNQINGV587, DSH agent
- Related: [#66](https://github.com/JUNQINGV587/mo-reader/issues/66), [#68](https://github.com/JUNQINGV587/mo-reader/issues/68), [#69](https://github.com/JUNQINGV587/mo-reader/issues/69)
- Amends: [ADR-0006](0006-multi-media-sources-and-cache.md) §1、§2

## Context

墨读原本把 Legado 的「订阅源（RssSource）」当成书源拒绝导入。用户要求支持 RSS 订阅，且希望与现有书架、阅读器、进度、缓存和备份共用同一套链路，而不是再维护一套独立的订阅阅读器。

Legado 订阅源不是标准 RSS/Atom XML：它用 `sortUrl` 描述分类列表，用 `ruleArticles` / `ruleTitle` / `ruleLink` / `ruleImage` / `rulePubDate` / `ruleContent` 抓网页。订阅源产出的是一条条文章（条目），不是一本书的章节；条目可能需要 Cookie、登录或注入脚本才能在 Legado 的 WebView 里打开。Cookie 由源级 jar 保存并发送；登录和注入脚本仍不支持。

#66 已确认的产品边界：

- 一个「源 × 分类」是一部作品；导入时列出分类，用户勾选后每类生成一张作品卡；
- 条目按发布时间倒序，只增不删，保留阅读进度与已读标记；
- 正文先是文本或摘要，图文块与视频播放后续补；
- Cookie 按源保存并只在同 host 发送，不读取外部浏览器 Cookie；不执行 `injectJs`，不内嵌 WebView；缺能力时明确提示。

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
- 订阅抓取不因为源声明了登录/注入脚本就整源拒绝——这些能力在导入时已列为「不可用」，公开页面仍可能成功；Cookie 会进入源级 jar。如果最终没有解析到条目/正文，错误里必须点名被丢弃的能力，不能只报空页。
- 正文规则失败但条目有摘要时，回退到摘要；两者都没有才报 `reader/parse-error`，并带章节上下文。

### 4. 与 ADR-0006 的关系

- ADR-0006 的四种作品类型扩展为五种：新增 `subscription`；书架左侧由五类变为六类（小说、漫画、音频、视频、网页、订阅）。
- ADR-0006 的章节载荷联合类型增加「`subscription`：文本（后续为图文块）」；漫画/音频/视频载荷与缓存规则不变。
- ADR-0006 的「不读取外部浏览器 Cookie、不 WebView、网站源不是作品」继续有效；Cookie 只按源保存和发送，本 ADR 不放开 WebView 或登录边界。

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
- 安全边界：不读取外部浏览器 Cookie；源级 Cookie 只在同 host 发送且不进备份；不执行 `injectJs`、不内嵌 WebView；feed 的条目链接只作为展示地址，不在服务端抓取文章页。

### 2026-11-14 — 图文块、抽址与单条下载（#66/#70/#71）

- §2 的「图文块由后续票实现」与 §4 的「`subscription`：文本（后续为图文块）」已由 #70 落地：订阅条目载荷为有序块数组（段落/标题/引用/代码/列表/图片），不保存原始 HTML；图片走媒体代理并按 50GB 媒体缓存。
- 视频条目由 #71 落地：从正文 HTML 按文档顺序抽 `m3u8`/`mp4` 字面量与 `<video>/<source>` 的 src，去重最多 5 个候选，服务端带源声明的请求头短探测（8 秒总预算），首个可用成为条目 `mediaUrl`；全失败报 `reader/media-unavailable`。播放复用现有 HLS/视频播放器。
- §4 的「漫画/音频/视频载荷与缓存规则不变」在订阅上扩展为：订阅媒体条目与 audio/video 共用媒体代理、缓存、HLS 离线与播放器；`cover=1` / `block=N` 是订阅封面与图文图片的代理入口。
- 下载粒度是 ADR-0006 §7/§9 的订阅例外：订阅一次只能下载一条，入口在阅读器，不进 autoDownload；图文/图集条目没有离线下载，只有媒体条目可离线。
- Non-goals 中「不定义图文块/抽址/播放器」由本节更新，现已实现；不执行 `injectJs`、不内嵌 WebView 的边界不变。

### 2026-11-14 — 备份恢复的凭据与规则边界（#79）

- 订阅源、订阅作品与条目元数据可随备份恢复；条目正文/媒体缓存/离线文件仍不进入备份。请求头在导出与恢复时都清洗 URL 用户名/密码、片段和敏感查询参数，并丢弃 Bearer/Basic/Token 值；源 headers 里的 Cookie/Authorization 在恢复时丢弃，不因坏头拒绝整份备份，规则里的敏感键仍拒绝。
- 规则型订阅源的规则恢复复用导入校验（敏感键、WebView、类型），坏备份报 `reader/invalid-backup` 并带 `sources[i].rules` 路径，不落库；feed 源不校验规则，也不导出 `rules`/`contentType`/headers/unsupported。
- 规则型订阅源允许恢复「无正文、只有条目 URL」的媒体条目，首次打开时重新抓取；RSS 2.0 feed 的每个条目仍必须有非空摘要，空 `text` 不能替代。
- 恢复失败整体回滚六张表（jobs/chapters/notes/books/sources/subscriptions）与设置，避免留下半套数据；备份版本仍为 2。

### 2026-11-14 — 源级 Cookie jar（用户授权）

- 用户明确允许墨读保存并发送 Cookie。订阅源导入时接受源声明请求头里的 Cookie，抓取中接收并合并 `Set-Cookie`，按源保存在独立 jar；Cookie 是 host-only，忽略 `Domain`，跨站重定向不带。
- 目录、条目正文、媒体探测、媒体代理、封面与下载都使用同一源级 jar；401/403 仍报 `reader/auth-required`。
- Cookie 不进入备份，`sourceView` 只暴露 `cookieCount`；登录信息与 `injectJs` 仍不支持。

## Alternatives considered

- **单独的 feeds/articles 表**：拒绝。会复制书架、进度、笔记、备份和追更逻辑，且用户看到两套阅读入口。
- **只支持标准 RSS/Atom XML**：拒绝。用户给的样本是 Legado 订阅源，不是 feed；只做 XML 无法覆盖现有生态。标准 RSS 2.0 作为同一作品模型的适配器已在 #74 接入。
- **内嵌 WebView 执行 `injectJs`**：拒绝。无法隔离第三方 Cookie，且与 ADR-0006 的安全边界冲突。
- **按条目单独建作品**：拒绝。条目会淹没书架，且无法表达「一个分类的连续信息流」。

## Non-goals

- 不读取或代理外部浏览器 Cookie；源级 Cookie 按上面规则保存，不做登录/验证码。
- 不执行 `injectJs`，不内嵌 WebView。
- 本 ADR 不定义图文块载荷、视频抽址和播放器；由 #70/#71 落地（见 Amendments），本节仅保留原始边界。
- 不做 Atom 解析；RSS 2.0 适配器已在 #74 接入（见 Amendments）。
