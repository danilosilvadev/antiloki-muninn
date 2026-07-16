// D4 — the review queue: one draft at a time, evidence side-by-side, keyboard
// triage. Approve pushes through SendPolicy (a refusal shows its reason, it
// doesn't silently fail); reject captures a reason that steers future dossiers.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, countWords, slugName, type LeadView } from '../api';
import { useDrawer } from '../shell';

export function ReviewPage(): ReactNode {
  const qc = useQueryClient();
  const drawer = useDrawer();
  const queue = useQuery({ queryKey: ['review'], queryFn: api.reviewQueue, retry: false });
  const [idx, setIdx] = useState(0);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [flash, setFlash] = useState<string | null>(null);

  const items = useMemo(() => queue.data?.items ?? [], [queue.data]);
  const cur: LeadView | undefined = items[idx];

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['review'] });
    void qc.invalidateQueries({ queryKey: ['leads'] });
    void qc.invalidateQueries({ queryKey: ['stats'] });
    void qc.invalidateQueries({ queryKey: ['control'] });
  };
  const clampAfterRemoval = (): void => setIdx((i) => Math.max(0, Math.min(i, items.length - 2)));

  const approve = useMutation({
    mutationFn: (id: string) => api.approve(id),
    onSuccess: (r) => {
      if (r.ok) {
        setFlash(`✅ approved → ${r.campaignId ? 'campaign ' + r.campaignId : 'sequence'}${r.notes?.length ? ' · ' + r.notes.join(' · ') : ''}`);
        clampAfterRemoval();
        refresh();
      } else {
        // policy refused — keep the card, show why (this is the whole point of the gate)
        setFlash(`⛔ SendPolicy refused: ${r.reason}`);
      }
    },
    onError: (e) => setFlash(e instanceof ApiError ? e.message : 'approve failed'),
  });
  const reject = useMutation({
    mutationFn: (p: { id: string; reason: string }) => api.reject(p.id, p.reason),
    onSuccess: () => {
      setRejecting(false);
      setReason('');
      setFlash('❌ rejected — the reason will steer the next dossiers');
      clampAfterRemoval();
      refresh();
    },
  });

  const doApprove = useCallback(() => { if (cur) approve.mutate(cur.lead.id); }, [cur, approve]);
  const move = useCallback((d: number) => { setRejecting(false); setIdx((i) => Math.max(0, Math.min(items.length - 1, i + d))); }, [items.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (rejecting) return; // don't hijack keys while typing a reason
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'a') { e.preventDefault(); doApprove(); }
      else if (e.key === 'r') { e.preventDefault(); setRejecting(true); }
      else if (e.key === 'e' && cur) { e.preventDefault(); drawer.open(cur.lead.id); }
      else if (e.key === 'j') { e.preventDefault(); move(1); }
      else if (e.key === 'k') { e.preventDefault(); move(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rejecting, doApprove, move, cur, drawer]);

  if (queue.error instanceof ApiError) {
    return <div className="hint-box"><b>Review needs the db.</b> {queue.error.message}</div>;
  }
  if (items.length === 0) {
    return (
      <div className="panel">
        <div className="ph">review queue</div>
        <div className="pb muted2">nothing awaiting approval — triage a lead to <span className="mono">analyzed</span> or wait for the raven.</div>
      </div>
    );
  }

  const a = cur?.analysis;
  const day0 = cur?.drafts.find((d) => d.step === 0) ?? cur?.drafts[0];

  return (
    <>
      <div className="toolbar">
        <span className="mono small muted">
          review — {idx + 1} of {items.length}
        </span>
        <span className="tiny muted2 mono">⌨ <kbd>a</kbd> approve · <kbd>e</kbd> edit · <kbd>r</kbd> reject · <kbd>j</kbd>/<kbd>k</kbd> move</span>
        <span style={{ flex: 1 }} />
        {flash && <span className="mono tiny" style={{ color: flash.startsWith('⛔') ? 'var(--red)' : 'var(--muted)' }}>{flash}</span>}
      </div>

      {cur && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 14 }}>
          <div className="panel">
            <div className="ph">
              draft · {slugName(cur.lead.linkedinUrl)} · day-0 · {a?.angle ?? '—'}
            </div>
            <div className="pb">
              {day0 ? (
                <>
                  {day0.subject && <div className="mono small" style={{ marginBottom: 8 }}><b style={{ color: 'var(--text)' }}>subj:</b> {day0.subject}</div>}
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, color: 'var(--muted)' }}>{day0.bodyMd}</div>
                  <div className="mono tiny muted2" style={{ marginTop: 10 }}>
                    {countWords(day0.bodyMd)}w {countWords(day0.bodyMd) > 80 ? '· over budget' : '✓'} · geo {cur.lead.geo ?? '—'} · {cur.enrichment?.emailStatus ?? 'no email'}
                  </div>
                </>
              ) : (
                <div className="muted2">no day-0 draft.</div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="ph">evidence</div>
            <div className="pb">
              {a ? (
                <>
                  <div className="mono small">fit <b style={{ color: 'var(--text)' }}>{a.fitScore}</b> · {a.icp}</div>
                  {a.pains.slice(0, 3).map((p, i) => (
                    <div key={i} className="small muted" style={{ padding: '5px 0' }}>
                      · <i style={{ color: 'var(--muted-2)' }}>"{p.evidence}"</i>
                    </div>
                  ))}
                  {cur.enrichment?.email && <div className="tiny muted2 mono" style={{ marginTop: 8 }}>{cur.enrichment.email}</div>}
                </>
              ) : (
                <div className="muted2 small">no analysis.</div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="toolbar">
        <button className="btn primary" disabled={approve.isPending} onClick={doApprove}>✅ approve → sequence <kbd>a</kbd></button>
        <button className="btn" onClick={() => cur && drawer.open(cur.lead.id)}>✏️ edit <kbd>e</kbd></button>
        <button className="btn warn" onClick={() => setRejecting((v) => !v)}>❌ reject <kbd>r</kbd></button>
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => move(-1)}>◀ k</button>
        <button className="btn sm" onClick={() => move(1)}>j ▶</button>
      </div>

      {rejecting && cur && (
        <div className="panel">
          <div className="ph">reject reason — this steers the analysis prompt for every future dossier</div>
          <div className="pb" style={{ display: 'flex', gap: 8 }}>
            <input
              autoFocus
              style={{ flex: 1 }}
              placeholder="e.g. too salesy — drop the flattery, lead with the tamper demo"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && reason.trim()) reject.mutate({ id: cur.lead.id, reason: reason.trim() }); }}
            />
            <button className="btn warn" disabled={!reason.trim() || reject.isPending} onClick={() => reject.mutate({ id: cur.lead.id, reason: reason.trim() })}>
              reject + park
            </button>
          </div>
        </div>
      )}
    </>
  );
}
