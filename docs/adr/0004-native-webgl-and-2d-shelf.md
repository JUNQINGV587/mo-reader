# ADR-0004: 原生 WebGL 阅读页与 2D 书架（去 three.js）

- Status: Accepted
- Date: 2026-11-05
- Deciders: JUNQINGV587, DSH agent
- Issue: [#10](https://github.com/JUNQINGV587/mo-reader/issues/10)
- Supersedes: [ADR-0002](0002-threejs-webgl-and-3d-shelf.md)
- Amends: [ADR-0001](0001-hybrid-webgl-reading-motion.md), [ADR-0003](0003-settings-and-degradation.md)

## Context

ADR-0002 把阅读页氛围/卷曲和书架统一到 three.js：一个共享懒加载 chunk、一个 esbuild 构建步骤、书架额外一个 WebGL context。运行一段时间后，维护者提出两条新约束：

- 书架不必再用 three.js；
- 能减掉的构建与运行时都减掉。

维护者随后进一步明确：书架不要 3D 模型。同时，iPad Safari 上卷曲的横向条带一直未解决，默认阅读方式已改为滚动，卷曲不再是核心体验。调研结论（CSS 3D 书架边界、连续滚动可用的 WebGL 路径）表明：

- 书架要的只是陈列、找书、打开；2D 排面（封面按排摆在横向层板上）足够，且天然可访问；不需要透视、拖拽和 3D 相机。
- 阅读页连续滚动的动效只能是文字背后的材质/光，以及文字边缘很薄的一层；抓文字像素去变形在滚动里不可行。
- 卷曲是顶点位移曲面，CSS 3D 做不出；原生 WebGL 只写卷曲的代价高于收益，直接去掉卷曲更稳。

## Decision

1. **书架改用 2D 排面**：封面按排摆在横向层板上，行底线用 CSS 层板/阴影；书是 DOM button，支持键盘/读屏；不再有透视、拖拽和滚轮换层；每行按容器宽度自适应列数，最多 48 本。
2. **书架打开过渡不再要 canvas 快照**：点封面时取封面元素的 `getBoundingClientRect()` 和封面图，走 OpenTransition 已有的无快照分支。
3. **书架可访问性优先**：书是可聚焦 button，支持 Tab、读屏、DOM 顺序、Ctrl+F；列表视图保留为回退；无 WebGL 不再拦截书架。
4. **阅读页改用原生 WebGL**：新模块 `client.gl.js`（懒加载、不打包、ESM export `mountAmbience`）手写一个 WebGL1 context，负责纸纹、柔光、接缝、尘埃和上下纸轴；文字永远留在 DOM，不做栅格化。
5. **滚动驱动**：`scroll` 事件只写目标值；rAF 读 `scrollTop` 做指数平滑，得到 `uScroll`（0..1）和带符号的 `uVelocity`；速度带动柔光/纸纹/尘埃，停下 300–500ms 回落；`scrollend` + 120ms、8s 空闲停帧；边缘 1–2 行用 CSS mask 渐隐。
6. **去掉卷曲**：`FLIP_STYLES` 只保留 `slide`/`flip`/`fade`；旧全局、每本、备份和存储 schema 里的 `curl` 一律读成 `flip`；设置键不新增。
7. **删除 three.js 与构建**：移除 `src/three-entry.js`、`client.three.js`、`npm run build:three`、esbuild 和 three 的 devDependency、package files 中的 `client.three.js`；`client.gl.js` 手写维护。
8. **设置口径不变**：`ambience` 的三档 `full`/`paper`/`off` 继续有效（full=轴+光+尘，paper=静态纸，off=无）；书架不再有独立动效开关（`shelfMotion` 已删除，旧记录里的该键被忽略）；`supportsWebGL` 只影响阅读页氛围，书架 2D 照常。
9. **测试接缝**：Node 测试覆盖设置/迁移与纯函数；`client.js` 的 `__test` 暴露 `shelfLayout`、`scrollMotion`；DOM/WebGL 走手动清单，暂不引入 Playwright。

## Consequences

Positive:

- 包体减少：三入口 three.js 约 569,209 B / gzip 144,706 B，全项目去掉后减约 557 KiB / 142 KiB gzip，并去掉构建步骤和 devDependency。
- 阅读页只保留一个 WebGL context，书架不再占 context；context 丢失只需走静态回退。
- 书架从 canvas 位图变成 DOM，键盘、读屏、选中、Ctrl+F 都成立；这是 2D 书架的主要收益。
- 书架不再有 preserve-3d 的 Safari 拍平/错位风险；CSS 和 DOM 简单，首开更快。
- 不再维护 esbuild 生成物，仓库回到手写源码；less moving parts。

Negative:

- 2D 排面没有真实厚度、透视和遮挡；陈列感靠封面、层板和阴影。
- 书架没有拖拽/滚轮换层，书多时靠滚动；48 本上限仍是硬约束。
- 阅读页原生 WebGL 需要自己维护 shader、纹理、context lost、DPR 和降级逻辑；`client.gl.js` 不受 Node 测试覆盖，只能靠手动清单。
- 滚动纸轴的厚度、速度映射和短章节隐藏是纯函数 + 手动观感，边界（iPad、低端机、深色主题）需要逐项验收。

## Alternatives considered

- **保留 CSS 3D 书架**：拒绝。维护者要求书架不要 3D 模型；2D 排面更简单，且没有 preserve-3d 兼容风险。
- **保留 three.js 全局统一**：拒绝。维护者要求去掉书架 three，且全项目减包；three.js 只剩阅读页一个场景，收益不足以支撑 chunk 和构建。
- **CSS 3D 也做阅读页卷曲**：拒绝。CSS 3D 只有平面变换，元素没有深度；做不出顶点位移的卷页曲面。
- **原生 WebGL 写书架**：拒绝。相机、光照、阴影、拾取都要手写，成本高于 2D 排面，且失去 DOM 可访问性。
- **只去书架，阅读页留 three**：拒绝。包体只省约 24.8 KB / 8.1 KB gzip，阅读页仍拉 three，构建也留着；维护者选全项目去掉。
- **书架只留列表**：拒绝。陈列感是书架的核心价值；2D 排面已足够，列表保留为回退即可。

## Revisit

出现以下情况时重新评估：

- 书架 2D 排面在 iPad/手机上封面过小或层板挤压，先调整列数和封面比例，再考虑更简的列表。
- 阅读页原生 WebGL 在低端机或 iPad 上持续掉帧，先降 DPR/尘埃/纸轴复杂度，再考虑把纸轴退回 CSS。
- 如果未来接受文字整体栅格化，才重新讨论卷曲或文字形变；当前不接受。
- 如果未来需要真 3D 陈列，再评估原生 WebGL 书架；当前 2D 排面优先。

## References

- 规格 issue: [#10](https://github.com/JUNQINGV587/mo-reader/issues/10)
- 实施票: [#11](https://github.com/JUNQINGV587/mo-reader/issues/11)–[#18](https://github.com/JUNQINGV587/mo-reader/issues/18)
- ADR-0001: `docs/adr/0001-hybrid-webgl-reading-motion.md`
- ADR-0002: `docs/adr/0002-threejs-webgl-and-3d-shelf.md`
- ADR-0003: `docs/adr/0003-settings-and-degradation.md`
- `GLOSSARY.md`
