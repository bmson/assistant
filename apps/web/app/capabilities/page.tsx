import { visibleWorkspaceCapabilityModules } from '@assistant/application';
import { assistantModuleMetas } from '@assistant/modules/meta';
import { requireOwner } from '@/auth';
import {
  capabilityStatus,
  capabilityStatusTitle,
  getCapabilityDiagnostics,
} from '@/lib/capabilities';
import { Badge, cardGridClass, PageHeader, PageShell } from '@/lib/ui';

export const metadata = { title: 'Capabilities' };
export const dynamic = 'force-dynamic';

export default async function CapabilitiesPage() {
  await requireOwner();
  const capabilityDiagnostics = await getCapabilityDiagnostics();
  const diagnostics = new Map(capabilityDiagnostics.diagnostics.map((item) => [item.module, item]));

  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/settings', label: 'Settings' }}
        title="Capabilities"
        intro="Optional tools installed on this assistant, including the same readiness and setup status shown in the mobile app. Connection-based tools can be configured from Settings."
      />

      <section className={`mt-8 ${cardGridClass}`}>
        {visibleWorkspaceCapabilityModules(
          assistantModuleMetas,
          capabilityDiagnostics.diagnostics,
        ).map((capability) => {
          const diagnostic = diagnostics.get(capability.name);
          const enabled = diagnostic?.enabled ?? false;
          const ready = diagnostic?.ready ?? false;
          const status = capabilityStatus(
            { enabled, ready },
            capabilityDiagnostics.statusAvailable,
          );
          return (
            <article key={capability.name} className="rounded-2xl border border-edge bg-raised p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="min-w-0 break-words font-semibold text-strong">
                  {capability.title}
                </h2>
                <Badge
                  tone={
                    status === 'ready' ? 'green' : status === 'setup_needed' ? 'amber' : 'neutral'
                  }
                >
                  {capabilityStatusTitle(status)}
                </Badge>
              </div>
              <p className="mt-1 text-sm leading-6 text-muted">{capability.summary}</p>
              {status === 'setup_needed' || status === 'unavailable' ? (
                <p
                  className={`mt-3 rounded-xl px-3 py-2 text-xs leading-5 ${
                    status === 'setup_needed'
                      ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/35 dark:text-amber-300'
                      : 'bg-surface text-muted'
                  }`}
                >
                  {diagnostic?.detail ?? 'Unavailable'}
                </p>
              ) : null}
            </article>
          );
        })}
      </section>
    </PageShell>
  );
}
