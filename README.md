# 墨读

在 DSH 中复刻「阅读」(Legado) 的阅读插件：书源、订阅、本地书、漫画/音频/视频、阅读页与书源编辑器。

> 状态：M2 完成（2026-11-25）。已交付书源与订阅、本地 TXT/EPUB/PDF/MOBI/AZW/AZW3 导入、书架书目迁移、自定义字体与阅读主题、漫画/音频/视频、TXT/EPUB 导出、笔记/替换/朗读；PDF 原版面渲染归入 M4。计划见《202611-墨读复刻阅读：设计与实施计划》。

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
