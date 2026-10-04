import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  apply: vi.fn(),
  dismiss: vi.fn(),
  requestFix: vi.fn(),
}));
vi.mock('@/app/improvements/actions', () => ({
  applyProposalAction: actions.apply,
  dismissProposalAction: actions.dismiss,
  requestProposalCodeFixAction: actions.requestFix,
}));

import { ProposalCard } from './proposal-card';

const proposal = {
  id: '12345678-1234-4234-8234-123456789abc',
  kind: 'note',
  title: 'Fix',
  rationale: 'Why',
  suggestion: 'Retry',
  evidenceCount: 0,
  applyable: false,
  createdLabel: '',
};

it('offers a code-fix request only when the service is available', () => {
  const available = renderToStaticMarkup(<ProposalCard proposal={proposal} canRequestFix />);
  expect(available).toContain('Request code fix');
  expect(available).toContain('Mark reviewed');

  const unavailable = renderToStaticMarkup(<ProposalCard proposal={proposal} />);
  expect(unavailable).not.toContain('Request code fix');
  expect(unavailable).toContain('Mark reviewed');
});
