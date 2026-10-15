import { describe, expect, it } from 'vitest';
import {
  buildOutputVerificationPrompt,
  publicWebClaimFindings,
  requestedPublicPageReceiptFindings,
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
const documentId = 'document123456';
function nativeDocPage(start: number, end: number, total: number, complete: boolean) {
  return {
    toolName: 'docs.get',
    status: 'succeeded',
    fromCurrentTask: true,
    args: { documentId, startOffset: start, maxChars: end - start },
    result: {
      documentId,
      title: 'Source document',
      url: `https://docs.google.com/document/d/${documentId}/edit`,
      text: 'x'.repeat(end - start),
      complete,
      truncated: !complete,
      receipt: {
        version: 1,
        source: { kind: 'google-doc', id: documentId, revision: 'rev-1' },
        requested: { start, limit: end - start, scope: 'body' },
        covered: { start, end, count: end - start, total, unavailable: 0 },
        complete,
        losses: complete ? [] : ['character-budget'],
        continuation: complete
          ? null
          : { tool: 'docs.get', input: { documentId, startOffset: end, maxChars: end - start } },
      },
    },
  };
}

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

  it('binds requested page identity through a safe redirect and accepts its final URL citation', async () => {
    const requestedUrl = 'https://transit.example/redirect';
    const redirectedRequest = request.replace(url, `${requestedUrl}.`);
    const redirectEvidence = structuredClone(evidence);
    const row = redirectEvidence[0];
    if (!row) throw new Error('Missing source fixture');
    row.args = { url: requestedUrl };
    row.result.finalUrl = url;
    const redirectSummary = summary;
    const router = {
      object: async () => ({
        ok: true,
        finishReason: 'stop',
        object: { decision: 'publish', reasons: [] },
      }),
    };

    expect(requestedPublicPageReceiptFindings(redirectedRequest, redirectEvidence)).toEqual([]);
    const result = await verifyFinalOutput(router as never, {
      taskId: 'redirected-source',
      request: redirectedRequest,
      draft: redirectSummary,
      evidence: redirectEvidence,
      critical: true,
    });
    expect(result.text).toBe(redirectSummary);
    expect(result.incomplete).not.toBe(true);
  });

  it('requires a redirect-bound final URL when the owner requests a source link', async () => {
    const requestedUrl = 'https://transit.example/redirect';
    const redirectedRequest = request.replace(url, requestedUrl);
    const redirectEvidence = structuredClone(evidence);
    const row = redirectEvidence[0];
    if (!row) throw new Error('Missing source fixture');
    row.args = { url: requestedUrl };
    row.result.finalUrl = url;
    const noCitation = summary.replace(` [Source](${url})`, '');
    let calls = 0;
    const result = await verifyFinalOutput(
      {
        object: async () => {
          calls += 1;
          return {
            ok: true,
            finishReason: 'stop',
            object: { decision: 'publish', reasons: [] },
          };
        },
      } as never,
      {
        taskId: 'redirect-without-citation',
        request: redirectedRequest,
        draft: noCitation,
        evidence: redirectEvidence,
        critical: true,
      },
    );
    expect(calls).toBe(2);
    expect(result.incomplete).toBe(true);
    expect(result.text).toContain(url);
  });

  it.each(['failed', 'stale', 'truncated', 'wrong-page', 'unsafe-final', 'empty-page'] as const)(
    'fails closed for an explicit page request with a %s receipt, without spending a review call',
    async (kind) => {
      const rows = structuredClone(evidence);
      const row = rows[0];
      if (!row) throw new Error('Missing source fixture');
      if (kind === 'failed') row.status = 'failed';
      if (kind === 'stale') row.fromCurrentTask = false;
      if (kind === 'truncated') row.result.truncated = true;
      if (kind === 'wrong-page') row.args = { url: 'https://transit.example/another-page' };
      if (kind === 'unsafe-final')
        row.result.finalUrl = 'https://user:pass@transit.example/airport';
      if (kind === 'empty-page') row.result.text = '  \n';
      let calls = 0;
      const result = await verifyFinalOutput(
        {
          object: async () => {
            calls += 1;
            return { ok: false };
          },
        } as never,
        {
          taskId: `missing-page-${kind}`,
          request,
          draft: summary,
          evidence: rows,
          critical: true,
        },
      );
      expect(calls).toBe(0);
      expect(result).toMatchObject({ incomplete: true, unavailable: false, attempted: false });
      expect(result.text).toContain('couldn’t verify a complete current read');
      expect(result.text).not.toContain('R10 links Central');
    },
  );

  it('requires a distinct matching receipt for every explicitly requested page', async () => {
    const secondUrl = 'https://transit.example/rail';
    const multiPageRequest = `Read ${url} and ${secondUrl}, then summarize both pages.`;
    const result = await verifyFinalOutput({ object: async () => ({ ok: false }) } as never, {
      taskId: 'missing-one-page',
      request: multiPageRequest,
      draft: summary,
      evidence,
      critical: true,
    });
    expect(result).toMatchObject({ incomplete: true, attempted: false });
    expect(result.text).not.toContain('R10 links Central');
  });

  it('does not require a page fetch for a web-search-only summary', async () => {
    const searchRequest =
      'Search the web for recent airport transport options and summarize them with source links.';
    const searchEvidence = [
      {
        toolName: 'web.search',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { query: 'airport transport' },
        result: { results: [{ title: 'Airport transport', url }] },
      },
    ];
    const draft = `- Rail options vary by route. [Source](${url})`;
    const result = await verifyFinalOutput(
      {
        object: async () => ({
          ok: true,
          finishReason: 'stop',
          object: { decision: 'publish', reasons: [] },
        }),
      } as never,
      {
        taskId: 'search-only',
        request: searchRequest,
        draft,
        evidence: searchEvidence,
        critical: true,
      },
    );
    expect(result.text).toBe(draft);
    expect(result.incomplete).not.toBe(true);
  });

  it('accepts a current ID-bound native Google Doc read without demanding web.fetch', () => {
    const documentUrl = `https://docs.google.com/document/d/${documentId}/edit`;
    const nativeRead = [nativeDocPage(0, 5, 5, true)];
    expect(
      requestedPublicPageReceiptFindings(
        `Read ${documentUrl} and summarize its contents.`,
        nativeRead,
      ),
    ).toEqual([]);
  });

  it('requires contiguous coverage from offset zero for paginated native document reads', () => {
    const documentUrl = `https://docs.google.com/document/d/${documentId}/edit`;
    const request = `Read ${documentUrl} and summarize its contents.`;
    expect(requestedPublicPageReceiptFindings(request, [nativeDocPage(4, 8, 8, true)])).toEqual([
      'No complete current native read receipt is bound to 1 requested Workspace document.',
    ]);
    expect(
      requestedPublicPageReceiptFindings(request, [
        nativeDocPage(0, 4, 8, false),
        nativeDocPage(4, 8, 8, true),
      ]),
    ).toEqual([]);
    expect(
      requestedPublicPageReceiptFindings(request, [
        nativeDocPage(0, 3, 8, false),
        nativeDocPage(4, 8, 8, true),
      ]),
    ).toEqual([
      'No complete current native read receipt is bound to 1 requested Workspace document.',
    ]);
    const changedRevisionTail = nativeDocPage(4, 8, 8, true);
    changedRevisionTail.result.receipt.source.revision = 'rev-2';
    expect(
      requestedPublicPageReceiptFindings(request, [
        nativeDocPage(0, 4, 8, false),
        changedRevisionTail,
      ]),
    ).toEqual([
      'No complete current native read receipt is bound to 1 requested Workspace document.',
    ]);
  });

  it('accepts a complete current native receipt despite redundant earlier partial reads', () => {
    const documentUrl = `https://docs.google.com/document/d/${documentId}/edit`;
    const request = `Read ${documentUrl} and summarize its contents.`;
    const partial = nativeDocPage(0, 4, 8, false);
    const full = nativeDocPage(0, 8, 8, true);
    expect(requestedPublicPageReceiptFindings(request, [partial, full])).toEqual([]);
    expect(
      requestedPublicPageReceiptFindings(request, [partial, partial, nativeDocPage(4, 8, 8, true)]),
    ).toEqual([]);
  });

  it('keeps the public-page receipt requirement when a request mixes a native Doc and public page', () => {
    const documentUrl = `https://docs.google.com/document/d/${documentId}/edit`;
    const mixedRequest = `Read ${documentUrl} and ${url}, then summarize both sources.`;
    const nativeRead = [nativeDocPage(0, 5, 5, true)];
    expect(requestedPublicPageReceiptFindings(mixedRequest, nativeRead)).toEqual([
      'No complete current web.fetch receipt is bound to 1 requested public page.',
    ]);
    expect(requestedPublicPageReceiptFindings(mixedRequest, [...nativeRead, ...evidence])).toEqual(
      [],
    );
  });

  it.each([
    [
      'quoted rewrite text',
      `Rewrite this quoted sentence for clarity: “Read ${url} and summarize its contents.”`,
    ],
    ['explicit no-browse instruction', `Do not browse; explain how this URL is structured: ${url}`],
    ['no-browse instruction with a summary request', `Don’t browse; summarize this page: ${url}`],
    [
      'curly-apostrophe no-browse instruction',
      `Don’t browse; explain how this URL is structured: ${url}`,
    ],
    [
      'search-results summary',
      `Search the web for this URL and summarize the search results: ${url}`,
    ],
  ])('does not turn %s into a page-fetch requirement', (_name, nonReadRequest) => {
    expect(requestedPublicPageReceiptFindings(nonReadRequest, [])).toEqual([]);
  });

  it('keeps the public page gate when an unrelated private-source prohibition is present', () => {
    expect(
      requestedPublicPageReceiptFindings(
        `Do not read my emails, but read ${url} and summarize it.`,
        [],
      ),
    ).toHaveLength(1);
    expect(
      requestedPublicPageReceiptFindings(`Read ${url}. Do not browse my saved files.`, []),
    ).toHaveLength(1);
    expect(
      requestedPublicPageReceiptFindings(`Read ${url} and do not browse my saved files.`, []),
    ).toHaveLength(1);
  });

  it('binds each page-read verb to its own URL target', () => {
    const otherUrl = 'https://example.test/quoted-page';
    expect(
      requestedPublicPageReceiptFindings(`Read ${url} and translate “Visit ${otherUrl}”.`, []),
    ).toEqual(['No complete current web.fetch receipt is bound to 1 requested public page.']);
    expect(requestedPublicPageReceiptFindings(`Read '${url}' and summarize it.`, [])).toHaveLength(
      1,
    );
  });

  it('gates explicitly quoted URL targets for summary and review requests', () => {
    expect(requestedPublicPageReceiptFindings(`Summarize '${url}'`, [])).toHaveLength(1);
    expect(requestedPublicPageReceiptFindings(`Summarize '${url}'`, evidence)).toEqual([]);
    expect(requestedPublicPageReceiptFindings(`Summarize this page: '${url}'`, [])).toHaveLength(1);
    expect(requestedPublicPageReceiptFindings(`Review the contents of '${url}'`, [])).toHaveLength(
      1,
    );

    const documentUrl = `https://docs.google.com/document/d/${documentId}/edit`;
    expect(requestedPublicPageReceiptFindings(`Summarize '${documentUrl}'`, [])).toEqual([
      'No complete current native read receipt is bound to 1 requested Workspace document.',
    ]);
    expect(
      requestedPublicPageReceiptFindings(`Summarize this page: '${documentUrl}'`, [
        nativeDocPage(0, 5, 5, true),
      ]),
    ).toEqual([]);
  });

  it.each(['browse', 'open', 'fetch', 'visit', 'read', 'load'])(
    'does not require a fetch when the owner says not to %s that URL',
    (verb) => {
      expect(
        requestedPublicPageReceiptFindings(`Do not ${verb} ${url}; explain how HTTPS works.`, []),
      ).toEqual([]);
    },
  );

  it('associates URLs with their own clauses and permits an explicitly quoted URL target', () => {
    const firstUrl = 'https://a.example/page';
    const quotedExample = 'https://b.example/page';
    expect(
      requestedPublicPageReceiptFindings(
        `Read ${firstUrl}; translate “Visit ${quotedExample}”.`,
        [],
      ),
    ).toEqual(['No complete current web.fetch receipt is bound to 1 requested public page.']);
    expect(requestedPublicPageReceiptFindings(`Read '${firstUrl}' and summarize it.`, [])).toEqual([
      'No complete current web.fetch receipt is bound to 1 requested public page.',
    ]);
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
