// The dossier contract (C4): zod is the single acceptance gate for the model's
// output — an analysis exists only if it PARSES (the author-accept doctrine).
// z.toJSONSchema(...) feeds the same shape to OpenRouter's structured output.
import { z } from 'zod';

export const ANGLES = ['verification', 'cant_lie', 'memory', 'orchestration'] as const;
export const ICPS = ['agency_owner', 'cto_ai_startup', 'ai_native_builder', 'other'] as const;
export const DRAFT_STEPS = ['day0_email', 'day3_linkedin', 'day6_email', 'day12_email'] as const;

const Draft = z.strictObject({
  step: z.enum(DRAFT_STEPS),
  channel: z.enum(['email', 'linkedin']),
  subject: z.string().max(120).nullable(),
  body: z.string().min(10),
});

export const AnalysisSchema = z.strictObject({
  fit_score: z.number().int().min(0).max(100),
  confidence: z.enum(['low', 'medium', 'high']),
  icp: z.enum(ICPS),
  angle: z.enum(ANGLES),
  pains: z
    .array(z.strictObject({ pain: z.string(), evidence: z.string(), source: z.string() }))
    .max(5),
  hooks: z.array(z.strictObject({ hook: z.string(), evidence: z.string() })).min(1).max(4),
  brief_md: z.string().min(50),
  drafts: z.array(Draft).length(4),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

export function analysisJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AnalysisSchema) as Record<string, unknown>;
}

export function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// Drafts must stay under the 80-word elite bar. Soft-enforced: the analysis is
// kept, violations are surfaced on the dossier for the human gate to see.
export function draftBudgetViolations(a: Analysis): string[] {
  const out: string[] = [];
  for (const d of a.drafts) {
    const words = countWords(d.body);
    if (words > 80) out.push(`${d.step}: ${words} words (budget 80)`);
  }
  return out;
}

export type AcceptResult =
  | { ok: true; analysis: Analysis }
  | { ok: false; issues: string };

// Single acceptance path for model output (never add ad-hoc checks elsewhere).
export function acceptAnalysis(parsed: unknown): AcceptResult {
  const r = AnalysisSchema.safeParse(parsed);
  if (r.success) return { ok: true, analysis: r.data };
  const issues = r.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
    .slice(0, 800);
  return { ok: false, issues };
}
