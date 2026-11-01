import type { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { extractDocument } from './extract.js';

describe('ExcelJS archive dependency compatibility', () => {
  it('uses patched glob/minimatch through CommonJS and round-trips XLSX', async () => {
    const require = createRequire(import.meta.url);
    const exceljsRequire = createRequire(require.resolve('exceljs/package.json'));
    const archiverRequire = createRequire(exceljsRequire.resolve('archiver/package.json'));
    const archiverUtilsRequire = createRequire(
      archiverRequire.resolve('archiver-utils/package.json'),
    );
    const globRequire = createRequire(archiverUtilsRequire.resolve('glob/package.json'));
    const globPackage = globRequire('glob/package.json') as { version: string };
    const minimatchPackage = globRequire('minimatch/package.json') as { version: string };
    const minimatchModule = globRequire('minimatch') as {
      minimatch?: (path: string, pattern: string) => boolean;
    };
    const minimatch = minimatchModule.minimatch;

    expect(globPackage.version).toBe('14.0.2');
    expect(minimatchPackage.version).toBe('11.0.1');
    expect(minimatch?.('report-2.xlsx', 'report-{1,2}.xlsx')).toBe(true);

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

  it('keeps archiver glob options and readdir-glob matching compatible in a temp tree', async () => {
    const require = createRequire(import.meta.url);
    const exceljsRequire = createRequire(require.resolve('exceljs/package.json'));
    const archiverRequire = createRequire(exceljsRequire.resolve('archiver/package.json'));
    const archiverUtilsRequire = createRequire(
      archiverRequire.resolve('archiver-utils/package.json'),
    );
    const globRequire = createRequire(archiverUtilsRequire.resolve('glob/package.json'));
    const archiverUtils = archiverUtilsRequire('archiver-utils') as {
      file: { expand: (options: Record<string, unknown>, pattern: string) => string[] };
    };
    const readdirGlob = archiverRequire('readdir-glob') as (
      root: string,
      options: Record<string, unknown>,
    ) => EventEmitter;
    const globPackage = globRequire('glob/package.json') as { version: string };
    const minimatchPackage = globRequire('minimatch/package.json') as { version: string };
    const glob = globRequire('glob') as {
      glob: (pattern: string, options: { cwd: string; signal: AbortSignal }) => Promise<string[]>;
    };
    const root = await mkdtemp(join(tmpdir(), 'assistant-xlsx-glob-'));

    try {
      await mkdir(join(root, 'nested', 'excluded'), { recursive: true });
      await writeFile(join(root, 'nested', 'match.txt'), 'match');
      await writeFile(join(root, 'nested', '.hidden.txt'), 'hidden');
      await writeFile(join(root, 'nested', 'excluded', 'skip.txt'), 'skip');

      expect(globPackage.version).toBe('14.0.2');
      expect(minimatchPackage.version).toBe('11.0.1');
      expect(
        archiverUtils.file
          .expand({ cwd: root, dot: true, ignore: ['**/excluded/**'] }, '**/*.txt')
          .sort(),
      ).toEqual(['nested/.hidden.txt', 'nested/match.txt']);

      const readdirMatches = await new Promise<string[]>((resolve, reject) => {
        const matches: string[] = [];
        readdirGlob(root, { pattern: '**/*.txt', nodir: true, skip: ['**/excluded'] })
          .on('match', (match: { relative: string }) => matches.push(match.relative))
          .on('error', reject)
          .on('end', () => resolve(matches));
      });
      expect(readdirMatches).toEqual(['nested/match.txt']);

      const controller = new AbortController();
      controller.abort();
      await expect(
        glob.glob('**/*.txt', { cwd: root, signal: controller.signal }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
