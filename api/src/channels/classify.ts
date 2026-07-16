// C8 · reply classifier — labels only, never acts. A wrong label costs a
// misordered inbox, so failures degrade to "no label" instead of guessing.
import { z } from 'zod';
import { OpenRouterClient } from '../analysis/openrouter.client';

const ReplyLabel = z.strictObject({
  label: z.enum(['positive', 'neutral', 'negative', 'ooo']),
  confidence: z.enum(['low', 'medium', 'high']),
});

export interface ClassifiedReply {
  label: 'positive' | 'neutral' | 'negative' | 'ooo';
  confidence: 'low' | 'medium' | 'high';
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

const SYSTEM = [
  "You label email replies to a B2B founder's low-volume outreach. JSON only.",
  'Labels: positive (interested, asking questions, wants a call) · neutral (maybe later,',
  'forwarded, lukewarm) · negative (no / stop / not interested) · ooo (auto-reply, out of office).',
  'You classify. You never draft replies, and you never act.',
].join(' ');

export async function classifyReply(client: OpenRouterClient, replyText: string): Promise<ClassifiedReply | null> {
  try {
    const r = await client.structured({
      system: SYSTEM,
      user: replyText.slice(0, 2000),
      schemaName: 'muninn_reply_label',
      jsonSchema: z.toJSONSchema(ReplyLabel) as Record<string, unknown>,
      maxTokens: 200,
    });
    const parsed = ReplyLabel.safeParse(r.parsed);
    if (!parsed.success) return null;
    return { ...parsed.data, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd };
  } catch (e) {
    console.warn('[classify] degraded to unlabeled:', e instanceof Error ? e.message.slice(0, 150) : e);
    return null;
  }
}
