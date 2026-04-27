import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';

export function AppShell() {
  return (
    <div className="grid grid-cols-[240px_1fr] grid-rows-[1fr_40px] h-screen">
      <aside className="row-span-1 row-start-1 border-r-[3px] border-[var(--color-text)] bg-[var(--color-bg)] p-4 flex flex-col">
        <Sidebar />
      </aside>
      <main className="row-start-1 overflow-auto p-6 flex flex-col gap-4">
        <Outlet />
      </main>
      <footer className="col-span-2 row-start-2 border-t-[3px] border-[var(--color-text)] bg-[var(--color-bg)]">
        <StatusBar />
      </footer>
    </div>
  );
}
