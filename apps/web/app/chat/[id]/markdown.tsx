'use client';

import 'katex/dist/katex.min.css';

import { Code2, Quote } from 'lucide-react';
import { Children, isValidElement, memo, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { reflowParagraphs } from '@/lib/paragraph-reflow';
import { MermaidDiagram } from './mermaid-diagram';

// Currency is much more common than inline TeX in an assistant transcript.
// Keep single-dollar text literal so "$1,000 ... $1,050" cannot be mistaken
// for one giant formula; display math remains available through $$...$$.
const remarkMathPlugin: [typeof remarkMath, { singleDollarTextMath: boolean }] = [
  remarkMath,
  { singleDollarTextMath: false },
];
const remarkPlugins = [remarkGfm, remarkMathPlugin];
// Only promote short, fully-bold labels that introduce structured content.
// Ordinary emphasis, whole bold sentences, and labels inside lists stay prose.
function rehypeAnswerSections() {
  return (tree: unknown) => {
    type Element = { type: string; tagName?: string; value?: string; children?: Element[] };
    const nodes = (tree as Element).children ?? [];
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (node.tagName !== 'p' || node.children?.length !== 1) continue;
      const strong = node.children[0];
      if (strong.tagName !== 'strong' || strong.children?.length !== 1) continue;
      const text = strong.children[0].value?.trim();
      if (text && /^(example|note|tip):?$/i.test(text)) continue;
      const next = nodes.slice(index + 1).find((item) => item.type === 'element');
      if (
        text &&
        text.length <= 60 &&
        !/[.!?"”'’]$/.test(text) &&
        ['ul', 'ol', 'pre', 'table'].includes(next?.tagName ?? '')
      ) {
        node.tagName = 'h2';
      }
    }
  };
}
function rehypeReadableMath() {
  return (tree: unknown) => {
    type Node = {
      tagName?: string;
      value?: string;
      properties?: { className?: string[] };
      children?: Node[];
    };
    const visit = (node: Node, inCode = false) => {
      const isMath = node.properties?.className?.some(
        (name) => name === 'math-display' || name === 'math-inline',
      );
      if (isMath) {
        for (const child of node.children ?? []) {
          // Models sometimes mix Markdown emphasis/currency into TeX. Keep
          // the actual amount, removing only incompatible presentation syntax.
          if (child.value)
            child.value = child.value
              .replace(/\*\*([^*]+)\*\*/g, '$1')
              .replace(/(?<!\\)\$(?=\d)/g, '\\$');
        }
        return;
      }
      const code = inCode || node.tagName === 'code' || node.tagName === 'pre';
      if (!code && node.value)
        node.value = node.value.replace(/(?<!\$)\$([A-Za-z])\$(?!\$)/g, '$1');
      node.children?.forEach((child) => {
        visit(child, code);
      });
    };
    visit(tree as Node);
  };
}
const rehypePlugins = [rehypeReadableMath, rehypeKatex, rehypeAnswerSections];

function withoutDuplicateHardBreaks(children: ReactNode): ReactNode {
  const items = Children.toArray(children);
  return items.map((child, index) => {
    const previous = items[index - 1];
    return typeof child === 'string' && isValidElement(previous) && previous.type === 'br'
      ? child.replace(/^\n/, '')
      : child;
  });
}

function tableCells(children: ReactNode): ReactNode[][] {
  const elements = (value: ReactNode) =>
    Children.toArray(value).filter(isValidElement) as ReactElement<{ children?: ReactNode }>[];
  return elements(children).flatMap((section) =>
    elements(section.props.children).map((row) =>
      elements(row.props.children).map((cell) => cell.props.children),
    ),
  );
}

const quoteClassName =
  'my-3 flex max-w-[72ch] items-start gap-2.5 rounded-xl border border-edge bg-sunken/55 px-3 py-2.5 text-strong first:mt-0 last:mb-0';

function QuoteContent({ children }: { children: ReactNode }) {
  return (
    <>
      <Quote className="mt-1 size-3.5 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 italic">{children}</div>
    </>
  );
}

function isStandaloneBoldQuote(children: ReactNode): boolean {
  const items = Children.toArray(children);
  if (items.length !== 1 || !isValidElement(items[0])) return false;
  const strong = items[0] as ReactElement<{ children?: ReactNode; node?: { tagName?: string } }>;
  if (strong.props.node?.tagName !== 'strong') return false;
  const textParts = Children.toArray(strong.props.children);
  if (textParts.length !== 1 || typeof textParts[0] !== 'string') return false;
  const text = textParts[0].trim();
  return (
    (text.startsWith('“') && text.endsWith('”')) ||
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith('‘') && text.endsWith('’')) ||
    (text.startsWith("'") && text.endsWith("'"))
  );
}

/**
 * Hand-rolled prose styling for assistant responses — Tailwind preflight strips
 * element defaults, so each markdown element gets its classes back here.
 * `node` is destructured away so react-markdown's hast node never reaches the DOM.
 */
const components: Components = {
  a: ({ node: _node, children, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium [overflow-wrap:anywhere] underline decoration-muted/70 underline-offset-2 hover:decoration-current"
    >
      {children}
    </a>
  ),
  p: ({ node: _node, className, children, ...props }) => {
    // Models often answer a "quote-style callout" request with one bold quoted
    // paragraph instead of Markdown blockquote syntax. Recognize only that
    // narrow, unambiguous shape so the requested semantic surface is not lost.
    if (isStandaloneBoldQuote(children)) {
      return (
        <blockquote data-quote-callout="true" className={quoteClassName}>
          <QuoteContent>
            <p {...props} className={`m-0 text-pretty ${className ?? ''}`}>
              {children}
            </p>
          </QuoteContent>
        </blockquote>
      );
    }
    return (
      // Chat convention, not strict CommonMark: a single line break in a reply
      // is a real break. react-markdown keeps soft breaks as "\n" in the DOM;
      // pre-line renders them instead of collapsing structured answers — one
      // found item per line — into a single block of text.
      <p
        {...props}
        className={`my-2.5 whitespace-pre-line text-pretty first:mt-0 last:mb-0 ${className ?? ''}`}
      >
        {withoutDuplicateHardBreaks(children)}
      </p>
    );
  },
  ul: ({ node: _node, className, ...props }) => (
    <ul
      {...props}
      className={`my-2.5 list-disc space-y-1.5 pl-5 marker:text-accent first:mt-0 last:mb-0 [&.contains-task-list]:list-none [&.contains-task-list]:pl-0 ${className ?? ''}`}
    />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol
      {...props}
      className={`my-2.5 list-decimal space-y-1.5 pl-5 marker:font-normal marker:text-muted first:mt-0 last:mb-0 ${className ?? ''}`}
    />
  ),
  li: ({ node: _node, className, ...props }) => (
    <li
      {...props}
      className={`pl-0.5 [&.task-list-item]:relative [&.task-list-item]:list-none [&.task-list-item]:pl-6 [&.task-list-item>input]:absolute [&.task-list-item>input]:top-1 [&.task-list-item>input]:left-0 [&>p]:my-0 ${className ?? ''}`}
    />
  ),
  input: ({ node: _node, className, type, ...props }) => (
    <input
      {...props}
      type={type}
      className={`${
        type === 'checkbox' ? 'mr-2 size-4 align-[-0.15em] accent-accent disabled:opacity-100' : ''
      } ${className ?? ''}`}
    />
  ),
  strong: ({ node: _node, className, ...props }) => (
    <strong {...props} className={`font-semibold ${className ?? ''}`} />
  ),
  em: ({ node: _node, className, ...props }) => (
    <em {...props} className={`italic ${className ?? ''}`} />
  ),
  del: ({ node: _node, className, ...props }) => (
    <del {...props} className={`decoration-muted/70 ${className ?? ''}`} />
  ),
  h1: ({ node: _node, ...props }) => (
    <h1 {...props} className="mt-6 mb-2 text-lg leading-6 font-semibold text-balance first:mt-0" />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2
      {...props}
      className="mt-5 mb-1.5 text-base leading-6 font-semibold text-balance first:mt-0"
    />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3
      {...props}
      className="mt-4 mb-1.5 text-base leading-6 font-medium text-balance first:mt-0"
    />
  ),
  h4: ({ node: _node, ...props }) => (
    <h4 {...props} className="mt-4 mb-1 text-base leading-6 font-medium first:mt-0" />
  ),
  h5: ({ node: _node, ...props }) => (
    <h5 {...props} className="mt-4 mb-1 text-base leading-6 font-medium first:mt-0" />
  ),
  h6: ({ node: _node, ...props }) => (
    <h6 {...props} className="mt-4 mb-1 text-base leading-6 font-medium text-muted first:mt-0" />
  ),
  blockquote: ({ node: _node, children, ...props }) => (
    <blockquote {...props} className={quoteClassName}>
      <QuoteContent>{children}</QuoteContent>
    </blockquote>
  ),
  hr: ({ node: _node, ...props }) => <hr {...props} className="my-3 border-edge" />,
  // react-markdown v10 has no `inline` flag: `code` gets inline styling, and
  // `pre` (block code wrapper) resets it on its child so blocks stay flat.
  code: ({ node: _node, className, ...props }) => (
    <code
      {...props}
      className={`break-words rounded bg-sunken px-1 py-0.5 font-mono text-[0.85em] [overflow-wrap:anywhere] ${className ?? ''}`}
    />
  ),
  pre: ({ node: _node, children, ...props }) => {
    const child = isValidElement(children)
      ? (children as ReactElement<{ className?: string; children?: unknown }>)
      : null;
    if (
      child?.props.className?.split(/\s+/).includes('language-mermaid') &&
      typeof child.props.children === 'string'
    ) {
      return <MermaidDiagram source={child.props.children.replace(/\n$/, '')} />;
    }
    const language = child?.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
    return (
      <div
        data-code-card="true"
        className="my-3 min-w-0 max-w-full overflow-hidden rounded-xl border border-edge first:mt-0 last:mb-0"
      >
        <div className="flex items-center gap-2 border-b border-edge bg-sunken/70 px-3 py-2 text-xs font-medium text-muted">
          <Code2 className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{language || 'Code'}</span>
        </div>
        <pre
          {...props}
          className="m-0 max-w-full overscroll-x-contain overflow-x-auto bg-[#10131a] p-4 font-mono text-[0.8125rem] leading-5 text-zinc-100 [&_code]:break-words [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em] [&_code]:whitespace-pre-wrap [&_code]:[overflow-wrap:anywhere]"
        >
          {children}
        </pre>
      </div>
    );
  },
  table: ({ node: _node, children, ...props }) => {
    const rows = tableCells(children);
    const headers = rows[0] ?? [];
    const useMobileRecords = headers.length > 3;
    return (
      <div className="my-3 max-w-full overscroll-x-contain overflow-x-auto rounded-xl border border-edge first:mt-0 last:mb-0">
        <table
          {...props}
          className={`${useMobileRecords ? 'hidden sm:table' : ''} w-full border-collapse text-xs [font-variant-numeric:tabular-nums] sm:text-sm`}
        >
          {children}
        </table>
        {useMobileRecords ? (
          <div data-mobile-table-records="true" className="divide-y divide-edge sm:hidden">
            {rows.slice(1).map((row, rowIndex) => (
              <dl
                key={rowIndex.toString()}
                className="space-y-2 px-3 py-3 [font-variant-numeric:tabular-nums]"
              >
                {headers.map((header, column) => (
                  <div
                    key={column.toString()}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-baseline gap-3"
                  >
                    <dt className="min-w-0 text-xs font-medium text-muted">{header}</dt>
                    <dd className="min-w-0 text-sm leading-5">{row[column] || '—'}</dd>
                  </div>
                ))}
              </dl>
            ))}
          </div>
        ) : null}
      </div>
    );
  },
  th: ({ node: _node, ...props }) => (
    <th
      {...props}
      className="border-b border-edge bg-sunken/70 px-1 py-2 text-left font-medium break-words hyphens-auto [overflow-wrap:break-word] sm:px-3"
    />
  ),
  td: ({ node: _node, ...props }) => (
    <td
      {...props}
      className="border-b border-edge/70 px-1 py-2 align-top break-words hyphens-auto [overflow-wrap:break-word] sm:px-3 last:[tr:last-child_&]:border-b-0"
    />
  ),
};

/**
 * Assistant-message markdown (GFM: tables, strikethrough, task lists, autolinks).
 *
 * Memoized on `text`, which is the whole of its input. Parsing markdown is by
 * far the most expensive thing the transcript does, and the log re-renders for
 * reasons that have nothing to do with any given message — a keystroke in the
 * composer, the keyboard resizing the form, a token arriving on the newest
 * reply. Without this, every one of those re-parsed every reply on screen, and
 * a long thread turned typing into a several-hundred-millisecond wait.
 */
export const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="message-markdown min-w-0 max-w-full break-words leading-relaxed [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {reflowParagraphs(text)}
      </ReactMarkdown>
    </div>
  );
});
