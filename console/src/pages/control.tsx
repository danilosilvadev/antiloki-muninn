// D6 — the full control-center: how hard is the machine running, and what is
// it forbidden to do? The kill switch + refusal log shipped with slice 3;
// slice 4 adds the per-angle sequence board (numbers + timing editor + pause),
// vendor spend vs budget, and the compliance board (geo + caps + suppressions).
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, fmtWhen, type AngleStat, type TemplateRow } from '../api';
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
  const budgetPct = c.budget.monthUsd > 0 ? Math.min(100, (c.budget.spentMonthUsd / c.budget.monthUsd) * 100) : 0;

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
          <span className="mono small muted2">applied within one scheduler tick · survives restart (DB flag)</span>
          <span style={{ flex: 1 }} />
          <span className="mono small">
            today <b style={{ color: c.sentToday >= c.dailyCap ? 'var(--red)' : 'var(--text)' }}>{c.sentToday}</b>/{c.dailyCap} pushes
            <span className="muted2"> · quiet {c.quietHours.replace('-', ':00–') + ':00'} (UTC{c.utcOffset >= 0 ? '+' : ''}{c.utcOffset})</span>
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 14 }}>
        <div className="panel">
          <div className="ph">sequences — one campaign per angle · timing is yours, words stay per-lead</div>
          <div className="pb list">
            {c.angles.map((a) => (
              <AngleRow
                key={a.angle}
                a={a}
                template={c.templates.find((tp) => tp.angle === a.angle)}
                pauseAll={c.pauseAll}
                onDone={invalidate}
              />
            ))}
            {!c.senderReady && (
              <div className="tiny" style={{ color: 'var(--amber)', marginTop: 8 }}>
                SMARTLEAD_API_KEY not set — approvals refuse with not_ready; campaigns appear on the first approval per angle.
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="ph">vendors — 30d spend · connection</div>
          <div className="pb">
            <div className="list">
              {c.vendors.map((vd) => (
                <div className="row" key={vd.provider}>
                  <span className={`dot ${vd.configured ? 'g' : ''}`} />
                  <span className="mono small" style={{ width: 92 }}>{vd.provider}</span>
                  <span className="mono small" style={{ width: 70, textAlign: 'right' }}>${vd.spend30dUsd.toFixed(2)}</span>
                  <span className="mono tiny muted2">{vd.calls30d} call{vd.calls30d === 1 ? '' : 's'}</span>
                  {!vd.configured && <span className="tiny muted2" style={{ marginLeft: 'auto' }}>key missing</span>}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="mono tiny muted2" style={{ marginBottom: 4 }}>
                month budget — ${c.budget.spentMonthUsd.toFixed(2)} / ${c.budget.monthUsd.toFixed(0)}
                {c.budget.tripped && <span className="badge r" style={{ marginLeft: 8 }}>BREAKER TRIPPED — enrichment/AI halted</span>}
                <span style={{ marginLeft: 6 }}>({c.budget.note})</span>
              </div>
              <div style={{ height: 8, borderRadius: 5, background: 'var(--panel-2)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${budgetPct}%`,
                  background: budgetPct >= 90 ? 'var(--red)' : budgetPct >= 70 ? 'var(--amber)' : 'var(--green)',
                }} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <CompliancePanel geoBlocked={c.geoBlocked} dailyCap={c.dailyCap} quietHours={c.quietHours} suppressionsCount={c.suppressionsCount} onDone={invalidate} />

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
    </>
  );
}

// One angle: its machine numbers, its Smartlead campaign, its timing editor
// (step 1 fixed at day 0 — the editor owns only the two follow-up delays),
// and its own pause independent of the kill switch.
function AngleRow(props: {
  a: AngleStat;
  template: TemplateRow | undefined;
  pauseAll: boolean;
  onDone: () => void;
}): ReactNode {
  const { a, template } = props;
  const delays = template?.delays ?? [0, 6, 6];
  const [d2, setD2] = useState(String(delays[1]));
  const [d3, setD3] = useState(String(delays[2]));
  const [note, setNote] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.saveTemplate(a.angle, [0, Number(d2), Number(d3)]),
    onSuccess: (r) => {
      setNote(r.note);
      props.onDone();
    },
    onError: (e) => setNote(e instanceof ApiError ? e.message : 'failed'),
  });
  const flip = useMutation({
    mutationFn: () => api.anglePause(a.angle, !a.paused),
    onSuccess: (r) => {
      setNote(r.note);
      props.onDone();
    },
  });

  const replyPct = a.pushed > 0 ? `${((a.replied / a.pushed) * 100).toFixed(1)}%` : '—';
  const dirty = Number(d2) !== delays[1] || Number(d3) !== delays[2];
  const valid = [d2, d3].every((s) => /^\d+$/.test(s) && Number(s) >= 0 && Number(s) <= 90);

  return (
    <div className="row" style={{ flexWrap: 'wrap', rowGap: 6 }}>
      <span className={`dot ${a.paused ? 'a' : a.campaignId ? 'g' : ''}`} title={a.paused ? 'paused' : a.campaignId ? 'live' : 'no campaign yet'} />
      <span className="badge v" style={{ width: 96, textAlign: 'center' }}>{a.angle}</span>
      <span className="mono small" style={{ width: 170 }}>
        pushed <b>{a.pushed}</b> · reply <b>{replyPct}</b> · pos <b>{a.positive}</b>
      </span>
      <span className="mono tiny muted2" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        day 0 → +
        <input className="mono" style={inputStyle} value={d2} onChange={(e) => setD2(e.target.value)} aria-label={`${a.angle} step-2 delay`} />
        d → +
        <input className="mono" style={inputStyle} value={d3} onChange={(e) => setD3(e.target.value)} aria-label={`${a.angle} step-3 delay`} />
        d
      </span>
      {dirty && (
        <button className="btn sm ok" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          save timing
        </button>
      )}
      <span style={{ flex: 1 }} />
      {a.campaignId && <span className="mono tiny muted2">smartlead #{a.campaignId}</span>}
      <button className="btn sm" disabled={flip.isPending} onClick={() => flip.mutate()}>
        {a.paused ? '▶ resume angle' : '⏸ pause angle'}
      </button>
      {note && <div className="tiny muted2" style={{ width: '100%' }}>{note}</div>}
    </div>
  );
}

const inputStyle = {
  width: 34,
  background: 'var(--base)',
  border: '1px solid var(--line)',
  borderRadius: 5,
  color: 'var(--text)',
  padding: '2px 5px',
  fontSize: 11,
} as const;

// The compliance board: what the machine is forbidden to do — geo blocks,
// caps, quiet hours (all SendPolicy inputs, edited here via Settings' hot
// reload) — plus the suppression list, searchable and appendable, never
// deletable (removing a suppression is a compliance risk, not a feature).
function CompliancePanel(props: {
  geoBlocked: string;
  dailyCap: number;
  quietHours: string;
  suppressionsCount: number;
  onDone: () => void;
}): ReactNode {
  const [cap, setCap] = useState(String(props.dailyCap));
  const [quiet, setQuiet] = useState(props.quietHours);
  const [geo, setGeo] = useState(props.geoBlocked);
  const [q, setQ] = useState('');
  const [searched, setSearched] = useState(false);
  const [addValue, setAddValue] = useState('');
  const [addKind, setAddKind] = useState<'email' | 'email_domain' | 'linkedin_url'>('email');
  const [msg, setMsg] = useState<string | null>(null);

  const knobsDirty = cap !== String(props.dailyCap) || quiet !== props.quietHours || geo !== props.geoBlocked;
  const saveKnobs = useMutation({
    mutationFn: () =>
      api.saveSettings({
        MUNINN_DAILY_SEND_CAP: cap,
        MUNINN_QUIET_HOURS: quiet,
        MUNINN_GEO_BLOCKED: geo,
      }),
    onSuccess: () => {
      setMsg('saved — runtime hot-reloaded');
      props.onDone();
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'failed'),
  });

  const search = useQuery({
    queryKey: ['suppressions', q, searched],
    queryFn: () => api.suppressions(q || undefined),
    enabled: searched,
    retry: false,
  });
  const add = useMutation({
    mutationFn: () => api.addSuppression({ [addKind]: addValue } as Record<string, string>),
    onSuccess: () => {
      setMsg(`suppressed (${addKind}) — takes effect on the next policy check`);
      setAddValue('');
      setSearched(true);
      void search.refetch();
      props.onDone();
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'failed'),
  });

  return (
    <div className="panel">
      <div className="ph">compliance — geo · caps · suppressions</div>
      <div className="pb">
        <div className="mono small" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {props.geoBlocked.split(',').map((g) => g.trim()).filter(Boolean).map((g) => (
            <span key={g} className="badge r">{g} ⊘</span>
          ))}
          <span className="badge g">UK-corp ✓</span>
          <span className="tiny muted2">blocked geos refuse at the gate; UK corporate subscribers ride the corporate-email note</span>
        </div>

        <div className="mono tiny" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          <span className="muted2">cap/day</span>
          <input className="mono" style={{ ...inputStyle, width: 40 }} value={cap} onChange={(e) => setCap(e.target.value)} aria-label="daily cap" />
          <span className="muted2">quiet</span>
          <input className="mono" style={{ ...inputStyle, width: 48 }} value={quiet} onChange={(e) => setQuiet(e.target.value)} aria-label="quiet hours" />
          <span className="muted2">geo blocked</span>
          <input className="mono" style={{ ...inputStyle, width: 76 }} value={geo} onChange={(e) => setGeo(e.target.value)} aria-label="geo blocked" />
          {knobsDirty && (
            <button className="btn sm ok" disabled={saveKnobs.isPending} onClick={() => saveKnobs.mutate()}>
              {saveKnobs.isPending ? 'reloading…' : 'save knobs'}
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
          <span className="mono small">suppressions <b>{props.suppressionsCount}</b></span>
          <input
            className="mono"
            style={{ ...inputStyle, width: 150 }}
            placeholder="search email/domain/url"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setSearched(true); }}
          />
          <button className="btn sm" onClick={() => setSearched(true)}>search</button>
        </div>
        {searched && search.data && (
          <div className="list" style={{ marginTop: 6, maxHeight: 150, overflowY: 'auto' }}>
            {search.data.rows.length === 0 && <div className="row muted2 tiny">no matches.</div>}
            {search.data.rows.map((s) => (
              <div className="row" key={s.id} style={{ padding: '4px 2px' }}>
                <span className="mono tiny" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.email ?? s.emailDomain ?? s.linkedinUrl}
                </span>
                <span className="badge a">{s.reason}</span>
                <span className="mono tiny muted2">{fmtWhen(s.at)}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <select
            className="mono"
            style={{ ...inputStyle, width: 'auto' }}
            value={addKind}
            onChange={(e) => setAddKind(e.target.value as typeof addKind)}
            aria-label="suppression kind"
          >
            <option value="email">email</option>
            <option value="email_domain">domain</option>
            <option value="linkedin_url">linkedin url</option>
          </select>
          <input
            className="mono"
            style={{ ...inputStyle, width: 190 }}
            placeholder="＋ add suppression"
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
          />
          <button className="btn sm warn" disabled={!addValue.trim() || add.isPending} onClick={() => add.mutate()}>
            suppress
          </button>
          <span className="tiny muted2">append-only — lifting a suppression is not offered, by design</span>
        </div>
        {msg && <div className="tiny muted2" style={{ marginTop: 8 }}>{msg}</div>}
      </div>
    </div>
  );
}
