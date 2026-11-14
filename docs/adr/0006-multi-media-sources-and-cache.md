# ADR-0006: 多类型媒体源、站点入口与服务端媒体缓存

- Status: Accepted
- Date: 2026-11-12
- Deciders: JUNQINGV587, DSH agent
- Related: [#51](https://github.com/JUNQINGV587/mo-reader/issues/51)

## Context

墨读目前只有文字书：书源导入、搜索、目录、正文和下载最终都落到文本。界面虽然已有漫画/音频/视频的展示分支，但没有端到端的数据与网络链路。

用户要求把视频源、音频源、漫画源和网站源都加入支持，并接受以下前提：

- 覆盖搜索、详情、目录、播放/看图、进度和按需下载的全链路；
- 兼容 Legado 的 0 文本、1 音频、2 图片/漫画、4 视频类型，继续使用现有 CSS/JSON/JS 子集；
- 网站源用我们自己的网址模板，不依赖 Legado 的 WebView 规则；
- 网页登录由外部浏览器处理，墨读不读取或代理外部浏览器 Cookie；书源/订阅源声明的 Cookie 与站点下发的 `Set-Cookie` 由源级 jar 保存（2026-11-14 修订）；
- 媒体文件存到 DSH 服务端，可跨设备访问；
- HLS 完整离线缓存，默认最高清晰度，AES-128 可解，DRM 不支持；
- 媒体在线播放走后端代理，避免 CORS/Referer 问题。

## Decision

### 1. 作品与分类书架

- 统一沿用 `books` 表存作品，新增 `contentType` 作为作品类型：`novel` / `comic` / `audio` / `video`。现有文字书默认 `novel`。
- 漫画、音频、视频各有独立书架页和左侧入口；小说仍在书架。左侧顺序固定为：小说、漫画、音频、视频、网页，然后是发现、书源、设置。
- 网站源不是作品，不写入 `books` 表；它只产生站点入口。

### 2. 书源类型与章节载荷

- Legado `bookSourceType` 映射：`0 -> novel`、`1 -> audio`、`2 -> comic`、`4 -> video`；`3`（网络文件）首版不支持并明确报错。
- `source.contentType` 是媒体类型的事实来源；加入书架时复制到 `book.contentType`。后续搜索/发现结果按源声明类型展示，不以文件名猜类型。
- 章节载荷是联合类型：
  - `novel`：文本；
  - `comic`：有序的图片 URL 列表；
  - `audio` / `video`：一个媒体 URL（可为 HLS playlist）、可选的媒体类型标记 `mediaHls` 及请求头；
  - `website`：没有章节。
- 媒体章节的“解析失败”不能变成空正文或假图片；必须报明确错误，并保留“在外部浏览器打开书源主页”的入口。

### 3. 网站源是站点入口

网站源使用扩展书源 JSON 表示，允许出现在普通源库数组中：

```json
{
  "bookSourceName": "示例站",
  "bookSourceUrl": "https://example.com",
  "contentType": "website",
  "homeUrl": "https://example.com",
  "searchUrl": "https://example.com/search?q={{key}}"
}
```

- `homeUrl` 必填；`searchUrl` 可选，`{{key}}` 由墨读做 URL 编码。
- `contentType=website` 的记录没有抓取规则、不会产出作品卡；启用后自动出现在“网页”书架。
- 点站点卡或全局搜索里的站点结果，用用户点击触发的 `window.open(..., noopener)` 打开外部浏览器。墨读不渲染 iframe，不读取、不保存外部浏览器 Cookie；站点登录和验证码完全由浏览器处理。网站源没有抓取链路，不创建源级 Cookie jar。
- 全局搜索把站点结果单独列在底部；没有 `searchUrl` 的站点只打开首页。
- 网站源的权限 origin 来自 `homeUrl` 和 `searchUrl`；订阅扩权检查必须把它们计入。

### 4. 服务端媒体存储与代理

- 媒体文件目录默认 `~/.dsh/reader/media`，默认配额 50GB；配额可在设置中调整。
- 插件新增 `webServer` 注入，在同一 DSH 认证边界下注册媒体 HTTP 路由：
  - 只接受缓存索引中的媒体/chapter id，不接受任意 URL，避免 SSRF；HLS playlist 的分片/密钥是受控例外：服务端重写为带 AES-GCM 短期签名令牌与过期时间的同源 URL，调用方不能直接构造任意上游 URL；
  - 支持 `Range`，供播放器拖动和分段播放；
  - 只读缓存目录，拒绝路径穿越；
  - 在线拉流走同一个后端代理，按源声明的请求头请求上游。
- 媒体文件不进入备份。备份只保留作品、章节、进度、书源和设置等轻量数据。
- 缓存索引持久化；服务重启后可继续已有缓存和未完成下载。

### 5. HLS 与加密媒体

- 在线播放通过后端代理；前端使用 HLS 播放器，不要求源站允许 CORS。
- 按需下载默认缓存最高码率变体；如果最高变体不可用，使用可用的最高变体。多码率选择不在首版 UI 中出现。
- HLS 缓存保存**解密后的分片**和本地 playlist/索引，不保存密钥。这样密钥过期后仍可离线播放。
- 只支持标准 `METHOD=AES-128`。`SAMPLE-AES`、Widevine、FairPlay 和其他 DRM 明确报 `reader/unsupported-media`。
- 下载失败不发布不完整索引；未完成分片可重试和断点续传，完成后才在 UI 标“已缓存”。
- 不引入 ffmpeg 合流；离线播放直接读本地 playlist 与分片。

### 6. 鉴权边界

- 媒体请求带书源/订阅源声明的请求头/Referer 和该源的 Cookie jar；不读取外部浏览器 Cookie。
- 源级 Cookie 按 host-only 保存，只在匹配 host 的请求发送，跨站重定向不带；Cookie 不写入备份，也不通过客户端接口暴露。
- 源级 jar 没有有效凭据、站点仍返回 401/403 时，必须报明确的“需要登录”错误，不能静默失败。
- AES-128 的 key 请求沿用同一套源请求头，但 key 不写入磁盘。
- 外部浏览器的登录态与墨读服务端完全分离；退出/清空浏览器由用户自行处理。

### 7. 下载、空间与淘汰

- 下载以作品为单位：默认勾选全部章节，下载前可取消部分章节。
- 下载任务持久化，可暂停、继续、重试；同一时间只允许有限并发（沿用现有 job 限制）。
- 空间达到 50GB 时，按“整部作品”的最近访问时间淘汰已完成缓存；正在下载和标记“保留”的作品不淘汰。
- 如果全部可淘汰项都不能释放足够空间，新下载失败并提示，不删除保留项。
- 媒体不会自动追更下载；目录更新可发现新章节，但下载仍需用户触发。

### 8. 阅读与进度

- 漫画默认纵向滚动；每本作品可在“纵向滚动/左右翻页”之间单独选择。条漫不强制切页。
- 音频支持跨页面后台继续；全局只有一个音频播放器，底部显示迷你播放条。视频离开播放页是否继续不作为首版承诺。
- 媒体进度按类型保存：文字用章节/百分比，漫画用章节+页序号，音频/视频用章节+秒；网站入口没有阅读进度。
- “继续阅读”优先恢复最近一部有进度的作品；媒体作品的“最近阅读”沿用现有书架排序语义。

### 9. 搜索与下载入口

- 发现页一次搜索全部启用源；作品结果按类型筛选、标识并合并；网站源作为独立“站点结果”组，不混入作品卡。
- 书架各分类的下载按钮只对作品显示；网站卡没有下载按钮。
- 下载前弹出章节范围选择；默认全选，清晰度固定为最高可用。

## Amendments

### 2026-11-14 — 源级 Cookie jar

- 用户明确允许墨读保存并发送 Cookie。范围限定为书源/订阅源自己的 Cookie：导入时接受源声明请求头里的 Cookie，抓取过程中接收并合并 `Set-Cookie`，按源保存在独立 jar 中。
- Cookie 是 host-only：忽略 `Domain` 属性，只发给完全相同的主机；跨站重定向不携带；不读取外部浏览器 Cookie，不把 Cookie 暴露给客户端接口或日志。
- 抓取、媒体探测、媒体代理、封面和下载都使用同一源级 jar；没有有效凭据导致 401/403 时仍报 `reader/auth-required`。
- Cookie 不进入备份；恢复备份从空 jar 开始。导入/恢复的静态请求头仍拒绝 `Authorization` 等凭据，规则级 `headers.Cookie` 仍被拒绝；只有源顶层声明的 Cookie 进入 jar。
- 持久化字段为源记录的 `cookies` 数组；`sourceView` 只返回 `cookieCount`。旧备份和没有 Cookie 的源不受影响。

### 2026-11-14 — 媒体类型标记与 HLS 判定（#77）

- §2 的音频/视频章节载荷增加可选 `mediaHls`：`true` 为 HLS playlist，`false` 为直链。地址以 `.m3u8` 结尾，或响应 `content-type` 为 `application/vnd.apple.mpegurl` / `application/x-mpegurl` / `audio/mpegurl` / `audio/x-mpegurl` 时判为 HLS。
- 地址后缀已能判定时以地址为准：`.m3u8` 即使响应 `octet-stream` 仍按 HLS，`.mp4` 即使响应 `octet-stream` 仍按直链；只有后缀无法判定时才看响应类型。
- 地址无法从后缀判定时，服务端用 HEAD（失败再用 1 字节 Range 的 GET）探测一次；结果随章节落库并在下载时复用。下载、播放与服务端代理共用同一判定，不再只认 `.m3u8` 后缀。
- 直链下载前若响应是 `text/html` 等明确的非媒体类型，报 `reader/unsupported-media` 且不写入媒体缓存。
- `reader/unsupported-media` 也用于远端返回了可读但非音频/视频的内容；探测失败或全部候选不可用仍是 `reader/media-unavailable`。

## Consequences

Positive:

- 四类媒体和网站入口共享现有书源/订阅/权限/备份基础设施。
- 媒体在线播放、离线缓存和跨设备读取走同一服务端通道。
- HLS 离线不依赖过期 key；服务端代理规避大部分 CORS/Referer 失败。
- 网站源不引入 WebView 登录代理和第三方 Cookie 风险。

Negative:

- 需要新增 `webServer` 媒体路由、文件缓存索引、HLS 下载器和媒体播放器，范围明显大于文字书。
- 服务端承担媒体带宽和 50GB 存储；需要配额、清理和 Range 测试。
- 外部浏览器无法提供墨读内的独立登录态；需要登录时只能用源声明的 Cookie 或站点抓取时下发的 Set-Cookie，源级 jar 没有凭据就仍会失败。
- 缓存分片不是通用视频文件，不能直接导出为 MP4。

## Alternatives considered

- **内嵌 iframe/WebView**：拒绝。普通浏览器无法隔离第三方 Cookie，且大量站点禁止 iframe；登录和验证码不可靠。
- **浏览器本地 IndexedDB 缓存**：拒绝。无法满足跨设备读取，且与 50GB 服务端配额目标不一致。
- **ffmpeg 转 MP4**：拒绝。新增外部依赖和转码成本；分片+本地 playlist 已能满足离线播放。
- **原样保存加密分片**：拒绝。密钥过期后离线不可用。
- **按集淘汰**：拒绝。容易留下断集，用户离线连续看会失败。
- **把网站源抓成作品卡**：拒绝。网站源没有 Legado 规则契约，抓取会变成另一套不稳定的爬虫。

## Non-goals

- 不做外部浏览器 Cookie 导入、服务端无头浏览器或验证码代理；源声明的 Cookie 走独立 jar，这不是浏览器登录态。
- 不支持 Legado `bookSourceType=3`（网络文件）。
- 不支持 SAMPLE-AES、Widevine、FairPlay 或其他 DRM。
- 不做字幕、弹幕、投屏、转码导出。
- 不自动追更下载媒体。

## References

- 需求讨论：书源支持扩展（2026-11-12）
- 规格父票：[#51](https://github.com/JUNQINGV587/mo-reader/issues/51)
