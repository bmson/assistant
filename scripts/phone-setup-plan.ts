import { parseAssistantModules } from '@assistant/config/modules';

/** Use the exact startup parser before any token, number or webhook mutation. */
export function phoneModules(current: string | undefined): string {
  const modules = new Set(parseAssistantModules(current));
  modules.add('calls');
  return [...modules].join(',');
}

export function phoneSetupInputs(input: {
  agentModules: string | undefined;
  webModules: string | undefined;
  agentUrl: string;
  ownerPhone: string;
  webUrl: string;
}) {
  const publicUrl = (raw: string) => {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.pathname !== '/'
    )
      throw new Error(
        'Phone setup requires a public HTTPS service URL without credentials or query.',
      );
    return url.origin;
  };
  if (input.ownerPhone && !/^\+[1-9]\d{6,14}$/.test(input.ownerPhone))
    throw new Error('Use E.164 form, like +14155550123.');
  return {
    ownerPhone: input.ownerPhone,
    agentModules: phoneModules(input.agentModules),
    webModules: phoneModules(input.webModules),
    agentUrl: publicUrl(input.agentUrl),
    webUrl: input.webUrl ? publicUrl(input.webUrl) : '',
  };
}

export function requiredPhonePrice(value: string | undefined): string {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))
    throw new Error('Could not verify the monthly number price. Stopped before purchase.');
  return value;
}
