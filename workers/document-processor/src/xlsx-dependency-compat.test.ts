import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { extractDocument } from './extract.js';

describe('ExcelJS archive dependency compatibility', () => {
  it('keeps minimatch 3 callable through CommonJS brace-expansion and round-trips XLSX', async () => {
    const require = createRequire(import.meta.url);
    const exceljsRequire = createRequire(require.resolve('exceljs/package.json'));
    const archiverRequire = createRequire(exceljsRequire.resolve('archiver/package.json'));
    const globRequire = createRequire(archiverRequire.resolve('glob/package.json'));
    const minimatch = globRequire('minimatch') as (path: string, pattern: string) => boolean;

    expect(typeof minimatch).toBe('function');
    expect(minimatch('report-2.xlsx', 'report-{1,2}.xlsx')).toBe(true);

    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Compatibility').addRow(['patch levels', 21, 7]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const extracted = await extractDocument(
      bytes,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'compatibility.xlsx',
    );

    expect(extracted).toMatchObject({
      kind: 'text',
      detail: 'spreadsheet with cell coordinates',
      structure: { complete: true, representation: 'cell-addresses' },
    });
    expect(extracted.text).toContain('# Sheet "Compatibility"');
    expect(extracted.text).toContain('Row 1: A1="patch levels" | B1="21" | C1="7"');
  });
});
