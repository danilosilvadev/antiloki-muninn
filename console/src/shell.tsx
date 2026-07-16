// D1 — the console shell: left rail, health header with the needs-you tray,
// and the lead drawer overlay (opens over any screen).
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { api, ApiError } from './api';
import { LeadDrawer } from './pages/drawer';

interface DrawerApi {
  leadId: string | null;
  open: (id: string) => void;
  close: () => void;
}
const DrawerCtx = createContext<DrawerApi>({ leadId: null, open: () => {}, close: () => {} });
export const useDrawer = (): DrawerApi => useContext(DrawerCtx);

export function Shell(): ReactNode {
  const [leadId, setLeadId] = useState<string | null>(null);
  const navigate = useNavigate();
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 15_000 });
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: api.stats,
    refetchInterval: 30_000,
    retry: (count, err) => !(err instanceof ApiError && err.status === 503) && count < 2,
  });

  const h = health.data;
  const machineDot = !h ? '' : h.workers ? 'g' : h.db ? 'a' : 'r';
  const machineLabel = !h
    ? 'connecting…'
    : h.workers
      ? 'all systems go'
      : h.db
        ? 'db up · vendors missing'
        : 'not configured';
  const needs = stats.data
    ? stats.data.needsYou.awaitingReview +
      stats.data.needsYou.remindersDue.length +
      stats.data.needsYou.parkedWithError.length
    : 0;

  return (
    <DrawerCtx.Provider value={{ leadId, open: setLeadId, close: () => setLeadId(null) }}>
      <div className="app">
        <nav className="rail">
          <div className="brand">
            muninn<i>.</i> <em className="muted2" style={{ fontStyle: 'normal', fontSize: 11 }}>console</em>
          </div>
          <Link to="/" activeProps={{ className: 'active' }} activeOptions={{ exact: true }}>
            <span className="lbl">◉ Dashboard</span>
          </Link>
          <Link to="/leads" activeProps={{ className: 'active' }}>
            <span className="lbl">☰ Leads</span>
          </Link>
          <span className="nav-off" title="arrives with slice 3">
            <span className="lbl">⌨ Review</span>
            <small>slice 3</small>
          </span>
          <span className="nav-off" title="arrives with slice 4">
            <span className="lbl">⏸ Control</span>
            <small>slice 4</small>
          </span>
          <span className="nav-off" title="arrives with slice 4">
            <span className="lbl">≋ Waitlist</span>
            <small>slice 4</small>
          </span>
          <Link to="/settings" activeProps={{ className: 'active' }}>
            <span className="lbl">⚙ Settings</span>
          </Link>
          <div className="foot">loopback · :5177 → :41945</div>
        </nav>
        <div className="main">
          <header className="topbar">
            <span>
              <span className={`dot ${machineDot}`} /> {machineLabel}
            </span>
            {h && h.degraded.length > 0 && (
              <button className="btn sm" onClick={() => void navigate({ to: '/settings' })}>
                {h.degraded.length} missing → settings
              </button>
            )}
            <span className="grow" />
            {stats.data && needs > 0 && (
              <button className="btn sm ok" onClick={() => void navigate({ to: '/' })}>
                needs you: {needs}
              </button>
            )}
            <span className="muted2">no sending until slice 3</span>
          </header>
          <div className="content">
            <Outlet />
          </div>
        </div>
      </div>
      {leadId && <LeadDrawer id={leadId} onClose={() => setLeadId(null)} />}
    </DrawerCtx.Provider>
  );
}
