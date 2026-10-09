import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { describe, expect, it } from 'vitest';
import { extractDocument } from './extract.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

async function minimalDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Dependency upgrade keeps document text intact.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('Mammoth and argparse compatibility', () => {
  it('continues extracting DOCX text through the document processor', async () => {
    const result = await extractDocument(
      await minimalDocx(),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'compatibility.docx',
    );

    expect(result).toEqual({
      kind: 'text',
      text: 'Dependency upgrade keeps document text intact.',
      detail: 'word document',
    });
    const raw = await mammoth.extractRawText({ buffer: await minimalDocx() });
    expect(raw.value.trim()).toBe('Dependency upgrade keeps document text intact.');
  });

  it('keeps Mammoth CLI camelCase parser aliases and conversion flags working', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'mammoth-cli-compat-'));
    try {
      const packageJson = require.resolve('mammoth/package.json');
      const mammothRequire = createRequire(realpathSync(packageJson));
      const argparsePackageJson = mammothRequire.resolve('argparse/package.json');
      const argparseVersion = JSON.parse(await readFile(argparsePackageJson, 'utf8')).version;
      const { ArgumentParser } = mammothRequire('argparse');
      expect(argparseVersion).toBe('2.0.1');
      expect(typeof ArgumentParser.prototype.addArgument).toBe('function');
      expect(typeof ArgumentParser.prototype.addMutuallyExclusiveGroup).toBe('function');
      expect(typeof ArgumentParser.prototype.parseArgs).toBe('function');

      const cli = path.join(path.dirname(packageJson), 'bin', 'mammoth');
      const input = path.join(temp, 'compatibility.docx');
      const output = path.join(temp, 'compatibility.md');
      await writeFile(input, await minimalDocx());

      const help = await run(process.execPath, [cli, '--help']);
      expect(help.stdout).toContain('--output-format {html,markdown}');
      expect(help.stdout).toContain('--output-dir OUTPUT_DIR');

      await run(process.execPath, [cli, '--output-format', 'markdown', input, output]);
      await expect(readFile(output, 'utf8')).resolves.toContain(
        'Dependency upgrade keeps document text intact\\.',
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
