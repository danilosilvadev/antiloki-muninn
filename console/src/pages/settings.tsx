// Settings — keys & permissions live HERE, per operator decision (2026-07-16).
// Values are posted once over loopback and stored in api/.env; the api never
// echoes a secret back (configured + length only). Saving hot-reloads the
// runtime, so subsystems light up without a restart.
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type KeyStatus } from '../api';

const GROUPS: { id: KeyStatus['group']; title: string; blurb: string }[] = [
  { id: 'core', title: 'core', blurb: 'the database everything else stands on' },
  { id: 'vendors', title: 'vendors', blurb: 'enrichment · analysis · find-similar' },
  { id: 'telegram', title: 'telegram', blurb: 'the raven in your pocket' },
  { id: 'tuning', title: 'tuning', blurb: 'thresholds, model, digest, booking link' },
];

export function SettingsPage(): ReactNode {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.saveSettings(draft),
    onSuccess: (r) => {
      setDraft({});
      setResult(
        r.degraded.length
          ? `saved + reloaded — still missing: ${r.degraded.length}`
          : 'saved + reloaded — all subsystems configured, the raven flies ✓',
      );
      void qc.invalidateQueries();
    },
    onError: (e) => setResult(e instanceof ApiError ? `refused: ${e.message}` : 'save failed'),
  });

  const s = settings.data;
  const dirtyCount = Object.keys(draft).length;

  return (
    <>
      <div className="hint-box">
        <b>Keys live on the operator machine, not in this app.</b> What you paste here is written to{' '}
        <span className="mono">api/.env</span> over loopback and applied live. Secrets are never shown again —
        only <i>configured · length</i>. This bundle contains no keys, ever.
      </div>

      {settings.error instanceof ApiError && <div className="error-box">{settings.error.message}</div>}

      {s && (
        <>
          <div className="panel">
            <div className="ph">machine state</div>
            <div className="pb" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }} >
              <span className="mono small"><span className={`dot ${s.db ? 'g' : 'r'}`} /> db</span>
              <span className="mono small"><span className={`dot ${s.workers ? 'g' : 'r'}`} /> pipeline workers</span>
              <span className="mono small"><span className={`dot ${s.telegram ? 'g' : 'r'}`} /> telegram</span>
              <span style={{ flex: 1 }} />
              {s.degraded.length > 0 && (
                <span className="mono tiny" style={{ color: 'var(--amber)' }}>
                  {s.degraded.join('  ·  ')}
                </span>
              )}
            </div>
          </div>

          {GROUPS.map((g) => {
            const keys = s.keys.filter((k) => k.group === g.id);
            if (keys.length === 0) return null;
            return (
              <div className="panel" key={g.id}>
                <div className="ph">{g.title} — {g.blurb}</div>
                <div className="pb">
                  {keys.map((k) => (
                    <div className="set-row" key={k.name}>
                      <div>
                        <div className="name">{k.name}</div>
                        <div className="hint">{k.hint}</div>
                      </div>
                      <div className="mono small">
                        {k.configured ? (
                          k.secret ? (
                            <span style={{ color: 'var(--green)' }}>configured ✓ · {k.length} chars</span>
                          ) : (
                            <span style={{ color: 'var(--text)' }}>{k.value}</span>
                          )
                        ) : (
                          <span className="muted2">not set</span>
                        )}
                      </div>
                      <input
                        placeholder={k.secret ? 'paste new value…' : 'set value…'}
                        type={k.secret ? 'password' : 'text'}
                        value={draft[k.name] ?? ''}
                        onChange={(e) => {
                          const next = { ...draft };
                          if (e.target.value === '') delete next[k.name];
                          else next[k.name] = e.target.value;
                          setDraft(next);
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          <div className="toolbar">
            <button className="btn primary" disabled={dirtyCount === 0 || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'saving + reloading…' : `save ${dirtyCount || ''} change${dirtyCount === 1 ? '' : 's'} + reload`}
            </button>
            {result && <span className="mono tiny muted">{result}</span>}
          </div>

          <div className="panel">
            <div className="ph">telegram binding — two steps</div>
            <div className="pb small muted">
              1 · set <span className="mono">TELEGRAM_BOT_TOKEN</span> above (from @BotFather) and save.<br />
              2 · message your bot anything — it replies with your chat id; paste it into{' '}
              <span className="mono">TELEGRAM_OPERATOR_CHAT_ID</span> and save again. From then on the bot serves only your chat.
            </div>
          </div>
        </>
      )}
    </>
  );
}
