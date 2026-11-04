window.__ModuleLoader__.load({
  id: '@local/mo-reader',
  factory(require) {
    const React = require('react');
    const { z } = require('zod');
    const h = React.createElement;
    const { useEffect, useMemo, useRef, useState } = React;
    const PANEL_ID = 'reader';
    const REMOTE_METHODS = [
      'state', 'importSource', 'removeSource', 'search', 'discover', 'addBook', 'removeBook',
      'toc', 'chapter', 'saveProgress', 'download', 'cancelJob', 'checkUpdates', 'importLocal',
      'setSettings', 'saveNote', 'deleteNote', 'exportBackup', 'importBackup',
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
    };

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

    function Notice({ notice, onClose }) {
      if (!notice) return null;
      return h('div', { className: `mr-notice ${notice.kind || 'info'}`, role: 'status' },
        h('span', null, notice.text), h('button', { onClick: onClose, 'aria-label': '关闭' }, h(Glyph, { name: 'close', size: 16 })));
    }

    function BookCover({ book, small = false }) {
      const cover = book.coverUrl || book.cover;
      return h('div', { className: `mr-cover ${small ? 'small' : ''}` },
        cover ? h('img', { src: cover, alt: '', loading: 'lazy', onError: (event) => { event.currentTarget.style.visibility = 'hidden'; } }) : null,
        h('span', null, (book.name || book.title || '书').slice(0, 1)));
    }

    function Library({ books, onOpen, onDownload, onRemove, onCheck, busy }) {
      if (!books.length) return h(Empty, {
        title: '书架还是空的', detail: '去发现搜书，或导入本地书籍。',
      });
      return h(React.Fragment, null,
        h('div', { className: 'mr-section-head' },
          h('div', null, h('h2', null, '我的书架'), h('p', null, `${books.length} 本 · 本机保存`)),
          h(Button, { icon: 'refresh', onClick: onCheck, disabled: busy }, '补查')),
        h('div', { className: 'mr-book-grid' }, books.map((book) => {
          const id = book.id || book.bookId;
          const name = book.name || book.title || '未命名';
          const unread = Number(book.unread || book.unreadCount || 0);
          const job = book.downloadStatus || book.download?.status;
          return h('article', { className: 'mr-book-card', key: id },
            h('button', { className: 'mr-book-open', onClick: () => onOpen(book) },
              h(BookCover, { book }),
              h('div', { className: 'mr-book-info' },
                h('div', { className: 'mr-book-title-row' }, h('h3', { title: name }, name), unread > 0 ? h('span', { className: 'mr-badge' }, `${unread} 章`) : null),
                h('p', null, book.author || (book.sourceType === 'local' ? '本地书籍' : '未知作者')),
                h('small', null, book.latestChapter || book.lastChapter || (job === 'running' ? '下载中' : '尚未读')))),
            h('div', { className: 'mr-book-actions' },
              h(Button, { kind: 'text', icon: 'download', title: '整本下载', onClick: () => onDownload(book), disabled: busy || job === 'running' || job === 'queued' }, job === 'completed' ? '已下载' : job === 'queued' ? '排队' : '下载'),
              h(Button, { kind: 'text danger', icon: 'trash', title: '移出书架', onClick: () => onRemove(book), disabled: busy }, '移除')));
        })));
    }

    function Discover({ sources, selectedSource, onSource, onSearch, onAdd, results, busy }) {
      const [query, setQuery] = useState('');
      if (!sources.length) return h(Empty, { icon: 'source', title: '先导入书源', detail: '支持 URL、文件或粘贴 JSON。' });
      return h('div', { className: 'mr-discover' },
        h('div', { className: 'mr-section-head' }, h('div', null, h('h2', null, '发现好书'), h('p', null, '搜索当前书源'))),
        h('form', { className: 'mr-searchbar', onSubmit: (event) => { event.preventDefault(); onSearch(query); } },
          h('select', { value: selectedSource, onChange: (e) => onSource(e.target.value), 'aria-label': '书源' },
            sources.map((source) => h('option', { key: source.id || source.bookSourceUrl, value: source.id || source.bookSourceUrl }, source.bookSourceName || source.name || source.bookSourceUrl))),
          h('input', { value: query, onChange: (e) => setQuery(e.target.value), placeholder: '书名或作者', 'aria-label': '搜索' }),
          h(Button, { kind: 'primary', icon: 'search', type: 'submit', disabled: busy }, '搜索')),
        busy ? h('div', { className: 'mr-loading' }, '正在查找…') : null,
        !busy && results && results.length === 0 ? h(Empty, { icon: 'search', title: '没有找到', detail: '换个关键词或书源试试。' }) : null,
        h('div', { className: 'mr-results' }, (results || []).map((book, index) => {
          const name = book.name || book.title || '未命名';
          return h('article', { className: 'mr-result', key: `${book.bookUrl || book.url || name}-${index}` },
            h(BookCover, { book, small: true }),
            h('div', { className: 'mr-result-info' }, h('h3', null, name), h('p', null, [book.author, book.kind].filter(Boolean).join(' · ') || '书籍'), book.intro ? h('p', { className: 'mr-intro' }, book.intro) : null),
            h(Button, { kind: 'primary soft', icon: 'plus', onClick: () => onAdd(book), disabled: busy }, '加书架'));
        })));
    }

    function Sources({ sources, onImport, onRemove, busy }) {
      const [draft, setDraft] = useState('');
      const [allowHttp, setAllowHttp] = useState(false);
      const fileRef = useRef(null);
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
            h('input', { ref: fileRef, type: 'file', accept: '.json,application/json', hidden: true, onChange: async (e) => { const file = e.target.files?.[0]; if (file) setDraft(await file.text()); e.target.value = ''; } }))),
        h('section', { className: 'mr-source-list' }, sources.length ? sources.map((source) => {
          const id = source.id || source.bookSourceUrl;
          return h('article', { className: 'mr-source-row', key: id },
            h('div', { className: 'mr-source-mark' }, h(Glyph, { name: 'source' })),
            h('div', null, h('h3', null, source.bookSourceName || source.name || '书源'), h('p', { title: source.bookSourceUrl }, source.bookSourceUrl)),
            h('span', { className: 'mr-tag' }, source.compatibility || '基础规则'),
            h(Button, { kind: 'text danger', icon: 'trash', onClick: () => onRemove(source), disabled: busy }, '移除'));
        }) : h(Empty, { icon: 'source', title: '暂无书源', detail: '导入后即可搜索和追更。' })));
    }

    function Settings({ settings, onSettings, onLocal, onExport, onImport, busy }) {
      const [replacementText, setReplacementText] = useState(() => (settings.replacements || []).map((rule) => `${rule.pattern || rule.from || ''}=>${rule.replacement || rule.to || ''}`).join('\n'));
      const localRef = useRef(null);
      const backupRef = useRef(null);
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
        h('section', { className: 'mr-panel mr-roadmap' }, h('h3', null, '分期说明'), h('p', null, '当前为文字核心版。高兼容脚本、AI 与多媒体将在后续阶段提供。')));
    }

    function ReaderView({ ctx, book, settings, onSettings, notes, onClose, onSaveNote, onDeleteNote, notify }) {
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
      const scrollRef = useRef(null);
      const requestRef = useRef(0);
      const speechGeneration = useRef(0);
      const saveTimer = useRef(null);
      const progressRef = useRef({ bookId: book.id || book.bookId, chapterId: null, percent: 0 });
      const bookId = book.id || book.bookId;
      const theme = settings.readerTheme || 'paper';
      const flushProgress = () => {
        clearTimeout(saveTimer.current);
        const payload = { ...progressRef.current };
        return payload.chapterId ? call(ctx, 'saveProgress', payload).catch(() => {}) : Promise.resolve();
      };
      const closeReader = async () => {
        await flushProgress();
        onClose();
      };

      const openChapter = async (index, restore = false) => {
        if (!toc[index]) return;
        const requestId = ++requestRef.current;
        flushProgress();
        setLoading(true); setError(''); setDrawer(''); setFailedIndex(index);
        stopSpeech();
        try {
          const item = toc[index];
          const id = item.id || item.chapterId || item.url || item.chapterUrl || String(index);
          const value = await call(ctx, 'chapter', { bookId, chapterId: id });
          if (requestId !== requestRef.current) return;
          setChapter(value || {});
          setChapterIndex(index);
          setFailedIndex(-1);
          const saved = restore ? Number(book.lastRead?.percent || book.progress?.percent || book.percent || 0) : 0;
          progressRef.current = { bookId, chapterId: id, percent: saved };
          setScrollPercent(saved);
          requestAnimationFrame(() => {
            if (!scrollRef.current) return;
            scrollRef.current.scrollTop = saved > 0 ? saved / 100 * (scrollRef.current.scrollHeight - scrollRef.current.clientHeight) : 0;
          });
        } catch (cause) { if (requestId === requestRef.current) setError(cause.message || String(cause)); }
        finally { if (requestId === requestRef.current) setLoading(false); }
      };

      useEffect(() => {
        let active = true;
        const requestId = ++requestRef.current;
        (async () => {
          try {
            const result = await call(ctx, 'toc', { bookId });
            const list = Array.isArray(result) ? result : result?.chapters || result?.items || [];
            if (!active || requestId !== requestRef.current) return;
            setToc(list);
            const savedId = book.lastRead?.chapterId || book.progress?.chapterId || book.chapterId;
            const index = Math.max(0, list.findIndex((item, i) => (item.id || item.chapterId || item.url || item.chapterUrl || String(i)) === savedId));
            if (list.length) {
              setFailedIndex(index);
              const item = list[index];
              const id = item.id || item.chapterId || item.url || item.chapterUrl || String(index);
              const value = await call(ctx, 'chapter', { bookId, chapterId: id });
              if (!active || requestId !== requestRef.current) return;
              setChapter(value || {}); setChapterIndex(index); setFailedIndex(-1);
              const saved = Number(book.lastRead?.percent || book.progress?.percent || book.percent || 0);
              progressRef.current = { bookId, chapterId: id, percent: saved };
              setScrollPercent(saved);
              requestAnimationFrame(() => {
                if (!scrollRef.current) return;
                scrollRef.current.scrollTop = saved > 0 ? saved / 100 * (scrollRef.current.scrollHeight - scrollRef.current.clientHeight) : 0;
              });
            }
          } catch (cause) { if (active && requestId === requestRef.current) setError(cause.message || String(cause)); }
          finally { if (active && requestId === requestRef.current) setLoading(false); }
        })();
        return () => { active = false; speechGeneration.current += 1; window.speechSynthesis?.cancel(); flushProgress(); };
      }, [bookId, retryNonce]);

      useEffect(() => {
        if (!drawer) return;
        const onKeyDown = (event) => { if (event.key === 'Escape') setDrawer(''); };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [drawer]);

      const stopSpeech = () => { speechGeneration.current += 1; window.speechSynthesis?.cancel(); setSpeaking(false); };
      const speak = () => {
        if (!('speechSynthesis' in window)) return notify('当前环境不支持系统语音', 'error');
        if (speaking) return stopSpeech();
        const text = String(chapter?.content || chapter?.text || '').trim();
        if (!text) return;
        const generation = ++speechGeneration.current;
        setSpeaking(true);
        const chunks = text.match(/[^。！？!?\n]{1,140}[。！？!?\n]?/g) || [text];
        let index = 0;
        const next = () => {
          if (generation !== speechGeneration.current) return;
          if (index >= chunks.length) return setSpeaking(false);
          const utterance = new SpeechSynthesisUtterance(chunks[index++]);
          utterance.rate = Number(settings.ttsRate || 1);
          utterance.onend = next;
          utterance.onerror = () => { if (generation === speechGeneration.current) setSpeaking(false); };
          window.speechSynthesis.speak(utterance);
        };
        next();
      };

      const onScroll = () => {
        if (!scrollRef.current || chapterIndex < 0) return;
        const el = scrollRef.current;
        const max = Math.max(1, el.scrollHeight - el.clientHeight);
        const percent = Math.round(el.scrollTop / max * 100);
        setScrollPercent(percent);
        const item = toc[chapterIndex];
        const chapterId = item && (item.id || item.chapterId || item.url || item.chapterUrl || String(chapterIndex));
        const payload = { bookId, chapterId, percent };
        progressRef.current = payload;
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => call(ctx, 'saveProgress', payload).catch(() => {}), 600);
      };

      const makeNote = () => {
        const selection = String(window.getSelection?.() || '').trim();
        setQuote(selection); setDrawer('notes');
        requestAnimationFrame(() => document.querySelector('.mr-note-editor textarea')?.focus());
      };
      const chapterNotes = notes.filter((note) => note.bookId === bookId && (!chapter || note.chapterId === progressRef.current.chapterId));
      const paragraphs = useMemo(() => String(chapter?.content || chapter?.text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean), [chapter]);
      const name = chapter?.name || chapter?.title || toc[chapterIndex]?.name || toc[chapterIndex]?.title || '正文';

      return h('div', { className: `mr-reader theme-${theme} font-${settings.fontFamily || 'serif'}` },
        h('header', { className: 'mr-reader-header' },
          h(Button, { kind: 'icon', icon: 'back', onClick: closeReader, title: '返回书架' }),
          h('div', { className: 'mr-reader-heading' }, h('strong', null, book.name || book.title || '本地书籍'), h('small', null, toc.length ? `${chapterIndex + 1}/${toc.length}` : '本地书籍')),
          h(Button, { kind: 'icon', icon: speaking ? 'stop' : 'play', onClick: speak, title: speaking ? '停止' : '听书' }),
          h(Button, { kind: 'icon', icon: 'note', onPointerDown: (event) => event.preventDefault(), onClick: makeNote, title: '笔记' }),
          h(Button, { kind: 'icon', icon: 'settings', onClick: () => setDrawer(drawer === 'settings' ? '' : 'settings'), title: '排版' }),
          h(Button, { kind: 'icon', icon: 'list', onClick: () => setDrawer(drawer === 'toc' ? '' : 'toc'), title: '目录' })),
        h('div', { className: 'mr-reading-progress', style: { width: `${scrollPercent}%` } }),
        h('main', { className: 'mr-chapter-scroll', ref: scrollRef, onScroll },
          loading ? h('div', { className: 'mr-loading' }, '正在打开章节…') : error ? h('div', { className: 'mr-error-block' }, h('p', null, error), h(Button, { onClick: () => { if (toc.length && failedIndex >= 0) openChapter(failedIndex); else { setLoading(true); setError(''); setRetryNonce((value) => value + 1); } } }, '重试')) :
            h('article', { className: 'mr-chapter', style: { fontSize: `${settings.fontSize || 20}px`, lineHeight: settings.lineHeight || 1.9 } },
              h('h1', null, name), paragraphs.map((line, index) => h('p', { key: index }, line)),
              !paragraphs.length ? h(Empty, { title: '本章无正文', detail: '可尝试刷新目录。' }) : null,
              h('div', { className: 'mr-chapter-end' }, chapterIndex + 1 < toc.length ? h(Button, { kind: 'primary soft', onClick: () => openChapter(chapterIndex + 1) }, '下一章') : h('span', null, '已是最后一章')))),
        h('footer', { className: 'mr-reader-footer' },
          h(Button, { kind: 'text', icon: 'back', disabled: chapterIndex <= 0 || loading, onClick: () => openChapter(chapterIndex - 1) }, '上一章'),
          h('span', null, chapterIndex >= 0 ? `${Math.round((chapterIndex + 1) / Math.max(1, toc.length) * 100)}%` : ''),
          h(Button, { kind: 'text', icon: 'next', disabled: chapterIndex + 1 >= toc.length || loading, onClick: () => openChapter(chapterIndex + 1) }, '下一章')),
        drawer ? h('div', { className: 'mr-drawer-backdrop', onClick: () => setDrawer('') }) : null,
        drawer ? h('aside', { className: 'mr-drawer', role: 'dialog', 'aria-modal': true, 'aria-label': drawer === 'toc' ? '目录' : drawer === 'notes' ? '笔记' : '排版' },
          h('div', { className: 'mr-drawer-head' }, h('h2', null, drawer === 'toc' ? '目录' : drawer === 'notes' ? '笔记' : '排版'), h(Button, { kind: 'icon', icon: 'close', onClick: () => setDrawer('') })),
          drawer === 'toc' ? h('div', { className: 'mr-toc' }, toc.map((item, index) => h('button', { key: item.id || item.chapterId || item.url || index, className: index === chapterIndex ? 'active' : '', onClick: () => openChapter(index) }, item.name || item.title || `第 ${index + 1} 章`))) : null,
          drawer === 'settings' ? h('div', { className: 'mr-drawer-body' },
            h('label', null, '字号'), h('div', { className: 'mr-stepper' }, h(Button, { onClick: () => onSettings({ fontSize: Math.max(14, settings.fontSize - 1) }) }, '减小'), h('strong', null, settings.fontSize), h(Button, { onClick: () => onSettings({ fontSize: Math.min(36, settings.fontSize + 1) }) }, '增大')),
            h('label', null, '行距'), h('input', { type: 'range', min: 1.4, max: 2.5, step: .1, value: settings.lineHeight, onChange: (e) => onSettings({ lineHeight: Number(e.target.value) }) }),
            h('label', null, '字体'), h('select', { value: settings.fontFamily, onChange: (e) => onSettings({ fontFamily: e.target.value }) }, h('option', { value: 'serif' }, '衬线'), h('option', { value: 'sans' }, '黑体')),
            h('label', null, '纸张'), h('div', { className: 'mr-theme-picker' }, ['paper', 'light', 'green', 'dark'].map((item) => h('button', { key: item, className: `mr-swatch ${item} ${theme === item ? 'active' : ''}`, 'aria-label': ({ paper: '米黄', light: '白色', green: '浅绿', dark: '深色' })[item], onClick: () => onSettings({ readerTheme: item }) }))),
            h('label', null, '语速'), h('input', { type: 'range', min: .5, max: 2, step: .1, value: settings.ttsRate || 1, onChange: (e) => onSettings({ ttsRate: Number(e.target.value) }) })) : null,
          drawer === 'notes' ? h('div', { className: 'mr-drawer-body' },
            quote ? h('blockquote', null, quote) : null,
            h('div', { className: 'mr-note-editor' }, h('textarea', { rows: 4, value: noteText, onChange: (e) => setNoteText(e.target.value), placeholder: '写下想法…' }), h(Button, { kind: 'primary', disabled: !noteText.trim(), onClick: async () => { try { await onSaveNote({ bookId, chapterId: progressRef.current.chapterId, text: noteText, quote }); setNoteText(''); setQuote(''); } catch {} } }, '保存')),
            h('div', { className: 'mr-notes' }, chapterNotes.map((note) => h('article', { key: note.id }, note.quote ? h('blockquote', null, note.quote) : null, h('p', null, note.text), h(Button, { kind: 'text danger', icon: 'trash', onClick: () => onDeleteNote(note) }, '删除'))))) : null) : null);
    }

    function ReaderApp({ ctx }) {
      const [data, setData] = useState({ sources: [], books: [], jobs: [], notes: [], settings: DEFAULT_SETTINGS });
      const [tab, setTab] = useState('library');
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const [selectedSource, setSelectedSource] = useState('');
      const [results, setResults] = useState(null);
      const [resultSource, setResultSource] = useState('');
      const [reading, setReading] = useState(null);
      const mounted = useRef(true);
      const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
      const sources = (data.sources || []).filter((source) => (source.id || source.bookSourceUrl) !== 'local' && source.bookSourceUrl !== 'local:');
      const books = (data.books || []).map((book) => {
        const job = (data.jobs || []).find((item) => item.bookId === (book.id || book.bookId));
        return job ? { ...book, downloadStatus: job.status, download: job } : book;
      });
      const notes = data.notes || [];
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
        const timer = setInterval(() => { refresh(true); }, 5000);
        return () => { mounted.current = false; clearInterval(timer); };
      }, []);

      const run = async (operation, success) => {
        setBusy(true);
        try { const value = await operation(); await refresh(true); if (success) notify(success, 'success'); return value; }
        catch (cause) { notify(cause.message || String(cause), 'error'); throw cause; }
        finally { setBusy(false); }
      };
      const importSource = (draft, allowHttp) => run(() => {
        const value = draft.trim();
        return call(ctx, 'importSource', /^https?:\/\//i.test(value) ? { url: value, allowHttp } : { text: value, allowHttp });
      }, '书源已导入');
      const search = (query) => {
        const sourceId = selectedSource;
        return run(() => call(ctx, query.trim() ? 'search' : 'discover', { sourceId, query, page: 1 }).then((value) => {
          setResults(Array.isArray(value) ? value : value?.items || value?.books || []);
          setResultSource(sourceId);
        })).catch(() => {});
      };
      const addBook = (book) => run(() => call(ctx, 'addBook', { sourceId: resultSource || selectedSource, bookUrl: book.bookUrl || book.url, download: true }), '已加入书架，开始下载').catch(() => {});
      const updateSettings = (partial) => {
        setData((current) => ({ ...current, settings: { ...current.settings, ...partial } }));
        return call(ctx, 'setSettings', partial).catch((cause) => notify(cause.message || String(cause), 'error'));
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
          await call(ctx, 'importLocal', args); await refresh(true); notify('书籍已导入', 'success'); setTab('library');
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
      const nav = [
        ['library', '书架', 'shelf'], ['discover', '发现', 'compass'], ['sources', '书源', 'source'], ['settings', '设置', 'settings'],
      ];
      if (reading) return h(React.Fragment, null, h('style', null, css), h(ReaderView, { ctx, book: reading, settings, notes, onSettings: updateSettings, onClose: () => { setReading(null); refresh(true); }, onSaveNote: saveNote, onDeleteNote: (note) => run(() => call(ctx, 'deleteNote', { id: note.id })).catch(() => {}), notify }));

      return h(React.Fragment, null, h('style', null, css), h('div', { className: 'mr-root' },
        h('nav', { className: 'mr-nav', 'aria-label': '墨读' },
          h('div', { className: 'mr-brand' }, h(ReaderIcon, { size: 30 }), h('div', null, h('strong', null, '墨读'), h('small', null, '读想读的书'))),
          h('div', { className: 'mr-nav-items' }, nav.map(([id, label, icon]) => h('button', { key: id, className: tab === id ? 'active' : '', onClick: () => setTab(id) }, h(Glyph, { name: icon }), h('span', null, label)))),
          h('div', { className: 'mr-local' }, h('span', null), '本机保存')),
        h('section', { className: 'mr-content' },
          h(Notice, { notice, onClose: () => setNotice(null) }),
          loading ? h('div', { className: 'mr-loading' }, '正在打开墨读…') : null,
          !loading && tab === 'library' ? h(Library, { books, busy, onOpen: setReading, onDownload: (book) => run(() => call(ctx, 'download', { bookId: book.id || book.bookId }), '下载已开始').catch(() => {}), onRemove: (book) => run(() => call(ctx, 'removeBook', { bookId: book.id || book.bookId }), '已移出书架').catch(() => {}), onCheck: () => run(() => call(ctx, 'checkUpdates'), '补查完成').catch(() => {}) }) : null,
          !loading && tab === 'discover' ? h(Discover, { sources, selectedSource, onSource: (sourceId) => { setSelectedSource(sourceId); setResults(null); setResultSource(''); }, onSearch: search, onAdd: addBook, results, busy }) : null,
          !loading && tab === 'sources' ? h(Sources, { sources, busy, onImport: importSource, onRemove: (source) => run(() => call(ctx, 'removeSource', { id: source.id || source.bookSourceUrl }), '书源已移除').catch(() => {}) }) : null,
          !loading && tab === 'settings' ? h(Settings, { settings, onSettings: updateSettings, onLocal: localImport, onExport: exportBackup, onImport: importBackup, busy }) : null)));
    }

    const css = String.raw`
.mr-root{--mr-accent:var(--dsw-alias-brand-primary);--mr-text:var(--dsw-alias-label-primary);--mr-muted:var(--dsw-alias-label-secondary);--mr-border:var(--dsw-alias-border-l1);height:100%;min-height:0;display:flex;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--mr-text);font-family:var(--dsw-font-family,system-ui,sans-serif)}
.mr-root *,.mr-reader *{box-sizing:border-box}.mr-root button,.mr-root input,.mr-root textarea,.mr-root select,.mr-reader button,.mr-reader input,.mr-reader textarea,.mr-reader select{font:inherit}.mr-root button,.mr-reader button{cursor:pointer}.mr-root button:disabled,.mr-reader button:disabled{cursor:not-allowed;opacity:.45}
.mr-nav{width:176px;flex:0 0 176px;display:flex;flex-direction:column;padding:24px 14px 16px;border-right:1px solid var(--mr-border);background:var(--dsw-alias-bg-layer-1)}
.mr-brand{display:flex;align-items:center;gap:10px;padding:0 10px 28px;color:var(--mr-accent)}.mr-brand strong{display:block;font-size:21px;letter-spacing:2px}.mr-brand small{display:block;color:var(--mr-muted);font-size:11px;margin-top:2px;letter-spacing:0}
.mr-nav-items{display:flex;flex-direction:column;gap:6px}.mr-nav-items button{min-height:44px;border:0;border-radius:10px;background:transparent;color:var(--mr-muted);display:flex;align-items:center;gap:12px;padding:0 14px;text-align:left}.mr-nav-items button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--mr-text)}.mr-nav-items button.active{background:color-mix(in srgb,var(--mr-accent) 12%,transparent);color:var(--mr-accent);font-weight:650}
.mr-local{margin-top:auto;color:var(--mr-muted);font-size:11px;display:flex;align-items:center;gap:7px;padding:10px}.mr-local span{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.mr-content{flex:1;min-width:0;height:100%;overflow-y:auto;padding:32px clamp(20px,4vw,54px);position:relative}.mr-content>div:not(.mr-notice){max-width:1180px;margin:0 auto}
.mr-section-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}.mr-section-head h2{font-size:25px;line-height:1.25;margin:0;letter-spacing:-.5px}.mr-section-head p{margin:7px 0 0;color:var(--mr-muted);font-size:13px}
.mr-button{min-height:38px;padding:7px 13px;border:1px solid var(--mr-border);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--mr-text);display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:13px;white-space:nowrap}.mr-button:hover:not(:disabled){border-color:var(--mr-accent)}.mr-button.primary{background:var(--mr-accent);border-color:var(--mr-accent);color:var(--dsw-alias-bg-base)}.mr-button.soft{background:color-mix(in srgb,var(--mr-accent) 12%,var(--dsw-alias-bg-layer-1));color:var(--mr-accent)}.mr-button.text{border-color:transparent;background:transparent;color:var(--mr-muted);padding-inline:8px}.mr-button.danger{color:var(--dsw-alias-state-error-primary)}.mr-button.icon{width:40px;height:40px;min-height:40px;padding:0;border-color:transparent;background:transparent;color:inherit}
.mr-book-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(225px,1fr));gap:16px}.mr-book-card{border:1px solid var(--mr-border);background:var(--dsw-alias-bg-layer-1);border-radius:14px;overflow:hidden;transition:border-color .15s,transform .15s}.mr-book-card:hover{border-color:color-mix(in srgb,var(--mr-accent) 45%,var(--mr-border));transform:translateY(-1px)}.mr-book-open{border:0;background:transparent;color:inherit;width:100%;padding:18px 16px 12px;display:flex;gap:14px;text-align:left;min-width:0}.mr-book-info{min-width:0;flex:1}.mr-book-title-row{display:flex;gap:6px;align-items:flex-start}.mr-book-info h3{font-size:16px;line-height:1.4;margin:1px 0 8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.mr-book-info p,.mr-book-info small{margin:0;color:var(--mr-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}.mr-book-info small{font-size:11px;margin-top:12px}.mr-badge{flex:0 0 auto;background:var(--dsw-alias-state-error-primary);color:white;font-size:10px;padding:2px 6px;border-radius:10px}.mr-book-actions{display:flex;justify-content:space-between;border-top:1px solid var(--mr-border);padding:3px 8px}
.mr-cover{position:relative;flex:0 0 66px;width:66px;height:94px;border-radius:6px;background:linear-gradient(145deg,color-mix(in srgb,var(--mr-accent) 35%,var(--dsw-alias-bg-layer-2)),var(--dsw-alias-bg-layer-2));box-shadow:0 4px 12px #0002;overflow:hidden;display:flex;align-items:center;justify-content:center}.mr-cover.small{width:52px;height:74px;flex-basis:52px}.mr-cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1}.mr-cover>span{font-family:serif;font-size:28px;color:var(--mr-accent);opacity:.65}
.mr-empty{text-align:center;padding:70px 20px;color:var(--mr-muted)}.mr-empty-icon{width:58px;height:58px;border-radius:18px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;color:var(--mr-accent)}.mr-empty h3{color:var(--mr-text);font-size:17px;margin:0 0 8px}.mr-empty p{font-size:13px;margin:0;line-height:1.7}
.mr-searchbar{display:flex;gap:10px;margin-bottom:22px}.mr-searchbar select{max-width:190px}.mr-root input,.mr-root textarea,.mr-root select,.mr-reader input,.mr-reader textarea,.mr-reader select{border:1px solid var(--mr-border);border-radius:9px;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));color:var(--mr-text);padding:10px 12px;outline:none}.mr-root input:focus,.mr-root textarea:focus,.mr-root select:focus,.mr-reader textarea:focus{border-color:var(--mr-accent)}.mr-searchbar input{flex:1;min-width:0}.mr-searchbar select{min-width:130px}.mr-results{display:flex;flex-direction:column;gap:10px}.mr-result{display:flex;align-items:center;gap:15px;padding:14px;border:1px solid var(--mr-border);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}.mr-result-info{flex:1;min-width:0}.mr-result-info h3{font-size:15px;margin:0 0 5px}.mr-result-info p{font-size:12px;color:var(--mr-muted);margin:0}.mr-result-info .mr-intro{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:7px;line-height:1.5}
.mr-panel{border:1px solid var(--mr-border);border-radius:13px;background:var(--dsw-alias-bg-layer-1);padding:20px;margin-bottom:16px}.mr-panel h3{font-size:15px;margin:0 0 14px}.mr-panel textarea{width:100%;resize:vertical;line-height:1.6}.mr-help{font-size:12px;color:var(--mr-muted);line-height:1.6}.mr-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--mr-muted);margin-top:12px}.mr-check input{width:16px;height:16px;padding:0}.mr-inline-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:12px}.mr-source-list{display:flex;flex-direction:column;gap:9px}.mr-source-row{display:flex;align-items:center;gap:12px;padding:13px 15px;border:1px solid var(--mr-border);border-radius:11px;background:var(--dsw-alias-bg-layer-1)}.mr-source-row>div:nth-child(2){flex:1;min-width:0}.mr-source-row h3{font-size:14px;margin:0 0 4px}.mr-source-row p{font-size:11px;color:var(--mr-muted);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mr-source-mark{color:var(--mr-accent)}.mr-tag{font-size:10px;border:1px solid var(--mr-border);padding:3px 7px;border-radius:10px;color:var(--mr-muted);white-space:nowrap}
.mr-setting-row{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:15px 0;font-size:13px}.mr-stepper{display:flex;align-items:center;gap:12px}.mr-stepper strong{min-width:42px;text-align:center}.mr-theme-picker{display:flex;gap:10px}.mr-swatch{width:34px;height:34px;border-radius:50%;border:2px solid transparent;box-shadow:0 0 0 1px var(--mr-border)}.mr-swatch.active{border-color:var(--mr-accent);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1),0 0 0 4px var(--mr-accent)}.mr-swatch.paper{background:#f4ecdc}.mr-swatch.light{background:#fff}.mr-swatch.green{background:#e3eee5}.mr-swatch.dark{background:#202522}.mr-roadmap p{color:var(--mr-muted);font-size:12px;line-height:1.7;margin:0}
.mr-notice{position:sticky;top:-20px;z-index:20;margin:-12px auto 16px;max-width:760px;padding:11px 13px;border-radius:10px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--mr-border);box-shadow:0 5px 20px #0002;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px}.mr-notice.error{border-color:var(--dsw-alias-state-error-primary)}.mr-notice.success{border-color:var(--dsw-alias-state-success-primary)}.mr-notice button{border:0;background:transparent;color:inherit;padding:4px;display:flex}.mr-loading{text-align:center;color:var(--mr-muted);font-size:13px;padding:36px}.mr-error-block{text-align:center;padding:50px 20px;color:var(--dsw-alias-state-error-primary)}
.mr-reader{--reader-bg:#f4ecdc;--reader-text:#342f27;--reader-muted:#857b68;--reader-border:#d9cfbb;height:100%;min-height:0;display:flex;flex-direction:column;position:relative;overflow:hidden;background:var(--reader-bg);color:var(--reader-text)}.mr-reader.theme-light{--reader-bg:#fff;--reader-text:#292d2b;--reader-muted:#7b817e;--reader-border:#e3e6e4}.mr-reader.theme-green{--reader-bg:#e3eee5;--reader-text:#2d3c31;--reader-muted:#708275;--reader-border:#c5d5c9}.mr-reader.theme-dark{--reader-bg:#202522;--reader-text:#d4d9d5;--reader-muted:#87918b;--reader-border:#3b4540}.mr-reader-header{height:58px;flex:0 0 58px;display:flex;align-items:center;gap:3px;padding:0 14px;border-bottom:1px solid var(--reader-border);background:var(--reader-bg);z-index:3}.mr-reader-heading{flex:1;min-width:0;text-align:center}.mr-reader-heading strong,.mr-reader-heading small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mr-reader-heading strong{font-size:14px}.mr-reader-heading small{font-size:10px;color:var(--reader-muted);margin-top:3px}.mr-reading-progress{height:2px;background:var(--mr-accent,var(--dsw-alias-brand-primary));position:absolute;top:57px;left:0;z-index:4;transition:width .2s}
.mr-chapter-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}.mr-chapter{width:min(100% - 40px,720px);margin:0 auto;padding:46px 0 70px;font-family:Georgia,'Noto Serif SC','Songti SC',serif}.font-sans .mr-chapter{font-family:system-ui,'Noto Sans SC',sans-serif}.mr-chapter h1{font-size:1.35em;line-height:1.5;margin:0 0 32px;font-weight:650}.mr-chapter p{margin:0 0 1em;text-align:justify;overflow-wrap:anywhere}.mr-chapter-end{display:flex;justify-content:center;padding:28px 0;color:var(--reader-muted);font-size:12px}.mr-reader-footer{height:50px;flex:0 0 50px;border-top:1px solid var(--reader-border);display:flex;align-items:center;justify-content:space-between;padding:0 18px;color:var(--reader-muted);font-size:11px;background:var(--reader-bg)}
.mr-drawer-backdrop{position:absolute;inset:0;background:#0004;z-index:8}.mr-drawer{position:absolute;top:0;right:0;bottom:0;width:min(390px,88%);z-index:9;background:var(--reader-bg);border-left:1px solid var(--reader-border);box-shadow:-12px 0 30px #0002;display:flex;flex-direction:column}.mr-drawer-head{height:58px;flex:0 0 58px;padding:0 14px 0 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--reader-border)}.mr-drawer-head h2{font-size:16px}.mr-toc{overflow-y:auto;padding:8px}.mr-toc button{display:block;width:100%;min-height:42px;text-align:left;padding:10px 12px;border:0;border-radius:7px;background:transparent;color:var(--reader-text);font-size:13px;line-height:1.5}.mr-toc button:hover,.mr-toc button.active{background:color-mix(in srgb,var(--reader-text) 8%,transparent)}.mr-toc button.active{color:var(--mr-accent,var(--dsw-alias-brand-primary));font-weight:600}.mr-drawer-body{padding:20px;overflow-y:auto}.mr-drawer-body>label{display:block;font-size:12px;color:var(--reader-muted);margin:20px 0 9px}.mr-drawer-body>label:first-child{margin-top:0}.mr-drawer-body input[type=range],.mr-drawer-body select{width:100%}.mr-note-editor textarea{width:100%;resize:vertical;background:transparent;color:var(--reader-text);border-color:var(--reader-border)}.mr-note-editor .mr-button{margin-top:8px}.mr-notes{margin-top:20px}.mr-notes article{border-top:1px solid var(--reader-border);padding:14px 0;font-size:13px}.mr-notes blockquote,.mr-drawer-body>blockquote{margin:0 0 12px;padding:9px 12px;border-left:3px solid var(--reader-muted);color:var(--reader-muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere}.mr-notes p{line-height:1.6;white-space:pre-wrap}
@media(max-width:720px){.mr-root{flex-direction:column;padding-left:88px}.mr-reader{padding-left:88px}.mr-nav{width:100%;flex:0 0 58px;order:2;padding:0 8px;border-right:0;border-top:1px solid var(--mr-border)}.mr-brand,.mr-local{display:none}.mr-nav-items{height:100%;flex-direction:row;justify-content:space-around;gap:0}.mr-nav-items button{min-width:0;min-height:56px;flex:1;flex-direction:column;justify-content:center;gap:2px;padding:3px 4px;font-size:10px;border-radius:8px}.mr-content{order:1;padding:20px 14px}.mr-section-head{margin-bottom:18px}.mr-section-head h2{font-size:22px}.mr-book-grid{grid-template-columns:1fr;gap:10px}.mr-book-open{padding:13px}.mr-book-actions{position:relative}.mr-searchbar{flex-wrap:wrap}.mr-searchbar select{max-width:none;width:100%}.mr-searchbar input{flex:1}.mr-result{align-items:flex-start;padding:12px;gap:10px}.mr-result .mr-button{align-self:center;padding-inline:9px}.mr-result-info .mr-intro{-webkit-line-clamp:1}.mr-source-row{flex-wrap:wrap}.mr-source-row .mr-tag{display:none}.mr-panel{padding:16px}.mr-notice{top:-12px}.mr-reader-header{padding:0 5px}.mr-reader-heading strong{font-size:12px}.mr-chapter{width:calc(100% - 34px);padding-top:30px}.mr-chapter h1{margin-bottom:24px}.mr-drawer{width:92%}}
`;

    return {
      inject: ['slots', 'layout', 'remote'],
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
