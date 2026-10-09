import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { GoogleClient } from './client.js';
import { a1Range, a1StartRange, registerSheetsTools } from './sheets.js';

const DEPS = { ownerEmail: 'owner@example.com' };

function toolsWith(api: ReturnType<typeof vi.fn>) {
  const registry = new ToolRegistry();
  registerSheetsTools(registry, { client: { api } as unknown as GoogleClient, ...DEPS });
  return registry;
}

describe('Google Sheets tools', () => {
  it('quotes a tab name safely for A1 notation', () => {
    expect(a1StartRange("Q1 team's plan")).toBe("'Q1 team''s plan'!A1");
    expect(a1Range("Q1 team's plan", 'B12')).toBe("'Q1 team''s plan'!B12");
  });

  it('creates, fills, and shares a sheet using literal cell values', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({
        spreadsheetId: 'SHEET-123_abc',
        spreadsheetUrl: 'https://sheets.example.test/SHEET-123_abc',
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const tool = toolsWith(api).get('sheets.create')?.tool;

    const result = (await tool?.execute(
      {
        title: 'Budget',
        sheetName: 'April',
        rows: [
          ['Item', 'Cost'],
          ['=SUM(A1:A2)', 12],
        ],
      },
      {} as never,
    )) as { spreadsheetId: string; url: string; sharedWith: string };

    expect(result).toEqual({
      spreadsheetId: 'SHEET-123_abc',
      title: 'Budget',
      url: 'https://sheets.example.test/SHEET-123_abc',
      sharedWith: 'owner@example.com',
    });
    const [createUrl, createInit] = api.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe('https://sheets.googleapis.com/v4/spreadsheets');
    expect(JSON.parse(String(createInit.body))).toEqual({
      properties: { title: 'Budget' },
      sheets: [{ properties: { title: 'April' } }],
    });
    const [valueUrl, valueInit] = api.mock.calls[1] as [string, RequestInit];
    expect(valueUrl).toContain('valueInputOption=RAW');
    expect(JSON.parse(String(valueInit.body))).toEqual({
      majorDimension: 'ROWS',
      values: [
        ['Item', 'Cost'],
        ['=SUM(A1:A2)', 12],
      ],
    });
  });

  it('offers creation, append, and read only to trusted owner work', () => {
    const registry = toolsWith(vi.fn());
    expect(registry.toolsForTask('unknown').map((tool) => tool.name)).not.toContain(
      'sheets.create',
    );
    expect(registry.toolsForTask('owner').map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'sheets.create',
        'sheets.append_rows',
        'sheets.write_rows',
        'sheets.get_rows',
      ]),
    );
  });

  it('keys append_rows idempotently: stable per call, distinct per rows', () => {
    const key = toolsWith(vi.fn()).get('sheets.append_rows')?.tool.idempotencyKey;
    expect(key).toBeDefined();
    if (!key) return;
    const ctx = { taskId: 'task-1' } as never;
    const base = { spreadsheetId: 'S1', sheetName: 'April', rows: [['a', 'b']] };
    expect(key(base, ctx)).toBe(key(base, ctx));
    expect(key(base, ctx)).not.toBe(key({ ...base, rows: [['a', 'c']] }, ctx));
  });

  it('updates a precise range using raw values', async () => {
    const api = vi.fn().mockResolvedValue({});
    const tool = toolsWith(api).get('sheets.write_rows')?.tool;

    const result = await tool?.execute(
      {
        spreadsheetId: 'SHEET-123_abc',
        sheetName: 'Applications',
        startCell: 'A7',
        rows: [['Acme', 'Applied', '=not a formula']],
      },
      {} as never,
    );

    expect(result).toMatchObject({ writtenRows: 1, startCell: 'A7' });
    const [url, init] = api.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(encodeURIComponent("'Applications'!A7"));
    expect(url).toContain('valueInputOption=RAW');
    expect(JSON.parse(String(init.body))).toEqual({
      majorDimension: 'ROWS',
      values: [['Acme', 'Applied', '=not a formula']],
    });
  });

  it('returns an exact continuation for a bounded row read and reaches later rows', async () => {
    const allRows = [['header'], ['ordinary'], ['decisive fact']];
    const api = vi.fn(async (url: string) => {
      if (url.includes('?fields=spreadsheetId')) {
        return {
          spreadsheetId: 'SHEET-123_abc',
          sheets: [
            {
              properties: {
                sheetId: 9,
                title: 'Evidence',
                gridProperties: { rowCount: 3, columnCount: 1 },
              },
            },
          ],
        };
      }
      const range = decodeURIComponent(url.split('/values/')[1] ?? '');
      const start = Number(range.match(/A(\d+):/)?.[1] ?? 1);
      const end = Number(range.match(/:ZZ(\d+)$/)?.[1] ?? start);
      return { values: allRows.slice(start - 1, end) };
    });
    const tool = toolsWith(api).get('sheets.get_rows')?.tool;
    const input = {
      spreadsheetId: 'SHEET-123_abc',
      sheetName: 'Evidence',
      startRow: 1,
      maxRows: 2,
    };
    const first = (await tool?.execute(input, {} as never)) as {
      rows: unknown[][];
      complete: boolean;
      continuation: { tool: string; input: { startRow: number } };
      receipt: { complete: boolean; covered: { count: number; total: number; ranges: unknown[] } };
    };
    expect(first.rows).toEqual(allRows.slice(0, 2));
    expect(first.complete).toBe(false);
    expect(first.receipt).toMatchObject({
      complete: false,
      covered: { count: 2, total: 3, ranges: [{ startRow: 0, endRow: 2 }] },
    });
    expect(first.continuation).toMatchObject({ tool: 'sheets.get_rows', input: { startRow: 3 } });

    const second = (await tool?.execute(
      { ...input, ...first.continuation.input },
      {} as never,
    )) as {
      rows: unknown[][];
      complete: boolean;
      receipt: { covered: { count: number; total: number } };
    };
    expect(second.rows).toEqual([['decisive fact']]);
    expect(second.complete).toBe(false); // A page is not a claim that earlier rows were also read.
    expect(second.receipt.covered).toEqual(expect.objectContaining({ count: 1, total: 3 }));
  });
});
