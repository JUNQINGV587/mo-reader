# ADR-0002: three.js 统一 WebGL 与真 3D 书架

- Status: Superseded by [ADR-0004](0004-native-webgl-and-2d-shelf.md)
- Date: 2026-11-04
- Deciders: JUNQINGV587, DSH agent
- Issue: [#1](https://github.com/JUNQINGV587/mo-reader/issues/1)
- Amends: [ADR-0001](0001-hybrid-webgl-reading-motion.md)

## Context

ADR-0001 选择原生 WebGL，并把 three.js 列为 Revisit 项；触发条件之一是“书架要真 3D”。维护者现在确认了这个条件，并进一步选择：

- 书架是**真 3D**：书脊、厚度、层板、相机、光照/阴影；支持拖拽转视角、点书抽出/翻开、保留列表回退。
- **全局统一**：阅读页的氛围/卷曲/光影和书架都走 three.js，不再维护两套 WebGL 渲染路径。
- **保留列表**：3D 书架之外保留列表视图，供搜索、无障碍和低端机使用。

这里的“全局统一”指**所有 WebGL 场景**统一走 three.js，不是把文字变成纹理：文字层仍是 DOM，滑动/翻转仍由 CSS 3D 负责位移，three.js 只画像素和光影。

## Decision

1. three.js 负责阅读页氛围、卷曲特效、书架三套场景；文字层保持 DOM，页面位移保持 CSS 3D。卷曲时当前页先由分页器画成 Canvas2D 行盒纹理，再由 three.js 的 `PlaneGeometry` + 自定义 shader 变形，运动结束前 150ms 交叉溶解回 DOM。
2. three.js 作为共享懒加载 chunk `client.three.js`，首次进入阅读页或书架时加载；主 `client.js` 继续负责 UI、DOM、分页、手势和状态。用 esbuild 打包并 tree-shake；若 DSH 宿主不能服务 package-local chunk，退回把 three.js 并入 `client.js`（仍可用，启动更大）。
3. 书架是真 3D：每本书是带封面/书脊/书页三个面的盒子；层板/侧板/背板有几何厚度；透视相机、方向光/环境光、阴影贴图；Raycaster 做拾取。空白处拖拽转视角，滚轮沿架移动，点书后从架上抽出/翻开再进入阅读；列表视图切换保留。
4. 远程封面纹理走服务端代理 + 缓存，复用 `lib/http.js` 的 SSRF/大小/协议校验；失败时退化为程序化书脊，不阻塞书架渲染。
5. 阅读页保留 ADR-0001 的 DOM 文字、分页、四式翻页、静态回退和 reduced motion。阅读页两个 canvas（背景在文字下、特效在文字上），各一个 context；书架一个 context；不为每页/每封面开 context。

## Consequences

Positive:

- 真 3D 书架有相机、光照、阴影、拾取，不需要手写一套 3D 引擎。
- 阅读页和书架共用 three.js 的场景/材质/几何工具，卷曲 shader 和书架光照可以共享数学与资源管理。
- three.js 懒加载，主 `client.js` 不背 3D 运行时；首次进书架/阅读页才付费。
- 文字仍是 DOM，清晰、可选中、可朗读、可访问；CSS 3D 位移不栅格化文字。

Negative:

- 新增构建步骤（esbuild）和生成文件 `client.three.js`；仓库不再是纯手写单文件。
- three.js 即使 tree-shake 也有约 90–150KB gzip；低端机首开书架有额外加载时间。
- 阅读页需要两个 WebGL context（背景/特效），比原方案多一个；需要管理 context lost/restore。
- 封面代理增加服务端请求面与缓存内存；远程封面可能失败，需要程序化书脊兜底。
- 3D 书架的阴影、纹理、拾取在低端机上比 CSS 3D 重；需要画质档和列表回退。

## Alternatives considered

- **原生 WebGL 做全部**：拒绝。真 3D 书架需要相机、光照、阴影、拾取；手写成本高于收益。
- **three.js 只做书架**：拒绝。维护者选“全局统一”，阅读页继续用原生 WebGL 会保留两套渲染路径。
- **CSS 3D 书架**：拒绝。封面倾斜/视差不是真 3D；没有书脊厚度、层板深度和相机。
- **OGL/regl 等更小库**：暂不选。包体更小，但生态/示例/阴影/加载器不如 three.js；若 three.js 包体或低端机验收不过，再作为退路。
- **把文字整体栅格化**：拒绝。选择、朗读、无障碍和清晰度都会丢；当前不接受。

## Revisit

出现以下情况时重新评估：

- three.js chunk 的 gzip/首开时间或低端机 fps 超出验收，先尝试书架专用 chunk，再考虑 OGL/regl。
- DSH 宿主无法稳定服务 package-local chunk，退回单包并重新评估体积。
- 未来接受文字整体栅格化，才考虑把文字层也放进 three.js。

## References

- 规格 issue: [#1](https://github.com/JUNQINGV587/mo-reader/issues/1)
- ADR-0001: `docs/adr/0001-hybrid-webgl-reading-motion.md`
- `GLOSSARY.md`
