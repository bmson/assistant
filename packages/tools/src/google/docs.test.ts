import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { GoogleClient } from './client.js';
import {
  buildContentRequests,
  type DocsBatchRequest,
  documentStructure,
  documentText,
  registerDocsTools,
} from './docs.js';

const DEPS = { botEmail: 'bot@example.com', ownerEmail: 'owner@example.com' };

function toolsWith(api: ReturnType<typeof vi.fn>) {
  const registry = new ToolRegistry();
  registerDocsTools(registry, { client: { api } as unknown as GoogleClient, ...DEPS });
  return registry;
}

function insertText(requests: DocsBatchRequest[]): string {
  const insert = requests.find((r) => 'insertText' in r)?.insertText as
    | { text?: string }
    | undefined;
  return insert?.text ?? '';
}

describe('buildContentRequests', () => {
  it('inserts plain paragraphs as a single text block with no styling', () => {
    const { requests } = buildContentRequests('First line\nSecond line', 1);
    expect(requests).toEqual([
      { insertText: { location: { index: 1 }, text: 'First line\nSecond line' } },
    ]);
  });

  it('returns nothing for empty content', () => {
    expect(buildContentRequests('', 1)).toEqual({ requests: [], insertedLength: 0 });
  });

  it('styles headings over the exact paragraph range', () => {
    const { requests } = buildContentRequests('# Title\nBody', 1);
    expect(insertText(requests)).toBe('Title\nBody');
    expect(requests).toContainEqual({
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 6 },
        paragraphStyle: { namedStyleType: 'HEADING_1' },
        fields: 'namedStyleType',
      },
    });
  });

  it('maps heading depth to the matching named style', () => {
    const { requests } = buildContentRequests('### Deep', 1);
    const style = requests.find((r) => 'updateParagraphStyle' in r)?.updateParagraphStyle as {
      paragraphStyle?: { namedStyleType?: string };
    };
    expect(style.paragraphStyle?.namedStyleType).toBe('HEADING_3');
  });

  it('coalesces consecutive bullets into one range but splits across a gap', () => {
    const { requests } = buildContentRequests('- a\n- bb\nplain\n- c', 1);
    const bullets = requests
      .filter((r) => 'createParagraphBullets' in r)
      .map((r) => (r.createParagraphBullets as { range: unknown }).range);
    // text "a\nbb\nplain\nc": "a"=[1,2), "bb"=[3,5) coalesce to [1,5];
    // "plain" breaks the run; "c"=[12,13).
    expect(bullets).toEqual([
      { startIndex: 1, endIndex: 5 },
      { startIndex: 12, endIndex: 13 },
    ]);
  });

  it('offsets every index when appending after existing text', () => {
    const { requests } = buildContentRequests('# H', 40, { leadingNewline: true });
    expect(requests[0]).toEqual({ insertText: { location: { index: 40 }, text: '\nH' } });
    // Leading newline occupies index 40; the heading text starts at 41.
    expect(requests).toContainEqual({
      updateParagraphStyle: {
        range: { startIndex: 41, endIndex: 42 },
        paragraphStyle: { namedStyleType: 'HEADING_1' },
        fields: 'namedStyleType',
      },
    });
  });

  it('keeps indices aligned to UTF-16 code units for astral characters', () => {
    // "😀" is two UTF-16 code units, so the heading on the next line starts at 1 + 2 + 1.
    const { requests } = buildContentRequests('😀\n# H', 1);
    const range = requests.find((r) => 'updateParagraphStyle' in r)?.updateParagraphStyle as {
      range: { startIndex: number };
    };
    expect(range.range.startIndex).toBe(4);
  });
});

describe('documentText', () => {
  it('flattens paragraph text runs and trims trailing newlines', () => {
    const text = documentText({
      body: {
        content: [
          {
            paragraph: {
              elements: [{ textRun: { content: 'Hello ' } }, { textRun: { content: 'world' } }],
            },
          },
          { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
        ],
      },
    });
    expect(text).toBe('Hello world');
  });

  it('retains table rows and cells as readable evidence', () => {
    expect(
      documentText({
        body: {
          content: [
            {
              table: {
                tableRows: [
                  {
                    tableCells: [
                      {
                        content: [{ paragraph: { elements: [{ textRun: { content: 'Name' } }] } }],
                      },
                      {
                        content: [
                          { paragraph: { elements: [{ textRun: { content: 'Status' } }] } },
                        ],
                      },
                    ],
                  },
                  {
                    tableCells: [
                      {
                        content: [
                          { paragraph: { elements: [{ textRun: { content: 'Reykjavik' } }] } },
                        ],
                      },
                      {
                        content: [{ paragraph: { elements: [{ textRun: { content: 'Ready' } }] } }],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe('Name | Status\nReykjavik | Ready');
  });
});

describe('native document structure', () => {
  it('reports real headings, bullets and table rows without treating text markers as formatting', () => {
    const paragraph = (text: string, style?: string, bullet = false) => ({
      paragraph: {
        paragraphStyle: { namedStyleType: style },
        ...(bullet ? { bullet: { listId: 'list-native' } } : {}),
        elements: [{ textRun: { content: `${text}\n` } }],
      },
    });
    const observed = documentStructure({
      body: {
        content: [
          paragraph('Heading', 'HEADING_1'),
          paragraph('One', 'NORMAL_TEXT', true),
          paragraph('Two', 'NORMAL_TEXT', true),
          paragraph('Three', 'NORMAL_TEXT', true),
          {
            table: {
              tableRows: [
                ['Task', 'Owner'],
                ['Read', 'Morgan'],
                ['Review', 'Taylor'],
              ].map((row) => ({ tableCells: row.map((cell) => ({ content: [paragraph(cell)] })) })),
            },
          },
        ],
      },
    });
    expect(observed).toEqual({
      complete: true,
      headings: [{ text: 'Heading', style: 'HEADING_1' }],
      bullets: ['One', 'Two', 'Three'],
      tables: [
        {
          rows: [
            ['Task', 'Owner'],
            ['Read', 'Morgan'],
            ['Review', 'Taylor'],
          ],
        },
      ],
    });
    expect(
      documentStructure({
        body: { content: [paragraph('# Heading - One - Two - Three |Task|Owner| |---|---|')] },
      }),
    ).toEqual({ complete: true, headings: [], bullets: [], tables: [] });
  });
});

describe('registerDocsTools', () => {
  it('creates the doc, writes styled content, and shares it with the owner', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ documentId: 'DOC-123_abc' }) // create
      .mockResolvedValueOnce({}) // batchUpdate
      .mockResolvedValueOnce({}) // share
      .mockResolvedValueOnce({
        permissions: [
          { type: 'user', emailAddress: 'bot@example.com' },
          { type: 'user', emailAddress: 'owner@example.com' },
        ],
      }); // verify ACL
    const tool = toolsWith(api).get('docs.create')?.tool;
    const result = (await tool?.execute(
      { title: 'Plan', content: '# Plan\n- one\n- two' },
      {} as never,
    )) as {
      documentId: string;
      url: string;
      sharedWith: string;
      sharingVerification: string;
      sharingVerificationDiagnostic: {
        status: string;
        reason: string;
        permissionCount: number;
        pagesRead: number;
        fullPageCompletion: boolean;
        unexpectedPrincipal: boolean | null;
        inheritedPermission: boolean | null;
        missingExpectedPrincipal: boolean | null;
        malformedPermissionEntry: boolean;
      };
    };

    expect(result).toEqual({
      documentId: 'DOC-123_abc',
      title: 'Plan',
      url: 'https://docs.google.com/document/d/DOC-123_abc/edit',
      sharedWith: 'owner@example.com',
      sharingVerification: 'verified_owner_only',
      sharingVerificationDiagnostic: {
        status: 'verified_owner_only',
        reason: 'verified',
        permissionCount: 2,
        pagesRead: 1,
        fullPageCompletion: true,
        unexpectedPrincipal: false,
        inheritedPermission: false,
        missingExpectedPrincipal: false,
        malformedPermissionEntry: false,
      },
      contentStructure: {
        complete: true,
        headings: [{ text: 'Plan', style: 'HEADING_1' }],
        bullets: ['one', 'two'],
        tables: [],
      },
    });

    const [createUrl, createInit] = api.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe('https://docs.googleapis.com/v1/documents');
    expect(JSON.parse(String(createInit.body))).toEqual({ title: 'Plan' });

    const [batchUrl] = api.mock.calls[1] as [string];
    expect(batchUrl).toBe('https://docs.googleapis.com/v1/documents/DOC-123_abc:batchUpdate');

    const [shareUrl, shareInit] = api.mock.calls[2] as [string, RequestInit];
    expect(shareUrl).toBe(
      'https://www.googleapis.com/drive/v3/files/DOC-123_abc/permissions?sendNotificationEmail=false',
    );
    expect(JSON.parse(String(shareInit.body))).toEqual({
      role: 'writer',
      type: 'user',
      emailAddress: 'owner@example.com',
    });
  });

  it('retains a sanitized ACL failure diagnostic in the create result', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ documentId: 'DOC-123_abc' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        permissions: [
          { type: 'user', emailAddress: 'bot@example.com' },
          { type: 'user', emailAddress: 'owner@example.com' },
          { type: 'user', emailAddress: 'unexpected@example.com' },
        ],
      });
    const tool = toolsWith(api).get('docs.create')?.tool;
    const result = (await tool?.execute({ title: 'Plan', content: 'Notes' }, {} as never)) as {
      sharingVerification: string;
      sharingVerificationDiagnostic: unknown;
    };

    expect(result.sharingVerification).toBe('not_owner_only');
    expect(result.sharingVerificationDiagnostic).toEqual({
      status: 'not_owner_only',
      reason: 'unexpected_principal',
      permissionCount: 3,
      pagesRead: 1,
      fullPageCompletion: true,
      unexpectedPrincipal: true,
      inheritedPermission: false,
      missingExpectedPrincipal: false,
      malformedPermissionEntry: false,
    });
    expect(JSON.stringify(result.sharingVerificationDiagnostic)).not.toContain('@');
  });

  it('recovers collapsed block boundaries and creates real table cells in separate insert phases', async () => {
    let tableIndex = 0;
    const api = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/documents') && init?.method === 'POST')
        return { documentId: 'NATIVE_DOC_12345' };
      if (url.endsWith(':batchUpdate')) {
        const { requests } = JSON.parse(String(init?.body)) as {
          requests: Array<Record<string, unknown>>;
        };
        const insertTable = requests.find((request) => request.insertTable)?.insertTable as
          | { location: { index: number } }
          | undefined;
        if (insertTable) tableIndex = insertTable.location.index + 1;
        return {};
      }
      if (url.endsWith('/NATIVE_DOC_12345'))
        return {
          body: {
            content: [
              {
                startIndex: tableIndex,
                table: {
                  tableRows: Array.from({ length: 3 }, (_, row) => ({
                    tableCells: Array.from({ length: 2 }, (_, column) => ({
                      content: [
                        {
                          startIndex: tableIndex + 4 + row * 5 + column * 2,
                          paragraph: { elements: [] },
                        },
                      ],
                    })),
                  })),
                },
              },
            ],
          },
        };
      return {};
    });
    const tool = toolsWith(api).get('docs.create')?.tool;
    const result = await tool?.execute(
      {
        title: 'Study plan',
        content:
          '# Study plan  - Read notes  - Discuss findings  - Write summary  | Item | Reviewer |  |---|---|  | Notes | Morgan |  | Findings | Taylor |',
      },
      {} as never,
    );
    expect(result).toMatchObject({
      contentStructure: {
        headings: [{ text: 'Study plan', style: 'HEADING_1' }],
        bullets: ['Read notes', 'Discuss findings', 'Write summary'],
        tables: [
          {
            rows: [
              ['Item', 'Reviewer'],
              ['Notes', 'Morgan'],
              ['Findings', 'Taylor'],
            ],
          },
        ],
      },
    });
    const batches = api.mock.calls
      .filter(([url]) => url.endsWith(':batchUpdate'))
      .map(([, init]) => JSON.parse(String(init?.body)).requests as DocsBatchRequest[]);
    expect(batches).toHaveLength(3);
    expect(insertText(batches[0] ?? [])).toBe(
      'Study plan\nRead notes\nDiscuss findings\nWrite summary',
    );
    expect(batches[1]).toEqual([
      { insertTable: { rows: 3, columns: 2, location: { index: tableIndex - 1 } } },
    ]);
    const cellInserts = (batches[2] ?? []).flatMap((request) =>
      request.insertText
        ? [request.insertText as { text: string; location: { index: number } }]
        : [],
    );
    expect(cellInserts.map((insert) => insert.text)).toEqual([
      'Taylor',
      'Findings',
      'Morgan',
      'Notes',
      'Reviewer',
      'Item',
    ]);
    expect(cellInserts.map((insert) => insert.location.index)).toEqual([
      tableIndex + 16,
      tableIndex + 14,
      tableIndex + 11,
      tableIndex + 9,
      tableIndex + 6,
      tableIndex + 4,
    ]);
    expect(api.mock.calls.findIndex(([url]) => url.endsWith('/NATIVE_DOC_12345'))).toBeLessThan(
      api.mock.calls.findLastIndex(([url]) => url.endsWith(':batchUpdate')),
    );
  });

  it('rejects malformed collapsed tables before creating an artifact', async () => {
    const api = vi.fn();
    await expect(
      toolsWith(api)
        .get('docs.create')
        ?.tool.execute(
          { title: 'Bad table', content: '| A | B | |---|---| | a | b |' },
          {} as never,
        ),
    ).rejects.toThrow('one row per newline');
    expect(api).not.toHaveBeenCalled();
  });

  it('skips the content batchUpdate when no body is given', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ documentId: 'DOC0000000' })
      .mockResolvedValueOnce({});
    const tool = toolsWith(api).get('docs.create')?.tool;
    await tool?.execute({ title: 'Empty', content: '' }, {} as never);
    // create, share and permission verification — no batchUpdate call.
    expect(api).toHaveBeenCalledTimes(3);
    expect((api.mock.calls[1] as [string])[0]).toContain('/permissions');
  });

  it('appends after the document end index on a fresh paragraph', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ body: { content: [{ endIndex: 12 }] } }) // get
      .mockResolvedValueOnce({}); // batchUpdate
    const tool = toolsWith(api).get('docs.append')?.tool;
    await tool?.execute({ documentId: 'DOC0000000', content: 'more' }, {} as never);

    const [, batchInit] = api.mock.calls[1] as [string, RequestInit];
    const { requests } = JSON.parse(String(batchInit.body));
    expect(requests[0]).toEqual({ insertText: { location: { index: 11 }, text: '\nmore' } });
  });

  it('replaces existing text without appending duplicate content', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({
        body: {
          content: [
            {
              paragraph: {
                elements: [
                  { textRun: { content: 'baldvin@bmson.com | linkedin.com/in/baldvin\n' } },
                ],
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        replies: [
          { replaceAllText: { occurrencesChanged: 1 } },
          { replaceAllText: { occurrencesChanged: 1 } },
        ],
      });
    const tool = toolsWith(api).get('docs.replace_text')?.tool;
    const result = await tool?.execute(
      {
        documentId: 'DOC0000000',
        replacements: [
          { oldText: 'baldvin@bmson.com', newText: 'bmson@bmson.com', matchCase: true },
          {
            oldText: 'linkedin.com/in/baldvin',
            newText: 'linkedin.com/in/bmson',
            matchCase: true,
          },
        ],
      },
      {} as never,
    );

    const [batchUrl, batchInit] = api.mock.calls[1] as [string, RequestInit];
    expect(batchUrl).toBe('https://docs.googleapis.com/v1/documents/DOC0000000:batchUpdate');
    expect(JSON.parse(String(batchInit.body))).toEqual({
      requests: [
        {
          replaceAllText: {
            containsText: { text: 'baldvin@bmson.com', matchCase: true },
            replaceText: 'bmson@bmson.com',
          },
        },
        {
          replaceAllText: {
            containsText: { text: 'linkedin.com/in/baldvin', matchCase: true },
            replaceText: 'linkedin.com/in/bmson',
          },
        },
      ],
    });
    expect(result).toMatchObject({ updated: true });
  });

  it('treats an already-applied replacement as an idempotent success', async () => {
    const api = vi.fn().mockResolvedValueOnce({
      body: {
        content: [
          { paragraph: { elements: [{ textRun: { content: 'Contact: bmson@bmson.com\n' } }] } },
        ],
      },
    });
    const tool = toolsWith(api).get('docs.replace_text')?.tool;
    const result = await tool?.execute(
      {
        documentId: 'DOC0000000',
        replacements: [
          { oldText: 'baldvin@bmson.com', newText: 'bmson@bmson.com', matchCase: true },
        ],
      },
      {} as never,
    );

    expect(api).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ updated: false });
  });

  it('shares with a third party as an approval-gated, outward-facing tool', () => {
    const registered = toolsWith(vi.fn()).get('docs.share');
    expect(registered?.tool.risk).toBe('approval');
    expect(registered?.tool.acceptsUntrustedInput).toBe(false);
    expect(registered?.flags.outwardFacing).toBe(true);
  });

  it('keeps doc writes out of untrusted-trigger registries but allows reads to stay gated', () => {
    const registry = toolsWith(vi.fn());
    const unknown = registry.toolsForTask('unknown').map((t) => t.name);
    expect(unknown).not.toContain('docs.create');
    expect(unknown).not.toContain('docs.append');
    expect(unknown).not.toContain('docs.replace_text');
    expect(unknown).not.toContain('docs.get');
    expect(unknown).not.toContain('docs.share');

    const owner = registry.toolsForTask('owner').map((t) => t.name);
    expect(owner).toEqual([
      'docs.create',
      'docs.append',
      'docs.replace_text',
      'docs.get',
      'docs.share',
    ]);
  });

  it('rejects a document id that is not a valid path segment', () => {
    const tool = toolsWith(vi.fn()).get('docs.get')?.tool;
    const parsed = tool?.inputSchema.safeParse({ documentId: '../../etc/passwd' });
    expect(parsed?.success).toBe(false);
  });

  it('continues bounded document reads without losing tables or splitting Unicode', async () => {
    const document = {
      documentId: 'document_123456',
      revisionId: 'rev-7',
      title: 'Plan',
      body: {
        content: [
          { paragraph: { elements: [{ textRun: { content: `${'a'.repeat(98)}😀` } }] } },
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    {
                      content: [
                        { paragraph: { elements: [{ textRun: { content: 'DECISIVE CELL' } }] } },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    const api = vi.fn().mockResolvedValue(document);
    const get = toolsWith(api).get('docs.get')?.tool;
    const firstPage = (await get?.execute(
      { documentId: 'document_123456', maxChars: 100 },
      {} as never,
    )) as {
      text: string;
      complete: boolean;
      receipt: {
        continuation: { input: { startOffset: number } } | null;
        source: { revision: string };
      };
    };
    expect(firstPage.complete).toBe(false);
    expect(firstPage.text).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(firstPage.receipt.source.revision).toBe('rev-7');
    const next = firstPage.receipt.continuation;
    expect(next).toBeTruthy();
    const secondPage = (await get?.execute(
      { documentId: 'document_123456', maxChars: 100, startOffset: next?.input.startOffset },
      {} as never,
    )) as { text: string; complete: boolean; receipt: { complete: boolean } };
    expect(secondPage.text).toContain('DECISIVE CELL');
    expect(secondPage.complete).toBe(true);
    expect(secondPage.receipt.complete).toBe(true);
    expect(api.mock.calls[0]?.[0]).toContain('includeTabsContent=true');
  });
});
