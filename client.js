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
      'state', 'importSource', 'removeSource', 'restoreBuiltinSources', 'search', 'discover', 'addBook', 'removeBook',
      'toc', 'chapter', 'saveProgress', 'download', 'cancelJob', 'pauseJob', 'resumeJob', 'checkUpdates', 'importLocal',
      'setSettings', 'setBookSettings', 'saveNote', 'deleteNote', 'exportBackup', 'importBackup', 'fetchCover',
      'cacheBookCover', 'bookCandidates', 'applyBookMeta',
      'createFolder', 'renameFolder', 'removeFolder', 'moveBooksToFolder', 'batchDeleteBooks', 'batchDownloadBooks', 'exportBook', 'markBookRead', 'exportNotes',
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
      replacements: [],
      mode: 'scroll',
      flipStyle: 'slide',
      measureWidth: 800,
      animations: true,
      motionQuality: 'auto',
      ambience: 'full',
      reducedMotion: 'system',
    };

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
        note: 'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5',
        play: 'M8 5l11 7-11 7z',
        stop: 'M7 7h10v10H7z',
        close: 'M6 6l12 12M18 6L6 18',
        upload: 'M12 16V4m-5 5 5-5 5 5M5 20h14',
        check: 'M5 12l4 4L19 6',
        type: 'M5 6V4h14v2M12 4v16M9 20h6',
        sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 3v1.6M12 19.4V21M3 12h1.6M19.4 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M18.4 5.6l-1.1 1.1M6.7 17.3l-1.1 1.1',
        up: 'M12 19V6m-6 6 6-6 6 6',
        moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
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



    const SHELF_MAX_BOOKS = 48;

    function shelfLayout(books = []) {
      const list = (Array.isArray(books) ? books : []).slice(0, SHELF_MAX_BOOKS);
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
        : status === 'failed' ? '失败'
        : status === 'completed' ? '已下载'
        : `${pct}%`;
      const kind = status === 'completed' ? 'done' : status === 'failed' ? 'failed' : status === 'paused' || status === 'cancelled' ? 'paused' : status === 'queued' ? 'queued' : 'running';
      return { label, kind, status };
    }

    function DownloadBadge({ book, onToggle }) {
      const badge = downloadBadge(book);
      if (!badge) return null;
      const toggle = (event) => { event.preventDefault(); event.stopPropagation(); onToggle?.(book); };
      return h('span', {
        className: `mr-dl-badge ${badge.kind}`,
        role: 'button',
        tabIndex: 0,
        title: badge.kind === 'paused' ? '点击继续下载' : badge.kind === 'running' || badge.kind === 'queued' ? '点击暂停下载' : badge.kind === 'failed' ? '点击重新下载' : '已下载，点击重新拉取新章',
        onClick: toggle,
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') toggle(event); },
      }, badge.label);
    }

    function ShelfBoard({ books, folders = [], reducedMotion = false, onOpen, headActions, onToggleDownload, online = null, onlineBusy = false, onlineFailed = 0, onSearchOnline, onAddOnline, onCreateFolder, onRenameFolder, onRemoveFolder, onMoveToFolder, onBatchDelete, onBatchDownload, onExport, onMarkRead }) {
      const [query, setQuery] = useState('');
      const [selectMode, setSelectMode] = useState(false);
      const [selected, setSelected] = useState(new Set());
      const [folderFilter, setFolderFilter] = useState(null);
      const [folderSheet, setFolderSheet] = useState(false);
      const [shareBook, setShareBook] = useState(null);
      const [sortBy, setSortBy] = useState('recent');
      const searchRef = useRef(null);
      useEffect(() => {
        const onKey = (event) => {
          if (!(event.metaKey || event.ctrlKey) || String(event.key).toLowerCase() !== 'k') return;
          const target = event.target;
          const field = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
          if (field && !target.closest?.('.mr-root')) return;
          event.preventDefault();
          searchRef.current?.focus();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);
      const layout = shelfLayout(books);
      const lastRead = layout.lastRead;
      const folderMap = useMemo(() => new Map(folders.map(f => [f.id, f])), [folders]);
      const booksInFolder = useMemo(() => {
        const map = new Map();
        for (const book of layout.books) {
          const fid = book.folderId || null;
          if (!map.has(fid)) map.set(fid, []);
          map.get(fid).push(book);
        }
        return map;
      }, [layout.books]);
      const visibleBooks = folderFilter ? (booksInFolder.get(folderFilter) || []) : (booksInFolder.get(null) || []);
      const debounceRef = useRef(null);
      useEffect(() => {
        if (!onSearchOnline) return undefined;
        const keyword = query.trim();
        clearTimeout(debounceRef.current);
        if (keyword.length < 1) { onSearchOnline(''); return undefined; }
        debounceRef.current = setTimeout(() => onSearchOnline(keyword), 500);
        return () => clearTimeout(debounceRef.current);
      }, [query, onSearchOnline]);
      const onlineItems = Array.isArray(online) ? online : [];
      const shelfUrls = new Set(layout.books.map((book) => book.bookUrl || book.url).filter(Boolean));
      const normalizedQuery = query.trim().toLowerCase();
      const matches = normalizedQuery
        ? layout.books.filter((book) => `${book.name || book.title || ''} ${book.author || ''}`.toLowerCase().includes(normalizedQuery))
        : visibleBooks;
      const sortedMatches = useMemo(() => {
        const arr = [...matches];
        if (sortBy === 'recent') arr.sort((a, b) => (b.lastReadAt || b.updatedAt || 0) - (a.lastReadAt || a.updatedAt || 0));
        else if (sortBy === 'added') arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        else if (sortBy === 'name') arr.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        else if (sortBy === 'progress') arr.sort((a, b) => (b.lastRead?.percent || 0) - (a.lastRead?.percent || 0));
        return arr;
      }, [matches, sortBy]);
      const heroBook = normalizedQuery || folderFilter || selectMode ? null : lastRead;
      const gridBooks = sortedMatches.filter((book) => book !== heroBook);
      const toggleSelect = (book) => {
        const id = book.id || book.bookId;
        setSelected(prev => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      };
      const toggleSelectAll = () => {
        if (selected.size === gridBooks.length) setSelected(new Set());
        else setSelected(new Set(gridBooks.map(b => b.id || b.bookId)));
      };
      const exitSelect = () => { setSelectMode(false); setSelected(new Set()); };
      const open = (book, event) => {
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
          bookId: String(book.id || book.bookId || ''),
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
      const progress = heroBook ? (heroBook.lastRead || heroBook.progress || {}) : {};
      const rawPercent = Number(progress.percent);
      const percent = Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, Math.round(rawPercent))) : 0;
      const chapter = progress.chapterTitle || (Number.isInteger(progress.chapterIndex) ? `第 ${progress.chapterIndex + 1} 章` : '');
      const heroTitle = heroBook ? String(heroBook.name || heroBook.title || '未命名').replace(/\.(?:txt|epub|md|pdf)$/i, '') : '';
      const byline = heroBook ? [heroBook.author, chapter, percent > 0 ? `已读 ${percent}%` : ''].filter(Boolean).join(' · ') : '';
      return h('div', { className: `mr-shelf${reducedMotion ? ' mr-reduced' : ''}` },
        h('div', { className: 'mr-shelf-topbar' },
          h('div', { className: 'mr-shelf-search', role: 'search' },
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
              onClick: () => { setQuery(''); searchRef.current?.focus(); },
            }, h(Glyph, { name: 'close', size: 14 })) : h('span', { className: 'kbd' }, '⌘K')),
          h('div', { className: 'mr-shelf-status' },
            h('span', { className: 'dot' }),
            h('span', null, '离线可用'),
            h('span', null, '十一月六日 · 周五'))),
        h('div', { className: 'mr-shelf-head' },
          h('div', { className: 'mr-shelf-head-copy' },
            h('div', { className: 'kicker' },
              h('span', null, normalizedQuery ? `找到 ${sortedMatches.length} 本` : folderFilter ? (folderMap.get(folderFilter)?.name || '文件夹') : `本机书库 · ${layout.count} 本`),
              h('span', { className: 'tag' }, '画廊')),
            h('h1', null, '书架')),
          h('div', { className: 'mr-shelf-head-actions' },
            h('select', { className: 'mr-sort-select', value: sortBy, onChange: (e) => setSortBy(e.target.value) },
              h('option', { value: 'recent' }, '最近阅读'),
              h('option', { value: 'added' }, '添加时间'),
              h('option', { value: 'name' }, '书名'),
              h('option', { value: 'progress' }, '进度')),
            headActions,
            h(Button, { kind: selectMode ? 'primary' : 'secondary', onClick: () => { setSelectMode(!selectMode); setSelected(new Set()); } }, selectMode ? '退出多选' : '多选'))),
        folders.length > 0 || selectMode ? h('div', { className: 'mr-shelf-folder-bar' },
          h('button', { className: `mr-folder-chip${!folderFilter ? ' active' : ''}`, onClick: () => setFolderFilter(null) }, '全部'),
          folders.map(f => h('button', {
            key: f.id,
            className: `mr-folder-chip${folderFilter === f.id ? ' active' : ''}`,
            onClick: () => setFolderFilter(f.id),
            onDoubleClick: () => { const name = window.prompt('重命名文件夹', f.name); if (name) onRenameFolder?.(f.id, name); },
          }, f.name)),
          h('button', { className: 'mr-folder-chip mr-folder-add', onClick: () => { const name = window.prompt('新建文件夹'); if (name) onCreateFolder?.(name); } }, '+ 新建'),
          folderFilter ? h('button', { className: 'mr-folder-chip mr-folder-del', onClick: () => { if (window.confirm(`删除文件夹「${folderMap.get(folderFilter)?.name}」？里面的书会回到书架。`)) { onRemoveFolder?.(folderFilter); setFolderFilter(null); } } }, '删除此文件夹') : null) : null,
        selectMode ? h('div', { className: 'mr-select-bar' },
          h('label', { className: 'mr-select-all' }, h('input', { type: 'checkbox', checked: selected.size === gridBooks.length && gridBooks.length > 0, onChange: toggleSelectAll }), `全选 (${selected.size}/${gridBooks.length})`),
          h('div', { className: 'mr-select-actions' },
            h(Button, { kind: 'secondary', disabled: !selected.size, onClick: () => setFolderSheet(true) }, '移动到…'),
            h(Button, { kind: 'secondary', disabled: !selected.size, onClick: () => onBatchDownload?.(Array.from(selected)) }, '下载'),
            h(Button, { kind: 'secondary', disabled: !selected.size, onClick: () => onExport?.(Array.from(selected)) }, '导出'),
            h(Button, { kind: 'secondary', disabled: !selected.size, onClick: () => onMarkRead?.(Array.from(selected)) }, '标已读'),
            h(Button, { kind: 'danger', disabled: !selected.size, onClick: () => { if (window.confirm(`删除 ${selected.size} 本书？`)) onBatchDelete?.(Array.from(selected)); } }, '删除'),
            h(Button, { kind: 'text', onClick: exitSelect }, '取消'))) : null,
        normalizedQuery && sortedMatches.length === 0
          ? h('div', { className: 'mr-shelf-search-empty' },
              h('p', null, `没有找到「${query.trim()}」`),
              h('p', { className: 'hint' }, '换个书名或作者，或清空搜索。'),
              h(Button, { kind: 'secondary', onClick: () => { setQuery(''); searchRef.current?.focus(); } }, '清空搜索'))
          : null,
        folderSheet ? h('div', { className: 'mr-folder-sheet-backdrop', onClick: () => setFolderSheet(false) },
          h('div', { className: 'mr-folder-sheet', onClick: (e) => e.stopPropagation() },
            h('h3', null, `移动 ${selected.size} 本书到…`),
            h('div', { className: 'mr-folder-sheet-list' },
              h('button', { className: 'mr-folder-sheet-item', onClick: () => { onMoveToFolder?.(Array.from(selected), null); setFolderSheet(false); exitSelect(); } }, '📚 移出文件夹（回到书架）'),
              folders.map(f => h('button', {
                key: f.id,
                className: 'mr-folder-sheet-item',
                onClick: () => { onMoveToFolder?.(Array.from(selected), f.id); setFolderSheet(false); exitSelect(); },
              }, `📁 ${f.name}`))),
            h(Button, { kind: 'text', onClick: () => setFolderSheet(false) }, '取消'))) : null,
        shareBook ? h(ShareCard, { book: shareBook, onClose: () => setShareBook(null) }) : null,
        layout.count === 0
          ? h('div', { className: 'mr-shelf-empty' },
              h('div', { className: 'mr-shelf-empty-icon' }, h(Glyph, { name: 'book', size: 24 })),
              h('h3', null, '墙上还空着'),
              h('p', null, '去发现搜书，或导入本地书籍。'))
          : h('div', { className: 'mr-shelf-gallery' },
              heroBook ? h('section', { className: 'mr-shelf-hero', 'aria-label': '继续阅读' },
                h('button', { className: 'mr-shelf-hero-cover', type: 'button', 'aria-label': `继续阅读 ${heroTitle}`, onClick: (event) => open(heroBook, event) }, coverNode(heroBook, heroTitle, 1), h(DownloadBadge, { book: heroBook, onToggle: onToggleDownload }), Number(heroBook.unread || heroBook.unreadCount || 0) > 0 ? h('span', { className: 'mr-new-badge' }, `+${Number(lastRead.unread || lastRead.unreadCount)} 章`) : null),
                h('div', { className: 'mr-shelf-hero-info' },
                  h('p', { className: 'mr-shelf-eyebrow' }, '01 · 继续阅读'),
                  h('h3', { className: 'mr-shelf-hero-title' }, heroTitle),
                  byline ? h('p', { className: 'mr-shelf-hero-by' }, byline) : null,
                  h('div', { className: 'mr-shelf-progress', 'aria-hidden': 'true' }, h('i', { style: { width: `${percent}%` } })),
                  h('button', { className: 'mr-shelf-cta', type: 'button', onClick: (event) => open(heroBook, event) }, '继续阅读 →'))) : null,
              normalizedQuery && matches.length === 0
                ? h('div', { className: 'mr-shelf-search-empty' },
                    h('p', null, `没有找到「${query.trim()}」`),
                    h('p', { className: 'hint' }, '换个书名或作者，或清空搜索。'),
                    h(Button, { kind: 'secondary', onClick: () => { setQuery(''); searchRef.current?.focus(); } }, '清空搜索'))
                : h('div', { className: 'mr-shelf-grid' },
                    normalizedQuery && gridBooks.length === 0
                      ? h('p', { className: 'mr-shelf-grid-note' }, '在读的这本就是')
                      : gridBooks.map((book, index) => {
                          const id = book.id || book.bookId || index;
                          const name = String(book.name || book.title || '未命名');
                          const variant = (index % 7) + 2;
                          const isSelected = selected.has(id);
                          return h('button', {
                            key: `book-${id}`,
                            className: `mr-shelf-piece${isSelected ? ' mr-selected' : ''}`,
                            type: 'button',
                            'aria-label': `${name}${book.author ? `，${book.author}` : ''}`,
                            title: name,
                            onClick: (event) => open(book, event),
                            onContextMenu: (event) => { event.preventDefault(); setShareBook(book); },
                          },
                          selectMode ? h('span', { className: 'mr-select-check' }, h('input', { type: 'checkbox', checked: isSelected, readOnly: true })) : null,
                          coverNode(book, name, variant),
                          h(DownloadBadge, { book, onToggle: onToggleDownload }),
                          Number(book.unread || book.unreadCount || 0) > 0 ? h('span', { className: 'mr-new-badge' }, `+${Number(book.unread || book.unreadCount)} 章`) : null,
                          h('span', { className: 'mr-shelf-cap' },
                            h('strong', null, name.replace(/\.(?:txt|epub|md|pdf)$/i, '')),
                            book.author ? h('small', null, book.author) : null));
                        }))),
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
        h('div', { className: 'mr-shelf-foot' },
          h('span', null, `共 ${layout.count} 本 · 本机保存 · 不上传`),
          h('span', { className: 'wall' }, normalizedQuery ? `${String(matches.length).padStart(2, '0')} 本 · 匹配` : `${String(layout.count).padStart(2, '0')} 本 · 都在墙上`)));
    }

    function Library({ books, folders = [], onOpen, onDownload, onRemove, onCheck, busy, view = 'shelf', onView, ctx, theme, quality, ambience, reducedMotion = false, onToggleDownload, online = null, onlineBusy = false, onlineFailed = 0, onSearchOnline, onAddOnline, onCreateFolder, onRenameFolder, onRemoveFolder, onMoveToFolder, onBatchDelete, onBatchDownload, onExport, onMarkRead }) {
      if (!books.length) return h(Empty, {
        title: '书架还是空的', detail: '去发现搜书，或导入本地书籍。',
      });
      const viewToggle = h('div', { className: 'mr-view-toggle', role: 'group', 'aria-label': '书架视图' },
        h('button', { className: view === 'shelf' ? 'active' : '', onClick: () => onView('shelf') }, '书架'),
        h('button', { className: view === 'list' ? 'active' : '', onClick: () => onView('list') }, '列表'));
      const checkButton = h(Button, { icon: 'refresh', onClick: onCheck, disabled: busy }, '补查');
      const actions = h(React.Fragment, null, viewToggle, checkButton);
      if (view === 'shelf') return h(ShelfBoard, { key: 'shelf', books, folders, reducedMotion, onOpen, headActions: actions, onToggleDownload, online, onlineBusy, onlineFailed, onSearchOnline, onAddOnline, onCreateFolder, onRenameFolder, onRemoveFolder, onMoveToFolder, onBatchDelete, onBatchDownload, onExport, onMarkRead });
      return h(React.Fragment, null,
        h('div', { className: 'mr-section-head' },
          h('div', null, h('h2', null, '我的书架'), h('p', null, `${books.length} 本 · 本机保存`)),
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
                h('p', null, book.author || (book.sourceType === 'local' ? '本地书籍' : '未知作者')),
                h('small', null, book.sourceFailed ? '源失效' : (book.latestChapter || book.lastChapter || (job === 'running' ? '下载中' : '尚未读'))))),
            h('div', { className: 'mr-book-actions' },
              h(Button, { kind: 'text', icon: 'download', title: '整本下载', onClick: () => onDownload(book), disabled: busy || job === 'running' || job === 'queued' }, job === 'completed' ? '已下载' : job === 'queued' ? '排队' : '下载'),
              h(Button, { kind: 'text danger', icon: 'trash', title: '移出书架', onClick: () => onRemove(book), disabled: busy }, '移除')));
        })));
    }

    function Discover({ sources, onSearch, onAdd, results, busy, failed }) {
      const [query, setQuery] = useState('');
      if (!sources.length) return h(Empty, { icon: 'source', title: '先导入书源', detail: '支持 URL、文件或粘贴 JSON。' });
      return h('div', { className: 'mr-discover' },
        h('div', { className: 'mr-section-head' }, h('div', null, h('h2', null, '发现好书'), h('p', null, `搜索全部 ${sources.length} 个书源`))),
        h('form', { className: 'mr-searchbar', onSubmit: (event) => { event.preventDefault(); onSearch(query); } },
          h('input', { value: query, onChange: (e) => setQuery(e.target.value), placeholder: '书名或作者', 'aria-label': '搜索' }),
          h(Button, { kind: 'primary', icon: 'search', type: 'submit', disabled: busy }, '搜索')),
        busy ? h('div', { className: 'mr-loading' }, '正在查找…') : null,
        !busy && failed ? h('p', { className: 'mr-help' }, `${failed} 个书源没响应，已跳过。`) : null,
        !busy && results && results.length === 0 ? h(Empty, { icon: 'search', title: '没有找到', detail: '换个关键词或书源试试。' }) : null,
        h('div', { className: 'mr-results' }, (results || []).map((book, index) => {
          const name = book.name || book.title || '未命名';
          return h('article', { className: 'mr-result', key: `${book.bookUrl || book.url || name}-${index}` },
            h(BookCover, { book, small: true }),
            h('div', { className: 'mr-result-info' }, h('h3', null, name), h('p', null, [book.author, book.kind, book.sourceName].filter(Boolean).map(plainText).join(' · ') || '书籍'), book.intro ? h('p', { className: 'mr-intro' }, book.intro) : null),
            h(Button, { kind: 'primary soft', icon: 'plus', onClick: () => onAdd(book), disabled: busy }, '加书架'));
        })));
    }

    function importSummary(result) {
      if (!result || typeof result !== 'object') return '书源已导入';
      const imported = Number(result.imported || 0);
      const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
      if (!imported) return '这批书源都不符合规则，一个也没有导入';
      const first = Array.isArray(result.skipped) && result.skipped[0]?.reason ? String(result.skipped[0].reason).replace(/^source\./, '') : '';
      const skippedText = skipped ? `跳过 ${skipped} 个${first ? `（${first.slice(0, 40)}）` : ''}` : '';
      return skippedText ? `已导入 ${imported} 个书源，${skippedText}` : `已导入 ${imported} 个书源`;
    }
    const SOURCE_LIBRARY_KEY = 'mo-reader:source-library';
    function readSourceLibrary() {
      try { return JSON.parse(window.localStorage.getItem(SOURCE_LIBRARY_KEY) || 'null') || { url: '', at: '' }; }
      catch { return { url: '', at: '' }; }
    }
    function writeSourceLibrary(value) {
      try { window.localStorage.setItem(SOURCE_LIBRARY_KEY, JSON.stringify(value)); } catch {}
    }
    function Sources({ sources, onImport, onRemove, busy, onPullLibrary, onRestoreBuiltin }) {
      const [draft, setDraft] = useState('');
      const [allowHttp, setAllowHttp] = useState(false);
      const [library, setLibrary] = useState(readSourceLibrary);
      const [libraryText, setLibraryText] = useState(library.url || '');
      const [libraryHttp, setLibraryHttp] = useState(false);
      const fileRef = useRef(null);
      const pulling = busy;
      return h('div', { className: 'mr-sources' },
        h('div', { className: 'mr-section-head' }, h('div', null, h('h2', null, '书源管理'), h('p', null, '基础规则 · 本机校验'))),
        h('section', { className: 'mr-panel' },
          h('h3', null, '导入书源'),
          h('textarea', { value: draft, onChange: (e) => setDraft(e.target.value), placeholder: '粘贴书源 JSON，或填写公开 URL', rows: 5 }),
          h('label', { className: 'mr-check' }, h('input', { type: 'checkbox', checked: allowHttp, onChange: (e) => setAllowHttp(e.target.checked) }), '允许明文 HTTP'),
          h('p', { className: 'mr-help' }, '不绕过登录、付费或验证码。JavaScript 规则将在第二期支持。'),
          h('div', { className: 'mr-inline-actions' },
            h(Button, { kind: 'primary', icon: 'plus', disabled: busy || !draft.trim(), onClick: () => onImport(draft, allowHttp).then(() => setDraft('')) }, '导入'),
            h(Button, { icon: 'upload', onClick: () => fileRef.current?.click(), disabled: busy }, '选文件'),
            h(Button, { icon: 'refresh', onClick: () => onRestoreBuiltin(), disabled: busy }, '恢复内置'),
            h('input', { ref: fileRef, type: 'file', accept: '.json,application/json', hidden: true, onChange: async (e) => { const file = e.target.files?.[0]; if (file) setDraft(await file.text()); e.target.value = ''; } }))),
        h('section', { className: 'mr-panel' },
          h('h3', null, '在线源库'),
          h('p', { className: 'mr-help' }, '填一个公开源库地址（返回书源 JSON 数组），拉取后导入全部可用书源。'),
          h('label', { className: 'mr-check' }, h('input', { type: 'checkbox', checked: libraryHttp, onChange: (e) => setLibraryHttp(e.target.checked) }), '允许明文 HTTP'),
          h('div', { className: 'mr-inline-actions' },
            h('input', { className: 'mr-input', value: libraryText, onChange: (e) => setLibraryText(e.target.value), placeholder: 'https://…/sources.json', style: { flex: '1 1 320px' } }),
            h(Button, { kind: 'primary', icon: 'download', disabled: pulling || !libraryText.trim(), onClick: async () => {
              const ok = await onPullLibrary({ url: libraryText.trim(), allowHttp: libraryHttp });
              if (ok === false) return;
              const next = { url: libraryText.trim(), at: new Date().toISOString() };
              setLibrary(next);
              writeSourceLibrary(next);
            } }, '拉取'),
            library.at ? h('span', { className: 'mr-help' }, `上次拉取 ${new Date(library.at).toLocaleString('zh-CN', { hour12: false })}`) : null)),
        h('section', { className: 'mr-source-list' }, sources.length ? sources.map((source) => {
          const id = source.id || source.bookSourceUrl;
          return h('article', { className: 'mr-source-row', key: id },
            h('div', { className: 'mr-source-mark' }, h(Glyph, { name: 'source' })),
            h('div', null, h('h3', null, source.bookSourceName || source.name || '书源'), h('p', { title: source.bookSourceUrl }, source.bookSourceUrl)),
            h('span', { className: `mr-tag${source.lastError ? ' failed' : ''}`, title: source.lastError || '' }, source.lastError ? '解析失败' : source.builtin ? '内置' : (source.compatibility || '基础规则')),
            source.builtin ? null : h(Button, { kind: 'text danger', icon: 'trash', onClick: () => onRemove(source), disabled: busy }, '移除'));
        }) : h(Empty, { icon: 'source', title: '暂无书源', detail: '导入后即可搜索和追更。' })));
    }

    function Settings({ settings, onSettings, onLocal, onExport, onImport, busy, onExportNotes, onUploadFont }) {
      const [replacementText, setReplacementText] = useState(() => (settings.replacements || []).map((rule) => `${rule.pattern || rule.from || ''}=>${rule.replacement || rule.to || ''}`).join('\n'));
      const localRef = useRef(null);
      const backupRef = useRef(null);
      const fontRef = useRef(null);
      useEffect(() => {
        setReplacementText((settings.replacements || []).map((rule) => `${rule.pattern || rule.from || ''}=>${rule.replacement || rule.to || ''}`).join('\n'));
      }, [settings.replacements]);
      const saveReplacements = () => {
        const replacements = replacementText.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
          const at = line.indexOf('=>');
          return at < 0 ? { pattern: line, replacement: '' } : { pattern: line.slice(0, at), replacement: line.slice(at + 2) };
        });
        return onSettings({ replacements });
      };
      return h('div', { className: 'mr-settings' },
        h('div', { className: 'mr-section-head' }, h('div', null, h('h2', null, '阅读设置'), h('p', null, '排版、净化与备份'))),
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
        h('section', { className: 'mr-panel' }, h('h3', null, '本地书籍'), h('p', { className: 'mr-help' }, '导入 TXT 或 EPUB，内容仅保存在本机。'),
          h(Button, { icon: 'upload', onClick: () => localRef.current?.click(), disabled: busy }, '导入书籍'),
          h('input', { ref: localRef, type: 'file', accept: '.txt,.epub,text/plain,application/epub+zip', hidden: true, onChange: (e) => { const file = e.target.files?.[0]; if (file) onLocal(file); e.target.value = ''; } })),
        h('section', { className: 'mr-panel' }, h('h3', null, '备份恢复'), h('p', { className: 'mr-help' }, '备份不包含密码、Cookie 或令牌。'),
          h('div', { className: 'mr-inline-actions' },
            h(Button, { icon: 'download', onClick: onExport, disabled: busy }, '导出'),
            h(Button, { icon: 'upload', onClick: () => backupRef.current?.click(), disabled: busy }, '恢复'),
            h('input', { ref: backupRef, type: 'file', accept: '.json,application/json', hidden: true, onChange: async (e) => { const file = e.target.files?.[0]; if (file) onImport(file); e.target.value = ''; } }))),
        h('section', { className: 'mr-panel mr-roadmap' }, h('h3', null, '分期说明'), h('p', null, '当前为文字核心版。高兼容脚本、AI 与多媒体将在后续阶段提供。')),
        h('section', { className: 'mr-panel' }, h('h3', null, '阅读统计'),
          h('div', { className: 'mr-stats-grid' },
            h('div', { className: 'mr-stat-card' }, h('strong', null, '0'), h('span', null, '今日阅读（分钟）')),
            h('div', { className: 'mr-stat-card' }, h('strong', null, '0'), h('span', null, '本周阅读（页）')),
            h('div', { className: 'mr-stat-card' }, h('strong', null, '0'), h('span', null, '连续阅读（天）')))),
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
          h('input', { ref: fontRef, type: 'file', accept: '.ttf,.otf,.woff,.woff2', hidden: true, onChange: (e) => { const file = e.target.files?.[0]; if (file) onUploadFont?.(file); e.target.value = ''; } })));
    }

    function ReaderView({ ctx, book, settings, onSettings, onBookSettings, notes, onClose, onSaveNote, onDeleteNote, notify, notice, onDismissNotice, deferMs = 0 }) {
      const [toc, setToc] = useState([]);
      const [chapter, setChapter] = useState(null);
      const [chapterIndex, setChapterIndex] = useState(-1);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [drawer, setDrawer] = useState('');
      const [speaking, setSpeaking] = useState(false);
      const [noteText, setNoteText] = useState('');
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
        el.scrollTop = Math.max(0, nodeTop(node) + offset);
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
        const value = await call(ctx, 'chapter', { bookId, chapterId: id });
        return { index, chapter: value || {} };
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
        if (current) { setChapter(current.chapter); setChapterIndex(current.index); chapterIndexRef.current = current.index; }
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
      const onPagedClick = (event) => {
        if (turnRef.current || suppressClickRef.current) return;
        if (event.target?.closest?.('button,a,input,textarea,select')) return;
        const selection = window.getSelection?.();
        if (selection && !selection.isCollapsed) return;
        const rect = pagedRef.current?.getBoundingClientRect();
        if (!rect) return;
        turnPage(event.clientX < rect.left + rect.width / 2 ? -1 : 1);
      };

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
          ...lines.map((line, key) => h('p', { key }, line)),
          !lines.length ? h(Empty, { key: 'empty', title: '本章无正文', detail: '可尝试刷新目录。' }) : null,
          showEnd
            ? h('div', { key: 'end', className: 'mr-chapter-end' }, index + 1 < toc.length
              ? h(Button, { kind: 'primary soft', onClick: () => openChapter(index + 1) }, '下一章')
              : h('span', null, '已是最后一章'))
            : null,
        ];
      };
      const chapterNodes = chapterNodesFor({ index: chapterIndex, chapter });
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

      return h('div', {
        className: `mr-reader theme-${theme} font-${settings.fontFamily === 'sans' ? 'sans' : 'serif'}${motionOff ? ' mr-reduced' : ''}`,
        style: { '--mr-text': `${Math.max(360, (settings.measureWidth || 800) - 128)}px` },
      },
        notice ? h(Notice, { notice, onClose: onDismissNotice }) : null,
        h('div', { className: 'mr-ambience', ref: ambienceHostRef, 'aria-hidden': true }),
        h('div', { className: 'mr-rail', 'aria-hidden': true }, h('i', { style: { width: `${bookPercent}%` } })),
        h('main', mode === 'paged'
          ? { className: 'mr-paged-view', ref: pagedRef, onClick: onPagedClick, onPointerDown: onPagedPointerDown, onPointerMove: onPagedPointerMove, onPointerUp: onPagedPointerUp, onPointerCancel: onPagedPointerCancel }
          : { className: 'mr-chapter-scroll', ref: scrollRef, onScroll },
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
                ['640', (settings.measureWidth || 800) === 640, () => onSettings({ measureWidth: 640 })],
                ['800', (settings.measureWidth || 800) === 800, () => onSettings({ measureWidth: 800 })],
                ['960', (settings.measureWidth || 800) === 960, () => onSettings({ measureWidth: 960 })],
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
              rangeRow('语速', (settings.ttsRate || 1).toFixed(1), '×', h('input', { type: 'range', min: .5, max: 2, step: .1, value: settings.ttsRate || 1, onChange: (e) => onSettings({ ttsRate: Number(e.target.value) }) }))))) : null,
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
            h('div', { className: 'mr-notes' }, chapterNotes.map((note) => h('article', { key: note.id }, note.quote ? h('blockquote', null, note.quote) : null, h('p', null, note.text), h(Button, { kind: 'text danger', icon: 'trash', onClick: () => onDeleteNote(note) }, '删除')))))) : null);
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

    function ReaderApp({ ctx }) {
      const [data, setData] = useState({ sources: [], books: [], jobs: [], notes: [], folders: [], settings: DEFAULT_SETTINGS });
      const [tab, setTab] = useState('library');
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
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

      const run = async (operation, success) => {
        setBusy(true);
        try { const value = await operation(); await refresh(true); if (success) notify(success, 'success'); return value; }
        catch (cause) { notify(cause.message || String(cause), 'error'); throw cause; }
        finally { setBusy(false); }
      };
      const importSource = (draft, allowHttp) => {
        const value = draft.trim();
        const pending = run(() => call(ctx, 'importSource', /^https?:\/\//i.test(value) ? { url: value, allowHttp } : { text: value, allowHttp }), '书源已导入');
        pending.then((result) => { if (result) setNotice({ kind: 'info', text: importSummary(result) }); }, () => {});
        return pending;
      };
      const search = async (query) => {
        const keyword = String(query || '').trim();
        if (!keyword) return;
        setBusy(true); setResults(null); setSearchFailed(0);
        const targets = sources.filter((source) => source.enabled !== false);
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
        const targets = sources.filter((source) => source.enabled !== false)
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
          await refresh(true); notify('书籍已导入', 'success'); setTab('library');
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
      const openBook = (book, detail) => {
        if (!detail?.rect || !detail?.panel || motionOff) { setOpening(null); setReading(book); return; }
        setOpening({ ...detail, book, theme: settings.readerTheme || 'paper' });
        setReading(book);
      };
      const nav = [
        ['library', '书架', 'shelf'], ['discover', '发现', 'compass'], ['sources', '书源', 'source'], ['settings', '设置', 'settings'],
      ];
      if (activeBook) return h(React.Fragment, null, h('style', null, css),
        h(ReaderView, { ctx, book: activeBook, settings, notes, notice, onDismissNotice: () => setNotice(null), deferMs: opening ? 200 : 0, onSettings: updateSettings, onBookSettings: (partial) => updateBookSettings(activeBook.id || activeBook.bookId, partial), onClose: () => { setOpening(null); setReading(null); refresh(true); }, onSaveNote: saveNote, onDeleteNote: (note) => run(() => call(ctx, 'deleteNote', { id: note.id })).catch(() => {}), notify }),
        opening ? h(OpenTransition, { key: opening.bookId || 'open', data: opening, onDone: () => setOpening(null) }) : null);

      return h(React.Fragment, null, h('style', null, css), h(MetaSheet, { state: metaSheet, onClose: () => setMetaSheet(null), onPick: applyMetaCandidate }), h('div', { className: 'mr-root' },
        h('nav', { className: 'mr-nav', 'aria-label': '墨读' },
          h('div', { className: 'mr-brand' }, h(ReaderIcon, { size: 30 }), h('div', null, h('strong', null, '墨读'), h('small', null, '读想读的书'))),
          h('div', { className: 'mr-nav-items' }, nav.map(([id, label, icon]) => h('button', { key: id, className: tab === id ? 'active' : '', onClick: () => setTab(id) }, h(Glyph, { name: icon }), h('span', null, label)))),
          h('div', { className: 'mr-local' }, h('span', null), '本机保存')),
        h('section', { className: 'mr-content' },
          h(Notice, { notice, onClose: () => setNotice(null) }),
          loading ? h('div', { className: 'mr-loading' }, '正在打开墨读…') : null,
          !loading && tab === 'library' ? h(Library, { books, folders: data.folders || [], busy, view: shelfView, onView: setShelfView, ctx, online: shelfOnline, onlineBusy: shelfOnlineBusy, onlineFailed: shelfOnlineFailed, onSearchOnline: searchShelfOnline, onAddOnline: (item) => addBook(item), theme: settings.readerTheme || 'paper', quality: settings.motionQuality || 'auto', ambience: settings.ambience || 'full', reducedMotion: prefersReducedMotion() || settings.reducedMotion === 'on', onOpen: openBook, onDownload: (book) => run(() => call(ctx, 'download', { bookId: book.id || book.bookId }), '下载已开始').catch(() => {}),
            onCreateFolder: (name) => run(() => call(ctx, 'createFolder', { name }), '文件夹已创建').catch(() => {}),
            onRenameFolder: (folderId, name) => run(() => call(ctx, 'renameFolder', { folderId, name }), '已重命名').catch(() => {}),
            onRemoveFolder: (folderId) => run(() => call(ctx, 'removeFolder', { folderId }), '文件夹已删除').catch(() => {}),
            onMoveToFolder: (bookIds, folderId) => run(() => call(ctx, 'moveBooksToFolder', { bookIds, folderId }), '已移动').catch(() => {}),
            onBatchDelete: (bookIds) => run(() => call(ctx, 'batchDeleteBooks', { bookIds }), `已删除 ${bookIds.length} 本`).catch(() => {}),
            onBatchDownload: (bookIds) => run(() => call(ctx, 'batchDownloadBooks', { bookIds }), `已开始下载 ${bookIds.length} 本`).catch(() => {}),
            onExport: (bookIds) => { bookIds.forEach(id => run(() => call(ctx, 'exportBook', { bookId: id, format: 'txt' }), '导出完成').then(r => { if (r?.text) { const blob = new Blob([r.text], { type: 'text/plain;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${r.name || id}.txt`; a.click(); URL.revokeObjectURL(a.href); } }, () => {})); },
            onMarkRead: (bookIds) => { bookIds.forEach(id => run(() => call(ctx, 'markBookRead', { bookId: id }), '已标记').catch(() => {})); },
            onToggleDownload: (book) => {
              const status = book.downloadStatus || book.download?.status;
              const bookId = book.id || book.bookId;
              if (status === 'failed' || status === 'completed') return run(() => call(ctx, 'download', { bookId }), status === 'failed' ? '重新下载' : '重新检查').catch(() => {});
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
          !loading && tab === 'sources' ? h(Sources, { sources, busy, onImport: importSource,
              onRestoreBuiltin: () => run(() => call(ctx, 'restoreBuiltinSources'), '内置书源已恢复').then((result) => { if (result) setNotice({ kind: 'success', text: `已恢复 ${result.added} 个内置书源` }); }, () => {}),
              onPullLibrary: (next) => {
                const pending = run(() => call(ctx, 'importSource', { url: next.url, allowHttp: next.allowHttp === true }), '拉取完成');
                pending.then((result) => { if (result) setNotice({ kind: 'info', text: importSummary(result) }); }, () => {});
                return pending.then(() => true, () => false);
              },
              onRemove: (source) => run(() => call(ctx, 'removeSource', { id: source.id || source.bookSourceUrl }), '书源已移除').catch(() => {}) }) : null,
          !loading && tab === 'settings' ? h(Settings, { settings, onSettings: updateSettings, onLocal: localImport, onExport: exportBackup, onImport: importBackup, busy,
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
.mr-content{flex:1;min-width:0;height:100%;overflow-y:auto;padding:24px clamp(20px,3vw,44px);position:relative;background:var(--mr-paper)}.mr-content>div:not(.mr-notice){max-width:1180px;margin:0 auto}
.mr-section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:24px}.mr-section-head h2{font:400 32px/1.2 var(--mr-serif);margin:0;letter-spacing:-.5px;color:var(--mr-text)}.mr-section-head p{margin:7px 0 0;color:var(--mr-muted);font-size:13px}
.mr-section-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mr-view-toggle{display:inline-flex;padding:2px;border:1px solid var(--mr-border);border-radius:8px;background:var(--mr-sunken)}
.mr-view-toggle button{min-height:32px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--mr-muted);font-size:12px}
.mr-view-toggle button.active{background:var(--mr-card);color:var(--mr-text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
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
.mr-shelf-head h1{font:400 32px/1.2 var(--mr-serif);margin:0;color:var(--mr-text);letter-spacing:-.4px}
.mr-shelf-head-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mr-shelf-gallery{display:grid;grid-template-columns:320px 1fr;gap:28px;align-items:stretch}
.mr-tag.failed{background:color-mix(in srgb, #a8422f 18%, transparent);color:#a8422f;border-color:color-mix(in srgb, #a8422f 35%, transparent)}
.mr-new-badge{position:absolute;left:8px;top:8px;z-index:3;display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;font:500 11px/1 var(--mr-sans);letter-spacing:.02em;color:#fff;background:#a8422f;box-shadow:0 1px 3px rgba(0,0,0,.18)}
.mr-dl-badge{position:absolute;right:8px;top:8px;z-index:3;display:inline-flex;align-items:center;justify-content:center;min-width:38px;height:20px;padding:0 7px;border-radius:999px;font:500 11px/1 var(--mr-sans);letter-spacing:.02em;color:var(--mr-on-accent);background:color-mix(in srgb,var(--mr-ink) 72%,transparent);backdrop-filter:blur(6px);cursor:pointer;user-select:none}
.mr-dl-badge:hover{background:color-mix(in srgb,var(--mr-ink) 84%,transparent)}
.mr-dl-badge.queued{background:color-mix(in srgb,var(--mr-ink) 45%,transparent)}
.mr-dl-badge.paused{background:color-mix(in srgb,var(--mr-ink) 55%,transparent)}
.mr-dl-badge.failed{background:#a8422f}
.mr-dl-badge.done{background:color-mix(in srgb,var(--mr-accent) 78%,#000 6%)}
.mr-shelf-piece{position:relative;display:flex;flex-direction:column;gap:10px;min-width:0;padding:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;appearance:none;border-radius:4px;opacity:0;animation:mr-fade-in .2s ease forwards}
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
.mr-shelf-foot{display:flex;align-items:center;justify-content:space-between;gap:16px;border-top:1px solid var(--mr-border);padding-top:12px;margin-top:auto;font-size:11px;color:var(--mr-muted)}
.mr-shelf-foot .wall{color:var(--mr-muted)}
.mr-shelf-folder-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 0 4px}
.mr-folder-chip{min-height:28px;padding:0 12px;border:1px solid var(--mr-border);border-radius:14px;background:var(--mr-card);color:var(--mr-muted);font-size:12px;white-space:nowrap;transition:background .15s,color .15s}
.mr-folder-chip:hover{background:var(--mr-sunken);color:var(--mr-text)}
.mr-folder-chip.active{background:var(--mr-accent);color:var(--mr-on-accent);border-color:var(--mr-accent)}
.mr-folder-add{border-style:dashed;color:var(--mr-accent)}
.mr-folder-del{color:var(--dsw-alias-state-danger-primary,#c44);border-color:var(--dsw-alias-state-danger-primary,#c44)}
.mr-select-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;background:var(--mr-card);border:1px solid var(--mr-border);border-radius:10px;margin:8px 0}
.mr-select-all{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--mr-text);cursor:pointer}
.mr-select-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.mr-shelf-piece.mr-selected{outline:2px solid var(--mr-accent);outline-offset:2px;border-radius:8px}
.mr-select-check{position:absolute;top:6px;left:6px;z-index:2;background:var(--mr-card);border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.15)}
.mr-folder-sheet-backdrop{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.3);backdrop-filter:blur(2px)}
.mr-folder-sheet{width:min(360px,90vw);max-height:60vh;overflow:auto;background:var(--mr-card);border:1px solid var(--mr-border);border-radius:14px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.2)}
.mr-folder-sheet h3{margin:0 0 12px;font-size:16px;color:var(--mr-text)}
.mr-folder-sheet-list{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
.mr-folder-sheet-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--mr-border);border-radius:8px;background:var(--mr-paper);color:var(--mr-text);font-size:14px;text-align:left;cursor:pointer;transition:background .15s}
.mr-folder-sheet-item:hover{background:var(--mr-sunken)}
.mr-sort-select{min-height:32px;padding:0 8px;border:1px solid var(--mr-border);border-radius:6px;background:var(--mr-card);color:var(--mr-text);font-size:12px}
.mr-stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
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
.mr-setting-row{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:15px 0;font-size:13px}.mr-stepper{display:flex;align-items:center;gap:12px}.mr-stepper strong{min-width:42px;text-align:center}.mr-setting-row input[type=range],.mr-drawer input[type=range]{accent-color:var(--mr-accent,var(--reader-accent));height:20px}.mr-mode-picker{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--mr-border);border-radius:8px;background:var(--mr-sunken)}.mr-mode-choice{min-height:32px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--mr-muted);font-size:12px;white-space:nowrap}.mr-mode-choice:hover{color:var(--mr-text)}.mr-mode-choice.active{background:var(--mr-card);color:var(--mr-text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}.mr-theme-picker{display:flex;gap:10px}.mr-swatch{width:34px;height:34px;border-radius:50%;border:2px solid transparent;box-shadow:0 0 0 1px var(--mr-border)}.mr-swatch.active{border-color:var(--mr-accent);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1),0 0 0 4px var(--mr-accent)}.mr-swatch.paper{background:#f4ecdc}.mr-swatch.light{background:#fff}.mr-swatch.green{background:#e3eee5}.mr-swatch.dark{background:#202522}.mr-roadmap p{color:var(--mr-muted);font-size:12px;line-height:1.7;margin:0}
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
.mr-tabbar{display:none}
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
@media(max-width:720px){.mr-shelf-search .kbd{display:none}.mr-root{flex-direction:column;padding-left:0}.mr-section-actions{width:100%;justify-content:space-between}.mr-reader{padding-left:0}.mr-page-window{width:calc(100% - 32px)}.mr-nav{width:100%;flex:0 0 58px;order:2;padding:0 8px;border-right:0;border-top:1px solid var(--mr-border)}.mr-brand,.mr-local{display:none}.mr-nav-items{height:100%;flex-direction:row;justify-content:space-around;gap:0}.mr-nav-items button{min-width:0;min-height:56px;flex:1;flex-direction:column;justify-content:center;gap:2px;padding:3px 4px;font-size:10px;border-radius:8px}.mr-content{order:1;padding:20px 14px}.mr-section-head{flex-wrap:wrap;margin-bottom:18px}.mr-section-head h2{font-size:22px;white-space:nowrap}.mr-book-grid{grid-template-columns:1fr;gap:10px}.mr-book-open{padding:13px}.mr-book-actions{position:relative}.mr-searchbar{flex-wrap:wrap}.mr-searchbar select{max-width:none;width:100%}.mr-searchbar input{flex:1}.mr-result{align-items:flex-start;padding:12px;gap:10px}.mr-result .mr-button{align-self:center;padding-inline:9px}.mr-result-info .mr-intro{-webkit-line-clamp:1}.mr-source-row{flex-wrap:wrap}.mr-source-row .mr-tag{display:none}.mr-panel{padding:16px}.mr-notice{top:-12px}.mr-chapter{width:calc(100% - 40px);padding:64px 0 84px}.mr-chapter-title{font-size:25px}.mr-chapter-no{letter-spacing:.42em;text-indent:.42em}.mr-drawer{left:0;right:0;width:auto}.mr-chapter-meta{letter-spacing:.04em}.mr-modal{padding:0}.mr-set-label{width:56px}}
`;

    return {
      inject: ['slots', 'layout', 'remote'],
      ...(globalThis.__MO_READER_TEST__ ? { __test: { pagination: paginationMath, shelfLayout, scrollMotion } } : {}),
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
