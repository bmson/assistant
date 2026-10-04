'use client';

import type { ImprovementActionResult } from '@assistant/persistence';
import { useState, useTransition } from 'react';
import {
  applyProposalAction,
  dismissProposalAction,
  requestProposalCodeFixAction,
} from '@/app/improvements/actions';
import type { ProposalCodeFixReceipt } from '@/lib/proposal-code-fix';
import {
  Badge,
  cardBodyClass,
  cardFooterClass,
  cardHeaderClass,
  cardShellClass,
  cardTitleClass,
  MetaLine,
  microLabelClass,
} from '@/lib/ui';
import { ActionButton } from '@/lib/ui-client';

export interface ProposalView {
  id: string;
  kind: string;
  title: string;
  rationale: string;
  suggestion: string;
  evidenceCount: number;
  applyable: boolean;
  createdLabel: string;
}

const kindLabels: Record<string, string> = {
  behavior: 'Behavior',
  model_role: 'Model swap',
  policy: 'Policy',
  prompt: 'Prompt',
  note: 'Note',
};

export function ProposalCard({
  proposal,
  canRequestFix = false,
}: {
  proposal: ProposalView;
  canRequestFix?: boolean;
}) {
  const requestFix = !proposal.applyable && canRequestFix;
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [pending, startTransition] = useTransition();
  const [pendingAction, setPendingAction] = useState<'apply' | 'dismiss' | 'request_fix' | null>(
    null,
  );
  const runAction = (
    name: 'apply' | 'dismiss' | 'request_fix',
    action: () => Promise<ImprovementActionResult | ProposalCodeFixReceipt>,
  ) => {
    setError('');
    setPendingAction(name);
    startTransition(async () => {
      try {
        const result = await action();
        setReceipt(result.detail);
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : 'Could not complete this request. Please try again.',
        );
      } finally {
        setPendingAction(null);
      }
    });
  };

  return (
    <article className={`${cardShellClass} flex h-full flex-col`}>
      {error && (
        <p role="alert" className="px-4 pt-4 text-sm text-red-600 sm:px-6 dark:text-red-400">
          {error}
        </p>
      )}
      {receipt && (
        <p role="status" className="px-4 pt-4 text-sm text-muted sm:px-6">
          {receipt}
        </p>
      )}
      <div className={`${cardBodyClass} flex-1`}>
        <div className={cardHeaderClass}>
          <div className="min-w-0">
            <Badge tone="neutral">{kindLabels[proposal.kind] ?? proposal.kind}</Badge>
            <h3 className={`mt-2 ${cardTitleClass}`}>{proposal.title}</h3>
          </div>
          <span className="shrink-0 text-xs text-muted">{proposal.createdLabel}</span>
        </div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {[
            ['Why this came up', proposal.rationale, 'min-w-0'],
            ['Proposed change', proposal.suggestion, 'min-w-0 rounded-xl bg-sunken/65 px-3 py-2.5'],
          ].map(([label, text, className]) =>
            text ? (
              <section key={label} className={className}>
                <h4 className={microLabelClass}>{label}</h4>
                <p className="mt-1 text-sm leading-5 text-strong">{text}</p>
              </section>
            ) : null,
          )}
        </div>
        <MetaLine
          segments={[
            `Based on ${proposal.evidenceCount} pattern${proposal.evidenceCount === 1 ? '' : 's'}`,
            proposal.applyable ? 'Can apply directly' : 'Advisory',
          ]}
        />
      </div>
      <footer className={cardFooterClass}>
        <ActionButton
          variant="primary"
          disabled={pending || Boolean(receipt)}
          pending={pendingAction === 'apply'}
          pendingLabel={proposal.applyable ? 'Applying…' : 'Noting…'}
          onClick={() => runAction('apply', () => applyProposalAction(proposal.id))}
          title={
            proposal.applyable
              ? 'Approve and enact this change'
              : 'Acknowledge this advisory suggestion'
          }
        >
          {proposal.applyable ? 'Approve & apply' : 'Mark reviewed'}
        </ActionButton>
        {requestFix && (
          <ActionButton
            disabled={pending || Boolean(receipt)}
            pending={pendingAction === 'request_fix'}
            pendingLabel="Queuing…"
            onClick={() =>
              runAction('request_fix', () => requestProposalCodeFixAction(proposal.id))
            }
            title="Create a code-fix report for investigation; no code changes until a fix is prepared and reviewed"
          >
            Request code fix
          </ActionButton>
        )}
        <ActionButton
          disabled={pending || Boolean(receipt)}
          pending={pendingAction === 'dismiss'}
          pendingLabel="Dismissing…"
          onClick={() => runAction('dismiss', () => dismissProposalAction(proposal.id))}
        >
          Dismiss
        </ActionButton>
      </footer>
    </article>
  );
}
