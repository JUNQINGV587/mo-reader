# ADR-0003: 动画设置、每本覆盖与可恢复进度

- Status: Accepted
- Date: 2026-11-04
- Deciders: JUNQINGV587, DSH agent
- Issue: [#1](https://github.com/JUNQINGV587/mo-reader/issues/1)
- Amends: [ADR-0002](0002-threejs-webgl-and-3d-shelf.md)

## Context

ADR-0001/0002 把翻页、氛围和 3D 书架做出来了，但设置只覆盖排版，阅读方式与翻页效果此前存在浏览器 localStorage 里，不进备份、不能被服务端读取，也无法按书覆盖。验收还要求：无 WebGL 可读、减少动态无位移、进度在改字号后仍落在同一段文字。

## Decision

1. **设置只有一份真源**：`mode`、`flipStyle`、`animations`、`motionQuality`、`ambience`、`shelfMotion`、`reducedMotion` 进 `DEFAULT_SETTINGS`，经 `normalizeSettings` 校验后持久化在服务端；删除阅读页的 localStorage 读写。
2. **每本覆盖只限三项**：`book.readerPrefs` 只允许 `mode`、`flipStyle`、`ambience`，用 `setBookSettings` 写入；其余设置永远跟随全局。未知键直接拒绝，不做静默忽略。清除覆盖用 `clear: true`。
3. **读路径先里后外**：阅读页先取 `readerPrefs`，再取全局设置，最后取默认值；设置页修改全局，抽屉在「本书单独设定」后才写 `readerPrefs`。
4. **进度按字符 offset 恢复**：`saveProgress` 同时保存 percent 与 offset。分页布局用 `caretRangeFromPoint` 取当前页首字符的章节内 offset，改字号/分栏/窗口时用 `Range` 把 offset 反查成列号；旧数据没有 offset 时退回 percent 估算。
5. **降级阶梯**：`supportsWebGL()` 为假 → 不加载 three.js、书架回退列表、翻页瞬时；`reducedMotion`/系统偏好/动画开关关闭 → 不播位移动画，只保留 300ms 章节名淡出；书架动效关闭 → 书架直接走列表。

## Consequences

Positive:

- 设置进备份、可测试、跨设备一致；每本书的阅读方式不会互相污染。
- 字符 offset 让字号与分栏改变后仍停在同一段文字，比 percent 稳。
- 降级路径不再依赖「恰好有 WebGL」，低端机和减少动态用户都能读。

Negative:

- 服务端多一个远程方法 `setBookSettings`，`readerPrefs` 进入 book 的持久化结构，迁移面变大。
- offset 依赖 DOM 文本节点顺序；章节内容若在两次阅读之间被替换，offset 可能落在相近位置而非精确原处，仍以 percent 兜底。
- 两份设置（全局与每本）需要在 UI 上解释「跟随全局 / 本书单独设定」，文案成本增加。

## Alternatives considered

- **全部设置都按书覆盖**：拒绝。备份、排障和 UI 都会膨胀；只有阅读方式相关三项值得按书区分。
- **继续用 localStorage**：拒绝。备份带不走，服务端不可见，测试无法覆盖。
- **只用 percent**：拒绝。字号或分栏变化后 percent 指向不同段落，验收不通过。
- **无 WebGL 时仍播 CSS 翻页**：拒绝。验收要求静态可读与瞬时翻页，CSS 位移在无 WebGL 机器上也不能保证流畅。

## References

- 规格 issue: [#1](https://github.com/JUNQINGV587/mo-reader/issues/1)
- ADR-0001: `docs/adr/0001-hybrid-webgl-reading-motion.md`
- ADR-0002: `docs/adr/0002-threejs-webgl-and-3d-shelf.md`
