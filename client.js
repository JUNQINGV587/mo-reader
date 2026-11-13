/* shelf-3d build: 2026-11-04T12:22 */
window.__ModuleLoader__.load({
  id: '@local/mo-reader',
  factory(require) {
    const React = require('react');
    const { z } = require('zod');
    const h = React.createElement;
    const { useEffect, useLayoutEffect, useMemo, useRef, useState } = React;
    const PANEL_ID = 'reader';
    const REMOTE_METHODS = [
      'state', 'importSource', 'addSubscriptions', 'subscribeSourceLibrary', 'refreshSubscription', 'confirmSubscriptionUpdate', 'rejectSubscriptionUpdate', 'removeSubscription', 'removeSource', 'setSourceEnabled', 'restoreBuiltinSources', 'search', 'discover', 'addBook', 'removeBook',
      'toc', 'chapter', 'saveProgress', 'download', 'cancelJob', 'cancelDownloadChapters', 'pauseJob', 'resumeJob', 'checkUpdates', 'importLocal', 'mediaCacheStats', 'listMediaCache', 'setChapterRetained',
      'setSettings', 'setBookSettings', 'saveNote', 'deleteNote', 'exportBackup', 'importBackup', 'fetchCover',
      'cacheBookCover', 'bookCandidates', 'applyBookMeta',
      'createFolder', 'renameFolder', 'removeFolder', 'moveBooksToFolder', 'batchDeleteBooks', 'batchDownloadBooks', 'exportBook', 'markBookRead', 'exportNotes',
      'aiSummarize', 'aiTranslate', 'aiAsk',
    ];
    const jsonCodec = () => ({ mode: 'strict', typeSymbol: '@local/mo-reader#Json', create: () => z.json() });
    const readerContribution = {
      package: '@local/mo-reader',
      descriptors: REMOTE_METHODS.map((method) => ({
        id: `@local/mo-reader#reader/${method}`,
        package: '@local/mo-reader', namespace: 'reader', service: 'reader', method,
        invocation: { kind: 'direct' },
        parameters: [{ name: 'args', wire: 'args', source: 'json', acceptsUndefined: true, codec: jsonCodec() }],
        result: jsonCodec(),
      })),
    };
    const DEFAULT_SETTINGS = {
      fontSize: 20,
      lineHeight: 1.9,
      fontFamily: 'serif',
      readerTheme: 'paper',
      ttsRate: 1,
      ttsEngine: 'system', // system | azure | iflytek | baidu
      ttsVoice: '',
      ttsPitch: 1,
      ttsVolume: 1,
      replacements: [],
      mode: 'scroll',
      flipStyle: 'slide',
      measureWidth: 960,
      animations: true,
      motionQuality: 'auto',
      ambience: 'full',
      reducedMotion: 'system',
    };

    const SHELF_CATEGORIES = [
      { id: 'novel', label: '小说', icon: 'book', unit: '本', blurb: '长篇与短篇，都在这一排。', empty: '去发现搜书，或导入本地书籍。' },
      { id: 'comic', label: '漫画', icon: 'comic', unit: '本', blurb: '画格连载，按章往下读。', empty: '导入漫画书源后，作品会出现在这里。' },
      { id: 'audio', label: '音频', icon: 'audio', unit: '本', blurb: '听书与播客，戴上耳机继续。', empty: '导入音频书源后，作品会出现在这里。' },
      { id: 'video', label: '视频', icon: 'video', unit: '本', blurb: '影视与课程，按集播放。', empty: '导入视频书源后，作品会出现在这里。' },
      { id: 'website', label: '网页', icon: 'web', unit: '个', blurb: '网站入口，点击在浏览器打开。', empty: '在书源里添加网站源，启用后会出现在这里。' },
      { id: 'subscription', label: '订阅', icon: 'rss', unit: '份', blurb: '订阅源的最新条目，按时间倒序。', empty: '在书源里导入 Legado 订阅源，勾选分类后会出现在这里。' },
    ];
    const SHELF_CATEGORY_IDS = new Set(SHELF_CATEGORIES.map((item) => item.id));
    const BOOK_CONTENT_TYPES = new Set(['novel', 'comic', 'audio', 'video', 'subscription']);
    function bookContentType(book) {
      const value = book?.contentType;
      return BOOK_CONTENT_TYPES.has(value) ? value : 'novel';
    }
    function mediaLocalUrl(id) {
      return id ? `/api/reader/media?id=${encodeURIComponent(id)}` : '';
    }
    function mediaProxyUrl(bookId, chapterId, extra = '') {
      return bookId && chapterId
        ? `/api/reader/proxy?bookId=${encodeURIComponent(bookId)}&chapterId=${encodeURIComponent(chapterId)}${extra ? `&${extra}` : ''}`
        : '';
    }
    let hlsPlayerPromise = null;
    function nativeHlsSupported() {
      const ua = navigator.userAgent || '';
      if (/iPad|iPhone|iPod/i.test(ua)) return true;
      return /AppleWebKit/i.test(ua) && !/Chrome|Android|Edg|Firefox/i.test(ua);
    }
    function loadHlsPlayer() {
      if (globalThis.Hls) return Promise.resolve(globalThis.Hls);
      if (hlsPlayerPromise) return hlsPlayerPromise;
      hlsPlayerPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/api/reader/hls.js';
        script.async = true;
        script.onload = () => globalThis.Hls ? resolve(globalThis.Hls) : reject(new Error('HLS 播放器未就绪'));
        script.onerror = () => reject(new Error('HLS 播放器加载失败'));
        document.head.appendChild(script);
      }).catch((error) => { hlsPlayerPromise = null; throw error; });
      return hlsPlayerPromise;
    }
    function mediaChapterSource(book, chapter) {
      const type = bookContentType(book);
      if (!chapter) return { kind: 'empty', error: '这一章还没有可用的媒体。' };
      if (type === 'comic') {
        const offline = Array.isArray(chapter.offline?.images) ? chapter.offline.images.map(mediaLocalUrl) : [];
        const images = offline.length ? offline : (Array.isArray(chapter.images) ? chapter.images.map((url, index) => /^https?:/i.test(url) ? mediaProxyUrl(book.id || book.bookId, chapter.id, `image=${index}`) : url) : []);
        return images.length ? { kind: 'images', images } : { kind: 'error', error: '这一章没有可显示的图片。' };
      }
      if (type === 'audio' || type === 'video') {
        const offline = chapter.offline;
        const offlineId = offline?.playlistId || offline?.mediaId;
        if (offlineId) {
          const hls = offline?.kind === 'hls' || /\.m3u8(?:[?#]|$)/i.test(offline?.playlistUrl || '');
          return { kind: 'media', url: mediaLocalUrl(offlineId), offline: true, hls: hls && !nativeHlsSupported() };
        }
        if (!chapter.mediaUrl) return { kind: 'error', error: '这一章缺少媒体地址。' };
        const url = mediaProxyUrl(book.id || book.bookId, chapter.id);
        if (!url) return { kind: 'error', error: '缺少章节媒体地址。' };
        const hls = /\.m3u8(?:[?#]|$)/i.test(chapter.mediaUrl || '');
        return { kind: 'media', url, offline: false, hls: hls && !nativeHlsSupported() };
      }
      return { kind: 'error', error: '不支持这种媒体类型。' };
    }
    function comicPageFromProgress(book, chapter, total) {
      if (!book?.progress || book.progress.chapterId !== chapter?.id || total <= 0) return 0;
      return Math.min(total - 1, Math.max(0, Math.floor(Number(book.progress.offset) || 0)));
    }
    function mediaStartSeconds(book, chapter) {
      if (!book?.progress || book.progress.chapterId !== chapter?.id) return 0;
      return Math.max(0, Number(book.progress.offset) || 0);
    }
    function mediaProgressPayload(chapterId, used, total) {
      const safeTotal = Math.max(1, Number(total) || 1);
      const value = Math.min(safeTotal, Math.max(0, Number(used) || 0));
      return { chapterId, offset: Math.floor(value), percent: Math.min(100, Math.max(0, value / safeTotal * 100)) };
    }
    function formatMediaTime(value) {
      const seconds = Math.max(0, Math.floor(Number(value) || 0));
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor(seconds % 3600 / 60);
      const secs = seconds % 60;
      return hours ? `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${mins}:${String(secs).padStart(2, '0')}`;
    }
    function formatBytes(value) {
      const bytes = Number(value) || 0;
      if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes % 1024 ** 3 ? 1 : 0)} GB`;
      if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
      return `${Math.max(0, Math.round(bytes / 1024))} KB`;
    }
    function booksForShelfCategory(books, categoryId) {
      if (!SHELF_CATEGORY_IDS.has(categoryId) || categoryId === 'website') return [];
      return (books || []).filter((book) => bookContentType(book) === categoryId);
    }
    function enabledWebsiteSources(sources) {
      return (sources || []).filter((source) => source?.contentType === 'website' && source.enabled !== false);
    }
    function websiteTarget(source, query = '') {
      const term = String(query || '').trim();
      const template = term && source?.searchUrl ? source.searchUrl : source?.homeUrl;
      return template ? template.replace(/\{\{\s*key\s*\}\}/g, encodeURIComponent(term)) : null;
    }
    function openExternalWebsite(source, query = '') {
      const url = websiteTarget(source, query);
      if (!url) return null;
      window.open(url, '_blank', 'noopener');
      return url;
    }
    function websiteHost(source) {
      try { return new URL(source.homeUrl).hostname; }
      catch { return source.homeUrl; }
    }

    function prefersReducedMotion() {
      try { return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true; }
      catch { return false; }
    }

    function supportsWebGL() {
      try {
        const canvas = document.createElement('canvas');
        return Boolean(window.WebGLRenderingContext && (canvas.getContext('webgl2') || canvas.getContext('webgl')));
      } catch { return false; }
    }

    // Pure page geometry shared by the paged view and the node tests. Keep
    // these free of DOM access so a layout change cannot hide a rounding bug.
    const paginationMath = Object.freeze({
      totalColumns(scrollWidth, pageWidth, gap) {
        return Math.max(1, Math.ceil(Number(scrollWidth) / (pageWidth + gap)));
      },
      pageCount(totalColumns, columns) {
        return Math.max(1, columns === 1 ? totalColumns : totalColumns - columns + 1);
      },
      pageForPercent(percent, pages) {
        if (!(pages > 1)) return 0;
        const value = Math.max(0, Math.min(100, Number(percent) || 0));
        return Math.max(0, Math.min(pages - 1, Math.round(value / 100 * (pages - 1))));
      },
      percentForPage(page, pages) {
        if (!(pages > 1)) return 0;
        const value = Math.max(0, Math.min(pages - 1, Number(page) || 0));
        return Math.round(value / (pages - 1) * 100);
      },
      columnForAnchor({ anchorLeft, pageIndex, pageStep, layoutLeft, step, pages }) {
        const untranslatedLeft = anchorLeft + pageIndex * pageStep;
        const column = Math.floor((untranslatedLeft - layoutLeft + 1) / step);
        return Math.max(0, Math.min(pages - 1, column));
      },
    });

    // Pure scroll-driven motion math for the scroll reader: progress, axis
    // thickness and smoothing are DOM-free so the node tests can pin them.
    const scrollMotion = Object.freeze({
      progress(value) {
        return Math.max(0, Math.min(1, Number(value) || 0));
      },
      axis(progress, viewport, options = {}) {
        const height = Math.max(0, Number(viewport) || 0);
        if (options.short || !(height > 0)) return { top: 0, bottom: 0, visible: false };
        const ratio = scrollMotion.progress(progress);
        const min = 5;
        const max = Math.min(44, Math.max(24, height * 0.06));
        const top = options.still ? min : min + ratio * (max - min);
        const bottom = options.still ? min : min + (1 - ratio) * (max - min);
        return { top, bottom, visible: true, min, max };
      },
      smooth(current, target, dt, lambda = 7) {
        const step = 1 - Math.exp(-lambda * Math.max(1, Number(dt) || 1) / 1000);
        return Number(current) + (Number(target) - Number(current)) * step;
      },
      velocity(previous, current, dt) {
        return (Number(current) - Number(previous)) * 1000 / Math.max(16, Number(dt) || 16);
      },
    });

    function plainText(value) {
      return String(value == null ? '' : value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    }

    function withTimeout(promise, ms) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`请求超过 ${Math.round(ms / 1000)} 秒，已跳过`)), ms);
        Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
      });
    }

    async function call(ctx, method, args) {
      const result = await ctx.remote.reader[method](args);
      if (result && result.ok === false) {
        const error = result.error;
        throw new Error(typeof error === 'string' ? error : error?.message || '操作失败');
      }
      return result && result.ok === true ? result.value : result;
    }

    function Glyph({ name, size = 20 }) {
      const paths = {
        book: 'M5 4.5c4-1.2 7-.3 9 2 2-2.3 5-3.2 9-2v16c-4-1.2-7-.3-9 2-2-2.3-5-3.2-9-2zM14 6.5v16',
        shelf: 'M4 4h16v16H4zM8 4v16M4 9h16',
        compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z',
        source: 'M8 5H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M8 19H5a2 2 0 0 1-2-2v-3m13 5h3a2 2 0 0 0 2-2v-3M8 12h8',
        settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19 12l2-1-2-4-2 .5L15 5h-6L7 7.5 5 7l-2 4 2 1v4l-2 1 2 4 2-.5L9 23h6l2-2.5 2 .5 2-4-2-1z',
        plus: 'M12 5v14M5 12h14',
        search: 'M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15zM16 16l5 5',
        back: 'M15 5l-7 7 7 7',
        next: 'M9 5l7 7-7 7',
        list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
        download: 'M12 3v12m-5-5 5 5 5-5M5 21h14',
        refresh: 'M20 6v5h-5M4 18v-5h5M6.1 8a7 7 0 0 1 11.8-2L20 11M4 13l2.1 5a7 7 0 0 0 11.8-2',
        trash: 'M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6',
        folder: 'M3 7h7l2 2h9v10H3zM3 7V5h7l2 2',
        note: 'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5',
        play: 'M8 5l11 7-11 7z',
        pause: 'M8 5v14M16 5v14',
        stop: 'M7 7h10v10H7z',
        grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
        scroll: 'M6 5h12M6 9h12M6 13h12M6 17h8',
        warning: 'M12 3 22 21H2zM12 9v5M12 17h.01',
        close: 'M6 6l12 12M18 6L6 18',
        upload: 'M12 16V4m-5 5 5-5 5 5M5 20h14',
        check: 'M5 12l4 4L19 6',
        type: 'M5 6V4h14v2M12 4v16M9 20h6',
        sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 3v1.6M12 19.4V21M3 12h1.6M19.4 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M18.4 5.6l-1.1 1.1M6.7 17.3l-1.1 1.1',
        up: 'M12 19V6m-6 6 6-6 6 6',
        moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
        chart: 'M4 19V11M10 19V5M16 19v-5M21 19V8',
        comic: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
        audio: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H5a1 1 0 0 1-1-1zm3 6h2v-6H4v5a1 1 0 0 0 1 1h2zm13-6h-3v6h2a1 1 0 0 0 1-1z',
        video: 'M4 5h16v14H4zM10 9l6 3-6 3z',
        web: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3.2 3.2 3.2 14.8 0 18M12 3c-3.2 3.2-3.2 14.8 0 18',
        rss: 'M5 5a14 14 0 0 1 14 14M5 12a7 7 0 0 1 7 7M6 19h.01',
      };
      return h('svg', {
        className: 'mr-glyph', width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, h('path', { d: paths[name] || paths.book }));
    }

    function ReaderIcon({ size = 22 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': true },
        h('rect', { width: 64, height: 64, rx: 16, fill: 'currentColor', opacity: .14 }),
        h('path', { d: 'M14 17c8-3 14-1 18 4 4-5 10-7 18-4v31c-8-3-14-1-18 4-4-5-10-7-18-4z', fill: 'currentColor' }));
    }

    function Button({ children, icon, kind = '', title, type = 'button', ...props }) {
      return h('button', { className: `mr-button ${kind}`, title, type, ...props },
        icon ? h(Glyph, { name: icon, size: 17 }) : null, children);
    }

    function Empty({ icon = 'book', title, detail, action }) {
      return h('div', { className: 'mr-empty' },
        h('div', { className: 'mr-empty-icon' }, h(Glyph, { name: icon, size: 28 })),
        h('h3', null, title), detail ? h('p', null, detail) : null, action || null);
    }

    // 进度的崩溃兜底：localStorage 是同步写，标签页被杀/刷新也还在。
    // 启动时用它和书里的进度比 updatedAt，谁新听谁的。
    const PROGRESS_MIRROR_KEY = 'mo-reader:progress';
    function readProgressMirror() {
      try {
        const raw = globalThis.localStorage?.getItem(PROGRESS_MIRROR_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    }
    function writeProgressMirror(value) {
      try { globalThis.localStorage?.setItem(PROGRESS_MIRROR_KEY, JSON.stringify(value)); } catch { /* 隐私模式等 */ }
    }

    function Notice({ notice, onClose }) {
      if (!notice) return null;
      return h('div', { className: `mr-notice ${notice.kind || 'info'}`, role: 'status' },
        h('span', null, notice.text), h('button', { onClick: onClose, 'aria-label': '关闭' }, h(Glyph, { name: 'close', size: 16 })));
    }

    const SHELF_COVER_TONES = [
      { bg: '#F4F1E9', fg: '#211C16' },
      { bg: '#211C16', fg: '#F1E7D2' },
      { bg: '#A4552F', fg: '#FFF3E3' },
      { bg: '#5A6348', fg: '#F1E7D2' },
      { bg: '#B08A46', fg: '#211C16' },
      { bg: '#8A3F26', fg: '#F1E7D2' },
      { bg: '#E8D9B8', fg: '#211C16' },
      { bg: '#3A342B', fg: '#F1E7D2' },
    ];

    function BookCover({ book, small = false }) {
      const cover = book.coverLocal || book.coverUrl || book.cover;
      const name = book.name || book.title || '书';
      const tone = SHELF_COVER_TONES[hashHue(name) % SHELF_COVER_TONES.length];
      return h('div', { className: `mr-cover ${small ? 'small' : ''}`, style: { background: tone.bg } },
        cover ? h('img', { src: cover, alt: '', loading: 'lazy', onError: (event) => { event.currentTarget.style.visibility = 'hidden'; } }) : null,
        h('span', { style: { color: tone.fg } }, name.slice(0, 1)));
    }

    function ShareCard({ book, onClose }) {
      const name = String(book.name || book.title || '未命名').replace(/\.(?:txt|epub|md|pdf)$/i, '');
      const author = book.author || '未知作者';
      const intro = book.intro || book.description || '';
      const cover = book.coverLocal || book.coverUrl || book.cover;
      const canvasRef = useRef(null);
      useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = 600, h = 800;
        canvas.width = w * 2; canvas.height = h * 2;
        ctx.scale(2, 2);
        // 背景
        ctx.fillStyle = '#f6f1e6'; ctx.fillRect(0, 0, w, h);
        // 顶部装饰线
        ctx.fillStyle = '#9a3b2b'; ctx.fillRect(0, 0, w, 4);
        // 封面
        if (cover) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { ctx.drawImage(img, 40, 60, 200, 280); drawText(); };
          img.onerror = () => drawText();
          img.src = cover;
        } else drawText();
        function drawText() {
          // 书名
          ctx.fillStyle = '#2b261e'; ctx.font = 'bold 28px serif';
          const lines = wrapText(ctx, name, w - 80, 28);
          lines.forEach((line, i) => ctx.fillText(line, 40, 400 + i * 36));
          // 作者
          ctx.fillStyle = '#867b68'; ctx.font = '16px sans-serif';
          ctx.fillText(author, 40, 400 + lines.length * 36 + 20);
          // 简介
          if (intro) {
            ctx.fillStyle = '#5a5248'; ctx.font = '14px sans-serif';
            const introLines = wrapText(ctx, intro.slice(0, 120), w - 80, 14);
            introLines.slice(0, 4).forEach((line, i) => ctx.fillText(line, 40, 480 + lines.length * 36 + i * 22));
          }
          // 底部
          ctx.fillStyle = '#867b68'; ctx.font = '12px sans-serif';
          ctx.fillText('墨读 · 本机阅读', 40, h - 40);
        }
        function wrapText(ctx, text, maxWidth, fontSize) {
          const lines = [];
          let line = '';
          for (const char of text) {
            const test = line + char;
            if (ctx.measureText(test).width > maxWidth) { lines.push(line); line = char; }
            else line = test;
          }
          if (line) lines.push(line);
          return lines;
        }
      }, [book]);
      const download = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = `${name}.png`;
        a.click();
      };
      return h('div', { className: 'mr-share-backdrop', onClick: onClose },
        h('div', { className: 'mr-share-card', onClick: (e) => e.stopPropagation() },
          h('h3', null, '分享书籍'),
          h('canvas', { ref: canvasRef, className: 'mr-share-canvas' }),
          h('div', { className: 'mr-share-actions' },
            h(Button, { onClick: download }, '保存图片'),
            h(Button, { kind: 'text', onClick: onClose }, '关闭'))));
    }



    function shelfBookId(book) {
      const value = book?.id ?? book?.bookId ?? book?.bookUrl ?? book?.url;
      return value === undefined || value === null ? '' : String(value);
    }

    function shelfFilterMatches(book, filter = 'all') {
      if (filter === 'reading') {
        const progress = book?.lastRead || book?.progress;
        return Boolean(book?.lastReadAt || (progress && (progress.chapterId || Number(progress.percent) > 0)));
      }
      if (filter === 'updates') return Number(book?.unread || book?.unreadCount || 0) > 0;
      if (filter === 'downloaded') {
        const job = book && typeof book.download === 'object' ? book.download : null;
        return (book?.downloadStatus || (typeof book?.download === 'string' ? book.download : job?.status)) === 'completed';
      }
      return true;
    }

    function shelfTimestamp(value) {
      if (value === null || value === undefined || value === '') return 0;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function shelfSortBooks(books, sortBy = 'recent') {
      const result = [...(Array.isArray(books) ? books : [])];
      if (sortBy === 'recent') result.sort((a, b) => shelfTimestamp(b.lastReadAt || b.updatedAt) - shelfTimestamp(a.lastReadAt || a.updatedAt));
      else if (sortBy === 'added') result.sort((a, b) => shelfTimestamp(b.addedAt || b.createdAt) - shelfTimestamp(a.addedAt || a.createdAt));
      else if (sortBy === 'name') result.sort((a, b) => String(a.name || a.title || '').localeCompare(String(b.name || b.title || '')));
      else if (sortBy === 'progress') result.sort((a, b) => Number((b.lastRead || b.progress)?.percent || 0) - Number((a.lastRead || a.progress)?.percent || 0));
      return result;
    }

    function selectShelfBooks(books, { query = '', folder = null, filter = 'all', sortBy = 'recent' } = {}) {
      const keyword = String(query).trim().toLowerCase();
      const result = (Array.isArray(books) ? books : []).filter((book) => {
        const folderId = book.folderId || null;
        if (folder === null ? folderId !== null : folderId !== folder) return false;
        if (keyword && !`${book.name || book.title || ''} ${book.author || ''}`.toLowerCase().includes(keyword)) return false;
        return shelfFilterMatches(book, filter);
      });
      return shelfSortBooks(result, sortBy);
    }

    function shelfResultKey({ query = '', filter = 'all', sortBy = 'recent', folder = null } = {}) {
      return JSON.stringify([String(query).trim().toLowerCase(), filter, sortBy, folder || null]);
    }

    function shelfPageGeometry({ width = 0, height = 0, mobile = false, count = 0 } = {}) {
      const safeWidth = Math.max(0, Number(width) || 0);
      const safeHeight = Math.max(0, Number(height) || 0);
      if (mobile) {
        const rows = safeHeight >= 540 ? 3 : 2;
        return { mobile: true, columns: 3, rows, capacity: 3 * rows, rowHeight: 0, height: safeHeight };
      }
      const gap = 12;
      const availableHeight = Math.max(0, safeHeight - 52);
      const widest = Math.max(3, Math.min(8, Math.floor(safeWidth / 145) || 3));
      const narrowest = Math.max(3, Math.min(widest, Math.floor(safeWidth / 240) || 3));
      let best = null;
      const itemCount = Math.max(0, Number(count) || 0);
      // 先保证当前书库能在一页放下；放不下时优先更大的容量，再选更大的封面。
      for (let columns = narrowest; columns <= widest; columns += 1) {
        const tileWidth = Math.max(0, (safeWidth - 18 * (columns - 1)) / columns);
        let rowHeight = Math.max(170, tileWidth * 4 / 3 + 64);
        const rows = Math.max(1, Math.min(3, Math.floor((availableHeight + gap) / (rowHeight + gap)) || 1));
        if (rows === 1) rowHeight = Math.min(rowHeight, Math.max(120, availableHeight));
        const candidate = { columns, rows, rowHeight, tileWidth, capacity: columns * rows, fits: itemCount > 0 && columns * rows >= itemCount };
        const prefer = !best
          || (candidate.fits && !best.fits)
          || (candidate.fits === best.fits && (candidate.fits
            ? candidate.tileWidth > best.tileWidth + 0.5
            : candidate.capacity > best.capacity || (candidate.capacity === best.capacity && candidate.tileWidth > best.tileWidth + 0.5)));
        if (prefer) best = candidate;
      }
      return { mobile: false, columns: best.columns, rows: best.rows, capacity: best.capacity, rowHeight: best.rowHeight, height: safeHeight };
    }

    function shelfPageCount(itemCount, geometry) {
      const capacity = Math.max(1, Number(typeof geometry === 'number' ? geometry : geometry?.capacity) || 1);
      return Math.max(1, Math.ceil(Math.max(0, Number(itemCount) || 0) / capacity));
    }

    function paginateShelf(books, requestedPage = 0, geometry = { capacity: 12 }) {
      const list = Array.isArray(books) ? books : [];
      const capacity = Math.max(1, Number(typeof geometry === 'number' ? geometry : geometry?.capacity) || 1);
      const pageCount = shelfPageCount(list.length, capacity);
      const page = Math.max(0, Math.min(pageCount - 1, Math.floor(Number(requestedPage) || 0)));
      const start = page * capacity;
      const items = list.slice(start, start + capacity);
      return { items, page, pageCount, capacity, start, anchorId: items.length ? shelfBookId(items[0]) : null };
    }

    function shelfAnchorPage(books, anchorId, geometry = { capacity: 12 }, fallbackPage = 0) {
      const list = Array.isArray(books) ? books : [];
      const capacity = Math.max(1, Number(typeof geometry === 'number' ? geometry : geometry?.capacity) || 1);
      const index = anchorId ? list.findIndex((book) => shelfBookId(book) === String(anchorId)) : -1;
      if (index >= 0) return Math.floor(index / capacity);
      return Math.max(0, Math.min(shelfPageCount(list.length, capacity) - 1, Math.floor(Number(fallbackPage) || 0)));
    }

    const shelfPagination = {
      id: shelfBookId,
      matchesFilter: shelfFilterMatches,
      sortBooks: shelfSortBooks,
      selectBooks: selectShelfBooks,
      resultKey: shelfResultKey,
      geometry: shelfPageGeometry,
      pageCount: shelfPageCount,
      paginate: paginateShelf,
      anchorPage: shelfAnchorPage,
    };

    function shelfLayout(books = []) {
      const list = Array.isArray(books) ? [...books] : [];
      const lastRead = list.find((book) => {
        const progress = book.lastRead || book.progress;
        return progress && (Number(progress.percent) > 0 || progress.chapterId);
      }) || list[0] || null;
      return { books: list, count: list.length, lastRead, faces: 1 };
    }

    function hashHue(text) {
      let hash = 0;
      const value = String(text || '');
      for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
      return hash % 360;
    }

    function downloadBadge(book) {
      const job = book && typeof book.download === 'object' ? book.download : null;
      const status = book?.downloadStatus || (typeof book?.download === 'string' ? book.download : job?.status);
      if (!status) return null;
      const total = Number(job?.total || 0);
      const done = Number(job?.done || 0);
      const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
      const label = status === 'queued' ? '排队'
        : status === 'paused' || status === 'cancelled' ? '已暂停'
        : status === 'partial' ? '部分失败'
        : status === 'failed' ? '失败'
        : status === 'completed' ? '已下载'
        : `${pct}%`;
      const kind = status === 'completed' ? 'done' : status === 'failed' || status === 'partial' ? 'failed' : status === 'paused' || status === 'cancelled' ? 'paused' : status === 'queued' ? 'queued' : 'running';
      return { label, kind, status };
    }

    function DownloadBadge({ book, onToggle }) {
      const badge = downloadBadge(book);
      if (!badge) return null;
      const toggle = (event) => { event.preventDefault(); event.stopPropagation(); onToggle?.(book); };
      const action = badge.kind === 'paused' ? '点击继续下载' : badge.kind === 'running' || badge.kind === 'queued' ? '点击暂停下载' : badge.kind === 'failed' ? '点击重新下载' : '已下载，点击重新拉取新章';
      const aria = badge.kind === 'done' ? '已下载，点击重新拉取新章' : `${badge.label}，${action}`;
      return h('span', {
        className: `mr-dl-badge ${badge.kind}`,
        role: 'button',
        tabIndex: 0,
        title: action,
        'aria-label': aria,
        onClick: toggle,
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') toggle(event); },
      },
        badge.kind === 'done' ? h(Glyph, { name: 'download', size: 14 }) : null,
        h('span', { className: 'mr-dl-label' }, badge.label));
    }

    function ShelfBoard({ books, category, folders = [], reducedMotion = false, onOpen, onCheck, busy = false, onToggleDownload, online = null, onlineBusy = false, onlineFailed = 0, onSearchOnline, onAddOnline, onCreateFolder, onRenameFolder, onRemoveFolder, onMoveToFolder, onBatchDelete, onBatchDownload, onExport, onMarkRead, onStats }) {
      const [query, setQuery] = useState('');
      const [selectMode, setSelectMode] = useState(false);
      const [selected, setSelected] = useState(new Set());
      const [selectionBusy, setSelectionBusy] = useState(false);
      const [folderFilter, setFolderFilter] = useState(null);
      const [folderSheet, setFolderSheet] = useState(false);
      const [shareBook, setShareBook] = useState(null);
      const sortBy = 'recent';
      const [mobileSearch, setMobileSearch] = useState(false);
      const [page, setPage] = useState(0);
      const [pageMotion, setPageMotion] = useState(null);
      const [glanceOffset, setGlanceOffset] = useState(0);
      const [geometry, setGeometry] = useState(() => shelfPageGeometry({
        width: window.innerWidth,
        height: window.innerHeight,
        mobile: window.matchMedia?.('(max-width: 760px)').matches || window.innerWidth <= 760,
        count: books.length,
      }));
      const searchRef = useRef(null);
      const wallRef = useRef(null);
      const trackRef = useRef(null);
      const debounceRef = useRef(null);
      const pageRef = useRef(page);
      const pageMotionSeqRef = useRef(0);
      const geometryRef = useRef(geometry);
      const gridBooksRef = useRef([]);
      const anchorRef = useRef(null);
      const gestureRef = useRef(null);
      const suppressClickRef = useRef(false);
      const longPressRef = useRef(null);
      const suppressOpenRef = useRef(false);
      pageRef.current = page;
      geometryRef.current = geometry;

      const layout = useMemo(() => shelfLayout(books), [books]);
      const folderMap = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
      const normalizedQuery = query.trim().toLowerCase();
      const resultKey = shelfResultKey({ query: normalizedQuery, filter: 'all', sortBy, folder: folderFilter });
      const sortedMatches = useMemo(() => selectShelfBooks(layout.books, {
        query: normalizedQuery, filter: 'all', folder: folderFilter, sortBy,
      }), [layout.books, normalizedQuery, folderFilter, sortBy]);
      const gridBooks = sortedMatches;
      gridBooksRef.current = gridBooks;
      const pageData = paginateShelf(gridBooks, page, geometry);
      const mobilePages = geometry.mobile
        ? Array.from({ length: pageData.pageCount }, (_, index) => paginateShelf(gridBooks, index, geometry))
        : [];
      const allSelected = gridBooks.length > 0 && gridBooks.every((book) => selected.has(shelfBookId(book)));

      const setCurrentPage = (nextPage, { scroll = true } = {}) => {
        const currentPage = pageRef.current;
        const next = paginateShelf(gridBooksRef.current, nextPage, geometryRef.current);
        if (scroll && !geometryRef.current.mobile && !reducedMotion && next.page !== currentPage) {
          pageMotionSeqRef.current += 1;
          setPageMotion({ direction: next.page > currentPage ? 'next' : 'prev', seq: pageMotionSeqRef.current });
        } else {
          setPageMotion(null);
        }
        pageRef.current = next.page;
        anchorRef.current = next.anchorId;
        setPage(next.page);
        if (scroll && geometryRef.current.mobile && trackRef.current) {
          trackRef.current.scrollTo({ left: next.page * trackRef.current.clientWidth, behavior: 'instant' });
        }
      };

      useEffect(() => {
        const onKey = (event) => {
          if (!(event.metaKey || event.ctrlKey) || String(event.key).toLowerCase() !== 'k') return;
          const target = event.target;
          const field = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
          if (field && !target.closest?.('.mr-root')) return;
          event.preventDefault();
          setMobileSearch(true);
          searchRef.current?.focus();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);

      useEffect(() => {
        if (mobileSearch) searchRef.current?.focus();
      }, [mobileSearch]);

      useEffect(() => {
        if (!onSearchOnline) return undefined;
        const keyword = query.trim();
        clearTimeout(debounceRef.current);
        if (keyword.length < 1) { onSearchOnline(''); return undefined; }
        debounceRef.current = setTimeout(() => onSearchOnline(keyword), 500);
        return () => clearTimeout(debounceRef.current);
      }, [query, onSearchOnline]);

      useLayoutEffect(() => {
        const node = wallRef.current;
        if (!node) return undefined;
        const measure = () => {
          const rect = node.getBoundingClientRect();
          const mobile = window.matchMedia?.('(max-width: 760px)').matches || window.innerWidth <= 760;
          const pager = mobile ? null : node.querySelector('.mr-shelf-pager');
          const pagerHeight = pager ? pager.getBoundingClientRect().height : 0;
          const next = shelfPageGeometry({
            width: rect.width,
            height: Math.max(0, rect.height - pagerHeight),
            mobile,
            count: gridBooksRef.current.length,
          });
          const previous = geometryRef.current;
          const changed = previous.mobile !== next.mobile || previous.columns !== next.columns || previous.rows !== next.rows || previous.rowHeight !== next.rowHeight || previous.height !== next.height;
          if (!changed) return;
          if (previous.capacity !== next.capacity || previous.mobile !== next.mobile) {
            const anchorId = anchorRef.current || paginateShelf(gridBooksRef.current, pageRef.current, previous).anchorId;
            const nextPage = shelfAnchorPage(gridBooksRef.current, anchorId, next, pageRef.current);
            pageRef.current = nextPage;
            setPage(nextPage);
          }
          geometryRef.current = next;
          setGeometry(next);
        };
        measure();
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
        observer?.observe(node);
        window.addEventListener('resize', measure);
        return () => {
          observer?.disconnect();
          window.removeEventListener('resize', measure);
        };
      }, [gridBooks.length]);

      const previousResultKeyRef = useRef(resultKey);
      useLayoutEffect(() => {
        if (previousResultKeyRef.current !== resultKey) {
          previousResultKeyRef.current = resultKey;
          const first = paginateShelf(gridBooks, 0, geometry);
          pageRef.current = 0;
          anchorRef.current = first.anchorId;
          setPage(0);
          if (trackRef.current) trackRef.current.scrollLeft = 0;
          const ids = new Set(gridBooks.map(shelfBookId));
          setSelected((previous) => new Set([...previous].filter((id) => ids.has(id))));
          return;
        }
        if (!anchorRef.current) {
          anchorRef.current = paginateShelf(gridBooks, page, geometry).anchorId;
          return;
        }
        const anchorId = anchorRef.current;
        const nextPage = shelfAnchorPage(gridBooks, anchorId, geometry, pageRef.current);
        if (nextPage !== pageRef.current) {
          pageRef.current = nextPage;
          setPage(nextPage);
        }
        if (geometry.mobile && trackRef.current) {
          const left = nextPage * trackRef.current.clientWidth;
          if (Math.abs(trackRef.current.scrollLeft - left) > 2) trackRef.current.scrollTo({ left, behavior: 'instant' });
        }
      }, [resultKey, gridBooks, geometry]);

      const onlineItems = Array.isArray(online) ? online : [];
      const shelfUrls = new Set(layout.books.map((book) => book.bookUrl || book.url).filter(Boolean));
      const toggleSelect = (book) => {
        const id = shelfBookId(book);
        if (!id) return;
        setSelected((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      };
      const toggleSelectAll = () => {
        setSelected(allSelected ? new Set() : new Set(gridBooks.map(shelfBookId).filter(Boolean)));
      };
      const exitSelect = () => { setSelectMode(false); setSelected(new Set()); };
      const runSelectionAction = async (action) => {
        if (selectionBusy) return;
        setSelectionBusy(true);
        try { await action(); exitSelect(); } catch { /* 失败时保留选择，便于重试。 */ } finally { setSelectionBusy(false); }
      };
      const cancelLongPress = () => {
        if (longPressRef.current) clearTimeout(longPressRef.current.timer);
        longPressRef.current = null;
      };
      const startLongPress = (event, book, id) => {
        if (selectMode || !id || event.button !== 0 && event.pointerType === 'mouse') return;
        if (event.target.closest?.('.mr-dl-badge, .mr-select-check')) return;
        cancelLongPress();
        const point = { x: event.clientX, y: event.clientY };
        const timer = setTimeout(() => {
          longPressRef.current = null;
          suppressOpenRef.current = true;
          setSelectMode(true);
          setSelected(new Set([id]));
          try { navigator.vibrate?.(8); } catch {}
          setTimeout(() => { suppressOpenRef.current = false; }, 900);
        }, 520);
        longPressRef.current = { ...point, timer };
      };
      const moveLongPress = (event) => {
        const press = longPressRef.current;
        if (!press) return;
        if (Math.abs(event.clientX - press.x) > 8 || Math.abs(event.clientY - press.y) > 8) cancelLongPress();
      };
      const open = (book, event) => {
        if (suppressOpenRef.current) {
          suppressOpenRef.current = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (selectMode) { toggleSelect(book); return; }
        const scope = event.currentTarget.closest?.('.mr-shelf-hero, .mr-shelf-book') || event.currentTarget;
        const cover = scope.querySelector?.('.mr-shelf-cover') || event.currentTarget.querySelector?.('.mr-shelf-cover');
        const rect = cover?.getBoundingClientRect?.() || scope.getBoundingClientRect?.();
        const panelNode = event.currentTarget.closest?.('.mr-root') || event.currentTarget;
        const panel = panelNode?.getBoundingClientRect?.();
        onOpen?.(book, {
          rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
          panel: panel ? { left: panel.left, top: panel.top, width: panel.width, height: panel.height } : null,
          cover: book.coverLocal || book.coverUrl || book.cover || '',
          bookId: shelfBookId(book),
        });
      };
      const coverNode = (book, name, variant = 1) => {
        const display = name.replace(/\.(?:txt|epub|md|pdf)$/i, '');
        const latin = !/[\u3400-\u9fff]/.test(display);
        const cover = book.coverLocal || book.coverUrl || book.cover || '';
        const sealBg = ['#211C16', '#B08A46', '#B08A46', '#B08A46', '#211C16', '#B08A46', '#211C16', '#B08A46'];
        const sealFg = ['#F4F1E9', '#211C16', '#211C16', '#211C16', '#F4F1E9', '#211C16', '#F4F1E9', '#211C16'];
        const idx = (variant - 1) % 8;
        const tone = SHELF_COVER_TONES[idx];
        return h('span', { className: `mr-shelf-cover cv${variant}`, style: { background: tone.bg } },
          h('span', { className: `mr-shelf-fallback${latin ? ' mr-latin' : ''}` },
            h('span', { className: 'mr-shelf-fallback-title', style: { color: tone.fg } }, display),
            h('span', { className: 'mr-shelf-seal', 'aria-hidden': 'true', style: { background: sealBg[idx], color: sealFg[idx] } }, display.slice(0, 1)),
            variant === 1 ? h('span', { className: 'mr-shelf-mtn', 'aria-hidden': 'true' }) : null),
          cover ? h('img', { src: cover, alt: '', loading: 'lazy', onError: (event) => { event.currentTarget.style.visibility = 'hidden'; } }) : null);
      };
      const renderBook = (book, index) => {
        const id = shelfBookId(book) || `anonymous-${index}`;
        const name = String(book.name || book.title || '未命名');
        const variant = (index % 7) + 2;
        const isSelected = selected.has(id);
        const byline = book.author || book.subscription?.sourceName || '';
        return h('button', {
          key: `book-${id}`,
          className: `mr-shelf-piece mr-shelf-book${isSelected ? ' mr-selected' : ''}`,
          type: 'button',
          'aria-label': `${name}${byline ? `，${byline}` : ''}`,
          'aria-pressed': selectMode ? isSelected : undefined,
          'data-book-id': id,
          title: name,
          onClick: (event) => open(book, event),
          onPointerDown: (event) => startLongPress(event, book, id),
          onPointerMove: moveLongPress,
          onPointerUp: cancelLongPress,
          onPointerCancel: cancelLongPress,
          onPointerLeave: cancelLongPress,
          onContextMenu: (event) => { event.preventDefault(); if (!suppressOpenRef.current) setShareBook(book); },
          onKeyDown: (event) => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              setShareBook(book);
            }
          },
        },
        selectMode ? h('span', { className: `mr-select-check${isSelected ? ' mr-checked' : ''}`, 'aria-hidden': 'true' },
          isSelected ? h(Glyph, { name: 'check', size: 15 }) : null) : null,
        h('span', { className: 'mr-shelf-visual' },
          h('span', { className: 'mr-shelf-cover-frame' },
            coverNode(book, name, variant),
            !selectMode ? h(DownloadBadge, { book, onToggle: onToggleDownload }) : null,
            Number(book.unread || book.unreadCount || 0) > 0 ? h('span', { className: 'mr-new-badge' }, `+${Number(book.unread || book.unreadCount)} 章`) : null)),
        h('span', { className: 'mr-shelf-cap' },
          h('strong', null, name.replace(/\.(?:txt|epub|md|pdf)$/i, '')),
          byline ? h('small', null, byline) : null));
      };
      const onTrackScroll = () => {
        if (!geometry.mobile || !trackRef.current) return;
        const node = trackRef.current;
        const nextPage = Math.max(0, Math.min(pageData.pageCount - 1, Math.round(node.scrollLeft / Math.max(1, node.clientWidth))));
        if (nextPage !== pageRef.current) {
          const next = paginateShelf(gridBooksRef.current, nextPage, geometryRef.current);
          pageRef.current = nextPage;
          anchorRef.current = next.anchorId;
          setPage(nextPage);
        }
      };
      const onTrackPointerDown = (event) => {
        if (!geometry.mobile || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
        gestureRef.current = { x: event.clientX, y: event.clientY, scrollLeft: trackRef.current?.scrollLeft || 0 };
        suppressClickRef.current = false;
      };
      const onTrackPointerMove = (event) => {
        const gesture = gestureRef.current;
        if (!gesture) return;
        if (Math.abs(event.clientX - gesture.x) > 8 || Math.abs(event.clientY - gesture.y) > 8 || Math.abs((trackRef.current?.scrollLeft || 0) - gesture.scrollLeft) > 5) {
          suppressClickRef.current = true;
        }
      };
      const onTrackPointerEnd = () => {
        gestureRef.current = null;
        setTimeout(() => { suppressClickRef.current = false; }, 250);
      };
      const onTrackClickCapture = (event) => {
        if (!suppressClickRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = false;
      };
      const clearSearch = () => { setQuery(''); searchRef.current?.focus(); };
      const openDeskSidebar = () => {
        const root = document.querySelector('.mr-root');
        if (root) root.style.zIndex = '50';
        // 宿主按钮的 aria-label 会随界面语言变化；data-sidebar-opener 是稳定契约。
        const toggle = document.querySelector('[data-sidebar-opener]');
        if (toggle) { toggle.click(); return; }
        const hostNewSession = [...document.querySelectorAll('button')].find((button) => {
          const label = (button.getAttribute('aria-label') || '').trim().toLowerCase();
          const text = (button.innerText || '').trim().toLowerCase();
          return ['new session', '新建会话'].includes(label) || ['new session', '新会话'].includes(text);
        });
        if (hostNewSession) hostNewSession.click();
      };
      const renameFolder = (folder) => {
        const name = window.prompt('重命名文件夹', folder.name);
        if (name) onRenameFolder?.(folder.id, name);
      };
      const categoryLabel = category?.label || '图书';
      const emptyTitle = layout.count === 0 ? `${categoryLabel}书架还空着` : normalizedQuery ? `没有找到「${query.trim()}」` : folderFilter ? '这个文件夹还空着' : '没有可展示的书';
      const emptyDetail = layout.count === 0 ? (category?.empty || '去发现搜书，或导入本地书籍。') : normalizedQuery ? '换个书名或作者，也可以看看在线结果。' : folderFilter ? '移动书籍到这里，或返回书库。' : '全部藏书都还在，换个搜索或排序试试。';
      const pageNumbers = [...new Set([0, pageData.pageCount - 1, pageData.page - 1, pageData.page, pageData.page + 1].filter((index) => index >= 0 && index < pageData.pageCount))].sort((a, b) => a - b);
      const renderedRows = geometry.mobile ? geometry.rows : Math.max(1, Math.min(geometry.rows, Math.ceil(pageData.items.length / geometry.columns)));
      const resumeBook = layout.books.find((book) => shelfFilterMatches(book, 'reading')) || null;
      const glancePool = gridBooks.length ? gridBooks : layout.books;
      const glanceBook = resumeBook || (glancePool.length ? glancePool[glanceOffset % glancePool.length] : null);
      const resumeProgress = resumeBook?.lastRead || resumeBook?.progress || null;
      const resumePercent = Math.max(0, Math.min(100, Number(resumeProgress?.percent) || 0));
      const gridHeight = renderedRows * geometry.rowHeight + Math.max(0, renderedRows - 1) * 12;
      const spareHeight = Math.max(0, Number(geometry.height) || 0) - gridHeight - 48;
      const showGlance = !geometry.mobile && !selectMode && Boolean(glanceBook) && spareHeight >= 96;
      const downloadedCount = layout.books.filter((book) => shelfFilterMatches(book, 'downloaded')).length;
      const readingCount = layout.books.filter((book) => shelfFilterMatches(book, 'reading')).length;
      const subscriptionSelected = Array.from(selected).some((id) => layout.books.some((book) => book.id === id && bookContentType(book) === 'subscription'));
      const pickRandomBook = () => {
        if (!glancePool.length) return;
        onOpen?.(glancePool[Math.floor(Math.random() * glancePool.length)]);
      };

      return h('div', { className: `mr-shelf mr-window-shelf${reducedMotion ? ' mr-reduced' : ''}${mobileSearch ? ' mr-mobile-search-open' : ''}${selectMode ? ' mr-selecting' : ''}` },
        h('div', { className: 'mr-shelf-topbar' },
          h('button', {
            className: 'mr-shelf-back',
            type: 'button',
            'aria-label': '打开 DSH 侧栏',
            title: '打开 DSH 侧栏',
            onClick: openDeskSidebar,
          }, h(Glyph, { name: 'back', size: 18 })),
          h('div', { className: `mr-shelf-search${mobileSearch ? ' mr-search-open' : ''}`, role: 'search' },
            h('button', {
              className: 'mr-shelf-mobile-search-toggle',
              type: 'button',
              'aria-label': mobileSearch ? '收起搜索' : '展开搜索',
              'aria-expanded': mobileSearch,
              onClick: () => {
                if (mobileSearch) { setMobileSearch(false); setQuery(''); searchRef.current?.blur(); }
                else setMobileSearch(true);
              },
            }, h(Glyph, { name: mobileSearch ? 'close' : 'search', size: 18 })),
            h('input', {
              ref: searchRef,
              type: 'text',
              value: query,
              placeholder: '搜书名、作者',
              'aria-label': '搜索书籍',
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery('');
                  event.currentTarget.blur();
                }
              },
            }),
            query ? h('button', {
              className: 'mr-shelf-search-clear',
              type: 'button',
              'aria-label': '清空搜索',
              onClick: clearSearch,
            }, h(Glyph, { name: 'close', size: 14 })) : h('span', { className: 'kbd' }, '⌘K')),
          h('button', {
            className: 'mr-shelf-refresh',
            type: 'button',
            'aria-label': '检查更新',
            title: '检查更新',
            disabled: busy || !onCheck,
            onClick: onCheck,
          }, h(Glyph, { name: 'refresh', size: 18 })),
          h('div', { className: 'mr-shelf-status' }, h('span', { className: 'dot' }), h('span', null, '本机保存'))),
        h('header', { className: 'mr-shelf-head' },
          h('div', { className: 'mr-shelf-head-copy' },
            h('div', { className: 'kicker' }, `窗边 · ${categoryLabel}`, h('span', { className: 'tag' }, `${layout.count} ${category?.unit || '本'}`)),
            h('h1', null, `${categoryLabel}书架`),
            h('p', { className: 'mr-shelf-head-blurb' }, category?.blurb || '本机保存的书，都在这一排。')),
          onStats ? h('div', { className: 'mr-shelf-head-actions' }, h(Button, { kind: 'text', icon: 'chart', onClick: onStats }, '阅读统计')) : null),
        folders.length > 0 && !selectMode ? h('div', { className: 'mr-shelf-folder-bar' },
          h('button', { className: `mr-folder-chip${!folderFilter ? ' active' : ''}`, onClick: () => setFolderFilter(null) }, '书库'),
          folders.map((folder) => h('button', {
            key: folder.id,
            className: `mr-folder-chip${folderFilter === folder.id ? ' active' : ''}`,
            'aria-label': `${folder.name}，双击或按 F2 重命名`,
            onClick: () => setFolderFilter(folder.id),
            onDoubleClick: () => renameFolder(folder),
            onKeyDown: (event) => { if (event.key === 'F2') { event.preventDefault(); renameFolder(folder); } },
          }, folder.name)),
          h('button', { className: 'mr-folder-chip mr-folder-add', onClick: () => { const name = window.prompt('新建文件夹'); if (name) onCreateFolder?.(name); } }, '+ 新建'),
          folderFilter ? h('button', { className: 'mr-folder-chip mr-folder-del', onClick: () => { if (window.confirm(`删除文件夹「${folderMap.get(folderFilter)?.name}」？里面的书会回到书架。`)) { onRemoveFolder?.(folderFilter); setFolderFilter(null); } } }, '删除文件夹') : null) : null,
        selectMode ? h('div', { className: 'mr-select-bar', role: 'toolbar', 'aria-label': '书籍多选操作' },
          h('div', { className: 'mr-select-head' },
            h('label', { className: 'mr-select-all' }, h('input', { type: 'checkbox', checked: allSelected, onChange: toggleSelectAll }), h('span', null, `全选 (${selected.size}/${gridBooks.length})`)),
            h('button', { className: 'mr-select-close', type: 'button', 'aria-label': '取消', title: '退出多选', onClick: exitSelect }, h(Glyph, { name: 'close', size: 18 }))),
          h('div', { className: 'mr-select-actions' },
            h(Button, { icon: 'folder', disabled: selectionBusy || !selected.size, onClick: () => setFolderSheet(true) }, h('span', null, '移动')),
            h(Button, { icon: 'download', disabled: selectionBusy || !selected.size || subscriptionSelected, title: subscriptionSelected ? '订阅暂不支持下载' : '下载', onClick: () => runSelectionAction(() => onBatchDownload?.(Array.from(selected))) }, h('span', null, '下载')),
            h(Button, { icon: 'upload', disabled: selectionBusy || !selected.size, onClick: () => runSelectionAction(() => onExport?.(Array.from(selected))) }, h('span', null, '导出')),
            h(Button, { icon: 'check', disabled: selectionBusy || !selected.size, onClick: () => runSelectionAction(() => onMarkRead?.(Array.from(selected))) }, h('span', null, '已读')),
            h(Button, { icon: 'trash', kind: 'mr-select-delete', disabled: selectionBusy || !selected.size, onClick: () => { if (window.confirm(`删除 ${selected.size} 本书？`)) runSelectionAction(() => onBatchDelete?.(Array.from(selected))); } }, h('span', null, '删除')))) : null,
        folderSheet ? h('div', { className: 'mr-folder-sheet-backdrop', onClick: () => setFolderSheet(false) },
          h('div', { className: 'mr-folder-sheet', onClick: (event) => event.stopPropagation() },
            h('h3', null, `移动 ${selected.size} 本书到…`),
            h('div', { className: 'mr-folder-sheet-list' },
              h('button', { className: 'mr-folder-sheet-item', onClick: () => { setFolderSheet(false); runSelectionAction(() => onMoveToFolder?.(Array.from(selected), null)); } }, '📚 移出文件夹（回到书架）'),
              folders.map((folder) => h('button', {
                key: folder.id,
                className: 'mr-folder-sheet-item',
                onClick: () => { setFolderSheet(false); runSelectionAction(() => onMoveToFolder?.(Array.from(selected), folder.id)); },
              }, `📁 ${folder.name}`))),
            h(Button, { kind: 'text', onClick: () => setFolderSheet(false) }, '取消'))) : null,
        shareBook ? h(ShareCard, { book: shareBook, onClose: () => setShareBook(null) }) : null,
        h('div', { className: 'mr-shelf-gallery' },
          h('section', { className: `mr-shelf-wall${showGlance ? ' has-glance' : ''}`, ref: wallRef, 'aria-label': '书架书籍' },
            showGlance ? h('section', { className: 'mr-shelf-glance', 'aria-label': '阅读建议' },
              h('span', { className: 'mr-shelf-glance-mark', 'aria-hidden': 'true' }, h(Glyph, { name: 'book', size: 20 })),
              h('div', { className: 'mr-shelf-glance-copy' },
                h('span', { className: 'mr-shelf-glance-kicker' }, resumeBook ? '接着上次 · 窗边' : '今日推荐 · 窗边'),
                h('strong', null, String(glanceBook?.name || glanceBook?.title || '未命名')),
                h('small', null, resumeBook
                  ? [glanceBook.author, resumePercent > 0 ? `已读 ${Math.round(resumePercent)}%` : '从上次停下的地方继续'].filter(Boolean).join(' · ')
                  : [glanceBook.author, `选自${categoryLabel}书架`].filter(Boolean).join(' · '))),
              h('div', { className: 'mr-shelf-glance-actions' },
                h(Button, { kind: 'primary', disabled: !onOpen, onClick: () => onOpen?.(glanceBook) }, resumeBook ? '继续阅读' : '翻开'),
                !resumeBook && glancePool.length > 1 ? h(Button, { kind: 'text', onClick: () => setGlanceOffset((value) => value + 1) }, '换一本') : null)) : null,
            gridBooks.length === 0
              ? h('div', { className: 'mr-shelf-empty' },
                  h('div', { className: 'mr-shelf-empty-icon' }, h(Glyph, { name: category?.icon || 'book', size: 24 })),
                  h('h3', null, emptyTitle),
                  h('p', null, emptyDetail),
                  normalizedQuery ? h(Button, { kind: 'secondary', onClick: clearSearch }, '清空搜索') : null)
              : h('div', {
                    key: geometry.mobile ? 'mobile' : pageMotion ? `desktop-${pageMotion.seq}` : 'desktop',
                    className: `mr-shelf-grid${geometry.mobile ? ' mr-mobile-track' : ''}${!geometry.mobile && !reducedMotion && pageMotion ? ` mr-page-${pageMotion.direction}` : ''}`,
                    ref: trackRef,
                    style: { '--shelf-columns': geometry.columns, '--shelf-rows': renderedRows, '--shelf-row-height': `${geometry.rowHeight}px` },
                    'data-page': pageData.page,
                    'data-page-count': pageData.pageCount,
                    'data-capacity': geometry.capacity,
                    onScroll: onTrackScroll,
                    onPointerDown: onTrackPointerDown,
                    onPointerMove: onTrackPointerMove,
                    onPointerUp: onTrackPointerEnd,
                    onPointerCancel: onTrackPointerEnd,
                    onClickCapture: onTrackClickCapture,
                    onAnimationEnd: (event) => {
                      if (event.target === event.currentTarget && pageMotion) setPageMotion(null);
                    },
                  }, geometry.mobile
                    ? mobilePages.map((entry, pageIndex) => h('div', {
                        className: 'mr-shelf-mobile-page',
                        key: `page-${pageIndex}`,
                        'data-mobile-page': pageIndex,
                      }, entry.items.map((book, index) => renderBook(book, pageIndex * geometry.capacity + index))))
                    : pageData.items.map((book, index) => renderBook(book, pageData.start + index))),
          !geometry.mobile && gridBooks.length > 0 ? h('div', { className: 'mr-shelf-foot' },
            h('div', { className: 'mr-shelf-stats', 'aria-label': '书架统计' },
              h('span', null, h('strong', null, layout.count), ' 本藏书'),
              h('span', null, h('strong', null, downloadedCount), ' 本已下载'),
              h('span', null, readingCount ? h(React.Fragment, null, h('strong', null, readingCount), ' 本在读') : '尚未开卷')),
            h('div', { className: 'mr-shelf-foot-actions' },
              h('button', { className: 'mr-shelf-random', type: 'button', title: '随机翻开一本', onClick: pickRandomBook },
                h(Glyph, { name: 'refresh', size: 14 }), h('span', null, '随机一本')),
              h('nav', { className: 'mr-shelf-pager', 'aria-label': '书架页码' },
                h('button', { type: 'button', 'aria-label': '上一页', disabled: pageData.page === 0, onClick: () => setCurrentPage(pageData.page - 1) }, '←'),
                pageNumbers.map((number, index) => h(React.Fragment, { key: number },
                  index > 0 && number - pageNumbers[index - 1] > 1 ? h('span', { className: 'mr-shelf-page-gap', 'aria-hidden': 'true' }, '…') : null,
                  h('button', { type: 'button', className: number === pageData.page ? 'active' : '', 'aria-label': `第 ${number + 1} 页`, 'aria-current': number === pageData.page ? 'page' : undefined, onClick: () => setCurrentPage(number) }, number + 1))),
                h('button', { type: 'button', 'aria-label': '下一页', disabled: pageData.page >= pageData.pageCount - 1, onClick: () => setCurrentPage(pageData.page + 1) }, '→')))) : null)),
        normalizedQuery ? h('section', { className: 'mr-shelf-online', 'aria-label': '在线搜索结果' },
          h('div', { className: 'mr-shelf-online-head' },
            h('h2', null, '在线'),
            h('span', { className: 'mr-shelf-online-meta' }, onlineItems.length ? `${onlineItems.length} 个结果${onlineBusy ? ' · 还在搜' : ''}` : onlineBusy ? '正在搜全部书源…' : onlineFailed ? `${onlineFailed} 个书源没响应` : '没有匹配')),
          onlineItems.length ? h('div', { className: 'mr-shelf-online-list' }, onlineItems.map((item, index) => {
            const key = `online-${item.sourceId || index}-${item.bookUrl || item.url || index}`;
            const added = shelfUrls.has(item.bookUrl || item.url);
            return h('article', { className: 'mr-shelf-online-row', key },
              h('div', { className: 'mr-shelf-online-cover' },
                item.coverUrl ? h('img', { src: item.coverUrl, alt: '', loading: 'lazy', onError: (event) => { event.currentTarget.style.visibility = 'hidden'; } }) : h('span', null, String(item.name || '书').slice(0, 1))),
              h('div', { className: 'mr-shelf-online-info' },
                h('strong', null, String(item.name || '未命名')),
                h('small', null, [item.author, item.sourceName].filter(Boolean).join(' · ')),
                item.intro ? h('p', null, String(item.intro).slice(0, 90)) : null),
              h(Button, { kind: added ? 'soft' : 'primary', disabled: added || !onAddOnline, onClick: () => onAddOnline?.(item) }, added ? '已在书架' : '加书架'));
          })) : null) : null,
        );

    }

    function Library({ books, category, folders = [], onOpen, onDownload, onRemove, onCheck, busy, view = 'shelf', onView, ctx, theme, quality, ambience, reducedMotion = false, onToggleDownload, online = null, onlineBusy = false, onlineFailed = 0, onSearchOnline, onAddOnline, onCreateFolder, onRenameFolder, onRemoveFolder, onMoveToFolder, onBatchDelete, onBatchDownload, onExport, onMarkRead, onStats }) {
      const viewToggle = h('div', { className: 'mr-view-toggle', role: 'group', 'aria-label': '书架视图' },
        h('button', { className: view === 'shelf' ? 'active' : '', onClick: () => onView('shelf') }, '书架'),
        h('button', { className: view === 'list' ? 'active' : '', onClick: () => onView('list') }, '列表'));
      const checkButton = h(Button, { icon: 'refresh', onClick: onCheck, disabled: busy }, '补查');
      const actions = h(React.Fragment, null, viewToggle, checkButton);
      if (view === 'shelf') return h(ShelfBoard, { key: 'shelf', books, category, folders, reducedMotion, onStats, onOpen, onCheck, busy, onToggleDownload, online, onlineBusy, onlineFailed, onSearchOnline, onAddOnline, onCreateFolder, onRenameFolder, onRemoveFolder, onMoveToFolder, onBatchDelete, onBatchDownload, onExport, onMarkRead });
      return h(React.Fragment, null,
        h('div', { className: 'mr-section-head' },
          h('div', null, h('h2', null, `${category?.label || ''}书架`), h('p', null, `${books.length} ${category?.unit || '本'} · 本机保存`)),
          h('div', { className: 'mr-section-actions' }, actions)),
        h('div', { className: 'mr-book-grid' }, books.map((book) => {
          const id = book.id || book.bookId;
          const name = book.name || book.title || '未命名';
          const unread = Number(book.unread || book.unreadCount || 0);
          const job = book.downloadStatus || book.download?.status;
          return h('article', { className: 'mr-book-card', key: id },
            h('button', { className: 'mr-book-open', onClick: () => onOpen(book) },
              h(BookCover, { book }),
              h(DownloadBadge, { book, onToggle: onToggleDownload }),
              h('div', { className: 'mr-book-info' },
                h('div', { className: 'mr-book-title-row' }, h('h3', { title: name }, name), unread > 0 ? h('span', { className: 'mr-badge' }, `${unread} 章`) : null),
                h('p', null, book.author || book.subscription?.sourceName || (book.sourceType === 'local' ? '本地书籍' : '未知作者')),
                h('small', null, book.sourceFailed ? '源失效' : (book.latestChapter || book.lastChapter || (book.contentType === 'subscription' ? '还没有条目' : job === 'running' ? '下载中' : '尚未读'))))),
            h('div', { className: 'mr-book-actions' },
              bookContentType(book) === 'subscription' ? null : h(Button, { kind: 'text', icon: 'download', title: '整本下载', onClick: () => onDownload(book), disabled: busy || job === 'running' || job === 'queued' }, job === 'completed' ? '已下载' : job === 'queued' ? '排队' : '下载'),
              h(Button, { kind: 'text danger', icon: 'trash', title: '移出书架', onClick: () => onRemove(book), disabled: busy }, '移除')));
        })));
    }

    const RECENT_SEARCHES_KEY = 'mo-reader:recent-searches';
    function readRecentSearches() {
      try {
        const value = JSON.parse(globalThis.localStorage?.getItem(RECENT_SEARCHES_KEY) || '[]');
        return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).slice(0, 4) : [];
      } catch { return []; }
    }
    function rememberSearch(term) {
      const value = String(term || '').trim();
      if (!value) return [];
      const next = [value, ...readRecentSearches().filter((item) => item !== value)].slice(0, 4);
      try { globalThis.localStorage?.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next)); } catch {}
      return next;
    }

    function ScreenHead({ kicker, title, sub, aside }) {
      return h('header', { className: 'mr-screen-head' },
        h('div', { className: 'mr-screen-copy' },
          h('p', { className: 'mr-screen-kicker' }, kicker),
          h('h1', null, title),
          sub ? h('p', { className: 'mr-screen-sub' }, sub) : null),
        aside ? h('div', { className: 'mr-screen-aside' }, aside) : null);
    }

    function WebsiteShelf({ sources }) {
      const sites = enabledWebsiteSources(sources);
      return h('div', { className: 'mr-screen mr-website-screen' },
        h(ScreenHead, { kicker: '窗边 · 网页', title: '网页书架', sub: '常用站点，点开就去。', aside: h('div', { className: 'mr-screen-stat' }, h('b', null, sites.length), h('span', null, '个网站')) }),
        sites.length ? h('div', { className: 'mr-website-grid' }, sites.map((source) => {
          const host = websiteHost(source);
          return h('article', { key: source.id, className: 'mr-website-card', role: 'link', tabIndex: 0, onClick: () => openExternalWebsite(source), onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); openExternalWebsite(source); } } },
            h('div', { className: 'mr-website-mark' }, h(Glyph, { name: 'web', size: 24 })),
            h('div', { className: 'mr-website-copy' },
              h('h2', null, source.name),
              h('p', null, host),
              h('span', { className: 'mr-website-kind' }, source.searchUrl ? '可站内搜索' : '仅打开首页')),
            h(Button, { kind: 'primary', className: 'mr-website-open', onClick: (event) => { event.stopPropagation(); openExternalWebsite(source); } }, '打开网站'));
        })) : h('div', { className: 'mr-shelf-empty mr-website-empty' },
          h('div', { className: 'mr-shelf-empty-icon' }, h(Glyph, { name: 'web', size: 30 })),
          h('h3', null, '网页书架还空着'),
          h('p', null, SHELF_CATEGORIES.find((category) => category.id === 'website').empty)));
    }

    function Discover({ sources, onSearch, onAdd, results, busy, failed }) {
      const [query, setQuery] = useState('');
      const [lastQuery, setLastQuery] = useState('');
      const [sourceFilter, setSourceFilter] = useState('');
      const [recent, setRecent] = useState(readRecentSearches);
      const runSearch = (value) => {
        const term = String(value ?? query).trim();
        if (!term || busy) return;
        setQuery(term);
        setLastQuery(term);
        setRecent(rememberSearch(term));
        if (searchableSources.length) onSearch(term);
      };
      const searchableSources = sources.filter((source) => source.id !== 'local' && source.contentType !== 'website' && source.kind !== 'rss' && source.enabled !== false);
      const siteSources = enabledWebsiteSources(sources);
      const sourceNames = [...new Set(searchableSources.map((source) => source.bookSourceName || source.name).filter(Boolean))];
      const allResults = results || [];
      const visible = sourceFilter ? allResults.filter((book) => book.sourceName === sourceFilter) : allResults;
      const searched = !!lastQuery;
      const siteResults = searched ? siteSources : [];
      return h('div', { className: 'mr-screen mr-discover-screen' },
        h(ScreenHead, {
          kicker: 'MO READ · 窗边 / 发现',
          title: '发现',
          sub: `搜索全部 ${searchableSources.length} 个书源 · 按书名或作者`,
          aside: h('div', { className: 'mr-screen-stat' }, h('b', null, searchableSources.length), h('span', null, '个书源')),
        }),
        !searchableSources.length && !siteSources.length ? h(Empty, { icon: 'source', title: '先导入书源', detail: '支持 URL、文件或粘贴 JSON。' }) : h('div', { className: 'mr-discover-layout' },
          h('section', { className: 'mr-search-panel', 'aria-label': '搜索与书源筛选' },
            h('p', { className: 'mr-card-kicker' }, 'SEARCH · 书源'),
            h('h2', null, '搜一本书'),
            h('p', { className: 'mr-search-lead' }, `同时搜索${sourceNames.slice(0, 4).join('、') || '已配置书源'}${sourceNames.length > 4 ? '等' : ''}，结果按匹配度排序。`),
            h('form', { className: 'mr-big-search', onSubmit: (event) => { event.preventDefault(); runSearch(); } },
              h(Glyph, { name: 'search', size: 18 }),
              h('input', { type: 'search', value: query, onChange: (e) => setQuery(e.target.value), placeholder: '书名、作者', 'aria-label': '搜索书名或作者' }),
              h('button', { type: 'submit', disabled: busy || !query.trim() }, '搜索')),
            sourceNames.length ? h('div', { className: 'mr-source-chips', 'aria-label': '按书源筛选结果' },
              h('button', { type: 'button', className: `mr-source-chip ${sourceFilter ? '' : 'active'}`, onClick: () => setSourceFilter('') }, '全部书源'),
              sourceNames.map((name) => h('button', { type: 'button', key: name, className: `mr-source-chip ${sourceFilter === name ? 'active' : ''}`, onClick: () => setSourceFilter(sourceFilter === name ? '' : name) }, name))) : null,
            recent.length ? h('div', { className: 'mr-recent' },
              h('span', null, '最近搜索'),
              recent.map((term) => h('button', { type: 'button', key: term, onClick: () => runSearch(term) }, term))) : null),
          h('section', { className: 'mr-results-panel', 'aria-label': '搜索结果', 'aria-live': 'polite' },
            h('div', { className: 'mr-results-head' },
              h('h2', null, searched ? `搜「${lastQuery}」` : '搜索结果'),
              h('span', null, searched ? `${visible.length} 本${sourceFilter ? ` · ${sourceFilter}` : ''}${siteResults.length ? ` · ${siteResults.length} 个站点` : ''}` : '输入书名或作者')),
            busy ? h('div', { className: 'mr-discovery-state' }, h('span', { className: 'mr-spinner', 'aria-hidden': true }), h('h3', null, '正在查找'), h('p', null, '同时搜索所有可用书源…'))
              : failed ? h('div', { className: 'mr-source-warning' }, h(Glyph, { name: 'source', size: 18 }), h('p', null, `${failed} 个书源没响应，已跳过；其余结果仍在下方。`))
                : null,
            !busy && searched && visible.length === 0 && !siteResults.length ? h('div', { className: 'mr-discovery-state' },
              h('div', { className: 'mr-discovery-icon' }, h(Glyph, { name: 'search', size: 24 })),
              h('h3', null, '没有找到'),
              h('p', null, sourceFilter ? `${sourceFilter} 里没有匹配结果，换个书源或关键词。` : '换个关键词或检查书源。')) : null,
            !busy && !searched ? h('div', { className: 'mr-discovery-state' },
              h('div', { className: 'mr-discovery-icon' }, h(Glyph, { name: 'search', size: 24 })),
              h('h3', null, '搜一本书'),
              h('p', null, '输入书名或作者，也可以从左侧最近搜索开始。')) : null,
            !busy && siteResults.length ? h('div', { className: 'mr-site-results', 'aria-label': '站点结果' },
              h('div', { className: 'mr-site-results-head' }, '站点结果'),
              siteResults.map((source) => {
                const host = websiteHost(source);
                return h('button', { type: 'button', className: 'mr-site-result', key: source.id, onClick: () => openExternalWebsite(source, lastQuery) },
                  h(Glyph, { name: 'web', size: 18 }),
                  h('span', null, h('b', null, source.name), h('small', null, source.searchUrl ? `${host} · 站内搜索` : `${host} · 打开首页`)),
                  h(Glyph, { name: 'right', size: 15 }));
              })) : null,
            h('div', { className: 'mr-discovery-results' }, visible.map((book, index) => {
              const name = book.name || book.title || '未命名';
              return h('article', { className: 'mr-discovery-result', key: `${book.bookUrl || book.url || name}-${index}` },
                h(BookCover, { book, small: true }),
                h('div', { className: 'mr-discovery-result-copy' },
                  h('h3', { title: name }, name),
                  h('p', null, [book.author, book.kind].filter(Boolean).map(plainText).join(' · ') || '书籍'),
                  sourceFilter ? null : h('span', { className: 'mr-discovery-source' }, book.sourceName || '书源')),
                h(Button, { kind: 'primary soft', icon: 'plus', onClick: () => onAdd(book), disabled: busy }, '加书架'));
            })))));
    }

    function importSummary(result) {
      if (!result || typeof result !== 'object') return '书源已导入';
      const rss = Array.isArray(result.rss) ? result.rss : result.kind === 'rss' ? [result] : [];
      const imported = result.kind === 'rss' ? 0 : Number(result.imported || 0);
      const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
      const first = Array.isArray(result.skipped) && result.skipped[0]?.reason ? String(result.skipped[0].reason).replace(/^source\./, '') : '';
      const skippedText = skipped ? `跳过 ${skipped} 个${first ? `（${first.slice(0, 40)}）` : ''}` : '';
      const rssText = rss.length
        ? `${rss.length > 1 ? `${rss.length} 个订阅源` : `订阅源「${rss[0].name}」`}，共 ${rss.reduce((count, item) => count + (item.categories?.length || 0), 0)} 个分类，请在下方勾选`
        : '';
      if (!imported && !rss.length) return '这批书源都不符合规则，一个也没有导入';
      if (!imported) return rssText;
      return [`已导入 ${imported} 个书源`, rssText, skippedText].filter(Boolean).join('；');
    }
    function Sources({ sources, subscriptions = [], onImport, onAddSubscriptions, onRemove, onToggle, onSubscribe, onUnsubscribe, onRefresh, onConfirmUpdate, onRejectUpdate, checkingIds = [], busy, onRestoreBuiltin }) {
      const [draft, setDraft] = useState('');
      const [allowHttp, setAllowHttp] = useState(false);
      const [libraryText, setLibraryText] = useState('');
      const [libraryHttp, setLibraryHttp] = useState(false);
      const [rssImports, setRssImports] = useState([]);
      const [rssPicked, setRssPicked] = useState({});
      const fileRef = useRef(null);
      const subscribing = busy;
      const available = sources.filter((source) => source.enabled !== false && !source.lastError).length;
      const subscribedCount = subscriptions.reduce((count, item) => count + (item.sourceIds?.length || 0), 0);
      const pickedFor = (sourceId) => rssPicked[sourceId] || [];
      const toggleRssCategory = (sourceId, url) => setRssPicked((current) => {
        const picked = current[sourceId] || [];
        return { ...current, [sourceId]: picked.includes(url) ? picked.filter((item) => item !== url) : [...picked, url] };
      });
      const pickAllRssCategories = (sourceId, urls) => setRssPicked((current) => ({ ...current, [sourceId]: urls }));
      const dismissRssImport = (sourceId) => {
        setRssImports((current) => current.filter((item) => item.sourceId !== sourceId));
        setRssPicked((current) => { const next = { ...current }; delete next[sourceId]; return next; });
      };
      const openRssSource = (source) => {
        const fresh = {
          sourceId: source.id,
          name: source.name || source.bookSourceName || '订阅源',
          categories: Array.isArray(source.categories) ? source.categories : [],
          unsupported: Array.isArray(source.unsupported) ? source.unsupported : [],
        };
        setRssImports((current) => [...current.filter((entry) => entry.sourceId !== source.id), fresh]);
        setRssPicked((current) => ({ ...current, [source.id]: [] }));
      };
      const confirmRssImport = (item) => {
        const urls = pickedFor(item.sourceId);
        if (!urls.length || busy || !onAddSubscriptions) return;
        onAddSubscriptions(item.sourceId, urls).then((result) => { if (result) dismissRssImport(item.sourceId); }, () => {});
      };
      const rssCapabilityLabels = { cookie: 'Cookie', login: '登录', 'inject-js': '注入脚本' };
      return h('div', { className: 'mr-screen mr-sources-screen' },
        h(ScreenHead, {
          kicker: 'MO READ · 窗边 / 书源',
          title: '书源',
          sub: `基础规则 · 本机校验 · ${sources.length} 个书源`,
          aside: h('div', { className: 'mr-screen-stat' }, h('b', null, sources.length), h('span', null, '个书源')),
        }),
        h('div', { className: 'mr-sources-layout' },
          h('div', { className: 'mr-sources-left' },
            h('section', { className: 'mr-window-card', 'aria-labelledby': 'source-import-title' },
              h('h2', { id: 'source-import-title' }, '导入书源'),
              h('p', { className: 'mr-help' }, '粘贴书源 JSON，或填写公开 URL。不绕过登录、付费或验证码。'),
              h('textarea', { value: draft, onChange: (e) => setDraft(e.target.value), placeholder: '粘贴书源 JSON，或填写公开 URL', rows: 5, 'aria-label': '书源 JSON 或 URL' }),
              h('label', { className: 'mr-check' }, h('input', { type: 'checkbox', checked: allowHttp, onChange: (e) => setAllowHttp(e.target.checked) }), '允许明文 HTTP'),
              h('div', { className: 'mr-inline-actions' },
                h(Button, { kind: 'primary', icon: 'plus', disabled: busy || !draft.trim(), onClick: () => onImport(draft, allowHttp).then((result) => {
                  setDraft('');
                  const list = Array.isArray(result?.rss) ? result.rss : result?.kind === 'rss' ? [result] : [];
                  if (!list.length) return;
                  setRssImports((current) => {
                    const next = [...current];
                    for (const item of list) if (!next.some((existing) => existing.sourceId === item.sourceId)) next.unshift(item);
                    return next;
                  });
                }, () => {}) }, '导入'),
                h(Button, { icon: 'upload', onClick: () => fileRef.current?.click(), disabled: busy }, '选文件'),
                h(Button, { icon: 'refresh', onClick: () => onRestoreBuiltin(), disabled: busy }, '恢复内置'),
                h('input', { ref: fileRef, type: 'file', accept: '.json,application/json', hidden: true, onChange: async (e) => { const file = e.target.files?.[0]; if (file) setDraft(await file.text()); e.target.value = ''; } }))),
            rssImports.map((item) => {
              const picked = pickedFor(item.sourceId);
              return h('section', { className: 'mr-window-card mr-rss-import', key: item.sourceId, 'aria-labelledby': `rss-import-${item.sourceId}` },
                h('h2', { id: `rss-import-${item.sourceId}` }, '订阅源已识别'),
                h('p', { className: 'mr-help' }, `「${item.name}」是 Legado 订阅源，不是书源。勾选的分类会各生成一张作品卡。`),
                item.unsupported?.length ? h('p', { className: 'mr-source-warning' },
                  h(Glyph, { name: 'warning', size: 16 }),
                  h('span', null, `不支持 ${item.unsupported.map((value) => rssCapabilityLabels[value] || value).join('、')}，导入时会丢弃。`)) : null,
                h('div', { className: 'mr-rss-head' },
                  h('span', null, `${item.categories.length} 个分类 · 已选 ${picked.length}`),
                  h('div', null,
                    h(Button, { kind: 'text', disabled: busy, onClick: () => pickAllRssCategories(item.sourceId, item.categories.map((category) => category.url)) }, '全选'),
                    h(Button, { kind: 'text', disabled: busy, onClick: () => pickAllRssCategories(item.sourceId, []) }, '全不选'))),
                h('div', { className: 'mr-rss-list' }, item.categories.map((category) => h('label', { className: 'mr-rss-row', key: category.url },
                  h('input', { type: 'checkbox', checked: picked.includes(category.url), onChange: () => toggleRssCategory(item.sourceId, category.url) }),
                  h('span', null, h('strong', null, category.name), h('small', { title: category.url }, category.url))))),
                h('div', { className: 'mr-inline-actions' },
                  h(Button, { kind: 'primary', icon: 'plus', disabled: busy || !picked.length, onClick: () => confirmRssImport(item) }, picked.length ? `加入书架（${picked.length}）` : '加入书架'),
                  h(Button, { kind: 'text', disabled: busy, onClick: () => dismissRssImport(item.sourceId) }, '取消')));
            }),
            h('section', { className: 'mr-window-card', 'aria-labelledby': 'source-library-title' },
              h('h2', { id: 'source-library-title' }, '订阅书源库'),
              h('p', { className: 'mr-help' }, '这里订阅的是书源合集，不是 Legado 的 RSS 订阅源。地址与启停状态保存在本机。'),
              h('div', { className: 'mr-online-row' },
                h('input', { value: libraryText, onChange: (e) => setLibraryText(e.target.value), placeholder: 'https://…/sources.json', 'aria-label': '公开源库地址' }),
                h(Button, { kind: 'primary', icon: 'download', disabled: subscribing || !libraryText.trim(), onClick: () => onSubscribe({ url: libraryText.trim(), allowHttp: libraryHttp }) }, '订阅')),
              h('label', { className: 'mr-check' }, h('input', { type: 'checkbox', checked: libraryHttp, onChange: (e) => setLibraryHttp(e.target.checked) }), '允许明文 HTTP'),
              subscriptions.length ? h('div', { className: 'mr-subscription-list' },
                subscriptions.map((item) => {
                  const pending = item.status === 'pending' && item.pending ? item.pending : null;
                  const isPending = item.status === 'pending';
                  const checking = !isPending && (item.checking === true || checkingIds.includes(item.id));
                  const when = (value) => { try { return new Date(value).toLocaleDateString('zh-CN'); } catch { return ''; } };
                  const failed = item.status === 'error';
                  const statusText = isPending ? '待确认' : checking ? '检查中' : failed ? '检查失败' : item.status === 'partial' ? '部分可用' : '已订阅';
                  const changes = pending?.changes || {};
                  const changeText = `新增 ${changes.added || 0} · 更新 ${changes.updated || 0} · 移除 ${changes.removed || 0}`;
                  const capabilityLabels = { js: '脚本', http: '明文 HTTP', post: 'POST' };
                  const originLabel = (value) => { try { return new URL(value).host; } catch { return value; } };
                  const permissions = [
                    ...(pending?.permissions?.origins || []).map((origin) => `新网站 ${origin}`),
                    ...(pending?.permissions?.capabilities || []).flatMap((item) => (item.capabilities || []).map((capability) => `${originLabel(item.origin)} 新增${capabilityLabels[capability] || capability}`)),
                  ];
                  const permissionText = permissions.join('、');
                  const shortList = (names = []) => {
                    const unique = [...new Set(names.filter(Boolean))];
                    return unique.length > 3 ? `${unique.slice(0, 3).join('、')} 等 ${unique.length} 个` : unique.join('、');
                  };
                  const changeNames = [
                    changes.addedNames?.length ? `新增：${shortList(changes.addedNames)}` : '',
                    changes.updatedNames?.length ? `更新：${shortList(changes.updatedNames)}` : '',
                    changes.removedNames?.length ? `移除：${shortList(changes.removedNames)}` : '',
                  ].filter(Boolean).join(' · ');
                  const detail = isPending
                    ? `${item.sourceIds?.length || 0} 个在用书源 · ${changeText}`
                    : `${item.sourceIds?.length || 0} 个书源 · 检查 ${item.lastCheckedAt ? when(item.lastCheckedAt) : '—'} · ${item.lastSuccessAt ? `${when(item.lastSuccessAt)} 成功` : '尚未成功'}${failed && item.lastFailureAt ? ` · ${when(item.lastFailureAt)} 失败` : ''}`;
                  return h('div', { className: `mr-subscription-row${isPending ? ' is-pending' : ''}`, key: item.id, 'aria-busy': checking || undefined },
                    h('div', { className: 'mr-subscription-copy' },
                      h('strong', { title: item.url }, item.url),
                      h('span', { title: failed && item.lastError ? item.lastError : detail }, detail),
                      isPending ? h('div', { className: 'mr-subscription-pending' },
                        h('span', { className: 'mr-pending-permissions', title: permissionText || '来源规则有变化' }, permissionText || '来源规则有变化'),
                        changeNames ? h('span', { className: 'mr-pending-changes', title: changeNames }, changeNames) : null) : null),
                    h('span', { className: 'mr-subscription-actions' },
                      h('span', { className: `mr-tag${failed || item.status === 'partial' ? ' failed' : checking ? ' checking' : isPending ? ' pending' : ''}`, title: failed ? item.lastError : undefined }, statusText),
                      isPending
                        ? [
                            h(Button, { key: 'confirm', kind: 'primary', disabled: busy || !pending, title: '应用已获取并等待确认的更新', onClick: () => onConfirmUpdate(item.id) }, '确认更新'),
                            h(Button, { key: 'reject', kind: 'text danger', disabled: busy, title: '放弃这次候选更新，继续使用旧版', onClick: () => onRejectUpdate(item.id) }, '拒绝'),
                            h(Button, { key: 'unsubscribe', kind: 'text', disabled: busy, title: '取消订阅，不删除书源', onClick: () => onUnsubscribe(item.id) }, '取消'),
                          ]
                        : [
                            h(Button, { key: 'refresh', kind: 'text', icon: 'refresh', disabled: busy || checking, title: '立即检查订阅更新', onClick: () => onRefresh(item.id) }, checking ? '检查中' : '刷新'),
                            h(Button, { key: 'unsubscribe', kind: 'text', disabled: busy || checking, title: '取消订阅，不删除书源', onClick: () => onUnsubscribe(item.id) }, '取消'),
                          ]));
                })) : null,
              h('p', { className: 'mr-help' }, `${subscriptions.length} 个订阅 · 关联 ${subscribedCount} 个书源`))),
          h('section', { className: 'mr-sources-list', 'aria-label': '已配置书源列表' },
            h('div', { className: 'mr-sources-list-head' },
              h('h2', null, '已配置'),
              h('span', null, `${sources.length} 个 · ${available} 个可用`)),
            sources.length ? sources.map((source) => {
              const id = source.id || source.bookSourceUrl;
              const name = source.bookSourceName || source.name || '书源';
              const disabled = source.enabled === false;
              const local = source.id === 'local' || source.bookSourceUrl === 'local:';
              const unsupportedLabels = { login: '登录', captcha: '验证码', payment: '付费', webview: '内置网页', cookie: 'Cookie', 'inject-js': '注入脚本' };
              const unsupported = (Array.isArray(source.unsupported) ? source.unsupported : []).map((item) => unsupportedLabels[item] || item);
              return h('article', { className: `mr-source-row${disabled ? ' is-disabled' : ''}`, key: id },
                h('span', { className: 'mr-source-icon', 'aria-hidden': true }, name.slice(0, 1)),
                h('div', null, h('h3', null, name), h('p', { title: source.bookSourceUrl }, source.bookSourceUrl), source.kind === 'rss' && unsupported.length ? h('p', { className: 'mr-source-unsupported' }, `导入时丢弃：${unsupported.join('、')}`) : null),
                h('div', { className: 'mr-source-side' },
                  h('span', { className: `mr-tag${source.lastError ? ' failed' : ''}`, title: source.lastError || (unsupported.length ? `不支持：${unsupported.join('、')}` : '') }, local ? '本机导入' : source.kind === 'rss' ? (disabled ? '订阅源 · 已停用' : '订阅源') : source.contentType === 'website' ? (disabled ? '网站 · 已停用' : '网站入口') : disabled ? '已停用' : source.lastError ? '解析失败 · 需更新规则' : unsupported.length ? `不支持 · ${unsupported.join('/')}` : source.builtin ? '内置 · 可用' : (source.compatibility || '基础规则')),
                  source.kind === 'rss' && source.categories?.length ? h(Button, { kind: 'text', onClick: () => openRssSource(source), disabled: busy }, '分类') : null,
                  local ? null : h(Button, { kind: 'text', onClick: () => onToggle(source), disabled: busy, 'aria-pressed': !disabled }, disabled ? '启用' : '停用'),
                  source.builtin || local ? null : h(Button, { kind: 'text danger', onClick: () => onRemove(source), disabled: busy }, '移除')));
            }) : h(Empty, { icon: 'source', title: '暂无书源', detail: '导入后即可搜索和追更。' }))));
    }

    function Stats() {
      return h('div', { className: 'mr-screen mr-stats-screen' },
        h(ScreenHead, {
          kicker: 'MO READ · 窗边 / 统计',
          title: '阅读统计',
          sub: '本机阅读记录 · 不上传',
          aside: h('span', { className: 'mr-screen-note' }, '近 365 天'),
        }),
        h('div', { className: 'mr-stats-layout' },
      h('section', { className: 'mr-panel mr-panel--wide' }, h('h3', null, '概览'),
        h('div', { className: 'mr-stats-grid' },
          h('div', { className: 'mr-stat-card' }, h('strong', null, (() => {
            const today = new Date().toISOString().slice(0, 10);
            const stats = JSON.parse(localStorage.getItem(`mo-reader:stats:${today}`) || '{"minutes":0}');
            return stats.minutes;
          })()), h('span', null, '今日阅读（分钟）')),
          h('div', { className: 'mr-stat-card' }, h('strong', null, (() => {
            let total = 0;
            for (let i = 0; i < 7; i++) {
              const d = new Date(); d.setDate(d.getDate() - i);
              const key = `mo-reader:stats:${d.toISOString().slice(0, 10)}`;
              const s = JSON.parse(localStorage.getItem(key) || '{"pages":0}');
              total += s.pages || 0;
            }
            return total;
          })()), h('span', null, '本周阅读（页）')),
          h('div', { className: 'mr-stat-card' }, h('strong', null, (() => {
            let streak = 0;
            for (let i = 0; i < 365; i++) {
              const d = new Date(); d.setDate(d.getDate() - i);
              const key = `mo-reader:stats:${d.toISOString().slice(0, 10)}`;
              const s = JSON.parse(localStorage.getItem(key) || '{"minutes":0}');
              if (s.minutes > 0) streak++; else break;
            }
            return streak;
          })()), h('span', null, '连续阅读（天）'))),
        // 阅读热力图（最近 12 周）
        h('div', { className: 'mr-heatmap' },
          h('h4', null, '阅读热力图'),
          h('div', { className: 'mr-heatmap-grid' },
            (() => {
              const cells = [];
              const today = new Date();
              // 最近 12 周（84 天）
              for (let i = 83; i >= 0; i--) {
                const d = new Date(today); d.setDate(d.getDate() - i);
                const key = `mo-reader:stats:${d.toISOString().slice(0, 10)}`;
                const s = JSON.parse(localStorage.getItem(key) || '{"minutes":0}');
                const level = s.minutes > 60 ? 4 : s.minutes > 30 ? 3 : s.minutes > 10 ? 2 : s.minutes > 0 ? 1 : 0;
                cells.push(h('div', { key: i, className: `mr-heatmap-cell level-${level}`, title: `${d.toISOString().slice(0, 10)}: ${s.minutes}分钟` }));
              }
              return cells;
            })()),
          h('div', { className: 'mr-heatmap-legend' },
            h('span', null, '少'),
            [0,1,2,3,4].map(l => h('div', { key: l, className: `mr-heatmap-cell level-${l}` })),
            h('span', null, '多'))),
        // 年度统计
        h('div', { className: 'mr-yearly-stats' },
          h('h4', null, `${new Date().getFullYear()} 年度统计`),
          h('div', { className: 'mr-yearly-grid' },
            h('div', { className: 'mr-yearly-item' }, h('strong', null, (() => {
              let total = 0;
              const year = new Date().getFullYear();
              for (let i = 0; i < 365; i++) {
                const d = new Date(year, 0, 1); d.setDate(d.getDate() + i);
                if (d > new Date()) break;
                const key = `mo-reader:stats:${d.toISOString().slice(0, 10)}`;
                const s = JSON.parse(localStorage.getItem(key) || '{"minutes":0}');
                total += s.minutes || 0;
              }
              return total;
            })()), h('span', null, '总分钟')),
            h('div', { className: 'mr-yearly-item' }, h('strong', null, (() => {
              let total = 0;
              const year = new Date().getFullYear();
              for (let i = 0; i < 365; i++) {
                const d = new Date(year, 0, 1); d.setDate(d.getDate() + i);
                if (d > new Date()) break;
                const key = `mo-reader:stats:${d.toISOString().slice(0, 10)}`;
                const s = JSON.parse(localStorage.getItem(key) || '{"pages":0}');
                total += s.pages || 0;
              }
              return total;
            })()), h('span', null, '总页数')),
            h('div', { className: 'mr-yearly-item' }, h('strong', null, (() => {
              let days = 0;
              const year = new Date().getFullYear();
              for (let i = 0; i < 365; i++) {
                const d = new Date(year, 0, 1); d.setDate(d.getDate() + i);
                if (d > new Date()) break;
                const key = `mo-reader:stats:${d.toISOString().slice(0, 10)}`;
                const s = JSON.parse(localStorage.getItem(key) || '{"minutes":0}');
                if (s.minutes > 0) days++;
              }
              return days;
            })()), h('span', null, '阅读天数')),
            h('div', { className: 'mr-yearly-item' }, h('strong', null, (() => {
              let total = 0;
              const year = new Date().getFullYear();
              for (let i = 0; i < 365; i++) {
                const d = new Date(year, 0, 1); d.setDate(d.getDate() + i);
                if (d > new Date()) break;
                const key = `mo-reader:stats:${d.toISOString().slice(0, 10)}`;
                const s = JSON.parse(localStorage.getItem(key) || '{"minutes":0}');
                total += s.minutes || 0;
              }
              const days = Math.max(1, Math.floor((new Date() - new Date(year, 0, 1)) / 86400000) + 1);
              return Math.round(total / days);
            })()), h('span', null, '日均分钟')))),
        // 阅读时长分布
        h('div', { className: 'mr-duration-dist' },
          h('h4', null, '阅读时长分布'),
          h('div', { className: 'mr-dist-bars' },
            (() => {
              const buckets = { '0-10分钟': 0, '10-30分钟': 0, '30-60分钟': 0, '60分钟以上': 0 };
              for (let i = 0; i < 365; i++) {
                const d = new Date(); d.setDate(d.getDate() - i);
                const key = `mo-reader:stats:${d.toISOString().slice(0, 10)}`;
                const s = JSON.parse(localStorage.getItem(key) || '{"minutes":0}');
                const m = s.minutes || 0;
                if (m === 0) continue;
                if (m <= 10) buckets['0-10分钟']++;
                else if (m <= 30) buckets['10-30分钟']++;
                else if (m <= 60) buckets['30-60分钟']++;
                else buckets['60分钟以上']++;
              }
              const max = Math.max(...Object.values(buckets), 1);
              return Object.entries(buckets).map(([label, count]) =>
                h('div', { key: label, className: 'mr-dist-row' },
                  h('span', { className: 'mr-dist-label' }, label),
                  h('div', { className: 'mr-dist-bar' },
                    h('div', { className: 'mr-dist-fill', style: { width: `${count / max * 100}%` } })),
                  h('span', { className: 'mr-dist-count' }, `${count}天`)));
            })())),
        // 阅读时段分析
        h('div', { className: 'mr-time-dist' },
          h('h4', null, '阅读时段分析'),
          h('div', { className: 'mr-time-grid' },
            (() => {
              const hours = Array.from({ length: 24 }, (_, i) => ({ hour: i, minutes: 0 }));
              for (let i = 0; i < 365; i++) {
                const d = new Date(); d.setDate(d.getDate() - i);
                const key = `mo-reader:stats:${d.toISOString().slice(0, 10)}`;
                const s = JSON.parse(localStorage.getItem(key) || '{"minutes":0,"lastActive":0}');
                if (s.lastActive > 0) {
                  const h = new Date(s.lastActive).getHours();
                  hours[h].minutes += s.minutes || 0;
                }
              }
              const max = Math.max(...hours.map(h => h.minutes), 1);
              return hours.map(({ hour, minutes }) =>
                h('div', { key: hour, className: 'mr-time-cell', title: `${hour}:00-${hour+1}:00: ${Math.round(minutes)}分钟` },
                  h('div', { className: 'mr-time-bar', style: { height: `${Math.max(minutes / max * 100, 4)}%` } }),
                  h('span', { className: 'mr-time-label' }, hour)));
            })())),
        // 阅读趋势（最近 30 天）
        h('div', { className: 'mr-trend-chart' },
          h('h4', null, '阅读趋势（近 30 天）'),
          h('div', { className: 'mr-trend-bars' },
            (() => {
              const days = [];
              for (let i = 29; i >= 0; i--) {
                const d = new Date(); d.setDate(d.getDate() - i);
                const key = `mo-reader:stats:${d.toISOString().slice(0, 10)}`;
                const s = JSON.parse(localStorage.getItem(key) || '{"minutes":0}');
                days.push({ date: d.toISOString().slice(5, 10), minutes: s.minutes || 0 });
              }
              const max = Math.max(...days.map(d => d.minutes), 1);
              return days.map(({ date, minutes }) =>
                h('div', { key: date, className: 'mr-trend-col', title: `${date}: ${minutes}分钟` },
                  h('div', { className: 'mr-trend-bar', style: { height: `${Math.max(minutes / max * 100, 2)}%` } }),
                  h('span', { className: 'mr-trend-label' }, date.slice(-2))));
            })())))
        ));
    }

    function Settings({ settings, onSettings, onLocal, onExport, onImport, busy, onExportNotes, onUploadFont, onStats }) {
      const [replacementText, setReplacementText] = useState(() => (settings.replacements || []).map((rule) => `${rule.pattern || rule.from || ''}=>${rule.replacement || rule.to || ''}`).join('\n'));
      const [quotaGb, setQuotaGb] = useState(() => String(Math.round((settings.mediaQuotaBytes || 50 * 1024 ** 3) / 1024 ** 3)));
      const quotaValid = Number.isInteger(Number(quotaGb)) && Number(quotaGb) >= 1 && Number(quotaGb) <= 500;
      const localRef = useRef(null);
      const backupRef = useRef(null);
      const fontRef = useRef(null);
      useEffect(() => {
        setReplacementText((settings.replacements || []).map((rule) => `${rule.pattern || rule.from || ''}=>${rule.replacement || rule.to || ''}`).join('\n'));
      }, [settings.replacements]);
      useEffect(() => {
        setQuotaGb(String(Math.round((settings.mediaQuotaBytes || 50 * 1024 ** 3) / 1024 ** 3)));
      }, [settings.mediaQuotaBytes]);
      const saveReplacements = () => {
        const replacements = replacementText.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
          const at = line.indexOf('=>');
          return at < 0 ? { pattern: line, replacement: '' } : { pattern: line.slice(0, at), replacement: line.slice(at + 2) };
        });
        return onSettings({ replacements });
      };
      return h('div', { className: 'mr-screen mr-settings mr-settings-screen' },
        h(ScreenHead, {
          kicker: 'MO READ · 窗边 / 设置',
          title: '设置',
          sub: '排版、净化与本机数据',
          aside: h(React.Fragment, null, h('span', { className: 'mr-screen-note' }, '本机保存 · 不上传'), onStats ? h(Button, { kind: 'text', icon: 'chart', onClick: onStats }, '阅读统计') : null),
        }),
        h('div', { className: 'mr-settings-grid' },
        h('section', { className: 'mr-panel' }, h('h3', null, '动画'),
          h('p', { className: 'mr-help' }, '无 WebGL 或减少动态时自动瞬时翻页。'),
          h('div', { className: 'mr-setting-row' }, h('span', null, '默认方式'), h('div', { className: 'mr-mode-picker' },
            h('button', { className: `mr-mode-choice ${(settings.mode || 'scroll') === 'paged' ? 'active' : ''}`, onClick: () => onSettings({ mode: 'paged' }) }, '翻页'),
            h('button', { className: `mr-mode-choice ${settings.mode === 'scroll' ? 'active' : ''}`, onClick: () => onSettings({ mode: 'scroll' }) }, '滚动'))),
          h('div', { className: 'mr-setting-row' }, h('span', null, '默认翻页'), h('div', { className: 'mr-mode-picker' },
            h('button', { className: `mr-mode-choice ${(settings.flipStyle || 'slide') === 'slide' ? 'active' : ''}`, onClick: () => onSettings({ flipStyle: 'slide' }) }, '滑动'),
            h('button', { className: `mr-mode-choice ${settings.flipStyle === 'flip' ? 'active' : ''}`, onClick: () => onSettings({ flipStyle: 'flip' }) }, '翻转'),
            h('button', { className: `mr-mode-choice ${settings.flipStyle === 'fade' ? 'active' : ''}`, onClick: () => onSettings({ flipStyle: 'fade' }) }, '淡入'))),
          h('div', { className: 'mr-setting-row' }, h('span', null, '动画开关'), h('div', { className: 'mr-mode-picker' },
            h('button', { className: `mr-mode-choice ${settings.animations === false ? '' : 'active'}`, onClick: () => onSettings({ animations: true }) }, '开'),
            h('button', { className: `mr-mode-choice ${settings.animations === false ? 'active' : ''}`, onClick: () => onSettings({ animations: false }) }, '关'))),
          h('div', { className: 'mr-setting-row' }, h('span', null, '画面质量'), h('div', { className: 'mr-mode-picker' },
            h('button', { className: `mr-mode-choice ${(settings.motionQuality || 'auto') === 'auto' ? 'active' : ''}`, onClick: () => onSettings({ motionQuality: 'auto' }) }, '自动'),
            h('button', { className: `mr-mode-choice ${settings.motionQuality === 'high' ? 'active' : ''}`, onClick: () => onSettings({ motionQuality: 'high' }) }, '高'),
            h('button', { className: `mr-mode-choice ${settings.motionQuality === 'low' ? 'active' : ''}`, onClick: () => onSettings({ motionQuality: 'low' }) }, '低'))),
          h('div', { className: 'mr-setting-row' }, h('span', null, '氛围'), h('div', { className: 'mr-mode-picker' },
            h('button', { className: `mr-mode-choice ${(settings.ambience || 'full') === 'full' ? 'active' : ''}`, onClick: () => onSettings({ ambience: 'full' }) }, '完整'),
            h('button', { className: `mr-mode-choice ${settings.ambience === 'paper' ? 'active' : ''}`, onClick: () => onSettings({ ambience: 'paper' }) }, '仅纸张'),
            h('button', { className: `mr-mode-choice ${settings.ambience === 'off' ? 'active' : ''}`, onClick: () => onSettings({ ambience: 'off' }) }, '关闭'))),
          h('div', { className: 'mr-setting-row' }, h('span', null, '减弱动态'), h('div', { className: 'mr-mode-picker' },
            h('button', { className: `mr-mode-choice ${(settings.reducedMotion || 'system') === 'system' ? 'active' : ''}`, onClick: () => onSettings({ reducedMotion: 'system' }) }, '跟随系统'),
            h('button', { className: `mr-mode-choice ${settings.reducedMotion === 'on' ? 'active' : ''}`, onClick: () => onSettings({ reducedMotion: 'on' }) }, '开启'),
            h('button', { className: `mr-mode-choice ${settings.reducedMotion === 'off' ? 'active' : ''}`, onClick: () => onSettings({ reducedMotion: 'off' }) }, '关闭')))),
        h('section', { className: 'mr-panel' }, h('h3', null, '默认排版'),
          h('div', { className: 'mr-setting-row' }, h('span', null, '字号'), h('div', { className: 'mr-stepper' },
            h(Button, { onClick: () => onSettings({ fontSize: Math.max(14, Number(settings.fontSize || 20) - 1) }) }, '减小'),
            h('strong', null, `${settings.fontSize || 20}px`),
            h(Button, { onClick: () => onSettings({ fontSize: Math.min(36, Number(settings.fontSize || 20) + 1) }) }, '增大'))),
          h('div', { className: 'mr-setting-row' }, h('span', null, '行距'), h('input', { type: 'range', min: 1.4, max: 2.5, step: .1, value: settings.lineHeight || 1.9, onChange: (e) => onSettings({ lineHeight: Number(e.target.value) }) })),
          h('div', { className: 'mr-setting-row' }, h('span', null, '纸张'), h('div', { className: 'mr-theme-picker' }, ['paper', 'light', 'green', 'dark'].map((theme) => h('button', { key: theme, className: `mr-swatch ${theme} ${settings.readerTheme === theme ? 'active' : ''}`, onClick: () => onSettings({ readerTheme: theme }), 'aria-label': theme }))))),
        h('section', { className: 'mr-panel' }, h('h3', null, '替换净化'), h('p', { className: 'mr-help' }, '每行一条：匹配=>替换；支持正则。'),
          h('textarea', { rows: 5, value: replacementText, onChange: (e) => setReplacementText(e.target.value), placeholder: '广告词=>' }),
          h(Button, { onClick: saveReplacements, disabled: busy }, '保存规则')),
        h('section', { className: 'mr-panel' }, h('h3', null, '媒体缓存'),
          h('p', { className: 'mr-help' }, '下载的漫画、音频和视频保存在 DSH 服务端；超出上限时按整部作品淘汰最久未看内容。'),
          h('div', { className: 'mr-setting-row' }, h('span', null, '上限（GB）'),
            h('input', { type: 'number', min: 1, max: 500, step: 1, value: quotaGb, onChange: (e) => setQuotaGb(e.target.value), 'aria-label': '媒体缓存上限GB' }),
            h(Button, { onClick: () => onSettings({ mediaQuotaBytes: Number(quotaGb) * 1024 ** 3 }), disabled: busy || !quotaValid }, '保存'))),
        h('section', { className: 'mr-panel' }, h('h3', null, '本地书籍'), h('p', { className: 'mr-help' }, '导入 TXT 或 EPUB，内容仅保存在本机。'),
          h(Button, { icon: 'upload', onClick: () => localRef.current?.click(), disabled: busy }, '导入书籍'),
          h('input', { ref: localRef, type: 'file', accept: '.txt,.epub,text/plain,application/epub+zip', hidden: true, onChange: (e) => { const file = e.target.files?.[0]; if (file) onLocal(file); e.target.value = ''; } })),
        h('section', { className: 'mr-panel' }, h('h3', null, '备份恢复'), h('p', { className: 'mr-help' }, '备份不包含密码、Cookie 或令牌。'),
          h('div', { className: 'mr-inline-actions' },
            h(Button, { icon: 'download', onClick: onExport, disabled: busy }, '导出'),
            h(Button, { icon: 'upload', onClick: () => backupRef.current?.click(), disabled: busy }, '恢复'),
            h('input', { ref: backupRef, type: 'file', accept: '.json,application/json', hidden: true, onChange: async (e) => { const file = e.target.files?.[0]; if (file) onImport(file); e.target.value = ''; } }))),
        h('section', { className: 'mr-panel mr-roadmap' }, h('h3', null, '支持范围'), h('p', null, '文字、漫画、音频、视频和网站入口；网站通过外部浏览器打开，登录与 DRM 媒体按书源提示处理。')),
        h('section', { className: 'mr-panel' }, h('h3', null, '笔记导出'),
          h('p', { className: 'mr-help' }, '把划线和笔记导出为 Markdown。'),
          h(Button, { icon: 'download', onClick: () => onExportNotes?.(), disabled: busy }, '导出笔记')),
        h('section', { className: 'mr-panel' }, h('h3', null, '夜间定时'),
          h('div', { className: 'mr-setting-row' }, h('span', null, '自动夜间'), h('div', { className: 'mr-mode-picker' },
            h('button', { className: `mr-mode-choice ${!settings.nightAuto ? 'active' : ''}`, onClick: () => onSettings({ nightAuto: false }) }, '关'),
            h('button', { className: `mr-mode-choice ${settings.nightAuto ? 'active' : ''}`, onClick: () => onSettings({ nightAuto: true }) }, '开'))),
          settings.nightAuto ? h('div', { className: 'mr-setting-row' }, h('span', null, '开始时间'), h('input', { type: 'time', value: settings.nightStart || '22:00', onChange: (e) => onSettings({ nightStart: e.target.value }) })) : null,
          settings.nightAuto ? h('div', { className: 'mr-setting-row' }, h('span', null, '结束时间'), h('input', { type: 'time', value: settings.nightEnd || '06:00', onChange: (e) => onSettings({ nightEnd: e.target.value }) })) : null),
        h('section', { className: 'mr-panel' }, h('h3', null, '听书定时'),
          h('div', { className: 'mr-setting-row' }, h('span', null, '定时停止'), h('div', { className: 'mr-mode-picker' },
            h('button', { className: `mr-mode-choice ${!settings.ttsTimer ? 'active' : ''}`, onClick: () => onSettings({ ttsTimer: 0 }) }, '关'),
            [15, 30, 60].map(min => h('button', { key: min, className: `mr-mode-choice ${settings.ttsTimer === min ? 'active' : ''}`, onClick: () => onSettings({ ttsTimer: min }) }, `${min}分钟`))))),
        h('section', { className: 'mr-panel' }, h('h3', null, '阅读目标'),
          h('div', { className: 'mr-setting-row' }, h('span', null, '每日目标（分钟）'), h('input', { type: 'number', min: 0, max: 480, step: 5, value: settings.dailyGoal || 0, onChange: (e) => onSettings({ dailyGoal: Number(e.target.value) }) })),
          h('p', { className: 'mr-help' }, '设为 0 关闭目标提醒。')),
        h('section', { className: 'mr-panel' }, h('h3', null, '自定义字体'),
          h('p', { className: 'mr-help' }, '上传 TTF/OTF 字体文件。'),
          h(Button, { icon: 'upload', onClick: () => fontRef.current?.click(), disabled: busy }, '上传字体'),
          h('input', { ref: fontRef, type: 'file', accept: '.ttf,.otf,.woff,.woff2', hidden: true, onChange: (e) => { const file = e.target.files?.[0]; if (file) onUploadFont?.(file); e.target.value = ''; } })),
        h('section', { className: 'mr-panel' }, h('h3', null, '快捷键'),
          h('div', { className: 'mr-shortcuts' },
            h('div', { className: 'mr-shortcuts-row' }, h('span', null, '上一页'), h('kbd', null, '←')),
            h('div', { className: 'mr-shortcuts-row' }, h('span', null, '下一页'), h('kbd', null, '→ / 空格')),
            h('div', { className: 'mr-shortcuts-row' }, h('span', null, '目录'), h('kbd', null, 'D')),
            h('div', { className: 'mr-shortcuts-row' }, h('span', null, '排版'), h('kbd', null, 'S')),
            h('div', { className: 'mr-shortcuts-row' }, h('span', null, '笔记'), h('kbd', null, 'N')),
            h('div', { className: 'mr-shortcuts-row' }, h('span', null, 'AI 助手'), h('kbd', null, 'A')),
            h('div', { className: 'mr-shortcuts-row' }, h('span', null, '听书'), h('kbd', null, 'T')),
            h('div', { className: 'mr-shortcuts-row' }, h('span', null, '切换模式'), h('kbd', null, 'M')),
            h('div', { className: 'mr-shortcuts-row' }, h('span', null, '关闭面板'), h('kbd', null, 'Esc'))))));
    }

    function MediaAudioDock({ track, playing, time, duration, onToggle, onSeek, onClose, onPrev, onNext }) {
      const [scrub, setScrub] = useState(null);
      const value = scrub ?? Math.min(time || 0, duration || 0);
      const mainButton = h('button', {
        type: 'button',
        className: 'mr-audio-dock-main',
        onClick: onToggle,
        'aria-label': playing ? '暂停' : '播放',
      },
        h(Glyph, { name: playing ? 'pause' : 'play', size: 18 }),
        h('span', null,
          h('strong', null, track.chapterTitle || track.bookName || '音频'),
          h('small', null, track.bookName || '')),
      );
      const progress = h('input', {
        type: 'range',
        min: 0,
        max: Math.max(1, Math.floor(duration || 0)),
        value,
        'aria-label': '播放进度',
        onChange: (event) => setScrub(Number(event.target.value)),
        onPointerUp: () => { onSeek?.(Number(value)); setScrub(null); },
        onKeyUp: () => { onSeek?.(Number(value)); setScrub(null); },
      });
      const elapsed = h('span', { className: 'mr-audio-dock-time' }, `${formatMediaTime(value)} / ${formatMediaTime(duration)}`);
      const close = h('button', {
        type: 'button',
        className: 'mr-reader-top-btn',
        'aria-label': '关闭音频',
        onClick: onClose,
      }, h(Glyph, { name: 'close', size: 16 }));
      const nav = onPrev || onNext ? h('span', { className: 'mr-audio-dock-nav' },
        h('button', { type: 'button', 'aria-label': '上一章', disabled: !onPrev, onClick: onPrev }, h(Glyph, { name: 'back', size: 15 })),
        h('button', { type: 'button', 'aria-label': '下一章', disabled: !onNext, onClick: onNext }, h(Glyph, { name: 'next', size: 15 })),
      ) : null;
      return h('div', { className: 'mr-audio-dock', role: 'region', 'aria-label': '迷你播放条' },
        nav,
        mainButton,
        progress,
        elapsed,
        close,
      );
    }

    function MediaReader({ ctx, book, settings, onClose, notify, jobs = [], audioTrack, audioPlaying = false, audioTime = 0, audioDuration = 0, onAudioPlay, onAudioToggle, onAudioSeek, onRefresh }) {
      const bookId = book.id || book.bookId;
      const type = bookContentType(book);
      const [toc, setToc] = useState([]);
      const [chapter, setChapter] = useState(null);
      const [chapterIndex, setChapterIndex] = useState(-1);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [comicMode, setComicMode] = useState(book.readerPrefs?.comicMode === 'paged' ? 'paged' : 'scroll');
      const [pageIndex, setPageIndex] = useState(0);
      const [retryNonce, setRetryNonce] = useState(0);
      const [sheetOpen, setSheetOpen] = useState(false);
      const [selected, setSelected] = useState([]);
      const [drawer, setDrawer] = useState(false);
      const [cacheUsed, setCacheUsed] = useState(0);
      const [bookUsed, setBookUsed] = useState(0);
      const [cacheRecords, setCacheRecords] = useState([]);
      const scrollRef = useRef(null);
      const pageRefs = useRef([]);
      const videoRef = useRef(null);
      const videoHlsRef = useRef(null);
      const videoMark = useRef(0);
      const saveTimer = useRef(null);
      const pendingProgress = useRef(null);
      const autoPlayRef = useRef(false);
      const restoredChapterRef = useRef(null);
      const tickRef = useRef(-1);
      const initialChapterId = book.progress?.chapterId;
      const job = useMemo(() => (jobs || []).filter((item) => item.bookId === bookId).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null, [jobs, bookId]);
      const source = mediaChapterSource(book, chapter);
      const sourceHome = /^https?:/i.test(String(book.sourceHome || '')) ? book.sourceHome : '';
      const sourceLink = sourceHome ? h('a', { href: sourceHome, target: '_blank', rel: 'noopener', className: 'mr-media-source-link' }, '在外部浏览器打开书源主页') : null;
      const currentTrack = audioTrack && (audioTrack.bookId === bookId) && (audioTrack.chapterId === chapter?.id);

      useEffect(() => {
        let live = true;
        setLoading(true); setError('');
        call(ctx, 'toc', { bookId }).then((items) => {
          if (!live) return;
          const list = Array.isArray(items) ? items : [];
          setToc(list);
          setSelected(list.map((item) => item.id));
          if (!list.length) {
            setLoading(false);
            setError('这本书还没有目录。');
            return;
          }
          const wanted = list.findIndex((item) => item.id === initialChapterId);
          setChapterIndex(wanted >= 0 ? wanted : 0);
        }).catch((cause) => { if (live) { setError(cause.message || String(cause)); setLoading(false); } });
        return () => { live = false; };
      }, [bookId]);

      const reloadCache = () => Promise.all([
        call(ctx, 'mediaCacheStats', {}).then((value) => setCacheUsed(Number(value?.usedBytes) || 0)).catch(() => {}),
        call(ctx, 'listMediaCache', { bookId }).then((items) => {
          const records = Array.isArray(items) ? items : [];
          setCacheRecords(records);
          setBookUsed(records.reduce((sum, item) => sum + (Number(item.size) || 0), 0));
        }).catch(() => {}),
      ]);

      useEffect(() => {
        if (!sheetOpen) return;
        reloadCache();
      }, [sheetOpen, job?.done]);

      useEffect(() => {
        if (!job) return;
        call(ctx, 'toc', { bookId }).then((items) => {
          if (Array.isArray(items)) setToc(items);
        }).catch(() => {});
      }, [job?.status, job?.done]);

      useEffect(() => {
        if (chapterIndex < 0 || !toc[chapterIndex]) return;
        const ticket = ++tickRef.current;
        videoMark.current = 0;
        let live = true;
        setLoading(true); setError('');
        call(ctx, 'chapter', { bookId, chapterId: toc[chapterIndex].id }).then((value) => {
          if (!live || ticket !== tickRef.current) return;
          setChapter(value);
          if (type === 'comic') {
            const count = Array.isArray(value.images) ? value.images.length : Array.isArray(value.offline?.images) ? value.offline.images.length : 0;
            restoredChapterRef.current = null;
            setPageIndex(comicPageFromProgress(book, value, count));
          }
          setLoading(false);
        }).catch((cause) => { if (live && ticket === tickRef.current) { setChapter(null); setError(cause.message || String(cause)); setLoading(false); } });
        return () => { live = false; };
      }, [bookId, chapterIndex, toc[chapterIndex]?.id, type, retryNonce]);

      useEffect(() => {
        if (type !== 'comic') return;
        const handleKey = (event) => {
          if (comicMode !== 'paged') return;
          const tag = String(event.target?.tagName || '').toLowerCase();
          if (['input', 'textarea', 'select'].includes(tag) || event.target?.isContentEditable) return;
          if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
            event.preventDefault();
            changeComicPage(pageIndex - 1);
          } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
            event.preventDefault();
            changeComicPage(pageIndex + 1);
          }
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
      }, [type, pageIndex, comicMode, chapter?.id, source.images?.length]);

      useEffect(() => {
        if (type !== 'video' || source.kind !== 'media' || !source.hls || !chapter) return;
        let live = true;
        loadHlsPlayer().then((Hls) => {
          if (!live || !videoRef.current) return;
          if (!Hls.isSupported()) {
            setError('浏览器不支持 HLS 播放，可先下载这一章。');
            return;
          }
          const player = new Hls({ enableWorker: false });
          videoHlsRef.current = player;
          player.loadSource(source.url);
          player.attachMedia(videoRef.current);
          player.on(Hls.Events.MANIFEST_PARSED, () => {
            const start = mediaStartSeconds(book, chapter);
            const el = videoRef.current;
            if (el && start > 0) { try { el.currentTime = start; } catch {} }
          });
          player.on(Hls.Events.ERROR, (_event, data) => {
            if (data?.fatal) setError(String(data?.details || '').includes('manifest') ? '这个视频需要 DRM 或使用了不受支持的 HLS 格式，无法在线播放；请尝试下载。' : '视频加载失败：媒体地址失效或格式不支持。');
          });
        }).catch(() => { if (live) setError('在线 HLS 播放器加载失败，可先下载这一章。'); });
        return () => {
          live = false;
          videoHlsRef.current?.destroy();
          videoHlsRef.current = null;
        };
      }, [chapter?.id, type, source.kind, source.url, source.hls]);

      useEffect(() => {
        if (!chapter || type !== 'comic' || chapterIndex < 0) return;
        const next = toc[chapterIndex + 1];
        if (!next) return;
        let live = true;
        const timer = setTimeout(() => {
          call(ctx, 'chapter', { bookId, chapterId: next.id }).then((value) => {
            if (!live) return;
            const nextSource = mediaChapterSource(book, { ...value, id: next.id });
            for (const url of (nextSource.images || []).slice(0, 3)) {
              const image = new Image();
              image.src = url;
            }
          }).catch(() => {});
        }, 1200);
        return () => { live = false; clearTimeout(timer); };
      }, [chapter?.id, chapterIndex, type, toc]);

      useEffect(() => {
        if (!chapter || type !== 'comic' || comicMode !== 'paged') return;
        const image = pageRefs.current[pageIndex];
        image?.scrollIntoView?.({ block: 'center' });
      }, [pageIndex, comicMode, chapter]);

      useEffect(() => {
        if (!chapter || type !== 'comic' || comicMode !== 'scroll') return;
        const node = scrollRef.current;
        if (!node) return;
        const image = pageRefs.current[pageIndex];
        if (image && node.contains(image)) image.scrollIntoView({ block: 'start' });
      }, [chapter?.id, comicMode]);

      useEffect(() => {
        if (!autoPlayRef.current || !chapter || loading || type !== 'audio') return;
        autoPlayRef.current = false;
        if (source.kind === 'error') return;
        onAudioPlay?.({ bookId, bookName: book.name || book.title, chapterId: chapter.id, chapterTitle: chapter.title, url: source.url, hls: source.hls }, mediaStartSeconds(book, chapter), toc.map((item) => ({ bookId, chapterId: item.id, title: item.title })));
      }, [chapter?.id, loading]);
      const flushProgress = () => {
        clearTimeout(saveTimer.current);
        const pending = pendingProgress.current;
        pendingProgress.current = null;
        if (pending) call(ctx, 'saveProgress', pending).catch(() => {});
      };

      useEffect(() => () => {
        clearTimeout(saveTimer.current);
        const pending = pendingProgress.current;
        if (pending) call(ctx, 'saveProgress', pending).catch(() => {});
      }, []);

      const persist = (offset, total) => {
        if (!chapter) return;
        pendingProgress.current = { bookId, ...mediaProgressPayload(chapter.id, offset, total) };
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          const pending = pendingProgress.current;
          pendingProgress.current = null;
          if (pending) call(ctx, 'saveProgress', pending).catch(() => {});
        }, 300);
      };

      const goChapter = (next) => {
        if (next < 0 || next >= toc.length) return;
        autoPlayRef.current = type === 'audio' && !!currentTrack && audioPlaying;
        if (type === 'video') captureVideo();
        flushProgress();
        setChapterIndex(next);
        setDrawer(false);
      };

      const closeReader = () => {
        if (type === 'video') captureVideo();
        flushProgress();
        onClose();
      };

      const onComicScroll = () => {
        if (type !== 'comic' || comicMode !== 'scroll' || !chapter) return;
        const node = scrollRef.current;
        if (!node) return;
        const stage = node.closest('.mr-media-stage') || node;
        const top = stage.getBoundingClientRect().top + 48;
        let active = 0;
        pageRefs.current.forEach((image, index) => {
          if (image && image.getBoundingClientRect().top <= top) active = index;
        });
        if (active !== pageIndex) {
          setPageIndex(active);
          persist(active, source.images?.length || 1);
        }
      };

      const changeComicPage = (next) => {
        const count = Math.max(1, source.images?.length || 1);
        const value = Math.min(count - 1, Math.max(0, next));
        setPageIndex(value);
        persist(value, count);
      };

      const toggleComicMode = () => {
        const next = comicMode === 'scroll' ? 'paged' : 'scroll';
        setComicMode(next);
        call(ctx, 'setBookSettings', { bookId, comicMode: next }).catch(() => {});
      };

      const playOrToggle = () => {
        if (!chapter || source.kind === 'error') return;
        if (currentTrack) onAudioToggle?.();
        else onAudioPlay?.({ bookId, bookName: book.name || book.title, chapterId: chapter.id, chapterTitle: chapter.title, url: source.url, hls: source.hls }, mediaStartSeconds(book, chapter), toc.map((item) => ({ bookId, chapterId: item.id, title: item.title })));
      };

      const captureVideo = () => {
        const el = videoRef.current;
        if (!el || type !== 'video' || !el.duration) return;
        persist(el.currentTime, el.duration);
      };

      const handleVideoTime = () => {
        const el = videoRef.current;
        if (!el || type !== 'video') return;
        if (el.currentTime - videoMark.current >= 5) {
          videoMark.current = el.currentTime;
          persist(el.currentTime, Math.max(el.duration || 0, 1));
        }
      };

      const startDownload = async () => {
        const ids = selected.filter((id) => {
          const chapterItem = toc.find((item) => item.id === id);
          return chapterItem && !chapterItem.downloaded;
        });
        if (!ids.length) { notify?.('选中的章节都已离线', 'info'); return; }
        try {
          await call(ctx, 'download', { bookId, chapterIds: ids });
          notify?.(`已开始下载 ${ids.length} 章`, 'success');
          onRefresh?.();
        } catch (cause) { notify?.(cause.message || String(cause), 'error'); }
      };

      const jobAction = async (action) => {
        const pausedJob = job?.status === 'paused';
        try {
          if (action === 'pause') await call(ctx, 'pauseJob', { bookId });
          else if (action === 'resume') await call(ctx, 'resumeJob', { bookId });
          else if (action === 'retry') {
            if (pausedJob) await call(ctx, 'resumeJob', { bookId });
            else await call(ctx, 'download', { bookId, chapterIds: job?.failedReasons ? Object.keys(job.failedReasons) : [] });
          }
          else if (action === 'cancel') await call(ctx, 'cancelJob', { jobId: job?.id });
          onRefresh?.();
        } catch (cause) { notify?.(cause.message || String(cause), 'error'); }
      };

      const cancelOne = async (chapterId) => {
        try {
          await call(ctx, 'cancelDownloadChapters', { bookId, chapterIds: [chapterId] });
          setSelected((items) => items.filter((id) => id !== chapterId));
          onRefresh?.();
        } catch (cause) { notify?.(cause.message || String(cause), 'error'); }
      };

      const images = source.kind === 'images' ? source.images : [];
      const count = Math.max(1, images.length);
      const audioTimeValue = currentTrack ? audioTime : 0;
      const audioDurationValue = currentTrack ? audioDuration : 0;

      return h('div', { className: `mr-reader mr-media-reader media-${type}` },
        h('header', { className: 'mr-editor-top' },
          h('button', { type: 'button', className: 'mr-reader-top-btn', 'aria-label': '返回书架', onClick: closeReader }, h(Glyph, { name: 'back', size: 20 })),
          h('div', { className: 'mr-media-head' }, h('strong', null, book.name || book.title), h('small', null, chapter?.title || toc[chapterIndex]?.title || '')),
          type === 'comic' ? h('button', { type: 'button', className: 'mr-reader-top-btn', onClick: toggleComicMode, 'aria-label': comicMode === 'scroll' ? '切换翻页' : '切换滚动', title: comicMode === 'scroll' ? '切换翻页' : '切换滚动' }, h(Glyph, { name: comicMode === 'scroll' ? 'grid' : 'scroll', size: 18 })) : null,
          h('button', { type: 'button', className: 'mr-reader-top-btn', 'aria-label': '目录', onClick: () => setDrawer((value) => !value) }, h(Glyph, { name: 'list', size: 18 })),
          h('button', { type: 'button', className: 'mr-reader-top-btn', 'aria-label': '下载', onClick: () => setSheetOpen(true) }, h(Glyph, { name: 'download', size: 18 }))),
        h('main', { className: `mr-media-stage ${type} ${comicMode}`, onScroll: type === 'comic' && comicMode === 'scroll' ? onComicScroll : undefined },
          loading ? h('div', { className: 'mr-loading' }, '正在载入…') : null,
          !loading && error ? h('div', { className: 'mr-media-error', role: 'alert' }, h(Glyph, { name: 'warning', size: 24 }), h('h2', null, '这一章打不开'), h('p', null, error), h('div', { className: 'mr-media-error-actions' }, h(Button, { onClick: () => { setError(''); setRetryNonce((value) => value + 1); } }, '重试'), sourceLink)) : null,
          !loading && !error && type === 'comic' ? h('div', { ref: scrollRef, className: `mr-comic ${comicMode}` },
            source.kind === 'error' ? h('div', { className: 'mr-media-error' }, h('p', null, source.error), sourceLink) : images.map((url, index) => h('img', { key: `${chapter?.id}-${index}`, ref: (node) => { pageRefs.current[index] = node; }, src: url, alt: `${chapter?.title || ''} 第 ${index + 1} 页`, className: comicMode === 'paged' && index !== pageIndex ? 'is-hidden' : '', loading: index < 2 ? 'eager' : 'lazy', onLoad: (event) => { if (type === 'comic' && comicMode === 'scroll' && index === pageIndex && restoredChapterRef.current !== chapter?.id) { restoredChapterRef.current = chapter?.id; event.currentTarget.scrollIntoView({ block: 'start' }); } } })),
            comicMode === 'paged' ? h('div', { className: 'mr-comic-nav' }, h(Button, { disabled: pageIndex <= 0, onClick: () => changeComicPage(pageIndex - 1) }, '上一页'), h('span', null, `${pageIndex + 1} / ${count}`), h(Button, { disabled: pageIndex >= count - 1, onClick: () => changeComicPage(pageIndex + 1) }, '下一页')) : null) : null,
          !loading && !error && type === 'audio' ? h('div', { className: 'mr-audio-stage' },
            h('div', { className: 'mr-media-cover' }, h(Glyph, { name: 'audio', size: 56 })),
            h('h1', null, chapter?.title || '音频章节'), h('p', null, book.name || book.title),
            source.kind === 'error' ? h('div', { className: 'mr-media-error' }, h('p', null, source.error), sourceLink) : h('div', { className: 'mr-audio-controls' },
              h('button', { type: 'button', className: 'mr-play-big', onClick: playOrToggle, 'aria-label': audioPlaying ? '暂停' : '播放' }, h(Glyph, { name: audioPlaying && currentTrack ? 'pause' : 'play', size: 30 })),
              h('input', { type: 'range', 'aria-label': '播放进度', min: 0, max: Math.max(1, Math.floor(audioDurationValue)), value: Math.min(audioTimeValue, audioDurationValue), onChange: (event) => onAudioSeek?.(Number(event.target.value)) }),
              h('span', null, `${formatMediaTime(audioTimeValue)} / ${formatMediaTime(audioDurationValue)}`),
              h('div', { className: 'mr-media-chapter-nav' }, h(Button, { disabled: chapterIndex <= 0, onClick: () => goChapter(chapterIndex - 1) }, '上一章'), h(Button, { disabled: chapterIndex >= toc.length - 1, onClick: () => goChapter(chapterIndex + 1) }, '下一章'))) ) : null,
          !loading && !error && type === 'video' ? h('div', { className: 'mr-video-stage' },
            source.kind === 'error' ? h('div', { className: 'mr-media-error', role: 'alert' }, h(Glyph, { name: 'warning', size: 24 }), h('h2', null, '视频无法播放'), h('p', null, source.error), h('div', { className: 'mr-media-error-actions' }, h(Button, { onClick: () => setSheetOpen(true) }, '打开下载'), sourceLink)):
              h('video', { ref: videoRef, controls: true, playsInline: true, preload: 'metadata', src: source.hls ? undefined : source.url, onLoadedMetadata: (event) => { const start = mediaStartSeconds(book, chapter); const duration = Number(event.currentTarget.duration) || 0; if (start > 0 && (!duration || start < duration - 1)) { try { event.currentTarget.currentTime = start; } catch {} } }, onTimeUpdate: handleVideoTime, onPause: () => captureVideo(), onError: () => setError('视频加载失败：地址可能已失效，或浏览器不支持该格式。'), onEnded: () => { const el = videoRef.current; persist(el?.duration || 0, el?.duration || 1); } })) : null),
        h('footer', { className: 'mr-media-foot' }, h(Button, { disabled: chapterIndex <= 0, onClick: () => goChapter(chapterIndex - 1) }, '上一章'), h('span', null, chapter?.title || ''), h(Button, { disabled: chapterIndex >= toc.length - 1, onClick: () => { goChapter(chapterIndex + 1); } }, '下一章')),
        drawer ? h('div', { className: 'mr-media-drawer' }, h('header', null, h('strong', null, '目录'), h('button', { onClick: () => setDrawer(false) }, '关闭')), toc.map((item, index) => h('button', { key: item.id, className: index === chapterIndex ? 'active' : '', onClick: () => goChapter(index) }, h('span', null, item.title), item.downloaded ? h('small', null, '已离线') : null))) : null,
        sheetOpen ? h(MediaDownloadSheet, { book, toc, job, selected, setSelected, onClose: () => setSheetOpen(false), onStart: startDownload, onJobAction: jobAction, onCancelOne: cancelOne, onRetain: (chapterId, retained) => call(ctx, 'setChapterRetained', { bookId, chapterId, retained }).then(reloadCache).catch((cause) => notify(cause.message || String(cause), 'error')), quota: settings.mediaQuotaBytes, cacheUsed, bookUsed, records: cacheRecords }) : null);
    }

    function MediaDownloadSheet({ book, toc, job, selected, setSelected, onClose, onStart, onJobAction, onCancelOne, onRetain, quota, cacheUsed = 0, bookUsed = 0, records = [] }) {
      const done = toc.filter((item) => item.downloaded).length;
      const running = job && ['queued', 'running'].includes(job.status);
      const paused = job?.status === 'paused';
      const failed = job?.failedReasons && Object.keys(job.failedReasons).length > 0;
      const active = running || paused;
      const pendingCount = selected.filter((id) => !toc.find((item) => item.id === id)?.downloaded).length;
      const averageSize = done > 0 ? bookUsed / done : 0;
      const estimate = Math.max(0, averageSize * pendingCount);
      const remaining = Math.max(0, (Number(quota) || 0) - (Number(cacheUsed) || 0));
      return h('div', { className: 'mr-sheet-backdrop', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('section', { className: 'mr-download-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': '下载面板' },
          h('header', null, h('div', null, h('h2', null, '离线缓存'), h('p', null, `${done} / ${toc.length} 章已离线 · 已用 ${formatBytes(bookUsed)} / 上限 ${formatBytes(quota || 0)}`), pendingCount ? h('p', { className: estimate > remaining ? 'mr-download-warning' : '' }, estimate > 0 ? `预计新增 ${formatBytes(estimate)}，剩余 ${formatBytes(remaining)}` : `剩余 ${formatBytes(remaining)}，可缓存 ${pendingCount} 章`) : null), h('button', { type: 'button', className: 'mr-reader-top-btn', onClick: onClose, 'aria-label': '关闭' }, h(Glyph, { name: 'close', size: 18 }))),
          job ? h('div', { className: `mr-download-job ${job.state || job.status}` }, h('strong', null, job.state === 'ready' ? '已完成' : job.state === 'retry' ? '部分失败' : job.state === 'error' ? '下载失败' : job.state === 'paused' ? '已暂停' : job.state === 'cancelled' ? '已取消' : '下载中'), h('span', null, `${job.done || 0} / ${job.total || 0}`), job.error ? h('small', null, job.error) : null) : null,
          h('div', { className: 'mr-download-tools' }, h(Button, { onClick: () => setSelected(selected.length === toc.length ? [] : toc.map((item) => item.id)) }, selected.length === toc.length ? '取消全选' : '全选'), h('span', null, `已选 ${selected.length} 章`)),
          h('div', { className: 'mr-download-list' }, toc.map((item) => {
            const reason = job?.failedReasons?.[item.id];
            const checked = selected.includes(item.id);
            const chapterRecords = records.filter((record) => record.chapterId === item.id);
            const retained = chapterRecords.length > 0 && chapterRecords.every((record) => record.retained);
            return h('div', { key: item.id, className: `mr-download-row${item.downloaded ? ' is-ready' : ''}${reason ? ' is-failed' : ''}` },
              h('input', { type: 'checkbox', 'aria-label': `${item.title} 选择`, checked, onChange: () => setSelected((items) => items.includes(item.id) ? items.filter((id) => id !== item.id) : [...items, item.id]) }),
              h('span', { className: 'mr-download-title' }, item.title),
              h('em', null, item.downloaded ? '已离线' : reason ? `失败 · ${reason}` : running ? '等待' : '未缓存'),
              h('span', { className: 'mr-download-actions' },
                item.downloaded && chapterRecords.length ? h('button', { type: 'button', className: `mr-download-retain${retained ? ' is-on' : ''}`, 'aria-pressed': retained, onClick: (event) => { event.preventDefault(); event.stopPropagation(); onRetain?.(item.id, !retained); } }, retained ? '取消保留' : '保留') : null,
                active && !item.downloaded && (!job?.chapterIds || job.chapterIds.includes(item.id)) ? h('button', { type: 'button', className: 'mr-download-cancel', onClick: (event) => { event.preventDefault(); event.stopPropagation(); onCancelOne(item.id); } }, '取消本章') : null));
          })),
          h('footer', null,
            h(Button, { kind: 'primary', onClick: onStart, disabled: !selected.length || running || paused }, '开始下载'),
            paused ? h(Button, { onClick: () => onJobAction('resume') }, '继续') : null,
            running ? h(Button, { onClick: () => onJobAction('pause') }, '暂停') : null,
            failed && !running ? h(Button, { onClick: () => onJobAction('retry') }, '重试失败章') : null,
            active ? h(Button, { onClick: () => onJobAction('cancel') }, '取消任务') : null)));
    }

    function ReaderView({ ctx, book, settings, onSettings, onBookSettings, notes, onClose, onSaveNote, onDeleteNote, notify, notice, onDismissNotice, deferMs = 0 }) {
      const [toc, setToc] = useState([]);
      const [chromeOpen, setChromeOpen] = useState(false);
      const [chapter, setChapter] = useState(null);
      const [chapterIndex, setChapterIndex] = useState(-1);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [drawer, setDrawer] = useState('');
      const [speaking, setSpeaking] = useState(false);
      const [noteText, setNoteText] = useState('');
      const [aiQuestion, setAiQuestion] = useState('');
      const [aiResult, setAiResult] = useState(null);
      const [voices, setVoices] = useState([]);
      const [quote, setQuote] = useState('');
      const [scrollPercent, setScrollPercent] = useState(0);
      const [retryNonce, setRetryNonce] = useState(0);
      const [failedIndex, setFailedIndex] = useState(-1);
      const bookPrefs = book.readerPrefs || null;
      const prefMode = bookPrefs?.mode || settings.mode || 'scroll';
      const prefFlipStyle = bookPrefs?.flipStyle || settings.flipStyle || 'slide';
      const prefAmbience = bookPrefs?.ambience || settings.ambience || 'full';
      // No WebGL or reduced motion means instant page changes; the CSS-based
      // slide/flip/fade styles stay available when WebGL is missing only if
      // the user has motion on, so this flag also gates CSS animation.
      const motionOff = prefersReducedMotion() || settings.reducedMotion === 'on' || settings.animations === false;
      const [mode, setMode] = useState(prefMode);
      const modeRef = useRef(prefMode);
      const [columns, setColumns] = useState(1);
      const [pageIndex, setPageIndex] = useState(0);
      const [pageCount, setPageCount] = useState(1);
      // 页数是按章量的：换章后到 measureLayout 跑完之前，pageCount 还是上一章的值，
      // 这段时间里宁可先不显示页码，也别闪一个错的。
      const [measuredFor, setMeasuredFor] = useState('');
      const [pageStep, setPageStep] = useState(0);
      const [pageWidth, setPageWidth] = useState(0);
      const [dragging, setDragging] = useState(false);
      const [dragOffset, setDragOffset] = useState(0);
      const [chapterVeil, setChapterVeil] = useState('');
      const [flipStyle, setFlipStyle] = useState(prefFlipStyle);
      const [turning, setTurning] = useState(false);
      const [fadeIn, setFadeIn] = useState(false);
      const scrollRef = useRef(null);
      const pagedRef = useRef(null);
      const articleRef = useRef(null);
      const pageIndexRef = useRef(0);
      const pendingPercentRef = useRef(null);
      const dragRef = useRef(null);
      const suppressClickRef = useRef(false);
      const turnHostRef = useRef(null);
      const turnRef = useRef(false);
      const turnTimer = useRef(null);
      const readerThreeRef = useRef(null);
      const ambienceHostRef = useRef(null);
      const ambienceRef = useRef(null);
      const scrollMotionRef = useRef({ target: 0, current: 0, velocity: 0, settle: 0 });
      const drawerRef = useRef('');
      drawerRef.current = drawer;
      const tocActiveRef = useRef(null);
      const veilTimer = useRef(null);
      const measureRef = useRef(null);
      const requestRef = useRef(0);
      const speechGeneration = useRef(0);
      const saveTimer = useRef(null);
      const webglRef = useRef(true);
      const pendingOffsetRef = useRef(null);
      const progressRef = useRef({ bookId: book.id || book.bookId, chapterId: null, percent: 0, offset: 0 });
      const lastSaveAtRef = useRef(0);
      const mirrorAtRef = useRef({ at: 0, chapterId: '' });
      const [scrollChapters, setScrollChapters] = useState([]);
      const [scrollError, setScrollError] = useState(null);
      const scrollChaptersRef = useRef([]);
      const chapterIndexRef = useRef(-1);
      const chapterNodesRef = useRef(new Map());
      const pageForOffsetRef = useRef(null);
      const textIndexRef = useRef(null);
      const scrollAppendRef = useRef(false);
      const trimTimerRef = useRef(0);
      const pendingScrollRestoreRef = useRef(null);
      const suppressScrollUntilRef = useRef(0);
      const modeReadyRef = useRef(false);
      const pendingPagePercentRef = useRef(null);
      const lastPercentRef = useRef(0);
      const bookId = book.id || book.bookId;
      const theme = settings.readerTheme || 'paper';
      useEffect(() => { pageIndexRef.current = pageIndex; }, [pageIndex]);
      useEffect(() => { chapterIndexRef.current = chapterIndex; }, [chapterIndex]);
      useEffect(() => { scrollChaptersRef.current = scrollChapters; }, [scrollChapters]);
      const restorePendingScroll = () => {
        const pending = pendingScrollRestoreRef.current;
        if (!pending || modeRef.current !== 'scroll') return;
        const node = chapterNodesRef.current.get(pending.index);
        const el = scrollRef.current;
        if (!node || !el || !node.isConnected) return;
        pendingScrollRestoreRef.current = null;
        suppressScrollUntilRef.current = performance.now() + 120;
        const offset = pending.offset != null
          ? pending.offset
          : (pending.percent || 0) / 100 * Math.max(1, node.offsetHeight);
        // 裁章后的坐标换算必须立即完成；继承 CSS smooth 会把内部恢复动画展示给读者。
        el.scrollTo({ top: Math.max(0, nodeTop(node) + offset), behavior: 'instant' });
      };
      // 窗口裁章会一次性移除视口上方几千像素，必须在这一帧 paint 之前把 scrollTop 摆回去，
      // 否则用户会看到「闪一下又归位」（真机上就是跳页）。
      useLayoutEffect(() => { restorePendingScroll(); }, [scrollChapters, mode]);
      useEffect(() => {
        if (!modeReadyRef.current) { modeReadyRef.current = true; return; }
        const index = chapterIndexRef.current;
        if (index < 0) return;
        if (mode !== 'scroll') {
          pendingPagePercentRef.current = lastPercentRef.current;
          return;
        }
        const percent = lastPercentRef.current || 0;
        if (scrollChaptersRef.current.some((entry) => entry.index === index)) {
          requestAnimationFrame(() => {
            pendingScrollRestoreRef.current = { index, percent };
            restorePendingScroll();
          });
        } else {
          loadScrollWindow(index, toc, { restore: { index, percent } });
        }
      }, [mode]);
      useEffect(() => { webglRef.current = supportsWebGL(); }, []);
      // 加载系统语音列表
      useEffect(() => {
        const loadVoices = () => { const list = window.speechSynthesis?.getVoices() || []; setVoices(list); };
        loadVoices();
        window.speechSynthesis?.addEventListener('voiceschanged', loadVoices);
        return () => window.speechSynthesis?.removeEventListener('voiceschanged', loadVoices);
      }, []);
      useEffect(() => { setMode(prefMode); }, [prefMode]);
      useEffect(() => { modeRef.current = mode; }, [mode]);
      useEffect(() => { setFlipStyle(prefFlipStyle); }, [prefFlipStyle]);
      const persistPref = (key, value) => {
        if (bookPrefs) onBookSettings?.({ [key]: value });
        else onSettings?.({ [key]: value });
      };
      const chooseFlip = (value) => { setFlipStyle(value); persistPref('flipStyle', value); };
      useEffect(() => () => {
        clearTimeout(turnTimer.current);
        turnHostRef.current?.remove?.();
        turnHostRef.current = null;
        turnRef.current = false;
      }, []);
      useEffect(() => {
        const host = ambienceHostRef.current;
        if (!host) return undefined;
        if (!webglRef.current || motionOff || prefAmbience === 'off') return undefined;
        let active = true;
        let api = null;
        (async () => {
          try {
            const module = readerThreeRef.current || await require.async('./client.gl.js');
            readerThreeRef.current = module;
            if (!active || !ambienceHostRef.current) return;
            if (!module || typeof module.mountAmbience !== 'function') return;
            api = module.mountAmbience(ambienceHostRef.current, {
              theme: settings.readerTheme || 'paper',
              quality: settings.motionQuality || 'auto',
              ambience: prefAmbience,
              reducedMotion: motionOff,
            });
            ambienceRef.current = api;
            api.setProgress((scrollPercent || 0) / 100);
            if (drawerRef.current || document.hidden) api.pause();
          } catch {}
        })();
        return () => {
          active = false;
          try { api?.dispose?.(); } catch {}
          if (ambienceRef.current === api) ambienceRef.current = null;
        };
      }, [prefAmbience, motionOff]);
      useEffect(() => { ambienceRef.current?.setTheme(theme); }, [theme]);
      useEffect(() => { ambienceRef.current?.setQuality(settings.motionQuality || 'auto'); }, [settings.motionQuality]);
      useEffect(() => { ambienceRef.current?.setAmbience(prefAmbience); }, [prefAmbience]);
      useEffect(() => {
        const total = pageCount > 1 ? (pageIndex + Math.min(1, scrollPercent / 100)) / pageCount : (scrollPercent || 0) / 100;
        ambienceRef.current?.setProgress(total);
      }, [scrollPercent, pageIndex, pageCount]);
      useEffect(() => { ambienceRef.current?.setSeam(turning ? 0.45 : 0, 0.5); }, [turning]);
      useEffect(() => {
        if (drawer !== 'toc') return undefined;
        const frame = requestAnimationFrame(() => {
          const node = tocActiveRef.current;
          if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' });
        });
        return () => cancelAnimationFrame(frame);
      }, [drawer]);
      useEffect(() => {
        const api = ambienceRef.current;
        if (!api) return;
        if (drawer || document.hidden) api.pause();
        else api.resume();
      }, [drawer]);
      useEffect(() => {
        let timer = 0;
        const wake = () => {
          const api = ambienceRef.current;
          if (api && !document.hidden && !drawerRef.current) api.resume();
          window.clearTimeout(timer);
          timer = window.setTimeout(() => { ambienceRef.current?.pause(); }, 8000);
        };
        const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
        for (const name of events) window.addEventListener(name, wake, { passive: true });
        timer = window.setTimeout(() => { ambienceRef.current?.pause(); }, 8000);
        return () => {
          for (const name of events) window.removeEventListener(name, wake);
          window.clearTimeout(timer);
        };
      }, []);
      useEffect(() => {
        if (mode !== 'scroll' || !chapter || motionOff) return undefined;
        const el = scrollRef.current;
        if (!el) return undefined;
        const state = scrollMotionRef.current;
        let frame = 0;
        let last = 0;
        const tick = (now) => {
          const dt = Math.min(64, now - (last || now));
          last = now;
          const max = Math.max(1, el.scrollHeight - el.clientHeight);
          const target = scrollMotion.progress(el.scrollTop / max);
          const previous = state.current;
          state.target = target;
          state.velocity = scrollMotion.smooth(state.velocity, scrollMotion.velocity(previous, target, dt), dt, 8);
          state.current = scrollMotion.smooth(state.current, target, dt, 7);
          const axes = scrollMotion.axis(state.current, el.clientHeight, {
            short: el.scrollHeight <= el.clientHeight + 1,
            still: motionOff,
          });
          ambienceRef.current?.setScroll?.(state.current, state.velocity, axes);
          frame = window.requestAnimationFrame(tick);
        };
        frame = window.requestAnimationFrame(tick);
        return () => {
          window.cancelAnimationFrame(frame);
          window.clearTimeout(state.settle);
        };
      }, [mode, chapter, motionOff]);
      const chapterIdAt = (index = chapterIndex) => {
        const item = toc[index];
        return item && (item.id || item.chapterId || item.url || item.chapterUrl || String(index));
      };
      const articleTextNodes = () => {
        const article = articleRef.current;
        if (!article) return [];
        const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.nodeValue && node.nodeValue.length) nodes.push(node);
        }
        return nodes;
      };
      const offsetOfNode = (node, nodeOffset) => {
        if (!node || node.nodeType !== 3) return null;
        const nodes = articleTextNodes();
        const index = nodes.indexOf(node);
        if (index < 0) return null;
        let total = 0;
        for (let i = 0; i < index; i += 1) total += nodes[i].nodeValue.length;
        return total + Math.max(0, Math.min(Number(nodeOffset) || 0, node.nodeValue.length));
      };
      const nodeAtOffset = (offset) => {
        const nodes = articleTextNodes();
        let rest = Math.max(0, Math.floor(Number(offset) || 0));
        for (const node of nodes) {
          if (rest <= node.nodeValue.length) return { node, offset: rest };
          rest -= node.nodeValue.length;
        }
        const last = nodes[nodes.length - 1];
        return last ? { node: last, offset: last.nodeValue.length } : null;
      };
      const caretFromPoint = (x, y) => {
        try {
          if (document.caretRangeFromPoint) {
            const range = document.caretRangeFromPoint(x, y);
            if (range) return { node: range.startContainer, offset: range.startOffset };
          }
          if (document.caretPositionFromPoint) {
            const position = document.caretPositionFromPoint(x, y);
            if (position) return { node: position.offsetNode, offset: position.offset };
          }
        } catch {}
        return null;
      };
      // First character of the page currently in view, as a character offset
      // into the whole chapter (not the DOM node). Percent cannot survive a
      // font-size change; an offset can be mapped back to the exact column.
      const pageStartOffset = () => {
        const view = pagedRef.current;
        const rect = view?.getBoundingClientRect();
        if (!rect) return null;
        const points = [[rect.left + 28, rect.top + 60], [rect.left + 28, rect.top + 110], [rect.left + 28, rect.bottom - 40]];
        for (const [x, y] of points) {
          const point = caretFromPoint(x, y);
          const offset = point ? offsetOfNode(point.node, point.offset) : null;
          if (offset != null) return offset;
        }
        return null;
      };
      const showChapterVeil = (text) => {
        if (!text) return;
        setChapterVeil(text);
        clearTimeout(veilTimer.current);
        veilTimer.current = setTimeout(() => setChapterVeil(''), 1100);
      };
      useEffect(() => () => { clearTimeout(veilTimer.current); clearTimeout(trimTimerRef.current); }, []);
      const commitProgress = (percent, offset = progressRef.current.offset || 0, index = chapterIndex) => {
        setScrollPercent(percent);
        const chapterId = chapterIdAt(index);
        progressRef.current = { bookId, chapterId, percent, offset };
        // 阅读时长统计：每次进度变化记一次活跃
        const today = new Date().toISOString().slice(0, 10);
        const statsKey = `mo-reader:stats:${today}`;
        const stats = JSON.parse(localStorage.getItem(statsKey) || '{"minutes":0,"pages":0,"lastActive":0}');
        const nowTs = Date.now();
        if (nowTs - stats.lastActive > 60000) stats.minutes += 1; // 超过 1 分钟算新会话
        stats.lastActive = nowTs;
        localStorage.setItem(statsKey, JSON.stringify(stats));
        // 阅读目标检查
        if (settings.dailyGoal > 0 && stats.minutes >= settings.dailyGoal) {
          const goalKey = `mo-reader:goal-notified:${today}`;
          if (!localStorage.getItem(goalKey)) {
            localStorage.setItem(goalKey, '1');
            notify?.('今日阅读目标已完成！', 'success');
          }
        }
        // 1. 同步写一份到 localStorage：崩溃/刷新时最多丢 350ms 的滚动。
        const stamp = Date.now();
        if (chapterId !== mirrorAtRef.current.chapterId || stamp - mirrorAtRef.current.at > 350) {
          mirrorAtRef.current = { at: stamp, chapterId };
          writeProgressMirror({ bookId, chapterId, percent, offset, savedAt: new Date(stamp).toISOString() });
        }
        // 2. 服务端存盘：滚动中一直有事件的话，600ms 的尾随定时器会被不断推后，
        //    所以再加一个 1.2s 的节流，保证持续阅读时也在定期落盘。
        const save = () => {
          lastSaveAtRef.current = Date.now();
          call(ctx, 'saveProgress', { bookId, chapterId, percent, offset }).catch(() => {});
        };
        clearTimeout(saveTimer.current);
        if (stamp - lastSaveAtRef.current >= 1200) save();
        else saveTimer.current = setTimeout(save, 600);
      };
      const flushProgress = () => {
        clearTimeout(saveTimer.current);
        const payload = { ...progressRef.current };
        if (!payload.chapterId) return Promise.resolve();
        writeProgressMirror({ ...payload, savedAt: new Date().toISOString() });
        lastSaveAtRef.current = Date.now();
        return call(ctx, 'saveProgress', payload).catch(() => {});
      };
      const closeReader = async () => {
        await flushProgress();
        onClose();
      };

      const chapterSourceId = (index, list = toc) => {
        const item = list[index];
        return item && (item.id || item.chapterId || item.url || item.chapterUrl || String(index));
      };
      const fetchChapterEntry = async (index, list = toc) => {
        const id = chapterSourceId(index, list);
        if (!id) return null;
        // 离线缓存：先查 localStorage，没有再请求
        const cacheKey = `mo-reader:chapter:${bookId}:${id}`;
        try {
          const cached = localStorage.getItem(cacheKey);
          if (cached) {
            const { text, timestamp } = JSON.parse(cached);
            // 缓存 7 天有效
            if (Date.now() - timestamp < 7 * 24 * 3600 * 1000) {
              return { index, chapter: { text, cached: true } };
            }
          }
        } catch {}
        const value = await call(ctx, 'chapter', { bookId, chapterId: id });
        // 写入缓存
        if (value?.text) {
          try { localStorage.setItem(cacheKey, JSON.stringify({ text: value.text, timestamp: Date.now() })); } catch {}
        }
        return { index, chapter: value || {} };
      };
      // 预加载：当前章加载后，后台预取下一章
      const prefetchNextChapter = (currentIndex) => {
        const next = currentIndex + 1;
        if (next >= toc.length) return;
        const id = chapterSourceId(next, toc);
        if (!id) return;
        const cacheKey = `mo-reader:chapter:${bookId}:${id}`;
        try { if (localStorage.getItem(cacheKey)) return; } catch {}
        call(ctx, 'chapter', { bookId, chapterId: id }).then(value => {
          if (value?.text) {
            try { localStorage.setItem(cacheKey, JSON.stringify({ text: value.text, timestamp: Date.now() })); } catch {}
          }
        }).catch(() => {});
      };
      const nodeTop = (node) => {
        const el = scrollRef.current;
        if (!node || !el) return 0;
        return node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      };
      const loadScrollWindow = async (center, list0 = toc, options = {}) => {
        const wanted = [center - 1, center, center + 1].filter((index) => index >= 0 && index < list0.length);
        const entries = await Promise.all(wanted.map((index) => fetchChapterEntry(index, list0).catch(() => null)));
        const list = entries.filter(Boolean).sort((a, b) => a.index - b.index);
        if (options.restore) pendingScrollRestoreRef.current = options.restore;
        setScrollChapters(list);
        scrollChaptersRef.current = list;
        const current = list.find((entry) => entry.index === center) || list[0] || null;
        if (current) { setChapter(current.chapter); setChapterIndex(current.index); chapterIndexRef.current = current.index; prefetchNextChapter(current.index); }
        return list;
      };
      const anchorAtScroll = (wanted) => {
        const el = scrollRef.current;
        if (!el) return null;
        const list = scrollChaptersRef.current;
        let current = list[0];
        for (const entry of list) {
          const node = chapterNodesRef.current.get(entry.index);
          if (node && nodeTop(node) <= el.scrollTop + 12) current = entry;
        }
        if (!current) return null;
        const kept = wanted.filter((index) => index >= current.index);
        if (!kept.length) return null;
        if (kept[0] !== current.index) return { index: kept[0], offset: 0 };
        const node = chapterNodesRef.current.get(current.index);
        if (!node) return null;
        const offset = el.scrollTop - nodeTop(node);
        return { index: current.index, offset: Math.max(0, Math.min(Math.max(0, node.offsetHeight - 1), offset)) };
      };
      const normalizeWindow = async (center) => {
        const wanted = [center - 1, center, center + 1].filter((index) => index >= 0 && index < toc.length);
        const list = scrollChaptersRef.current;
        const have = new Map(list.map((entry) => [entry.index, entry]));
        if (wanted.length === list.length && wanted.every((index) => have.has(index))) return;
        const missing = wanted.filter((index) => !have.has(index));
        const fetched = await Promise.all(missing.map((index) => fetchChapterEntry(index).catch(() => null)));
        const seen = new Set();
        const next = wanted
          .map((index) => have.get(index) || fetched.find((entry) => entry && entry.index === index))
          .filter((entry) => entry && !seen.has(entry.index) && seen.add(entry.index));
        if (!next.length) return;
        // 以「此刻视口里的那一段」为锚，避免等 fetch 期间用户又滚了几百像素造成回跳。
        pendingScrollRestoreRef.current = anchorAtScroll(wanted) || { index: center, percent: 0 };
        suppressScrollUntilRef.current = performance.now() + 400;
        setScrollChapters(next);
        scrollChaptersRef.current = next;
      };

      const appendScrollChapter = async (index) => {
        if (scrollAppendRef.current) return;
        if (index < 0 || index >= toc.length) return;
        if (scrollChaptersRef.current.some((entry) => entry.index === index)) return;
        scrollAppendRef.current = true;
        try {
          const entry = await fetchChapterEntry(index);
          if (!entry) return;
          if (scrollChaptersRef.current.some((item) => item.index === index)) return;
          const list = [...scrollChaptersRef.current, entry].sort((a, b) => a.index - b.index);
          setScrollChapters(list);
          scrollChaptersRef.current = list;
          setScrollError(null);
        } catch {
          setScrollError(index);
        } finally {
          scrollAppendRef.current = false;
        }
      };
      const openChapter = async (index, restore = false, atPercent = null) => {
        if (!toc[index]) return;
        const requestId = ++requestRef.current;
        flushProgress();
        setLoading(true); setError(''); setDrawer(''); setFailedIndex(index); setScrollError(null);
        stopSpeech();
        const item = toc[index];
        const id = chapterSourceId(index);
        const saved = atPercent != null
          ? Math.max(0, Math.min(100, Number(atPercent) || 0))
          : restore ? Number(book.lastRead?.percent || book.progress?.percent || book.percent || 0) : 0;
        const savedOffset = atPercent != null ? 0 : restore ? Number(book.lastRead?.offset || book.progress?.offset || 0) : 0;
        try {
          if (mode === 'scroll') {
            const list = await loadScrollWindow(index, toc, { restore: { index, percent: saved } });
            if (requestId !== requestRef.current) return;
            if (!list.some((entry) => entry.index === index)) throw new Error('章节未加载');
            progressRef.current = { bookId, chapterId: id, percent: saved, offset: savedOffset };
            pendingPercentRef.current = saved;
            pendingOffsetRef.current = savedOffset > 0 ? savedOffset : null;
            lastPercentRef.current = saved;
            setPageIndex(0);
            pageIndexRef.current = 0;
            setScrollPercent(saved);
            setFailedIndex(-1);
            return;
          }
          const value = await call(ctx, 'chapter', { bookId, chapterId: id });
          if (requestId !== requestRef.current) return;
          setChapter(value || {});
          setChapterIndex(index);
          setFailedIndex(-1);
          if (mode !== 'scroll') showChapterVeil((value && (value.name || value.title)) || item.name || item.title || '正文');
          progressRef.current = { bookId, chapterId: id, percent: saved, offset: savedOffset };
          pendingPercentRef.current = saved;
          pendingOffsetRef.current = savedOffset > 0 ? savedOffset : null;
          setPageIndex(0);
          pageIndexRef.current = 0;
          setScrollPercent(saved);
          requestAnimationFrame(() => {
            if (!scrollRef.current) return;
            scrollRef.current.scrollTop = saved > 0 ? saved / 100 * (scrollRef.current.scrollHeight - scrollRef.current.clientHeight) : 0;
          });
        } catch (cause) { if (requestId === requestRef.current) setError(cause.message || String(cause)); }
        finally { if (requestId === requestRef.current) setLoading(false); }
      };

      useEffect(() => {
        const onPageHide = () => { flushProgress(); };
        const onVisibility = () => { if (document.visibilityState === 'hidden') flushProgress(); };
        window.addEventListener('pagehide', onPageHide);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          window.removeEventListener('pagehide', onPageHide);
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, []);

      useEffect(() => {
        let active = true;
        let timer = 0;
        const requestId = ++requestRef.current;
        const start = async () => {
          try {
            const result = await call(ctx, 'toc', { bookId });
            const list = Array.isArray(result) ? result : result?.chapters || result?.items || [];
            if (!active || requestId !== requestRef.current) return;
            setToc(list);
            let savedId = book.lastRead?.chapterId || book.progress?.chapterId || book.chapterId;
            let index = Math.max(0, list.findIndex((item, i) => (item.id || item.chapterId || item.url || item.chapterUrl || String(i)) === savedId));
            // 上次是被刷新/杀掉的话，书里的进度可能落后几十毫秒到几百毫秒，
            // localStorage 里那份「刚滚到的位置」更新就用它。
            const mirror = readProgressMirror();
            const mirrorIndex = mirror && mirror.bookId === bookId
              ? list.findIndex((item, i) => (item.id || item.chapterId || item.url || item.chapterUrl || String(i)) === mirror.chapterId)
              : -1;
            const mirrorAt = Date.parse(mirror?.savedAt || 0) || 0;
            const storedAt = Date.parse(book.progress?.updatedAt || book.lastRead?.updatedAt || 0) || 0;
            const useMirror = mirrorIndex >= 0 && mirrorAt > storedAt;
            if (useMirror) { savedId = mirror.chapterId; index = mirrorIndex; }
            if (list.length) {
              setFailedIndex(index);
              const item = list[index];
              const id = item.id || item.chapterId || item.url || item.chapterUrl || String(index);
              const saved = useMirror ? Math.max(0, Math.min(100, Number(mirror.percent) || 0)) : Number(book.lastRead?.percent || book.progress?.percent || book.percent || 0);
              const savedOffset = useMirror ? Number(mirror.offset) || 0 : Number(book.lastRead?.offset || book.progress?.offset || 0);
              progressRef.current = { bookId, chapterId: id, percent: saved, offset: savedOffset };
              pendingPercentRef.current = saved;
              pendingOffsetRef.current = savedOffset > 0 ? savedOffset : null;
              setPageIndex(0);
              pageIndexRef.current = 0;
              setScrollPercent(saved);
              if (modeRef.current === 'scroll') {
                await loadScrollWindow(index, list, { restore: { index, percent: saved } });
                if (!active || requestId !== requestRef.current) return;
                setFailedIndex(-1);
              } else {
                const value = await call(ctx, 'chapter', { bookId, chapterId: id });
                if (!active || requestId !== requestRef.current) return;
                setChapter(value || {}); setChapterIndex(index); setFailedIndex(-1);
                requestAnimationFrame(() => {
                  if (!scrollRef.current) return;
                  scrollRef.current.scrollTop = saved > 0 ? saved / 100 * (scrollRef.current.scrollHeight - scrollRef.current.clientHeight) : 0;
                });
              }
            }
          } catch (cause) { if (active && requestId === requestRef.current) setError(cause.message || String(cause)); }
          finally { if (active && requestId === requestRef.current) setLoading(false); }
        };
        if (deferMs > 0) timer = window.setTimeout(() => { if (active) start(); }, deferMs);
        else start();
        return () => { active = false; window.clearTimeout(timer); speechGeneration.current += 1; window.speechSynthesis?.cancel(); flushProgress(); };
      }, [bookId, retryNonce, deferMs]);

      useEffect(() => {
        if (mode !== 'paged' || !pageCount) return undefined;
        const pending = pendingPagePercentRef.current;
        if (pending == null) return undefined;
        const timer = setTimeout(() => {
          pendingPagePercentRef.current = null;
          goPage(paginationMath.pageForPercent(pending, pageCount));
        }, 160);
        return () => clearTimeout(timer);
      }, [mode, pageCount]);
      useEffect(() => {
        if (mode !== 'scroll' || !toc.length || chapterIndex < 0) return undefined;
        if (scrollChaptersRef.current.some((entry) => entry.index === chapterIndex)) return undefined;
        let active = true;
        loadScrollWindow(chapterIndex, toc, { restore: { index: chapterIndex, percent: scrollPercent } }).catch(() => {});
        return () => { active = false; };
      }, [mode, toc.length]);


      useEffect(() => {
        if (!drawer) return;
        const onKeyDown = (event) => { if (event.key === 'Escape') setDrawer(''); };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [drawer]);

      // 朗读跟页：翻页模式下把正在读的那句映射回页码，自动翻过去。
      // 正文段落没有换行符，朗读切句却可能带着，所以比对时先去掉空白，
      // 再靠 map 把「无空白串」的下标换回原文偏移。
      const articleIndex = () => {
        const article = articleRef.current;
        if (!article) return null;
        const full = article.textContent || '';
        const key = `${chapterIdAt()}|${full.length}|${modeRef.current}`;
        const cached = textIndexRef.current;
        if (cached && cached.key === key) return cached;
        let stripped = '';
        const map = [];
        for (let i = 0; i < full.length; i += 1) {
          const ch = full[i];
          if (!/\s/.test(ch)) { stripped += ch; map.push(i); }
        }
        textIndexRef.current = { key, stripped, map, cursor: 0 };
        return textIndexRef.current;
      };
      const followPageForSpeech = (chunk) => {
        if (modeRef.current !== 'paged' || !pageForOffsetRef.current) return;
        const index = articleIndex();
        if (!index || !index.stripped) return;
        const probe = String(chunk || '').replace(/\s+/g, '').slice(0, 16);
        if (!probe) return;
        const at = index.stripped.indexOf(probe, index.cursor || 0);
        const hit = at >= 0 ? at : index.stripped.indexOf(probe);
        if (hit < 0) return;
        index.cursor = hit;
        const target = pageForOffsetRef.current(index.map[hit]);
        if (target == null) return;
        const next = Math.max(0, Math.min(pageCount - 1, target));
        if (next === pageIndexRef.current) return;
        setPageIndex(next);
        pageIndexRef.current = next;
        lastPercentRef.current = paginationMath.percentForPage(next, pageCount);
        commitProgress(lastPercentRef.current);
      };

      const stopSpeech = () => { speechGeneration.current += 1; window.speechSynthesis?.cancel(); setSpeaking(false); };
      const advancePagedForSpeech = async (index, generation) => {
        const id = chapterSourceId(index);
        try {
          const value = await call(ctx, 'chapter', { bookId, chapterId: id });
          if (generation !== speechGeneration.current) return;
          setChapter(value || {});
          setChapterIndex(index);
          chapterIndexRef.current = index;
          setPageIndex(0); pageIndexRef.current = 0;
          progressRef.current = { bookId, chapterId: id, percent: 0, offset: 0 };
          pendingPercentRef.current = 0; pendingOffsetRef.current = null; lastPercentRef.current = 0;
          setScrollPercent(0);
          speakChapter(index, generation, value && (value.content || value.text));
        } catch {
          if (generation === speechGeneration.current) setSpeaking(false);
        }
      };

      const speakChapter = (index, generation, textOverride) => {
        if (generation !== speechGeneration.current) return;
        const source = textOverride != null ? { text: textOverride } : (index === chapterIndex ? chapter : scrollChaptersRef.current.find((entry) => entry.index === index)?.chapter);
        const text = String(source?.content || source?.text || '').trim();
        const chunks = text ? (text.match(/[^。！？!?\n]{1,140}[。！？!?\n]?/g) || [text]) : [];
        let cursor = 0;
        const next = () => {
          if (generation !== speechGeneration.current) return;
          if (cursor >= chunks.length) {
            const following = index + 1;
            // 朗读中途可能切过阅读方式，这里必须读当前值，否则翻页模式会走滚动的跨章分支，
            // 页码不归零、正文和声音各走各的。
            if (modeRef.current === 'scroll' && following < toc.length) {
              const jump = () => {
                if (generation !== speechGeneration.current) return;
                const node = chapterNodesRef.current.get(following);
                const el = scrollRef.current;
                if (node && el) el.scrollTop = nodeTop(node);
                const entry = scrollChaptersRef.current.find((item) => item.index === following);
                if (entry) { setChapter(entry.chapter); setChapterIndex(following); chapterIndexRef.current = following; }
                // 语音自动跨章时视口是程序化跳的，那次 scroll 事件会被恢复抑制吃掉，
                // 这里显式收敛窗口，否则一路听下去章节只增不减。
                if (modeRef.current === 'scroll') normalizeWindow(following);
                speakChapter(following, generation);
              };
              if (scrollChaptersRef.current.some((entry) => entry.index === following)) jump();
              else appendScrollChapter(following).then(jump).catch(() => setSpeaking(false));
              return;
            }
            if (following < toc.length) { advancePagedForSpeech(following, generation); return; }
            setSpeaking(false);
            return;
          }
          const spoken = chunks[cursor];
          cursor += 1;
          followPageForSpeech(spoken);
          const utterance = new SpeechSynthesisUtterance(spoken);
          utterance.rate = Number(settings.ttsRate || 1);
          utterance.pitch = Number(settings.ttsPitch || 1);
          utterance.volume = Number(settings.ttsVolume || 1);
          // 选择声音
          if (settings.ttsVoice) {
            const voice = voices.find(v => v.name === settings.ttsVoice);
            if (voice) utterance.voice = voice;
          }
          // 引擎选择：系统语音用 SpeechSynthesis，其他引擎预留接口
          if (settings.ttsEngine && settings.ttsEngine !== 'system') {
            // TODO: Azure/讯飞/百度 TTS API 接入（需要 API Key）
            notify(`${settings.ttsEngine} 引擎暂未接入，使用系统语音`);
          }
          let started = false;
          // 有些环境（没有装语音包、系统合成失败）speak() 之后既不 start 也不 end，
          // 状态会永远停在「停止」。这里给每句一个启动看门狗。
          const watchdog = window.setTimeout(() => {
            if (started || generation !== speechGeneration.current) return;
            stopSpeech();
            notify('当前环境没有可用的语音', 'error');
          }, 2000);
          utterance.onstart = () => { started = true; window.clearTimeout(watchdog); };
          utterance.onend = () => { window.clearTimeout(watchdog); next(); };
          utterance.onerror = () => {
            window.clearTimeout(watchdog);
            if (generation === speechGeneration.current) setSpeaking(false);
          };
          window.speechSynthesis.speak(utterance);
        };
        next();
      };
      const speak = () => {
        if (!('speechSynthesis' in window)) return notify('当前环境不支持系统语音', 'error');
        if (speaking) return stopSpeech();
        const windowChapter = scrollChaptersRef.current.find((entry) => entry.index === chapterIndex)?.chapter;
        const text = String(chapter?.content || chapter?.text || windowChapter?.content || windowChapter?.text || '').trim();
        if (!text) return;
        const generation = ++speechGeneration.current;
        setSpeaking(true);
        speakChapter(chapterIndex, generation);
        // 听书定时：N 分钟后自动停止
        if (settings.ttsTimer > 0) {
          setTimeout(() => {
            if (speechGeneration.current === generation) {
              stopSpeech();
              notify?.('定时停止', 'info');
            }
          }, settings.ttsTimer * 60 * 1000);
        }
      };

      const armTrim = () => {
        window.clearTimeout(trimTimerRef.current);
        trimTimerRef.current = window.setTimeout(() => {
          trimTimerRef.current = 0;
          normalizeWindow(chapterIndexRef.current);
        }, 180);
      };
      const onScroll = () => {
        const el = scrollRef.current;
        if (!el || chapterIndexRef.current < 0) return;
        if (performance.now() < suppressScrollUntilRef.current) return;
        // 手势没停就别裁章：倒计时跟着每次滚动事件往后推。
        if (trimTimerRef.current) armTrim();
        const max = Math.max(1, el.scrollHeight - el.clientHeight);
        scrollMotionRef.current.target = scrollMotion.progress(el.scrollTop / max);
        const list = scrollChaptersRef.current;
        if (list.length) {
          const probe = el.scrollTop + 12;
          let current = list[0];
          for (const entry of list) {
            const node = chapterNodesRef.current.get(entry.index);
            if (node && nodeTop(node) <= probe) current = entry;
          }
          const node = chapterNodesRef.current.get(current.index);
          const start = node ? nodeTop(node) : 0;
          const height = node ? Math.max(1, node.offsetHeight) : 1;
          const within = Math.max(0, Math.min(1, (el.scrollTop - start) / height));
          if (current.index !== chapterIndexRef.current) {
            chapterIndexRef.current = current.index;
            setChapterIndex(current.index);
            setChapter(current.chapter);
            progressRef.current = { ...progressRef.current, chapterId: chapterSourceId(current.index) };
            // 裁章会移除视口上方的几千像素，手势进行中改 DOM 会被当成「跳页」；
            // 等滚动停稳（180ms 无新事件）再一次性收窗口。
            armTrim();
          }
          lastPercentRef.current = Math.round(within * 100);
          commitProgress(lastPercentRef.current, 0, current.index);
          const last = list[list.length - 1];
          const lastNode = chapterNodesRef.current.get(last.index);
          if (lastNode) {
            const remaining = nodeTop(lastNode) + lastNode.offsetHeight - (el.scrollTop + el.clientHeight);
            if (remaining < el.clientHeight) appendScrollChapter(last.index + 1);
          }
        } else {
          commitProgress(Math.round(el.scrollTop / max * 100), 0);
        }
        window.clearTimeout(scrollMotionRef.current.settle);
        scrollMotionRef.current.settle = window.setTimeout(() => {
          scrollMotionRef.current.target = scrollMotion.progress(el.scrollTop / max);
        }, 120);
      };

      const makeNote = () => {
        const selection = String(window.getSelection?.() || '').trim();
        setQuote(selection); setDrawer('notes');
        requestAnimationFrame(() => document.querySelector('.mr-note-editor textarea')?.focus());
      };
      const chapterNotes = notes.filter((note) => note.bookId === bookId && (!chapter || note.chapterId === progressRef.current.chapterId));
      const paragraphs = useMemo(() => String(chapter?.content || chapter?.text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean), [chapter]);
      const name = chapter?.name || chapter?.title || toc[chapterIndex]?.name || toc[chapterIndex]?.title || '正文';

      const goPage = (target) => {
        if (loading) return;
        const next = Math.max(0, Math.min(pageCount - 1, target));
        if (next === pageIndexRef.current) return;
        setPageIndex(next);
        pageIndexRef.current = next;
        lastPercentRef.current = paginationMath.percentForPage(next, pageCount);
        commitProgress(lastPercentRef.current);
      };
      const buildTurnSheet = () => {
        const view = pagedRef.current;
        const article = articleRef.current;
        if (!view || !article || !pageStep) return null;
        const viewRect = view.getBoundingClientRect();
        // article.getBoundingClientRect() includes its translateX(-pageIndex*pageStep),
        // so derive the page box from the untransformed layout offsets instead.
        const articleRect = article.getBoundingClientRect();
        const two = columns > 1;
        const layoutLeft = viewRect.left + article.offsetLeft - view.scrollLeft;
        const layoutTop = viewRect.top + article.offsetTop - view.scrollTop;
        const layoutWidth = article.clientWidth;
        const layoutHeight = article.clientHeight;
        if (!viewRect.width || !layoutWidth || !layoutHeight) return null;
        const pageLeft = two ? layoutLeft + pageStep : layoutLeft;
        const pageWidthNow = two ? (pageWidth || layoutWidth) : layoutWidth;
        // The host lives outside .mr-reader, so its CSS variables (theme colors, fonts)
        // do not cascade in. Copy the resolved values from the live page instead.
        const readerEl = view.closest('.mr-reader');
        const articleStyle = getComputedStyle(article);
        const readerStyle = readerEl ? getComputedStyle(readerEl) : null;
        const pageBackground = (readerStyle && readerStyle.backgroundColor) || articleStyle.backgroundColor || '#fff';
        const host = document.createElement('div');
        host.className = `mr-turn-host theme-${theme} font-${settings.fontFamily || 'serif'}`;
        host.style.color = articleStyle.color;
        Object.assign(host.style, {
          position: 'fixed', left: `${viewRect.left}px`, top: `${viewRect.top}px`,
          width: `${viewRect.width}px`, height: `${viewRect.height}px`,
          zIndex: '9000', pointerEvents: 'none', overflow: 'hidden', perspective: '1800px',
        });
        const sheet = document.createElement('div');
        sheet.className = 'mr-turn-sheet';
        Object.assign(sheet.style, {
          position: 'absolute', left: `${pageLeft - viewRect.left}px`, top: `${layoutTop - viewRect.top}px`,
          width: `${pageWidthNow}px`, height: `${layoutHeight}px`,
          overflow: 'hidden', background: pageBackground,
          transformStyle: 'preserve-3d', backfaceVisibility: 'hidden', willChange: 'transform, opacity',
        });
        const clone = article.cloneNode(true);
        clone.classList.remove('mr-dragging', 'mr-turning', 'mr-fade-in');
        Object.assign(clone.style, {
          position: 'absolute', left: `${layoutLeft - pageLeft}px`, top: '0px',
          width: `${layoutWidth}px`, height: `${layoutHeight}px`, margin: '0',
          color: articleStyle.color, fontFamily: articleStyle.fontFamily,
          fontStyle: articleStyle.fontStyle, letterSpacing: articleStyle.letterSpacing,
          transition: 'none', transform: `translateX(${-pageIndexRef.current * pageStep}px)`,
        });
        const shade = document.createElement('div');
        shade.className = 'mr-turn-shade';
        sheet.appendChild(clone);
        sheet.appendChild(shade);
        host.appendChild(sheet);
        return { host, sheet, shade };
      };
      const endTurn = (built) => {
        clearTimeout(turnTimer.current);
        built.host.remove();
        if (turnHostRef.current === built.host) turnHostRef.current = null;
        turnRef.current = false;
        setTurning(false);
        setFadeIn(false);
      };
      const beginTurn = (style, delta, target) => {
        const built = buildTurnSheet();
        if (!built) return false;
        turnRef.current = true;
        setTurning(true);
        document.body.appendChild(built.host);
        turnHostRef.current = built.host;
        if (target != null) goPage(target);
        const { sheet, shade } = built;
        if (style === 'flip') {
          sheet.style.transformOrigin = delta > 0 ? 'left center' : 'right center';
          const angle = delta > 0 ? -172 : 172;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            sheet.style.transition = 'transform .48s cubic-bezier(.3,.05,.25,1)';
            shade.style.transition = 'opacity .48s ease';
            sheet.style.transform = `rotateY(${angle}deg)`;
            shade.style.opacity = '.85';
          }));
          turnTimer.current = setTimeout(() => endTurn(built), 520);
          return true;
        }
        if (style === 'fade') {
          shade.style.display = 'none';
          setFadeIn(true);
          requestAnimationFrame(() => {
            sheet.style.transition = 'opacity .24s ease, transform .24s ease';
            sheet.style.opacity = '0';
            sheet.style.transform = 'translateY(-8px)';
          });
          turnTimer.current = setTimeout(() => endTurn(built), 280);
          return true;
        }
        shade.style.display = 'none';
        const distance = Math.max(160, pageStep || 320);
        requestAnimationFrame(() => {
          sheet.style.transition = 'transform .32s ease-in, opacity .32s ease-in';
          sheet.style.transform = `translateX(${delta > 0 ? -distance : distance}px)`;
          sheet.style.opacity = '0';
        });
        turnTimer.current = setTimeout(() => endTurn(built), 340);
        return true;
      };
      const turnChapter = (dir) => {
        const index = chapterIndex + dir;
        if (!toc[index]) return;
        const percent = dir > 0 ? 0 : 100;
        if (motionOff || !webglRef.current) { openChapter(index, false, percent); return; }
        beginTurn(flipStyle === 'slide' ? 'slide' : flipStyle, dir, null);
        openChapter(index, false, percent);
      };
      const turnPage = (delta) => {
        if (!delta || loading || turnRef.current) return;
        const next = pageIndexRef.current + delta;
        if (next < 0) {
          if (chapterIndex > 0) turnChapter(-1);
          return;
        }
        if (next >= pageCount) {
          if (chapterIndex + 1 < toc.length) turnChapter(1);
          else if (chapterIndex === toc.length - 1) {
            // 读完最后一章，自动标记已读
            call(ctx, 'markBookRead', { bookId: book.id || book.bookId }).catch(() => {});
            notify?.('已读完全书', 'success');
          }
          return;
        }
        if (motionOff || !webglRef.current) { goPage(next); return; }
        if (flipStyle === 'flip' || flipStyle === 'fade') {
          if (beginTurn(flipStyle, delta, next)) return;
        }
        goPage(next);
      };

      const measureLayout = (restorePercent = null, anchorOffset = null) => {
        const view = pagedRef.current;
        const article = articleRef.current;
        if (!view || !article) return;
        const nextColumns = 1;
        const gap = 0;
        const width = article.clientWidth || view.clientWidth;
        if (nextColumns !== columns) { setColumns(nextColumns); return; }
        const nextPageWidth = nextColumns === 1 ? width : (width - gap) / nextColumns;
        article.style.columnWidth = `${nextPageWidth}px`;
        article.style.columnGap = `${gap}px`;
        article.style.columnCount = 'auto';
        article.style.columnFill = 'auto';
        // Multicol clips at the column box instead of pushing a half line to the
        // next column, so snap both the box and the chapter head to whole lines.
        const box = getComputedStyle(article);
        const lineHeight = parseFloat(box.lineHeight) || 0;
        const padTop = parseFloat(box.paddingTop) || 0;
        const padBottom = parseFloat(box.paddingBottom) || 0;
        if (lineHeight > 0) {
          const head = article.querySelector('.mr-chapter-open');
          if (head) {
            const headPad = parseFloat(getComputedStyle(head).paddingBottom) || 0;
            const content = Math.max(0, head.getBoundingClientRect().height - headPad);
            const snappedPad = Math.max(0, Math.ceil(content / lineHeight) * lineHeight - content);
            if (Math.abs(headPad - snappedPad) > 0.5) head.style.paddingBottom = `${snappedPad}px`;
          }
          const available = view.clientHeight - padTop - padBottom;
          if (available > lineHeight) {
            const snapped = Math.floor(available / lineHeight) * lineHeight;
            const target = `${snapped + padTop + padBottom}px`;
            if (article.style.height !== target) article.style.height = target;
          }
        }
        const totalColumns = paginationMath.totalColumns(article.scrollWidth, nextPageWidth, gap);
        const pages = paginationMath.pageCount(totalColumns, nextColumns);
        const currentPercent = restorePercent != null
          ? restorePercent
          : paginationMath.percentForPage(pageIndexRef.current, pageCount);
        // Map an anchor offset to a column. The article is translated by
        // -pageIndex*pageStep, so add that back before comparing to layoutLeft.
        const pageForOffset = (offset) => {
          const anchor = nodeAtOffset(offset);
          if (!anchor) return null;
          try {
            const range = document.createRange();
            range.setStart(anchor.node, anchor.offset);
            range.setEnd(anchor.node, Math.min(anchor.node.nodeValue.length, anchor.offset + 1));
            const rect = range.getBoundingClientRect();
            if (!rect || (!rect.width && !rect.height)) return null;
            const step = nextPageWidth + gap;
            const layoutLeft = article.getBoundingClientRect().left + pageIndexRef.current * step;
            return paginationMath.columnForAnchor({
              anchorLeft: rect.left,
              pageIndex: pageIndexRef.current,
              pageStep: pageStep || step,
              layoutLeft,
              step,
              pages,
            });
          } catch { return null; }
        };
        pageForOffsetRef.current = pageForOffset;
        const anchor = anchorOffset != null ? Number(anchorOffset) : Number(progressRef.current.offset || 0);
        const anchored = anchor > 0 ? pageForOffset(anchor) : null;
        const target = anchored != null ? anchored : paginationMath.pageForPercent(currentPercent, pages);
        const nextPercent = anchored != null ? paginationMath.percentForPage(target, pages) : currentPercent;
        pendingPercentRef.current = null;
        pendingOffsetRef.current = null;
        setPageWidth(nextPageWidth);
        setPageStep(nextPageWidth + gap);
        setPageCount(pages);
        setMeasuredFor(String(chapterIdAt()));
        pageIndexRef.current = target;
        setPageIndex(target);
        setScrollPercent(nextPercent);
        progressRef.current = { bookId, chapterId: chapterIdAt(), percent: nextPercent, offset: anchor > 0 ? anchor : 0 };
      };
      measureRef.current = measureLayout;

      useEffect(() => {
        if (mode !== 'paged' || !chapter) return;
        const raf = requestAnimationFrame(() => measureRef.current(pendingPercentRef.current, pendingOffsetRef.current));
        return () => cancelAnimationFrame(raf);
      }, [mode, columns, chapter, settings.fontSize, settings.lineHeight, settings.fontFamily, settings.measureWidth]);

      // Persist the first character of the visible page so a later font-size
      // or column change can land on the same text instead of the same percent.
      useEffect(() => {
        if (mode !== 'paged' || !chapter || loading) return;
        const raf = requestAnimationFrame(() => {
          const offset = pageStartOffset();
          if (offset == null) return;
          const percent = paginationMath.percentForPage(pageIndex, pageCount);
          commitProgress(percent, offset);
        });
        return () => cancelAnimationFrame(raf);
      }, [mode, chapter, pageIndex, pageCount, loading]);

      useEffect(() => {
        if (mode !== 'paged') return;
        const onResize = () => {
          const percent = paginationMath.percentForPage(pageIndexRef.current, pageCount);
          const anchor = progressRef.current.offset || null;
          requestAnimationFrame(() => measureRef.current(percent, anchor));
        };
        window.addEventListener('resize', onResize);
        const view = pagedRef.current;
        const observer = view && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
        if (observer) observer.observe(view);
        return () => {
          window.removeEventListener('resize', onResize);
          if (observer) observer.disconnect();
        };
      }, [mode, pageCount, columns]);

      useEffect(() => {
        if (mode !== 'paged' || drawer) return;
        const onKeyDown = (event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;
          if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); turnPage(-1); }
          if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ' || event.code === 'Space') { event.preventDefault(); turnPage(1); }
          if (event.key === 'Home') { event.preventDefault(); goPage(0); }
          if (event.key === 'End') { event.preventDefault(); goPage(pageCount - 1); }
          // 快捷键：D=目录 S=设置 N=笔记 A=AI T=听书 M=模式
          if (event.key === 'd' || event.key === 'D') { event.preventDefault(); setDrawer(drawer === 'toc' ? '' : 'toc'); }
          if (event.key === 's' || event.key === 'S') { event.preventDefault(); setDrawer(drawer === 'settings' ? '' : 'settings'); }
          if (event.key === 'n' || event.key === 'N') { event.preventDefault(); setDrawer(drawer === 'notes' ? '' : 'notes'); }
          if (event.key === 'a' || event.key === 'A') { event.preventDefault(); setDrawer(drawer === 'ai' ? '' : 'ai'); }
          if (event.key === 't' || event.key === 'T') { event.preventDefault(); speak(); }
          if (event.key === 'm' || event.key === 'M') { event.preventDefault(); toggleMode(); }
          if (event.key === 'Escape') { event.preventDefault(); setDrawer(''); }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [mode, drawer, pageCount, pageIndex, chapterIndex, toc.length, loading]);

      const toggleMode = () => {
        if (turnRef.current) return;
        if (mode === 'paged') {
          setMode('scroll');
          persistPref('mode', 'scroll');
        } else {
          pendingPercentRef.current = scrollPercent;
          setMode('paged');
          persistPref('mode', 'paged');
        }
      };

      const canTurn = (delta) => delta > 0
        ? pageIndexRef.current < pageCount - 1 || chapterIndex + 1 < toc.length
        : pageIndexRef.current > 0 || chapterIndex > 0;
      const onPagedPointerDown = (event) => {
        if (mode !== 'paged' || drawer || loading || turnRef.current || event.button > 0) return;
        if (event.target?.closest?.('button,a,input,textarea,select')) return;
        const view = pagedRef.current;
        const rect = view?.getBoundingClientRect();
        if (!rect || !pageStep) return;
        if (event.pointerType === 'mouse') {
          const edge = Math.max(28, rect.width * 0.12);
          if (event.clientX > rect.left + edge && event.clientX < rect.right - edge) return;
        }
        dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now(), axis: null };
      };
      const onPagedPointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.axis) {
          if (Math.abs(dx) < 9 && Math.abs(dy) < 9) return;
          if (Math.abs(dx) <= Math.abs(dy)) { dragRef.current = null; return; }
          drag.axis = 'x';
          setDragging(true);
          try { pagedRef.current?.setPointerCapture?.(event.pointerId); } catch {}
        }
        event.preventDefault();
        const direction = dx < 0 ? 1 : -1;
        const resistance = canTurn(direction) ? 1 : 0.18;
        setDragOffset(Math.max(-pageStep * 0.9, Math.min(pageStep * 0.9, dx * resistance)));
      };
      const endPagedDrag = (event, cancelled = false) => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        const wasHorizontal = drag.axis === 'x';
        setDragging(false);
        setDragOffset(0);
        if (!wasHorizontal) return;
        try { pagedRef.current?.releasePointerCapture?.(event.pointerId); } catch {}
        if (cancelled) return;
        const dx = event.clientX - drag.x;
        const dt = Math.max(16, performance.now() - drag.time);
        const speed = Math.abs(dx) / dt;
        if (Math.abs(dx) < Math.max(24, pageStep * 0.16) && speed < 0.45) return;
        suppressClickRef.current = true;
        setTimeout(() => { suppressClickRef.current = false; }, 80);
        turnPage(dx < 0 ? 1 : -1);
      };
      const onPagedPointerUp = (event) => endPagedDrag(event, false);
      const onPagedPointerCancel = (event) => endPagedDrag(event, true);
      const bookLabel = String(book.title || book.name || '').trim().replace(/\.(txt|epub|md)$/i, '');
      const chapterNodesFor = (entry, options = {}) => {
        const index = entry.index;
        const source = entry.chapter || {};
        const lines = String(source.content || source.text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
        const heading = source.name || source.title || toc[index]?.name || toc[index]?.title || '正文';
        const rawHeading = String(heading || '').trim();
        const prefixed = bookLabel && (rawHeading === bookLabel || rawHeading.startsWith(`${bookLabel}/`) || rawHeading.startsWith(`${bookLabel}·`));
        const rawTitle = prefixed ? (rawHeading === bookLabel ? bookLabel : rawHeading.slice(bookLabel.length + 1).trim()) : rawHeading;
        const titleMatch = rawTitle.match(/^(第[〇零一二三四五六七八九十百千万两\d]+[章节回卷])[\s　]*([\s\S]*)$/);
        const chapterNo = titleMatch ? titleMatch[1] : '';
        const chapterTitle = titleMatch ? titleMatch[2].trim() : rawTitle;
        const chars = lines.reduce((sum, line) => sum + line.replace(/\s/g, '').length, 0);
        const meta = [bookLabel, chars ? `${chars} 字` : ''].filter(Boolean).join(' · ');
        const showEnd = options.withEnd === true;
        return [
          h('header', { key: 'title', className: 'mr-chapter-open' },
            chapterNo ? h('div', { className: 'mr-chapter-no' }, chapterNo) : null,
            chapterTitle ? h('h1', { className: 'mr-chapter-title' }, chapterTitle) : null,
            meta ? h('div', { className: 'mr-chapter-meta' }, h('i', { 'aria-hidden': true }), h('span', null, meta)) : null),
          ...(book.contentType === 'comic' ? renderComic(lines) :
              book.contentType === 'audio' ? [renderAudio(source)] :
              book.contentType === 'video' ? [renderVideo(source)] :
              lines.map((line, key) => h('p', { key }, line))),
          !lines.length && book.contentType !== 'audio' && book.contentType !== 'video' ? h(Empty, { key: 'empty', title: '本章无正文', detail: book.contentType === 'subscription' ? '这条订阅没有正文内容，稍后重试或换一条。' : '可尝试刷新目录。' }) : null,
          showEnd
            ? h('div', { key: 'end', className: 'mr-chapter-end' }, index + 1 < toc.length
              ? h(Button, { kind: 'primary soft', onClick: () => openChapter(index + 1) }, '下一章')
              : h('span', null, '已是最后一章'))
            : null,
        ];
      };
      const chapterNodes = chapterNodesFor({ index: chapterIndex, chapter });

      // 多媒体渲染器
      function renderComic(lines) {
        return lines.map((line, key) => {
          const trimmed = line.trim();
          if (/^https?:\/\/.*\.(?:jpg|jpeg|png|gif|webp|avif|svg)(?:\?|$)/i.test(trimmed)) {
            return h('div', { key, className: 'mr-comic-page' },
              h('img', { src: trimmed, alt: `第 ${key + 1} 页`, loading: 'lazy', decoding: 'async' }));
          }
          if (trimmed.startsWith('![') || trimmed.startsWith('http')) {
            const match = trimmed.match(/!\[([^\]]*)\]\(([^)]+)\)/) || trimmed.match(/^(https?:\/\/\S+)/);
            if (match) {
              const url = match[2] || match[1];
              const alt = match[1] || `第 ${key + 1} 页`;
              return h('div', { key, className: 'mr-comic-page' },
                h('img', { src: url, alt, loading: 'lazy', decoding: 'async' }));
            }
          }
          return h('p', { key }, line);
        });
      }

      function renderAudio(source) {
        const url = source.audioUrl || source.url || source.src || '';
        if (!url) return h('p', null, '本章无音频');
        return h('div', { className: 'mr-audio-player' },
          h('audio', { controls: true, preload: 'metadata', src: url },
            '你的浏览器不支持音频播放。'),
          h('p', { className: 'mr-audio-title' }, source.title || source.name || '音频'));
      }

      function renderVideo(source) {
        const url = source.videoUrl || source.url || source.src || '';
        if (!url) return h('p', null, '本章无视频');
        // 嵌入 B站/YouTube 等
        if (/bilibili\.com\/video\/(\w+)/.test(url)) {
          const bv = url.match(/bilibili\.com\/video\/(\w+)/)?.[1];
          return h('div', { className: 'mr-video-embed' },
            h('iframe', { src: `https://player.bilibili.com/player.html?bvid=${bv}&autoplay=0`, allowFullScreen: true, frameBorder: 0 }));
        }
        if (/youtube\.com\/watch\?v=(\w+)/.test(url) || /youtu\.be\/(\w+)/.test(url)) {
          const vid = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)(\w+)/)?.[1];
          return h('div', { className: 'mr-video-embed' },
            h('iframe', { src: `https://www.youtube.com/embed/${vid}`, allowFullScreen: true, frameBorder: 0 }));
        }
        return h('div', { className: 'mr-video-player' },
          h('video', { controls: true, preload: 'metadata', src: url },
            '你的浏览器不支持视频播放。'));
      }
      const pagedArticleStyle = {
        fontSize: `${settings.fontSize || 20}px`,
        lineHeight: settings.lineHeight || 1.9,
        columnWidth: pageWidth ? `${pageWidth}px` : 'auto',
        columnGap: '0px',
        columnCount: 'auto',
        columnFill: 'auto',
        height: '100%',
        transform: `translateX(${-(pageIndex * pageStep) + dragOffset}px)`,
      };

      const toolButton = (icon, label, onClick, extra = {}) => h('button', {
        type: 'button', className: 'mr-tool-btn', title: label, 'aria-label': label, onClick, ...extra,
      }, h(Glyph, { name: icon, size: 19 }), h('span', null, label));
      const tabButton = (icon, label, onClick, extra = {}) => h('button', {
        type: 'button', className: 'mr-tab-btn', title: label, 'aria-label': label, onClick, ...extra,
      }, h(Glyph, { name: icon, size: 20 }), h('span', null, label));
      const segment = (items) => h('div', { className: 'mr-seg' }, items.map(([text, active, handle]) => h('button', {
        key: text, type: 'button', className: `mr-seg-btn${active ? ' active' : ''}`, onClick: handle,
      }, text)));
      const settingRow = (label, control) => h('div', { key: label, className: 'mr-set-row' },
        h('span', { className: 'mr-set-label' }, label), h('div', { className: 'mr-set-control' }, control));
      const rangeRow = (label, value, suffix, control) => settingRow(label, h('div', { className: 'mr-range' },
        control, h('span', { className: 'mr-range-val' }, `${value}${suffix}`)));
      const chapterPercent = chapterIndex >= 0 ? `${Math.round((chapterIndex + 1) / Math.max(1, toc.length) * 100)}%` : '';
      const pageFraction = mode === 'paged' ? Math.min(1, (pageIndex + 1) / Math.max(1, pageCount)) : scrollPercent / 100;
      const bookPercent = chapterIndex >= 0 && toc.length
        ? Math.max(0, Math.min(100, (chapterIndex + pageFraction) / toc.length * 100))
        : 0;

      const toggleReaderChrome = (event) => {
        if (!window.matchMedia('(max-width: 720px)').matches) return;
        if (suppressClickRef.current) return;
        if (String(window.getSelection?.() || '').trim()) return;
        const target = event.target;
        if (target?.closest?.('button, a, input, textarea, select, .mr-drawer, .mr-modal, .mr-drawer-backdrop, .mr-modal-backdrop')) return;
        setChromeOpen((value) => !value);
      };
      return h('div', {
        className: `mr-reader theme-${theme} font-${settings.fontFamily === 'sans' ? 'sans' : 'serif'}${motionOff ? ' mr-reduced' : ''}${chromeOpen ? ' mr-chrome-open' : ' mr-chrome-hidden'}`,
        style: {
          '--mr-text': `${Math.max(360, (settings.measureWidth || 960) - 128)}px`,
          '--mr-text-half': `${Math.max(360, (settings.measureWidth || 960) - 128) / 2}px`,
        },
      },
        h('header', { className: 'mr-reader-top' },
          h('button', { type: 'button', className: 'mr-reader-top-btn', 'aria-label': '返回书架', onClick: closeReader }, h(Glyph, { name: 'back', size: 20 })),
          h('div', { className: 'mr-reader-top-copy' },
            h('strong', null, bookLabel),
            h('span', null, name)),
          h('button', { type: 'button', className: 'mr-reader-top-btn', 'aria-label': '排版设置', onClick: () => setDrawer(drawer === 'settings' ? '' : 'settings') }, h(Glyph, { name: 'type', size: 18 }))),
        notice ? h(Notice, { notice, onClose: onDismissNotice }) : null,
        h('div', { className: 'mr-ambience', ref: ambienceHostRef, 'aria-hidden': true }),
        h('div', { className: 'mr-rail', 'aria-hidden': true }, h('i', { style: { width: `${bookPercent}%` } })),
        h('main', mode === 'paged'
          ? { className: 'mr-paged-view', ref: pagedRef, onClick: toggleReaderChrome, onPointerDown: onPagedPointerDown, onPointerMove: onPagedPointerMove, onPointerUp: onPagedPointerUp, onPointerCancel: onPagedPointerCancel }
          : { className: 'mr-chapter-scroll', ref: scrollRef, onScroll, onClick: toggleReaderChrome },
          loading ? h('div', { className: 'mr-loading' }, '正在打开章节…') : error ? h('div', { className: 'mr-error-block' }, h('p', null, error), h(Button, { onClick: () => { if (toc.length && failedIndex >= 0) openChapter(failedIndex); else { setLoading(true); setError(''); setRetryNonce((value) => value + 1); } } }, '重试')) :
            mode === 'paged'
              ? h('div', { className: 'mr-page-window' },
                h('article', { className: `mr-chapter mr-paged-chapter${dragging ? ' mr-dragging' : ''}${turning ? ' mr-turning' : ''}${fadeIn ? ' mr-fade-in' : ''}`, ref: articleRef, style: pagedArticleStyle }, chapterNodes))
              : [
                scrollChapters.map((entry) => h('article', {
                  key: entry.index,
                  className: 'mr-chapter',
                  'data-chapter-index': entry.index,
                  ref: (node) => {
                    if (node) chapterNodesRef.current.set(entry.index, node);
                    else chapterNodesRef.current.delete(entry.index);
                  },
                  style: { fontSize: `${settings.fontSize || 20}px`, lineHeight: settings.lineHeight || 1.9 },
                }, chapterNodesFor(entry, { withEnd: entry.index === toc.length - 1 }))),
                scrollError != null
                  ? h('div', { key: 'retry', className: 'mr-scroll-retry' },
                    h('p', null, '本章未加载'),
                    h(Button, { onClick: () => { const next = scrollError; setScrollError(null); appendScrollChapter(next); } }, '重试'))
                  : null,
              ],
          chapterVeil ? h('div', { className: `mr-chapter-veil${chapterVeil ? ' show' : ''}`, key: chapterVeil }, chapterVeil) : null),
        mode === 'paged' && !loading && !error && measuredFor && measuredFor === String(chapterIdAt())
          ? h('div', { className: 'mr-folio', 'aria-hidden': true }, `${Math.min(pageCount, pageIndex + 1)} / ${pageCount}`)
          : null,
        h('nav', { className: 'mr-tools', 'aria-label': '阅读工具' },
          toolButton('back', '返回', closeReader),
          toolButton('list', '目录', () => setDrawer(drawer === 'toc' ? '' : 'toc')),
          toolButton('type', '排版', () => setDrawer(drawer === 'settings' ? '' : 'settings')),
          h('hr', { 'aria-hidden': true }),
          toolButton(speaking ? 'stop' : 'play', speaking ? '停止' : '听书', speak),
          toolButton('note', '笔记', makeNote, { onPointerDown: (event) => event.preventDefault() }),
          h('hr', { 'aria-hidden': true }),
          toolButton('sparkles', 'AI', () => setDrawer(drawer === 'ai' ? '' : 'ai')),
          toolButton(theme === 'dark' ? 'sun' : 'moon', '夜间', () => onSettings({ readerTheme: theme === 'dark' ? 'paper' : 'dark' })),
          mode === 'scroll' ? toolButton('up', '回顶', () => scrollRef.current?.scrollTo({ top: 0, behavior: motionOff ? 'auto' : 'smooth' })) : null),
        h('nav', { className: 'mr-tabbar', 'aria-label': '阅读工具' },
          tabButton('back', '返回', closeReader),
          tabButton('list', '目录', () => setDrawer(drawer === 'toc' ? '' : 'toc')),
          tabButton('type', '排版', () => setDrawer(drawer === 'settings' ? '' : 'settings')),
          tabButton(speaking ? 'stop' : 'play', speaking ? '停止' : '听书', speak),
          tabButton('note', '笔记', makeNote, { onPointerDown: (event) => event.preventDefault() })),
        drawer ? h('div', { className: `mr-drawer-backdrop${drawer === 'toc' ? ' mr-backdrop-soft' : ''}`, onClick: () => setDrawer('') }) : null,
        drawer === 'settings' ? h('div', { className: 'mr-modal-backdrop', onClick: () => setDrawer('') },
          h('div', { className: 'mr-modal', role: 'dialog', 'aria-modal': true, 'aria-label': '排版', onClick: (event) => event.stopPropagation() },
            h('div', { className: 'mr-modal-head' },
              h('h2', null, '排版'),
              h('button', { type: 'button', className: 'mr-modal-close', 'aria-label': '关闭', onClick: () => setDrawer('') }, h(Glyph, { name: 'close', size: 15 }))),
            h('div', { className: 'mr-modal-body' },
              settingRow('本书', segment([
                ['跟随全局', !bookPrefs, () => onBookSettings?.({ clear: true })],
                ['本书单独设定', !!bookPrefs, () => onBookSettings?.({ mode: prefMode, flipStyle: prefFlipStyle, ambience: prefAmbience })],
              ])),
              settingRow('纸张', h('div', { className: 'mr-swatches' }, ['paper', 'light', 'green', 'dark'].map((item) => h('button', {
                key: item, type: 'button', className: `mr-swatch ${item}${theme === item ? ' active' : ''}`,
                'aria-label': ({ paper: '米黄', light: '白色', green: '浅绿', dark: '深色' })[item],
                onClick: () => onSettings({ readerTheme: item }),
              })))),
              settingRow('字体', segment([
                ['衬线', settings.fontFamily !== 'sans', () => onSettings({ fontFamily: 'serif' })],
                ['黑体', settings.fontFamily === 'sans', () => onSettings({ fontFamily: 'sans' })],
              ])),
              settingRow('字号', h('div', { className: 'mr-stepper' },
                h('button', { type: 'button', className: 'mr-step-btn', onClick: () => onSettings({ fontSize: Math.max(14, (settings.fontSize || 19) - 1) }) }, '减小'),
                h('strong', null, settings.fontSize || 19),
                h('button', { type: 'button', className: 'mr-step-btn', onClick: () => onSettings({ fontSize: Math.min(36, (settings.fontSize || 19) + 1) }) }, '增大'))),
              settingRow('版心', segment([
                ['640', (settings.measureWidth || 960) === 640, () => onSettings({ measureWidth: 640 })],
                ['800', (settings.measureWidth || 960) === 800, () => onSettings({ measureWidth: 800 })],
                ['960', (settings.measureWidth || 960) === 960, () => onSettings({ measureWidth: 960 })],
              ])),
              settingRow('阅读方式', segment([
                ['翻页', mode === 'paged', () => { pendingPercentRef.current = scrollPercent; setMode('paged'); persistPref('mode', 'paged'); }],
                ['滚动', mode === 'scroll', () => { setMode('scroll'); persistPref('mode', 'scroll'); }],
              ])),
              settingRow('翻页效果', segment([
                ['滑动', flipStyle === 'slide', () => chooseFlip('slide')],
                ['翻转', flipStyle === 'flip', () => chooseFlip('flip')],
                ['淡入', flipStyle === 'fade', () => chooseFlip('fade')],
              ])),
              settingRow('氛围', segment([
                ['完整', prefAmbience === 'full', () => persistPref('ambience', 'full')],
                ['仅纸张', prefAmbience === 'paper', () => persistPref('ambience', 'paper')],
                ['关闭', prefAmbience === 'off', () => persistPref('ambience', 'off')],
              ])),
              rangeRow('行距', (settings.lineHeight || 1.9).toFixed(1), '', h('input', { type: 'range', min: 1.4, max: 2.5, step: .1, value: settings.lineHeight || 1.9, onChange: (e) => onSettings({ lineHeight: Number(e.target.value) }) })),
              rangeRow('语速', (settings.ttsRate || 1).toFixed(1), '×', h('input', { type: 'range', min: .5, max: 2, step: .1, value: settings.ttsRate || 1, onChange: (e) => onSettings({ ttsRate: Number(e.target.value) }) })),
              rangeRow('音调', (settings.ttsPitch || 1).toFixed(1), '×', h('input', { type: 'range', min: .5, max: 2, step: .1, value: settings.ttsPitch || 1, onChange: (e) => onSettings({ ttsPitch: Number(e.target.value) }) })),
              rangeRow('音量', Math.round((settings.ttsVolume || 1) * 100), '%', h('input', { type: 'range', min: 0, max: 1, step: .1, value: settings.ttsVolume || 1, onChange: (e) => onSettings({ ttsVolume: Number(e.target.value) }) })),
              settingRow('引擎', h('select', { value: settings.ttsEngine || 'system', onChange: (e) => onSettings({ ttsEngine: e.target.value }) },
                h('option', { value: 'system' }, '系统语音'),
                h('option', { value: 'azure' }, 'Azure TTS'),
                h('option', { value: 'iflytek' }, '讯飞'),
                h('option', { value: 'baidu' }, '百度'))),
              settingRow('声音', h('select', { value: settings.ttsVoice || '', onChange: (e) => onSettings({ ttsVoice: e.target.value }) },
                h('option', { value: '' }, '默认'),
                ...voices.map(v => h('option', { key: v.name, value: v.name }, `${v.name} (${v.lang})`))))))) : null,
        drawer === 'toc' ? h('aside', { className: 'mr-drawer mr-drawer-left', role: 'dialog', 'aria-modal': true, 'aria-label': '目录' },
          h('div', { className: 'mr-drawer-head' },
            h('h2', null, '目录'),
            h('span', { className: 'mr-drawer-count' }, `${toc.length} 章`),
            h(Button, { kind: 'icon', icon: 'close', onClick: () => setDrawer('') })),
          h('div', { className: 'mr-toc' }, toc.map((item, index) => h('button', {
            key: item.id || item.chapterId || item.url || index,
            ref: index === chapterIndex ? tocActiveRef : null,
            className: index === chapterIndex ? 'active' : '',
            onClick: () => openChapter(index),
          }, item.name || item.title || `第 ${index + 1} 章`)))) : null,
        drawer === 'notes' ? h('aside', { className: 'mr-drawer', role: 'dialog', 'aria-modal': true, 'aria-label': '笔记' },
          h('div', { className: 'mr-drawer-head' },
            h('h2', null, '笔记'),
            h(Button, { kind: 'icon', icon: 'close', onClick: () => setDrawer('') })),
          h('div', { className: 'mr-drawer-body' },
            quote ? h('blockquote', null, quote) : null,
            h('div', { className: 'mr-note-editor' }, h('textarea', { rows: 4, value: noteText, onChange: (e) => setNoteText(e.target.value), placeholder: '写下想法…' }), h(Button, { kind: 'primary', disabled: !noteText.trim(), onClick: async () => { try { await onSaveNote({ bookId, chapterId: progressRef.current.chapterId, text: noteText, quote }); setNoteText(''); setQuote(''); } catch {} } }, '保存')),
            h('div', { className: 'mr-notes' }, chapterNotes.map((note) => h('article', { key: note.id }, note.quote ? h('blockquote', null, note.quote) : null, h('p', null, note.text), h(Button, { kind: 'text danger', icon: 'trash', onClick: () => onDeleteNote(note) }, '删除')))))) : null,
        drawer === 'ai' ? h('aside', { className: 'mr-drawer', role: 'dialog', 'aria-modal': true, 'aria-label': 'AI 助手' },
          h('div', { className: 'mr-drawer-head' },
            h('h2', null, 'AI 助手'),
            h(Button, { kind: 'icon', icon: 'close', onClick: () => setDrawer('') })),
          h('div', { className: 'mr-drawer-body' },
            h('div', { className: 'mr-ai-actions' },
              h(Button, { icon: 'file', onClick: () => { run(() => call(ctx, 'aiSummarize', { bookId }), '摘要生成中…').then(r => { if (r?.summary) setAiResult({ type: 'summary', text: r.summary }); }, () => {}); } }, '章节摘要'),
              h(Button, { icon: 'translate', onClick: () => { const text = window.getSelection()?.toString() || ''; if (!text) { notify('请先选中要翻译的文字'); return; } run(() => call(ctx, 'aiTranslate', { text, target: 'zh' }), '翻译中…').then(r => { if (r?.translated) setAiResult({ type: 'translate', text: r.translated }); }, () => {}); } }, '划词翻译')),
            h('div', { className: 'mr-ai-ask' },
              h('textarea', { rows: 3, value: aiQuestion, onChange: (e) => setAiQuestion(e.target.value), placeholder: '问 AI 关于这本书的问题…' }),
              h(Button, { kind: 'primary', disabled: !aiQuestion.trim(), onClick: () => { run(() => call(ctx, 'aiAsk', { bookId, question: aiQuestion }), '思考中…').then(r => { if (r?.answer) setAiResult({ type: 'answer', text: r.answer }); setAiQuestion(''); }, () => {}); } }, '提问')),
            aiResult ? h('div', { className: 'mr-ai-result' },
              h('div', { className: 'mr-ai-result-head' }, h('span', null, aiResult.type === 'summary' ? '摘要' : aiResult.type === 'translate' ? '翻译' : '回答'), h(Button, { kind: 'icon', icon: 'close', onClick: () => setAiResult(null) })),
              h('p', null, aiResult.text)) : null)) : null);
    }

    const OPEN_BACKDROPS = { paper: '#f4ecdc', light: '#ffffff', green: '#e3eee5', dark: '#202522' };

    function OpenTransition({ data, onDone }) {
      const coverRef = useRef(null);
      const doneRef = useRef(onDone);
      doneRef.current = onDone;
      const panel = data.panel;
      const from = data.rect;
      useEffect(() => {
        const node = coverRef.current;
        let animation = null;
        if (node && from && panel) {
          const dx = panel.left + panel.width / 2 - (from.left + from.width / 2);
          const dy = panel.top + panel.height * 0.42 - (from.top + from.height / 2);
          animation = node.animate([
            { transform: 'translate3d(0,0,0) scale(1)', opacity: 1, offset: 0 },
            { transform: `translate3d(${dx * 0.6}px, ${dy * 0.6}px, 0) scale(1.16)`, opacity: 0.6, offset: 0.5 },
            { transform: `translate3d(${dx}px, ${dy}px, 0) scale(1.34)`, opacity: 0, offset: 1 },
          ], { duration: 460, easing: 'cubic-bezier(.24,.6,.3,1)', fill: 'forwards' });
        }
        const timer = window.setTimeout(() => doneRef.current?.(), 520);
        return () => { window.clearTimeout(timer); animation?.cancel?.(); };
      }, []);
      if (!panel) return null;
      const backdrop = OPEN_BACKDROPS[data.theme] || OPEN_BACKDROPS.paper;
      const left = from ? from.left - panel.left : panel.width / 2 - 40;
      const top = from ? from.top - panel.top : panel.height / 3;
      const width = from ? Math.max(36, from.width) : 80;
      const height = from ? Math.max(52, from.height) : 112;
      const name = String(data.book?.name || data.book?.title || '书');
      const coverStyle = { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` };
      return h('div', { className: 'mr-open-shift', style: { left: `${panel.left}px`, top: `${panel.top}px`, width: `${panel.width}px`, height: `${panel.height}px` } },
        h('div', { className: 'mr-open-veil', style: { background: backdrop } }),
        h('div', { ref: coverRef, className: 'mr-open-cover', style: coverStyle },
          data.cover ? h('img', { src: data.cover, alt: '' }) : h('span', null, name.slice(0, 1))));
    }

    function MetaSheet({ state, onClose, onPick }) {
      if (!state) return null
      const title = String(state.book?.name || state.book?.title || '').replace(/\.(?:txt|epub|md)$/i, '')
      const candidates = state.candidates || []
      const body = state.busy
        ? h('p', { className: 'mr-meta-status' }, '正在搜书源…')
        : state.error
          ? h('p', { className: 'mr-meta-status' }, '补全信息暂时不可用，可以跳过。')
          : candidates.length === 0
            ? h('p', { className: 'mr-meta-status' }, '没搜到合适的，可以跳过。')
          : h('div', { className: 'mr-meta-list' }, candidates.map((item, index) => h('button', {
            key: `${item.sourceId}-${index}`,
            type: 'button',
            className: 'mr-meta-row',
            onClick: () => onPick(item),
          },
          h('span', { className: 'mr-meta-cover' }, item.coverUrl ? h('img', { src: item.coverUrl, alt: '', loading: 'lazy' }) : String(item.name || '?').slice(0, 1)),
          h('span', { className: 'mr-meta-copy' },
            h('strong', null, item.name || '未命名'),
            h('small', null, [item.author, item.sourceName].filter(Boolean).join(' · ')),
            item.intro ? h('em', null, item.intro) : null))))
      return h('div', { className: 'mr-meta-backdrop', role: 'dialog', 'aria-label': '补全书籍信息', onClick: onClose },
        h('div', { className: 'mr-meta-sheet', onClick: (event) => event.stopPropagation() },
          h('header', { className: 'mr-meta-head' },
            h('h2', null, '补全书籍信息'),
            h('button', { type: 'button', className: 'mr-meta-close', 'aria-label': '关闭', onClick: onClose }, h(Glyph, { name: 'close' }))),
          h('p', { className: 'mr-meta-sub' }, `从书源里挑一条最像「${title}」的信息，或者跳过。`),
          body,
          h('footer', { className: 'mr-meta-foot' }, h('button', { type: 'button', className: 'mr-meta-skip', onClick: onClose }, '跳过'))))
    }

    function ReaderNav({ tab, onTab }) {
      const nav = [
        ...SHELF_CATEGORIES.map((category) => [category.id, category.label, category.icon]),
        ['discover', '发现', 'compass'], ['sources', '书源', 'source'], ['settings', '设置', 'settings'],
      ];
      return h('nav', { className: 'mr-nav', 'aria-label': '墨读' },
        h('div', { className: 'mr-brand', title: '墨读', 'aria-label': '墨读' }, h(ReaderIcon, { size: 26 })),
        h('div', { className: 'mr-nav-items' }, nav.map(([id, label, icon]) => h('button', { key: id, className: tab === id ? 'active' : '', 'data-tab': id, onClick: () => onTab(id) }, h(Glyph, { name: icon }), h('span', null, label)))),
        h('div', { className: 'mr-local' }, h('span', null), '本机保存'));
    }

    function ReaderApp({ ctx }) {
      const [data, setData] = useState({ sources: [], subscriptions: [], books: [], jobs: [], notes: [], folders: [], settings: DEFAULT_SETTINGS });
      const [tab, setTab] = useState('novel');
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
      const [refreshingSubscriptions, setRefreshingSubscriptions] = useState([]);
      const [notice, setNotice] = useState(null);
      const [selectedSource, setSelectedSource] = useState('');
      const [results, setResults] = useState(null)
      const [shelfOnline, setShelfOnline] = useState(null)
      const [metaSheet, setMetaSheet] = useState(null)
      const [shelfOnlineBusy, setShelfOnlineBusy] = useState(false)
      const [shelfOnlineFailed, setShelfOnlineFailed] = useState(0)
      const shelfSearchTicket = useRef(0);
      const [resultSource, setResultSource] = useState('');
      const [searchFailed, setSearchFailed] = useState(0);
      const [reading, setReading] = useState(null);
      const [opening, setOpening] = useState(null);
      const [shelfView, setShelfView] = useState('shelf');
      const [audioTrack, setAudioTrack] = useState(null);
      const [audioQueue, setAudioQueue] = useState([]);
      const [audioPlaying, setAudioPlaying] = useState(false);
      const [audioTime, setAudioTime] = useState(0);
      const [audioDuration, setAudioDuration] = useState(0);
      const audioElRef = useRef(null);
      const audioHlsRef = useRef(null);
      const audioSaveAt = useRef(0);
      const mounted = useRef(true);
      const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
      const sources = (data.sources || []).filter((source) => (source.id || source.bookSourceUrl) !== 'local' && source.bookSourceUrl !== 'local:');
      const books = (data.books || []).map((book) => {
        const bookId = book.id || book.bookId;
        const job = (data.jobs || [])
          .filter((item) => item.bookId === bookId)
          .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
        const sourceFailed = (data.sources || []).some((item) => (item.id || item.bookSourceUrl) === book.sourceId && item.lastError);
        return job ? { ...book, sourceFailed, downloadStatus: job.status, download: job } : { ...book, sourceFailed };
      });
      const notes = data.notes || [];
      const activeCategory = SHELF_CATEGORIES.find((category) => category.id === tab) || null;
      const categoryBooks = activeCategory ? booksForShelfCategory(books, activeCategory.id) : [];
      const activeBook = reading ? books.find((book) => (book.id || book.bookId) === (reading.id || reading.bookId)) || reading : null;
      const notify = (text, kind = 'info') => setNotice({ text, kind });

      const refresh = async (quiet = false) => {
        if (!quiet) setLoading(true);
        try {
          const value = await call(ctx, 'state');
          if (!mounted.current) return;
          setData({ ...value, settings: { ...DEFAULT_SETTINGS, ...(value.settings || {}) } });
          const availableSources = (value.sources || []).filter((source) => (source.id || source.bookSourceUrl) !== 'local' && source.bookSourceUrl !== 'local:');
          setSelectedSource((current) => {
            const valid = availableSources.some((source) => (source.id || source.bookSourceUrl) === current);
            if (current && !valid) { setResults(null); setResultSource(''); }
            return valid ? current : availableSources[0]?.id || availableSources[0]?.bookSourceUrl || '';
          });
        } catch (cause) { if (mounted.current) notify(cause.message || String(cause), 'error'); }
        finally { if (mounted.current) setLoading(false); }
      };
      useEffect(() => {
        mounted.current = true; refresh();
        const timer = setInterval(() => { refresh(true); }, 2000);
        return () => { mounted.current = false; clearInterval(timer); };
      }, []);

      // 夜间定时：到点自动切换主题
      useEffect(() => {
        if (!settings.nightAuto) return;
        const check = () => {
          const now = new Date();
          const current = now.getHours() * 60 + now.getMinutes();
          const [sh, sm] = (settings.nightStart || '22:00').split(':').map(Number);
          const [eh, em] = (settings.nightEnd || '06:00').split(':').map(Number);
          const start = sh * 60 + sm;
          const end = eh * 60 + em;
          const inNight = start <= end ? (current >= start && current < end) : (current >= start || current < end);
          const targetTheme = inNight ? 'dark' : 'paper';
          if (settings.readerTheme !== targetTheme) updateSettings({ readerTheme: targetTheme });
        };
        check();
        const timer = setInterval(check, 60000);
        return () => clearInterval(timer);
      }, [settings.nightAuto, settings.nightStart, settings.nightEnd, settings.readerTheme]);

      const run = async (operation, success) => {
        setBusy(true);
        try { const value = await operation(); await refresh(true); if (success) notify(success, 'success'); return value; }
        catch (cause) { notify(cause.message || String(cause), 'error'); throw cause; }
        finally { setBusy(false); }
      };
      const importSource = (draft, allowHttp) => {
        const value = draft.trim();
        const pending = run(() => call(ctx, 'importSource', /^https?:\/\//i.test(value) ? { url: value, allowHttp } : { text: value, allowHttp }), null);
        pending.then((result) => { if (result) setNotice({ kind: 'info', text: importSummary(result) }); }, () => {});
        return pending;
      };
      const addSubscriptions = (sourceId, categories) => run(() => call(ctx, 'addSubscriptions', { sourceId, categories }), null).then((result) => {
        const parts = [];
        if (result?.added) parts.push(`已加入 ${result.added} 份订阅`);
        if (result?.missing?.length) parts.push(`${result.missing.length} 个分类已不在源里`);
        notify(parts.join('；') || '这些分类已经在书架里', result?.added ? 'success' : 'info');
        return result;
      });
      const subscribeLibrary = async (payload) => {
        try {
          const result = await run(() => call(ctx, 'subscribeSourceLibrary', payload));
          const skipped = Array.isArray(result?.skipped) ? result.skipped.length : 0;
          notify(`已订阅 ${result?.imported ?? 0} 个书源${skipped ? `，跳过 ${skipped} 个` : ''}`, skipped ? 'info' : 'success');
          return result;
        } catch { return false; }
      };
      const refreshSubscription = async (id) => {
        setRefreshingSubscriptions((ids) => ids.includes(id) ? ids : [...ids, id]);
        try {
          const result = await run(() => call(ctx, 'refreshSubscription', { id }));
          if (result?.pending) {
            notify('订阅包含新增网站或能力，等待确认后才会更新', 'info');
            return result;
          }
          const changes = [result?.added ? `新增 ${result.added}` : '', result?.updated ? `更新 ${result.updated}` : '', result?.removed ? `移除 ${result.removed}` : ''].filter(Boolean);
          notify(changes.length ? `订阅已检查：${changes.join('，')}` : '订阅已检查，没有变化', result?.removed ? 'info' : 'success');
          return result;
        } catch { await refresh(true); return false; }
        finally { setRefreshingSubscriptions((ids) => ids.filter(item => item !== id)); }
      };
      const confirmSubscriptionUpdate = (id) => run(() => call(ctx, 'confirmSubscriptionUpdate', { id }), '订阅更新已确认').catch(() => false);
      const rejectSubscriptionUpdate = (id) => run(() => call(ctx, 'rejectSubscriptionUpdate', { id }), '已拒绝本次更新，继续使用旧版').catch(() => false);
      const removeSubscription = (id) => run(() => call(ctx, 'removeSubscription', { id }), '已取消订阅，书源仍保留').catch(() => false);
      const toggleSource = (item) => {
        const enabling = item.enabled === false;
        const id = item.id || item.bookSourceUrl;
        return run(() => call(ctx, 'setSourceEnabled', { id, enabled: enabling }), enabling ? '书源已启用' : '书源已停用').catch(() => false);
      };
      const search = async (query) => {
        const keyword = String(query || '').trim();
        if (!keyword) return;
        setBusy(true); setResults(null); setSearchFailed(0);
        const targets = sources.filter((source) => source.id !== 'local' && source.contentType !== 'website' && source.kind !== 'rss' && source.enabled !== false);
        const settled = await Promise.allSettled(targets.map((source) => {
          const sourceId = source.id || source.bookSourceUrl;
          return withTimeout(call(ctx, 'search', { sourceId, query: keyword, page: 1 }), 15_000)
            .then((value) => ({ source, sourceId, items: Array.isArray(value) ? value : value?.items || value?.books || [] }));
        }));
        const shelfUrls = new Set(books.map((book) => book.bookUrl || book.url).filter(Boolean));
        const merged = [];
        let failed = 0;
        for (const outcome of settled) {
          if (outcome.status === 'rejected') { failed += 1; continue; }
          const { source, sourceId, items } = outcome.value;
          const label = source.bookSourceName || source.name || source.bookSourceUrl;
          for (const item of items) merged.push({ ...item, sourceId, sourceName: label });
        }
        merged.sort((a, b) => Number(shelfUrls.has(b.bookUrl || b.url)) - Number(shelfUrls.has(a.bookUrl || a.url)));
        setResults(merged);
        setSearchFailed(failed);
        setResultSource('');
        setBusy(false);
      };
      const searchShelfOnline = async (keyword) => {
        const text = String(keyword || '').trim()
        if (!text) { setShelfOnline(null); setShelfOnlineFailed(0); setShelfOnlineBusy(false); return }
        const ticket = ++shelfSearchTicket.current
        setShelfOnlineBusy(true)
        const targets = sources.filter((source) => source.enabled !== false && source.kind !== 'rss')
        const settled = await Promise.allSettled(targets.map((source) => {
          const sourceId = source.id || source.bookSourceUrl
          return withTimeout(call(ctx, 'search', { sourceId, query: text, page: 1 }), 15_000)
            .then((value) => ({ source, items: Array.isArray(value) ? value : value?.items || value?.books || [] }))
        }))
        if (ticket !== shelfSearchTicket.current) return
        const items = []
        let failed = 0
        for (const outcome of settled) {
          if (outcome.status === 'rejected') { failed += 1; continue }
          const label = outcome.value.source.bookSourceName || outcome.value.source.name || outcome.value.source.bookSourceUrl
          const sourceId = outcome.value.source.id || outcome.value.source.bookSourceUrl
          for (const item of outcome.value.items) items.push({ ...item, sourceId, sourceName: label })
        }
        setShelfOnline(items)
        setShelfOnlineFailed(failed)
        setShelfOnlineBusy(false)
      }
      const addBook = (book) => run(() => call(ctx, 'addBook', { sourceId: book.sourceId || resultSource || book.bookSourceUrl || selectedSource, bookUrl: book.bookUrl || book.url, download: true, book }), '已加入书架，开始下载').catch(() => {});
      const updateSettings = (partial) => {
        setData((current) => ({ ...current, settings: { ...current.settings, ...partial } }));
        return call(ctx, 'setSettings', partial).catch((cause) => notify(cause.message || String(cause), 'error'));
      };
      const updateBookSettings = (bookId, partial) => {
        setData((current) => ({
          ...current,
          books: (current.books || []).map((item) => {
            if ((item.id || item.bookId) !== bookId) return item;
            if (partial.clear === true) {
              const { readerPrefs, ...rest } = item;
              return rest;
            }
            const prefs = { ...(item.readerPrefs || {}) };
            for (const [key, value] of Object.entries(partial)) {
              if (value == null) delete prefs[key];
              else prefs[key] = value;
            }
            return { ...item, readerPrefs: Object.keys(prefs).length ? prefs : null };
          }),
        }));
        return call(ctx, 'setBookSettings', { bookId, ...partial }).catch((cause) => notify(cause.message || String(cause), 'error'));
      };
      const openMetaSheet = async (book) => {
        const bookId = book.id || book.bookId;
        const query = String(book.name || book.title || '').replace(/\.(?:txt|epub|md|pdf)$/i, '').trim();
        setMetaSheet({ book, bookId, candidates: null, busy: true });
        try {
          const sources = (data.sources || []).filter((item) => item.id || item.bookSourceUrl);
          const perSource = await Promise.allSettled(sources.map(async (source) => {
            const list = await withTimeout(call(ctx, 'search', { sourceId: source.id, query }), 15000);
            const items = Array.isArray(list) ? list : (list?.items || list?.results || []);
            return items.slice(0, 2).map((item) => ({
              sourceId: source.id,
              sourceName: source.name,
              name: String(item.name || '').trim(),
              author: String(item.author || '').trim(),
              intro: String(item.intro || '').trim(),
              coverUrl: String(item.coverUrl || '').trim(),
              bookUrl: String(item.bookUrl || '').trim(),
            }));
          }));
          const candidates = perSource.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : [])).slice(0, 8);
          setMetaSheet({ book, bookId, candidates, busy: false });
        } catch (cause) {
          const message = cause.message || String(cause);
          setMetaSheet({ book, bookId, candidates: [], busy: false, error: message });
        }
      };
      const applyMetaCandidate = async (candidate) => {
        const bookId = metaSheet?.bookId;
        if (!bookId) return;
        setMetaSheet(null);
        try {
          await call(ctx, 'applyBookMeta', { bookId, meta: candidate });
          await refresh(true);
          notify('已补全书籍信息', 'success');
        } catch (cause) { notify(cause.message || String(cause), 'error'); }
      };
      const localImport = async (file) => {
        if (file.size > 50 * 1024 * 1024) return notify('单本书不能超过 50MB', 'error');
        const format = file.name.toLowerCase().endsWith('.epub') ? 'epub' : 'txt';
        try {
          setBusy(true);
          let args = { name: file.name, format };
          if (format === 'txt') args.text = await file.text();
          else {
            const bytes = new Uint8Array(await file.arrayBuffer());
            let binary = '';
            for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
            args.base64 = btoa(binary);
          }
          const imported = await call(ctx, 'importLocal', args);
          await refresh(true); notify('书籍已导入', 'success'); setTab('novel');
          if (imported && !String(imported.author || '').trim()) void openMetaSheet(imported);
        } catch (cause) { notify(cause.message || String(cause), 'error'); }
        finally { setBusy(false); }
      };
      const exportBackup = async () => {
        try {
          const backup = await call(ctx, 'exportBackup');
          const text = typeof backup === 'string' ? backup : JSON.stringify(backup, null, 2);
          const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
          const anchor = document.createElement('a');
          anchor.href = url; anchor.download = `mo-reader-backup-${new Date().toISOString().slice(0, 10)}.json`; anchor.style.display = 'none';
          document.body.appendChild(anchor); anchor.click();
          setTimeout(() => { anchor.remove(); URL.revokeObjectURL(url); }, 1000); notify('备份已导出', 'success');
        } catch (cause) { notify(cause.message || String(cause), 'error'); }
      };
      const importBackup = async (file) => {
        try { const data = JSON.parse(await file.text()); await run(() => call(ctx, 'importBackup', { data }), '备份已恢复'); }
        catch (cause) { notify(cause.message || String(cause), 'error'); }
      };
      const saveNote = (note) => run(() => call(ctx, 'saveNote', note), '笔记已保存');
      const motionOff = prefersReducedMotion() || settings.reducedMotion === 'on' || settings.animations === false;
      const saveAudioNow = () => {
        const el = audioElRef.current;
        if (!el || !audioTrack) return;
        const duration = Number(el.duration) || 0;
        if (!duration) return;
        const offset = Math.floor(Number(el.currentTime) || 0);
        call(ctx, 'saveProgress', { bookId: audioTrack.bookId, chapterId: audioTrack.chapterId, offset, percent: Math.min(100, Math.max(0, offset / duration * 100)) }).catch(() => {});
      };
      const startAudio = (track, startAt = 0, queue) => {
        saveAudioNow();
        if (Array.isArray(queue)) setAudioQueue(queue);
        setAudioTime(Number(startAt) || 0);
        setAudioTrack({ ...track, startAt: Number(startAt) || 0, nonce: Date.now() });
        setAudioPlaying(true);
      };
      const toggleAudio = () => {
        const el = audioElRef.current;
        if (!el || !audioTrack) return;
        if (el.paused) el.play().then(() => setAudioPlaying(true)).catch(() => setAudioPlaying(false));
        else { el.pause(); saveAudioNow(); setAudioPlaying(false); }
      };
      const seekAudio = (seconds) => {
        const el = audioElRef.current;
        if (!el) return;
        el.currentTime = Math.max(0, Number(seconds) || 0);
        setAudioTime(el.currentTime);
      };
      const closeAudio = () => {
        saveAudioNow();
        audioElRef.current?.pause();
        setAudioPlaying(false);
        setAudioTrack(null);
        setAudioTime(0);
        setAudioDuration(0);
      };
      const audioIndex = audioQueue.findIndex((item) => item.chapterId === audioTrack?.chapterId);
      const playQueuedAudio = async (nextIndex) => {
        const item = audioQueue[nextIndex];
        if (!item) return;
        try {
          const payload = await call(ctx, 'chapter', { bookId: item.bookId, chapterId: item.chapterId });
          const queuedBook = books.find((value) => (value.id || value.bookId) === item.bookId) || { id: item.bookId, contentType: 'audio' };
          const source = mediaChapterSource({ ...queuedBook, contentType: 'audio' }, { ...payload, id: item.chapterId });
          if (source.kind !== 'media') { notify(source.error || '这一章没有可播放的音频。', 'error'); return; }
          startAudio({ bookId: item.bookId, bookName: queuedBook.name || queuedBook.title, chapterId: item.chapterId, chapterTitle: item.title, url: source.url, hls: source.hls }, mediaStartSeconds(queuedBook, { id: item.chapterId }));
        } catch (cause) {
          notify(cause.message || String(cause), 'error');
        }
      };
      useEffect(() => {
        const el = audioElRef.current;
        audioHlsRef.current?.destroy();
        audioHlsRef.current = null;
        if (!el || !audioTrack) {
          if (el) { el.pause(); el.removeAttribute('src'); el.load(); }
          return;
        }
        let live = true;
        const play = () => {
          if (!live) return;
          try { el.currentTime = audioTrack.startAt || 0; } catch {}
          el.play().then(() => setAudioPlaying(true)).catch(() => setAudioPlaying(false));
        };
        if (audioTrack.hls) {
          loadHlsPlayer().then((Hls) => {
            if (!live) return;
            if (!Hls.isSupported()) { notify('浏览器不支持 HLS 音频，可先下载这一章', 'error'); return; }
            const player = new Hls({ enableWorker: false });
            audioHlsRef.current = player;
            player.loadSource(audioTrack.url);
            player.attachMedia(el);
            player.on(Hls.Events.MANIFEST_PARSED, play);
            player.on(Hls.Events.ERROR, (_event, data) => {
              if (data?.fatal) { setAudioPlaying(false); notify('音频加载失败：媒体地址失效或格式不支持', 'error'); }
            });
          }).catch(() => { if (live) notify('在线 HLS 播放器加载失败，可先下载这一章', 'error'); });
        } else {
          el.src = audioTrack.url;
          el.load();
          play();
        }
        return () => {
          live = false;
          audioHlsRef.current?.destroy();
          audioHlsRef.current = null;
        };
      }, [audioTrack?.nonce]);
      const onAudioTime = () => {
        const el = audioElRef.current;
        if (!el || !audioTrack) return;
        setAudioTime(el.currentTime || 0);
        setAudioDuration(el.duration || 0);
        const stamp = Date.now();
        if (el.duration && stamp - audioSaveAt.current > 6000) {
          audioSaveAt.current = stamp;
          const percent = Math.min(100, Math.max(0, (el.currentTime / el.duration) * 100));
          call(ctx, 'saveProgress', { bookId: audioTrack.bookId, chapterId: audioTrack.chapterId, offset: Math.floor(el.currentTime), percent }).catch(() => {});
        }
      };
      const audioElement = h('audio', {
        ref: audioElRef, preload: 'metadata', hidden: true,
        onPlay: () => setAudioPlaying(true), onPause: () => setAudioPlaying(false),
        onTimeUpdate: onAudioTime,
        onLoadedMetadata: (event) => {
          const start = Number(audioTrack?.startAt) || 0;
          if (start > 0 && event.currentTarget.currentTime < 1) { try { event.currentTarget.currentTime = start; } catch {} }
          onAudioTime();
        },
        onEnded: () => { setAudioPlaying(false); if (audioTrack) call(ctx, 'saveProgress', { bookId: audioTrack.bookId, chapterId: audioTrack.chapterId, offset: Math.floor(audioDuration || 0), percent: 100 }).catch(() => {}); },
        onError: () => { setAudioPlaying(false); notify('音频加载失败：地址可能已失效，或浏览器不支持该格式', 'error'); },
      });
      const openBook = (book, detail) => {
        if (!detail?.rect || !detail?.panel || motionOff) { setOpening(null); setReading(book); return; }
        setOpening({ ...detail, book, theme: settings.readerTheme || 'paper' });
        setReading(book);
      };
      if (activeBook) return h(React.Fragment, null, h('style', null, css), audioElement,
        bookContentType(activeBook) === 'novel' || bookContentType(activeBook) === 'subscription'
          ? h(ReaderView, { ctx, book: activeBook, settings, notes, notice, onDismissNotice: () => setNotice(null), deferMs: opening ? 200 : 0, onSettings: updateSettings, onBookSettings: (partial) => updateBookSettings(activeBook.id || activeBook.bookId, partial), onClose: () => { setOpening(null); setReading(null); refresh(true); }, onSaveNote: saveNote, onDeleteNote: (note) => run(() => call(ctx, 'deleteNote', { id: note.id })).catch(() => {}), notify })
          : h(MediaReader, { ctx, book: activeBook, settings, notify, jobs: data.jobs || [], onClose: () => { setOpening(null); setReading(null); refresh(true); }, onRefresh: () => refresh(true), audioTrack, audioPlaying, audioTime, audioDuration, onAudioPlay: startAudio, onAudioToggle: toggleAudio, onAudioSeek: seekAudio }),
        audioTrack ? h(MediaAudioDock, { track: audioTrack, playing: audioPlaying, time: audioTime, duration: audioDuration, onToggle: toggleAudio, onSeek: seekAudio, onClose: closeAudio, onPrev: audioIndex > 0 ? () => playQueuedAudio(audioIndex - 1) : null, onNext: audioIndex >= 0 && audioIndex < audioQueue.length - 1 ? () => playQueuedAudio(audioIndex + 1) : null }) : null,
        opening ? h(OpenTransition, { key: opening.bookId || 'open', data: opening, onDone: () => setOpening(null) }) : null);

      return h(React.Fragment, null, h('style', null, css), audioElement,
        audioTrack ? h(MediaAudioDock, { track: audioTrack, playing: audioPlaying, time: audioTime, duration: audioDuration, onToggle: toggleAudio, onSeek: seekAudio, onClose: closeAudio, onPrev: audioIndex > 0 ? () => playQueuedAudio(audioIndex - 1) : null, onNext: audioIndex >= 0 && audioIndex < audioQueue.length - 1 ? () => playQueuedAudio(audioIndex + 1) : null }) : null,
        h(MetaSheet, { state: metaSheet, onClose: () => setMetaSheet(null), onPick: applyMetaCandidate }), h('div', { className: 'mr-root' },
        h(ReaderNav, { tab, onTab: setTab }),
        h('section', { className: 'mr-content' },
          h(Notice, { notice, onClose: () => setNotice(null) }),
          loading ? h('div', { className: 'mr-loading' }, '正在打开墨读…') : null,
          !loading && activeCategory?.id === 'website' ? h(WebsiteShelf, { sources }) : null,
          !loading && activeCategory && activeCategory.id !== 'website' ? h(Library, { books: categoryBooks, category: activeCategory, folders: data.folders || [], busy, view: shelfView, onView: setShelfView, ctx, online: shelfOnline, onlineBusy: shelfOnlineBusy, onlineFailed: shelfOnlineFailed, onSearchOnline: searchShelfOnline, onAddOnline: (item) => addBook(item), theme: settings.readerTheme || 'paper', quality: settings.motionQuality || 'auto', ambience: settings.ambience || 'full', reducedMotion: motionOff, onStats: () => setTab('stats'), onOpen: openBook, onDownload: (book) => run(() => call(ctx, 'download', { bookId: book.id || book.bookId }), '下载已开始').catch(() => {}),
            onCreateFolder: (name) => run(() => call(ctx, 'createFolder', { name }), '文件夹已创建').catch(() => {}),
            onRenameFolder: (folderId, name) => run(() => call(ctx, 'renameFolder', { folderId, name }), '已重命名').catch(() => {}),
            onRemoveFolder: (folderId) => run(() => call(ctx, 'removeFolder', { folderId }), '文件夹已删除').catch(() => {}),
            onMoveToFolder: (bookIds, folderId) => run(() => call(ctx, 'moveBooksToFolder', { bookIds, folderId }), '已移动'),
            onBatchDelete: (bookIds) => run(() => call(ctx, 'batchDeleteBooks', { bookIds }), `已删除 ${bookIds.length} 本`),
            onBatchDownload: (bookIds) => run(() => call(ctx, 'batchDownloadBooks', { bookIds }), `已开始下载 ${bookIds.length} 本`),
            onExport: (bookIds) => Promise.all(bookIds.map(id => run(() => call(ctx, 'exportBook', { bookId: id, format: 'txt' }), '导出完成').then(r => { if (r?.text) { const blob = new Blob([r.text], { type: 'text/plain;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${r.name || id}.txt`; a.click(); URL.revokeObjectURL(a.href); } else if (r?.base64) { const blob = new Blob([Uint8Array.from(atob(r.base64), c => c.charCodeAt(0))], { type: 'application/epub+zip' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${r.name || id}.epub`; a.click(); URL.revokeObjectURL(a.href); } }))),
            onMarkRead: (bookIds) => Promise.all(bookIds.map(id => run(() => call(ctx, 'markBookRead', { bookId: id }), '已标记'))),
            onToggleDownload: (book) => {
              const status = book.downloadStatus || book.download?.status;
              const bookId = book.id || book.bookId;
              if (status === 'failed' || status === 'partial' || status === 'completed') return run(() => call(ctx, 'download', { bookId }), status === 'completed' ? '重新检查' : '重新下载').catch(() => {});
              const paused = status === 'paused' || status === 'cancelled';
              if (paused) {
                const pending = call(ctx, 'resumeJob', { bookId }).catch(() => call(ctx, 'download', { bookId }));
                return run(() => pending, '继续下载').catch(() => {});
              }
              const pending = call(ctx, 'pauseJob', { bookId }).catch(() => {
                const jobId = book.download?.id || book.download?.jobId || book.downloadJobId;
                return call(ctx, 'cancelJob', { jobId });
              });
              return run(() => pending, '已暂停').catch(() => {});
            }, onRemove: (book) => run(() => call(ctx, 'removeBook', { bookId: book.id || book.bookId }), '已移出书架').catch(() => {}), onCheck: () => run(() => call(ctx, 'checkUpdates'), '补查完成').catch(() => {}) }) : null,
          !loading && tab === 'discover' ? h(Discover, { sources, onSearch: search, onAdd: addBook, results, busy, failed: searchFailed }) : null,
          !loading && tab === 'sources' ? h(Sources, { sources, subscriptions: data.subscriptions || [], checkingIds: [...new Set([...(data.subscriptions || []).filter(item => item.checking).map(item => item.id), ...refreshingSubscriptions])], busy, onImport: importSource, onAddSubscriptions: addSubscriptions,
              onRestoreBuiltin: () => run(() => call(ctx, 'restoreBuiltinSources'), '内置书源已恢复').then((result) => { if (result) setNotice({ kind: 'success', text: `已恢复 ${result.added} 个内置书源` }); }, () => {}),
              onSubscribe: subscribeLibrary,
              onRefresh: refreshSubscription,
              onConfirmUpdate: confirmSubscriptionUpdate,
              onRejectUpdate: rejectSubscriptionUpdate,
              onUnsubscribe: removeSubscription,
              onToggle: toggleSource,
              onRemove: (source) => run(() => call(ctx, 'removeSource', { id: source.id || source.bookSourceUrl }), '书源已移除').catch(() => {}) }) : null,
          !loading && tab === 'stats' ? h(Stats) : null,
          !loading && tab === 'settings' ? h(Settings, { settings, onSettings: updateSettings, onLocal: localImport, onExport: exportBackup, onImport: importBackup, busy, onStats: () => setTab('stats'),
            onExportNotes: () => run(() => call(ctx, 'exportNotes'), '导出完成').then(r => { if (r?.text) { const blob = new Blob([r.text], { type: 'text/markdown;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '墨读笔记.md'; a.click(); URL.revokeObjectURL(a.href); } }, () => {}),
            onUploadFont: (file) => { const reader = new FileReader(); reader.onload = (e) => { const fontFamily = `custom-${Date.now()}`; const style = document.createElement('style'); style.textContent = `@font-face{font-family:'${fontFamily}';src:url('${e.target.result}')}`; document.head.appendChild(style); updateSettings({ fontFamily }); setNotice({ kind: 'success', text: '字体已应用' }); }; reader.readAsDataURL(file); },
          }) : null)));
    }

    const css = String.raw`
.mr-root{--mr-accent:var(--dsw-alias-brand-primary);--mr-accent-hover:color-mix(in srgb,var(--dsw-alias-brand-primary) 86%,var(--dsw-alias-bg-base));--mr-on-accent:var(--dsw-alias-bg-base);--mr-paper:var(--dsw-alias-bg-base);--mr-card:var(--dsw-alias-bg-layer-1);--mr-sunken:var(--dsw-alias-bg-overlay);--mr-text:var(--dsw-alias-label-primary);--mr-body:var(--dsw-alias-label-primary);--mr-muted:var(--dsw-alias-label-secondary);--mr-border:var(--dsw-alias-border-l2);--mr-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px -12px rgba(0,0,0,.12);--mr-cover-shadow:0 10px 28px rgba(0,0,0,.12);--mr-serif:"Songti SC","Noto Serif CJK SC","Source Han Serif SC",Georgia,serif;--mr-sans:"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",var(--dsw-font-family,system-ui),sans-serif;height:100%;min-height:0;display:flex;overflow:hidden;background:var(--mr-paper);color:var(--mr-text);font-family:var(--mr-sans)}
body[data-ds-dark-theme] .mr-root{--mr-sunken:var(--dsw-alias-bg-layer-2);--mr-shadow:0 1px 2px rgba(0,0,0,.24),0 8px 24px -12px rgba(0,0,0,.55);--mr-cover-shadow:0 10px 28px rgba(0,0,0,.55)}
body[data-ds-dark-theme] .mr-shelf-cover{box-shadow:0 0 0 1px rgba(242,232,213,.14),var(--mr-cover-shadow)}
.mr-root *,.mr-reader *{box-sizing:border-box}.mr-root button,.mr-root input,.mr-root textarea,.mr-root select,.mr-reader button,.mr-reader input,.mr-reader textarea,.mr-reader select{font:inherit}.mr-root button,.mr-reader button{cursor:pointer}.mr-root button:disabled,.mr-reader button:disabled{cursor:not-allowed;opacity:.45}
.mr-nav{width:176px;flex:0 0 176px;display:flex;flex-direction:column;padding:24px 14px 16px;border-right:1px solid var(--mr-border);background:var(--mr-card)}
.mr-brand{display:flex;align-items:center;gap:10px;padding:0 10px 28px;color:var(--mr-text)}.mr-brand svg{color:var(--mr-accent)}.mr-brand strong{display:block;font-family:var(--mr-serif);font-size:21px;letter-spacing:2px}.mr-brand small{display:block;color:var(--mr-muted);font-size:11px;margin-top:2px;letter-spacing:0}
.mr-nav-items{display:flex;flex-direction:column;gap:4px}.mr-nav-items button{min-height:44px;border:0;border-left:2px solid transparent;border-radius:8px;background:transparent;color:var(--mr-muted);display:flex;align-items:center;gap:12px;padding:0 14px;text-align:left;font-size:13px}.mr-nav-items button:hover{background:var(--mr-sunken);color:var(--mr-text)}.mr-nav-items button.active{border-left-color:transparent;background:var(--mr-sunken);color:var(--mr-text);font-weight:600}.mr-nav-items button.active svg{color:var(--mr-text)}
.mr-local{margin-top:auto;color:var(--mr-muted);font-size:11px;display:flex;align-items:center;gap:7px;padding:10px}.mr-local span{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.mr-content{flex:1;min-width:0;height:100%;overflow-y:auto;padding:24px clamp(20px,3vw,44px);position:relative;background:var(--mr-paper)}.mr-content>div:not(.mr-notice):not(.mr-window-shelf){max-width:1180px;margin:0 auto}
.mr-section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:24px}.mr-section-head h2{font:400 32px/1.2 var(--mr-serif);margin:0;letter-spacing:-.5px;color:var(--mr-text)}.mr-section-head p{margin:7px 0 0;color:var(--mr-muted);font-size:13px}
.mr-section-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mr-view-toggle{display:inline-flex;padding:2px;border:1px solid var(--mr-border);border-radius:8px;background:transparent}
.mr-view-toggle button{min-height:32px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--mr-muted);font-size:12px}
.mr-view-toggle button.active{background:color-mix(in srgb,var(--mr-accent) 14%,var(--mr-paper));color:var(--mr-accent);font-weight:600;box-shadow:none}
body[data-ds-dark-theme] .mr-view-toggle button.active{box-shadow:0 1px 2px rgba(0,0,0,.4)}
.mr-shelf{position:relative;z-index:1;display:flex;flex-direction:column;gap:0;min-height:100%}
.mr-shelf-topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 0 16px;margin-bottom:20px}
.mr-shelf-online{margin:26px 0 8px;padding-top:18px;border-top:1px solid var(--mr-line)}
.mr-shelf-online-head{display:flex;align-items:baseline;gap:12px;margin-bottom:12px}
.mr-shelf-online-head h2{margin:0;font-size:15px;font-weight:600}
.mr-shelf-online-meta{color:var(--mr-muted);font-size:12px}
.mr-shelf-online-list{display:flex;flex-direction:column;gap:2px}
.mr-shelf-online-row{display:flex;align-items:center;gap:14px;padding:12px 4px;border-bottom:1px solid var(--mr-line)}
.mr-shelf-online-row:last-child{border-bottom:0}
.mr-meta-backdrop{position:absolute;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(24,21,16,.30);backdrop-filter:blur(2px)}
.mr-meta-sheet{width:min(560px,100%);max-height:min(600px,100%);overflow:auto;padding:18px 20px 14px;border-radius:14px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));box-shadow:0 24px 60px rgba(0,0,0,.22)}
.mr-meta-head{display:flex;align-items:center;justify-content:space-between}
.mr-meta-head h2{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-text-1)}
.mr-meta-close{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:8px;background:none;color:var(--dsw-alias-text-2);cursor:pointer}
.mr-meta-close:hover{background:var(--dsw-alias-bg-2,rgba(0,0,0,.05));color:var(--dsw-alias-text-1)}
.mr-meta-sub{margin:4px 0 14px;font-size:12px;line-height:1.6;color:var(--dsw-alias-text-2)}
.mr-meta-status{margin:0;padding:18px 0;font-size:12px;color:var(--dsw-alias-text-2)}
.mr-meta-list{display:flex;flex-direction:column;gap:6px}
.mr-meta-row{display:flex;align-items:flex-start;gap:12px;width:100%;padding:10px;border:1px solid transparent;border-radius:10px;background:none;text-align:left;cursor:pointer}
.mr-meta-row:hover{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-2,rgba(0,0,0,.03))}
.mr-meta-cover{display:flex;align-items:center;justify-content:center;flex:none;width:38px;height:52px;overflow:hidden;border-radius:4px;background:var(--dsw-alias-bg-3,rgba(0,0,0,.06));font-size:14px;color:var(--dsw-alias-text-2)}
.mr-meta-cover img{width:100%;height:100%;object-fit:cover}
.mr-meta-copy{display:flex;flex-direction:column;gap:2px;min-width:0}
.mr-meta-copy strong{font-size:13px;font-weight:600;color:var(--dsw-alias-text-1)}
.mr-meta-copy small{font-size:11px;color:var(--dsw-alias-text-2)}
.mr-meta-copy em{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11px;font-style:normal;line-height:1.6;color:var(--dsw-alias-text-3)}
.mr-meta-foot{display:flex;justify-content:flex-end;margin-top:10px}
.mr-meta-skip{padding:6px 10px;border:0;border-radius:8px;background:none;color:var(--dsw-alias-text-2);font-size:12px;cursor:pointer}
.mr-meta-skip:hover{background:var(--dsw-alias-bg-2,rgba(0,0,0,.05));color:var(--dsw-alias-text-1)}
.mr-shelf-online-cover{flex:none;width:42px;height:56px;border-radius:4px;overflow:hidden;background:var(--mr-sunken);display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--mr-muted)}
.mr-shelf-online-cover img{width:100%;height:100%;object-fit:cover}
.mr-shelf-online-info{min-width:0;flex:1}
.mr-shelf-online-info strong{display:block;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mr-shelf-online-info small{display:block;margin-top:2px;color:var(--mr-muted);font-size:12px}
.mr-shelf-online-info p{margin:4px 0 0;color:var(--mr-muted);font-size:12px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.mr-shelf-search{display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;border:1px solid var(--mr-border);border-radius:8px;background:var(--dsw-specific-input-major,var(--mr-card));font-size:13px;color:var(--mr-muted)}
.mr-shelf-search:focus-within{border-color:var(--mr-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--mr-accent) 12%,transparent)}
.mr-shelf-search input{border:0!important;background:transparent;outline:none;width:200px;padding:0;font-size:13px;color:var(--mr-text)}.mr-shelf-search input:focus,.mr-shelf-search input:focus-visible{outline:0!important;box-shadow:none!important}.mr-shelf-search input::placeholder{color:var(--mr-muted);opacity:1}
.mr-shelf-search .kbd{font-size:11px;border:1px solid var(--mr-border);border-radius:4px;padding:1px 4px;color:var(--mr-muted)}
.mr-shelf-search-clear{display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--mr-muted);cursor:pointer}
.mr-shelf-search-clear:hover{background:var(--mr-card);color:var(--mr-text)}
.mr-shelf-back{display:inline-flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;padding:0;border:1px solid var(--mr-border);border-radius:9px;background:var(--mr-paper);color:var(--mr-muted);cursor:pointer;margin-right:auto}.mr-shelf-back:hover{border-color:var(--mr-accent);color:var(--mr-accent)}.mr-shelf-refresh{display:inline-flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;padding:0;border:1px solid var(--mr-border);border-radius:9px;background:var(--mr-paper);color:var(--mr-muted);cursor:pointer}.mr-shelf-refresh:hover{border-color:var(--mr-accent);color:var(--mr-accent)}.mr-shelf-refresh:disabled{opacity:.45;cursor:default}
.mr-shelf-search-clear:focus-visible{outline:2px solid var(--mr-accent);outline-offset:2px}
.mr-shelf-search-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:260px;padding:24px;border:1px dashed var(--mr-border);border-radius:10px;text-align:center}
.mr-shelf-search-empty p{margin:0;font-size:13px;color:var(--mr-muted)}
.mr-shelf-search-empty p:first-child{font:400 20px/1.35 var(--mr-serif);color:var(--mr-text)}
.mr-shelf-search-empty .hint{font-size:12px}
.mr-shelf-search-empty .mr-button{margin-top:6px}
.mr-shelf-grid-note{grid-column:1/-1;display:flex;align-items:center;justify-content:center;min-height:200px;border:1px dashed var(--mr-border);border-radius:10px;color:var(--mr-muted);font-size:13px;text-align:center;padding:24px}
.mr-shelf-status{display:flex;align-items:center;gap:12px;font-size:11px;color:var(--mr-muted)}
.mr-shelf-status .dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.mr-shelf-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:20px}
.mr-shelf-head-copy{min-width:0}
.mr-shelf-head .kicker{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.14em;color:var(--mr-muted);margin-bottom:8px}
.mr-shelf-head .kicker .tag{border:1px solid var(--mr-border);color:var(--mr-muted);padding:1px 6px;font-size:11px;border-radius:2px;letter-spacing:.08em}
.mr-shelf-head h1{font:400 32px/1.2 var(--mr-serif);margin:0;color:var(--mr-text);letter-spacing:-.4px}.mr-shelf-head-blurb{margin:7px 0 0;color:var(--mr-muted);font-size:12px;line-height:1.5}
.mr-shelf-head-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mr-shelf-gallery{display:grid;grid-template-columns:320px 1fr;gap:28px;align-items:stretch}
.mr-tag.failed{background:color-mix(in srgb, #a8422f 18%, transparent);color:#a8422f;border-color:color-mix(in srgb, #a8422f 35%, transparent)}
.mr-new-badge{position:absolute;left:8px;top:8px;z-index:3;display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;font:500 11px/1 var(--mr-sans);letter-spacing:.02em;color:#fff;background:#a8422f;box-shadow:0 1px 3px rgba(0,0,0,.18)}
.mr-dl-badge{position:absolute;right:8px;top:8px;z-index:3;display:inline-flex;align-items:center;justify-content:center;min-width:38px;height:20px;padding:0 7px;border-radius:999px;font:500 11px/1 var(--mr-sans);letter-spacing:.02em;color:var(--mr-on-accent);background:color-mix(in srgb,var(--mr-ink) 72%,transparent);backdrop-filter:blur(6px);cursor:pointer;user-select:none}
.mr-dl-badge:hover{background:color-mix(in srgb,var(--mr-ink) 84%,transparent)}
.mr-dl-badge.queued{background:color-mix(in srgb,var(--mr-ink) 45%,transparent)}
.mr-dl-badge.paused{background:color-mix(in srgb,var(--mr-ink) 55%,transparent)}
.mr-dl-badge.failed{background:#a8422f}
.mr-dl-badge.done{background:color-mix(in srgb,var(--mr-accent) 78%,#000 6%)}.mr-dl-badge>svg{display:none}
.mr-shelf-piece{position:relative;display:flex;flex-direction:column;gap:10px;min-width:0;padding:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;appearance:none;border-radius:4px;opacity:0;animation:mr-fade-in .2s ease forwards;-webkit-touch-callout:none;user-select:none}
.mr-shelf-piece:focus-visible{outline:2px solid var(--mr-accent);outline-offset:4px}
.mr-shelf-piece:hover .mr-shelf-cover{transform:translateY(-4px)}
.mr-shelf-piece:active .mr-shelf-cover{transform:translateY(-2px)}
@keyframes mr-fade-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.mr-shelf-cover{position:relative;display:block;aspect-ratio:2/3;border-radius:4px;overflow:hidden;box-shadow:var(--mr-cover-shadow);transition:transform .18s cubic-bezier(.2,.8,.2,1)}
.mr-shelf-cover::before{content:'';position:absolute;inset:0 auto 0 0;width:6px;background:linear-gradient(90deg,rgba(0,0,0,.08),rgba(0,0,0,0));z-index:2;pointer-events:none}
.mr-shelf-cover::after{content:'';position:absolute;inset:0 0 0 auto;width:3px;background:rgba(255,255,255,.3);z-index:2;pointer-events:none}
.mr-shelf-cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.mr-shelf-mtn{position:absolute;left:0;right:0;bottom:0;height:33%;z-index:1;pointer-events:none;background:linear-gradient(180deg,rgba(33,28,22,.02),rgba(33,28,22,.14));clip-path:polygon(0 100%,0 62%,14% 40%,28% 62%,42% 46%,56% 68%,72% 38%,86% 58%,100% 44%,100% 100%)}
.mr-shelf-fallback{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px}
.mr-shelf-fallback-title{position:relative;z-index:3;font-family:var(--mr-serif);font-size:18px;line-height:1.4;color:#211C16;text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mr-shelf-hero-cover .mr-shelf-fallback-title{font-size:24px}.mr-shelf-fallback.mr-latin .mr-shelf-fallback-title{writing-mode:horizontal-tb;text-orientation:initial;font-size:12px;line-height:1.45;letter-spacing:0;white-space:normal;overflow-wrap:anywhere;max-height:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.mr-shelf-seal{position:absolute;right:12px;bottom:12px;z-index:4;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:4px;background:var(--mr-accent);color:var(--mr-on-accent);font-family:var(--mr-serif);font-size:14px;line-height:1;box-shadow:0 1px 0 rgba(255,255,255,.2) inset}
.mr-shelf-cap{display:block;min-width:0}
.mr-shelf-cap strong{display:block;font:500 14px/1.45 var(--mr-serif);color:var(--mr-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mr-shelf-cap small{display:block;font-size:11px;color:var(--mr-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.mr-shelf-hero{position:relative;display:flex;flex-direction:column;gap:12px}
.mr-shelf-hero-cover{position:relative;width:320px;padding:0;border:0;background:transparent;color:inherit;border-radius:4px;cursor:pointer}.mr-shelf-hero-cover .mr-shelf-cover{aspect-ratio:3/4}
.mr-shelf-hero-cover:focus-visible{outline:2px solid var(--mr-accent);outline-offset:4px}
.mr-shelf-hero-info{min-width:0}
.mr-shelf-eyebrow{margin:0 0 4px;color:var(--mr-muted);font-size:11px;letter-spacing:.12em}
.mr-shelf-hero-title{margin:0 0 4px;color:var(--mr-text);font:400 26px/1.25 var(--mr-serif);letter-spacing:-.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mr-shelf-hero-by{margin:0 0 8px;color:var(--mr-muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mr-shelf-progress{height:3px;border-radius:2px;background:var(--mr-border);overflow:hidden;margin:0 0 8px}
.mr-shelf-progress i{display:block;height:100%;background:var(--mr-accent);border-radius:2px}
.mr-shelf-cta{min-height:40px;padding:0 18px;border:0;border-radius:8px;background:var(--mr-accent);color:var(--mr-on-accent);font-size:13px;font-weight:600;cursor:pointer}
.mr-shelf-cta:hover{background:var(--mr-accent-hover)}
.mr-shelf-cta:focus-visible{outline:2px solid var(--mr-accent);outline-offset:2px}
.mr-shelf-folder-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 0 4px}
.mr-folder-chip{min-height:28px;padding:0 12px;border:1px solid var(--mr-border);border-radius:14px;background:var(--mr-card);color:var(--mr-muted);font-size:12px;white-space:nowrap;transition:background .15s,color .15s}
.mr-folder-chip:hover{background:var(--mr-sunken);color:var(--mr-text)}
.mr-folder-chip.active{background:var(--mr-accent);color:var(--mr-on-accent);border-color:var(--mr-accent)}
.mr-folder-add{border-style:dashed;color:var(--mr-accent)}
.mr-folder-del{color:var(--dsw-alias-state-danger-primary,#c44);border-color:var(--dsw-alias-state-danger-primary,#c44)}
.mr-select-bar{display:flex;flex-direction:column;align-items:stretch;gap:4px;width:min(100%,560px);padding:8px 12px 10px;background:var(--mr-paper);border:1px solid var(--mr-border);border-radius:14px;box-shadow:0 12px 36px rgba(62,48,31,.12);margin:8px auto 12px}.mr-select-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:32px;padding-bottom:4px;border-bottom:1px solid var(--mr-border)}.mr-select-actions{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;width:100%}.mr-select-actions .mr-button{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;width:100%;min-width:0;height:48px;padding:4px 0 2px;border:0;border-radius:10px;background:transparent;box-shadow:none;color:var(--mr-text);font-size:11px;line-height:1.2;white-space:nowrap}.mr-select-actions .mr-button:hover{background:var(--mr-sunken)}.mr-select-actions .mr-button:disabled{opacity:.35;background:transparent}.mr-select-actions .mr-button.mr-select-delete{color:var(--dsw-alias-state-danger-primary,#a8332a)}
.mr-select-all{display:flex;align-items:center;gap:8px;min-height:32px;font-size:12px;font-weight:500;color:var(--mr-text);cursor:pointer}.mr-select-all input{width:16px;height:16px;margin:0;accent-color:var(--mr-accent)}.mr-select-close{display:inline-flex;align-items:center;justify-content:center;flex:none;width:36px;height:36px;margin:-4px -4px -4px 0;padding:0;border:0;border-radius:50%;background:transparent;color:var(--mr-muted);cursor:pointer}.mr-select-close:hover{background:var(--mr-sunken);color:var(--mr-text)}
.mr-shelf-piece{transition:transform .16s ease}.mr-shelf-piece.mr-selected{outline:0;z-index:2;transform:scale(1.025);transform-origin:center}.mr-shelf-piece.mr-selected .mr-shelf-cover{box-shadow:0 10px 26px rgba(62,48,31,.24)}
.mr-select-check{position:absolute;top:7px;right:7px;left:auto;z-index:2;box-sizing:border-box;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:1.5px solid color-mix(in srgb,var(--mr-text) 48%,transparent);background:color-mix(in srgb,var(--mr-paper) 92%,transparent);color:var(--mr-text);box-shadow:0 1px 4px rgba(38,30,20,.14);pointer-events:none}.mr-select-check.mr-checked{border-color:var(--mr-accent);background:var(--mr-accent);color:var(--mr-on-accent)}.mr-select-check svg{display:block;flex:none}
.mr-folder-sheet-backdrop{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.3);backdrop-filter:blur(2px)}
.mr-folder-sheet{width:min(360px,90vw);max-height:60vh;overflow:auto;background:var(--mr-card);border:1px solid var(--mr-border);border-radius:14px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.2)}
.mr-folder-sheet h3{margin:0 0 12px;font-size:16px;color:var(--mr-text)}
.mr-folder-sheet-list{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
.mr-folder-sheet-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--mr-border);border-radius:8px;background:var(--mr-paper);color:var(--mr-text);font-size:14px;text-align:left;cursor:pointer;transition:background .15s}
.mr-folder-sheet-item:hover{background:var(--mr-sunken)}
.mr-sort-select{min-height:32px;padding:0 8px;border:1px solid var(--mr-border);border-radius:6px;background:var(--mr-card);color:var(--mr-text);font-size:12px}
.mr-stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
/* 阅读热力图 */
.mr-heatmap{margin-top:20px}
.mr-heatmap h4{font-size:13px;font-weight:600;margin:0 0 12px;color:var(--mr-text)}
.mr-heatmap-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:3px;max-width:420px}
.mr-heatmap-cell{width:100%;aspect-ratio:1;border-radius:2px;background:var(--mr-sunken)}
.mr-heatmap-cell.level-0{background:var(--mr-sunken)}
.mr-heatmap-cell.level-1{background:#ebedf0}
.mr-heatmap-cell.level-2{background:#9be9a8}
.mr-heatmap-cell.level-3{background:#40c463}
.mr-heatmap-cell.level-4{background:#30a14e}
.mr-heatmap-legend{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11px;color:var(--mr-muted)}
.mr-heatmap-legend .mr-heatmap-cell{width:12px;height:12px}
/* 年度统计 */
.mr-yearly-stats{margin-top:20px}
.mr-yearly-stats h4{font-size:13px;font-weight:600;margin:0 0 12px;color:var(--mr-text)}
.mr-yearly-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.mr-yearly-item{text-align:center;padding:16px 12px;background:var(--mr-paper);border:1px solid var(--mr-border);border-radius:8px}
.mr-yearly-item strong{display:block;font-size:28px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--mr-accent)}
.mr-yearly-item span{font-size:11px;color:var(--mr-muted);margin-top:4px}
/* 阅读时长分布 */
.mr-duration-dist{margin-top:20px}
.mr-duration-dist h4{font-size:13px;font-weight:600;margin:0 0 12px;color:var(--mr-text)}
.mr-dist-bars{display:flex;flex-direction:column;gap:8px}
.mr-dist-row{display:flex;align-items:center;gap:12px}
.mr-dist-label{width:80px;font-size:12px;color:var(--mr-body);text-align:right}
.mr-dist-bar{flex:1;height:24px;background:var(--mr-sunken);border-radius:4px;overflow:hidden}
.mr-dist-fill{height:100%;background:var(--mr-accent);border-radius:4px;transition:width .3s}
.mr-dist-count{width:50px;font-size:12px;color:var(--mr-muted)}
/* 阅读时段分析 */
.mr-time-dist{margin-top:20px}
.mr-time-dist h4{font-size:13px;font-weight:600;margin:0 0 12px;color:var(--mr-text)}
.mr-time-grid{display:flex;align-items:flex-end;gap:2px;height:80px}
.mr-time-cell{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%}
.mr-time-bar{width:100%;background:var(--mr-accent);border-radius:2px;min-height:4px}
.mr-time-label{font-size:10px;color:var(--mr-muted)}
/* 阅读趋势 */
.mr-trend-chart{margin-top:20px}
.mr-trend-chart h4{font-size:13px;font-weight:600;margin:0 0 12px;color:var(--mr-text)}
.mr-trend-bars{display:flex;align-items:flex-end;gap:2px;height:100px}
.mr-trend-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%}
.mr-trend-bar{width:100%;background:var(--mr-accent);border-radius:2px;min-height:2px;opacity:.85}
.mr-trend-label{font-size:9px;color:var(--mr-muted)}
.mr-stat-card{display:flex;flex-direction:column;align-items:center;padding:16px;border:1px solid var(--mr-border);border-radius:10px;background:var(--mr-sunken)}
.mr-stat-card strong{font-size:28px;font-weight:600;color:var(--mr-accent)}
.mr-stat-card span{font-size:12px;color:var(--mr-muted);margin-top:4px}
.mr-share-backdrop{position:absolute;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);backdrop-filter:blur(4px)}
.mr-share-card{background:var(--mr-card);border:1px solid var(--mr-border);border-radius:16px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.25);text-align:center}
.mr-share-card h3{margin:0 0 16px;font-size:18px;color:var(--mr-text)}
.mr-share-canvas{width:300px;height:400px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.15)}
.mr-share-actions{display:flex;gap:10px;justify-content:center;margin-top:16px}
.mr-shelf-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;border:1px dashed var(--mr-border);border-radius:8px;background:color-mix(in srgb,var(--mr-card) 55%,transparent)}
.mr-shelf-empty-icon{width:48px;height:48px;border-radius:50%;background:var(--mr-sunken);display:flex;align-items:center;justify-content:center;margin-bottom:12px;color:var(--mr-accent)}
.mr-shelf-empty h3{color:var(--mr-text);font:400 18px/1.3 var(--mr-serif);margin:0 0 6px}
.mr-shelf-empty p{font-size:13px;color:var(--mr-muted);margin:0;line-height:1.7}
.mr-shelf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:22px 16px;align-content:center}
.mr-shelf.mr-reduced .mr-shelf-cover{transition:none}
.mr-shelf.mr-reduced .mr-shelf-piece{animation:none;opacity:1}
@media (max-width:720px){.mr-shelf-gallery{grid-template-columns:1fr;gap:20px}.mr-shelf-hero-cover{width:100%}.mr-shelf-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 12px}.mr-shelf-head{flex-wrap:wrap;align-items:flex-start}.mr-shelf-head-actions{width:100%;justify-content:space-between}.mr-shelf-topbar{flex-wrap:wrap;gap:10px}.mr-shelf-search{flex:1;min-width:0}.mr-shelf-search input{width:100%}.mr-shelf-status span:last-child{display:none}}
@media (prefers-reduced-motion:reduce){.mr-shelf-piece{animation:none;opacity:1}.mr-shelf-cover{transition:none}.mr-shelf-piece:hover .mr-shelf-cover,.mr-shelf-piece:active .mr-shelf-cover{transform:none}}
.mr-shelf{container-type:inline-size}
@container (max-width:900px){.mr-shelf-gallery{grid-template-columns:280px 1fr}.mr-shelf-hero-cover{width:280px}}
@container (max-width:760px){.mr-shelf-gallery{grid-template-columns:260px 1fr}.mr-shelf-hero-cover{width:260px}}
@container (max-width:640px){.mr-shelf-gallery{grid-template-columns:1fr;gap:20px}.mr-shelf-hero{position:relative;flex-direction:row;align-items:flex-start;gap:16px}.mr-shelf-hero-cover{width:120px}.mr-shelf-hero-cover .mr-shelf-fallback-title{font-size:15px;white-space:normal;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;max-width:100%}.mr-shelf-hero-title{font-size:20px}.mr-shelf-hero-by{font-size:11px}.mr-shelf-cta{height:36px;min-height:36px;font-size:13px;padding:0 14px}.mr-shelf-progress{margin-top:10px}.mr-shelf-progress-label{font-size:10px}.mr-shelf-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 12px;align-content:start}}
.mr-button{min-height:40px;padding:0 16px;border:1px solid var(--mr-border);border-radius:8px;background:var(--mr-card);color:var(--mr-text);display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:13px;font-weight:500;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.04);transition:background .15s,border-color .15s,transform .15s}.mr-button:hover:not(:disabled){border-color:color-mix(in srgb,var(--mr-text) 22%,var(--mr-border));background:var(--mr-sunken)}.mr-button.primary{background:var(--mr-accent);border-color:var(--mr-accent);color:var(--mr-on-accent);box-shadow:0 1px 2px rgba(0,0,0,.12)}.mr-button.primary:hover:not(:disabled){background:var(--mr-accent-hover);border-color:var(--mr-accent-hover)}.mr-button.soft{background:color-mix(in srgb,var(--mr-accent) 10%,var(--mr-card));border-color:color-mix(in srgb,var(--mr-accent) 30%,var(--mr-border));color:var(--mr-accent)}.mr-button.soft:hover:not(:disabled){background:color-mix(in srgb,var(--mr-accent) 16%,var(--mr-card))}.mr-button.text{min-height:32px;border-color:transparent;background:transparent;color:var(--mr-muted);padding-inline:8px;box-shadow:none}.mr-button.text:hover:not(:disabled){background:var(--mr-sunken);color:var(--mr-text);border-color:transparent}.mr-button.danger{color:var(--dsw-alias-state-error-primary)}.mr-button.icon{width:40px;height:40px;min-height:40px;padding:0;border-color:transparent;background:transparent;color:inherit;box-shadow:none}.mr-button.icon:hover:not(:disabled){background:var(--mr-sunken)}.mr-button:focus-visible{outline:2px solid var(--mr-accent);outline-offset:2px}.mr-button:active:not(:disabled){transform:translateY(1px)}
.mr-book-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(225px,1fr));gap:16px}.mr-book-card{position:relative;border:1px solid var(--mr-border);background:var(--mr-card);border-radius:12px;overflow:hidden;box-shadow:var(--mr-shadow);transition:border-color .15s,transform .15s}.mr-book-card:hover{border-color:color-mix(in srgb,var(--mr-accent) 45%,var(--mr-border));transform:translateY(-1px)}.mr-book-open{border:0;background:transparent;color:inherit;width:100%;padding:18px 16px 12px;display:flex;gap:14px;text-align:left;min-width:0}.mr-book-info{min-width:0;flex:1}.mr-book-title-row{display:flex;gap:6px;align-items:flex-start}.mr-book-info h3{font:400 15px/1.45 var(--mr-serif);margin:1px 0 8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.mr-book-info p,.mr-book-info small{margin:0;color:var(--mr-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}.mr-book-info p{font-size:12px}.mr-book-info small{font-size:11px;margin-top:12px}.mr-badge{flex:0 0 auto;background:var(--mr-accent);color:var(--mr-on-accent);font-size:10px;padding:2px 6px;border-radius:10px}.mr-book-actions{display:flex;justify-content:space-between;border-top:1px solid var(--mr-border);padding:3px 8px}
.mr-cover{position:relative;flex:0 0 66px;width:66px;height:94px;border-radius:6px;background:linear-gradient(145deg,color-mix(in srgb,var(--mr-accent) 35%,var(--dsw-alias-bg-layer-2)),var(--dsw-alias-bg-layer-2));box-shadow:0 4px 12px #0002;overflow:hidden;display:flex;align-items:center;justify-content:center}.mr-cover.small{width:52px;height:74px;flex-basis:52px}.mr-cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1}.mr-cover>span{font-family:serif;font-size:28px;color:var(--mr-accent);opacity:.65}
.mr-empty{text-align:center;padding:70px 20px;color:var(--mr-muted)}.mr-empty-icon{width:58px;height:58px;border-radius:18px;background:var(--mr-sunken);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;color:var(--mr-accent)}.mr-empty h3{color:var(--mr-text);font:400 18px/1.3 var(--mr-serif);margin:0 0 8px}.mr-empty p{font-size:13px;margin:0;line-height:1.7}
.mr-searchbar{display:flex;gap:10px;margin-bottom:22px}.mr-searchbar select{max-width:190px}.mr-root input,.mr-root textarea,.mr-root select,.mr-reader input,.mr-reader textarea,.mr-reader select{border:1px solid var(--mr-border);border-radius:8px;background:var(--dsw-specific-input-major,var(--mr-sunken));color:var(--mr-text);padding:9px 12px;outline:none}.mr-root input:focus,.mr-root textarea:focus,.mr-root select:focus,.mr-reader textarea:focus{border-color:var(--mr-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--mr-accent) 18%,transparent)}.mr-reader input,.mr-reader textarea,.mr-reader select{background:var(--mr-sunken)}.mr-root input[type=range]{padding:0;min-height:24px}.mr-searchbar input{flex:1;min-width:0}.mr-searchbar select{min-width:130px}.mr-results{display:flex;flex-direction:column;gap:10px}.mr-result{display:flex;align-items:center;gap:15px;padding:14px;border:1px solid var(--mr-border);border-radius:12px;background:var(--mr-card);box-shadow:var(--mr-shadow)}.mr-result-info{flex:1;min-width:0}.mr-result-info h3{font:400 15px/1.45 var(--mr-serif);margin:0 0 5px}.mr-result-info p{font-size:12px;color:var(--mr-muted);margin:0}.mr-result-info .mr-intro{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:7px;line-height:1.5}
.mr-panel{border:1px solid var(--mr-border);border-radius:12px;background:var(--mr-card);box-shadow:var(--mr-shadow);padding:20px;margin-bottom:16px}.mr-panel h3{font:400 18px/1.35 var(--mr-serif);margin:0 0 14px}.mr-panel textarea{width:100%;resize:vertical;line-height:1.6}.mr-help{font-size:12px;color:var(--mr-muted);line-height:1.6}.mr-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--mr-muted);margin-top:12px}.mr-check input{width:16px;height:16px;padding:0}.mr-inline-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:12px}.mr-source-list{display:flex;flex-direction:column;gap:9px}.mr-source-row{display:flex;align-items:center;gap:12px;padding:13px 15px;border:1px solid var(--mr-border);border-radius:11px;background:var(--mr-card)}.mr-source-row>div:nth-child(2){flex:1;min-width:0}.mr-source-row h3{font:400 15px/1.4 var(--mr-serif);margin:0 0 4px}.mr-source-row p{font-size:11px;color:var(--mr-muted);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mr-source-mark{color:var(--mr-accent)}.mr-tag{font-size:10px;border:1px solid var(--mr-border);padding:3px 7px;border-radius:10px;color:var(--mr-muted);white-space:nowrap}
.mr-setting-row{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:15px 0;font-size:13px}.mr-stepper{display:flex;align-items:center;gap:12px}.mr-stepper strong{min-width:42px;text-align:center}.mr-setting-row input[type=range],.mr-drawer input[type=range]{accent-color:var(--mr-accent,var(--reader-accent));height:20px}.mr-mode-picker{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--mr-border);border-radius:8px;background:transparent}.mr-mode-choice{min-height:32px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--mr-muted);font-size:12px;white-space:nowrap}.mr-mode-choice:hover{color:var(--mr-text)}.mr-mode-choice.active{background:color-mix(in srgb,var(--mr-accent) 14%,var(--mr-paper));color:var(--mr-accent);font-weight:600;box-shadow:none}.mr-theme-picker{display:flex;gap:10px}.mr-swatch{width:34px;height:34px;border-radius:50%;border:2px solid transparent;box-shadow:0 0 0 1px var(--mr-border)}.mr-swatch.active{border-color:var(--mr-accent);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1),0 0 0 4px var(--mr-accent)}.mr-swatch.paper{background:#f4ecdc}.mr-swatch.light{background:#fff}.mr-swatch.green{background:#e3eee5}.mr-swatch.dark{background:#202522}.mr-roadmap p{color:var(--mr-muted);font-size:12px;line-height:1.7;margin:0}
.mr-notice{position:sticky;top:-20px;z-index:20;margin:-12px auto 16px;max-width:760px;padding:11px 13px;border-radius:10px;background:var(--mr-card);border:1px solid var(--mr-border);box-shadow:var(--mr-shadow);display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px}.mr-notice.error{border-color:var(--dsw-alias-state-error-primary)}.mr-notice.success{border-color:var(--dsw-alias-state-success-primary)}.mr-notice button{border:0;background:transparent;color:inherit;padding:4px;display:flex}.mr-loading{text-align:center;color:var(--mr-muted);font-size:13px;padding:36px}.mr-error-block{text-align:center;padding:50px 20px;color:var(--dsw-alias-state-error-primary)}
.mr-reader>.mr-notice{position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:60;margin:0;max-width:min(560px,calc(100% - 32px));width:max-content}
.mr-reader{--reader-bg:#f6f1e6;--reader-text:#2b261e;--reader-muted:#867b68;--reader-border:#e2d8c4;--reader-accent:#9a3b2b;--reader-card:#fbf7ee;--mr-card:var(--reader-bg);--mr-sunken:color-mix(in srgb,var(--reader-text) 6%,var(--reader-bg));--mr-border:var(--reader-border);--mr-text:var(--reader-text);--mr-muted:var(--reader-muted);--mr-accent:var(--reader-accent);--mr-accent-hover:color-mix(in srgb,var(--reader-accent) 84%,#000);--mr-on-accent:var(--reader-bg);height:100%;min-height:0;display:flex;flex-direction:column;position:relative;overflow:hidden;background:var(--reader-bg);color:var(--reader-text)}
.mr-reader.theme-light{--reader-bg:#fdfcf9;--reader-text:#24282a;--reader-muted:#7b817e;--reader-border:#e5e4de;--reader-card:#ffffff}
.mr-reader.theme-green{--reader-bg:#e9f0e9;--reader-text:#2c3a30;--reader-muted:#6f8174;--reader-border:#cfdcce;--reader-accent:#4d6350;--reader-card:#f6faf5}
.mr-reader.theme-dark{--reader-bg:#1d2220;--reader-text:#d7dcd8;--reader-muted:#8a938d;--reader-border:#39433c;--reader-accent:#c98169;--reader-card:#242b27}
.mr-rail{position:absolute;left:0;right:0;top:0;height:2px;z-index:6;pointer-events:none;background:color-mix(in srgb,var(--reader-text) 7%,transparent)}
.mr-rail i{display:block;height:100%;background:var(--reader-accent);opacity:.7;transition:width .28s ease}
.mr-tools{position:absolute;right:14px;top:50%;transform:translateY(-50%);z-index:7;display:flex;flex-direction:column;gap:2px}
.mr-tool-btn{display:flex;flex-direction:column;align-items:center;gap:4px;width:54px;padding:8px 0 7px;border:1px solid transparent;border-radius:10px;background:none;color:var(--reader-muted);font:400 11px/1 'Noto Serif CJK SC',Georgia,serif;letter-spacing:.04em;transition:background .15s ease,color .15s ease,border-color .15s ease}
.mr-tool-btn:hover:not(:disabled){background:color-mix(in srgb,var(--reader-text) 5%,transparent);border-color:color-mix(in srgb,var(--reader-text) 10%,transparent);color:var(--reader-text)}
.mr-tool-btn svg{display:block}
.mr-tools hr{width:22px;height:1px;margin:5px auto;border:0;background:color-mix(in srgb,var(--reader-text) 12%,transparent)}
.mr-folio{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);z-index:3;font:400 11px/1 'Noto Serif CJK SC',Georgia,serif;letter-spacing:.24em;color:var(--reader-muted);pointer-events:none;font-variant-numeric:tabular-nums}
.mr-reader-top{display:none}.mr-tabbar{display:none}
.mr-chapter-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;position:relative;z-index:2;overflow-anchor:none}
.mr-paged-view{flex:1;min-height:0;overflow:hidden;position:relative;z-index:2;touch-action:pan-y}
.mr-page-window{position:relative;width:min(var(--mr-text,672px),calc(100% - 56px));height:100%;margin:0 auto;overflow:hidden}
.mr-chapter{width:min(var(--mr-text,672px),calc(100% - 56px));margin:0 auto;padding:76px 0 96px;font-family:'Noto Serif CJK SC',Georgia,'Noto Serif SC','Songti SC',SimSun,serif}
.font-sans .mr-chapter{font-family:system-ui,'Noto Sans SC','PingFang SC',sans-serif}
.mr-chapter.mr-paged-chapter{width:100%;height:100%;margin:0;padding:68px 0 74px;box-sizing:border-box;column-fill:auto;will-change:transform;transition:transform .18s ease-out}
.mr-paged-chapter.mr-dragging{transition:none;user-select:none;cursor:grabbing}
.mr-paged-chapter.mr-turning{transition:none}
.mr-paged-chapter.mr-fade-in{animation:mr-page-fade .24s ease both}
@keyframes mr-page-fade{from{opacity:.2}to{opacity:1}}
.mr-turn-host{contain:layout paint}
.mr-turn-shade{position:absolute;inset:0;pointer-events:none;opacity:0;background:linear-gradient(90deg,rgba(0,0,0,.04),rgba(0,0,0,.22) 60%,rgba(0,0,0,.45))}
@media (prefers-reduced-motion:reduce){.mr-chapter-veil{animation-duration:.3s}.mr-paged-chapter{transition:none}}
.mr-reader.mr-reduced .mr-paged-chapter{transition:none}
.mr-reader.mr-reduced .mr-chapter-veil{animation-duration:.3s}
.mr-reader.mr-reduced .mr-paged-chapter.mr-fade-in{animation:none}
.mr-chapter-open{padding:0 0 8px;break-inside:avoid}
.mr-chapter-no{font-size:12px;line-height:1.6;letter-spacing:.52em;text-indent:.52em;color:var(--reader-accent);opacity:.92}
.mr-chapter-title{font-size:30px;line-height:1.45;font-weight:600;margin:16px 0 0;letter-spacing:.01em}
.mr-chapter-meta{display:flex;align-items:center;gap:12px;margin:22px 0 34px;font-size:12px;letter-spacing:.08em;color:var(--reader-muted)}
.mr-chapter-meta i{display:block;width:28px;height:1px;background:var(--reader-accent);opacity:.5}
.mr-chapter p{margin:0 0 .82em;text-align:justify;text-justify:inter-ideograph;overflow-wrap:anywhere;letter-spacing:.012em}
.mr-chapter-end{display:flex;align-items:center;justify-content:center;gap:14px;padding:34px 0 6px;color:var(--reader-muted);font-size:12px}
.mr-chapter-scroll .mr-chapter{padding:36px 0 28px}
.mr-chapter-scroll .mr-chapter + .mr-chapter{margin-top:24px}
.mr-scroll-retry{display:flex;flex-direction:column;align-items:center;gap:12px;padding:40px 0 80px;color:var(--reader-muted);font-size:13px}
.mr-scroll-retry p{margin:0}
.mr-scroll-retry .mr-button{min-height:0;padding:4px 0;border:0;background:none;color:var(--reader-accent);font-size:13px;letter-spacing:.12em}
.mr-scroll-retry .mr-button:hover:not(:disabled){background:none;text-decoration:underline;text-underline-offset:4px}
.mr-chapter-end .mr-button{min-height:0;padding:0;border:0;background:none;color:var(--reader-accent);font-size:12px;letter-spacing:.14em;box-shadow:none}
.mr-chapter-end .mr-button:hover:not(:disabled){background:none;color:var(--reader-accent);text-decoration:underline;text-underline-offset:4px}
.mr-chapter-veil{position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);z-index:6;pointer-events:none;padding:9px 16px;border-radius:999px;background:color-mix(in srgb,var(--reader-bg) 86%,transparent);color:var(--reader-muted);font-size:13px;letter-spacing:.08em;box-shadow:0 10px 26px color-mix(in srgb,var(--reader-text) 12%,transparent);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);animation:mr-veil-in 1.05s ease both}
.mr-chapter-veil.show{opacity:1}
@keyframes mr-veil-in{0%{opacity:0;transform:translate(-50%,-42%)}18%,70%{opacity:1;transform:translate(-50%,-50%)}100%{opacity:0;transform:translate(-50%,-54%)}}
.mr-drawer-backdrop{position:absolute;inset:0;z-index:8;background:color-mix(in srgb,var(--reader-text) 14%,transparent)}
.mr-drawer{position:absolute;top:0;right:0;bottom:0;width:min(368px,90%);z-index:9;display:flex;flex-direction:column;background:var(--reader-bg);border-left:1px solid color-mix(in srgb,var(--reader-text) 12%,transparent);box-shadow:-20px 0 44px color-mix(in srgb,var(--reader-text) 12%,transparent)}
.mr-drawer-head{height:52px;flex:0 0 52px;padding:0 8px 0 22px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid color-mix(in srgb,var(--reader-text) 10%,transparent)}
.mr-drawer-head h2{font-size:14px;font-weight:600;letter-spacing:.22em;text-indent:.22em;color:var(--reader-text)}
.mr-toc{overflow-y:auto;overscroll-behavior:contain;padding:6px 0 24px}
.mr-toc button{position:relative;display:block;width:100%;min-height:44px;padding:11px 22px;border:0;border-radius:0;background:transparent;color:var(--reader-text);font-size:13px;line-height:1.55;text-align:left;opacity:.74;transition:background .15s ease,opacity .15s ease}
.mr-toc button:hover{background:color-mix(in srgb,var(--reader-text) 5%,transparent);opacity:1}
.mr-toc button.active{color:var(--reader-accent);font-weight:600;opacity:1}
.mr-toc button.active::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:2px;background:var(--reader-accent)}
.mr-drawer-body{padding:6px 22px 28px;overflow-y:auto;overscroll-behavior:contain}
.mr-drawer-body>label{display:block;font-size:12px;letter-spacing:.13em;color:var(--reader-muted);margin:24px 0 10px}
.mr-drawer-body>label:first-child{margin-top:8px}
.mr-drawer-left{left:0;right:auto;border-left:0;border-right:1px solid color-mix(in srgb,var(--reader-text) 12%,transparent);box-shadow:20px 0 44px color-mix(in srgb,var(--reader-text) 12%,transparent)}
.mr-drawer-count{margin-left:auto;margin-right:10px;font-size:12px;letter-spacing:.06em;color:var(--reader-muted)}
.mr-backdrop-soft{background:color-mix(in srgb,var(--reader-text) 16%,transparent);-webkit-backdrop-filter:none;backdrop-filter:none}
.mr-modal-backdrop{position:absolute;inset:0;z-index:9;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--reader-text) 30%,transparent);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}
.mr-modal{width:min(480px,100%);max-height:100%;display:flex;flex-direction:column;background:var(--reader-card);border:1px solid color-mix(in srgb,var(--reader-text) 10%,transparent);border-radius:14px;box-shadow:0 30px 80px color-mix(in srgb,var(--reader-text) 26%,transparent);overflow:hidden}
.mr-modal-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px 6px}
.mr-modal-head h2{margin:0;font-size:14px;font-weight:600;letter-spacing:.2em;text-indent:.2em;color:var(--reader-text)}
.mr-modal-close{width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:8px;background:none;color:var(--reader-muted)}
.mr-modal-close:hover{background:color-mix(in srgb,var(--reader-text) 7%,transparent);color:var(--reader-text)}
.mr-modal-body{padding:4px 22px 22px;overflow-y:auto;overscroll-behavior:contain}
.mr-set-row{display:flex;align-items:center;gap:14px;padding:9px 0}
.mr-set-label{flex:none;width:64px;font-size:12px;letter-spacing:.08em;color:var(--reader-muted)}
.mr-set-control{flex:1;min-width:0;display:flex;align-items:center;gap:10px}
.mr-seg{display:flex;flex-wrap:wrap;gap:8px}
.mr-seg-btn{min-height:30px;padding:0 14px;border:1px solid color-mix(in srgb,var(--reader-text) 14%,transparent);border-radius:8px;background:none;color:var(--reader-text);font-size:13px;line-height:1}
.mr-seg-btn:hover{border-color:color-mix(in srgb,var(--reader-text) 30%,transparent)}
.mr-seg-btn.active{border-color:var(--reader-accent);color:var(--reader-accent);background:color-mix(in srgb,var(--reader-accent) 6%,transparent)}
.mr-stepper{display:flex;align-items:center;border:1px solid color-mix(in srgb,var(--reader-text) 14%,transparent);border-radius:8px;overflow:hidden}
.mr-step-btn{min-height:30px;padding:0 14px;border:0;background:none;color:var(--reader-text);font-size:13px}
.mr-step-btn:hover{background:color-mix(in srgb,var(--reader-text) 6%,transparent)}
.mr-stepper strong{min-width:52px;text-align:center;font-size:14px;font-weight:600}
.mr-swatches{display:flex;gap:10px}
.mr-swatches .mr-swatch{width:26px;height:26px;border:1px solid color-mix(in srgb,var(--reader-text) 16%,transparent);border-radius:50%;box-shadow:none}
.mr-swatches .mr-swatch.active{outline:1px solid var(--reader-accent);outline-offset:3px;border-color:transparent}
.mr-range{display:flex;align-items:center;gap:12px;flex:1}
.mr-range input[type=range]{-webkit-appearance:none;appearance:none;flex:1;height:22px;margin:0;background:transparent;accent-color:var(--reader-accent)}
.mr-range input[type=range]::-webkit-slider-runnable-track{height:2px;border-radius:2px;background:color-mix(in srgb,var(--reader-text) 16%,transparent)}
.mr-range input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;margin-top:-5px;border:0;border-radius:50%;background:var(--reader-accent)}
.mr-range input[type=range]::-moz-range-track{height:2px;border-radius:2px;background:color-mix(in srgb,var(--reader-text) 16%,transparent)}
.mr-range input[type=range]::-moz-range-thumb{width:12px;height:12px;border:0;border-radius:50%;background:var(--reader-accent)}
.mr-range-val{min-width:36px;text-align:right;font-size:12px;color:var(--reader-muted);font-variant-numeric:tabular-nums}
.mr-note-editor textarea{width:100%;min-height:96px;padding:6px 0;border:0;border-bottom:1px solid color-mix(in srgb,var(--reader-text) 14%,transparent);border-radius:0;background:transparent;color:var(--reader-text);font-size:14px;line-height:1.8;resize:vertical}
.mr-drawer .mr-note-editor .mr-button{min-height:30px;margin-top:14px;padding:0 2px;border:0;background:none;box-shadow:none;color:var(--reader-accent);font-size:13px;letter-spacing:.12em}.mr-drawer .mr-note-editor .mr-button:hover:not(:disabled){background:none;color:var(--reader-accent);text-decoration:underline;text-underline-offset:4px}.mr-drawer .mr-note-editor .mr-button:disabled{background:none;border-color:transparent;color:var(--reader-muted);box-shadow:none;opacity:.55}.mr-drawer .mr-note-editor textarea:focus{outline:none;box-shadow:none;border-bottom-color:var(--reader-accent)}
.mr-drawer .mr-button.primary{background:var(--reader-accent);border-color:var(--reader-accent);color:var(--reader-bg)}
.mr-notes{margin-top:24px}
.mr-notes article{border-top:1px solid color-mix(in srgb,var(--reader-text) 12%,transparent);padding:14px 0;font-size:13px}
.mr-notes blockquote,.mr-drawer-body>blockquote{margin:0 0 12px;padding:8px 12px;border-left:2px solid color-mix(in srgb,var(--reader-accent) 55%,transparent);color:var(--reader-muted);font-size:12px;line-height:1.7;overflow-wrap:anywhere}
.mr-notes p{line-height:1.7;white-space:pre-wrap}
.mr-open-shift{position:fixed;z-index:80;overflow:hidden;pointer-events:none;contain:layout paint}
.mr-open-veil{position:absolute;inset:0;opacity:.96;animation:mr-open-veil .46s ease-out both}
@keyframes mr-open-veil{0%{opacity:.96}40%{opacity:1}100%{opacity:0}}
.mr-open-cover{position:absolute;border-radius:5px;overflow:hidden;transform-origin:50% 50%;will-change:transform,opacity;box-shadow:0 24px 60px rgba(0,0,0,.34),0 5px 14px rgba(0,0,0,.22);background:#cbb99b}
.mr-open-cover img{display:block;width:100%;height:100%;object-fit:cover}
.mr-open-cover span{display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-family:Georgia,'Noto Serif SC',serif;font-size:24px;color:#4a3d2c;background:linear-gradient(150deg,#dfcfae,#bfa986)}
.mr-open-spine{position:absolute;left:0;top:0;bottom:0;width:5px;background:linear-gradient(90deg,rgba(0,0,0,.28),rgba(255,255,255,.12) 62%,transparent)}
.mr-ambience{position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none;contain:strict}.mr-ambience canvas{display:block;width:100%;height:100%}.mr-chapter-scroll,.mr-paged-view{position:relative;z-index:2}.mr-loading,.mr-error-block{position:relative;z-index:2}

  @media(max-width:880px){.mr-tools{display:none}.mr-tabbar{position:absolute;left:0;right:0;bottom:0;z-index:7;display:flex;align-items:center;justify-content:space-around;height:54px;background:var(--reader-bg);border-top:1px solid color-mix(in srgb,var(--reader-text) 10%,transparent)}.mr-tab-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;flex:1;height:100%;padding:0;border:0;background:none;color:var(--reader-muted);font:400 11px/1 'Noto Serif CJK SC',Georgia,serif;letter-spacing:.04em}.mr-tab-btn:hover:not(:disabled){color:var(--reader-text)}.mr-paged-view{padding-bottom:54px}.mr-folio{bottom:70px}.mr-page-window{width:min(var(--mr-text,672px),calc(100% - 40px))}}
@media(min-width:881px){.mr-page-window,.mr-chapter{width:min(var(--mr-text,672px),calc(100% - 200px))}}
@media(max-width:720px){
.mr-reader{position:fixed;inset:0;z-index:2147483000;width:100vw;height:100vh;height:100dvh;border-radius:0}
.mr-reader-top{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:calc(6px + env(safe-area-inset-top,0px)) 10px 6px;border-bottom:1px solid color-mix(in srgb,var(--reader-border) 72%,transparent);background:color-mix(in srgb,var(--reader-bg) 94%,transparent);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);z-index:9}
.mr-reader-top-btn{flex:none;width:38px;height:38px;display:flex;align-items:center;justify-content:center;border:0;border-radius:10px;background:transparent;color:var(--reader-muted)}
.mr-reader-top-btn:active{background:color-mix(in srgb,var(--reader-text) 7%,transparent)}
.mr-reader-top-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding:0 2px}
.mr-reader-top-copy strong,.mr-reader-top-copy span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mr-reader-top-copy strong{font:500 14px/1.3 var(--mr-serif);color:var(--reader-text)}
.mr-reader-top-copy span{font:400 10px/1.3 var(--mr-serif);color:var(--reader-muted)}
.mr-reader .mr-tabbar{padding-bottom:env(safe-area-inset-bottom,0px);height:calc(54px + env(safe-area-inset-bottom,0px))}
.mr-reader .mr-paged-view{padding-bottom:calc(54px + env(safe-area-inset-bottom,0px))}
.mr-shelf-search .kbd{display:none}.mr-root{flex-direction:column;padding-left:0}.mr-section-actions{width:100%;justify-content:space-between}.mr-reader{padding-left:0}.mr-page-window{width:calc(100% - 32px)}.mr-nav{width:100%;flex:0 0 58px;order:2;padding:0 8px;border-right:0;border-top:1px solid var(--mr-border)}.mr-brand,.mr-local{display:none}.mr-nav-items{height:100%;flex-direction:row;justify-content:space-around;gap:0;overflow:visible}.mr-nav-items button{min-width:0;min-height:56px;flex:1;flex-direction:column;justify-content:center;gap:2px;padding:3px 4px;font-size:10px;border-radius:8px}.mr-content{order:1;padding:20px 14px}.mr-section-head{flex-wrap:wrap;margin-bottom:18px}.mr-section-head h2{font-size:22px;white-space:nowrap}.mr-book-grid{grid-template-columns:1fr;gap:10px}.mr-book-open{padding:13px}.mr-book-actions{position:relative}.mr-searchbar{flex-wrap:wrap}.mr-searchbar select{max-width:none;width:100%}.mr-searchbar input{flex:1}.mr-result{align-items:flex-start;padding:12px;gap:10px}.mr-result .mr-button{align-self:center;padding-inline:9px}.mr-result-info .mr-intro{-webkit-line-clamp:1}.mr-source-row{flex-wrap:wrap}.mr-source-row .mr-tag{display:none}.mr-panel{padding:16px}.mr-notice{top:-12px}.mr-chapter{width:calc(100% - 40px);padding:64px 0 84px}.mr-chapter-title{font-size:25px}.mr-chapter-no{letter-spacing:.42em;text-indent:.42em}.mr-drawer{left:0;right:0;width:auto}.mr-chapter-meta{letter-spacing:.04em}.mr-modal{padding:0}.mr-set-label{width:56px}}
/* 平板适配（721-1024px） */
@media(min-width:721px) and (max-width:1024px){
  .mr-nav{width:140px;flex:0 0 140px;padding:20px 10px 14px}
  .mr-content{padding:20px 24px}
  .mr-content>div:not(.mr-notice):not(.mr-window-shelf){max-width:900px}
  .mr-chapter{width:min(var(--mr-text,672px),calc(100% - 160px))}
  .mr-tools{right:8px}
  .mr-tool-btn{width:48px;padding:6px 0}
  .mr-book-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .mr-drawer{width:320px}
}
/* 桌面端（1025px+） */
@media(min-width:1025px){
  .mr-nav{width:200px;flex:0 0 200px;padding:28px 18px 20px}
  .mr-content{padding:28px clamp(24px,4vw,56px)}
  .mr-content>div:not(.mr-notice):not(.mr-window-shelf){max-width:1280px}
  .mr-chapter{width:min(var(--mr-text,672px),calc(100% - 240px))}
  .mr-tools{right:20px}
  .mr-tool-btn{width:56px;padding:10px 0}
  .mr-book-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .mr-drawer{width:400px}
}
/* 横屏模式（高度<500px 且宽度>高度） */
@media(orientation:landscape) and (max-height:500px){
  .mr-root{flex-direction:row}
  .mr-nav{width:64px;flex:0 0 64px;padding:12px 8px;order:0}
  .mr-nav-items{flex-direction:column;gap:8px}
  .mr-nav-items button{min-height:44px;flex-direction:row;gap:6px;padding:8px;font-size:11px}
  .mr-brand,.mr-local{display:none}
  .mr-content{order:1;padding:16px 20px}
  .mr-reader{padding-left:0}
  .mr-tools{position:absolute;right:8px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:4px}
  .mr-tool-btn{width:40px;padding:6px 0;font-size:10px}
  .mr-tool-btn span{display:none}
  .mr-tabbar{display:none}
  .mr-chapter{padding:40px 0 60px;width:min(var(--mr-text,672px),calc(100% - 100px))}
  .mr-chapter-title{font-size:22px;margin-top:12px}
  .mr-chapter-no{font-size:11px;letter-spacing:.4em}
  .mr-chapter-meta{margin:16px 0 24px;font-size:11px}
  .mr-folio{bottom:12px;font-size:10px}
  .mr-paged-view{padding-bottom:0}
  .mr-page-window{width:calc(100% - 80px)}
  .mr-drawer{width:300px}
  .mr-modal{max-height:90vh}
}
/* 快捷键提示 */
.mr-shortcuts{display:flex;flex-direction:column;gap:8px;padding:16px;background:var(--reader-card);border:1px solid var(--reader-border);border-radius:10px;font-size:12px}
.mr-shortcuts kbd{display:inline-block;padding:2px 6px;background:var(--reader-bg);border:1px solid var(--reader-border);border-radius:4px;font-family:monospace;font-size:11px}
.mr-shortcuts-row{display:flex;justify-content:space-between;align-items:center}
.mr-shortcuts-row span{color:var(--reader-muted)}
/* 阅读页精修：动效与细节 */.mr-chapter p{transition:opacity .2s ease}
.mr-chapter p:first-of-type::first-letter{font-size:2.1em;line-height:1;float:left;margin:0.08em 0.1em 0 0;font-weight:500;color:var(--reader-accent)}
.mr-chapter p:hover{opacity:.95}
.mr-folio{transition:opacity .3s ease,transform .3s ease}
.mr-folio:hover{opacity:.7;transform:translateX(-50%) scale(1.05)}
.mr-tool-btn{transition:all .2s cubic-bezier(.4,0,.2,1)}
.mr-tool-btn:active{transform:scale(.92)}
.mr-tool-btn svg{transition:transform .2s ease}
.mr-tool-btn:hover svg{transform:translateY(-1px)}
.mr-chapter-title{transition:letter-spacing .3s ease}
.mr-chapter:hover .mr-chapter-title{letter-spacing:.02em}
.mr-chapter-meta{transition:opacity .3s ease}
.mr-chapter:hover .mr-chapter-meta{opacity:.8}
.mr-chapter-end .mr-button{transition:all .2s ease}
.mr-chapter-end .mr-button:hover{letter-spacing:.18em}
.mr-chapter-scroll{scroll-behavior:smooth}
.mr-reader.mr-reduced .mr-chapter-scroll{scroll-behavior:auto}
.mr-chapter p::selection{background:color-mix(in srgb,var(--reader-accent) 20%,transparent);color:var(--reader-text)}
.mr-chapter-title::selection{background:color-mix(in srgb,var(--reader-accent) 30%,transparent)}
.mr-tab-btn{transition:all .2s ease}
.mr-tab-btn:active{transform:scale(.9)}
.mr-page-window{transition:transform .2s ease-out}
.mr-paged-chapter{transition:transform .18s cubic-bezier(.4,0,.2,1)}
.mr-chapter-veil{animation:mr-veil-in 1.05s cubic-bezier(.4,0,.2,1) both}
@keyframes mr-fade-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.mr-chapter{animation:mr-fade-in .4s ease-out}
.mr-reader.mr-reduced .mr-chapter{animation:none}
@media (prefers-reduced-motion:reduce){.mr-chapter p,.mr-folio,.mr-tool-btn,.mr-chapter-title,.mr-chapter-meta,.mr-chapter-end .mr-button,.mr-tab-btn{transition:none}.mr-chapter{animation:none}}
/* 多媒体内容 */
.mr-comic-page{margin:0 auto 16px;text-align:center;max-width:100%}
.mr-comic-page img{max-width:100%;height:auto;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
.mr-audio-player{padding:24px;background:var(--reader-card);border-radius:12px;border:1px solid var(--reader-border);margin:16px 0}
.mr-audio-player audio{width:100%;margin-bottom:12px}
.mr-audio-title{font-size:14px;color:var(--reader-muted);text-align:center;margin:0}
.mr-video-embed{position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:12px;margin:16px 0;background:#000}
.mr-video-embed iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:0}
.mr-video-player{margin:16px 0;border-radius:12px;overflow:hidden}
.mr-video-player video{width:100%;display:block}
/* AI 助手 */
.mr-ai-actions{display:flex;gap:10px;margin-bottom:20px}
.mr-ai-actions .mr-button{flex:1}
.mr-ai-ask{display:flex;flex-direction:column;gap:10px;margin-bottom:20px}
.mr-ai-ask textarea{resize:vertical;min-height:80px}
.mr-ai-result{background:var(--reader-card);border:1px solid var(--reader-border);border-radius:10px;padding:14px;animation:mr-fade-in .3s ease}
.mr-ai-result-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;font-size:12px;color:var(--reader-muted);letter-spacing:.1em}
.mr-ai-result p{margin:0;font-size:14px;line-height:1.8;white-space:pre-wrap}
/* 窗边书架：共用外壳与真实数据分页。 */
.mr-root{--mr-accent:#6b4a2d;--mr-accent-hover:#543921;--mr-on-accent:#fffaf0;--mr-paper:#f6f0e1;--mr-card:#fbf7ec;--mr-sunken:#e9e1d0;--mr-text:#29261f;--mr-body:#29261f;--mr-muted:#766e60;--mr-border:#d5ccb8;--mr-line:#d5ccb8;--mr-ink:#211c16;background:var(--mr-paper)}
.mr-nav{width:108px;flex:0 0 108px;padding:18px 10px 14px;border-right:1px solid var(--mr-border);background:#e7e0cf}
.mr-brand{justify-content:center;padding:0 0 22px}.mr-brand>div{display:none}.mr-brand svg{width:26px;height:26px;color:var(--mr-accent)}
.mr-nav-items{gap:8px;min-height:0;overflow-y:auto;scrollbar-width:none}.mr-nav-items::-webkit-scrollbar{display:none}.mr-nav-items button{min-height:58px;flex-direction:column;justify-content:center;gap:5px;padding:6px 0;border-left:0;border-radius:11px;font-size:11px;text-align:center}.mr-nav-items button svg{width:22px;height:22px}.mr-nav-items button.active{border-left:0;background:#f6f0e1;color:var(--mr-accent)}
.mr-local{justify-content:center;padding:10px 0;font-size:0}.mr-content{background:var(--mr-paper)}
.mr-content>.mr-window-shelf{max-width:none;height:100%;min-height:0}
.mr-window-shelf{display:flex;flex-direction:column;gap:0;min-height:0;color:var(--mr-text)}
.mr-window-shelf .mr-shelf-topbar{flex:0 0 auto;min-height:28px;padding:0;margin:0 0 10px}
.mr-window-shelf .mr-shelf-head{flex:0 0 auto;align-items:center;margin:0 0 14px;gap:14px}.mr-window-shelf .mr-shelf-head h1{font-size:30px}.mr-window-shelf .mr-shelf-head .kicker{margin-bottom:5px}
.mr-window-shelf .mr-shelf-head-actions{justify-content:flex-end;gap:8px}.mr-window-shelf .mr-shelf-head-actions .mr-button{background:transparent}.mr-window-shelf .mr-sort-select{background:transparent;border-color:transparent;min-height:36px}
.mr-window-shelf .mr-shelf-search{height:38px;border-radius:10px;background:var(--mr-paper)}.mr-window-shelf .mr-shelf-search input{width:min(220px,24vw);background:var(--mr-paper)}
.mr-window-shelf .mr-shelf-folder-bar{flex:0 0 auto;padding:0 0 10px;gap:6px}.mr-window-shelf .mr-folder-chip{background:transparent;min-height:28px}.mr-window-shelf .mr-folder-chip.active{background:var(--mr-accent)}
.mr-window-shelf .mr-select-bar{flex:0 0 auto}
.mr-window-shelf .mr-shelf-gallery{display:flex;flex-direction:column;gap:16px;flex:1 1 auto;align-items:stretch;min-height:0}.mr-window-shelf.mr-no-hero .mr-shelf-gallery{grid-template-columns:minmax(0,1fr)}
.mr-window-shelf .mr-shelf-hero{flex:0 0 auto;display:grid;grid-template-columns:110px minmax(0,1fr);align-items:center;gap:18px;min-width:0;padding:16px;border:1px solid var(--mr-border);border-radius:4px;background:#eee6d4;overflow:hidden}
.mr-window-shelf .mr-shelf-hero-cover{width:110px;max-width:110px;justify-self:center}.mr-window-shelf .mr-shelf-hero-cover .mr-shelf-cover{aspect-ratio:3/4}.mr-window-shelf .mr-shelf-hero-info{align-self:center}.mr-window-shelf .mr-shelf-hero-title{font-size:22px;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.mr-window-shelf .mr-shelf-hero-by{white-space:normal}.mr-window-shelf .mr-shelf-cta{margin-top:12px;min-height:36px;padding:0 14px}
.mr-shelf-wall{position:relative;flex:1 1 auto;min-width:0;min-height:0;display:grid;grid-template-rows:auto auto;align-content:center;row-gap:16px}
.mr-shelf-wall.has-glance{grid-template-rows:auto auto auto;align-content:center;row-gap:16px}
.mr-window-shelf .mr-shelf-grid:not(.mr-mobile-track){min-height:0;display:grid;grid-template-columns:repeat(var(--shelf-columns),minmax(0,1fr));grid-template-rows:repeat(var(--shelf-rows),var(--shelf-row-height,minmax(0,1fr)));gap:12px 18px;align-content:center}
.mr-shelf-glance{position:relative;display:flex;align-items:center;gap:16px;min-height:84px;padding:14px 18px 14px 20px;border:1px solid var(--mr-border);border-radius:4px;background:color-mix(in srgb,var(--mr-accent) 5%,var(--mr-card));overflow:hidden}
.mr-shelf-glance::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--mr-accent)}
.mr-shelf-glance-mark{display:grid;place-items:center;flex:0 0 42px;height:52px;border:1px solid color-mix(in srgb,var(--mr-accent) 42%,var(--mr-border));border-radius:2px;color:var(--mr-accent);background:color-mix(in srgb,var(--mr-accent) 7%,transparent)}
.mr-shelf-glance-copy{min-width:0;display:flex;flex-direction:column;gap:3px}
.mr-shelf-glance-kicker{font-size:10px;letter-spacing:.15em;color:var(--mr-accent);font-weight:600}
.mr-shelf-glance-copy strong{font:400 20px/1.35 var(--mr-serif);color:var(--mr-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mr-shelf-glance-copy small{font-size:11px;color:var(--mr-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mr-shelf-glance-actions{display:flex;align-items:center;gap:4px;margin-left:auto;flex:0 0 auto}
.mr-shelf-glance-actions .mr-button{min-height:34px;padding:0 14px;font-size:12px}
.mr-shelf-foot{display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:32px;min-width:0}
.mr-shelf-stats{display:flex;align-items:center;gap:14px;min-width:0;color:var(--mr-muted);font-size:11px;white-space:nowrap}
.mr-shelf-stats span{display:inline-flex;align-items:baseline;gap:3px}
.mr-shelf-stats strong{font:600 15px/1 var(--mr-serif);color:var(--mr-text);letter-spacing:.02em}
.mr-shelf-foot-actions{display:flex;align-items:center;gap:10px;margin-left:auto;min-width:0}
.mr-shelf-random{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border:1px solid var(--mr-border);border-radius:5px;background:transparent;color:var(--mr-muted);font-size:11px;cursor:pointer}
.mr-shelf-random:hover{border-color:var(--mr-accent);color:var(--mr-accent)}
.mr-shelf-foot .mr-shelf-pager{padding-top:0}
@keyframes mrShelfPageNext{from{opacity:0;transform:translateX(26px)}to{opacity:1;transform:translateX(0)}}
@keyframes mrShelfPagePrev{from{opacity:0;transform:translateX(-26px)}to{opacity:1;transform:translateX(0)}}
.mr-window-shelf .mr-shelf-grid.mr-page-next{animation:mrShelfPageNext .22s cubic-bezier(.2,.7,.2,1) both}
.mr-window-shelf .mr-shelf-grid.mr-page-prev{animation:mrShelfPagePrev .22s cubic-bezier(.2,.7,.2,1) both}
@media(max-width:720px){.mr-window-shelf .mr-shelf-head{margin:0 0 6px;gap:6px;align-items:center}.mr-window-shelf .mr-shelf-head h1{font-size:22px}.mr-window-shelf .mr-shelf-head .kicker{margin-bottom:3px}.mr-window-shelf .mr-shelf-head-blurb{display:none}.mr-window-shelf .mr-shelf-head-actions{display:none}}
@media(prefers-reduced-motion:reduce){.mr-window-shelf .mr-shelf-grid.mr-page-next,.mr-window-shelf .mr-shelf-grid.mr-page-prev{animation:none}}
.mr-window-shelf .mr-shelf-piece{--shelf-cap-space:47px;height:100%;min-height:0;display:flex;flex-direction:column;justify-content:center;gap:7px;container-type:size;opacity:1;animation:none;border-radius:3px}.mr-window-shelf .mr-shelf-visual{position:relative;display:flex;justify-content:center;align-items:center;width:100%;min-height:0}.mr-window-shelf .mr-shelf-cover-frame{position:relative;display:block;flex:0 0 auto;width:min(100cqw,calc((100cqh - var(--shelf-cap-space)) * .6667));aspect-ratio:2/3}.mr-window-shelf .mr-shelf-cover{width:100%;height:100%;min-height:0;aspect-ratio:2/3;border-radius:3px;box-shadow:0 5px 12px rgba(62,48,31,.16)}.mr-window-shelf .mr-shelf-piece:hover .mr-shelf-cover{transform:translateY(-2px)}.mr-window-shelf .mr-shelf-cap{flex:0 0 40px;width:min(100cqw,calc((100cqh - var(--shelf-cap-space)) * .6667));align-self:center}.mr-window-shelf .mr-shelf-cap strong{font-size:13px;line-height:1.35}.mr-window-shelf .mr-shelf-cap small{font-size:10px;margin-top:3px}.mr-window-shelf .mr-shelf-fallback-title{font-size:15px}
.mr-shelf-pager{display:flex;flex:0 0 auto;align-items:center;justify-content:flex-end;gap:3px;padding-top:8px}.mr-shelf-pager button{min-width:28px;height:28px;padding:0 6px;border:0;border-radius:5px;background:transparent;color:var(--mr-muted);font-size:11px}.mr-shelf-pager button:hover:not(:disabled){background:var(--mr-sunken);color:var(--mr-text)}.mr-shelf-pager button[aria-current=page]{background:var(--mr-accent);color:var(--mr-on-accent)}.mr-shelf-pager button:focus-visible{outline:2px solid var(--mr-accent);outline-offset:1px}
.mr-window-shelf .mr-shelf-grid-note{height:100%;min-height:180px;background:rgba(251,247,236,.36)}
.mr-window-shelf .mr-shelf-online{flex:0 0 auto;margin-top:16px;padding-top:12px;border-color:var(--mr-border)}.mr-window-shelf .mr-shelf-online-row{border-color:var(--mr-border)}
.mr-shelf-mobile-search-toggle{display:none;min-width:36px;height:36px;padding:0;border:1px solid var(--mr-border);border-radius:9px;background:var(--mr-card);color:var(--mr-text);align-items:center;justify-content:center}
@media(max-width:720px){
  .mr-root{position:fixed;inset:0;z-index:2147483000;height:100dvh;box-sizing:border-box;padding-top:env(safe-area-inset-top);background:var(--mr-paper)}
  .mr-nav{width:100%;flex:0 0 58px;order:2;padding:0 8px;border-right:0;border-top:1px solid var(--mr-border)}.mr-brand,.mr-local{display:none}.mr-nav-items{height:100%;flex-direction:row;justify-content:space-around;gap:0;overflow:visible}.mr-nav-items button{min-width:0;min-height:56px;flex:1;flex-direction:column;justify-content:center;gap:2px;padding:3px 4px;font-size:10px;border-radius:8px}.mr-nav-items button.active{background:#f6f0e1}
  .mr-content{padding:14px 12px 84px}.mr-content>.mr-window-shelf{min-height:100%;height:auto}
  .mr-window-shelf .mr-shelf-topbar{position:static;width:100%;justify-content:flex-end;min-height:36px;margin:0 0 10px}.mr-window-shelf .mr-shelf-status{display:none}.mr-shelf-mobile-search-toggle{display:inline-flex}.mr-window-shelf .mr-shelf-back{width:36px;height:36px}.mr-window-shelf .mr-shelf-refresh{width:36px;height:36px;background:var(--mr-paper)}.mr-window-shelf.mr-mobile-search-open .mr-shelf-refresh{display:none}.mr-window-shelf.mr-mobile-search-open .mr-shelf-back{display:none}.mr-window-shelf .mr-shelf-search{display:flex;flex:0 0 auto;min-width:0;height:36px;padding:0 6px}.mr-window-shelf .mr-shelf-search:not(.mr-search-open){height:36px;padding:0;border:0;background:transparent}.mr-window-shelf .mr-shelf-search:not(.mr-search-open) .mr-shelf-mobile-search-toggle{border:1px solid var(--mr-border);background:var(--mr-paper)}.mr-window-shelf.mr-mobile-search-open .mr-shelf-topbar{position:static;width:100%;justify-content:flex-end;min-height:36px;margin:0 0 10px}.mr-window-shelf.mr-mobile-search-open .mr-shelf-head{display:flex}.mr-window-shelf.mr-mobile-search-open .mr-shelf-search{display:flex;flex:1;height:36px;padding:0 4px;border:0;border-bottom:1px solid var(--mr-border);border-radius:0;background:transparent}.mr-window-shelf.mr-mobile-search-open .mr-shelf-search input{background:transparent}.mr-window-shelf.mr-mobile-search-open .mr-shelf-search:focus-within{box-shadow:none}.mr-window-shelf .mr-shelf-search.mr-search-open .mr-shelf-mobile-search-toggle{min-width:28px;height:32px;border:0;background:transparent}.mr-window-shelf .mr-shelf-search:not(.mr-search-open) input{display:none}.mr-window-shelf .mr-shelf-search input{width:100%;min-width:0;height:100%;box-sizing:border-box;font-size:16px;line-height:normal}.mr-window-shelf .mr-shelf-search .kbd{display:none}
  .mr-window-shelf .mr-shelf-head{align-items:flex-start;margin-bottom:8px;gap:8px}.mr-window-shelf .mr-shelf-head h1{font-size:25px}.mr-window-shelf .mr-shelf-head .kicker{display:none}.mr-window-shelf .mr-shelf-head-actions{justify-content:flex-start;gap:6px;width:100%}.mr-window-shelf .mr-sort-select{max-width:88px;min-height:36px;padding:0 4px;font-size:12px}.mr-window-shelf .mr-view-toggle{height:36px;padding:2px}.mr-window-shelf .mr-view-toggle button{min-height:30px;padding:0 8px;font-size:12px}.mr-window-shelf .mr-shelf-head-actions .mr-button{min-height:36px;padding:0 9px;font-size:12px;white-space:nowrap}

  .mr-trend-col{min-width:0}.mr-trend-label{font-size:8px}.mr-trend-col:not(:nth-child(5n+1)) .mr-trend-label{display:none}
  .mr-time-cell{min-width:0}.mr-time-label{font-size:8px}.mr-time-cell:not(:nth-child(3n+1)) .mr-time-label{visibility:hidden}
  .mr-window-shelf .mr-shelf-folder-bar{flex-wrap:nowrap;overflow-x:auto;padding-bottom:7px;scrollbar-width:none}.mr-window-shelf .mr-folder-chip{min-height:27px;padding:0 10px;font-size:11px}
  .mr-window-shelf .mr-shelf-gallery,.mr-window-shelf.mr-no-hero .mr-shelf-gallery{display:flex;flex-direction:column;gap:12px;min-height:0}.mr-window-shelf .mr-shelf-hero{flex:0 0 auto;display:flex;gap:14px;padding:12px;min-height:132px}.mr-window-shelf .mr-shelf-hero-cover{flex:0 0 82px;width:82px}.mr-window-shelf .mr-shelf-hero-cover .mr-shelf-fallback-title{display:none}.mr-window-shelf .mr-shelf-hero-cover .mr-new-badge{left:4px;top:4px}.mr-window-shelf .mr-shelf-hero-cover .mr-dl-badge{right:auto;left:4px;top:auto;bottom:4px}.mr-window-shelf .mr-shelf-hero-title{font-size:18px}.mr-window-shelf .mr-shelf-hero-by{font-size:10px}.mr-window-shelf .mr-shelf-cta{min-height:32px;height:32px;margin-top:8px;font-size:11px}.mr-window-shelf .mr-shelf-progress-label{display:none}
  .mr-shelf-wall{flex:0 0 auto;height:clamp(420px,145vw,620px);min-height:0;display:block;overflow:hidden}.mr-window-shelf .mr-shelf-grid.mr-mobile-track{overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;overscroll-behavior-x:contain;touch-action:pan-x pan-y;scrollbar-width:none;-webkit-overflow-scrolling:touch}.mr-window-shelf .mr-shelf-grid.mr-mobile-track::-webkit-scrollbar{display:none}
  .mr-window-shelf .mr-shelf-grid.mr-mobile-track{display:flex;gap:10px;width:100%;height:100%;min-height:0}.mr-window-shelf .mr-shelf-mobile-page{flex:0 0 100%;width:100%;height:100%;min-height:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(var(--shelf-rows,3),minmax(0,1fr));gap:9px 7px;scroll-snap-align:start;scroll-snap-stop:always}
@media(max-width:720px) and (max-height:900px){.mr-window-shelf .mr-shelf-wall{height:clamp(420px,125vw,560px)}}
  .mr-window-shelf .mr-shelf-piece{--shelf-cap-space:45px;gap:6px}.mr-window-shelf .mr-shelf-cap{flex-basis:40px}.mr-window-shelf .mr-shelf-cap strong{font-size:12.5px;line-height:1.3}.mr-window-shelf .mr-shelf-cap small{font-size:10px;line-height:1.3}.mr-window-shelf .mr-shelf-fallback{padding:8px}.mr-window-shelf .mr-shelf-fallback-title{font-size:12px}.mr-window-shelf .mr-shelf-seal{right:6px;bottom:6px;width:22px;height:22px;font-size:11px}.mr-window-shelf .mr-new-badge{left:5px;top:5px;height:16px;min-width:0;padding:0 4px;font-size:8px}.mr-window-shelf .mr-dl-badge{left:5px;right:auto;top:auto;bottom:5px;width:20px;min-width:20px;height:20px;padding:0;border-radius:50%;font-size:0}.mr-window-shelf .mr-dl-badge::before{font:600 11px/1 var(--mr-sans)}.mr-window-shelf .mr-dl-badge::after{content:'';position:absolute;inset:-4px}.mr-window-shelf .mr-dl-badge.done::before{content:none}.mr-window-shelf .mr-dl-badge.done{left:auto;right:2px;top:calc(100% + 23px);bottom:auto;width:18px;min-width:18px;height:18px;border-radius:4px;background:transparent;color:var(--mr-muted);box-shadow:none;backdrop-filter:none}.mr-window-shelf .mr-dl-badge.done>svg{display:block}.mr-window-shelf .mr-dl-badge.done::after{inset:-7px 0 -7px -7px}.mr-window-shelf .mr-dl-badge.running::before{content:'↓'}.mr-window-shelf .mr-dl-badge.queued::before{content:'…'}.mr-window-shelf .mr-dl-badge.paused::before{content:'Ⅱ'}.mr-window-shelf .mr-dl-badge.failed::before{content:'!'}
  .mr-shelf-pager{display:none}
  .mr-window-shelf .mr-select-bar{position:fixed;left:12px;right:12px;bottom:calc(72px + env(safe-area-inset-bottom,0px));z-index:80;width:auto;max-width:480px;margin:0 auto;padding:8px 10px 6px;border-radius:16px;background:color-mix(in srgb,var(--mr-paper) 96%,transparent);backdrop-filter:blur(16px)}
  .mr-window-shelf.mr-selecting .mr-shelf-wall{padding-bottom:132px}
  .mr-window-shelf .mr-select-actions .mr-button{height:52px;padding:4px 0 2px;font-size:11px}
}
@media(max-width:360px){
  .mr-window-shelf .mr-shelf-head-actions{gap:4px}.mr-window-shelf .mr-sort-select{max-width:74px;padding:0 2px;font-size:11.5px}.mr-window-shelf .mr-view-toggle{padding:1px}.mr-window-shelf .mr-view-toggle button{padding:0 6px;font-size:11.5px}.mr-window-shelf .mr-shelf-head-actions .mr-button{padding:0 7px;font-size:11.5px}
}
@media(orientation:landscape) and (max-height:500px){.mr-nav{width:64px;flex:0 0 64px;order:0;padding:12px 6px}.mr-nav-items{flex-direction:column}.mr-nav-items button{min-height:44px;flex:0 0 auto}.mr-content>.mr-window-shelf{min-height:0}.mr-window-shelf .mr-shelf-head .kicker{display:none}}
@media(prefers-reduced-motion:reduce){.mr-window-shelf .mr-shelf-piece{animation:none;opacity:1}.mr-window-shelf .mr-shelf-cover{transition:none}.mr-shelf-wall{scroll-behavior:auto}}
.mr-stats-layout{display:grid;grid-template-columns:1fr;gap:20px}
.mr-stats-layout>.mr-panel{margin:0}

/* 窗边共用页头与发现/书源/设置外壳 */
.mr-reader.theme-paper{--reader-accent:#6b4a2d;--reader-bg:#f6f0e1;--reader-card:#fbf7ec;--reader-border:#d5ccb8}
.mr-screen{max-width:1120px;margin:0 auto;color:var(--mr-text)}
.mr-screen-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:2px 0 18px;border-bottom:1px solid var(--mr-border);margin-bottom:22px}
.mr-screen-copy{min-width:0}
.mr-screen-kicker{margin:0 0 6px;font-size:10px;line-height:1.5;letter-spacing:.18em;text-transform:uppercase;color:var(--mr-muted)}
.mr-screen-head h1{margin:0;font:400 42px/1.05 var(--mr-serif);letter-spacing:-.035em}
.mr-screen-sub{margin:9px 0 0;font-size:12px;line-height:1.6;color:var(--mr-muted)}
.mr-screen-aside{flex:none;display:flex;align-items:flex-end;gap:14px;padding-bottom:3px}
.mr-screen-stat{display:flex;align-items:baseline;gap:5px;color:var(--mr-muted)}.mr-screen-stat b{font:400 24px/1 var(--mr-serif);color:var(--mr-text)}.mr-screen-stat span{font-size:11px}
.mr-screen-note{padding-bottom:2px;font-size:11px;color:var(--mr-muted);white-space:nowrap}
.mr-card-kicker{margin:0 0 5px;font-size:10px;line-height:1.4;letter-spacing:.16em;text-transform:uppercase;color:var(--mr-muted)}
.mr-discover-layout{display:grid;grid-template-columns:340px minmax(0,1fr);gap:24px;align-items:start}
.mr-search-panel{display:flex;flex-direction:column;gap:14px;padding:20px;border:1px solid var(--mr-border);background:var(--mr-card);box-shadow:var(--mr-shadow)}
.mr-search-panel h2{margin:0;font:400 24px/1.25 var(--mr-serif)}
.mr-search-lead{margin:0;font-size:12px;line-height:1.7;color:var(--mr-muted)}
.mr-big-search{display:flex;align-items:center;gap:8px;min-height:46px;padding-left:12px;border:1px solid var(--mr-border);background:var(--mr-paper)}
.mr-big-search:focus-within{border-color:var(--mr-accent);background:var(--mr-card)}
.mr-big-search svg{flex:none;color:var(--mr-muted)}
.mr-big-search input{flex:1;min-width:0;height:44px;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;font-size:13px;outline:0}
.mr-big-search input:focus{box-shadow:none}
.mr-big-search button{align-self:stretch;min-width:66px;padding:0 12px;border:0;background:var(--mr-accent);color:var(--mr-on-accent);font-size:12px}
.mr-big-search button:disabled{opacity:.55}
.mr-source-chips{display:flex;flex-wrap:wrap;gap:7px}
.mr-source-chip{min-height:30px;padding:4px 8px;border:1px solid var(--mr-border);border-radius:0;background:var(--mr-paper);color:var(--mr-muted);font-size:11px;line-height:1.4}
.mr-source-chip:hover{border-color:var(--mr-accent);color:var(--mr-accent)}
.mr-source-chip.active{border-color:var(--mr-accent);background:var(--mr-accent-soft,#efe4d4);color:var(--mr-accent)}
.mr-recent{display:flex;flex-direction:column;gap:1px;padding-top:12px;border-top:1px solid var(--mr-line)}
.mr-recent>span{margin-bottom:3px;font-size:11px;color:var(--mr-muted)}
.mr-recent button{display:flex;align-items:center;min-height:38px;padding:0;border:0;border-bottom:1px solid var(--mr-line);background:transparent;color:var(--mr-text);font-size:12px;text-align:left}
.mr-recent button:hover{color:var(--mr-accent)}
.mr-results-panel{min-width:0;min-height:0}
.mr-results-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding-bottom:10px;border-bottom:1px solid var(--mr-border)}
.mr-results-head h2{margin:0;font:400 24px/1.3 var(--mr-serif)}
.mr-results-head>span{font-size:11px;color:var(--mr-muted);text-align:right}
.mr-discovery-state{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:260px;padding:28px 20px;border-bottom:1px solid var(--mr-line);background:var(--mr-card);text-align:center}
.mr-discovery-state h3{margin:14px 0 0;font:400 22px/1.35 var(--mr-serif)}
.mr-discovery-state p{max-width:32em;margin:8px 0 0;font-size:12px;line-height:1.7;color:var(--mr-muted)}
.mr-discovery-icon{display:grid;place-items:center;width:46px;height:46px;border-radius:50%;background:var(--mr-accent-soft,#efe4d4);color:var(--mr-accent)}
.mr-spinner{width:34px;height:34px;border:3px solid var(--mr-line);border-top-color:var(--mr-accent);border-radius:50%;animation:mr-discovery-spin .9s linear infinite}
@keyframes mr-discovery-spin{to{transform:rotate(360deg)}}
.mr-source-warning{display:flex;align-items:flex-start;gap:10px;margin:12px 0 2px;padding:11px 12px;border-left:3px solid var(--mr-update,#a85132);background:var(--mr-update-soft,#f3e4db);color:var(--mr-text)}
.mr-source-warning svg{flex:none;margin-top:2px;color:var(--mr-update,#a85132)}.mr-source-warning p{margin:0;font-size:12px;line-height:1.65}
.mr-discovery-results{display:flex;flex-direction:column}
.mr-discovery-result{display:flex;align-items:center;gap:14px;padding:13px 0;border-bottom:1px solid var(--mr-line)}
.mr-discovery-result .mr-cover{width:46px;height:62px;flex-basis:46px;border-radius:2px;box-shadow:0 3px 10px rgba(35,28,20,.16)}
.mr-discovery-result .mr-cover>span{font-size:20px}
.mr-discovery-result-copy{flex:1;min-width:0}
.mr-discovery-result-copy h3{margin:0;overflow:hidden;font:400 16px/1.4 var(--mr-serif);text-overflow:ellipsis;white-space:nowrap}
.mr-discovery-result-copy p{margin:3px 0 0;overflow:hidden;font-size:11px;line-height:1.5;color:var(--mr-muted);text-overflow:ellipsis;white-space:nowrap}
.mr-discovery-source{display:inline-block;margin-top:5px;padding:2px 6px;border:1px solid var(--mr-border);font-size:10px;line-height:1.4;color:var(--mr-muted)}
.mr-website-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}
.mr-website-card{display:grid;grid-template-columns:44px minmax(0,1fr);gap:12px;padding:20px;border:1px solid var(--mr-border);background:var(--mr-paper);border-radius:var(--mr-radius);cursor:pointer}
.mr-website-mark{width:44px;height:44px;display:grid;place-items:center;background:var(--mr-sunken);color:var(--mr-accent)}
.mr-website-copy{min-width:0}.mr-website-copy h2{margin:0;font:400 20px/1.4 var(--mr-serif);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mr-website-copy p{margin:4px 0 8px;font-size:11px;color:var(--mr-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mr-website-kind{font-size:10px;color:var(--mr-muted)}
.mr-website-open{grid-column:2;justify-self:start;min-height:34px;padding:0 12px;font-size:11px}
.mr-site-results{margin:0 0 8px;border-bottom:1px solid var(--mr-line)}.mr-site-results-head{padding:8px 0;font-size:11px;font-weight:600;letter-spacing:.12em;color:var(--mr-muted)}
.mr-site-result{display:flex;align-items:center;gap:11px;width:100%;padding:12px 0;border:0;border-top:1px solid var(--mr-line);background:transparent;color:var(--mr-text);text-align:left;cursor:pointer}.mr-site-result>span{flex:1;min-width:0}.mr-site-result b,.mr-site-result small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mr-site-result b{font:400 15px/1.5 var(--mr-serif)}.mr-site-result small{margin-top:2px;font-size:10px;color:var(--mr-muted)}.mr-site-result>svg:first-child{color:var(--mr-accent);flex:none}.mr-site-result>svg:last-child{color:var(--mr-muted);flex:none}
.mr-discovery-result .mr-button{flex:none;min-height:34px;padding:0 10px;font-size:11px}
.mr-sources-layout{display:grid;grid-template-columns:370px minmax(0,1fr);gap:22px;align-items:start}
.mr-sources-left{display:flex;flex-direction:column;gap:16px}
.mr-window-card{padding:18px;border:1px solid var(--mr-border);background:var(--mr-paper);box-shadow:none}
.mr-window-card h2{margin:0 0 4px;font:400 20px/1.3 var(--mr-serif)}
.mr-window-card .mr-help{margin:0 0 12px}
.mr-window-card textarea{width:100%;resize:vertical;line-height:1.6;padding:10px;border:1px solid var(--mr-border);border-radius:8px;background:color-mix(in srgb,var(--mr-card) 38%,var(--mr-paper));color:var(--mr-text)}.mr-window-card textarea:focus{outline:none;border-color:var(--mr-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--mr-accent) 12%,transparent)}
.mr-online-row{display:flex;align-items:center;gap:8px;margin-top:10px}.mr-online-row input{flex:1;min-width:0;height:38px;padding:0 10px;border:1px solid var(--mr-border);border-radius:8px;background:color-mix(in srgb,var(--mr-card) 38%,var(--mr-paper));color:var(--mr-text);font-size:12px}.mr-online-row input:focus{outline:none;border-color:var(--mr-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--mr-accent) 12%,transparent)}.mr-online-row .mr-button{flex:none;min-height:38px;padding:0 12px}
.mr-sources-list{min-width:0}
.mr-sources-list-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding-bottom:10px;border-bottom:1px solid var(--mr-border)}
.mr-sources-list-head h2{margin:0;font:400 22px/1.3 var(--mr-serif)}
.mr-sources-list-head span{font-size:11px;color:var(--mr-muted)}
.mr-rss-import{margin-bottom:16px}
.mr-rss-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0 6px}
.mr-rss-head>span{font-size:11px;color:var(--mr-muted)}
.mr-rss-head>div{display:flex;gap:6px}
.mr-rss-list{max-height:260px;overflow:auto;border-top:1px solid var(--mr-line);border-bottom:1px solid var(--mr-line)}
.mr-rss-row{display:flex;align-items:center;gap:10px;padding:8px 2px;border-bottom:1px solid var(--mr-line);cursor:pointer}
.mr-rss-row:last-child{border-bottom:0}
.mr-rss-row input{flex:none;width:15px;height:15px;padding:0}
.mr-rss-row span{display:flex;flex-direction:column;min-width:0}
.mr-rss-row strong{font-size:12px;font-weight:500;line-height:1.4}
.mr-rss-row small{overflow:hidden;font-size:10px;color:var(--mr-muted);text-overflow:ellipsis;white-space:nowrap}
.mr-source-unsupported{margin-top:2px;overflow:visible;color:var(--mr-update,#a85132);font-size:10px;line-height:1.5;text-overflow:clip;white-space:normal}
.mr-source-row{display:grid;grid-template-columns:30px minmax(0,1fr) auto;align-items:center;gap:12px;padding:13px 0;border-bottom:1px solid var(--mr-line);background:transparent;border-radius:0}
.mr-source-row h3{margin:0;font:400 15px/1.4 var(--mr-serif)}
.mr-source-row p{margin:2px 0 0;overflow:hidden;font-size:11px;color:var(--mr-muted);text-overflow:ellipsis;white-space:nowrap}
.mr-source-icon{display:grid;place-items:center;width:30px;height:38px;border:1px solid var(--mr-border);background:var(--mr-paper);color:var(--mr-accent);font:400 15px/1 var(--mr-serif)}
.mr-source-side{display:flex;align-items:center;gap:9px}
.mr-source-side .mr-tag{display:inline-flex;align-items:center;min-height:24px;padding:2px 6px;border:1px solid var(--mr-border);font-size:10px;color:var(--mr-muted);white-space:nowrap}
.mr-source-side .mr-tag.failed{border-color:var(--mr-update,#a85132);color:var(--mr-update-ink,#9a452a);background:var(--mr-update-soft,#f3e4db)}
.mr-source-side .mr-button{min-height:28px;padding:0 5px;font-size:11px}
.mr-subscription-list{display:flex;flex-direction:column;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--mr-line)}
.mr-subscription-row{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}.mr-subscription-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px;flex-shrink:0;flex-wrap:wrap}.mr-tag.checking{border-style:dashed}
@media(max-width:640px){.mr-subscription-row{align-items:flex-start;flex-direction:column}.mr-subscription-actions{width:100%;justify-content:space-between}}
.mr-subscription-copy{display:flex;flex-direction:column;gap:2px;min-width:0}
.mr-subscription-copy strong{overflow:hidden;font-size:11px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
.mr-subscription-copy span{font-size:10px;color:var(--mr-muted)}
.mr-tag.pending{border-color:color-mix(in srgb,var(--mr-accent) 42%,var(--mr-border));color:var(--mr-accent);border-style:dashed}
.mr-subscription-row.is-pending{align-items:flex-start;flex-direction:column;padding:9px 8px;margin:0 -8px;border-radius:8px;background:color-mix(in srgb,var(--mr-accent) 5%,transparent)}.mr-subscription-row.is-pending .mr-subscription-copy,.mr-subscription-row.is-pending .mr-subscription-actions{width:100%}.mr-subscription-row.is-pending .mr-subscription-actions{justify-content:flex-start;gap:8px;margin-top:2px}
.mr-subscription-pending{display:flex;flex-direction:column;gap:2px;margin-top:4px;min-width:0}
.mr-pending-permissions{max-width:310px;line-height:1.5;white-space:normal;overflow-wrap:anywhere;color:var(--mr-body)!important}
.mr-pending-changes{font-size:9px!important}
@media(max-width:640px){.mr-pending-permissions{max-width:100%}.mr-subscription-actions .mr-btn{font-size:11px}}
.mr-source-row.is-disabled .mr-source-icon,.mr-source-row.is-disabled h3,.mr-source-row.is-disabled p{opacity:.5}
.mr-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start}
.mr-settings-grid .mr-panel{margin:0;min-width:0}
.mr-settings-grid .mr-panel--wide{grid-column:1/-1}
.mr-settings-grid .mr-panel textarea{width:100%}
@media(max-width:900px){.mr-screen-head h1{font-size:36px}.mr-discover-layout{grid-template-columns:300px minmax(0,1fr);gap:18px}.mr-sources-layout{grid-template-columns:1fr}.mr-sources-left{display:grid;grid-template-columns:1fr 1fr}.mr-settings-grid{grid-template-columns:1fr}.mr-settings-grid .mr-panel--wide{grid-column:auto}}
@media(max-width:720px){
  .mr-screen-head{align-items:flex-start;gap:14px;padding:24px 0 14px;margin-bottom:16px}.mr-screen-head h1{font-size:32px}.mr-screen-kicker{font-size:9px}.mr-screen-sub{font-size:11px}.mr-screen-aside{padding-top:4px}.mr-screen-stat b{font-size:20px}
  .mr-discover-layout{display:block}.mr-search-panel{padding:15px;gap:12px;margin-bottom:16px}.mr-search-panel h2{font-size:21px}
  .mr-big-search{min-height:44px}.mr-big-search input{height:42px}
  .mr-source-chips{gap:6px}.mr-source-chip{min-height:32px}
  .mr-results-head{align-items:flex-start;flex-direction:column;gap:3px}.mr-results-head>span{text-align:left}
  .mr-discovery-result{gap:10px;padding:11px 0}.mr-discovery-result .mr-cover{width:42px;height:56px;flex-basis:42px}.mr-discovery-result .mr-button{min-height:40px;padding:0 8px}
  .mr-website-grid{grid-template-columns:1fr;gap:10px}.mr-website-card{padding:14px}
  .mr-discovery-state{min-height:240px;padding:24px 14px}
  .mr-sources-left{display:flex;flex-direction:column;gap:12px}.mr-window-card{padding:15px}
  .mr-online-row{flex-direction:column;align-items:stretch}.mr-online-row input{flex:none;width:100%;height:38px}.mr-online-row .mr-button{width:100%}
  .mr-source-row{grid-template-columns:30px minmax(0,1fr);gap:9px;padding:12px 0}.mr-source-side{grid-column:2;flex-wrap:wrap;justify-content:space-between;gap:6px}.mr-source-side .mr-tag{white-space:normal}
  .mr-settings-grid{display:flex;flex-direction:column;align-items:stretch;gap:12px}
}
@media(max-width:720px){
  .mr-window-shelf .mr-shelf-wall{height:auto;flex:0 0 auto;display:block;overflow:visible}
  .mr-window-shelf .mr-shelf-grid.mr-mobile-track{display:block;width:100%;height:auto;overflow:visible;scroll-snap-type:none}
  .mr-window-shelf .mr-shelf-mobile-page{display:grid;box-sizing:border-box;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:none;gap:22px 12px;width:100%;height:auto;min-height:0;flex:none;margin:0 0 22px;padding:4px;scroll-snap-align:none}
  .mr-window-shelf .mr-shelf-mobile-page:last-child{margin-bottom:0}
  .mr-window-shelf .mr-shelf-piece{height:auto;min-height:0;container-type:normal;justify-content:flex-start;gap:8px}
  .mr-window-shelf .mr-shelf-cover-frame{width:100%;height:auto;aspect-ratio:2/3}
  .mr-window-shelf .mr-shelf-cover{width:100%;height:auto;aspect-ratio:2/3}
  .mr-window-shelf .mr-shelf-cap{width:100%;min-height:40px;flex:0 0 auto;flex-basis:auto;align-self:stretch;display:flex;flex-direction:column;justify-content:flex-start}
}
@media(max-width:720px){
  .mr-reader-top{position:absolute;top:0;left:0;right:0}
  .mr-reader .mr-chapter,.mr-reader .mr-paged-chapter{padding-top:calc(68px + env(safe-area-inset-top,0px))}
  .mr-reader.mr-chrome-hidden .mr-reader-top,
  .mr-reader.mr-chrome-hidden .mr-tabbar{display:none}
  .mr-reader.mr-chrome-hidden .mr-folio{bottom:14px}
}
/* 桌面阅读：正文保持版心，工具像起点一样贴近正文，而不是屏幕边缘。 */
@media(min-width:881px){
  .mr-reader .mr-tools{left:calc(50% + var(--mr-text-half,336px) + 12px);right:auto;gap:6px}
  .mr-reader .mr-tool-btn{width:64px;min-height:64px;padding:10px 0 8px;gap:6px;border-radius:12px}
}
.mr-media-reader{background:var(--reader-bg);color:var(--reader-text)}
.mr-media-reader input[type=range],.mr-audio-dock input[type=range]{accent-color:var(--reader-accent)}
.mr-audio-dock-nav{display:flex;gap:1px;flex:none}.mr-audio-dock-nav button{width:24px;height:30px;border:0;background:transparent;color:var(--reader-muted);display:grid;place-items:center;padding:0}.mr-audio-dock-nav button:disabled{opacity:.25}
.mr-audio-dock input[type=range]{accent-color:var(--reader-accent)}
.mr-editor-top{display:flex;align-items:center;gap:10px;flex:0 0 auto;min-height:56px;padding:10px 14px;border-bottom:1px solid var(--reader-border);background:color-mix(in srgb,var(--reader-bg) 94%,transparent);z-index:8}
.mr-media-head{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}.mr-media-head strong{font:600 15px/1.3 var(--mr-serif);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mr-media-head small{font-size:11px;color:var(--reader-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mr-media-stage{flex:1;min-height:0;overflow:auto;padding:20px clamp(14px,3vw,40px) 84px;overscroll-behavior:contain}
.mr-comic{max-width:780px;margin:0 auto;display:flex;flex-direction:column;gap:6px;align-items:center}.mr-comic img{display:block;width:100%;height:auto;border-radius:4px;background:var(--reader-card)}.mr-comic.paged img.is-hidden{display:none}.mr-comic-nav{position:sticky;bottom:8px;display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--reader-border);border-radius:999px;background:color-mix(in srgb,var(--reader-bg) 92%,transparent);backdrop-filter:blur(12px);font-size:12px}
.mr-media-error{max-width:520px;margin:12vh auto 0;padding:28px;border:1px solid var(--reader-border);border-radius:16px;background:var(--reader-card);text-align:center;color:var(--reader-muted)}.mr-media-error svg{color:var(--reader-accent)}.mr-media-error h2{font:500 22px/1.3 var(--mr-serif);margin:12px 0 6px;color:var(--reader-text)}.mr-media-error p{font-size:13px;line-height:1.8;margin:0 0 18px}
.mr-media-error-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px}.mr-media-source-link{font-size:12px;color:var(--reader-muted);text-decoration:underline;text-underline-offset:3px}
.mr-audio-stage{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center}.mr-media-cover{width:148px;height:148px;display:grid;place-items:center;border-radius:18px;background:var(--reader-card);border:1px solid var(--reader-border);color:var(--reader-accent);box-shadow:0 18px 44px color-mix(in srgb,#000 14%,transparent)}.mr-audio-stage h1{font:500 28px/1.3 var(--mr-serif);margin:8px 0 0}.mr-audio-stage>p{color:var(--reader-muted);font-size:13px;margin:0}
.mr-audio-controls{width:min(520px,100%);display:flex;flex-direction:column;align-items:center;gap:10px}.mr-audio-controls input{width:100%}.mr-play-big{width:68px;height:68px;border:0;border-radius:50%;display:grid;place-items:center;background:var(--reader-accent);color:var(--reader-bg);margin:8px 0}.mr-audio-controls>span{font-size:12px;color:var(--reader-muted)}
.mr-media-chapter-nav{display:flex;gap:8px;margin-top:10px}
.mr-video-stage{min-height:100%;display:flex;align-items:center;justify-content:center}.mr-video-stage video{width:min(1080px,100%);max-height:calc(100dvh - 190px);background:#000;border-radius:8px}
.mr-media-foot{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;gap:14px;padding:12px 18px calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--reader-border);background:color-mix(in srgb,var(--reader-bg) 94%,transparent);backdrop-filter:blur(14px);z-index:7}.mr-media-foot>span{max-width:44vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--reader-muted)}
.mr-media-drawer{position:absolute;top:56px;right:0;bottom:0;width:min(360px,86vw);z-index:20;border-left:1px solid var(--reader-border);background:var(--reader-card);box-shadow:-18px 0 44px color-mix(in srgb,#000 16%,transparent);overflow:auto;padding:14px}.mr-media-drawer header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.mr-media-drawer header button{border:0;background:transparent;color:var(--reader-muted)}.mr-media-drawer>button{display:flex;justify-content:space-between;gap:10px;width:100%;padding:11px 10px;border:0;border-bottom:1px solid var(--reader-border);background:transparent;text-align:left;color:var(--reader-text);font-size:13px}.mr-media-drawer>button.active{color:var(--reader-accent);font-weight:600}.mr-media-drawer>button small{color:var(--reader-muted);font-size:10px}
.mr-sheet-backdrop{position:fixed;inset:0;z-index:2147483005;display:grid;place-items:center;padding:16px;background:rgba(25,21,17,.38);backdrop-filter:blur(3px)}.mr-download-warning{color:var(--reader-accent-strong,#a23a27)}.mr-download-sheet{width:min(560px,100%);max-height:min(760px,88dvh);display:flex;flex-direction:column;background:var(--reader-card);color:var(--reader-text);border:1px solid var(--reader-border);border-radius:18px;box-shadow:0 26px 80px rgba(0,0,0,.28);overflow:hidden}.mr-download-sheet header{display:flex;justify-content:space-between;gap:12px;padding:18px 18px 12px;border-bottom:1px solid var(--reader-border)}.mr-download-sheet header h2{font:500 22px/1.2 var(--mr-serif);margin:0}.mr-download-sheet header p{font-size:11px;color:var(--reader-muted);margin:5px 0 0}.mr-download-job{display:flex;align-items:center;gap:10px;padding:10px 18px;background:var(--mr-sunken);font-size:12px}.mr-download-job small{color:var(--reader-muted);margin-left:auto;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mr-download-tools{display:flex;justify-content:space-between;align-items:center;padding:10px 18px;font-size:12px;color:var(--reader-muted)}.mr-download-list{flex:1;min-height:0;overflow:auto;padding:0 18px}.mr-download-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:10px;min-height:44px;border-bottom:1px solid var(--reader-border);font-size:12px}.mr-download-actions{display:flex;align-items:center;gap:2px}.mr-download-retain{border:0;background:transparent;color:var(--reader-muted);font-size:10px;padding:4px}.mr-download-retain.is-on{color:var(--reader-accent)}.mr-download-row input{width:16px;height:16px}.mr-download-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mr-download-row em{font-style:normal;color:var(--reader-muted);font-size:10px}.mr-download-row.is-ready em{color:var(--dsw-alias-state-success-primary)}.mr-download-row.is-failed em{color:var(--reader-accent)}.mr-download-cancel{border:0;background:transparent;color:var(--reader-muted);font-size:10px;padding:4px}.mr-download-sheet footer{display:flex;flex-wrap:wrap;gap:8px;padding:14px 18px calc(14px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--reader-border)}
.mr-audio-dock{--mr-card:var(--dsw-alias-bg-layer-1);--mr-border:var(--dsw-alias-border-l2);--mr-text:var(--dsw-alias-label-primary);--mr-muted:var(--dsw-alias-label-secondary);position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:2147483001;width:min(720px,calc(100vw - 24px));display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--mr-border);border-radius:16px;background:color-mix(in srgb,var(--mr-card) 94%,transparent);color:var(--mr-text);box-shadow:0 16px 44px rgba(0,0,0,.2);backdrop-filter:blur(18px)}.mr-audio-dock-main{display:flex;align-items:center;gap:10px;min-width:0;flex:1;border:0;background:transparent;color:inherit;text-align:left}.mr-audio-dock-main span{display:flex;flex-direction:column;min-width:0}.mr-audio-dock-main strong,.mr-audio-dock-main small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mr-audio-dock-main strong{font-size:12px}.mr-audio-dock-main small{font-size:10px;color:var(--mr-muted)}.mr-audio-dock input{width:min(220px,24vw)}.mr-audio-dock-time{font-size:10px;color:var(--mr-muted);white-space:nowrap}
@media(max-width:720px){
  .mr-editor-top{min-height:52px;padding:calc(8px + env(safe-area-inset-top,0px)) 10px 8px}
  .mr-media-stage{padding:12px 8px 78px}.mr-comic img{border-radius:0}.mr-media-cover{width:118px;height:118px}.mr-audio-stage h1{font-size:22px}.mr-download-sheet{max-height:92dvh;border-radius:14px}.mr-download-row{grid-template-columns:auto minmax(0,1fr) auto;grid-template-areas:"check title status" ". . cancel"}.mr-download-row input{grid-area:check}.mr-download-title{grid-area:title}.mr-download-row em{grid-area:status}.mr-download-actions{grid-area:cancel;justify-self:end}.mr-audio-dock{left:8px;right:8px;bottom:calc(70px + env(safe-area-inset-bottom,0px));transform:none;width:auto}.mr-audio-dock input{width:30vw}.mr-audio-dock-time{display:none}
}
`;

    return {
      inject: ['slots', 'layout', 'remote'],
      ...(globalThis.__MO_READER_TEST__ ? { __test: { pagination: paginationMath, shelfLayout, shelfPagination, ShelfBoard, ReaderNav, SHELF_CATEGORIES, bookContentType, booksForShelfCategory, WebsiteShelf, enabledWebsiteSources, websiteTarget, scrollMotion, Stats, Settings, Discover, Sources, ReaderView, MediaReader, MediaDownloadSheet, MediaAudioDock, mediaChapterSource, mediaProgressPayload, mediaStartSeconds, comicPageFromProgress, formatMediaTime, formatBytes, readerStyle: css } } : {}),
      async apply(ctx) {
        const unmount = await ctx.remote.$mount(readerContribution);
        const ui = ctx.inject(['remote.reader'], (inner) => {
          inner.slots.inject('main', () => inner.slots.register({ name: 'main', key: PANEL_ID }, () => h(ReaderApp, { ctx: inner })));
          inner.slots.inject('sidebar.panellist', () => inner.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 8, label: '墨读' }, ReaderIcon));
        });
        try {
          await ui;
        } catch (error) {
          await ui.dispose();
          await unmount();
          throw error;
        }
        return async () => {
          await ui.dispose();
          await unmount();
        };
      },
    };
  },
});
