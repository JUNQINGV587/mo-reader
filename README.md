# 墨读

在 DSH 中复刻「阅读」(Legado) 的阅读插件：书源、订阅、本地书、漫画/音频/视频、阅读页与书源编辑器。

> 状态：M2 完成（2026-11-25）。已交付书源与订阅、本地 TXT/EPUB/PDF/MOBI/AZW/AZW3 导入、书架书目迁移、自定义字体与阅读主题、漫画/音频/视频、TXT/EPUB 导出、笔记/替换/朗读。计划见《202611-墨读复刻阅读：设计与实施计划》。

## PDF 原版阅读

本地导入的 PDF 默认按原页面渲染（翻页、跳页、50%–300% 缩放、适应宽度），阅读页与详情页都能一键切到文本模式；两种进度分别保存，互不覆盖。原版模式不生成文字层，选词、搜索与笔记请切到文本模式。

PDF 原版渲染使用 pdfjs-dist。宿主只加载打包后的 `dist/client/client.js`，因此 PDF worker 以内联方式打进同一个 bundle。cmaps 与标准字体取自安装的 pdfjs-dist，由本地服务按 `/reader/pdfjs/` 提供（与导入路径同一套资源，不走 CDN），未嵌入字形的中文 PDF 也能正常显示；内联 worker 是 data: URL，资源必须由主线程加载（`useWorkerFetch: false`），交给 worker 的只是解析结果。

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
