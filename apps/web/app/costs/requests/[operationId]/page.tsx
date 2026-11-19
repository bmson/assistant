import { requireOwner } from '@/auth';
import { PageHeader, PageShell } from '@/lib/ui';
import { EstimatedCostRequestReview } from './request-review';

export const metadata = { title: 'Review spending request' };
export const dynamic = 'force-dynamic';

export default async function SpendingRequestPage({
  params,
}: {
  params: Promise<{ operationId: string }>;
}) {
  const owner = await requireOwner();
  const { operationId } = await params;
  return (
    <PageShell size="reading">
      <PageHeader back={{ href: '/costs', label: 'Costs' }} title="Review spending request" />
      <div className="mt-6">
        <EstimatedCostRequestReview
          operationId={operationId}
          formSessionScope={owner.formSessionScope}
        />
      </div>
    </PageShell>
  );
}
