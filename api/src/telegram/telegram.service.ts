// Telegram console v0 (C9): the operator texts a LinkedIn URL from their
// phone; the raven answers with a dossier and three buttons. Locked to ONE
// chat id; every other chat is ignored (and told nothing).
import type { IngestResult } from '../leads/leads.service';
import { extractLinkedinUrl } from '../leads/leads.service';
import type { ITelegramClient, TgUpdate } from './telegram.client';
import { escapeHtml } from './dossier';

export interface TelegramDeps {
  client: ITelegramClient;
  operatorChatId: string | null;
  pipelineReady: boolean;
  degraded: string[];
  ingest: ((url: string) => Promise<IngestResult>) | null;
  setStatus: ((leadId: string, status: string, note?: string) => Promise<void>) | null;
  saveNote: ((leadId: string, note: string) => Promise<void>) | null;
  digest: (() => Promise<string>) | null;
}

const HELP = [
  '🐦 <b>muninn</b> — the raven.',
  'text me a <code>linkedin.com/in/…</code> URL → I return a dossier.',
  '/digest — pipeline + spend now',
  'buttons on a dossier: ✅ queue (ready for sequencing) · ✏️ note · ❌ park',
].join('\n');

export class TelegramService {
  private stopped = false;
  private offset = 0;
  private noteFor: string | null = null;
  private readonly aborter = new AbortController();

  constructor(private readonly deps: TelegramDeps) {}

  start(): void {
    void this.loop();
  }

  // Aborts the in-flight long poll too — a runtime reload must kill this
  // poller instantly, or the fresh one would 409 against Telegram.
  stop(): void {
    this.stopped = true;
    this.aborter.abort();
  }

  private async loop(): Promise<void> {
    console.log('[telegram] long-poll started');
    while (!this.stopped) {
      try {
        const updates = await this.deps.client.getUpdates(this.offset, 30, this.aborter.signal);
        for (const u of updates ?? []) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          try {
            await this.handle(u);
          } catch (e) {
            console.error('[telegram] handle failed:', e);
          }
        }
      } catch (e) {
        if (this.stopped) break;
        console.error('[telegram] poll failed, backing off 5s:', e instanceof Error ? e.message : e);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    console.log('[telegram] long-poll stopped');
  }

  // Exported update router — unit tested with a fake client.
  async handle(u: TgUpdate): Promise<void> {
    if (u.callback_query) return this.handleCallback(u);
    if (u.message) return this.handleMessage(u);
  }

  private isOperator(chatId: number | string): boolean {
    return this.deps.operatorChatId != null && String(chatId) === String(this.deps.operatorChatId);
  }

  private async handleCallback(u: TgUpdate): Promise<void> {
    const cq = u.callback_query!;
    const chatId = cq.message?.chat?.id;
    if (chatId == null || !this.isOperator(chatId)) {
      await this.deps.client.answerCallback(cq.id);
      return;
    }
    const m = /^([qnp]):([0-9a-f-]{36})$/.exec(cq.data ?? '');
    if (!m || !this.deps.setStatus || !this.deps.saveNote) {
      await this.deps.client.answerCallback(cq.id, 'not available');
      return;
    }
    const [, action, leadId] = m;
    const shortId = leadId.slice(0, 8);
    if (action === 'q') {
      await this.deps.setStatus(leadId, 'queued', 'operator approved via telegram');
      await this.deps.client.answerCallback(cq.id, 'queued ✓');
      await this.deps.client.sendMessage(
        chatId,
        `✅ <code>${shortId}</code> queued — the sequencer picks it up when slice 3 ships; until then it's your manual-outreach shortlist.`,
      );
    } else if (action === 'p') {
      await this.deps.setStatus(leadId, 'parked', 'operator parked via telegram');
      await this.deps.client.answerCallback(cq.id, 'parked');
      await this.deps.client.sendMessage(chatId, `❌ <code>${shortId}</code> parked — kept in the record, no outreach.`);
    } else {
      this.noteFor = leadId;
      await this.deps.client.answerCallback(cq.id);
      await this.deps.client.sendMessage(chatId, `✏️ reply with your note for <code>${shortId}</code> — I'll attach it.`);
    }
  }

  private async handleMessage(u: TgUpdate): Promise<void> {
    const msg = u.message!;
    const chatId = msg.chat.id;
    const text = (msg.text ?? '').trim();

    if (this.deps.operatorChatId == null) {
      await this.deps.client.sendMessage(
        chatId,
        `your chat id is <code>${escapeHtml(String(chatId))}</code> — set <code>TELEGRAM_OPERATOR_CHAT_ID=${escapeHtml(String(chatId))}</code> in api/.env and restart the api.`,
      );
      return;
    }
    if (!this.isOperator(chatId)) {
      console.warn('[telegram] ignoring non-operator chat', chatId);
      return;
    }

    if (text === '/start' || text === '/help') {
      const extra = this.deps.degraded.length
        ? '\n\n⚠ degraded:\n' + this.deps.degraded.map((d) => '· ' + escapeHtml(d)).join('\n')
        : '';
      await this.deps.client.sendMessage(chatId, HELP + extra);
      return;
    }

    if (text === '/digest') {
      if (!this.deps.digest) {
        await this.deps.client.sendMessage(chatId, 'digest needs the db configured (SUPABASE_DB_URL).');
        return;
      }
      await this.deps.client.sendMessage(chatId, await this.deps.digest());
      return;
    }

    const url = extractLinkedinUrl(text);
    if (url) {
      if (!this.deps.pipelineReady || !this.deps.ingest) {
        await this.deps.client.sendMessage(
          chatId,
          '⚠ pipeline not ready:\n' + this.deps.degraded.map((d) => '· ' + escapeHtml(d)).join('\n'),
        );
        return;
      }
      const r = await this.deps.ingest(url);
      if (r.kind === 'created') {
        await this.deps.client.sendMessage(
          chatId,
          `🐦 raven dispatched — <code>${r.leadId.slice(0, 8)}</code>. The dossier lands here when enrich + analyze finish.`,
        );
      } else if (r.kind === 'existing') {
        await this.deps.client.sendMessage(
          chatId,
          `already tracked — <code>${r.leadId.slice(0, 8)}</code>, status <b>${escapeHtml(r.status)}</b>.`,
        );
      } else if (r.kind === 'suppressed') {
        await this.deps.client.sendMessage(chatId, '⛔ that person is on the suppression list — not ingesting.');
      } else {
        await this.deps.client.sendMessage(chatId, 'that doesn\'t look like a <code>linkedin.com/in/…</code> profile URL.');
      }
      return;
    }

    if (this.noteFor && this.deps.saveNote) {
      const leadId = this.noteFor;
      this.noteFor = null;
      await this.deps.saveNote(leadId, text);
      await this.deps.client.sendMessage(chatId, `noted ✓ attached to <code>${leadId.slice(0, 8)}</code>.`);
      return;
    }

    await this.deps.client.sendMessage(chatId, 'send a linkedin profile URL, or /help.');
  }
}
