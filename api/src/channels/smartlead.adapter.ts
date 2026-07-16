// Smartlead adapter (C6) — the ONLY file that knows Smartlead's HTTP contract.
// Model: one campaign per angle, created once with placeholder variables;
// each approved lead is pushed with its OWN four bodies as custom fields, so
// Smartlead executes timing/rotation/warmup interplay while every word stays
// muninn-authored and human-approved. Cold mail leaves ONLY through here, on
// the secondary sending domains — never the canonical (two-mail-paths rule).
//
// CONTRACT ASSUMPTIONS concentrated here; auth is ?api_key=; the first live
// push is verified in the slice-3 runbook. Raw responses ride vendor_calls.

export interface SmartleadLeadInput {
  email: string;
  firstName: string;
  lastName: string;
  customFields: Record<string, string>; // muninn_subject_1.., muninn_body_1..3
}

type FetchFn = typeof fetch;

export class SmartleadAdapter {
  constructor(
    private readonly opts: { apiKey: string; baseUrl: string; fetchFn?: FetchFn },
  ) {
    // money-guard: tests must inject fetchFn — a test run may never reach a paid vendor
    if (!opts.fetchFn && (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test')) {
      throw new Error('SmartleadAdapter: tests must inject fetchFn (money-guard)');
    }
  }

  private get fetchFn(): FetchFn {
    return this.opts.fetchFn ?? fetch;
  }

  private url(path: string): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${this.opts.baseUrl}${path}${sep}api_key=${encodeURIComponent(this.opts.apiKey)}`;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchFn(this.url(path), {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`smartlead ${method} ${path} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json;
  }

  async listCampaigns(): Promise<{ id: string; name: string }[]> {
    const json = await this.call('GET', '/campaigns');
    const arr = (Array.isArray(json) ? json : (json as Record<string, unknown>)['data'] ?? []) as
      Record<string, unknown>[];
    return (Array.isArray(arr) ? arr : []).map((c) => ({ id: String(c['id']), name: String(c['name'] ?? '') }));
  }

  // One campaign per angle: three email steps whose subject + body are
  // per-lead custom variables; delays come from the angle's sequence template
  // (D6 editor), defaulting to day-0 / +6 / +6. Day-3 LinkedIn is NOT here —
  // it stays a manual, operator-executed touch (P1 discipline).
  async createCampaign(angle: string, delays: number[] = [0, 6, 6]): Promise<string> {
    const created = (await this.call('POST', '/campaigns/create', { name: `muninn-${angle}` })) as
      Record<string, unknown>;
    const id = created['id'] ?? (created['data'] as Record<string, unknown> | undefined)?.['id'];
    if (id == null) throw new Error(`smartlead create campaign: no id in ${JSON.stringify(created).slice(0, 200)}`);
    const campaignId = String(id);
    await this.pushSequenceSteps(campaignId, delays);
    return campaignId;
  }

  // Same payload as creation — Smartlead replaces the campaign's step list.
  // Only timing changes; the words stay per-lead custom fields, always.
  async updateSequences(campaignId: string, delays: number[]): Promise<void> {
    await this.pushSequenceSteps(campaignId, delays);
  }

  private async pushSequenceSteps(campaignId: string, delays: number[]): Promise<void> {
    await this.call('POST', `/campaigns/${campaignId}/sequences`, {
      sequences: delays.map((d, i) => ({
        seq_number: i + 1,
        seq_delay_details: { delay_in_days: d },
        subject: `{{muninn_subject_${i + 1}}}`,
        email_body: `{{muninn_body_${i + 1}}}`,
      })),
    });
  }

  async addLead(campaignId: string, lead: SmartleadLeadInput): Promise<unknown> {
    return this.call('POST', `/campaigns/${campaignId}/leads`, {
      lead_list: [
        {
          email: lead.email,
          first_name: lead.firstName,
          last_name: lead.lastName,
          custom_fields: lead.customFields,
        },
      ],
      settings: { ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_duplicate_leads_in_other_campaign: false },
    });
  }

  async setCampaignStatus(campaignId: string, status: 'PAUSED' | 'START'): Promise<void> {
    await this.call('POST', `/campaigns/${campaignId}/status`, { status });
  }

  // Belt + suspenders: Smartlead stops on reply/unsub itself (campaign
  // setting); this yanks a lead explicitly. 404s are soft — log, don't throw.
  async stopLead(campaignId: string, email: string): Promise<boolean> {
    try {
      await this.call('POST', `/campaigns/${campaignId}/leads/${encodeURIComponent(email)}/pause`, {});
      return true;
    } catch (e) {
      console.warn('[smartlead] stopLead soft-failed:', e instanceof Error ? e.message.slice(0, 200) : e);
      return false;
    }
  }
}
