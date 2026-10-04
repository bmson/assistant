'use client';
import { CopyButton } from '@/lib/copy-button';
import { textareaClass } from '@/lib/ui';
export function InvestigationBrief({ prompt }: { prompt: string }) {
  return (
    <section className="grid gap-3" aria-label="Investigation request">
      <h2 className="font-semibold">Investigation request</h2>
      <p className="text-sm text-muted">
        Paste this request into the mobile app. Your assistant can read the underlying records with
        its audit tools and cite the evidence behind its findings.
      </p>
      <textarea
        className={`min-h-32 w-full ${textareaClass}`}
        aria-label="Investigation request"
        value={prompt}
        readOnly
      />
      <CopyButton value={prompt} name="investigation request" />
    </section>
  );
}
