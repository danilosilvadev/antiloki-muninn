// Thin Telegram Bot API client — plain fetch, long polling, no library.
// The bot is an INTERNAL control surface (the operator talking to their own
// machine), not an outreach channel; cold Telegram does not exist in muninn.

export interface TgChat {
  id: number | string;
}
export interface TgMessage {
  message_id: number;
  chat: TgChat;
  text?: string;
}
export interface TgCallbackQuery {
  id: string;
  data?: string;
  message?: { chat: TgChat };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export type InlineKeyboard = { text: string; callback_data: string }[][];

export interface ITelegramClient {
  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]>;
  sendMessage(chatId: number | string, html: string, keyboard?: InlineKeyboard): Promise<unknown>;
  answerCallback(id: string, text?: string): Promise<unknown>;
}

type FetchFn = typeof fetch;

export class TelegramClient implements ITelegramClient {
  constructor(
    private readonly opts: { token: string; fetchFn?: FetchFn; baseUrl?: string },
  ) {
    // money-guard sibling: tests must inject fetchFn — no ambient network from a test run
    if (!opts.fetchFn && (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test')) {
      throw new Error('TelegramClient: tests must inject fetchFn');
    }
  }

  private get base(): string {
    return `${this.opts.baseUrl ?? 'https://api.telegram.org'}/bot${this.opts.token}`;
  }

  private get fetchFn(): FetchFn {
    return this.opts.fetchFn ?? fetch;
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchFn(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown } | null;
    if (!json?.ok) throw new Error(`telegram ${method} failed: ${JSON.stringify(json).slice(0, 300)}`);
    return json.result;
  }

  async getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]> {
    return (await this.call('getUpdates', {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message', 'callback_query'],
    })) as TgUpdate[];
  }

  sendMessage(chatId: number | string, html: string, keyboard?: InlineKeyboard): Promise<unknown> {
    return this.call('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  answerCallback(id: string, text?: string): Promise<unknown> {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  }
}
