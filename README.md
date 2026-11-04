# 墨读

墨读是一个在 DSH 里使用的阅读插件。它把书源、TXT 和 EPUB 放进同一个书架，阅读进度、笔记和设置都保存在本机。

当前版本先把文字阅读这条链路做完整：找书、加入书架、阅读、下载和追更。复杂的 JavaScript 书源、AI 和多媒体支持留到后续版本。

## 功能

- 书架、发现、目录和阅读进度
- 导入基础规则书源，按书源搜索和阅读
- 导入 TXT、EPUB，本地书籍也能整本下载
- 字号、行距、主题、系统听书、替换净化和选文笔记
- DSH 运行时每小时检查更新，重新打开后补查
- 本机持久化和备份恢复，备份不包含密码、Cookie 或令牌
- 桌面与手机布局

## 安装

需要 DSH 0.2.2-alpha.3，以及 Node.js 24.9.0 或更高版本。

```bash
git clone https://github.com/JUNQINGV587/mo-reader.git
cd mo-reader
npm ci --ignore-scripts
```

在 DSH 的插件管理中安装这个目录。安装后如果提示重启，重启 DSH，再从左侧「墨读」进入。

本项目保留 `private: true`，目前只作为本地 DSH bundle 分发，不发布到 npm。

## 书源与本地书籍

「书源」页面支持粘贴 JSON 或导入 JSON 文件。当前只支持不依赖脚本的基础规则书源；包含 JavaScript、Rhino、Java 调用或 WebView 的书源暂不能运行。

TXT 和 EPUB 可以从「设置」页面导入。EPUB 当前只导入正文，不导入图片。

请只使用自己有权访问的内容。插件不绕过登录、付费、验证码或反爬限制，也不会在 DSH 关闭后常驻追更。

## 开发

```bash
npm ci --ignore-scripts
npm test
```

测试不访问网络，覆盖书源规则、TXT/EPUB、下载任务、阅读进度、笔记、备份和真实持久化后端。GitHub Actions 会在 Node.js 24.9.0 和最新 24.x 上运行测试。

## 隐私

书源搜索、正文下载和追更会访问你配置的网站。其余阅读数据默认留在本机。HTTP 书源需要单独允许，备份会剔除常见凭据字段。

## 许可证

[MIT](LICENSE) © 2026 JUNQINGV587
