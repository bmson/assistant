import { describe, expect, it, vi } from 'vitest';
import type { GoogleClient } from './client.js';
import { readSpreadsheet } from './sheet-reading.js';

const id = 'sheet_1234567890';
const properties = (
  sheetId: number,
  title: string,
  index: number,
  rows = 2,
  columns = 2,
  hidden = false,
) => ({
  sheetId,
  title,
  index,
  hidden,
  sheetType: 'GRID',
  gridProperties: { rowCount: rows, columnCount: columns },
});
const first = properties(7, "Owner's facts", 0);
const second = properties(42, 'Later answers', 1, 2, 2, true);
const empty = properties(99, 'Empty', 2);
function mockClient(
  tabs = [first, second, empty],
  data: Record<number, unknown[][]> = {
    7: [['first fact', 12], [false]],
    42: [['later fact', true]],
  },
) {
  const api = vi.fn(async (url: string) => {
    const parsed = new URL(url);
    const range = parsed.searchParams.get('ranges');
    if (!range) return { spreadsheetId: id, sheets: tabs.map((properties) => ({ properties })) };
    const tab = tabs.find((item) => range.startsWith(`'${item.title.replaceAll("'", "''")}'!`));
    if (!tab) throw new Error('unknown range');
    const start = /!([A-Z]+)(\d+):([A-Z]+)(\d+)/.exec(range);
    if (!start?.[1] || !start[2] || !start[3] || !start[4])
      throw new Error('Missing range coordinates');
    let column = 0;
    for (const letter of start[1]) column = column * 26 + letter.charCodeAt(0) - 64;
    let endColumn = 0;
    for (const letter of start[3]) endColumn = endColumn * 26 + letter.charCodeAt(0) - 64;
    const startRow = Number(start[2]);
    const endRow = Number(start[4]);
    const rows = data[tab.sheetId] ?? [];
    return {
      spreadsheetId: id,
      sheets: [
        {
          properties: tab,
          data: [
            {
              startRow: startRow - 1,
              startColumn: column - 1,
              rowData: rows.slice(startRow - 1, endRow).map((values) => ({
                values: values.slice(column - 1, endColumn).map((value) => ({
                  effectiveValue:
                    typeof value === 'string'
                      ? { stringValue: value }
                      : typeof value === 'boolean'
                        ? { boolValue: value }
                        : { numberValue: value },
                })),
              })),
            },
          ],
        },
      ],
    };
  });
  return { api, client: { api, apiBytes: vi.fn() } as unknown as GoogleClient };
}
describe('bounded Google spreadsheet reading', () => {
  it('reads later and hidden tabs, identifies empty tabs, and keeps typed values and quoted names', async () => {
    const { client, api } = mockClient();
    const result = await readSpreadsheet(client, id, {});
    expect(result.complete).toBe(true);
    expect(result.text).toContain('later fact');
    expect(result.tabs).toHaveLength(3);
    expect(result.tabs[0]).toMatchObject({ sheetId: 7, values: [['first fact', 12], [false]] });
    expect(result.tabs[1]).toMatchObject({ sheetId: 42, hidden: true, read: true, complete: true });
    expect(result.tabs[2]).toMatchObject({ sheetId: 99, emptyInReadRange: true, complete: true });
    expect(result.receipt).toMatchObject({
      version: 1,
      source: { kind: 'google-sheet', id },
      complete: true,
      covered: { count: 3, total: 3 },
    });
    expect(new URL(api.mock.calls[1]?.[0] ?? 'invalid').searchParams.get('ranges')).toBe(
      "'Owner''s facts'!A1:B2",
    );
    expect(api.mock.calls.every(([url]) => !url.includes('/values/'))).toBe(true);
  });
  it('uses stable sheet IDs after rename and reorder, and lists omitted tabs', async () => {
    const renamed = properties(42, 'Renamed later', 0);
    const { client } = mockClient([renamed, { ...first, index: 1 }], { 42: [['later fact']] });
    const result = await readSpreadsheet(client, id, { sheetIds: [42] });
    expect(result.complete).toBe(false);
    expect(result.tabs[0]).toMatchObject({
      sheetId: 42,
      title: 'Renamed later',
      values: [['later fact']],
    });
    expect(result.omittedSheetIds).toEqual([7]);
  });
  it('rejects a title reused for a different sheet between metadata and data reads', async () => {
    const { client, api } = mockClient([first]);
    api.mockResolvedValueOnce({ spreadsheetId: id, sheets: [{ properties: first }] });
    api.mockResolvedValueOnce({
      spreadsheetId: id,
      sheets: [{ properties: { ...first, sheetId: 999 }, data: [] }],
    } as never);
    await expect(readSpreadsheet(client, id, {})).rejects.toThrow('tab changed');
  });
  it('returns bounds and continuation for large tabs without claiming workbook completeness', async () => {
    const { client } = mockClient([properties(7, first.title, 0, 1000, 50)], { 7: [['a']] });
    const result = await readSpreadsheet(client, id, { maxRows: 10, maxColumns: 5 });
    expect(result.complete).toBe(false);
    expect(result.tabs[0]).toMatchObject({
      range: "'Owner''s facts'!A1:E10",
      continuation: { sheetIds: [7], startRow: 1, startColumn: 6 },
    });
    expect(result.receipt.continuation).toEqual({
      tool: 'drive.read',
      input: {
        fileId: id,
        sheetIds: [7],
        startRow: 1,
        startColumn: 6,
        maxSheets: 20,
        maxRows: 10,
        maxColumns: 5,
        maxChars: 20000,
      },
    });
  });
  it('continues by stable sheet ID and range to read decisive rows after the boundary', async () => {
    const tab = properties(7, 'Answers', 0, 2, 1);
    const { client } = mockClient([tab], { 7: [['first'], ['DECISIVE after row boundary']] });
    const firstPage = await readSpreadsheet(client, id, { maxRows: 1 });
    expect(firstPage.complete).toBe(false);
    expect(firstPage.tabs[0]?.values).toEqual([['first']]);
    const next = firstPage.receipt.continuation?.input as {
      sheetIds?: number[];
      startRow?: number;
      startColumn?: number;
    };
    expect(next).toMatchObject({ sheetIds: [7], startRow: 2, startColumn: 1 });
    const secondPage = await readSpreadsheet(client, id, {
      sheetIds: next.sheetIds,
      startRow: next.startRow,
      startColumn: next.startColumn,
      maxRows: 1,
    });
    expect(secondPage.tabs[0]?.values).toEqual([['DECISIVE after row boundary']]);
    expect(secondPage.tabs[0]?.continuation).toBeNull();
    expect(secondPage.receipt).toMatchObject({ complete: false, covered: { count: 1, total: 1 } });
  });
  it('never silently slices a cell or row when the character budget runs out', async () => {
    const { client } = mockClient([first, second], { 7: [['x'.repeat(120)]], 42: [['later']] });
    const result = await readSpreadsheet(client, id, { maxChars: 100 });
    expect(result.complete).toBe(false);
    expect(result.tabs[0]).toMatchObject({
      values: [],
      reason: 'character-budget',
      continuation: { startRow: 1 },
    });
    expect(result.text).not.toContain('xxxxx');
    expect(result.tabs[1]?.complete).toBe(false);
  });
  it('requires explicit CSV fallback and marks its tab coverage unknown', async () => {
    const api = vi.fn().mockRejectedValue(new Error('Sheets access unavailable'));
    const apiBytes = vi
      .fn()
      .mockResolvedValue({ body: Buffer.from('first sheet only'), contentType: 'text/csv' });
    const client = { api, apiBytes } as unknown as GoogleClient;
    await expect(readSpreadsheet(client, id, {})).rejects.toThrow('enumerate');
    expect(apiBytes).not.toHaveBeenCalled();
    const result = await readSpreadsheet(client, id, { allowFirstSheetCsvFallback: true });
    expect(result).toMatchObject({
      representation: 'first-sheet-csv-fallback',
      complete: false,
      truncated: true,
      coverageUnknown: true,
      tabs: [],
    });
    expect(apiBytes).toHaveBeenCalledTimes(1);
  });
  it('renders dates and exposes cell errors as errors instead of positive facts', async () => {
    const { client, api } = mockClient([first]);
    api.mockResolvedValueOnce({ spreadsheetId: id, sheets: [{ properties: first }] });
    api.mockResolvedValueOnce({
      spreadsheetId: id,
      sheets: [
        {
          properties: first,
          data: [
            {
              rowData: [
                {
                  values: [
                    {
                      effectiveValue: { numberValue: 45678 },
                      formattedValue: '2025-01-21',
                      effectiveFormat: { numberFormat: { type: 'DATE' } },
                    },
                    {
                      effectiveValue: { errorValue: { type: 'REF', message: 'Missing reference' } },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as never);
    const result = await readSpreadsheet(client, id, {});
    expect(result.tabs[0]?.values).toEqual([
      ['2025-01-21', { error: { type: 'REF', message: 'Missing reference' } }],
    ]);
  });
  it('rejects removed IDs and wrong grid offsets or dimensions', async () => {
    const { client, api } = mockClient([first]);
    await expect(readSpreadsheet(client, id, { sheetIds: [123] })).rejects.toThrow(
      'no longer exists',
    );
    api.mockResolvedValueOnce({ spreadsheetId: id, sheets: [{ properties: first }] });
    api.mockResolvedValueOnce({
      spreadsheetId: id,
      sheets: [{ properties: first, data: [{ startRow: 10 }] }],
    } as never);
    await expect(readSpreadsheet(client, id, {})).rejects.toThrow('different range');
  });
});
