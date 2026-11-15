# 墨读

在 DSH 中复刻「阅读」(Legado) 的阅读插件：书源、订阅、本地书、漫画/音频/视频、阅读页与书源编辑器。

> 状态：M0 骨架（2026-11-15）。旧实现已移除，正在按《202611-墨读复刻阅读：设计与实施计划》重建。

## 结构

```text
src/
  core/     与平台无关的核心（数据模型、规则引擎、解析、网络、备份）
  server/   DSH 适配层（Remote、存储、抓取代理、任务）
  web/      Vue 3 界面与 DSH 槽位桥接
test/       构建产物冒烟测试（node --test）
```

## 开发

```bash
npm install
npm run typecheck
npm run build
npm test
```

## 许可

GPL-3.0-only。源自「阅读」(Legado) 的部分按 GPL-3.0 发布，见 `NOTICE` 与 `LICENSE`。
