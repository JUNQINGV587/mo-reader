import { AppShell, Focus, Grid, Hero, Library, Panel, ShelfRow, Spines } from '../components/ui'
import { books, readingBook } from '../data/books'

export function AFreeGrid() {
  return (
    <AppShell>
      <section className="stage a">
        <Grid items={books} />
      </section>
    </AppShell>
  )
}

export function FShelf() {
  return (
    <AppShell>
      <section className="stage b">
        <Panel hint="点封面翻开">
          <ShelfRow items={books} />
        </Panel>
      </section>
    </AppShell>
  )
}

export function CSpines() {
  return (
    <AppShell>
      <section className="stage c">
        <Panel hint="点书脊翻开，悬停看封面">
          <Spines />
        </Panel>
      </section>
    </AppShell>
  )
}

export function DEditorial() {
  return (
    <AppShell>
      <section className="stage editorial">
        <Focus book={readingBook} />
        <Library count={8}>
          <Grid items={books.slice(1)} />
        </Library>
      </section>
    </AppShell>
  )
}

export function EMixed() {
  return (
    <AppShell>
      <section className="stage">
        <Hero />
        <Library count={8}>
          <Grid items={books} />
        </Library>
      </section>
    </AppShell>
  )
}

export function Themed({ theme, glass }: { theme: string; glass?: boolean }) {
  return (
    <AppShell theme={theme} glass={glass}>
      <section className="stage">
        <Hero />
        <Library count={8}>
          <Grid items={books} />
        </Library>
      </section>
    </AppShell>
  )
}
