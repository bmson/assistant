import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageMarkdown } from './markdown';

describe('MessageMarkdown', () => {
  it('renders hard breaks only once while retaining soft breaks', () => {
    const html = renderToStaticMarkup(<MessageMarkdown text={'**Label**  \nDetail\nNext'} />);
    expect(html).toContain('<br/>Detail\nNext');
    expect(html).not.toContain('<br/>\n');
  });

  it('renders an overlong reply paragraph as several short ones', () => {
    const sentence = 'The review moved to Thursday because finance needs two more days to close.';
    const html = renderToStaticMarkup(<MessageMarkdown text={Array(8).fill(sentence).join(' ')} />);
    expect(html.match(/<p /g)?.length).toBeGreaterThan(1);
  });

  it('promotes short bold list labels but not emphasized sentences', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown text={'**Risks**\n\n- Delay\n\n**Keep it simple.**\n\n- Next'} />,
    );
    expect(html).toMatch(/<h2[^>]*><strong[^>]*>Risks<\/strong><\/h2>/);
    expect(html).toMatch(/<p[^>]*><strong[^>]*>Keep it simple\.<\/strong><\/p>/);
  });
  it('renders common assistant formatting with the restrained type hierarchy', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown
        text={'# Result\n\nThis is **important**, *qualified*, and ~~superseded~~.\n\n- One\n- Two'}
      />,
    );

    expect(html).toContain(
      '<h1 class="mt-6 mb-2 text-lg leading-6 font-semibold text-balance first:mt-0">',
    );
    expect(html).toContain('<strong class="font-semibold ">important</strong>');
    expect(html).toContain('<em class="italic ">qualified</em>');
    expect(html).toContain('<del class="decoration-muted/70 ">superseded</del>');
    expect(html).toContain('<ul class="my-2.5 list-disc');
  });

  it('preserves GFM task-list classes and renders native checkboxes without duplicate bullets', () => {
    const html = renderToStaticMarkup(<MessageMarkdown text={'- [x] Done\n- [ ] Next'} />);

    expect(html).toContain('contains-task-list');
    expect(html).toContain('task-list-item');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('accent-accent');
  });

  it('keeps soft line breaks as real breaks, so one found item per line stays per line', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown
        text={'Found 3 receipts:\nAmazon — $45.99, yesterday\nDelta — flight confirmation'}
      />,
    );

    // The break stays in the DOM as a newline and pre-line renders it;
    // folding it to a space is what produced a single block of text.
    expect(html).toContain('whitespace-pre-line');
    expect(html).toContain('receipts:\nAmazon');
  });

  it('keeps lookup tables compact and scannable', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown text={'| Item | Count |\n| :--- | ---: |\n| Receipts | 12 |'} />,
    );

    expect(html).toContain('[font-variant-numeric:tabular-nums]');
    expect(html).toContain('align-top');
    expect(html).toContain('Receipts');
    expect(html).not.toContain('data-mobile-table-records="true"');
  });

  it('uses label-value records for long two-column content without changing the desktop table', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown
        text={
          '| Candidate | Break |\n| --- | --- |\n| Monday afternoon for a two-hour focus block | 10m |\n| Tuesday morning for a two-hour focus block | 10m |\n| Thursday afternoon for a two-hour focus block | 10m |\nLimits: Free/busy coverage is incomplete.\nAssumptions: A two-hour block fits the request.\nCalendar sources: [Work calendar](https://calendar.google.com/calendar/event?eid=calendar-source)'
        }
      />,
    );

    expect(html).toContain('data-mobile-table-records="true"');
    expect(html).toContain('hidden sm:table');
    expect(html).toContain('sm:hidden');
    expect(html.match(/<dl /g)).toHaveLength(3);
    const table = /<table\b[\s\S]*?<\/table>/.exec(html)?.[0];
    expect(table).toBeDefined();
    expect(table).not.toContain('Limits:');
    expect(table).not.toContain('Assumptions:');
    expect(table).not.toContain('Calendar sources:');
    expect(html.indexOf('</table>')).toBeLessThan(html.indexOf('Limits:'));
    expect(html).toContain('href="https://calendar.google.com/calendar/event?eid=calendar-source"');
  });

  it('leaves fenced code and display math untouched', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown
        text={
          '```markdown\n| Candidate | Break |\n| --- | --- |\n| Monday focus block | 10m |\nLimits: literal code content\n```'
        }
      />,
    );

    expect(html).toContain('| Monday focus block | 10m |\nLimits: literal code content');
    expect(html).not.toContain('data-mobile-table-records="true"');

    const mathHtml = renderToStaticMarkup(
      <MessageMarkdown
        text={
          '| Candidate | Break |\n| --- | --- |\n| Monday afternoon for a two-hour focus block | 10m |\n$$\n\\text{Assumptions:} \\quad x = 1\n$$'
        }
      />,
    );
    expect(mathHtml).toContain('class="katex-display"');
    expect(mathHtml).not.toContain('katex-error');
  });

  it('keeps short two-column and three-column tables in their existing layout', () => {
    const short = renderToStaticMarkup(
      <MessageMarkdown text={'| Item | Count |\n| --- | ---: |\n| Bags | 2 |'} />,
    );
    const threeColumns = renderToStaticMarkup(
      <MessageMarkdown text={'| Day | Item | Count |\n| --- | --- | ---: |\n| Mon | Bags | 2 |'} />,
    );

    expect(short).not.toContain('data-mobile-table-records="true"');
    expect(threeColumns).not.toContain('data-mobile-table-records="true"');
    expect(threeColumns).toContain('<table');
    expect(threeColumns).not.toContain('hidden sm:table');
  });

  it('offers label-value records for wide tables on phones', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown
        text={
          '| Day | Activity | Duration | Notes |\n| --- | --- | --- | --- |\n| Mon | Run | 30 min | Easy pace |'
        }
      />,
    );
    expect(html).toContain('data-mobile-table-records="true"');
    expect(html).toContain('hidden sm:table');
    expect(html).toContain('<dt');
    expect(html).toContain('<dd');
    expect(html).toContain('Easy pace');
  });

  it('renders display math without treating currency ranges as formulas', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown
        text={'**Principal:** $1,000\n\n$$\nA = P(1 + r)^t\n$$\n\nFrom $1,000 to $1,050.'}
      />,
    );

    expect(html).toContain('class="katex-display"');
    expect(html).toContain('$1,000');
    expect(html).toContain('$1,050');
  });

  it('does not inherit trusted math rendering from a polluted object prototype', () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'trust');
    Object.defineProperty(Object.prototype, 'trust', {
      configurable: true,
      writable: true,
      value: true,
    });
    try {
      const html = renderToStaticMarkup(
        <MessageMarkdown text={'$$\\includegraphics{https://tracking.example.test/pixel.png}$$'} />,
      );
      expect(html).not.toContain('<img');
      expect(html).not.toContain('rel="preload"');
    } finally {
      if (previous) Object.defineProperty(Object.prototype, 'trust', previous);
      else Reflect.deleteProperty(Object.prototype, 'trust');
    }
  });

  it('keeps mixed Markdown currency inside equations readable and code literal', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown
        text={'$$\nA = 1000 \\times 1.05 = **$1,050**\n$$\n\n$A$ is the amount.\n\n`$A$`'}
      />,
    );
    expect(html).toContain('katex-display');
    expect(html).not.toContain('katex-error');
    expect(html).toContain('A is the amount.');
    expect(html).toContain('$A$</code>');
  });

  it('gives a standalone bold quote the shared callout surface', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown
        text={'**"If it is not verified, it is not done."**\n\nCheck the evidence.'}
      />,
    );

    expect(html).toContain('data-quote-callout="true"');
    expect(html).toContain('bg-sunken/55');
    expect(html).toContain('Check the evidence.');
  });

  it('allows a hostile long token to wrap inside fenced code', () => {
    const url = 'https://example.com/a/very/long/path/with?many=parameters&that=need&safe=wrapping';
    const html = renderToStaticMarkup(<MessageMarkdown text={`\`\`\`text\n${url}\n\`\`\``} />);

    expect(html).toContain('whitespace-pre-wrap');
    expect(html).toContain('[overflow-wrap:anywhere]');
    expect(html).toContain(url.replaceAll('&', '&amp;'));
  });

  it('gives code a semantic header without duplicating inline-code chrome', () => {
    const html = renderToStaticMarkup(<MessageMarkdown text={'```swift\nlet count = 3\n```'} />);
    expect(html).toContain('data-code-card="true"');
    expect(html).toContain('>swift</span>');
    expect(html).toContain('lucide-code');
    expect(html).toContain('[&amp;_code]:text-[1em]');
  });

  it('uses a quiet, decorative icon for quotation callouts', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown text={'> Keep the important part clear.'} />,
    );
    expect(html).toContain('<blockquote');
    expect(html).toContain('lucide-quote');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('Keep the important part clear.');
  });

  it('routes Mermaid fences to the diagram renderer instead of exposing a raw code block', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown text={'```mermaid\ngraph LR\n  A --> B\n```'} />,
    );

    expect(html).toContain('Diagram');
    expect(html).toContain('Rendering diagram');
    expect(html).toContain('View diagram source');
    expect(html).not.toContain('MERMAID</div>');
  });
});
