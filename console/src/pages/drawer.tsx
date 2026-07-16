// D3 — everything about this one person, and what may I do next, right now.
// The timeline is the per-person outreach audit chain; compose edits drafts
// but the send button is server-truth disabled until slice 3's SendPolicy.
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, countWords, fmtWhen, slugName } from '../api';

const STEP_LABELS = ['day 0 · email', 'day 3 · linkedin', 'day 6 · email', 'day 12 · email'];

export function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }): ReactNode {
  const qc = useQueryClient();
  const view = useQuery({ queryKey: ['lead', id], queryFn: () => api.lead(id) });
  const timeline = useQuery({ queryKey: ['timeline', id], queryFn: () => api.timeline(id) });
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, retry: false });
  const [note, setNote] = useState('');
  const [remNote, setRemNote] = useState('');
  const [remDue, setRemDue] = useState('');
  const [banner, setBanner] = useState<string | null>(null);

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['lead', id] });
    void qc.invalidateQueries({ queryKey: ['timeline', id] });
    void qc.invalidateQueries({ queryKey: ['leads'] });
    void qc.invalidateQueries({ queryKey: ['stats'] });
  };

  const setStatus = useMutation({
    mutationFn: (status: 'queued' | 'parked') => api.setStatus(id, status, 'via drawer'),
    onSuccess: (_r, status) => { setBanner(`→ ${status}`); refresh(); },
  });
  const addNote = useMutation({
    mutationFn: () => api.addNote(id, note),
    onSuccess: () => { setNote(''); refresh(); },
  });
  const addReminder = useMutation({
    mutationFn: () => api.addReminder(id, remNote, new Date(remDue).toISOString()),
    onSuccess: () => { setRemNote(''); setRemDue(''); setBanner('reminder set'); refresh(); },
  });
  const expand = useMutation({
    mutationFn: (mode: 'colleagues' | 'lookalike') => api.expand(id, mode),
    onSuccess: (r) => { setBanner(`find similar: ${r.found} found, ${r.inserted} new suggestion${r.inserted === 1 ? '' : 's'}`); void qc.invalidateQueries({ queryKey: ['suggestions'] }); },
    onError: (e) => setBanner(e instanceof Error ? e.message : 'expand failed'),
  });

  const v = view.data;
  const lead = v?.lead;
  const a = v?.analysis ?? null;
  const calendly = stats.data?.calendlyUrl ?? null;

  return (
    <>
      <div className="drawer-veil" onClick={onClose} />
      <aside className="drawer">
        <div className="dh">
          <div className="t">
            <b>{lead ? slugName(lead.linkedinUrl) : '…'}</b>
            {v?.enrichment?.email && <span className="badge g">{v.enrichment.emailStatus}</span>}
            {a && <span className="mono">fit <b style={{ color: a.fitScore >= (stats.data?.fitThreshold ?? 70) ? 'var(--green)' : 'var(--amber)' }}>{a.fitScore}</b></span>}
            {lead && <span className="badge">{lead.status}</span>}
            <span style={{ flex: 1 }} />
            <button className="btn sm" onClick={onClose}>✕ close</button>
          </div>
          <div className="t">
            <button className="btn sm ok" disabled={setStatus.isPending} onClick={() => setStatus.mutate('queued')}>✅ queue</button>
            <button className="btn sm warn" disabled={setStatus.isPending} onClick={() => setStatus.mutate('parked')}>❌ park</button>
            <button className="btn sm" disabled={expand.isPending} onClick={() => expand.mutate('colleagues')}>find similar · colleagues</button>
            <button className="btn sm" disabled={expand.isPending} onClick={() => expand.mutate('lookalike')}>· lookalike titles</button>
            {calendly ? (
              <a className="btn sm" href={calendly} target="_blank" rel="noreferrer">book a call ↗</a>
            ) : (
              <span className="btn sm" style={{ opacity: 0.45, cursor: 'not-allowed' }} title="set CALENDLY_URL in Settings">book a call</span>
            )}
            {banner && <span className="mono tiny muted">{banner}</span>}
          </div>
          {lead && (
            <div className="mono tiny muted2">
              <a href={lead.linkedinUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--orange)' }}>
                {lead.linkedinUrl}
              </a>{' '}
              · source {lead.source} {lead.lastError ? <span style={{ color: 'var(--red)' }}> · last error: {lead.lastError}</span> : null}
            </div>
          )}
        </div>

        <div className="db">
          <div className="panel">
            <div className="ph">dossier</div>
            <div className="pb">
              {!a && <div className="muted2 small">no analysis yet — the raven hasn't finished (or the lead was ingested without vendor keys).</div>}
              {a && (
                <>
                  <dl className="kv">
                    <dt>icp</dt><dd><b>{a.icp}</b></dd>
                    <dt>angle</dt><dd><span className="badge v">{a.angle ?? '—'}</span></dd>
                    <dt>model</dt><dd className="mono tiny">{a.model}</dd>
                  </dl>
                  {a.pains.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div className="mono tiny muted2" style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>pains</div>
                      {a.pains.map((p, i) => (
                        <div key={i} className="small muted" style={{ padding: '4px 0' }}>
                          · {p.pain} — <i style={{ color: 'var(--muted-2)' }}>"{p.evidence}"</i> <span className="tiny muted2">({p.source})</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {a.hooks.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div className="mono tiny muted2" style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>hooks</div>
                      <div className="small muted">{a.hooks.map((h) => h.hook).join(' · ')}</div>
                    </div>
                  )}
                  <div style={{ marginTop: 10 }}>
                    <div className="mono tiny muted2" style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>brief</div>
                    <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{a.briefMd}</div>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="ph">compose · drafts the review queue (slice 3) will send</div>
            <div className="pb" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(v?.drafts ?? []).map((d) => <DraftEditor key={d.id} draft={d} onSaved={refresh} />)}
              {(v?.drafts ?? []).length === 0 && <div className="muted2 small">drafts appear after analysis.</div>}
            </div>
          </div>

          <div className="panel">
            <div className="ph">notes & reminders</div>
            <div className="pb" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input style={{ flex: 1 }} placeholder="note…" value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="btn sm" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate()}>save note</button>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input style={{ flex: 1 }} placeholder="reminder…" value={remNote} onChange={(e) => setRemNote(e.target.value)} />
                <input type="datetime-local" value={remDue} onChange={(e) => setRemDue(e.target.value)} />
                <button className="btn sm" disabled={!remNote.trim() || !remDue || addReminder.isPending} onClick={() => addReminder.mutate()}>
                  ＋ reminder
                </button>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="ph">timeline · the per-person audit chain</div>
            <div className="pb tl">
              {(timeline.data?.items ?? []).map((it, i) => (
                <div className="it" key={i}>
                  <span className="at">{fmtWhen(it.at)}</span>
                  <span className="k">{it.kind}</span>
                  <span className="d tiny">{renderDetail(it.detail)}</span>
                </div>
              ))}
              {(timeline.data?.items ?? []).length === 0 && <div className="muted2 small">nothing yet.</div>}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

function DraftEditor({
  draft,
  onSaved,
}: {
  draft: { id: string; step: number | null; channel: string; subject: string | null; bodyMd: string; status: string };
  onSaved: () => void;
}): ReactNode {
  const [subject, setSubject] = useState(draft.subject ?? '');
  const [body, setBody] = useState(draft.bodyMd);
  const [reason, setReason] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.editDraft(draft.id, { subject: draft.channel === 'email' ? subject : null, body_md: body }),
    onSuccess: (r) => { setReason(r.reason); onSaved(); },
  });
  const markSent = useMutation({
    mutationFn: () => api.markSent(draft.id),
    onSuccess: () => { setReason('marked sent ✓'); onSaved(); },
  });
  const words = countWords(body);
  const dirty = body !== draft.bodyMd || (draft.subject ?? '') !== subject;
  const isLinkedin = draft.channel === 'linkedin';
  const alreadySent = draft.status === 'sent';
  return (
    <div className="draft">
      <div className="dt">
        <span className="badge o">{STEP_LABELS[draft.step ?? 0] ?? `step ${draft.step}`}</span>
        <span className="badge">{draft.channel}</span>
        <span style={{ color: words > 80 ? 'var(--red)' : 'var(--muted-2)' }}>{words}w {words > 80 ? '· over the 80w budget' : '✓'}</span>
        <span style={{ flex: 1 }} />
        <span className="tiny muted2">{draft.status}</span>
      </div>
      {draft.channel === 'email' && (
        <input placeholder="subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      )}
      <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} disabled={alreadySent} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn sm" disabled={!dirty || save.isPending || alreadySent} onClick={() => save.mutate()}>save draft</button>
        {isLinkedin ? (
          // P1 stays manual: you send the connect note in LinkedIn's real UI, then record it here.
          <button className="btn sm ok" disabled={alreadySent || markSent.isPending} onClick={() => markSent.mutate()} title="send it in LinkedIn, then mark it">
            {alreadySent ? 'sent ✓' : 'I sent this in LinkedIn — mark sent'}
          </button>
        ) : (
          <button className="btn sm" disabled title="email sends are approved in the Review queue → SendPolicy → Smartlead">
            {alreadySent ? 'sent ✓' : 'email sends via Review → approve'}
          </button>
        )}
        {reason && <span className="tiny muted2 mono">{reason}</span>}
      </div>
    </div>
  );
}

function renderDetail(detail: unknown): string {
  if (detail == null) return '';
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail).slice(0, 180);
  } catch {
    return String(detail);
  }
}
