'use client';

import type { EstimatedCostQuote } from '@assistant/persistence';
import { useEffect, useState } from 'react';
import {
  createEstimatedCostTransport,
  type EstimatedCostTransport,
} from '@/app/chat/[id]/estimated-cost-transport';
import { InlineEstimatedCostRequest } from '@/app/chat/[id]/inline-estimated-cost-request';
import { cardShellClass } from '@/lib/ui';

const defaultTransport = createEstimatedCostTransport();

/** Resolve the exact operation before presenting its existing decision card. */
export function EstimatedCostRequestReview({
  operationId,
  formSessionScope,
  transport = defaultTransport,
}: {
  operationId: string;
  formSessionScope?: string;
  transport?: EstimatedCostTransport;
}) {
  const [state, setState] = useState<{
    operationId: string;
    quote: EstimatedCostQuote | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    setState(null);
    void transport.read(operationId).then(
      (result) => {
        if (active) {
          const quote =
            result.ok &&
            result.request.operationId === operationId &&
            result.request.quote?.operationId === operationId
              ? result.request.quote
              : null;
          setState({ operationId, quote });
        }
      },
      () => {
        if (active) setState({ operationId, quote: null });
      },
    );
    return () => {
      active = false;
    };
  }, [operationId, transport]);

  if (!state || state.operationId !== operationId) {
    return (
      <div className={`${cardShellClass} p-5`} role="status">
        Checking this request…
      </div>
    );
  }
  if (!state.quote) {
    return (
      <div className={`${cardShellClass} p-5`} role="status">
        This request is unavailable. Its current status could not be confirmed here.
      </div>
    );
  }
  return (
    <InlineEstimatedCostRequest
      part={state.quote}
      formSessionScope={formSessionScope}
      transport={transport}
    />
  );
}
