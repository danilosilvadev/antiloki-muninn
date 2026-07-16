// Resend adapter (C10/C11) — the ONLY file that knows Resend's HTTP contract.
// This is the CONSENTED mail path: waitlist invites and the operator digest,
// sent from the canonical domain. Cold mail never leaves through here — that
// is Smartlead's lane, on the secondary sending domains (two-mail-paths rule).

export interface ResendEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

type FetchFn = typeof fetch;

export class ResendAdapter {
  constructor(
    private readonly opts: { apiKey: string; baseUrl: string; from: string; fetchFn?: FetchFn },
  ) {
    // money-guard: tests must inject fetchFn — a test run may never reach a paid vendor
    if (!opts.fetchFn && (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test')) {
      throw new Error('ResendAdapter: tests must inject fetchFn (money-guard)');
    }
  }

  private get fetchFn(): FetchFn {
    return this.opts.fetchFn ?? fetch;
  }

  async send(email: ResendEmail): Promise<string> {
    const res = await this.fetchFn(`${this.opts.baseUrl}/emails`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        from: this.opts.from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`resend POST /emails ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return String(json['id'] ?? '');
  }
}
