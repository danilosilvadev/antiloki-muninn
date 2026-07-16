// D1 — the console shell: left rail, health header with the needs-you tray,
// and the lead drawer overlay (opens over any screen).
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  const qc = useQueryClient();
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 15_000 });
  const noRetry503 = (count: number, err: unknown): boolean => !(err instanceof ApiError && err.status === 503) && count < 2;
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 30_000, retry: noRetry503 });
  const control = useQuery({ queryKey: ['control'], queryFn: api.control, refetchInterval: 15_000, retry: noRetry503 });
  const reviewCount = stats.data?.needsYou.awaitingReview ?? 0;
  const pause = useMutation({
    mutationFn: (on: boolean) => api.pauseAll(on),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['control'] }); },
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
          <Link to="/review" activeProps={{ className: 'active' }}>
            <span className="lbl">⌨ Review</span>
            {reviewCount > 0 && <small style={{ color: 'var(--amber)' }}>{reviewCount}</small>}
          </Link>
          <Link to="/control" activeProps={{ className: 'active' }}>
            <span className="lbl">⏸ Control</span>
          </Link>
          <Link to="/waitlist" activeProps={{ className: 'active' }}>
            <span className="lbl">≋ Waitlist</span>
          </Link>
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
            {control.data && (
              <>
                <span className="mono tiny muted2">
                  {control.data.sentToday}/{control.data.dailyCap} today
                </span>
                <button
                  className={`btn sm ${control.data.pauseAll ? '' : 'warn'}`}
                  style={control.data.pauseAll ? { color: 'var(--green)', borderColor: 'var(--green)' } : {}}
                  disabled={pause.isPending}
                  onClick={() => pause.mutate(!control.data!.pauseAll)}
                  title="global kill switch"
                >
                  {control.data.pauseAll ? '▶ resume all' : '⏸ pause all'}
                </button>
              </>
            )}
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
