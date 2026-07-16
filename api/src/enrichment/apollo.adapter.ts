// Apollo "find similar" adapter (C3) — the ONLY file that knows Apollo's HTTP
// contract. Two modes: colleagues (same company domain, senior roles) and
// lookalike (same title elsewhere). Output feeds the suggestions inbox —
// suggestions only, NEVER auto-queued (plan disposition, P3 rides along).

export interface ApolloPerson {
  name: string | null;
  title: string | null;
  company: string | null;
  linkedinUrl: string | null;
  raw: unknown;
}

export interface FindSimilarInput {
  mode: 'colleagues' | 'lookalike';
  companyDomain?: string | null;
  companyName?: string | null;
  title?: string | null;
  perPage?: number;
}

type FetchFn = typeof fetch;

export class ApolloAdapter {
  constructor(
    private readonly opts: { apiKey: string; baseUrl: string; fetchFn?: FetchFn },
  ) {
    // money-guard: tests must inject fetchFn — a test run may never reach a paid vendor
    if (!opts.fetchFn && (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test')) {
      throw new Error('ApolloAdapter: tests must inject fetchFn (money-guard)');
    }
  }

  private get fetchFn(): FetchFn {
    return this.opts.fetchFn ?? fetch;
  }

  async findSimilar(input: FindSimilarInput): Promise<ApolloPerson[]> {
    // CONTRACT ASSUMPTION (verify on first live call — runbook): POST
    // /mixed_people/search with x-api-key; people[] in the response.
    const body: Record<string, unknown> = { page: 1, per_page: Math.min(input.perPage ?? 10, 25) };
    if (input.mode === 'colleagues') {
      if (input.companyDomain) body['q_organization_domains_list'] = [input.companyDomain];
      else if (input.companyName) body['q_organization_name'] = input.companyName;
      else throw new Error('apollo colleagues mode needs a company domain or name');
      body['person_seniorities'] = ['owner', 'founder', 'c_suite', 'vp', 'head', 'director'];
    } else {
      if (!input.title) throw new Error('apollo lookalike mode needs a title');
      body['person_titles'] = [input.title];
    }
    const res = await this.fetchFn(`${this.opts.baseUrl}/mixed_people/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-cache',
        'x-api-key': this.opts.apiKey,
      },
      body: JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`apollo search ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return mapPeople(json);
  }
}

// Exported for unit tests — all response-shape assumptions live here.
export function mapPeople(json: unknown): ApolloPerson[] {
  const j = (json ?? {}) as Record<string, unknown>;
  const people = (Array.isArray(j['people']) ? j['people'] : Array.isArray(j['contacts']) ? j['contacts'] : []) as
    Record<string, unknown>[];
  return people.map((p) => {
    const org = (p['organization'] ?? {}) as Record<string, unknown>;
    const name =
      (typeof p['name'] === 'string' && p['name']) ||
      [p['first_name'], p['last_name']].filter((x) => typeof x === 'string' && x).join(' ') ||
      null;
    return {
      name,
      title: typeof p['title'] === 'string' ? p['title'] : null,
      company:
        (typeof org['name'] === 'string' && org['name']) ||
        (typeof p['organization_name'] === 'string' && p['organization_name']) ||
        null,
      linkedinUrl: typeof p['linkedin_url'] === 'string' ? p['linkedin_url'] : null,
      raw: p,
    };
  });
}
