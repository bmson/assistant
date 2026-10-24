import { policyLabels, policyScope } from '@/app/settings/labels';
import { phoneCallPolicyPresentation } from './phone-call-policy-presentation';

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

export function projectStandingApprovalPolicy(policy: StandingApprovalPolicyInput) {
  return {
    id: policy.id,
    toolName: policy.toolName,
    templateKey: policy.templateKey,
    label: policy.label ?? policyLabels[policy.templateKey] ?? null,
    scope: policyScope(policy.templateKey, policy.match),
    phoneCallPresentation: phoneCallPolicyPresentation(policy),
    effect: policy.effect,
    enabled: policy.enabled,
    createdVia: policy.createdVia,
  };
}

export type StandingApprovalPolicyView = ReturnType<typeof projectStandingApprovalPolicy>;
