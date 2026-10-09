import { z } from 'zod';
import { sourceReadReceipt } from '../source-read-receipt.js';
import type { GoogleClient } from './client.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const Sheet = z.object({
  properties: z.object({
    sheetId: z.number().int().nonnegative(),
    title: z.string().min(1).max(300),
    index: z.number().int().nonnegative(),
    hidden: z.boolean().optional(),
    sheetType: z.string().optional(),
    gridProperties: z
      .object({
        rowCount: z.number().int().nonnegative(),
        columnCount: z.number().int().nonnegative(),
      })
      .optional(),
  }),
});
const cellError = z.object({ type: z.string(), message: z.string().optional() });
const cell = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.object({ error: cellError }),
]);
const GridCell = z.object({
  effectiveValue: z
    .object({
      stringValue: z.string().optional(),
      numberValue: z.number().finite().optional(),
      boolValue: z.boolean().optional(),
      errorValue: cellError.optional(),
    })
    .optional(),
  formattedValue: z.string().optional(),
  effectiveFormat: z
    .object({ numberFormat: z.object({ type: z.string().optional() }).optional() })
    .optional(),
});
function typedCell(value: z.infer<typeof GridCell>): z.infer<typeof cell> {
  const effective = value.effectiveValue;
  if (effective?.errorValue) return { error: effective.errorValue };
  if (effective?.numberValue !== undefined) {
    const type = value.effectiveFormat?.numberFormat?.type;
    if (type && ['DATE', 'TIME', 'DATE_TIME'].includes(type)) {
      if (value.formattedValue === undefined)
        throw new Error('Spreadsheet date display value is missing');
      return value.formattedValue;
    }
    return effective.numberValue;
  }
  return effective?.stringValue ?? effective?.boolValue ?? null;
}
export const sheetReadOptions = {
  sheetIds: z.array(z.number().int().nonnegative()).min(1).max(20).optional(),
  maxSheets: z.number().int().min(1).max(20).default(20),
  startRow: z.number().int().min(1).max(10_000_000).default(1),
  startColumn: z.number().int().min(1).max(18_278).default(1),
  maxRows: z.number().int().min(1).max(500).default(100),
  maxColumns: z.number().int().min(1).max(100).default(26),
  allowFirstSheetCsvFallback: z.boolean().default(false),
};
const Options = z.object({
  ...sheetReadOptions,
  maxChars: z.number().int().min(100).max(50_000).default(20_000),
});
function columnLabel(index: number): string {
  let result = '';
  for (let number = index; number > 0; number = Math.floor((number - 1) / 26))
    result = String.fromCharCode(65 + ((number - 1) % 26)) + result;
  return result;
}

/** Bounded typed grid reads with all-tab metadata and verified response identities. */
export async function readSpreadsheet(
  client: GoogleClient,
  spreadsheetId: string,
  options: z.input<typeof Options>,
) {
  const args = Options.parse(options);
  let metadata: z.infer<typeof Sheet>[];
  try {
    const response = await client.api<unknown>(
      `${SHEETS}/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,sheets(properties(sheetId,title,index,hidden,sheetType,gridProperties))`,
    );
    const result = z
      .object({ spreadsheetId: z.literal(spreadsheetId), sheets: z.array(Sheet).max(200) })
      .parse(response);
    if (
      new Set(result.sheets.map((sheet) => sheet.properties.sheetId)).size !== result.sheets.length
    )
      throw new Error('Spreadsheet has duplicate sheet identities');
    metadata = result.sheets.sort(
      (a, b) =>
        a.properties.index - b.properties.index || a.properties.sheetId - b.properties.sheetId,
    );
  } catch (error) {
    if (!args.allowFirstSheetCsvFallback)
      throw new Error(
        'Cannot enumerate spreadsheet tabs. Enable Google Sheets read access or explicitly request first-sheet CSV fallback.',
        { cause: error },
      );
    const { body } = await client.apiBytes(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}/export?mimeType=text%2Fcsv`,
    );
    const text = body.toString('utf8');
    return {
      representation: 'first-sheet-csv-fallback' as const,
      complete: false,
      truncated: true,
      text: text.slice(0, args.maxChars),
      tabs: [],
      omittedSheetIds: null,
      continuation: { action: 'Enable Sheets read access and enumerate tabs' },
      coverageUnknown: true,
      receipt: sourceReadReceipt({
        version: 1,
        source: { kind: 'google-sheet', id: spreadsheetId },
        requested: {
          start: args.startRow - 1,
          limit: args.maxRows,
          sheetIds: args.sheetIds,
          scope: 'first-sheet-csv-fallback',
        },
        covered: { count: 0, total: null, unavailable: 0 },
        complete: false,
        losses: ['unsupported-representation', 'coverage-unknown'],
        continuation: null,
      }),
    };
  }
  if (args.sheetIds?.some((id) => !metadata.some((sheet) => sheet.properties.sheetId === id)))
    throw new Error('A requested sheet ID no longer exists. Refresh the tab manifest.');
  const selected = metadata
    .filter((sheet) => !args.sheetIds || args.sheetIds.includes(sheet.properties.sheetId))
    .slice(0, args.maxSheets);
  const selectedIds = new Set(selected.map((sheet) => sheet.properties.sheetId));
  let budget = args.maxChars;
  const textParts: string[] = [];
  const tabs = [];
  const coveredRanges: Array<{
    sourceId: string;
    startRow: number;
    startColumn: number;
    endRow: number;
    endColumn: number;
  }> = [];
  for (const sheet of metadata) {
    const properties = sheet.properties;
    const base = {
      sheetId: properties.sheetId,
      title: properties.title,
      index: properties.index,
      hidden: properties.hidden ?? false,
      gridRows: properties.gridProperties?.rowCount ?? null,
      gridColumns: properties.gridProperties?.columnCount ?? null,
    };
    if (
      !selectedIds.has(properties.sheetId) ||
      budget <= 0 ||
      (properties.sheetType && properties.sheetType !== 'GRID')
    ) {
      tabs.push({
        ...base,
        read: false,
        complete: false,
        reason: !selectedIds.has(properties.sheetId)
          ? 'tab-limit-or-selection'
          : budget <= 0
            ? 'character-budget'
            : 'unsupported-sheet-type',
        values: [],
        continuation: {
          sheetIds: [properties.sheetId],
          startRow: args.startRow,
          startColumn: args.startColumn,
        },
      });
      continue;
    }
    const rows = properties.gridProperties?.rowCount;
    const columns = properties.gridProperties?.columnCount;
    if (rows === undefined || columns === undefined)
      throw new Error(
        'Spreadsheet grid dimensions are missing; completeness cannot be established.',
      );
    if (rows === 0 || columns === 0 || args.startRow > rows || args.startColumn > columns) {
      tabs.push({
        ...base,
        read: true,
        complete: args.startRow === 1 && args.startColumn === 1,
        reason: 'empty-range',
        values: [],
        range: null,
        continuation: null,
      });
      continue;
    }
    const endRow = Math.min(rows, args.startRow + args.maxRows - 1);
    const endColumn = Math.min(columns, args.startColumn + args.maxColumns - 1);
    const range = `'${properties.title.replaceAll("'", "''")}'!${columnLabel(args.startColumn)}${args.startRow}:${columnLabel(endColumn)}${endRow}`;
    // One read returns cell data and its sheet ID together. Verify identity and
    // dimensions so a title renamed/reused between requests cannot relabel facts.
    const query = new URLSearchParams({
      ranges: range,
      fields:
        'spreadsheetId,sheets(properties(sheetId,title,index,hidden,sheetType,gridProperties),data(startRow,startColumn,rowData(values(effectiveValue,formattedValue,effectiveFormat(numberFormat(type))))))',
    });
    const response = await client.api<unknown>(
      `${SHEETS}/${encodeURIComponent(spreadsheetId)}?${query}`,
    );
    const result = z
      .object({
        spreadsheetId: z.literal(spreadsheetId),
        sheets: z
          .array(
            Sheet.extend({
              data: z
                .array(
                  z.object({
                    startRow: z.number().int().nonnegative().optional(),
                    startColumn: z.number().int().nonnegative().optional(),
                    rowData: z
                      .array(
                        z.object({
                          values: z
                            .array(GridCell)
                            .max(endColumn - args.startColumn + 1)
                            .optional(),
                        }),
                      )
                      .max(endRow - args.startRow + 1)
                      .optional(),
                  }),
                )
                .max(1)
                .optional(),
            }),
          )
          .max(200),
      })
      .parse(response);
    const matched = result.sheets.filter(
      (entry) => entry.properties.sheetId === properties.sheetId,
    );
    const current = matched[0];
    if (
      matched.length !== 1 ||
      !current ||
      current.properties.title !== properties.title ||
      current.properties.gridProperties?.rowCount !== rows ||
      current.properties.gridProperties?.columnCount !== columns ||
      (current.properties.hidden ?? false) !== base.hidden
    ) {
      throw new Error(
        'Spreadsheet tab changed while reading. Refresh the manifest and retry by sheet ID.',
      );
    }
    const grid = current.data?.[0];
    if (
      grid &&
      ((grid.startRow ?? 0) !== args.startRow - 1 ||
        (grid.startColumn ?? 0) !== args.startColumn - 1)
    )
      throw new Error('Spreadsheet response returned a different range');
    const values: Array<Array<z.infer<typeof cell>>> = [];
    const returned = (grid?.rowData ?? []).map((row) => (row.values ?? []).map(typedCell));
    const heading = `# Sheet ${JSON.stringify(properties.title)} (id ${properties.sheetId}${base.hidden ? ', hidden' : ''}), range ${range}\n`;
    let text = heading.length <= budget ? heading : '';
    let clipped = heading.length > budget;
    for (let index = 0; index < returned.length; index += 1) {
      const row = returned[index] as Array<z.infer<typeof cell>>;
      const line = `Row ${args.startRow + index}: ${JSON.stringify(row)}\n`;
      if (text.length + line.length > budget) {
        clipped = true;
        break;
      }
      values.push(row);
      text += line;
    }
    budget -= text.length;
    textParts.push(text);
    if (values.length > 0) {
      coveredRanges.push({
        sourceId: String(properties.sheetId),
        startRow: args.startRow - 1,
        startColumn: args.startColumn - 1,
        endRow: args.startRow - 1 + values.length,
        endColumn: endColumn,
      });
    }
    const nextRow = clipped ? args.startRow + values.length : endRow + 1;
    const complete =
      !clipped &&
      args.startRow === 1 &&
      args.startColumn === 1 &&
      endRow === rows &&
      endColumn === columns;
    tabs.push({
      ...base,
      read: true,
      complete,
      range,
      values,
      emptyInReadRange: returned.length === 0,
      reason: clipped ? 'character-budget' : complete ? null : 'bounded-range',
      continuation: clipped
        ? {
            sheetIds: [properties.sheetId],
            startRow: nextRow,
            startColumn: args.startColumn,
            note:
              values.length === 0
                ? 'Increase maxChars or reduce maxColumns; the next row exceeds the character budget.'
                : undefined,
          }
        : endColumn < columns
          ? { sheetIds: [properties.sheetId], startRow: args.startRow, startColumn: endColumn + 1 }
          : endRow < rows
            ? { sheetIds: [properties.sheetId], startRow: endRow + 1, startColumn: 1 }
            : null,
    });
  }
  const complete = tabs.every((tab) => tab.complete);
  const continuableTab = tabs.find(
    (tab) => !tab.complete && tab.continuation && 'sheetIds' in tab.continuation,
  );
  const firstContinuation = continuableTab?.continuation;
  const continuationNeedsMoreChars =
    firstContinuation && 'note' in firstContinuation && firstContinuation.note;
  const canResumeCharacterBudget = !continuationNeedsMoreChars || args.maxChars < 50_000;
  const receiptContinuation =
    firstContinuation && 'sheetIds' in firstContinuation && canResumeCharacterBudget
      ? {
          tool: 'drive.read',
          input: {
            fileId: spreadsheetId,
            sheetIds: firstContinuation.sheetIds,
            startRow: firstContinuation.startRow,
            startColumn: firstContinuation.startColumn,
            maxSheets: args.maxSheets,
            maxRows: args.maxRows,
            maxColumns: args.maxColumns,
            maxChars: continuationNeedsMoreChars ? 50_000 : args.maxChars,
          },
        }
      : null;
  const losses = new Set<
    'character-budget' | 'range-limit' | 'unsupported-representation' | 'continuation-unavailable'
  >(
    tabs.flatMap((tab) => {
      if (tab.complete) return [];
      if (tab.reason === 'character-budget') return ['character-budget'];
      if (tab.reason === 'unsupported-sheet-type') return ['unsupported-representation'];
      return ['range-limit'];
    }),
  );
  if (continuationNeedsMoreChars && !canResumeCharacterBudget)
    losses.add('continuation-unavailable');
  return {
    representation: 'typed-tab-ranges' as const,
    complete,
    truncated: !complete,
    text: textParts.join(''),
    tabs,
    omittedSheetIds: tabs.filter((tab) => !tab.read).map((tab) => tab.sheetId),
    limits: {
      maxSheets: args.maxSheets,
      maxRows: args.maxRows,
      maxColumns: args.maxColumns,
      maxChars: args.maxChars,
    },
    coverageUnknown: false,
    receipt: sourceReadReceipt({
      version: 1,
      source: { kind: 'google-sheet', id: spreadsheetId },
      requested: {
        start: args.startRow - 1,
        limit: args.maxRows,
        sheetIds: args.sheetIds,
        ranges: args.sheetIds?.map((sheetId) => ({
          sourceId: String(sheetId),
          startRow: args.startRow - 1,
          startColumn: args.startColumn - 1,
        })),
        scope: 'grid-tabs',
      },
      covered: {
        count: tabs.filter((tab) => tab.read).length,
        total: metadata.length,
        unavailable: tabs.filter((tab) => !tab.read).length,
        ranges: coveredRanges,
      },
      complete,
      losses: [...losses],
      continuation: receiptContinuation,
    }),
  };
}
