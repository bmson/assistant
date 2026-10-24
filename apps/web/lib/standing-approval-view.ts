import { phoneCallPolicyPresentation } from '@assistant/application/approval-policy-presentation';
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
    opaqueDetails:
      isPhone && kind !== 'same_brief' && presentation?.kind === 'opaque'
        ? presentation.details
        : null,
    effectiveAvailability: isPhone
      ? phonePermissionAvailability(policy, ownerNumberGrantEnabled)
      : null,
    effect: policy.effect,
    enabled: policy.enabled,
    createdVia: policy.createdVia,
  };
}

export type StandingApprovalPolicyView = ReturnType<typeof projectStandingApprovalPolicy>;
