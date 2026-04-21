import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './shared/components/AppShell';
import { ProjectsPage } from './features/projects/ProjectsPage';
import { NotFound } from './pages/NotFound';

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/board" element={<Placeholder title="看板" />} />
        <Route path="/workers" element={<Placeholder title="Workers" />} />
        <Route path="/logs" element={<Placeholder title="Logs" />} />
        <Route path="/skills" element={<Placeholder title="Skills" />} />
        <Route path="/system" element={<Placeholder title="系统" />} />
        <Route path="/chat" element={<Placeholder title="对话" />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function Placeholder({ title }: { title: string }) {
  return (
    <div className="nb-card-interactive nb-card max-w-2xl">
      <h2 className="font-[family-name:var(--font-heading)] text-2xl font-bold mb-2">
        {title} <span className="text-sm font-normal text-[var(--color-text-muted)]">(M{getM(title)} 实装)</span>
      </h2>
      <p className="text-[var(--color-text-muted)]">
        这是 M1 walking skeleton。完整实装见 M2 后续里程碑。
      </p>
    </div>
  );
}

function getM(t: string): string {
  if (t === '看板') return '2';
  if (t === 'Workers' || t === 'Logs') return '3';
  if (t === 'Skills' || t === '系统') return '4';
  if (t === '对话') return '5';
  return '?';
}
