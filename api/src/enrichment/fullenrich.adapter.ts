// FullEnrich adapter (C2) — the ONLY file that knows FullEnrich's HTTP contract.
// Contract assumptions (bulk enrich + poll) are concentrated in start() and
// mapPollResponse(); the vendor response is stored verbatim in
// lead_enrichments.raw, so if their shape drifts, the data survives and only
// this file changes. First live call is verified in the slice-1 runbook.
//
// Flag note (P3, tier 2): this acquires business contact data about a person
// via a licensed B2B provider. Built per the approved plan's disposition —
// legitimate-interest basis, suppression checked at ingest, erasure +
// retention land in slice 5.

export interface EnrichStartInput {
  linkedinUrl: string;
  firstname?: string;
  lastname?: string;
  companyHint?: string;
}

export interface EnrichPollResult {
  status: 'pending' | 'done' | 'failed';
  email: string | null;
  emailStatus: 'verified' | 'catch_all' | 'not_found' | null;
  profile: Record<string, unknown> | null;
  company: Record<string, unknown> | null;
  creditsUsed: number | null;
  raw: unknown;
}

type FetchFn = typeof fetch;

export class FullEnrichAdapter {
  constructor(
    private readonly opts: {
      apiKey: string;
      baseUrl: string;
      usdPerCredit: number;
      fetchFn?: FetchFn;
    },
  ) {
    // money-guard: tests must inject fetchFn — a test run may never reach a paid vendor
    if (!opts.fetchFn && (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test')) {
      throw new Error('FullEnrichAdapter: tests must inject fetchFn (money-guard)');
    }
  }

  private get fetchFn(): FetchFn {
    return this.opts.fetchFn ?? fetch;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' };
  }

  async start(input: EnrichStartInput): Promise<{ enrichmentId: string; raw: unknown }> {
    const body = {
      name: `muninn ${input.linkedinUrl}`.slice(0, 80),
      datas: [
        {
          firstname: input.firstname ?? '',
          lastname: input.lastname ?? '',
          ...(input.companyHint ? { company_name: input.companyHint } : {}),
          linkedin_url: input.linkedinUrl,
          enrich_fields: ['contact.emails'],
        },
      ],
    };
    const res = await this.fetchFn(`${this.opts.baseUrl}/contact/enrich/bulk`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`fullenrich start ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    const j = json as Record<string, unknown>;
    const id = j['enrichment_id'] ?? j['id'];
    if (!id) throw new Error(`fullenrich start: no enrichment id in ${JSON.stringify(json).slice(0, 300)}`);
    return { enrichmentId: String(id), raw: json };
  }

  async poll(enrichmentId: string): Promise<EnrichPollResult> {
    const res = await this.fetchFn(`${this.opts.baseUrl}/contact/enrich/bulk/${enrichmentId}`, {
      method: 'GET',
      headers: this.headers(),
    });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`fullenrich poll ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return mapPollResponse(json);
  }

  costUsd(creditsUsed: number | null): number | null {
    return creditsUsed == null ? null : Math.round(creditsUsed * this.opts.usdPerCredit * 1e6) / 1e6;
  }
}

// Exported for unit tests — every contract assumption about the poll shape lives here.
export function mapPollResponse(json: unknown): EnrichPollResult {
  const j = (json ?? {}) as Record<string, unknown>;
  const datas = (Array.isArray(j['datas']) ? j['datas'] : Array.isArray(j['data']) ? j['data'] : []) as
    Record<string, unknown>[];
  const d = datas[0] ?? null;
  const contact = (d?.['contact'] ?? null) as Record<string, unknown> | null;
  const emails = (Array.isArray(contact?.['emails']) ? contact?.['emails'] : []) as Record<string, unknown>[];
  const firstEmail = emails[0] ?? null;

  const statusRaw = String(j['status'] ?? d?.['status'] ?? '').toUpperCase();
  const terminalDone = /FINISH|COMPLET|DONE|SUCCESS/.test(statusRaw);
  const terminalFail = /FAIL|ERROR|CANCEL/.test(statusRaw);

  let status: EnrichPollResult['status'];
  if (terminalFail) status = 'failed';
  else if (terminalDone || firstEmail) status = 'done';
  else status = 'pending';

  let email: string | null = null;
  let emailStatus: EnrichPollResult['emailStatus'] = null;
  if (firstEmail && typeof firstEmail['email'] === 'string') {
    email = firstEmail['email'] as string;
    const s = String(firstEmail['status'] ?? '').toLowerCase();
    emailStatus = /valid|verif|deliverable|safe/.test(s) ? 'verified' : /catch/.test(s) ? 'catch_all' : 'verified';
  } else if (status === 'done') {
    emailStatus = 'not_found';
  }

  const profile = (d?.['profile'] ?? d?.['person'] ?? d ?? null) as Record<string, unknown> | null;
  const company = (d?.['company'] ?? contact?.['company'] ?? null) as Record<string, unknown> | null;

  const creditsRaw = j['credits_used'] ?? d?.['credits_used'] ?? d?.['credits'] ?? null;
  const creditsUsed =
    typeof creditsRaw === 'number' ? creditsRaw : status === 'done' && email ? 1 : status === 'done' ? 0 : null;

  return { status, email, emailStatus, profile, company, creditsUsed, raw: json };
}

// URL-only ingests have no name; FullEnrich matches far better with one. Derive
// a naive guess from the /in/<slug> ("danilo-silva-1a2b3c" → "Danilo Silva") —
// marked as a guess, improved when the operator passes real hints.
export function nameGuessFromSlug(slug: string): { firstname: string; lastname: string } {
  const parts = slug
    .split('-')
    .filter((p) => p && !/^\d+$/.test(p) && !/^[0-9a-f]{6,}$/i.test(p))
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  return { firstname: parts[0] ?? '', lastname: parts.slice(1).join(' ') };
}
