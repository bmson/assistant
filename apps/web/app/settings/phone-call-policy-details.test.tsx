import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PhoneCallPolicyPresentation } from '@/lib/phone-call-policy-presentation';
import { PhoneCallPolicyDetails } from './phone-call-policy-details';

describe('phone-call standing-rule settings details', () => {
  it('keeps long conditions readable and distinguishes a saved hang-up message from a message to leave', () => {
    const presentation: Extract<PhoneCallPolicyPresentation, { kind: 'same_brief' }> = {
      kind: 'same_brief',
      recipient: '+14155550123',
      contactName: 'Harbor Hotel',
      maxMinutes: 4,
      goal: 'Confirm the late check-in time',
      mayShare:
        'Booking HARBOR-42 is for Friday evening. The train is expected at 8:15 PM, and the front desk asked for an arrival estimate before 9 PM. Share only this booking and arrival context; do not add unrelated personal details.',
      mayAgreeTo:
        'Accept check-in until 10 PM only if there is no new fee, the room remains the existing reservation, and the hotel confirms the booking reference. If any condition is unclear, do not agree and ask Alex to decide.',
      mustNot:
        'Do not change the reservation, room type, dates, guest count, payment method, or cancellation terms. Do not accept a deposit, fee, upgrade, or other charge. Do not disclose a home address or any detail outside the approved context.',
      language: 'English',
      voicemailMode: 'hang_up',
      voicemailMessage:
        'This saved message belongs to the original brief and must remain visible for review even though the selected voicemail mode is hang up.',
    };
    const html = renderToStaticMarkup(<PhoneCallPolicyDetails presentation={presentation} />);
    const collapsed = html.split('<details')[0] ?? html;

    expect(html).toContain('Harbor Hotel');
    expect(html).toContain('+14155550123');
    expect(html).toContain('up to 4 min');
    expect(html).toContain('Exact approved brief');
    expect(html).toContain('Context from the approved brief');
    expect(collapsed).not.toContain('Booking HARBOR-42 is for Friday evening.');
    expect(html).toContain('May agree to: Accept check-in until 10 PM only if there is no new fee');
    expect(html).toContain('Instructions in approved brief: Do not change the reservation');
    expect(html).toContain('Voicemail: Hang up on voicemail');
    expect(html).toContain('Exact call brief');
    expect(html).toContain('Booking HARBOR-42 is for Friday evening.');
    expect(html).toContain('Do not change the reservation, room type, dates');
    expect(html).toContain('Saved voicemail message (not used when hanging up)');
    expect(html).toContain('This saved message belongs to the original brief');
    expect(html).toMatch(/<details class="[^"]*">/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('break-words');
  });

  it('uses Not specified consistently for empty approved-brief conditions', () => {
    const presentation: Extract<PhoneCallPolicyPresentation, { kind: 'same_brief' }> = {
      kind: 'same_brief',
      recipient: '+14155550123',
      contactName: '',
      maxMinutes: 4,
      goal: 'Confirm the late check-in time',
      mayShare: '',
      mayAgreeTo: '',
      mustNot: '',
      language: '',
      voicemailMode: 'leave_message',
      voicemailMessage: '',
    };
    const html = renderToStaticMarkup(<PhoneCallPolicyDetails presentation={presentation} />);
    const collapsed = html.split('<details')[0] ?? html;

    expect(collapsed).toContain('Context: Not specified');
    expect(html).toContain('May agree to: Not specified');
    expect(html).toContain('Instructions in approved brief: Not specified');
    expect(html).toContain('exact message: Not specified');
  });
});
