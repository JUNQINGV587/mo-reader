import type { ReactNode } from 'react'
import { GlassCanvas } from './GlassCanvas'
import { books, readingBook, readingMeta, type Book } from '../data/books'

const icons = {
  shelf: (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 14h16" />
    </svg>
  ),
  find: (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
      <path d="M8 11h6" />
    </svg>
  ),
  source: (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 5h9l5 5v9H5z" />
      <path d="M14 5v5h5" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 1 0 .6 4" />
      <path d="M20 4v7h-7" />
    </svg>
  ),
}

export function Cover({ book, bare }: { book: Book; bare?: boolean }) {
  const hueStyle = { '--h': book.hue } as React.CSSProperties
  if (book.art) {
    return (
      <span className={`cover art${bare ? ' bare' : ''}`} style={hueStyle}>
        <span className="art-title">{book.title}</span>
      </span>
    )
  }
  return (
    <span className={`cover${bare ? ' bare' : ''}`} style={hueStyle}>
      <span className="fallback">
        <span className={`ft${book.latin ? ' latin' : ''}`}>{book.title}</span>
        <span className="seal">{book.seal}</span>
      </span>
    </span>
  )
}

export function BookCard({ book }: { book: Book }) {
  return (
    <button className="book" type="button">
      <Cover book={book} />
      <span className="meta">
        <strong>{book.title}</strong>
        <small>{book.subtitle}</small>
      </span>
    </button>
  )
}

export function Grid({ items }: { items: Book[] }) {
  return (
    <div className="grid">
      {items.map((book) => (
        <BookCard key={book.title} book={book} />
      ))}
    </div>
  )
}

export function Library({ children, count = 8 }: { children: ReactNode; count?: number }) {
  return (
    <div className="library">
      <h2>
        全部书籍
        <span>{count} 本</span>
      </h2>
      {children}
    </div>
  )
}

export function Hero({ book = readingBook }: { book?: Book }) {
  return (
    <div className="hero">
      <Cover book={book} bare />
      <div>
        <p className="eyebrow">继续阅读</p>
        <h2>{book.title}</h2>
        <p className="by">
          {book.subtitle} · {readingMeta.chapter} · 已读 {readingMeta.percent}%
        </p>
        <div className="progress">
          <i />
        </div>
        <button className="cta" type="button">
          继续阅读
        </button>
      </div>
    </div>
  )
}

export function Focus({ book = readingBook }: { book?: Book }) {
  return (
    <div className="focus">
      <Cover book={book} />
      <h2>{book.title}</h2>
      <p className="by">
        {book.subtitle} · 已读 {readingMeta.percent}%
      </p>
      <div className="progress">
        <i />
      </div>
      <div className="pg">
        <span>{readingMeta.chapter}</span>
        <span>{readingMeta.percent}%</span>
      </div>
      <button className="cta" type="button">
        继续阅读
      </button>
    </div>
  )
}

export function Panel({ children, hint }: { children: ReactNode; hint: string }) {
  return (
    <div className="panel">
      <div className="shelf">
        {children}
        <div className="plank" />
      </div>
      <div className="hint">{hint}</div>
    </div>
  )
}

export function ShelfRow({ items }: { items: Book[] }) {
  return (
    <div className="shelf-row">
      {items.map((book) => (
        <BookCard key={book.title} book={book} />
      ))}
    </div>
  )
}

export function Spines() {
  return (
    <div className="shelf-row spines">
      {books.map((book) => (
        <button
          key={book.title}
          className="spine"
          type="button"
          style={{ '--w': book.spineWidth, '--ht': book.spineHeight } as React.CSSProperties}
        >
          <span className={`spine-title${book.latin ? ' latin' : ''}`}>{book.title}</span>
          <span className="spine-peek">
            <Cover book={book} bare />
          </span>
        </button>
      ))}
    </div>
  )
}

export function Side() {
  return (
    <aside className="side">
      <div className="brand">
        <span className="logo">墨</span>
        <div>
          <strong>墨读</strong>
          <small>读想读的书</small>
        </div>
      </div>
      <nav className="nav">
        <button type="button" className="on">
          <span className="ni">{icons.shelf}</span>书架
        </button>
        <button type="button">
          <span className="ni">{icons.find}</span>发现
        </button>
        <button type="button">
          <span className="ni">{icons.source}</span>书源
        </button>
        <button type="button">
          <span className="ni">{icons.settings}</span>设置
        </button>
      </nav>
    </aside>
  )
}

export function Head() {
  return (
    <header className="head">
      <div>
        <h1>我的书架</h1>
        <p>8 本 · 本机保存</p>
      </div>
      <div className="actions">
        <div className="toggle">
          <button className="on" type="button">
            书架
          </button>
          <button type="button">列表</button>
        </div>
        <button className="ghost" type="button">
          {icons.refresh} 补查
        </button>
      </div>
    </header>
  )
}

export function AppShell({ theme, glass, children }: { theme?: string; glass?: boolean; children: ReactNode }) {
  return (
    <div className={`app${theme ? ` ${theme}` : ''}`}>
      {glass && <GlassCanvas />}
      <Side />
      <main className="main">
        <Head />
        {children}
      </main>
    </div>
  )
}
