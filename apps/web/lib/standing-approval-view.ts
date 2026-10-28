import { phoneCallPolicyPresentation } from '@assistant/application/approval-policy-presentation';
import {
  parsePhoneCallOwnerActionGrantMatch,
  parsePhoneCallToOwnerNumberGrantMatch,
} from '@assistant/persistence';
import {
  phonePermissionAvailability,
  phonePermissionKind,
  phonePermissionLabel,
  policyLabels,
  policyScope,
} from '@/app/settings/labels';

export interface StandingApprovalPolicyInput {
  id: string;
  toolName: string;
  templateKey: string;
  label?: string | null;
  match: unknown;
  effect: string;
  enabled: boolean;
  createdVia: string;
}

export function projectStandingApprovalPolicy(
  policy: StandingApprovalPolicyInput,
  ownerNumberGrantEnabled: boolean = false,
) {
  const presentation = phoneCallPolicyPresentation(policy);
  const isPhone = policy.toolName === 'phone.call';
  const kind: 'owner_number' | 'same_brief' | 'opaque' | null = !isPhone
    ? null
    : phonePermissionKind(policy.templateKey, policy.match) === 'owner_number'
      ? 'owner_number'
      : presentation?.kind === 'same_brief'
        ? 'same_brief'
        : 'opaque';
  const ownerGrant =
    kind === 'owner_number'
      ? policy.templateKey === 'phone.call.owner_action.v2'
        ? parsePhoneCallOwnerActionGrantMatch(policy.match)
        : parsePhoneCallToOwnerNumberGrantMatch(policy.match)
      : null;
  const phoneCallRecipient =
    kind === 'same_brief' && presentation?.kind === 'same_brief'
      ? presentation.recipient
      : (ownerGrant?.recipientE164 ?? null);
  const effectiveAvailability = !isPhone
    ? null
    : kind === 'same_brief'
      ? policy.effect !== 'allow'
        ? 'This saved entry is not an allow permission.'
        : policy.enabled
          ? 'Available for the exact approved brief.'
          : 'Paused. A new call permission needs a fresh review.'
      : (phonePermissionAvailability(policy, ownerNumberGrantEnabled) ??
        'Saved scope unavailable. Refresh or remove this entry.');
  const phoneCallState = !isPhone
    ? null
    : kind === 'opaque'
      ? 'Saved scope unavailable'
      : policy.effect !== 'allow'
        ? 'Unavailable'
        : !policy.enabled
          ? 'Paused'
          : effectiveAvailability?.startsWith('Expired')
            ? 'Expired'
            : effectiveAvailability?.includes('disabled by the system')
              ? 'Disabled by system'
              : kind === 'same_brief'
                ? 'Available for exact brief'
                : 'Available for direct requests';
  const expiresLine = ownerGrant
    ? `expires ${formatPhoneGrantExpiry(ownerGrant.expiresAt)}`
    : 'expiry not recorded';
  const phoneCallLimitLine = !isPhone
    ? null
    : kind === 'same_brief' && presentation?.kind === 'same_brief'
      ? `Exact approved brief · up to ${presentation.maxMinutes} min · expiry not recorded`
      : ownerGrant
        ? 'maxCallsPerHour' in ownerGrant
          ? `Direct owner calls · up to ${ownerGrant.maxMinutes} min · ${ownerGrant.maxCallsPerHour}/60 min, ${ownerGrant.maxCallsPerDay}/24 h · USD ${(ownerGrant.maxCostUsdMicrosPerCall / 1_000_000).toFixed(2)}/call, ${(ownerGrant.maxCostUsdMicrosPerDay / 1_000_000).toFixed(2)}/24 h · ${expiresLine}`
          : `Future owner-number calls · up to ${ownerGrant.maxMinutes} min · ${expiresLine}`
        : 'Saved scope unavailable · duration and expiry unavailable';
  return {
    id: policy.id,
    toolName: policy.toolName,
    templateKey: policy.templateKey,
    label:
      isPhone && kind !== 'same_brief'
        ? kind === 'owner_number'
          ? phonePermissionLabel(policy.templateKey, policy.match)
          : 'Stored phone permission'
        : (policy.label ?? policyLabels[policy.templateKey] ?? null),
    scope: isPhone && kind === 'opaque' ? null : policyScope(policy.templateKey, policy.match),
    phoneCallPresentation: presentation,
    phonePermissionKind: kind,
    phoneCallRecipient,
    phoneCallState,
    phoneCallLimitLine,
    opaqueDetails:
      isPhone && kind !== 'same_brief' && presentation?.kind === 'opaque'
        ? presentation.details
        : null,
    effectiveAvailability,
    effect: policy.effect,
    enabled: policy.enabled,
    createdVia: policy.createdVia,
  };
}

function formatPhoneGrantExpiry(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'expiry unavailable';
  return (
    new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(date) + ' (UTC)'
  );
}

export type StandingApprovalPolicyView = ReturnType<typeof projectStandingApprovalPolicy>;
