# 卷曲翻页横向条带：复现、修复与验证 · 2026-11-05

对应 Issue：JUNQINGV587/mo-reader#9；原始录屏同时补齐 JUNQINGV587/mo-reader#8 的 Phase 3 证据。

## 结论

- **最终产品决定**：默认阅读方式改为上下滚动，不再把卷曲动画作为默认路径。卷曲仍可在设置中手动选择，iPad Safari 的横向条带是已知问题，不阻塞滚动阅读。
- **真机与软件渲染均复现**：维护者在 iPad + Safari 看到「花屏、很多横线」；本机 headless Chromium / SwiftShader 也能稳定复现。因此这是产品渲染缺陷，不是截图伪影。
- **本机已确认一个缺陷点**：原顶点着色器把 `d > 0.30` 的顶点直接送到 `p.x = -100.0`，与折边邻点形成横跨页面的退化/巨大三角形。移除屏外位移并在片元阶段丢弃页尾后，Chromium/SwiftShader 不再出现该条带。
- **真机问题尚未解决**：维护者重启 DSH、彻底关闭并重开 Safari 标签页后仍复现。因此屏外位移不是唯一根因，#9 必须保持打开。
- **当前单变量实验**：按维护者确认的需求基线，纸张改为 `transparent:false`、恢复 `depthWrite/depthTest`，末尾淡出从 shader uniform 移到 DOM canvas `style.opacity`。接口、回调、680ms 时长与翻页交互不变；该项仍需 iPad Safari 验收。

## 产物

| 文件 | 内容 |
| --- | --- |
| `curl-680ms.gif` | 修复前真实 3080 页面卷曲录屏抽帧，第 4 帧可见条带 |
| `app-stripes-60ms.jpg` | 修复前真实页面条带最明显的一帧 |
| `probe-stripes-2136ms.jpg` | 修复前 4000ms 慢放隔离探针的条带 |
| `probe-original-65.png` | 原实现固定在原始进度 0.65：页面被黑色横带覆盖，stripe score = 7 |
| `probe-fixed-65.png` | 修复后同一进度与几何：文字、纸面与卷曲正常，stripe score = 0 |
| `app-fixed-680ms.jpg` | 修复后真实页面 680ms 动画中的代表帧，无横向条带 |
| `app-fixed-680ms.json` | 真实页面采样元数据：chunk 注入次数、帧时间、页码、选择与 stripe 指标 |
| `probe.html` | 合成 canvas 直接调用 `mountCurl`，并逐帧直接读取 WebGL 画布 |
| 仓库根目录 `scripts/test-curl-stripes.mjs` | 自动启动临时 HTTP 服务与 Chromium，执行确定性回归 |

## 一键回归

在仓库根目录执行（需 Node 24+ 与 `/usr/bin/chromium`；可用 `CHROMIUM` 覆盖路径）：

```bash
npm run test:curl
CURL_DIRECTION=-1 npm run test:curl
CURL_PROGRESS=time npm run test:curl
```

默认使用真实页面几何 **944×605**、时长 **680ms**，并把动画固定在原始进度 **0.65**，消除 rAF 时序抖动。HTTP 服务仅在内存中替换被测模块的计时语句，不改写源文件；源模块 URL 自动加时间戳，避免 ES module 缓存让 A/B 实验误用旧实现。

判定来自 WebGL 画布本身，不经过截图或 DOM：把画布缩到 450×350，计算每行平均亮度和水平差；两行都近似水平均质、相隔两行亮度却跳变超过 15 时记一次跳变，16 行窗口内跳变数即 stripe score，**score ≥ 6 为 FAIL**。

可用变量：`CURL_SRC`、`CURL_DIRECTION`、`CURL_WIDTH`、`CURL_HEIGHT`、`CURL_DURATION`、`CURL_PROGRESS=time`。测试结束会关闭临时浏览器、HTTP 服务并删除临时 profile。

### 修复前后结果

| 用例 | 结果 |
| --- | --- |
| 原实现，944×605 / 680ms / 固定 0.65 | FAIL，maxScore = 7 |
| 修复后，同条件正向 | PASS，maxScore = 0 |
| 修复后，同条件反向 | PASS，maxScore = 3，低于阈值 6 |
| 修复后完整计时隔离探针 | 完整跑到 done，11 帧，maxScore = 0 |
| 完整 `npm test` | 36/36 通过 |

## 真实页面验收

操作路径：侧栏「墨读」→「列表」→ `curl-test.txt` →「排版」→「卷曲」→ 下一页。CDP 驱动真实 3080 页面并录制 680ms 动画，结果：

- 页码：`1 / 8` → `2 / 8`。
- WebGL canvas：944×605；17 个 overlay 采样帧，`maxStripeScore = 0`。
- overlay 从 614.7ms 到 1312.1ms，约 697ms，结束后正常移除。
- 翻完后在 `.mr-paged-chapter` 建立 Range，`getSelection()` 为 `"1段。天"`；命中测试仍落在 `BUTTON.mr-page-btn`。

**验证环境说明**：长期运行的 3080 进程未启用 HMR，旧 `client.three.js?rev=…` 是不可变缓存，磁盘重建后该进程仍提供旧 rev。为验证新代码，CDP `Fetch` 只把真实页面请求 `/plugins/@local/mo-reader/client.three.js` 的响应替换为刚重建的 `/data/reader/client.three.js`（`injectedChunks = 1`），其余页面、DOM、纹理捕获与交互均走真实应用。正常部署/重载插件资源后无需此测试注入。

## 已排除的方向

| 猜测 | 试验与结论 |
| --- | --- |
| 截图时序 / 抓帧太慢 | 合成器截图、screencast、直接 WebGL 像素采样均出现；真机也复现 |
| DOM 快照 `capturePageCanvas` | 合成 canvas 直接喂 `mountCurl` 也复现，与 DOM 快照无关 |
| 纹理尺寸 / NPOT / mip | POT 与 NPOT 都复现；纹理使用 LinearFilter 且禁用 mip，不是主因 |
| 纯色探针可单独作回归 | 不可：纯色在修复前后都为 0；必须使用含文字/对比内容的纹理 |
| 把页尾顶点塌缩到折边即可 | 不完整：真实 944×605 / 680ms 下仍可能留下细三角形并出现条带；最终同时移除屏外位移并在片元阶段丢弃页尾 |

## 边界

- 自动化图形环境仍为本机 SwiftShader；iPad Safari 的人工结果证明原缺陷真实存在，但修复后的真机回归未再次执行。
- 本证据验证卷曲动画缺陷，不包含其他 three 动效或视觉 redesign。
