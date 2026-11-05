import { Navigate, Route, Routes } from 'react-router-dom'
import { AFreeGrid, CSpines, DEditorial, EMixed, FShelf, Themed } from './screens'

const themes: { path: string; theme: string; glass?: boolean }[] = [
  { path: 'd1', theme: 'theme-d1' },
  { path: 'd2', theme: 'theme-d2' },
  { path: 'd3', theme: 'theme-d3' },
  { path: 'd4', theme: 'theme-d4' },
  { path: 's1-editorial', theme: 'theme-s1-editorial' },
  { path: 's2-swiss', theme: 'theme-s2-swiss' },
  { path: 's3-dark', theme: 'theme-s3-dark' },
  { path: 's4-brutalist', theme: 'theme-s4-brutalist' },
  { path: 's5-glass', theme: 'theme-s5-glass', glass: true },
  { path: 's6-deco', theme: 'theme-s6-deco' },
]

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/e-mixed" replace />} />
      <Route path="/a-grid" element={<AFreeGrid />} />
      <Route path="/b-shelf" element={<FShelf />} />
      <Route path="/c-spines" element={<CSpines />} />
      <Route path="/d-editorial" element={<DEditorial />} />
      <Route path="/e-mixed" element={<EMixed />} />
      {themes.map((item) => (
        <Route key={item.path} path={`/${item.path}`} element={<Themed theme={item.theme} glass={item.glass} />} />
      ))}
      <Route path="*" element={<Navigate to="/e-mixed" replace />} />
    </Routes>
  )
}
