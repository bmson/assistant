import { describe, expect, it } from 'vitest';
import { phoneModules, phoneSetupInputs, requiredPhonePrice } from './phone-setup-plan.js';

describe('phone setup preflight', () => {
  it.each(['', 'minimal'])('keeps %s as base plus calls', (value) => {
    expect(phoneModules(value)).toBe('calls');
  });
  it('uses canonical aliases and preserves each service module selection', () => {
    expect(phoneModules('all')).toBe(phoneModules(undefined));
    expect(phoneModules('google, calendar')).toBe('google,calendar,calls');
    expect(
      phoneSetupInputs({
        agentModules: 'minimal',
        webModules: 'reminders',
        agentUrl: 'https://agent.example/',
        ownerPhone: '+14155550123',
        webUrl: 'https://web.example/',
      }),
    ).toMatchObject({ agentModules: 'calls', webModules: 'reminders,calls' });
  });
  it.each(['minimal,calls', 'future'])(
    'rejects invalid startup modules %s before setup',
    (value) => {
      expect(() => phoneModules(value)).toThrow();
    },
  );
  it.each([undefined, '', 'NaN', '-1', 'USD 2'])(
    'requires an obtained price %s before purchase',
    (value) => {
      expect(() => requiredPhonePrice(value)).toThrow('Stopped before purchase');
    },
  );
  it('accepts an explicit zero or decimal quote', () => {
    expect(requiredPhonePrice('0')).toBe('0');
    expect(requiredPhonePrice('1.15')).toBe('1.15');
  });
  it('rejects malformed owner and service URLs before any external mutation', () => {
    const input = {
      agentModules: 'minimal',
      webModules: 'minimal',
      agentUrl: 'https://agent.example',
      ownerPhone: '+14155550123',
      webUrl: 'https://web.example',
    };
    expect(() => phoneSetupInputs({ ...input, ownerPhone: 'invalid' })).toThrow('E.164');
    expect(() =>
      phoneSetupInputs({ ...input, agentUrl: 'https://user:pass@agent.example' }),
    ).toThrow('HTTPS');
    expect(() => phoneSetupInputs({ ...input, webUrl: 'http://web.example' })).toThrow('HTTPS');
  });
});
