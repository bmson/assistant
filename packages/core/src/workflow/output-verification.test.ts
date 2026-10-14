import { describe, expect, it } from 'vitest';
import {
  buildOutputVerificationPrompt,
  OUTPUT_VERIFICATION_SYSTEM,
  type OutputVerification,
  publicWebClaimFindings,
  repairRequestedBullets,
  verifyFinalOutput,
} from './output-verification.js';

describe('self-reflective output verification', () => {
  it.each(['introduction', 'missing-section', 'truncated'] as const)(
    'preserves a detailed checked answer after a %s revision',
    async (kind) => {
      const draft = `## Background\n${'The source describes a completed January appointment. '.repeat(8)}\n\n## Current work\n${'The owner is developing a calendar integration. '.repeat(8)}`;
      const revision =
        kind === 'missing-section'
          ? `## Background\n${'The source describes a completed January appointment. '.repeat(8)}`
          : 'The owner has an interesting professional background.';
      const router = {
        object: async () => ({
          ok: true,
          modelId: 'test',
          degraded: false,
          finishReason: kind === 'truncated' ? 'length' : 'stop',
          object: { decision: 'revise', revisedText: revision, reasons: [] },
        }),
      };
      const result = await verifyFinalOutput(router as never, {
        taskId: 't',
        request: 'Give a detailed profile including background and current work.',
        draft,
        evidence: [],
        critical: true,
      });
      expect(result.text).toBe(draft);
      expect(result.revised).toBe(false);
    },
  );
  it('carries bounded follow-up context separately from outcome evidence', () => {
    const prompt = buildOutputVerificationPrompt({
      request: 'Yes, please',
      draft: 'The confirmation says check-in is at 3 PM.',
      evidence: [],
      context: [
        { role: 'system', content: 'SYSTEM_SECRET' },
        { role: 'tool', content: 'RAW_TOOL_SECRET' },
        { role: 'user', parts: [{ type: 'text', text: 'Where are we staying?' }] },
        { role: 'assistant', content: 'I can check the hotel confirmation.' },
      ],
    });
    expect(prompt).toContain('conversation_context_not_evidence');
    expect(prompt).toContain('Where are we staying?');
    expect(prompt).toContain('I can check the hotel confirmation.');
    expect(prompt).not.toMatch(/SYSTEM_SECRET|RAW_TOOL_SECRET/);
    expect(OUTPUT_VERIFICATION_SYSTEM).toContain(
      'Earlier assistant claims, offers, and card labels are not evidence',
    );

    const bounded = buildOutputVerificationPrompt({
      request: 'What is the address?',
      draft: 'Not confirmed.',
      evidence: [],
      context: [
        { role: 'user', content: 'STALE_SUBJECT' },
        ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'x'.repeat(50_000) })),
      ],
    });
    expect(bounded).not.toContain('STALE_SUBJECT');
    expect(bounded.length).toBeLessThan(4_500);
  });

  it('keeps current source evidence ahead of unrelated old tool results under the cap', () => {
    const prompt = buildOutputVerificationPrompt({
      request: 'Check the score',
      draft: 'The game is tied.',
      evidence: [
        ...Array.from({ length: 30 }, () => ({
          toolName: 'memory.recall',
          status: 'succeeded',
          result: { text: 'x'.repeat(3000) },
          fromCurrentTask: false,
        })),
        { toolName: 'web.fetch', status: 'succeeded', result: { text: 'CURRENT_GAME_SCORE' } },
      ],
    });
    expect(prompt).toContain('CURRENT_GAME_SCORE');
    expect(prompt.length).toBeLessThan(13000);
  });

  it('keeps web source status separate from a bounded long evidence excerpt', async () => {
    const longSource = `${'Opening page text. '.repeat(140)}\n\nPublic transport option: take the S-Bahn to the airport.\n${'Later page text. '.repeat(900)}`;
    let verifierPrompt = '';
    const router = {
      object: async (_role: string, input: { prompt: string }) => {
        verifierPrompt = input.prompt;
        return {
          ok: true as const,
          modelId: 'test/rewrite',
          degraded: false,
          object: { decision: 'publish' as const, reasons: [] },
        };
      },
    };

    await verifyFinalOutput(router as never, {
      taskId: 'task-long-fetch',
      request: 'Summarize the verified transport option.',
      draft: 'The page lists an S-Bahn option.',
      evidence: [
        {
          toolName: 'web.fetch',
          status: 'succeeded',
          result: {
            status: 200,
            contentType: 'text/html',
            finalUrl: 'https://transit.example/airport',
            truncated: false,
            text: longSource,
          },
        },
      ],
      critical: true,
    });

    const durable = verifierPrompt.match(
      /<durable_evidence>\n([\s\S]*?)\n<\/durable_evidence>/,
    )?.[1];
    expect(durable).toBeDefined();
    const evidence = JSON.parse(durable ?? '{}') as {
      status: string;
      source: {
        httpStatus: number;
        sourceTruncated: boolean | null;
        sourceExcerpt: string;
        sourceExcerptOmittedChars: number;
      };
    };
    expect(evidence.status).toBe('succeeded');
    expect(evidence.source.httpStatus).toBe(200);
    expect(evidence.source.sourceTruncated).toBe(false);
    expect(evidence.source.sourceExcerptOmittedChars).toBeGreaterThan(0);
    expect(evidence.source.sourceExcerpt).toContain(
      'Public transport option: take the S-Bahn to the airport.',
    );
    expect(evidence.source.sourceExcerpt).not.toContain('[truncated]');
    expect(verifierPrompt.length).toBeLessThan(13_000);
  });

  it('preserves an actual source-truncation signal separately from excerpt clipping', () => {
    const prompt = buildOutputVerificationPrompt({
      request: 'What does the source say?',
      draft: 'The source is incomplete.',
      evidence: [
        {
          toolName: 'web.fetch',
          status: 'succeeded',
          result: {
            status: 200,
            finalUrl: 'https://source.example/page',
            truncated: true,
            text: 'The fetcher reports that the document ended at its configured limit.',
          },
        },
      ],
    });
    const durable = prompt.match(/<durable_evidence>\n([\s\S]*?)\n<\/durable_evidence>/)?.[1];
    const evidence = JSON.parse(durable ?? '{}') as {
      source: { sourceTruncated: boolean | null; sourceExcerptOmittedChars: number };
    };
    expect(evidence.source.sourceTruncated).toBe(true);
    expect(evidence.source.sourceExcerptOmittedChars).toBe(0);
  });

  it('retains separately bound late service passages and their transfer qualifiers', () => {
    const source = [
      'Airport transport overview',
      'R10',
      '- Route: Central - Airport',
      '- Frequency: every 15 minutes',
      'Page information. '.repeat(900),
      '731',
      '- Route: Town - Junction',
      '- Frequency: hourly',
      '- Continue to the airport with R10.',
      'B12&nbsp;',
      '- Route: Market - Airport',
      '- Frequency: every 20 minutes',
      'B120',
      '- Route: Unrelated town - Harbor',
    ].join('\n');
    const prompt = buildOutputVerificationPrompt({
      request: 'Give a short summary of the official transport options.',
      draft: 'R10, 731 and B12 all serve the airport.',
      evidence: [
        { toolName: 'web.fetch', status: 'succeeded', result: { text: source, truncated: false } },
      ],
    });
    const durable = prompt.match(/<durable_evidence>\n([\s\S]*?)\n<\/durable_evidence>/)?.[1];
    const evidence = JSON.parse(durable ?? '{}') as {
      source: {
        sourceTruncated: boolean;
        sourcePassages: {
          label: string;
          startOffset: number;
          endOffset: number;
          text: string;
          omittedChars: number;
        }[];
        sourcePassagesOmittedCount: number;
      };
    };
    expect(evidence.source.sourceTruncated).toBe(false);
    expect(evidence.source.sourcePassages.map((passage) => passage.label)).toEqual([
      'R10',
      '731',
      'B12',
    ]);
    const connection = evidence.source.sourcePassages.find((passage) => passage.label === '731');
    expect(connection?.text).toContain('Continue to the airport with R10.');
    expect(connection?.text).not.toContain('every 15 minutes');
    expect(connection?.omittedChars).toBe(0);
    for (const passage of evidence.source.sourcePassages)
      expect(source.slice(passage.startOffset, passage.endOffset)).toBe(passage.text);
    expect(evidence.source.sourcePassagesOmittedCount).toBe(0);
    expect(prompt.length).toBeLessThan(13_000);
  });

  it('keeps the web evidence cap and records losses for many long named entries', () => {
    const source = Array.from(
      { length: 30 },
      (_, i) => `B${i + 10}\n${'Service information. '.repeat(1000)}`,
    ).join('\n');
    const prompt = buildOutputVerificationPrompt({
      request: 'Compare the listed options.',
      draft: Array.from({ length: 30 }, (_, i) => `B${i + 10}`).join(', '),
      evidence: [{ toolName: 'web.fetch', status: 'succeeded', result: { text: source } }],
    });
    const durable = prompt.match(/<durable_evidence>\n([\s\S]*?)\n<\/durable_evidence>/)?.[1];
    const evidence = JSON.parse(durable ?? '{}');
    expect(durable?.length).toBeLessThanOrEqual(12_000);
    expect(evidence.source.sourcePassagesOmittedCount).toBe(6);
    expect(
      evidence.source.sourcePassages.every(
        (passage: { omittedChars: number }) => passage.omittedChars > 0,
      ),
    ).toBe(true);
    expect(evidence.source.sourceTruncated).toBeNull();
  });

  it('keeps failed web reads distinguishable from successful or truncated source content', () => {
    const prompt = buildOutputVerificationPrompt({
      request: 'Check this page.',
      draft: 'The page could not be read.',
      evidence: [
        {
          toolName: 'web.fetch',
          status: 'failed',
          error: 'upstream request failed',
          result: {
            status: 503,
            finalUrl: 'https://source.example/page',
            truncated: false,
            text: '',
          },
        },
      ],
    });
    const durable = prompt.match(/<durable_evidence>\n([\s\S]*?)\n<\/durable_evidence>/)?.[1];
    const evidence = JSON.parse(durable ?? '{}') as {
      status: string;
      error: string;
      source: { httpStatus: number; sourceTruncated: boolean | null };
    };
    expect(evidence.status).toBe('failed');
    expect(evidence.error).toBe('upstream request failed');
    expect(evidence.source.httpStatus).toBe(503);
    expect(evidence.source.sourceTruncated).toBe(false);
  });

  it('treats unrequested emoji as a final-response defect', () => {
    expect(OUTPUT_VERIFICATION_SYSTEM).toMatch(/emoji are not decoration/i);
    expect(OUTPUT_VERIFICATION_SYSTEM).toMatch(/explicitly request an emoji/i);
    expect(OUTPUT_VERIFICATION_SYSTEM).toMatch(/complete emoji-free replacement/i);
  });

  it('checks entity attributes against their own source entries and honors concise formats', () => {
    expect(OUTPUT_VERIFICATION_SYSTEM).toMatch(
      /each entity and each claimed attribute against its own source passage/i,
    );
    expect(OUTPUT_VERIFICATION_SYSTEM).toMatch(
      /a shared stop or segment does not establish another route/i,
    );
    expect(OUTPUT_VERIFICATION_SYSTEM).toMatch(/three concise bullets/i);
    expect(OUTPUT_VERIFICATION_SYSTEM).toMatch(/keep source links with the bullet they support/i);
  });

  it('asks the verifier to reject obvious repeated or corrupted fragments', () => {
    expect(OUTPUT_VERIFICATION_SYSTEM).toMatch(/generation loops/i);
    expect(OUTPUT_VERIFICATION_SYSTEM).toMatch(/replacement-character corruption/i);
    expect(OUTPUT_VERIFICATION_SYSTEM).toMatch(/do not guess at damaged words or numbers/i);
  });

  it('uses a complete verifier revision and leaves final safety enforcement to its caller', async () => {
    const router = {
      object: async () => ({
        ok: true as const,
        modelId: 'test/rewrite',
        degraded: false,
        object: {
          decision: 'revise',
          revisedText: 'I can confirm the document was created.',
          reasons: ['clarity_or_format'],
        } satisfies OutputVerification,
      }),
    };

    await expect(
      verifyFinalOutput(router as never, {
        taskId: 'task-1',
        request: 'Was the document created?',
        draft: 'Done.',
        evidence: [],
        critical: true,
      }),
    ).resolves.toEqual({
      text: 'I can confirm the document was created.',
      attempted: true,
      revised: true,
      unavailable: false,
    });
  });

  it('keeps the checked draft when the verifier is budget-blocked or unavailable', async () => {
    const router = {
      object: async () => ({
        ok: false as const,
        decision: { mode: 'park' as const, reason: 'cap' },
      }),
    };

    await expect(
      verifyFinalOutput(router as never, {
        taskId: 'task-1',
        request: 'Say hi',
        draft: 'Hi!',
        evidence: [],
        critical: true,
      }),
    ).resolves.toEqual({ text: 'Hi!', attempted: false, revised: false, unavailable: true });
  });

  it('keeps the checked draft when the verifier provider throws', async () => {
    const router = {
      object: async () => {
        throw new Error('rewrite provider unavailable');
      },
    };

    await expect(
      verifyFinalOutput(router as never, {
        taskId: 'task-1',
        request: 'Say hi',
        draft: 'Hi!',
        evidence: [],
        critical: true,
      }),
    ).resolves.toEqual({ text: 'Hi!', attempted: false, revised: false, unavailable: true });
  });

  it('marks enclosed evidence as data and excludes tool arguments from the verifier prompt', () => {
    const prompt = buildOutputVerificationPrompt({
      request: 'What happened?',
      draft: 'I sent it.',
      evidence: [
        {
          toolName: 'gmail.send',
          status: 'succeeded',
          args: { apiKey: 'must-not-leak' },
          result: { messageId: 'm-1' },
        },
      ],
    });

    expect(prompt).toContain('<durable_evidence>');
    expect(prompt).toContain('messageId');
    expect(prompt).not.toContain('must-not-leak');
  });
});

describe('source-bound public service summaries', () => {
  const body = `Airport Express (FEX)
- Route: Berlin Hauptbahnhof - Potsdamer Platz - Südkreuz - Airport
- Frequency: every 15 minutes (jointly four services per hour with RE20 until December 2026)
- Travel time: Hauptbahnhof 23 minutes; Südkreuz 14 minutes

RE20
- Route: Berlin Hauptbahnhof - Potsdamer Platz - Südkreuz - Airport
- Frequency: hourly (jointly four services per hour with FEX until December 2026)
- Travel time: Hauptbahnhof 23 minutes; Südkreuz 14 minutes

RB22
- Route: Potsdam - Griebnitzsee - Airport
- Frequency: hourly

RB32&nbsp;
- Route: Oranienburg - Ostkreuz - Airport
- Frequency: hourly

S-Bahn trains (S9, S85)
S9
- Route: Spandau - Charlottenburg - Alexanderplatz - Airport
- Frequency: every 20 minutes

S85
- Route: Frohnau - Ostkreuz - Airport
- Frequency: every 20 minutes

Express buses (X7, X71)
X7&#160;
- Route: Rudow - Airport
- Frequency: every 5–10 minutes

X71
- Route: Alt-Mariendorf - Rudow - Airport
- Frequency: every 20 minutes

BER2 (subject to surcharge)
- Route: Potsdam - Airport
- Frequency: 16x daily
- Ticket can be purchased only on the bus

163
- Route: Schöneweide - Schönefeld station
- Frequency: every 20 minutes
- Continue to the airport with S9/S85

743&#xA0;
- Route: Lichtenrade - Wassmannsdorf (change here to S9/S85 to Airport)
- Frequency: hourly

N7X
- Route: Zoologischer Garten - Airport
- Frequency: every 15 minutes
- Runs in this direction only

Frequently asked questions
Other text.
`;
  const source = `${'Navigation filler. '.repeat(600)}
${body}`;
  const evidence = [
    {
      toolName: 'web.fetch',
      status: 'succeeded',
      result: {
        status: 200,
        finalUrl: 'https://transit.example/services',
        text: source,
        truncated: false,
      },
    },
  ];
  const request = 'Summarize this page in three short bullets with a source link.';
  const bad =
    '- **Rail FEX, RE20, RB22, RB32** — depart from Berlin Hauptbahnhof, Potsdamer Platz and Südkreuz to Airport; travel time ~14–23 minutes, every 15 minutes jointly until December 2026.- **S9 and S85** — from Spandau, Charlottenburg and Alexanderplatz to Airport every 20 minutes.- **Buses 163 and 743** — also serve the airport.Source: [Source](https://transit.example/services)';
  const good = `- **Rail** — FEX links Berlin Hauptbahnhof with the airport every 15 minutes; RE20 is hourly, with the shared frequency qualified until December 2026.
- **S-Bahn** — S9 and S85 reach the airport every 20 minutes; their city origins and stops differ.
- **Buses** — X7 serves the airport from Rudow, while 163 requires a change to S9/S85. [Source](https://transit.example/services)`;

  it('retains parenthetical IDs, NBSP/entity headings, qualifiers and original source offsets under the evidence cap', () => {
    const draft = 'FEX RE20 RB22 RB32 S9 S85 X7 X71 BER2 163 743 N7X';
    const prompt = buildOutputVerificationPrompt({ request, draft, evidence });
    const durable = prompt.match(/<durable_evidence>\n([\s\S]*?)\n<\/durable_evidence>/)?.[1] ?? '';
    const projected = JSON.parse(durable).source;
    expect(projected.sourcePassages.map((passage: { label: string }) => passage.label)).toEqual(
      draft.split(' '),
    );
    for (const passage of projected.sourcePassages) {
      expect(source.slice(passage.startOffset, passage.endOffset)).toBe(passage.text);
      expect(passage.omittedChars).toBe(0);
    }
    expect(
      projected.sourcePassages.find((passage: { label: string }) => passage.label === 'FEX').text,
    ).toContain('December 2026');
    expect(
      projected.sourcePassages.find((passage: { label: string }) => passage.label === '163').text,
    ).toContain('Continue to the airport');
    expect(
      projected.sourcePassages.find((passage: { label: string }) => passage.label === '743').text,
    ).toContain('change here');
    expect(
      projected.sourcePassages.find((passage: { label: string }) => passage.label === 'N7X').text,
    ).not.toContain('Frequently asked questions');
    expect(durable.length).toBeLessThanOrEqual(12_000);
  });

  it('detects cross-service frequency, travel-time and origin borrowing plus omitted transfers', () => {
    const findings = publicWebClaimFindings(repairRequestedBullets(request, bad), evidence);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('RB22: the shared frequency'),
        expect.stringContaining('RB32: the shared travel-time'),
        expect.stringContaining('S85: the shared origin/stop'),
        expect.stringContaining('163: its source requires'),
        expect.stringContaining('743: its source requires'),
      ]),
    );
    expect(publicWebClaimFindings(good, evidence)).toEqual([]);
    expect(
      publicWebClaimFindings(
        'FEX and RE20 run jointly every 15 minutes until December 2026.',
        evidence,
      ),
    ).toEqual([]);
  });

  it('derives a shared cadence only from its own service count and preserves its stated cutoff', () => {
    const rows = [
      {
        toolName: 'web.fetch',
        status: 'succeeded',
        result: {
          status: 200,
          text: 'R10\n- Frequency: hourly; until May 2027 both lines jointly run two services per hour\nR20\n- Frequency: hourly',
          truncated: false,
        },
      },
    ];
    expect(
      publicWebClaimFindings('R10 runs jointly every 30 minutes until May 2027.', rows),
    ).toEqual([]);
    expect(publicWebClaimFindings('R10 runs jointly every 30 minutes.', rows)).not.toEqual([]);
    expect(
      publicWebClaimFindings('R10 runs jointly every 30 minutes until May 2028.', rows),
    ).not.toEqual([]);
  });

  it('does not equate B12 with B120 or treat an HTTP error or truncated read as complete evidence', () => {
    const rows = [
      {
        toolName: 'web.fetch',
        status: 'succeeded',
        result: { status: 200, text: 'B12\n- Frequency: hourly', truncated: false },
      },
    ] as const;
    expect(publicWebClaimFindings('B120 is hourly.', rows)).toContain(
      'B120: this identifier is absent from complete current source evidence.',
    );
    for (const changes of [{ status: 503 }, { truncated: true }])
      expect(
        publicWebClaimFindings('B12 is hourly.', [
          { ...rows[0], result: { ...rows[0]?.result, ...changes } },
        ]),
      ).toContain('B12: this identifier is absent from complete current source evidence.');
  });

  it('keeps exact service boundaries when one identifier is a prefix of another', () => {
    const rows = [
      {
        toolName: 'web.fetch',
        status: 'succeeded',
        result: {
          status: 200,
          text: 'B12\n- Frequency: hourly\nB120\n- Frequency: every 15 minutes',
          truncated: false,
        },
      },
    ];
    expect(publicWebClaimFindings('B120 runs every 15 minutes.', rows)).toEqual([]);
    expect(publicWebClaimFindings('B12 runs every 15 minutes.', rows)).toContain(
      'B12: the shared frequency “every 15 minutes” is not stated by its own Frequency passage.',
    );
  });

  it('does not erase independently evidenced private identifiers in a mixed-source task', () => {
    const rows = [
      ...evidence,
      {
        toolName: 'calendar.list_events',
        status: 'succeeded',
        result: { events: [{ summary: 'Flight UA123' }] },
      },
    ];
    expect(
      publicWebClaimFindings(
        'Flight UA123 is in the calendar. S9 reaches the airport every 20 minutes.',
        rows,
      ),
    ).toEqual([]);
    expect(publicWebClaimFindings('Flight UA124 is in the calendar.', rows)).not.toEqual([]);
  });

  it('does not interpret source-link path identifiers as service claims', () => {
    const rows = [
      {
        toolName: 'web.fetch',
        status: 'succeeded',
        result: { status: 200, text: 'General transport information.', truncated: false },
      },
    ];
    expect(publicWebClaimFindings('See [Source](https://transit.example/T99).', rows)).toEqual([]);
  });

  it('repairs only exact requested collapsed bold bullet markers, preserving words and links', () => {
    const fixed = repairRequestedBullets(request, bad);
    expect(fixed.match(/^-/gm)).toHaveLength(3);
    expect(fixed).toContain('\n\nSource: [Source]');
    expect(fixed.replace(/\s/g, '')).toBe(bad.replace(/\s/g, ''));
    expect(repairRequestedBullets('Use two bullets.', bad)).toBe(bad);
    expect(repairRequestedBullets('Give an overview.', bad)).toBe(bad);
    const fenced = ['```', bad, '```'].join('\n');
    expect(repairRequestedBullets(request, fenced)).toBe(fenced);
    expect(
      repairRequestedBullets(request, 'Costs: - **one** and - **two**, plus - **three**.'),
    ).toBe('Costs: - **one** and - **two**, plus - **three**.');
  });

  it('performs one targeted correction when a reviewer publishes the same conflation', async () => {
    const prompts: string[] = [];
    const router = {
      object: async (_role: string, input: { prompt: string }) => {
        prompts.push(input.prompt);
        return {
          ok: true,
          finishReason: 'stop',
          object:
            prompts.length === 1
              ? { decision: 'publish', reasons: [] }
              : { decision: 'revise', revisedText: good, reasons: ['ungrounded_fact'] },
        };
      },
    };
    const result = await verifyFinalOutput(router as never, {
      taskId: 'web',
      request,
      draft: bad,
      evidence,
      critical: true,
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('source_attribute_findings');
    expect(prompts[1]).toContain('RB22');
    expect(result).toMatchObject({ text: good, revised: true, unavailable: false });
  });

  it('does not publish contradicted details after a second bad revision or unavailable correction', async () => {
    for (const failure of ['bad', 'unavailable', 'length', 'throw']) {
      let calls = 0;
      const router = {
        object: async () => {
          calls++;
          if (calls === 1) return { ok: true, object: { decision: 'publish', reasons: [] } };
          if (failure === 'throw') throw new Error('Unavailable');
          return failure === 'unavailable'
            ? { ok: false }
            : {
                ok: true,
                finishReason: failure === 'length' ? 'length' : 'stop',
                object: { decision: 'revise', revisedText: bad, reasons: [] },
              };
        },
      };
      const result = await verifyFinalOutput(router as never, {
        taskId: 'web',
        request,
        draft: bad,
        evidence,
        critical: true,
      });
      expect(calls).toBe(2);
      expect(result.text).toContain('couldn’t verify');
      expect(result.text).toContain('[Source](https://transit.example/services)');
      expect(result.text).not.toMatch(/RB22|Spandau|163/);
    }
  });
});
