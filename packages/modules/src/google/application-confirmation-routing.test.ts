import { buildEmailContentProvenance } from '@assistant/core';
import { describe, expect, it, vi } from 'vitest';
import type { ApplicationConfirmationDeps } from './application-confirmations.js';
import {
  confirmationTokenHashes,
  routeApplicationConfirmation,
} from './application-confirmations.js';

function routingDeps(
  overrides: Partial<{
    alreadyClaimed: unknown;
    candidates: Array<{ confirmationTokenHash: string }>;
  }> = {},
) {
  const applications = {
    byConfirmationMessage: vi.fn().mockResolvedValue(overrides.alreadyClaimed ?? null),
    awaitingFrom: vi.fn().mockResolvedValue(overrides.candidates ?? []),
    expireDue: vi.fn(),
    claim: vi.fn(),
    createWatch: vi.fn(),
    list: vi.fn(),
    cancel: vi.fn(),
    get: vi.fn(),
    updateActionState: vi.fn(),
    toolCallStatus: vi.fn(),
    settleExecutingToolCall: vi.fn(),
  };
  const deps = {
    persistence: { applications },
    notifyOwner: vi.fn(),
  } as unknown as ApplicationConfirmationDeps;
  return { deps, applications };
}

const body = 'We received your application.';
const input = {
  agentId: 'owner-id',
  messageId: 'gmail-id',
  from: 'HR@company.example',
  subject: 'Offer confirmed REF-12345',
  body,
  emailContentProvenance: buildEmailContentProvenance({
    subject: 'Offer confirmed REF-12345',
    fullBody: body,
    storedBody: body,
    messagePrefix: '',
    authenticated: true,
    mode: 'direct',
    parts: [],
  }),
  authenticated: true,
};

describe('direct email route snapshot', () => {
  it('routes an exact saved application token to its durable application observer without mutating the watch', async () => {
    const tokenHash = [...confirmationTokenHashes(`${input.subject}\n${input.body}`)][0] as string;
    const { deps, applications } = routingDeps({
      candidates: [{ confirmationTokenHash: tokenHash }],
    });

    await expect(routeApplicationConfirmation(deps, input)).resolves.toBe(
      'application_confirmation',
    );
    expect(applications.byConfirmationMessage).toHaveBeenCalledWith(
      input.agentId,
      `gmail:${input.messageId}`,
    );
    expect(applications.awaitingFrom).toHaveBeenCalledWith(
      input.agentId,
      input.from.toLowerCase(),
      expect.any(Date),
    );
    expect(applications.expireDue).not.toHaveBeenCalled();
    expect(applications.claim).not.toHaveBeenCalled();
    expect(applications.createWatch).not.toHaveBeenCalled();
  });

  it('does not route a watched token when direct-source provenance is missing', async () => {
    const tokenHash = [...confirmationTokenHashes(`${input.subject}\n${input.body}`)][0] as string;
    const { deps } = routingDeps({ candidates: [{ confirmationTokenHash: tokenHash }] });
    await expect(
      routeApplicationConfirmation(deps, { ...input, emailContentProvenance: null }),
    ).resolves.toBe('email_triage');
  });

  it('routes a nonmatch to ordinary email triage and does not claim an unrelated watch', async () => {
    const { deps, applications } = routingDeps({
      candidates: [{ confirmationTokenHash: 'unrelated-token-hash' }],
    });

    await expect(routeApplicationConfirmation(deps, input)).resolves.toBe('email_triage');
    expect(applications.expireDue).not.toHaveBeenCalled();
    expect(applications.claim).not.toHaveBeenCalled();
  });

  it('keeps an already claimed Gmail message on the application path even after its watch leaves awaiting state', async () => {
    const { deps, applications } = routingDeps({
      alreadyClaimed: { id: 'application-id', status: 'updated' },
    });

    await expect(routeApplicationConfirmation(deps, input)).resolves.toBe(
      'application_confirmation',
    );
    expect(applications.awaitingFrom).not.toHaveBeenCalled();
  });

  it('fails closed to no application route for unauthenticated mail', async () => {
    const { deps, applications } = routingDeps({
      candidates: [
        {
          confirmationTokenHash: [
            ...confirmationTokenHashes(`${input.subject}\n${input.body}`),
          ][0] as string,
        },
      ],
    });

    await expect(
      routeApplicationConfirmation(deps, { ...input, authenticated: false }),
    ).resolves.toBe('email_triage');
    expect(applications.byConfirmationMessage).not.toHaveBeenCalled();
    expect(applications.awaitingFrom).not.toHaveBeenCalled();
  });
});
