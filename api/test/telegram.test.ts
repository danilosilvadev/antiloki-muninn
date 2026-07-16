import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramClient, type TgUpdate } from '../src/telegram/telegram.client';
import { TelegramService, type TelegramDeps } from '../src/telegram/telegram.service';

function fakeClient() {
  const sent: { chatId: unknown; html: string; keyboard?: unknown }[] = [];
  const answered: { id: string; text?: string }[] = [];
  return {
    sent,
    answered,
    client: {
      getUpdates: async () => [],
      sendMessage: async (chatId: any, html: string, keyboard?: any) => {
        sent.push({ chatId, html, keyboard });
        return {};
      },
      answerCallback: async (id: string, text?: string) => {
        answered.push({ id, text });
        return {};
      },
    },
  };
}

function makeService(overrides: Partial<TelegramDeps> = {}) {
  const f = fakeClient();
  const statusChanges: { leadId: string; status: string }[] = [];
  const notes: { leadId: string; note: string }[] = [];
  const ingested: string[] = [];
  const deps: TelegramDeps = {
    client: f.client,
    operatorChatId: '777',
    pipelineReady: true,
    degraded: [],
    ingest: async (url) => {
      ingested.push(url);
      return { kind: 'created', leadId: '0f0e0d0c-1111-4222-8333-444455556666' };
    },
    setStatus: async (leadId, status) => {
      statusChanges.push({ leadId, status });
    },
    saveNote: async (leadId, note) => {
      notes.push({ leadId, note });
    },
    digest: async () => 'DIGEST-BODY',
    ...overrides,
  };
  return { svc: new TelegramService(deps), f, statusChanges, notes, ingested };
}

const msg = (chatId: number | string, text: string): TgUpdate => ({
  update_id: 1,
  message: { message_id: 1, chat: { id: chatId }, text },
});

test('money-guard: TelegramClient without fetchFn under tests throws', () => {
  assert.throws(() => new TelegramClient({ token: 'x'.repeat(30) } as any), /inject fetchFn/);
});

test('unset operator chat id → bot replies with the chat id bootstrap line', async () => {
  const { svc, f } = makeService({ operatorChatId: null });
  await svc.handle(msg(424242, 'hello'));
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].html, /TELEGRAM_OPERATOR_CHAT_ID=424242/);
});

test('non-operator chats are ignored silently', async () => {
  const { svc, f, ingested } = makeService();
  await svc.handle(msg(999, 'https://linkedin.com/in/a-rossi-123'));
  assert.equal(f.sent.length, 0);
  assert.equal(ingested.length, 0);
});

test('a linkedin URL from the operator is ingested and acknowledged', async () => {
  const { svc, f, ingested } = makeService();
  await svc.handle(msg(777, 'look at https://www.linkedin.com/in/a-rossi-123 today'));
  assert.deepEqual(ingested, ['https://www.linkedin.com/in/a-rossi-123']);
  assert.match(f.sent[0].html, /raven dispatched — <code>0f0e0d0c<\/code>/);
});

test('pipeline not ready → degraded list instead of ingest', async () => {
  const { svc, f, ingested } = makeService({ pipelineReady: false, degraded: ['db: SUPABASE_DB_URL missing'] });
  await svc.handle(msg(777, 'linkedin.com/in/a-rossi-123'));
  assert.equal(ingested.length, 0);
  assert.match(f.sent[0].html, /pipeline not ready/);
  assert.match(f.sent[0].html, /SUPABASE_DB_URL/);
});

test('suppressed and existing ingest results phrase honestly', async () => {
  const sup = makeService({ ingest: async () => ({ kind: 'suppressed' }) });
  await sup.svc.handle(msg(777, 'linkedin.com/in/gone'));
  assert.match(sup.f.sent[0].html, /suppression list/);

  const ex = makeService({ ingest: async () => ({ kind: 'existing', leadId: 'aaaabbbb-1111-4222-8333-444455556666', status: 'analyzed' }) });
  await ex.svc.handle(msg(777, 'linkedin.com/in/known'));
  assert.match(ex.f.sent[0].html, /already tracked/);
  assert.match(ex.f.sent[0].html, /analyzed/);
});

test('/digest sends the digest body; /help lists degraded subsystems', async () => {
  const { svc, f } = makeService({ degraded: ['analysis: OPENROUTER_API_KEY missing'] });
  await svc.handle(msg(777, '/digest'));
  assert.equal(f.sent[0].html, 'DIGEST-BODY');
  await svc.handle(msg(777, '/help'));
  assert.match(f.sent[1].html, /OPENROUTER_API_KEY/);
});

test('callbacks: queue and park change status; note captures the next message', async () => {
  const { svc, f, statusChanges, notes } = makeService();
  const leadId = '0f0e0d0c-1111-4222-8333-444455556666';
  const cb = (data: string): TgUpdate => ({
    update_id: 2,
    callback_query: { id: 'cb1', data, message: { chat: { id: 777 } } },
  });

  await svc.handle(cb(`q:${leadId}`));
  assert.deepEqual(statusChanges[0], { leadId, status: 'queued' });
  assert.equal(f.answered[0].text, 'queued ✓');

  await svc.handle(cb(`p:${leadId}`));
  assert.deepEqual(statusChanges[1], { leadId, status: 'parked' });

  await svc.handle(cb(`n:${leadId}`));
  await svc.handle(msg(777, 'warm intro possible via J.'));
  assert.deepEqual(notes, [{ leadId, note: 'warm intro possible via J.' }]);

  // callbacks from strangers only get an ack, never an action
  const strangers = makeService();
  await strangers.svc.handle({ update_id: 3, callback_query: { id: 'cb2', data: `q:${leadId}`, message: { chat: { id: 999 } } } });
  assert.equal(strangers.statusChanges.length, 0);
});
