// Renders a lead view into the Telegram dossier message (C9). Pure — unit
// tested against the 4096-char Telegram limit with maximal inputs.
import type { InlineKeyboard } from './telegram.client';
import { countWords } from '../analysis/schema';
import { slugOf } from '../leads/leads.service';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type LeadRow = { id: string; linkedinUrl: string; status: string };
type EnrichmentRow = { raw: unknown; email: string | null; emailStatus: string | null } | null;
type AnalysisRow = {
  fitScore: number;
  icp: string;
  angle: string | null;
  pains: unknown;
  hooks: unknown;
  briefMd: string;
} | null;
type DraftRow = { step: number | null; channel: string; subject: string | null; bodyMd: string };

export interface LeadView {
  lead: LeadRow;
  enrichment: EnrichmentRow;
  analysis: AnalysisRow;
  drafts: DraftRow[];
}

// Vendor-shape-tolerant display name: common FullEnrich field spots, then the slug.
export function displayName(view: LeadView): string {
  const raw = (view.enrichment?.raw ?? {}) as Record<string, unknown>;
  const datas = (Array.isArray(raw['datas']) ? raw['datas'] : []) as Record<string, unknown>[];
  const d = datas[0] ?? raw;
  for (const source of [d, (d['contact'] ?? {}) as Record<string, unknown>, (d['profile'] ?? {}) as Record<string, unknown>]) {
    const fn = source['firstname'] ?? source['first_name'];
    const ln = source['lastname'] ?? source['last_name'];
    if (typeof fn === 'string' && fn) return `${fn} ${typeof ln === 'string' ? ln : ''}`.trim();
    const name = source['name'] ?? source['full_name'];
    if (typeof name === 'string' && name) return name;
  }
  const slug = slugOf(view.lead.linkedinUrl);
  return slug
    .split('-')
    .filter((p) => p && !/^\d+$/.test(p) && !/^[0-9a-f]{6,}$/i.test(p))
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ') || slug;
}

const STEP_LABELS = ['day 0 · email', 'day 3 · linkedin', 'day 6 · email', 'day 12 · email'];

export function renderDossier(
  view: LeadView,
  violations: string[] = [],
): { html: string; keyboard: InlineKeyboard } {
  const a = view.analysis;
  const name = escapeHtml(displayName(view));
  const shortId = view.lead.id.slice(0, 8);
  const emailBadge = view.enrichment?.email
    ? view.enrichment.emailStatus === 'verified'
      ? '✓ verified email'
      : `~ ${escapeHtml(view.enrichment.emailStatus ?? 'email')}`
    : '✖ no email — LinkedIn-only';

  const lines: string[] = [];
  lines.push(`🐦 <b>${name}</b> · <code>${shortId}</code>`);
  lines.push(escapeHtml(view.lead.linkedinUrl));

  if (!a) {
    lines.push('', `status: ${escapeHtml(view.lead.status)} — no analysis yet.`);
    return { html: lines.join('\n'), keyboard: keyboardFor(view.lead.id) };
  }

  lines.push(
    `fit <b>${a.fitScore}</b> · ${escapeHtml(a.icp)} · angle <b>${escapeHtml(a.angle ?? '—')}</b> · ${emailBadge}`,
  );

  const pains = (Array.isArray(a.pains) ? a.pains : []) as { pain?: string; evidence?: string; source?: string }[];
  if (pains.length) {
    lines.push('', '<b>pains</b>');
    for (const p of pains.slice(0, 3)) {
      lines.push(`· ${escapeHtml(p.pain ?? '')} — <i>${escapeHtml((p.evidence ?? '').slice(0, 120))}</i>`);
    }
  }

  const hooks = (Array.isArray(a.hooks) ? a.hooks : []) as { hook?: string }[];
  if (hooks.length) {
    lines.push('', '<b>hooks</b> ' + hooks.map((h) => escapeHtml(h.hook ?? '')).filter(Boolean).slice(0, 3).join(' · '));
  }

  lines.push('', '<b>brief</b>', escapeHtml(a.briefMd.slice(0, 700)) + (a.briefMd.length > 700 ? '…' : ''));

  if (view.drafts.length) {
    lines.push('', '<b>drafts</b>');
    view.drafts.slice(0, 4).forEach((d, i) => {
      const label = STEP_LABELS[d.step ?? i] ?? `step ${d.step ?? i}`;
      const words = countWords(d.bodyMd);
      const subject = d.subject ? ` — “${escapeHtml(d.subject.slice(0, 80))}”` : '';
      lines.push(`<b>${i + 1}. ${label}</b> (${words}w)${subject}`);
      lines.push(escapeHtml(d.bodyMd.slice(0, 280)) + (d.bodyMd.length > 280 ? '…' : ''));
    });
  }

  if (violations.length) {
    lines.push('', '⚠ over budget: ' + escapeHtml(violations.join(' · ')));
  }

  let html = lines.join('\n');
  if (html.length > 4000) html = html.slice(0, 3990) + '\n…';
  return { html, keyboard: keyboardFor(view.lead.id) };
}

function keyboardFor(leadId: string): InlineKeyboard {
  return [
    [
      { text: '✅ queue', callback_data: `q:${leadId}` },
      { text: '✏️ note', callback_data: `n:${leadId}` },
      { text: '❌ park', callback_data: `p:${leadId}` },
    ],
  ];
}
