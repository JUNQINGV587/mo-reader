# 交接：shelf-options → React + Vite（TypeScript）

> 给写代码的模型看：照这份把设计稿做成真页面。设计稿就是源码——每屏一个 HTML，样式在 tokens.css 等样式表里。先读源文件，截图只用来对照，别凭截图猜数值。

## 做什么

- 设计目录：`/data/reader/.scratch/shelf-options`（12 屏，desktop 1280×800）
- 做到：`/data/reader`（现有项目 @local/mo-reader：没认出框架，包管理 npm）
- 框架：React + Vite（TypeScript）
- 生成时间：2026-11-05 16:16

## 桌面软件要点

- 这是桌面软件的设计（窗口内容 1280×800）。要做成真软件：Electron 或 Tauri 套网页，框架选的「React + Vite（TypeScript）」写界面；用户要原生（SwiftUI / WinUI）就先问清。
- 窗口按钮是系统画的：Mac 用无边框标题栏（Electron `titleBarStyle: 'hiddenInset'`，Tauri `titleBarStyle: 'Overlay'`），红绿灯盖在左上角，设计稿左上空出的 80×52 照留；顶栏可拖动的地方加 `-webkit-app-region: drag`，按钮、输入框加 `no-drag`。Windows 用自定义标题栏时右上角 138×32 留给系统按钮（Electron `titleBarOverlay`）。
- 整个窗口不滚，侧栏、列表、详情各自滚（`overflow: auto`）；最小窗口尺寸照设计里最小的那种（多尺寸里的 1024×680）设。

## 屏幕和路由

| 屏 | 设计文件 | 建议路由 | 截图（handoff/shots/） | 跳到 |
| --- | --- | --- | --- | --- |
| 方案 A · 封面网格 | a-grid.html | `/a-grid` | a-grid-1.jpg | — |
| 方案 B · 层板书架 | b-shelf.html | `/b-shelf` | b-shelf-1.jpg | — |
| 方案 C · 书脊书架 | c-spines.html | `/c-spines` | c-spines-1.jpg | — |
| 方案 D · 阅读主页 | d-editorial.html | `/d-editorial` | d-editorial-1.jpg、d-editorial-2.jpg | — |
| 方案 E · A+D 合体 | e-mixed.html | `/e-mixed` | e-mixed-1.jpg、e-mixed-2.jpg | — |
| 方案 E · A+D 合体 | d1.html | `/d1` | d1-1.jpg、d1-2.jpg | — |
| 方案 E · A+D 合体 | d2.html | `/d2` | d2-1.jpg、d2-2.jpg | — |
| 方案 E · A+D 合体 | d3.html | `/d3` | d3-1.jpg、d3-2.jpg | — |
| 方案 E · A+D 合体 | d4.html | `/d4` | d4-1.jpg、d4-2.jpg | — |
| 方案 E · A+D 合体 | s1-editorial.html | `/s1-editorial` | s1-editorial-1.jpg、s1-editorial-2.jpg | — |
| 方案 E · A+D 合体 | s2-swiss.html | `/s2-swiss` | s2-swiss-1.jpg、s2-swiss-2.jpg | — |
| 方案 E · A+D 合体 | s3-dark.html | `/s3-dark` | s3-dark-1.jpg、s3-dark-2.jpg | — |

## 设计变量

`tokens.css` 里 37 个变量（颜色 0 个：）。

- 把 tokens.css 原样放进项目的全局样式（如 `src/styles/tokens.css`）并在入口引入；组件样式里一律用 `var(--…)`，别写死色值、字号。
- 别的样式表：`shell.css`（公共样式，拆进对应组件或全局样式）

## 几屏共用的部分（做成组件）

- `.actions`：12 屏都有（a-grid、b-shelf、c-spines、d-editorial、e-mixed、d1、d2、d3、d4、s1-editorial、s2-swiss、s3-dark）→ `Actions` 组件
- `.app`：12 屏都有（a-grid、b-shelf、c-spines、d-editorial、e-mixed、d1、d2、d3、d4、s1-editorial、s2-swiss、s3-dark）→ `App` 组件
- `.brand`：12 屏都有（a-grid、b-shelf、c-spines、d-editorial、e-mixed、d1、d2、d3、d4、s1-editorial、s2-swiss、s3-dark）→ `Brand` 组件
- `.ghost`：12 屏都有（a-grid、b-shelf、c-spines、d-editorial、e-mixed、d1、d2、d3、d4、s1-editorial、s2-swiss、s3-dark）→ `Ghost` 组件
- `.head`：12 屏都有（a-grid、b-shelf、c-spines、d-editorial、e-mixed、d1、d2、d3、d4、s1-editorial、s2-swiss、s3-dark）→ `Head` 组件
- `.main`：12 屏都有（a-grid、b-shelf、c-spines、d-editorial、e-mixed、d1、d2、d3、d4、s1-editorial、s2-swiss、s3-dark）→ `Main` 组件
- `.nav`：12 屏都有（a-grid、b-shelf、c-spines、d-editorial、e-mixed、d1、d2、d3、d4、s1-editorial、s2-swiss、s3-dark）→ `Nav` 组件
- `.side`：12 屏都有（a-grid、b-shelf、c-spines、d-editorial、e-mixed、d1、d2、d3、d4、s1-editorial、s2-swiss、s3-dark）→ `Side` 组件
- `.stage`：12 屏都有（a-grid、b-shelf、c-spines、d-editorial、e-mixed、d1、d2、d3、d4、s1-editorial、s2-swiss、s3-dark）→ `Stage` 组件
- `.toggle`：12 屏都有（a-grid、b-shelf、c-spines、d-editorial、e-mixed、d1、d2、d3、d4、s1-editorial、s2-swiss、s3-dark）→ `Toggle` 组件
- `.book`：11 屏都有（a-grid、b-shelf、d-editorial、e-mixed、d1、d2、d3、d4、s1-editorial、s2-swiss、s3-dark）→ `Book` 组件
- `.grid`：10 屏都有（a-grid、d-editorial、e-mixed、d1、d2、d3、d4、s1-editorial、s2-swiss、s3-dark）→ `Grid` 组件
- `.cta`：9 屏都有（d-editorial、e-mixed、d1、d2、d3、d4、s1-editorial、s2-swiss、s3-dark）→ `Cta` 组件
- `.library`：9 屏都有（d-editorial、e-mixed、d1、d2、d3、d4、s1-editorial、s2-swiss、s3-dark）→ `Library` 组件

## 交互和状态

- 设计稿里没有脚本和表单，纯展示。
- 悬停 / 聚焦 / 按下的样式 28 处：照搬，别丢。

## 图片和字体

- 没有单独的图片、字体文件（图形都写在 HTML / SVG 里）。

## 做法和验收

1. 搭骨架：在现有项目里加页面和路由（看清它现有的目录结构、样式写法、组件库再动手）；把 tokens.css（和公共样式表）搬进去。
2. 一屏一个页面，路由照上面的表；先抽几屏共用的组件，再拼页面。
3. 结构、文案、数字、图标照设计稿的 HTML 搬；class 名可以改成项目的习惯，样式值（间距、字号、颜色、圆角、阴影）一律用设计变量。
4. 每做完一屏：把开发服务器跑起来，调 `compare_design`（screen 填设计文件名，url 填这一屏在开发服务器上的地址），照差异图把不一样的地方改掉，直到差异在 3% 以内，或者剩下的差别说得出理由（比如真实数据、系统字体）。
5. 全部做完：每屏再对一遍；告诉用户做了哪些页面、怎么跑起来（命令和地址）、还有哪里和设计稿不一样。

别做：改设计（配色、文案、布局）、加设计稿里没有的功能、引入新的 UI 组件库（项目已经在用的除外）。
