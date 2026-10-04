'use client';

import { useEffect, useRef, useState } from 'react';
import { CopyButton } from '@/lib/copy-button';
import { btn } from '@/lib/ui';

/** Shows a new offline recovery code once and requires acknowledgement before continuing. */
export function RecoveryCodeNotice({
  code,
  continueHref,
}: {
  code: string;
  continueHref?: string;
}) {
  return <RecoveryCodeContent key={code} code={code} continueHref={continueHref} />;
}

function RecoveryCodeContent({ code, continueHref }: { code: string; continueHref?: string }) {
  const [saved, setSaved] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div className="grid min-w-0 gap-4 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold text-strong">
        Save your recovery code
      </h2>
      <p className="text-sm leading-6 text-amber-900 dark:text-amber-200">
        Keep this code in a password manager or on paper. It lets you add a new passkey if you lose
        your device. This is the only time it will be shown.
      </p>
      <code className="min-w-0 rounded-md border border-amber-300 bg-white px-3 py-2 font-mono text-lg text-strong [overflow-wrap:anywhere] select-all dark:border-amber-800 dark:bg-amber-950">
        {code}
      </code>
      <CopyButton value={code} name="recovery code" />
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-strong">
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-accent"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        I saved the recovery code
      </label>
      {continueHref ? (
        <div>
          <button
            type="button"
            disabled={!saved}
            onClick={() => window.location.assign(continueHref)}
            className={btn.primary}
          >
            Continue
          </button>
        </div>
      ) : null}
    </div>
  );
}
