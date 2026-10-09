import { describe, expect, it } from 'vitest';
import {
  decodeXmlEntities,
  extractTagContents,
  normalize,
  parserFor,
  stripRtf,
  xmlText,
} from './text-helpers.js';

describe('document-processor text helpers', () => {
  it('decodes named and numeric XML entities', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &#65; &#x42;')).toBe('a & b <c> A B');
    // & is decoded last so &amp;lt; stays a literal &lt;
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
  });

  it('pulls the inner text of repeated tags (PowerPoint a:t runs)', () => {
    const xml = '<a:p><a:r><a:t>Hello</a:t></a:r><a:r><a:t>World &amp; more</a:t></a:r></a:p>';
    expect(extractTagContents(xml, 'a:t')).toEqual(['Hello', 'World & more']);
  });

  it('flattens OpenDocument-style xml to text with paragraph breaks', () => {
    const xml = '<text:p>First line</text:p><text:p>Second<text:span> part</text:span></text:p>';
    const out = xmlText(xml);
    expect(out).toContain('First line');
    expect(out).toContain('Second part');
    expect(out).not.toContain('<');
  });

  it('strips RTF control words, header groups, and hex escapes', () => {
    const rtf =
      '{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red0\\green0\\blue0;}' +
      "\\f0\\fs24 Caf\\'e9 time.\\par Second line.}";
    const out = stripRtf(rtf);
    expect(out).toContain('Café time.');
    expect(out).toContain('Second line.');
    expect(out).not.toContain('fonttbl');
    expect(out).not.toContain('\\par');
    expect(out).not.toMatch(/[{}]/);
  });

  it('routes formats to a parser by mime, then by extension', () => {
    expect(
      parserFor(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'a.docx',
      ),
    ).toBe('docx');
    expect(parserFor('application/octet-stream', 'sheet.xlsx')).toBe('xlsx');
    expect(parserFor('application/vnd.oasis.opendocument.text', 'x.odt')).toBe('opendocument');
    expect(parserFor('application/rtf', 'x.rtf')).toBe('rtf');
    // OCR now handles images and PDFs instead of returning unsupported.
    expect(parserFor('image/png', 'scan.png')).toBe('image');
    expect(parserFor('image/jpeg', 'photo.jpg')).toBe('image');
    expect(parserFor('application/octet-stream', 'receipt.tiff')).toBe('image');
    expect(parserFor('application/pdf', 'scan.pdf')).toBe('pdf');
    expect(parserFor('application/octet-stream', 'doc.pdf')).toBe('pdf');
    // Audio/video remain out of scope.
    expect(parserFor('audio/mpeg', 'voice.mp3')).toBe('unsupported');
  });
  it('rejects oversized extracted text instead of returning a silent prefix', () => {
    expect(() => normalize('x'.repeat(8 * 1024 * 1024 + 1))).toThrow('no truncated text');
  });
});
