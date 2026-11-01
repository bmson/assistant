import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { outboundCallTwiml, registerCallTools } from './index.js';

describe('phone.call tool', () => {
  const setup = () => {
    const registry = new ToolRegistry();
    const startCall = vi.fn(async () => ({ callSid: `CA${'a'.repeat(32)}` }));
    registerCallTools(registry, { allowedCountryCodes: '1', maxMinutes: 5, startCall });
    const registered = registry.get('phone.call');
    if (!registered) throw new Error('phone.call not registered');
    return { registered, startCall };
  };

  it('requires approval by default and allows only an explicitly saved call brief', () => {
    const { registered } = setup();
    expect(registered.tool.risk).toBe('approval');
    expect(registered.flags).toMatchObject({
      outwardFacing: true,
      blanketAllowIneligible: true,
      scopedAllowTemplates: ['phone.call.same_brief'],
      autonomyFloor: true,
      returnsUntrustedContent: true,
    });
    expect(registered.tool.acceptsUntrustedInput).toBe(false);
  });

  it('adds the owner-number grant template only behind the explicit feature flag', () => {
    const registry = new ToolRegistry();
    registerCallTools(registry, {
      allowedCountryCodes: '1',
      maxMinutes: 5,
      ownerNumberGrantEnabled: true,
      startCall: async () => ({ callSid: `CA${'b'.repeat(32)}` }),
    });
    expect(registry.get('phone.call')?.flags.scopedAllowTemplates).toEqual([
      'phone.call.same_brief',
      'phone.call.to_owner_number.v1',
      'phone.call.owner_action.v2',
    ]);
  });

  it('keeps the v2 cost quote read-only and separate from the generic reservation hook', async () => {
    const registry = new ToolRegistry();
    const quoteOwnerCallCostUsdMicros = vi.fn(async () => 123_456);
    registerCallTools(registry, {
      allowedCountryCodes: '1',
      maxMinutes: 5,
      ownerNumberGrantEnabled: true,
      quoteOwnerCallCostUsdMicros,
      startCall: async () => ({ callSid: `CA${'c'.repeat(32)}` }),
    });
    const tool = registry.get('phone.call')?.tool;
    expect(tool?.estimateCost).toBeUndefined();
    const quote = tool?.quoteOwnerCallCostUsdMicros;
    expect(quote).toBeDefined();
    if (!quote) throw new Error('call quote hook missing');
    await expect(
      quote(
        { brief: { to: '+14155550123', goal: 'Ask about hours', maxMinutes: 3 } },
        {} as ToolContext,
      ),
    ).resolves.toBe(123_456);
    expect(quoteOwnerCallCostUsdMicros).toHaveBeenCalledTimes(1);
  });

  it('refuses an undialable number before any approval card exists, and caps the length', async () => {
    const { registered } = setup();
    const prepare = registered.tool.prepare as NonNullable<typeof registered.tool.prepare>;
    const ctx = {} as ToolContext;
    await expect(
      prepare({ brief: { to: '+19005550123', goal: 'Win a prize', maxMinutes: 5 } }, ctx),
    ).rejects.toThrow('premium-rate');
    expect(
      await prepare(
        { brief: { to: '+14155550123', goal: 'Ask opening hours', maxMinutes: 30 } },
        ctx,
      ),
    ).toMatchObject({ brief: { maxMinutes: 5 } });
    expect(
      registered.tool.approvalSummary?.({
        brief: {
          to: '+14155550123',
          contactName: 'Nopa',
          goal: 'Book a table',
          mayAgreeTo: '7-8pm',
          mustNot: 'pay a deposit',
          context: '',
          language: 'English',
          maxMinutes: 5,
          onVoicemail: 'hang_up',
        },
      }),
    ).toBe(
      'Call Nopa (+14155550123) for up to 5 min: Book a table · May agree to: 7-8pm · Never: pay a deposit · Hangs up on voicemail',
    );
  });

  it('checkpoints the pending call before dialing and rolls back a definite refusal', async () => {
    const { registered, startCall } = setup();
    const staged: unknown[] = [];
    const cleared: unknown[] = [];
    const ctx = {
      taskId: 't',
      now: () => new Date('2026-09-27T00:00:00Z'),
      execution: { dbToolCallId: 'd', modelToolCallId: 'm', toolName: 'phone.call' },
      stageBrowserJob: async (job: unknown) => {
        // Nothing may ring before the pending call is durable.
        expect(startCall).toHaveBeenCalledTimes(staged.length);
        staged.push(job);
      },
      clearStagedBrowserJob: async (job: unknown) => void cleared.push(job),
      log: async () => {},
    } as unknown as ToolContext;
    const brief = { to: '+14155550123', goal: 'Ask opening hours', maxMinutes: 5 };
    const pending = (await registered.tool.execute({ brief }, ctx)) as {
      pending: string;
      timeoutAt: string;
    };
    expect(pending.pending).toBe('call_pending');
    // 5 min call + 3 ringing + 2 grace.
    expect(pending.timeoutAt).toBe('2026-09-27T00:10:00.000Z');
    expect(staged).toHaveLength(1);

    startCall.mockRejectedValueOnce(new Error('Another call is still in progress'));
    await expect(registered.tool.execute({ brief }, ctx)).rejects.toThrow('still in progress');
    expect(cleared).toHaveLength(1);
  });

  it('escapes everything placed into the TwiML', () => {
    const twiml = outboundCallTwiml({
      disclosure: 'Hi <Hangup/> & "bye"',
      streamUrl: 'wss://a.example/voice/stream',
      callId: 'id',
      streamToken: 'tok',
    });
    expect(twiml).toContain('Hi &lt;Hangup/&gt; &amp; &quot;bye&quot;');
    expect(twiml).not.toContain('<Hangup/>');
  });
});
