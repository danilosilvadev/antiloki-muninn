// D2 — who's in the pipeline, at what stage, and what's the next action?
// One-click classify everywhere: saved views are a click, bulk actions are a
// click, suggestions accept/dismiss are a click. Row click opens the drawer.
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, slugName, fmtWhen, type LeadRow } from '../api';
import { useDrawer } from '../shell';

const VIEWS: { label: string; filter: { status?: string; fitMin?: number } }[] = [
  { label: 'Needs triage', filter: { status: 'analyzed' } },
  { label: 'Queued', filter: { status: 'queued' } },
  { label: 'Parked', filter: { status: 'parked' } },
  { label: 'High fit', filter: { fitMin: 70 } },
  { label: 'All', filter: {} },
];

const STATUS_DOT: Record<string, string> = {
  new: '', enriched: 'v', analyzed: 'a', queued: 'g', in_sequence: 'v', replied: 'g', parked: 'r', suppressed: 'r',
};

export function LeadsPage(): ReactNode {
  const qc = useQueryClient();
  const drawer = useDrawer();
  const [view, setView] = useState(0);
  const [q, setQ] = useState('');
  const [angle, setAngle] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ingestUrl, setIngestUrl] = useState('');
  const [banner, setBanner] = useState<string | null>(null);

  const filter = { ...VIEWS[view].filter, q: q || undefined, angle: angle || undefined, limit: 100 };
  const leads = useQuery({ queryKey: ['leads', filter], queryFn: () => api.leads(filter), retry: false });
  const suggestions = useQuery({ queryKey: ['suggestions'], queryFn: () => api.suggestions('pending'), retry: false });

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['leads'] });
    void qc.invalidateQueries({ queryKey: ['stats'] });
    void qc.invalidateQueries({ queryKey: ['suggestions'] });
  };

  const ingest = useMutation({
    mutationFn: (url: string) => api.ingest(url),
    onSuccess: (r) => {
      setIngestUrl('');
      setBanner(r.existing ? `already tracked — status ${r.status}` : `🐦 raven dispatched — ${r.lead_id.slice(0, 8)}`);
      refresh();
    },
    onError: (e) => setBanner(e instanceof ApiError ? e.message : 'ingest failed'),
  });
  const bulk = useMutation({
    mutationFn: (p: { ids: string[]; status: 'queued' | 'parked' }) => api.bulkStatus(p.ids, p.status),
    onSuccess: (r, p) => {
      setSelected(new Set());
      setBanner(`${r.changed} lead${r.changed === 1 ? '' : 's'} → ${p.status}`);
      refresh();
    },
  });
  const accept = useMutation({
    mutationFn: (id: string) => api.acceptSuggestion(id),
    onSuccess: (r) => {
      setBanner(r.ok ? 'accepted → ingested through the normal gates' : `not accepted: ${r.result}`);
      refresh();
    },
  });
  const dismiss = useMutation({ mutationFn: (id: string) => api.dismissSuggestion(id), onSuccess: refresh });

  if (leads.error instanceof ApiError) {
    return <div className="hint-box"><b>Leads need the db.</b> {leads.error.message}</div>;
  }

  const rows = leads.data?.rows ?? [];
  const toggle = (id: string): void => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <>
      <div className="toolbar">
        {VIEWS.map((v, i) => (
          <button key={v.label} className={`btn sm${i === view ? ' primary' : ''}`} onClick={() => { setView(i); setSelected(new Set()); }}>
            {v.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <select value={angle} onChange={(e) => setAngle(e.target.value)}>
          <option value="">angle: all</option>
          <option value="verification">verification</option>
          <option value="cant_lie">can't-lie</option>
          <option value="memory">memory</option>
          <option value="orchestration">orchestration</option>
        </select>
        <input placeholder="search url…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 160 }} />
      </div>

      <div className="toolbar">
        <input
          placeholder="＋ ingest: linkedin.com/in/…"
          value={ingestUrl}
          onChange={(e) => setIngestUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && ingestUrl.trim()) ingest.mutate(ingestUrl.trim()); }}
          style={{ width: 320 }}
        />
        <button className="btn" disabled={!ingestUrl.trim() || ingest.isPending} onClick={() => ingest.mutate(ingestUrl.trim())}>
          dispatch the raven
        </button>
        {banner && <span className="mono tiny muted">{banner}</span>}
        <span style={{ flex: 1 }} />
        {selected.size > 0 && (
          <>
            <span className="mono tiny muted">{selected.size} selected →</span>
            <button className="btn sm ok" onClick={() => bulk.mutate({ ids: [...selected], status: 'queued' })}>queue</button>
            <button className="btn sm warn" onClick={() => bulk.mutate({ ids: [...selected], status: 'parked' })}>park</button>
          </>
        )}
      </div>

      <div className="panel" style={{ overflowX: 'auto' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 26 }}></th>
              <th>Name · URL</th>
              <th>Company</th>
              <th>Fit</th>
              <th>Angle</th>
              <th>Status</th>
              <th>Email</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l: LeadRow) => (
              <tr key={l.id} className="click" onClick={() => drawer.open(l.id)}>
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                </td>
                <td>
                  <b>{slugName(l.linkedinUrl)}</b>
                  <div className="tiny muted2 mono">{l.linkedinUrl.replace('https://www.', '')}</div>
                </td>
                <td>{l.company ?? '—'}</td>
                <td>
                  {l.fit != null ? (
                    <>
                      <span className="fitbar"><i style={{ width: `${l.fit}%`, background: l.fit >= 70 ? 'var(--green)' : 'var(--amber)' }} /></span>
                      <span className="mono">{l.fit}</span>
                    </>
                  ) : (
                    <span className="muted2">—</span>
                  )}
                </td>
                <td>{l.angle ? <span className="badge v">{l.angle}</span> : <span className="muted2">—</span>}</td>
                <td>
                  <span className={`dot ${STATUS_DOT[l.status] ?? ''}`} /> <span className="mono tiny">{l.status}</span>
                </td>
                <td>
                  {l.email ? (
                    <span className={`badge ${l.emailStatus === 'verified' ? 'g' : 'a'}`}>{l.emailStatus}</span>
                  ) : (
                    <span className="muted2 tiny">none</span>
                  )}
                </td>
                <td className="mono tiny muted2">{fmtWhen(l.updatedAt)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="muted2" style={{ padding: 18 }}>
                  {leads.isLoading ? 'loading…' : 'no leads in this view — dispatch the raven with a linkedin URL above'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {leads.data && <div className="mono tiny muted2">{leads.data.total} lead{leads.data.total === 1 ? '' : 's'} in view</div>}

      <div className="panel">
        <div className="ph">
          expansion suggestions · find-similar output lands here — accepting runs the normal ingest gates, nothing is auto-queued
        </div>
        <div className="pb list">
          {(suggestions.data?.rows ?? []).map((s) => (
            <div className="row" key={s.id}>
              <span className="badge o">{s.mode}</span>
              <span>
                <b>{s.name ?? 'unnamed'}</b> {s.title ? `· ${s.title}` : ''} {s.company ? `@ ${s.company}` : ''}
              </span>
              <span className="tiny muted2 mono">{s.linkedinUrl ? s.linkedinUrl.replace('https://www.', '') : 'no url — cannot ingest'}</span>
              <span style={{ flex: 1 }} />
              <button className="btn sm ok" disabled={!s.linkedinUrl || accept.isPending} onClick={() => accept.mutate(s.id)}>
                accept
              </button>
              <button className="btn sm" onClick={() => dismiss.mutate(s.id)}>dismiss</button>
            </div>
          ))}
          {(suggestions.data?.rows ?? []).length === 0 && (
            <div className="row muted2">empty — open a lead and hit “find similar”</div>
          )}
        </div>
      </div>
    </>
  );
}
