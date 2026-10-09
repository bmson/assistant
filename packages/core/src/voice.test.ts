import { createDb, type Db, writingSamples } from '@assistant/db';
import type { VoiceContextRepository } from '@assistant/persistence';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelRouter } from './model-router/router.js';
import { captureOwnerWritingSample, rewriteInVoice, type VoiceContext } from './voice.js';

const context: VoiceContext = {
  description: 'casual, direct, short sentences',
  dos: ['be brief'],
  donts: ['no corporate polish'],
  signature: '— B Bot',
  samples: ['hey — works for me. see you then.'],
};

const DRAFT = 'Lunch with Katie is confirmed for Friday at 12:00 at Café Loki. Bring the contract.';

/** Scripted fakes: first rewrite drops the date; the check catches it; retry fixes it. */
function fakeRouter(script: {
  rewrites: string[];
  verdicts: Array<{ intact: boolean; problems: string[] }>;
}) {
  let rewriteCall = 0;
  let checkCall = 0;
  return {
    async generate() {
      const text = script.rewrites[rewriteCall] ?? '';
      rewriteCall += 1;
      return { ok: true, modelId: 'fake', degraded: false, text };
    },
    async object() {
      const verdict = script.verdicts[checkCall] ?? { intact: true, problems: [] };
      checkCall += 1;
      return { ok: true, modelId: 'fake', degraded: false, object: verdict };
    },
  } as unknown as ModelRouter;
}

describe('voice pipeline', () => {
  it('skips entirely when there is no profile and no samples', async () => {
    const router = fakeRouter({ rewrites: [], verdicts: [] });
    const result = await rewriteInVoice(router, {
      draft: DRAFT,
      register: 'email_casual',
      context: { description: '', dos: [], donts: [], signature: '', samples: [] },
    });
    expect(result).toEqual({ text: DRAFT, rewritten: false });
  });

  it('accepts a rewrite that preserves every fact', async () => {
    const good = 'lunch w/ Katie confirmed — Friday 12:00, Café Loki. bring the contract.';
    const router = fakeRouter({ rewrites: [good], verdicts: [{ intact: true, problems: [] }] });
    const result = await rewriteInVoice(router, {
      draft: DRAFT,
      register: 'email_casual',
      context,
    });
    expect(result).toEqual({ text: good, rewritten: true });
  });

  it('catches seeded fact drift and recovers on the retry', async () => {
    const drifted = 'lunch w/ Katie confirmed at Café Loki. bring the contract.'; // dropped Friday 12:00
    const fixed = 'lunch w/ Katie confirmed — Friday 12:00, Café Loki. bring the contract.';
    const router = fakeRouter({
      rewrites: [drifted, fixed],
      verdicts: [
        { intact: false, problems: ['dropped the date/time Friday 12:00'] },
        { intact: true, problems: [] },
      ],
    });
    const result = await rewriteInVoice(router, {
      draft: DRAFT,
      register: 'email_casual',
      context,
    });
    expect(result.text).toBe(fixed);
    expect(result.rewritten).toBe(true);
  });

  it('falls back to the original draft (flagged) when both attempts break facts', async () => {
    const bad1 = 'lunch confirmed at Café Loki.';
    const bad2 = 'lunch with Katie on Friday.';
    const router = fakeRouter({
      rewrites: [bad1, bad2],
      verdicts: [
        { intact: false, problems: ['dropped date and contract'] },
        { intact: false, problems: ['dropped time, place, contract'] },
      ],
    });
    const result = await rewriteInVoice(router, {
      draft: DRAFT,
      register: 'email_casual',
      context,
    });
    expect(result.text).toBe(DRAFT); // fails safe to the original
    expect(result.rewritten).toBe(false);
    expect(result.flagged).toMatch(/fact-preservation/);
  });

  it('fails closed to the original when verification is budget-blocked', async () => {
    const generate = vi.fn(async () => ({
      ok: true as const,
      modelId: 'fake',
      degraded: false,
      text: 'lunch is next Tuesday, somewhere else.',
    }));
    const object = vi.fn(async () => ({
      ok: false as const,
      decision: { mode: 'block' as const, reason: 'daily budget exhausted' },
    }));
    const router = { generate, object } as unknown as ModelRouter;

    const result = await rewriteInVoice(router, {
      draft: DRAFT,
      register: 'email_casual',
      context,
    });

    expect(result.text).toBe(DRAFT);
    expect(result.rewritten).toBe(false);
    expect(result.flagged).toMatch(/could not be fact-checked.*daily budget exhausted/);
    expect(generate).toHaveBeenCalledOnce();
    expect(object).toHaveBeenCalledOnce();
  });

  it('fails closed to the original when the verifier throws', async () => {
    const router = {
      generate: async () => ({
        ok: true as const,
        modelId: 'fake',
        degraded: false,
        text: 'rewrite with unknown fidelity',
      }),
      object: async () => {
        throw new Error('provider unavailable');
      },
    } as unknown as ModelRouter;

    const result = await rewriteInVoice(router, {
      draft: DRAFT,
      register: 'sms',
      context,
    });

    expect(result).toEqual({
      text: DRAFT,
      rewritten: false,
      flagged:
        'voice rewrite could not be fact-checked (verifier unavailable); using the original draft',
    });
  });

  it('fails safe to the original when the rewrite model call throws', async () => {
    // A provider error/timeout on the rewrite (generate) must not escape
    // rewriteInVoice — otherwise the throw propagates through the tool prepare
    // hook and fails/parks the whole outbound task instead of just skipping the
    // cosmetic rewrite.
    const router = {
      generate: async () => {
        throw new Error('provider timeout');
      },
      object: async () => ({
        ok: true as const,
        modelId: 'fake',
        degraded: false,
        object: { intact: true, problems: [] },
      }),
    } as unknown as ModelRouter;

    const result = await rewriteInVoice(router, {
      draft: DRAFT,
      register: 'email_casual',
      context,
    });

    expect(result).toEqual({ text: DRAFT, rewritten: false });
  });
});

describe('captureOwnerWritingSample (integration)', () => {
  let db: Db;
  let dbUp = false;
  const marker = `auto:test-${Date.now()}`;
  const embedRouter = {
    embeddingSpace: async () => ({
      provider: 'synthetic',
      model: 'voice-capture-fixture',
      dimensions: 1536,
      revision: '1',
    }),
    embed: async (texts: string[]) => texts.map(() => new Array(1536).fill(0.01)),
  } as unknown as ModelRouter;

  beforeAll(async () => {
    db = createDb(
      process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant',
    );
    try {
      await db.select().from(writingSamples).limit(1);
      dbUp = true;
    } catch {
      console.warn('voice.test: database unreachable — skipping capture tests');
    }
  });

  afterAll(async () => {
    if (dbUp) await db.delete(writingSamples).where(like(writingSamples.context, `${marker}%`));
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  const longText = `Hey — can you grab the flight details and put lunch on Friday at noon? Loki works. Thanks a lot. ${marker}`;

  it('captures a substantial owner message, deduping exact repeats', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const first = await captureOwnerWritingSample(db, embedRouter, {
      text: longText,
      register: 'email_casual',
      context: marker.slice('auto:'.length),
    });
    // Note: production prefixes context with 'auto:'; here we pass the suffix so
    // the row lands under our unique marker for cleanup.
    expect(first).toBe(true);
    const rows = await db.select().from(writingSamples).where(eq(writingSamples.text, longText));
    expect(rows).toHaveLength(1);

    const second = await captureOwnerWritingSample(db, embedRouter, {
      text: longText,
      register: 'email_casual',
      context: marker.slice('auto:'.length),
    });
    expect(second).toBe(false); // exact duplicate not stored twice
  });

  it('skips trivial one-liners below the minimum length', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const stored = await captureOwnerWritingSample(db, embedRouter, {
      text: 'ok thanks',
      register: 'sms',
      context: marker.slice('auto:'.length),
    });
    expect(stored).toBe(false);
  });

  it('rejects an auto sample whose embed finishes after owner erasure', async () => {
    let generation = 'before-erasure';
    let wrote = false;
    const repository: VoiceContextRepository = {
      kind: 'voice-context-repository',
      async profile() {
        return null;
      },
      async hasSamples() {
        return false;
      },
      async nearestSamples() {
        return [];
      },
      async hasSampleText() {
        return false;
      },
      async countSamplesWithContextPrefix() {
        return 0;
      },
      async observationGeneration() {
        return generation;
      },
      async addSample(_input, observed) {
        if (observed !== generation) throw new Error('Privacy erasure changed during observation');
        wrote = true;
      },
    };
    const delayedRouter = {
      embeddingSpace: async () => ({
        provider: 'synthetic',
        model: 'voice-capture-fixture',
        dimensions: 1536,
        revision: '1',
      }),
      embed: async () => {
        generation = 'after-erasure';
        return [new Array(1536).fill(0.01)];
      },
    } as unknown as ModelRouter;
    await expect(
      captureOwnerWritingSample(repository, delayedRouter, {
        text: `${longText} ${marker}`,
        register: 'email_casual',
        context: marker.slice('auto:'.length),
      }),
    ).resolves.toBe(false);
    expect(generation).toBe('after-erasure');
    expect(wrote).toBe(false);
  });
});
