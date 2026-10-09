import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { extractDocument } from './extract.js';

describe('structural office extraction', () => {
  it('preserves leading/interior blanks, row numbers, dimensions and merged headers', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Quarterly');
    sheet.getCell('B2').value = 'Team';
    sheet.getCell('D2').value = 'Amount';
    sheet.getCell('B4').value = 'North';
    sheet.getCell('D4').value = 12;
    sheet.mergeCells('B2:C2');
    const result = await extractDocument(
      Buffer.from(await book.xlsx.writeBuffer()),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'a.xlsx',
    );
    expect(result.text).toContain('Dimensions: 4 rows x 4 columns');
    expect(result.text).toContain('Row 4: A4="" | B4="North" | C4="" | D4="12"');
    expect(result.text).toContain('C2="Team" (merged with B2)');
    expect(result.structure).toEqual({ complete: true, representation: 'cell-addresses' });
  });
  it('extracts later, hidden and empty workbook tabs with their topology', async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('First').getCell('A1').value = 'First fact';
    const later = book.addWorksheet('Later renamed');
    later.state = 'hidden';
    later.getCell('D3').value = 'Only later answer';
    book.addWorksheet('Empty');
    const result = await extractDocument(
      Buffer.from(await book.xlsx.writeBuffer()),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'all-tabs.xlsx',
    );
    expect(result.text).toContain('# Sheet "First"');
    expect(result.text).toContain('# Sheet "Later renamed"');
    expect(result.text).toContain('Visibility: hidden');
    expect(result.text).toContain('D3="Only later answer"');
    expect(result.text).toContain('# Sheet "Empty"');
    expect(result.structure?.complete).toBe(true);
  });
  it('follows declared slide order instead of filenames, retaining empty slides', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/presentation.xml',
      '<p:presentation><p:sldIdLst><p:sldId id="2" r:id="r2"/><p:sldId id="1" r:id="r1"/><p:sldId id="3" r:id="r3"/></p:sldIdLst></p:presentation>',
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/><Relationship Id="r3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/></Relationships>',
    );
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Second declared</a:t></p:sld>');
    zip.file('ppt/slides/slide2.xml', '<p:sld><a:t>First declared</a:t></p:sld>');
    zip.file('ppt/slides/slide3.xml', '<p:sld/>');
    const result = await extractDocument(
      await zip.generateAsync({ type: 'nodebuffer' }),
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'a.pptx',
    );
    expect(result.text).toBe(
      '# Slide 1\nFirst declared\n\n# Slide 2\nSecond declared\n\n# Slide 3',
    );
    expect(result.structure).toEqual({ complete: true, representation: 'ordered-slides' });
    zip.remove('ppt/slides/slide2.xml');
    await expect(
      extractDocument(
        await zip.generateAsync({ type: 'nodebuffer' }),
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'a.pptx',
      ),
    ).rejects.toThrow('content is missing');
  });
});
