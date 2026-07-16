// D7 — waitlist & waves: who's coming to us, who's referring, and who gets
// the next invite. Wave issuing is a two-step on purpose: PREVIEW shows
// exactly who the referral math picked (tier first, then join order) before
// ISSUE mints codes and sends the Resend invites. Activation is the third,
// human column — a click is interest; "activated" means they actually started.
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, fmtWhen, type IssueResult, type WaveRow } from '../api';

export function WaitlistPage(): ReactNode {
  const qc = useQueryClient();
  const view = useQuery({ queryKey: ['waitlist'], queryFn: api.waitlist, refetchInterval: 30_000, retry: false });
  const [selected, setSelected] = useState<number | null>(null);

  if (view.error instanceof ApiError) {
    return <div className="hint-box"><b>Waitlist needs the db.</b> {view.error.message}</div>;
  }
  const v = view.data;
  if (!v) return <div className="muted mono small">loading…</div>;

  const f = v.funnel;
  const pct = (a: number, b: number): string => (b > 0 ? ` (${((a / b) * 100).toFixed(1)}%)` : '');
  const selectedWave = v.waves.find((w) => w.wave === selected) ?? null;

  return (
    <>
      <div className="tiles">
        <Tile k="WAITLIST" v={String(v.totals.members)} sub={`+${v.totals.last7d} (7d)`} />
        <Tile k="REFERRED IN" v={String(f.referred)} sub={`${f.referralVisits7d} link visits (7d)`} />
        <Tile k="INVITED" v={String(f.invited)} sub={`${v.waves.length} wave${v.waves.length === 1 ? '' : 's'}`} />
        <Tile k="REDEEMED" v={String(f.redeemed)} sub={f.invited > 0 ? `${((f.redeemed / f.invited) * 100).toFixed(0)}% of invited` : 'no invites yet'} />
        <Tile k="ACTIVATED" v={String(f.activated)} sub="operator-confirmed" />
      </div>

      <div className="panel">
        <div className="pb funnel" style={{ padding: '12px 14px' }}>
          <span>signup <b>{f.joined}</b></span>
          <span className="sep">›</span>
          <span>referred <b>{f.referred}</b>{pct(f.referred, f.joined)}</span>
          <span className="sep">›</span>
          <span>invited <b>{f.invited}</b></span>
          <span className="sep">›</span>
          <span>redeemed <b>{f.redeemed}</b>{pct(f.redeemed, f.invited)}</span>
          <span className="sep">›</span>
          <span>activated <b>{f.activated}</b>{pct(f.activated, f.invited)}</span>
          <span style={{ flex: 1 }} />
          <span className="muted2 tiny">visits live in PostHog — this funnel starts at the row the form landed</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 14 }}>
        <div className="panel">
          <div className="ph">waves — create → preview → issue</div>
          <div className="pb">
            <CreateWaveForm onCreated={(w) => { setSelected(w); void qc.invalidateQueries({ queryKey: ['waitlist'] }); }} />
            <div className="list" style={{ marginTop: 10 }}>
              {v.waves.length === 0 && <div className="row muted2 small">no waves yet — create wave 1 and pick its slot count.</div>}
              {v.waves.map((w) => (
                <div
                  className="row"
                  key={w.wave}
                  style={{ cursor: 'pointer', background: selected === w.wave ? 'color-mix(in srgb, var(--panel-2) 70%, transparent)' : undefined }}
                  onClick={() => setSelected(selected === w.wave ? null : w.wave)}
                >
                  <span className="badge o">wave {w.wave}</span>
                  <span className="mono small">{w.issued}/{w.size} issued</span>
                  <span className="mono small muted">redeemed {w.redeemed} · activated {w.activated}</span>
                  <span style={{ flex: 1 }} />
                  {w.opensAt && <span className="mono tiny muted2">opens {w.opensAt.slice(0, 10)}</span>}
                  {w.label && <span className="mono tiny muted2">{w.label}</span>}
                  <span className="mono tiny muted2">{selected === w.wave ? '▾' : '▸'}</span>
                </div>
              ))}
            </div>
            {selectedWave && <WaveDetail wave={selectedWave} onChanged={() => void qc.invalidateQueries({ queryKey: ['waitlist'] })} />}
          </div>
        </div>

        <div className="panel">
          <div className="ph">top referrers — every {v.referralsPerJump} referrals jump a wave</div>
          <div className="pb list">
            {v.leaderboard.length === 0 && <div className="row muted2 small">no referrals yet — the share link does the work.</div>}
            {v.leaderboard.map((r) => (
              <div className="row" key={r.memberId}>
                <span className="mono small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.name ?? r.email}
                </span>
                <span className="mono small"><b>{r.referrals}</b> ref{r.referrals === 1 ? '' : 's'}</span>
                {r.tier > 0
                  ? <span className="badge g">▲ jumped {r.tier}</span>
                  : <span className="mono tiny muted2">{r.toNextJump} more to jump</span>}
                {r.position != null && <span className="mono tiny muted2">#{r.position}</span>}
              </div>
            ))}
            <div className="row muted2 tiny" style={{ borderBottom: 'none' }}>
              consent — email <b style={{ margin: '0 4px' }}>{v.consents.email}</b> · whatsapp <b style={{ margin: '0 4px' }}>{v.consents.whatsapp}</b> · telegram <b style={{ margin: '0 4px' }}>{v.consents.telegram}</b> (opt-in only, from the thank-you page)
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Tile(props: { k: string; v: string; sub: string }): ReactNode {
  return (
    <div className="tile">
      <div className="tk">{props.k}</div>
      <div className="tv">{props.v}</div>
      <div className="ts tiny muted2">{props.sub}</div>
    </div>
  );
}

function CreateWaveForm(props: { onCreated: (wave: number) => void }): ReactNode {
  const [size, setSize] = useState('10');
  const [opens, setOpens] = useState('');
  const [label, setLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createWave(Number(size), opens || undefined, label || undefined),
    onSuccess: (r) => {
      setErr(null);
      props.onCreated(r.wave);
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'failed'),
  });
  const valid = /^\d+$/.test(size) && Number(size) >= 1 && Number(size) <= 500;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="mono tiny muted2">new wave:</span>
      <input className="mono" style={miniInput(46)} value={size} onChange={(e) => setSize(e.target.value)} aria-label="wave size" placeholder="slots" />
      <input className="mono" style={miniInput(110)} type="date" value={opens} onChange={(e) => setOpens(e.target.value)} aria-label="opens at" />
      <input className="mono" style={miniInput(130)} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label (optional)" aria-label="wave label" />
      <button className="btn sm ok" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
        create wave
      </button>
      {err && <span className="tiny" style={{ color: 'var(--red)' }}>{err}</span>}
    </div>
  );
}

function WaveDetail(props: { wave: WaveRow; onChanged: () => void }): ReactNode {
  const w = props.wave;
  const remaining = Math.max(0, w.size - w.issued);
  const [result, setResult] = useState<IssueResult | null>(null);

  const selection = useQuery({
    queryKey: ['wave-selection', w.wave, w.issued],
    queryFn: () => api.waveSelection(w.wave),
    enabled: remaining > 0,
    retry: false,
  });
  const issue = useMutation({
    mutationFn: () => api.issueWave(w.wave),
    onSuccess: (r) => {
      setResult(r);
      props.onChanged();
    },
  });
  const activate = useMutation({
    mutationFn: (id: string) => api.activateMember(id),
    onSuccess: props.onChanged,
  });

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
      {remaining > 0 && (
        <>
          <div className="mono small" style={{ marginBottom: 6 }}>
            next up — <b>{remaining}</b> open slot{remaining === 1 ? '' : 's'}, referral tier first, then join order:
          </div>
          <div className="list" style={{ maxHeight: 180, overflowY: 'auto' }}>
            {selection.data?.picks.map((p) => (
              <div className="row" key={p.id} style={{ padding: '4px 2px' }}>
                <span className="mono tiny muted2" style={{ width: 44 }}>#{p.position ?? '—'}</span>
                <span className="mono small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name ?? p.email}</span>
                {p.tier > 0 && <span className="badge g">▲{p.tier}</span>}
                <span className="mono tiny muted2">{p.referrals} refs</span>
              </div>
            ))}
            {selection.data && selection.data.picks.length === 0 && (
              <div className="row muted2 tiny">nobody eligible — everyone is invited or suppressed.</div>
            )}
          </div>
          <button
            className="btn primary sm"
            style={{ marginTop: 8 }}
            disabled={issue.isPending || !selection.data || selection.data.picks.length === 0}
            onClick={() => issue.mutate()}
          >
            {issue.isPending ? 'issuing…' : `issue ${selection.data?.picks.length ?? ''} code(s) + invites`}
          </button>
        </>
      )}
      {result && (
        <div className="tiny" style={{ marginTop: 8, color: result.emailErrors.length ? 'var(--amber)' : 'var(--green)' }}>
          issued {result.issued.length} · emailed {result.issued.filter((i) => i.emailed).length}
          {result.emailsSkippedReason && <span className="muted2"> · {result.emailsSkippedReason}</span>}
          {result.emailErrors.length > 0 && <span> · {result.emailErrors.length} email(s) failed — codes stay valid</span>}
        </div>
      )}
      {w.invites.length > 0 && (
        <div className="list" style={{ marginTop: 10, maxHeight: 220, overflowY: 'auto' }}>
          {w.invites.map((i) => (
            <div className="row" key={i.code} style={{ padding: '4px 2px' }}>
              <span className="mono small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.name ?? i.email ?? '—'}</span>
              <code className="mono tiny">{i.code}</code>
              <span className="mono tiny muted2">{fmtWhen(i.issuedAt)}</span>
              <span className="mono tiny" style={{ width: 78, color: i.redeemedAt ? 'var(--green)' : 'var(--muted-2)' }}>
                {i.redeemedAt ? '✓ redeemed' : '· unopened'}
              </span>
              {i.activatedAt
                ? <span className="badge g">activated</span>
                : i.memberId
                  ? <button className="btn sm" disabled={activate.isPending} onClick={() => activate.mutate(i.memberId!)}>mark activated</button>
                  : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function miniInput(width: number) {
  return {
    width,
    background: 'var(--base)',
    border: '1px solid var(--line)',
    borderRadius: 5,
    color: 'var(--text)',
    padding: '3px 6px',
    fontSize: 11,
  } as const;
}
