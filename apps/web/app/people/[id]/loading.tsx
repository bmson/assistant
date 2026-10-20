import { PageShell, Skeleton } from '@/lib/ui';

/** Loading fallback for a person's page while the dossier resolves. */
export default function Loading() {
  return (
    <PageShell size="reading">
      <Skeleton className="h-9 w-64" />
      <div className="mt-4 flex items-start gap-4">
        <Skeleton className="size-14 shrink-0 rounded-full!" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <Skeleton className="mt-6 h-24 w-full rounded-2xl" />
      <div className="mt-8 flex flex-col gap-2">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
      <div className="mt-8 flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    </PageShell>
  );
}
