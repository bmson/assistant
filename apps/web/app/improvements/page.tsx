import { improvementProposalSuggestion } from '@assistant/application';
import { ProposalCard, type ProposalView } from '@/app/improvements/proposal-card';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getSelfRepairOverview } from '@/lib/self-repair-server';
import { cardGridClass, EmptyState, PageHeader, PageShell } from '@/lib/ui';
import { listOpenImprovements } from '@/lib/workspace-reviews';
import { RepairPanel } from './repair-panel';

export const metadata = { title: 'Improvements' };

export const dynamic = 'force-dynamic';

export default async function ImprovementsPage() {
  await requireOwner();
  const now = new Date();
  const [rows, repairs] = await Promise.all([listOpenImprovements(), getSelfRepairOverview()]);

  const proposals: ProposalView[] = rows.map((p) => {
    return {
      id: p.id,
      kind: p.kind,
      title: p.title,
      rationale: p.rationale,
      suggestion: improvementProposalSuggestion(p.kind, p.change),
      evidenceCount: p.evidenceIds.length,
      applyable: p.kind === 'model_role',
      createdLabel: relativeTime(p.createdAt, now),
    };
  });

  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="Improvements"
        intro="Track fixes from reported failures to tested pull requests, alongside model and behavior suggestions. Review and merge code changes yourself."
      />
      <RepairPanel overview={repairs} />
      <section className="mt-8">
        {proposals.length === 0 ? (
          <EmptyState>
            No open proposals. The nightly review surfaces suggestions here when it spots a pattern.
          </EmptyState>
        ) : (
          <div className={cardGridClass}>
            {proposals.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                canRequestFix={repairs.enabled && repairs.configured}
              />
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
