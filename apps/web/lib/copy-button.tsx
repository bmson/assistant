'use client';

import { useState } from 'react';
import { ActionButton } from './ui-client';

/** Clipboard feedback stays beside the value, including a usable manual fallback. */
export function CopyButton({ value, name }: { value: string; name: string }) {
  // A different value owns fresh feedback. An older clipboard operation can
  // finish after replacement without claiming the new value was copied.
  return <ClipboardButton key={value} value={value} name={name} />;
}

function ClipboardButton({ value, name }: { value: string; name: string }) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  return (
    <div className="grid min-w-0 justify-items-start gap-1">
      <ActionButton
        pending={state === 'copying'}
        pendingLabel="Copying…"
        onClick={() => {
          setState('copying');
          void (async () => {
            try {
              await navigator.clipboard.writeText(value);
              setState('copied');
            } catch {
              setState('failed');
            }
          })();
        }}
      >
        Copy {name}
      </ActionButton>
      <p role="status" className="text-xs leading-5 text-muted">
        {state === 'copied'
          ? `${name.charAt(0).toUpperCase()}${name.slice(1)} copied.`
          : state === 'failed'
            ? `Clipboard access is unavailable. Select and copy the ${name} above.`
            : ''}
      </p>
    </div>
  );
}
