# ADR-0001: 混合渲染的 WebGL 阅读动效

- Status: Accepted; amended by [ADR-0002](0002-threejs-webgl-and-3d-shelf.md); further amended by [ADR-0004](0004-native-webgl-and-2d-shelf.md)
- Date: 2026-11-04
- Deciders: JUNQINGV587, DSH agent
- Issue: [#1](https://github.com/JUNQINGV587/mo-reader/issues/1)

## Context

墨读是 DSH 插件：Node 侧 `ReaderService`（cordis service）+ 浏览器侧单文件 `client.js`（`window.__ModuleLoader__`）。阅读页目前是 DOM 文本滚动，只有 CSS 过渡。需求是加入流畅的 WebGL 动画，同时保持文字清晰、可选中、可朗读，并且不脱离 DSH。

可选路线：Go sidecar、Go→WASM、纯 WebGL 文字、CSS-only 翻页、混合渲染。

## Decision

1. 不用 Go。动画与 WebGL 全部用 JS。
2. 文字层保持 DOM；WebGL 负责翻页变形、光影、纸张/尘埃；CSS 3D 负责页面位移/旋转。
3. 卷曲纹理由分页器直接绘制到 Canvas2D（按行盒），不引入 `html2canvas`；运动结束前 150ms 交叉溶解回 DOM。
4. 阅读页背景/特效各一个 WebGL context，书架一个；共用一套 three.js 场景管理器（见 ADR-0002），不给每张封面/每页单开。
5. 无 WebGL 或 reduced motion 时静态可读、瞬时翻页；不做 CSS 动画降级。
6. 主 `client.js` 保持单文件；three.js 作为共享懒加载 chunk（见 ADR-0002）。

## Consequences

Positive:

- 文字全程清晰（除卷曲运动期间），选择/朗读/无障碍不受影响。
- 不需要改 DSH，也不需要 sidecar/IPC/多平台二进制。
- 主包体可控：three.js 在共享懒加载 chunk 里，不进首屏主包（见 ADR-0002）。

Negative:

- 卷曲需要一套 Canvas 纹理路径，和 DOM 渲染要保持断行/字体一致；实现复杂度高。
- 双渲染路径（DOM + Canvas）需要同步主题、字号、DPR。
- WebGL context 丢失、低端机掉帧需要降级处理。
- 双栏 + 卷曲的“一次翻一页”是数字模型，不是严格书页物理。

## Alternatives considered

- **Go sidecar**：拒绝。各平台二进制、IPC、生命周期、升级；违背“完全依托 DSH”。
- **Go→WASM**：拒绝。约 2MB + `wasm_exec` glue，与 ModuleLoader 单文件同步加载别扭。
- **纯 WebGL 文字**：拒绝。文字会糊，选择/朗读/无障碍全丢。
- **CSS-only 卷曲**：拒绝。分条 transform 会切字，和“流畅”目标冲突；用户选混合。
- **html2canvas**：拒绝。增加依赖与体积，CSS/字体保真不可控；页面结构已知，自己画更稳。
- **three.js**：先后被 [ADR-0002](0002-threejs-webgl-and-3d-shelf.md) 引入、又被 [ADR-0004](0004-native-webgl-and-2d-shelf.md) 移除。当前阅读页用原生 WebGL，书架用 2D，文字仍是 DOM。

## Revisit

ADR-0002 引入、ADR-0004 去掉了 three.js；以下条件仍保留：

- 如果 three.js chunk 的 gzip/首开时间或低端机 fps 不过验收，考虑书架专用 chunk 或 OGL/regl。
- 如果 DSH 宿主不能稳定服务 package-local chunk，退回单包并重新评估体积。
- 如果接受把文字页整体栅格化，才考虑把文字层也放进 three.js（当前不接受）。

## References

- 规格 issue: [#1](https://github.com/JUNQINGV587/mo-reader/issues/1)
- `GLOSSARY.md`
