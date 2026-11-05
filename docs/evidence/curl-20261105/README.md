# 卷曲翻页（Phase 3）实机录屏证据 · 2026-11-05

对应 Issue：JUNQINGV587/mo-reader#8（补 Phase 3 卷曲 680ms 真实录屏）。

## 结论先说

- **动画确实跑起来了，时长与实现一致**：`mountCurl` 默认 `duration = 680`（`src/three-entry.js:1222`），实测 overlay 节点存在 697ms（宿主时钟 764ms→1461ms），翻页推进正常（4/6 → 5/6、6/6 → 1/6 均验证过）。
- **翻完文字可正常选中**：录完后 `.mr-curl-host` 已移除，DOM 文字层回归；脚本在 `.mr-paged-chapter` 内建立 Range，`getSelection()` 返回 `"1段。天"`。
- **发现异常：卷曲过程中会出现横向条带**。页面区域被数十条横带替代，每条带是页面纹理被压成一行后横向拉伸；同一帧里未被条带覆盖的部分正常。多次录制中都出现，但**不是每一帧**，出现时机不固定（有的 run 在第 60–150ms，有的在 800ms 之后，4000ms 慢放探针里约在 1968–2136ms）。
- **尚未能定根因**，也**尚不能排除采集端伪影**：证据来自无 GPU 的 headless Chromium（SwiftShader 软件渲染）。详见「已知边界」。

## 产物

| 文件 | 内容 |
| --- | --- |
| `curl-680ms.gif` | 真实 3080 页面里一次卷曲翻页的 screencast 抽帧（620px 宽，21 帧，约 680ms），第 4 帧可见条带 |
| `app-stripes-60ms.jpg` | 条带最清楚的一帧（相对动画开始 +60ms，原尺寸 1440×813） |
| `probe-stripes-2136ms.jpg` | 隔离探针在 4000ms 慢放、+2136ms 的同一现象（合成纹理，不经过 DOM 快照） |
| `probe.html` | 隔离探针页：用合成 canvas 直接调用 `mountCurl`，可复现 |

## 复现步骤

### A. 真实页面（需要 3080 在跑，且本机有 Chromium）

```bash
# 1. 起一个可被 CDP 驱动的 Chromium（无 GPU 环境用 SwiftShader）
/usr/bin/chromium --headless=new --no-sandbox --disable-dev-shm-usage \
  --remote-debugging-port=9222 --remote-allow-origins='*' \
  --user-data-dir=/tmp/mo/profile --window-size=1440,900 \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader about:blank

# 2. 打开 http://127.0.0.1:3080/ → 侧栏「墨读」→ 列表 → 打开一本 TXT →
#    header「排版」→ 翻页效果「卷曲」→ 关抽屉
# 3. 用 CDP 的 Page.startScreencast 抓帧，点 footer 的「下一页」
```

录屏脚本是临时的（`/tmp/mo/cdp.mjs` + `final.mjs`），未入库；要点只有两个：先 `Target.activateTarget` 让 3080 页成为活动标签（否则 rAF 被冻结、screencast 只出 1 帧），以及每帧 `Page.screencastFrameAck`。

### B. 隔离探针（不需要 DSH）

```bash
cd <repo root>
python3 -m http.server 8137 --bind 127.0.0.1 --directory .
# 打开 http://127.0.0.1:8137/docs/evidence/curl-20261105/probe.html?w=900&h=700&d=4000
# 参数：w/h 合成画布尺寸，d 动画时长（毫秒，默认 4000 便于慢放观察），dir 方向，plain=1 只画纯色
```

探针只做三件事：画一张合成 canvas（底色 + 色标 + 16 行文字 + 20px 网格）→ `mountCurl(host, { canvas, width, height, duration })` → 记录 `window.__probe`。

## 已排除的方向

| 猜测 | 试验 | 结果 |
| --- | --- | --- |
| 截图时序 / 抓帧太慢 | 换 `Page.captureScreenshot`（合成器截图）与 `Page.startScreencast`（真实帧）两条路径 | 两条都出现，且同一现象在合成纹理探针里也能出 → 不是抓帧太慢造成的错觉 |
| DOM 快照（`capturePageCanvas` 逐字符 fillText）有问题 | 绕开 DOM，用合成 canvas 直接喂 `mountCurl` | 同样出现 → 与快照实现无关 |
| 纹理尺寸 / NPOT | 探针对比 1024×512（POT）与 872×705（NPOT） | 都出现 → 与纹理尺寸无关 |
| 只有文字才有内容、看不出所以然 | `plain=1` 纯色纹理 | 条带不可见（纯色没有高频内容可暴露），但折角明暗正常 → 是「采样内容错位」，不是整屏失效 |

## 已知边界（重要）

- 本机**没有 GPU**（无 `/dev/dri`），Chromium 走 `--use-angle=swiftshader`；`chrome-devtools` MCP 自带的 Chrome 因 `at: - /opt/google/chrome/chrome` 缺失且禁止 root 启动，用不了。
- 因此「条带」目前只能确认「在软件渲染 + headless 采集下可稳定出现」，**不能确认它在用户的真实 GPU 浏览器里是否出现**。若真机复现，那是产品缺陷；若不复现，则是采集/合成器层面的伪影，不应改渲染代码。
- 代码层面的可疑点（供真机复现后参考，不是结论）：顶点着色器把 `d > 0.30` 的顶点 `p.x = -100.0`（`src/three-entry.js` 的 `mountCurl` vertexShader），这些顶点与其邻点构成跨屏巨三角形，与页面共面（`depthWrite: false`、`DoubleSide`），理论上会与正常页面区域发生 z-fighting 并采到被拉伸的单行纹理。把「传送出屏」改成「塌缩到折边」或「片元 discard」是候选修法；但**在没有真机复现前不应动这段代码**。
