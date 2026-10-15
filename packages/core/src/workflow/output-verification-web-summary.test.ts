import { describe, expect, it } from 'vitest';
import {
  buildOutputVerificationPrompt,
  publicWebClaimFindings,
  shortBulletFindings,
  verifyFinalOutput,
} from './output-verification.js';

// Sanitized source-shaped replay of a successful, untruncated airport page:
// navigation precedes early rail entries and later buses/transfer qualifiers.
const url = 'https://transit.example/airport';
const source = [
  'Airport transport',
  'Navigation and airport services. '.repeat(130),
  'Regional trains and express buses connect the city with the airport.',
  'The train station is below Terminal 1; bus stops are at arrivals level.',
  'Airport Express (R10)',
  '- Route: Central - Airport',
  '- Frequency: every 15 minutes',
  'R20',
  '- Route: West - Airport',
  '- Frequency: hourly',
  'Other airport information. '.repeat(300),
  'Express buses (B10)',
  '- Route: South - Airport',
  '- Frequency: every 20 minutes',
  'B20',
  '- Route: North - Interchange',
  '- Continue to Airport with R10.',
  'Frequently asked questions',
].join('\n');
const evidence = [
  {
    toolName: 'web.fetch',
    status: 'succeeded',
    fromCurrentTask: true,
    args: { url },
    result: { status: 200, finalUrl: url, text: source, truncated: false },
  },
];
const request = `Read ${url} and summarize the public transport options in three short bullets with a source link. Do not use my email, calendar, or memories.`;
const summary = [
  '- **Rail:** R10 runs every 15 minutes; R20 runs hourly.',
  '- **Direct bus:** B10 connects South with the airport every 20 minutes.',
  `- **Transfer bus:** B20 ends at Interchange; continue to Airport with R10. [Source](${url})`,
].join('\n');
const verbose = `## Rail\n${'The rail service connects Central with Airport. '.repeat(35)}\n## Buses\n${'Some buses require a transfer. '.repeat(35)}\n[Source](${url})`;

describe('source-grounded public page summary recovery', () => {
  it('keeps early and late source units, offsets and omissions available for a generic refusal', () => {
    const prompt = buildOutputVerificationPrompt({
      request,
      draft: 'I could not summarize the page.',
      evidence,
    });
    const durable = prompt.match(/<durable_evidence>\n([\s\S]*?)\n<\/durable_evidence>/)?.[1];
    const projected = JSON.parse(durable ?? '{}').source;
    expect(projected.sourceTruncated).toBe(false);
    expect(projected.sourcePassages.map((passage: { label: string }) => passage.label)).toEqual([
      'R10',
      'R20',
      'B10',
      'B20',
    ]);
    for (const passage of projected.sourcePassages)
      expect(source.slice(passage.startOffset, passage.endOffset)).toBe(passage.text);
    expect(projected.sourcePassages.at(-1).text).toContain('Continue to Airport');
    expect(durable?.length).toBeLessThanOrEqual(12_000);
  });

  it('publishes the exact concise correction draft after a semantic reviewer approves it', async () => {
    const prompts: string[] = [];
    const router = {
      object: async (_role: string, input: { prompt: string }) => {
        prompts.push(input.prompt);
        return {
          ok: true,
          finishReason: 'stop',
          object:
            prompts.length === 1
              ? { decision: 'revise', revisedText: summary, reasons: ['ungrounded_fact'] }
              : { decision: 'publish', reasons: [], revisedText: 'UNSUBMITTED_REPLACEMENT' },
        };
      },
    };
    const result = await verifyFinalOutput(router as never, {
      taskId: 'summary',
      request,
      draft: verbose,
      evidence,
      critical: true,
    });
    expect(summary.length).toBeLessThan(verbose.length / 3);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('<completion_findings>');
    expect(prompts[1]).toContain(`<proposed_response>\n${summary}\n</proposed_response>`);
    expect(prompts[1]).not.toContain(verbose);
    expect(result).toMatchObject({
      text: summary,
      attempted: true,
      revised: true,
      unavailable: false,
    });
    expect(result.incomplete).not.toBe(true);
    expect(shortBulletFindings(request, result.text)).toEqual([]);
    expect(publicWebClaimFindings(result.text, evidence)).toEqual([]);
  });

  it.each([
    ['missing bullet', summary.split('\n').slice(0, 2).join('\n')],
    ['unfinished', '- Rail:\n- Bus:\n- Connections:'],
    ['unsupported frequency', summary.replace('R20 runs hourly', 'R20 runs every 15 minutes')],
    ['missing source link', summary.replace(` [Source](${url})`, '')],
    ['wrong source link', summary.replace(url, 'https://invented.example/airport')],
  ])('does not publish an approved but %s correction', async (_name, incomplete) => {
    let calls = 0;
    const router = {
      object: async () => ({
        ok: true,
        finishReason: 'stop',
        object:
          ++calls === 1
            ? { decision: 'revise', revisedText: incomplete, reasons: ['ungrounded_fact'] }
            : { decision: 'publish', reasons: [] },
      }),
    };
    const result = await verifyFinalOutput(router as never, {
      taskId: 'incomplete-summary',
      request,
      draft: verbose,
      evidence,
      critical: true,
    });
    expect(calls).toBe(2);
    expect(result.incomplete).toBe(true);
    expect(result.text).not.toBe(incomplete);
    expect(result.text).not.toBe(verbose);
    expect(result.text).toContain('Source');
    expect(result.text).not.toContain('available evidence.');
  });

  it('retains useful source-checked text after a formatting-only outage without declaring completion', async () => {
    let calls = 0;
    const draft = `- R20 runs hourly.\n- B20 ends at Interchange; continue to Airport with R10. [Source](${url})`;
    const result = await verifyFinalOutput(
      {
        object: async () =>
          ++calls === 1
            ? { ok: true, object: { decision: 'publish', reasons: [] } }
            : { ok: false },
      } as never,
      { taskId: 'format-outage', request, draft, evidence, critical: true },
    );
    expect(calls).toBe(2);
    expect(result.text).toContain('R20 runs hourly');
    expect(result.text).toContain(url);
    expect(result.text).toContain('couldn’t complete the requested formatting');
    expect(result).toMatchObject({ incomplete: true, unavailable: true });
  });

  it.each(['failed', 'old', 'truncated'])(
    'does not turn a %s receipt into a readable current page',
    async (kind) => {
      const rows = structuredClone(evidence);
      const row = rows[0];
      if (!row) throw new Error('Missing source fixture');
      if (kind === 'old') row.fromCurrentTask = false;
      if (kind === 'failed') row.result.status = 500;
      if (kind === 'truncated') row.result.truncated = true;
      let calls = 0;
      const result = await verifyFinalOutput(
        {
          object: async () => ({
            ok: true,
            object:
              ++calls === 1
                ? {
                    decision: 'revise',
                    revisedText: 'The supported details are:',
                    reasons: ['ungrounded_fact'],
                  }
                : { decision: 'publish', reasons: [] },
          }),
        } as never,
        { taskId: 'failed-fetch', request, draft: verbose, evidence: rows, critical: true },
      );
      expect(result.incomplete).toBe(true);
      expect(result.text).not.toContain('page was retrieved');
    },
  );
});
