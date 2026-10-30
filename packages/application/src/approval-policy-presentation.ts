import { CallBriefSchema } from '@assistant/core';
import { z } from 'zod';

const SameBriefMatchSchema = z
  .object({
    brief: CallBriefSchema.strict(),
  })
  .strict();

export type PhoneCallPolicyPresentation =
  | {
      kind: 'same_brief';
      recipient: string;
      contactName: string;
      maxMinutes: number;
      goal: string;
      mayShare: string;
      mayAgreeTo: string;
      mustNot: string;
      language: string;
      voicemailMode: 'leave_message' | 'hang_up';
      voicemailMessage: string;
    }
  | { kind: 'opaque'; details: string };

function opaqueDetails(match: unknown): string {
  try {
    return JSON.stringify(match, null, 2) ?? String(match);
  } catch {
    return 'Saved rule data could not be displayed.';
  }
}

/**
 * Project phone-call standing-rule data for the authenticated owner's settings.
 * Only the exact legacy template is interpreted; unknown or malformed matches
 * remain available as readable opaque JSON and are never guessed at.
 */
export function phoneCallPolicyPresentation(input: {
  toolName: string;
  templateKey: string;
  match: unknown;
}): PhoneCallPolicyPresentation | null {
  if (input.toolName !== 'phone.call') return null;
  if (input.templateKey !== 'phone.call.same_brief') {
    return { kind: 'opaque', details: opaqueDetails(input.match) };
  }

  const parsed = SameBriefMatchSchema.safeParse(input.match);
  if (!parsed.success) return { kind: 'opaque', details: opaqueDetails(input.match) };
  const brief = parsed.data.brief;
  return {
    kind: 'same_brief',
    recipient: brief.to,
    contactName: brief.contactName ?? '',
    maxMinutes: brief.maxMinutes,
    goal: brief.goal,
    mayShare: brief.context,
    mayAgreeTo: brief.mayAgreeTo,
    mustNot: brief.mustNot,
    language: brief.language,
    voicemailMode: brief.onVoicemail,
    voicemailMessage: brief.voicemailMessage ?? '',
  };
}
