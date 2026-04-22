import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { AppShell } from './shared/components/AppShell';
import { ErrorBoundary } from './shared/components/ErrorBoundary';
import { ProjectsPage } from './features/projects/ProjectsPage';
import { NewProjectPage } from './features/projects/NewProjectPage';
import { ProjectDetailPage } from './features/projects/ProjectDetailPage';
import { BoardPage } from './features/board/BoardPage';
import { WorkersPage } from './features/workers/WorkersPage';
import { WorkersAggregatePage } from './features/workers/WorkersAggregatePage';
import { LogsPage } from './features/logs/LogsPage';
import { SkillsPage } from './features/skills/SkillsPage';
import { SystemPage } from './features/system/SystemPage';
import { ChatPage } from './features/chat/ChatPage';
import { NotFound } from './pages/NotFound';

/** /workers：没 ?project= 时走聚合视图；有则保留原单项目 WorkersPage。 */
function WorkersRoute() {
  const [params] = useSearchParams();
  const project = params.get('project');
  return project ? <WorkersPage /> : <WorkersAggregatePage />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/new" element={<NewProjectPage />} />
          <Route path="/projects/:name" element={<ProjectDetailPage />} />
          <Route path="/board" element={<BoardPage />} />
          <Route path="/workers" element={<WorkersRoute />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/system" element={<SystemPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:sessionId" element={<ChatPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
