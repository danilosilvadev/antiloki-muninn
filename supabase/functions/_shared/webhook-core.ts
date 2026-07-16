// Pure mapping for the webhook-sink (B3): Smartlead payload → our event row +
// suppression decision. Import-free and erasable-TS so the root node --test
// suite runs the exact file the edge function ships.

export type SinkKind =
  | 'sent'
  | 'open'
  | 'click'
  | 'reply'
  | 'bounce'
  | 'unsub'
  | 'complaint'
  | 'unknown';

export interface MappedWebhook {
  kind: SinkKind;
  email: string | null;            // the prospect's email, lowercased
  sendingAccount: string | null;   // the mailbox that sent (domain-health math)
  campaignId: string | null;
  replyText: string | null;        // reply body when present (classifier input)
  suppress: 'unsub' | 'bounce' | 'complaint' | null; // immediate suppression, no api involved
}

// Smartlead event names seen in their webhook docs; matched loosely on purpose.
const KIND_MAP: [RegExp, SinkKind][] = [
  [/REPLY|RESPONDED/i, 'reply'],
  [/BOUNCE/i, 'bounce'],
  [/UNSUBSCRIBE|UNSUB/i, 'unsub'],
  [/SPAM|COMPLAINT/i, 'complaint'],
  [/OPEN/i, 'open'],
  [/CLICK/i, 'click'],
  [/SENT/i, 'sent'],
];

export function mapSmartleadWebhook(payload: unknown): MappedWebhook {
  const p = (payload ?? {}) as Record<string, unknown>;
  const eventRaw = String(p['event_type'] ?? p['event'] ?? p['type'] ?? '');
  let kind: SinkKind = 'unknown';
  for (const [re, k] of KIND_MAP) {
    if (re.test(eventRaw)) {
      kind = k;
      break;
    }
  }

  const emailRaw =
    p['lead_email'] ?? p['to_email'] ?? p['email'] ??
    (p['lead'] as Record<string, unknown> | undefined)?.['email'] ?? null;
  const email = typeof emailRaw === 'string' && emailRaw.includes('@') ? emailRaw.trim().toLowerCase() : null;

  const accountRaw = p['from_email'] ?? p['sent_from'] ?? p['email_account'] ?? p['sender_email'] ?? null;
  const sendingAccount =
    typeof accountRaw === 'string' && accountRaw.includes('@') ? accountRaw.trim().toLowerCase() : null;

  const campaignRaw = p['campaign_id'] ?? (p['campaign'] as Record<string, unknown> | undefined)?.['id'] ?? null;
  const campaignId = campaignRaw != null ? String(campaignRaw) : null;

  const replyRaw = p['reply_body'] ?? p['reply_message'] ?? p['message_body'] ?? p['preview_text'] ?? null;
  const replyText =
    kind === 'reply' && typeof replyRaw === 'string' && replyRaw.trim() ? replyRaw.trim().slice(0, 4000) : null;

  const suppress = kind === 'unsub' ? 'unsub' : kind === 'bounce' ? 'bounce' : kind === 'complaint' ? 'complaint' : null;

  return { kind, email, sendingAccount, campaignId, replyText, suppress };
}

export function emailDomain(email: string | null): string | null {
  if (!email || !email.includes('@')) return null;
  return email.split('@')[1] ?? null;
}
