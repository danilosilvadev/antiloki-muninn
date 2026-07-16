// OpenRouter client — plain fetch against /chat/completions with structured
// output (json_schema). Provider-agnostic by construction: the model is an env
// value, never a literal at a call site.

export interface StructuredCallResult {
  parsed: unknown;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  raw: unknown;
}

type FetchFn = typeof fetch;

export class OpenRouterClient {
  constructor(
    private readonly opts: {
      apiKey: string;
      baseUrl: string;
      model: string;
      fetchFn?: FetchFn;
    },
  ) {
    // money-guard: tests must inject fetchFn — a test run may never reach a paid vendor
    if (!opts.fetchFn && (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test')) {
      throw new Error('OpenRouterClient: tests must inject fetchFn (money-guard)');
    }
  }

  get model(): string {
    return this.opts.model;
  }

  private get fetchFn(): FetchFn {
    return this.opts.fetchFn ?? fetch;
  }

  async structured(call: {
    system: string;
    user: string;
    schemaName: string;
    jsonSchema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<StructuredCallResult> {
    const res = await this.fetchFn(`${this.opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
        'x-title': 'muninn',
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0.2,
        max_tokens: call.maxTokens ?? 4000,
        messages: [
          { role: 'system', content: call.system },
          { role: 'user', content: call.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: call.schemaName, strict: true, schema: call.jsonSchema },
        },
        usage: { include: true },
      }),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok || json == null) {
      throw new Error(`openrouter ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
    }
    const j = json as { choices?: { message?: { content?: unknown } }[]; usage?: Record<string, unknown> };
    const content = j.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error(`openrouter: empty content in ${JSON.stringify(json).slice(0, 400)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(content));
    } catch {
      throw new Error(`openrouter: content is not JSON: ${content.slice(0, 200)}`);
    }
    const usage = j.usage ?? {};
    return {
      parsed,
      tokensIn: numOrNull(usage['prompt_tokens']),
      tokensOut: numOrNull(usage['completion_tokens']),
      costUsd: numOrNull(usage['cost']),
      raw: json,
    };
  }
}

export function stripFences(s: string): string {
  const t = s.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return m ? m[1] : t;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
