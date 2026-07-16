// D5 — is the machine healthy, are we on target, what needs me today?
// Slice-3-owned numbers (sends, replies, domain health) are labeled as
// not-yet-live instead of rendered as zeroes that read like data.
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Line, LineChart, ResponsiveContainer } from 'recharts';
import { api, ApiError, fmtWhen } from '../api';
import { useDrawer } from '../shell';

export function DashboardPage(): ReactNode {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const drawer = useDrawer();
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 30_000, retry: false });
  const reminderDone = useMutation({
    mutationFn: (id: string) => api.reminderDone(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stats'] }),
  });

  if (stats.error instanceof ApiError) {
    return (
      <div className="hint-box">
        <b>The machine isn't wired yet.</b> {stats.error.message} — open{' '}
        <a href="#" style={{ color: 'var(--orange)' }} onClick={(e) => { e.preventDefault(); void navigate({ to: '/settings' }); }}>
          Settings
        </a>{' '}
        and paste the keys (they live in <span className="mono">api/.env</span>, never in this bundle).
      </div>
    );
  }
  const s = stats.data;
  if (!s) return <div className="muted mono small">loading…</div>;

  const spark = s.waitlist.sparkline.map((v, i) => ({ i, v }));
  const spendTotal = s.spend30d.reduce((a, r) => a + r.totalUsd, 0);
  const by = s.pipeline.byStatus;

  return (
    <>
      <div className="tiles">
        <div className="tile">
          <div className="tk">Waitlist</div>
          <div className="tv">
            {s.waitlist.total}
            {s.waitlist.last7d > 0 && <small>▲{s.waitlist.last7d} 7d</small>}
          </div>
          <div className="ts" style={{ height: 26 }}>
            <ResponsiveContainer width="100%" height={26}>
              <LineChart data={spark}>
                <Line type="monotone" dataKey="v" stroke="var(--green)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="tile">
          <div className="tk">Pipeline (24h)</div>
          <div className="tv">{s.pipeline.ingested24h}<small style={{ color: 'var(--muted-2)' }}>ingested</small></div>
        </div>
        <div className="tile">
          <div className="tk">Awaiting review</div>
          <div className="tv" style={{ color: s.needsYou.awaitingReview ? 'var(--amber)' : undefined }}>
            {s.needsYou.awaitingReview}
          </div>
        </div>
        <div className="tile">
          <div className="tk">Vendor spend (30d)</div>
          <div className="tv">${spendTotal.toFixed(2)}</div>
          <div className="tiny muted2 mono">
            {s.spend30d.map((r) => `${r.provider} $${r.totalUsd.toFixed(2)}`).join(' · ') || 'nothing yet'}
          </div>
        </div>
        <div className="tile off">
          <div className="tk">Sent / reply % / positive</div>
          <div className="tv">— sends begin with slice 3</div>
        </div>
      </div>

      <div className="panel">
        <div className="ph">needs you</div>
        <div className="pb list">
          {s.needsYou.awaitingReview > 0 && (
            <div className="row">
              <span className="dot a" />
              <span>
                <b>{s.needsYou.awaitingReview}</b> dossier{s.needsYou.awaitingReview === 1 ? '' : 's'} awaiting triage
              </span>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => void navigate({ to: '/leads' })}>open leads</button>
            </div>
          )}
          {s.needsYou.remindersDue.map((r) => (
            <div className="row" key={r.id}>
              <span className="dot v" />
              <span>
                reminder due: <b>{r.note}</b>
              </span>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => drawer.open(r.leadId)}>open</button>
              <button className="btn sm ok" disabled={reminderDone.isPending} onClick={() => reminderDone.mutate(r.id)}>
                done ✓
              </button>
            </div>
          ))}
          {s.needsYou.parkedWithError.map((p) => (
            <div className="row" key={p.leadId}>
              <span className="dot r" />
              <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                parked with error: {p.error}
              </span>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => drawer.open(p.leadId)}>open</button>
            </div>
          ))}
          {s.needsYou.awaitingReview === 0 &&
            s.needsYou.remindersDue.length === 0 &&
            s.needsYou.parkedWithError.length === 0 && <div className="row muted2">nothing — the machine is quiet</div>}
        </div>
      </div>

      <div className="panel">
        <div className="ph">pipeline</div>
        <div className="pb funnel">
          {['new', 'enriched', 'analyzed', 'queued', 'in_sequence', 'replied', 'parked'].map((st, i) => (
            <span key={st}>
              {i > 0 && <span className="sep">› </span>}
              {st} <b>{by[st] ?? 0}</b>
            </span>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        <div className="panel">
          <div className="ph">activity · live</div>
          <div className="pb list">
            {s.activity.slice(0, 10).map((e, i) => (
              <div className="row" key={i}>
                <span className="mono tiny muted2" style={{ width: 58 }}>{fmtWhen(e.at)}</span>
                <span className="badge v">{e.kind}</span>
                {e.leadId && (
                  <button className="btn sm" onClick={() => drawer.open(e.leadId!)}>
                    {e.leadId.slice(0, 8)}
                  </button>
                )}
              </div>
            ))}
            {s.activity.length === 0 && <div className="row muted2">no events yet — feed the raven a URL</div>}
          </div>
        </div>
        <div className="panel">
          <div className="ph">domain health</div>
          <div className="pb muted2 small">{s.slice3.note}</div>
        </div>
      </div>
    </>
  );
}
