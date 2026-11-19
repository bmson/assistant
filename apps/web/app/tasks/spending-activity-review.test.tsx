import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SpendingActivityReview } from './spending-activity-review';

it('links only the exact spending operation and never invents one', () => {
  const html = renderToStaticMarkup(
    <SpendingActivityReview status="waiting_estimated_cost" operationId="request/a" />,
  );
  expect(html).toContain('/costs/requests/request%2Fa');
  expect(html).toContain('Review spending request');
  const unknown = renderToStaticMarkup(<SpendingActivityReview status="waiting_estimated_cost" />);
  expect(unknown).toContain('cannot be opened');
  expect(unknown).not.toContain('href=');
  expect(
    renderToStaticMarkup(<SpendingActivityReview status="running" operationId="request/a" />),
  ).toBe('');
});
