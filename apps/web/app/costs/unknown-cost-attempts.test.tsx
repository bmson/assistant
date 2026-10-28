import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UnknownCostAttempts } from './unknown-cost-attempts.js';

describe('unknown cost attempt presentation', () => {
  it('keeps complete zero distinct by omitting an empty exposure notice', () => {
    const html = renderToStaticMarkup(
      createElement(UnknownCostAttempts, {
        summary: {
          count: 0,
          countComplete: true,
          estimatedUsd: '0.000000',
          estimateComplete: true,
        },
      }),
    );

    expect(html).toBe('');
  });

  it('shows unavailable coverage when the incomplete count is zero', () => {
    const html = renderToStaticMarkup(
      createElement(UnknownCostAttempts, {
        summary: {
          count: 0,
          countComplete: false,
          estimatedUsd: null,
          estimateComplete: false,
        },
      }),
    );

    expect(html).toContain('Outstanding unknown outcome coverage unavailable.');
    expect(html).not.toContain('at least 0');
    expect(html).not.toContain('Retained reservation estimate $0');
  });

  it('shows a complete nonzero retained estimate with the spend separation warning', () => {
    const html = renderToStaticMarkup(
      createElement(UnknownCostAttempts, {
        summary: {
          count: 2,
          countComplete: true,
          estimatedUsd: '0.375000',
          estimateComplete: true,
        },
      }),
    );

    expect(html).toContain('Outstanding unknown outcomes:');
    expect(html).toContain('2');
    expect(html).toContain('Retained reservation estimate $0.38');
    expect(html).toContain('Estimate only, not confirmed spend.');
    expect(html).toContain('Do not add this estimate to spend totals.');
  });

  it('shows a lower-bound count and withholds an unavailable estimate', () => {
    const html = renderToStaticMarkup(
      createElement(UnknownCostAttempts, {
        summary: {
          count: 501,
          countComplete: false,
          estimatedUsd: null,
          estimateComplete: false,
        },
      }),
    );

    expect(html).toContain('Outstanding unknown outcomes:');
    expect(html).toContain('at least 501');
    expect(html).toContain('Retained reservation estimate unavailable.');
    expect(html).toContain('Do not add an unknown estimate to spend totals.');
    expect(html).not.toContain('Retained reservation estimate $');
  });
});
