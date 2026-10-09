import { describe, expect, it } from 'vitest';
import {
  ageScaledConfidence,
  detectKind,
  parseJsonExport,
  parseJsonExportDetailed,
  parseMbox,
  parseMboxDetailed,
  parseText,
  parseTextDetailed,
  windowUnits,
} from './import-parsers.js';

const MBOX = `From alice@example.com Mon Mar 04 10:00:00 2019
From: Alice Example <alice@example.com>
To: baldvin@example.com
Subject: Flat in Reykjavik
Date: Mon, 4 Mar 2019 10:00:00 +0000

Hey! The flat on Laugavegur is available from April.
> quoted reply line that should vanish
Let me know if you want it.

From bob@example.com Tue Jun 11 09:30:00 2024
From: Bob Builder <bob@example.com>
Subject: Padel on Tuesday
Date: Tue, 11 Jun 2024 09:30:00 +0000
Content-Type: multipart/alternative; boundary="000abc"

--000abc
Content-Type: text/plain; charset=UTF-8

Padel court booked for Tuesday 18:00.
QWxhZGRpbjpvcGVuIHNlc2FtZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
--000abc--
`;

describe('parseMbox', () => {
  it('splits messages and decodes MIME bodies without dropping content', async () => {
    const units = await parseMbox(MBOX);
    expect(units).toHaveLength(2);

    expect(units[0]?.date?.getUTCFullYear()).toBe(2019);
    expect(units[0]?.header).toContain('Alice Example');
    expect(units[0]?.header).toContain('Flat in Reykjavik');
    expect(units[0]?.text).toContain('Laugavegur');
    expect(units[0]?.text).toContain('[Quoted or forwarded content begins]');
    expect(units[0]?.text).toContain('quoted reply');

    expect(units[1]?.date?.getUTCFullYear()).toBe(2024);
    expect(units[1]?.text).toContain('Padel court booked');
    // This fixture has no transfer-encoding declaration, so the parser must not
    // guess that valid-looking text is base64 and discard it.
    expect(units[1]?.text).toContain('QWxhZGRpbjpvcGVuIHNlc2FtZQ');
    expect(units[1]?.text).toContain('Padel court booked');
  });

  it('parses CRLF, base64 and quoted-printable with source date and RFC mailbox', async () => {
    const encoded = [
      'From owner@example.com Mon Jan 01 10:00:00 2024',
      'From: Owner Person <owner@example.com>',
      'Date: Mon, 01 Jan 2024 10:00:00 +0200',
      'Subject: encoded',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'The caf=C3=A9 menu is ready; please bring the signed copy before Friday.',
      '--b',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('<p>HTML alternative should not duplicate text</p>').toString('base64'),
      '--b--',
      '',
    ].join('\r\n');
    const parsed = await parseMboxDetailed(encoded);
    expect(parsed.units).toHaveLength(1);
    expect(parsed.units[0]?.text).toContain('café');
    expect(parsed.units[0]?.authorEmail).toBe('owner@example.com');
    expect(parsed.units[0]?.sourceOffset).toBe(0);
    expect(parsed.units[0]?.date?.toISOString()).toBe('2024-01-01T08:00:00.000Z');
    expect(parsed.diagnostics).toMatchObject({
      acceptedUnits: 1,
      rejectedUnits: 0,
      partial: false,
    });
  });

  it('decodes a base64-only text MIME part before normalization', async () => {
    const decoded = 'The encoded body contains the decisive reservation for Friday afternoon.';
    const message = [
      'From owner@example.com Tue Jan 02 10:00:00 2024',
      'From: Owner <owner@example.com>',
      'Date: Tue, 02 Jan 2024 10:00:00 +0000',
      'Subject: encoded body',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(decoded).toString('base64'),
      '',
    ].join('\r\n');
    expect((await parseMbox(message))[0]?.text).toBe(decoded);
  });

  it('keeps HTML quote boundaries and nested forwarded markers for attribution review', async () => {
    const source = [
      'From owner@example.com Tue Jan 02 10:00:00 2024',
      'From: Owner <owner@example.com>',
      'Date: Tue, 02 Jan 2024 10:00:00 +0000',
      'Subject: reply',
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<p>My new answer is to move the meeting to Friday.</p><blockquote><p>Third party says meet Thursday.</p><blockquote>Nested forward says Tuesday.</blockquote></blockquote>',
      '',
    ].join('\n');
    const unit = (await parseMbox(source))[0];
    expect(unit?.hasQuotedContent).toBe(true);
    expect(unit?.text).toContain('Quoted content begins');
    expect(unit?.text).toContain('Third party says meet Thursday');
    expect(unit?.text).toContain('Nested forward says Tuesday');
  });

  it('chunks long messages losslessly and retains the decisive trailing sentence', async () => {
    const finalSentence =
      'The decisive final instruction is preserve every source sentence through the very end.';
    const source = `From owner@example.com Tue Jan 02 10:00:00 2024\nFrom: Owner <owner@example.com>\nDate: Tue, 02 Jan 2024 10:00:00 +0000\nSubject: long\n\n${'ordinary words '.repeat(500)}${finalSentence}`;
    const units = await parseMbox(source);
    expect(units.length).toBeGreaterThan(1);
    expect(units.map((unit) => unit.text).join('')).toContain(finalSentence);
    expect(units.at(-1)?.unitOffset).toBeGreaterThan(0);
  });

  it('reports malformed MIME messages as a partial parse with source offsets', async () => {
    const parsed = await parseMboxDetailed(
      'From x@example.com Tue Jan 02 10:00:00 2024\nContent-Type: multipart/mixed; boundary=bad\n\n--bad\n',
    );
    expect(parsed.diagnostics.partial).toBe(true);
    expect(parsed.diagnostics.rejectedUnits).toBe(1);
    expect(parsed.diagnostics.issues[0]?.offset).toBe(0);
  });
});

describe('parseJsonExport', () => {
  it('reads arrays of messages with flexible keys', () => {
    const units = parseJsonExport(
      JSON.stringify([
        { date: '2020-05-01T12:00:00Z', from: 'Anna', text: 'Moving to Oslo next month!' },
        { timestamp: 1718100000, sender: 'Baldvin', content: 'Congrats!' },
        { text: '' },
      ]),
    );
    expect(units).toHaveLength(2);
    expect(units[0]?.date?.getUTCFullYear()).toBe(2020);
    expect(units[0]?.header).toBe('From Anna');
    expect(units[1]?.date?.getUTCFullYear()).toBe(2024);
  });

  it('accepts a {messages: []} wrapper and reports malformed or empty inputs explicitly', () => {
    expect(parseJsonExport('{"messages":[{"text":"hello there"}]}')).toHaveLength(1);
    expect(parseJsonExport('not json at all')).toHaveLength(0);
    expect(parseJsonExportDetailed('not json at all').diagnostics).toMatchObject({
      partial: true,
      rejectedUnits: 1,
    });
    expect(parseJsonExportDetailed('{"messages":[]}').diagnostics).toMatchObject({
      partial: false,
      acceptedUnits: 0,
      rejectedUnits: 0,
    });
    expect(parseJsonExportDetailed('{}').diagnostics).toMatchObject({
      partial: true,
      rejectedUnits: 1,
    });
  });

  it('keeps source offsets and out-of-order per-unit years without a median fallback', () => {
    const parsed = parseJsonExportDetailed(
      JSON.stringify([
        { date: '2024-01-01', text: 'First event happened in the current year.' },
        { date: '1998-01-01', text: 'Second event happened much earlier.' },
        { text: 'An undated claim follows the historical record.' },
      ]),
    );
    const windows = windowUnits(parsed.units, 100000);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.date).toBeNull();
    expect(windows[0]?.text).toContain('observed 2024-01-01');
    expect(windows[0]?.text).toContain('observed 1998-01-01');
    expect(windows[0]?.units.map((unit) => unit.sourceOffset)).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
  });

  it('keeps JSON offsets aligned when rejected primitive rows precede valid messages', () => {
    const content = '[null, {"text":"This valid message follows an invalid row."}]';
    const parsed = parseJsonExportDetailed(content);
    expect(parsed.diagnostics.issues[0]?.offset).toBe(1);
    expect(parsed.units[0]?.sourceOffset).toBe(content.indexOf('{'));
  });

  it('preserves localized quote boundaries while retaining the original text for review', async () => {
    const source = [
      'From owner@example.com Tue Jan 02 10:00:00 2024',
      'From: Owner <owner@example.com>',
      'Date: Tue, 02 Jan 2024 10:00:00 +0000',
      'Subject: reply',
      '',
      'I will make the final decision after the board meeting.',
      'Le mardi 2 janvier, Alice <alice@example.com> a écrit :',
      '> Je propose de reporter la décision au mois prochain.',
      '',
    ].join('\r\n');
    const unit = (await parseMbox(source))[0];
    expect(unit?.hasQuotedContent).toBe(true);
    expect(unit?.text).toContain('final decision');
    expect(unit?.text).toContain('reporter la décision');
    expect(unit?.text).toContain('[Quoted or forwarded content begins]');
  });
});

describe('parseText + windowUnits', () => {
  it('bounds rendered provenance and separators while preserving long source text and offsets', () => {
    const text = 'A source sentence with exact spaces. '.repeat(40);
    const unit = {
      date: new Date('2026-10-07T10:00:00Z'),
      header: 'From Ada',
      text,
      sourceOffset: 42,
      authorEmail: 'ada@example.test',
      hasQuotedContent: false,
      unitOffset: 0,
    };
    const windows = windowUnits([unit], 300);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every((window) => window.text.length <= 300)).toBe(true);
    const chunks = windows.flatMap((window) => window.units);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    let offset = 0;
    for (const chunk of chunks) {
      expect(chunk.sourceOffset).toBe(42);
      expect(chunk.unitOffset).toBe(offset);
      offset += chunk.text.length;
    }
    for (const window of windows)
      expect(window.text.match(/Source offset/g)).toHaveLength(window.units.length);
    const small = { ...unit, header: '', authorEmail: null, text: 'Retained short source text.' };
    expect(
      windowUnits([small, small, small], 200).every((window) => window.text.length <= 200),
    ).toBe(true);
    expect(() => windowUnits([unit], 20)).toThrow('provenance');
  });
  it('keeps ALL rows of a CSV-shaped file (newlines but no blank lines)', () => {
    const rows = Array.from({ length: 200 }, (_, i) => `Person ${i},1990-01-${(i % 28) + 1}`);
    const units = parseText(rows.join('\n'));
    const joined = units.map((u) => u.text).join('\n');
    expect(joined).toContain('Person 0,');
    expect(joined).toContain('Person 199,'); // the tail must survive, not be truncated away
    expect(units.length).toBeGreaterThan(1);
  });

  it('uses exact source offsets for LF and CRLF text files', () => {
    const lf = parseTextDetailed(
      'first paragraph has enough words to preserve.\n\nsecond paragraph is also kept in full.',
    );
    const crlfText =
      'first paragraph has enough words to preserve.\r\n\r\nsecond paragraph is also kept in full.';
    const crlf = parseTextDetailed(crlfText);
    expect(lf.units.map((unit) => unit.text)).toEqual(crlf.units.map((unit) => unit.text));
    expect(crlf.units[1]?.sourceOffset).toBe(crlfText.indexOf('second paragraph'));
  });

  it('merges paragraphs into units and windows preserve order', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'x'.repeat(200)}`).join(
      '\n\n',
    );
    const units = parseText(text);
    expect(units.length).toBeGreaterThan(1);
    const windows = windowUnits(units, 2000);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]?.text).toContain('Paragraph 0');
  });

  it('does not substitute a group median for different or missing unit dates', () => {
    const windows = windowUnits(
      [
        {
          date: new Date('2019-01-01'),
          header: '',
          text: 'a',
          sourceOffset: 0,
          authorEmail: null,
          hasQuotedContent: false,
          unitOffset: 0,
        },
        {
          date: new Date('2021-01-01'),
          header: '',
          text: 'b',
          sourceOffset: 2,
          authorEmail: null,
          hasQuotedContent: false,
          unitOffset: 0,
        },
        {
          date: new Date('2024-01-01'),
          header: '',
          text: 'c',
          sourceOffset: 4,
          authorEmail: null,
          hasQuotedContent: false,
          unitOffset: 0,
        },
      ],
      100000,
    );
    expect(windows[0]?.date).toBeNull();
  });
});

describe('ageScaledConfidence', () => {
  const now = new Date('2026-07-16');
  it('older facts start lower, floored, and unknown ages are capped', () => {
    const fresh = ageScaledConfidence(0.8, new Date('2026-07-01'), now);
    const old = ageScaledConfidence(0.8, new Date('2019-07-01'), now);
    const ancient = ageScaledConfidence(0.8, new Date('1995-01-01'), now);
    expect(fresh).toBeGreaterThan(old);
    expect(old).toBeGreaterThan(ancient);
    expect(ancient).toBeGreaterThanOrEqual(0.8 * 0.35 - 1e-9);
    expect(ageScaledConfidence(0.9, null, now)).toBeLessThanOrEqual(0.6);
  });
});

describe('detectKind', () => {
  it('sniffs mbox, json, and falls back to text', () => {
    expect(detectKind('mail.mbox', 'whatever')).toBe('mbox');
    expect(detectKind('notes.txt', 'From alice')).toBe('text');
    expect(detectKind('anything.bin', 'From alice@example.com Mon Mar 04 10:00:00 2019')).toBe(
      'mbox',
    );
    expect(detectKind('chat.json', '[]')).toBe('json');
    expect(detectKind('data.dat', '[{"text":"hi"}]')).toBe('json');
    expect(detectKind('diary.md', '# My year')).toBe('text');
  });
});
