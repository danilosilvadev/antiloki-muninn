// The kill switch + refusal log ship in slice 3 (a slice-3 exit criterion);
// the full control-center (sequence editor, caps board, vendor spend) is
// slice 4. This page is the minimum: pause-all, domain-health state, the
// SendPolicy refusal log, and the live cap counter.
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, fmtWhen } from '../api';
import { useDrawer } from '../shell';

export function ControlPage(): ReactNode {
  const qc = useQueryClient();
  const drawer = useDrawer();
  const control = useQuery({ queryKey: ['control'], queryFn: api.control, refetchInterval: 15_000, retry: false });

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['control'] });
    void qc.invalidateQueries({ queryKey: ['health'] });
  };
  const pause = useMutation({ mutationFn: (on: boolean) => api.pauseAll(on), onSuccess: invalidate });
  const clearHealth = useMutation({ mutationFn: () => api.clearHealthPause(), onSuccess: invalidate });

  if (control.error instanceof ApiError) {
    return <div className="hint-box"><b>Control needs the db.</b> {control.error.message}</div>;
  }
  const c = control.data;
  if (!c) return <div className="muted mono small">loading…</div>;

  const bounce = c.health.bounceRate == null ? '—' : `${(c.health.bounceRate * 100).toFixed(1)}%`;
  const complaint = c.health.complaintRate == null ? '—' : `${(c.health.complaintRate * 100).toFixed(2)}%`;

  return (
    <>
      <div className="panel" style={{ borderColor: c.pauseAll ? 'var(--red)' : undefined }}>
        <div className="ph">the kill switch</div>
        <div className="pb" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <button
            className={`btn ${c.pauseAll ? 'primary' : 'warn'}`}
            style={c.pauseAll ? { background: 'var(--green)', borderColor: 'var(--green)' } : {}}
            disabled={pause.isPending}
            onClick={() => pause.mutate(!c.pauseAll)}
          >
            {c.pauseAll ? '▶ RESUME ALL SENDING' : '⏸ PAUSE ALL SENDING'}
          </button>
          <span className="mono small">
            state: <b style={{ color: c.pauseAll ? 'var(--red)' : 'var(--green)' }}>{c.pauseAll ? 'PAUSED' : 'sending active'}</b>
          </span>
          <span className="mono small muted">applied within one scheduler tick · survives restart (DB flag)</span>
          <span style={{ flex: 1 }} />
          <span className="mono small">
            today <b style={{ color: c.sentToday >= c.dailyCap ? 'var(--red)' : 'var(--text)' }}>{c.sentToday}</b>/{c.dailyCap} pushes
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div className="panel" style={{ borderColor: c.healthPaused.on ? 'var(--amber)' : undefined }}>
          <div className="ph">domain health (7d)</div>
          <div className="pb">
            <div className="mono small" style={{ display: 'flex', gap: 18 }}>
              <span>sends <b className="mono">{c.health.sent}</b></span>
              <span>bounce <b style={{ color: c.health.bounceRate && c.health.bounceRate > 0.02 ? 'var(--red)' : 'var(--text)' }}>{bounce}</b></span>
              <span>complaints <b style={{ color: c.health.complaintRate && c.health.complaintRate >= 0.001 ? 'var(--red)' : 'var(--text)' }}>{complaint}</b></span>
            </div>
            {c.health.sent < 20 && <div className="tiny muted2" style={{ marginTop: 6 }}>under 20 sends — rates are noise, reported when there's signal</div>}
            {c.healthPaused.on && (
              <div style={{ marginTop: 10 }}>
                <span className="badge a">auto-paused for health</span>
                <button className="btn sm" style={{ marginLeft: 8 }} disabled={clearHealth.isPending} onClick={() => clearHealth.mutate()}>
                  clear the health hold
                </button>
                <div className="tiny muted2" style={{ marginTop: 6 }}>clearing lifts the gate; campaigns still need pause-all OFF to resume — deliberate.</div>
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="ph">angle campaigns</div>
          <div className="pb">
            {c.campaigns.length === 0 && <div className="muted2 small">none yet — created on the first approval per angle.</div>}
            {c.campaigns.map((cp) => (
              <div key={cp.angle} className="mono small" style={{ padding: '3px 0' }}>
                <span className="badge v">{cp.angle}</span> <span className="muted2">smartlead #{cp.campaignId}</span>
              </div>
            ))}
            {!c.senderReady && <div className="tiny" style={{ color: 'var(--amber)', marginTop: 8 }}>SMARTLEAD_API_KEY not set — approvals refuse with not_ready.</div>}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="ph">SendPolicy refusal log — every refused send, with its reason</div>
        <div className="pb list">
          {c.refusals.length === 0 && <div className="row muted2">no refusals — nothing has been blocked.</div>}
          {c.refusals.map((r) => (
            <div className="row" key={r.id}>
              <span className="mono tiny muted2" style={{ width: 58 }}>{fmtWhen(r.at)}</span>
              <span className="badge r">{r.code}</span>
              <span className="small muted" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.reason}</span>
              {r.leadId && <button className="btn sm" onClick={() => drawer.open(r.leadId!)}>{r.leadId.slice(0, 8)}</button>}
            </div>
          ))}
        </div>
      </div>

      <div className="hint-box">
        The full control-center — sequence template editor, caps &amp; quiet-hours board, per-vendor spend, geo policy — arrives in <b>slice 4</b>. This is the safety subset: the switch, the health gate, and the record of what the gate refused.
      </div>
    </>
  );
}
