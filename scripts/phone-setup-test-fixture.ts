import {
  createPhoneSetupPorts,
  describePhoneService,
  type PhoneApi,
  type PhoneGcloud,
  phoneRouting,
} from './phone-setup-adapters.js';
import {
  type PhoneSetupPlan,
  type PhoneSetupStep,
  validatePhoneSetupPlan,
} from './phone-setup-lifecycle.js';
import { phoneSetupInputs } from './phone-setup-plan.js';

export const syntheticPhone = '+14155550123';
export const syntheticSid = `PN${'a'.repeat(32)}`;
export const syntheticAccount = `AC${'a'.repeat(32)}`;
export const syntheticToken = 'b'.repeat(32);
export function syntheticNumber() {
  return {
    sid: syntheticSid,
    phone_number: syntheticPhone,
    capabilities: { voice: true, sms: true },
    voice_url: 'https://existing.example/calls',
    voice_method: 'GET',
    sms_url: 'https://existing.example/texts',
    sms_method: 'GET',
    voice_fallback_url: 'https://existing.example/fallback',
    voice_fallback_method: 'POST',
    status_callback: 'https://existing.example/status',
    status_callback_method: 'POST',
  } as Record<string, unknown> & {
    sid: string;
    phone_number: string;
    capabilities: { voice: boolean; sms: boolean };
  };
}
function serviceJson(name: string) {
  return {
    status: {
      url: `https://${name}.example`,
      latestReadyRevisionName: `${name}-old`,
      latestCreatedRevisionName: `${name}-old`,
      conditions: [{ type: 'Ready', status: 'True' }],
    },
    spec: {
      template: {
        spec: {
          serviceAccountName: 'agent@fake-project.iam.gserviceaccount.com',
          timeoutSeconds: 300,
          containers: [
            {
              env: [{ name: 'ASSISTANT_MODULES', value: 'minimal' }] as Array<{
                name: string;
                value?: string;
                valueFrom?: { secretKeyRef: { name: string; key: string } };
              }>,
            },
          ],
        },
      },
    },
  };
}
export type FakePhoneState = {
  services: Record<string, ReturnType<typeof serviceJson>>;
  number: ReturnType<typeof syntheticNumber> | null;
  secrets: Record<string, string>;
  bindings: string[];
  mutations: string[];
  requests: Array<{ url: string; form?: Record<string, string> }>;
  missingPermission?: string;
  monthly: string;
};
export function fakePhoneState(purchase = false): FakePhoneState {
  return {
    services: {
      'assistant-agent': serviceJson('assistant-agent'),
      'assistant-web': serviceJson('assistant-web'),
    },
    number: purchase ? null : syntheticNumber(),
    secrets: {},
    bindings: [],
    mutations: [],
    requests: [],
    monthly: '1.15',
  };
}
export function fakePhonePorts(
  state: FakePhoneState,
  options: {
    failBefore?: PhoneSetupStep;
    failAfter?: PhoneSetupStep;
    afterMutation?: (step: PhoneSetupStep) => void | Promise<void>;
  } = {},
) {
  const before = (step: PhoneSetupStep) => {
    if (options.failBefore === step) throw new Error(`synthetic failure before ${step}`);
  };
  const after = (step: PhoneSetupStep) => {
    state.mutations.push(step);
    if (options.failAfter === step) throw new Error(`synthetic receipt loss after ${step}`);
  };
  const gcloud: PhoneGcloud = (args, input) => {
    if (args[0] === 'services' && args[1] === 'list')
      return 'run.googleapis.com\nsecretmanager.googleapis.com';
    if (args[0] === 'run' && args[2] === 'describe')
      return JSON.stringify(state.services[args[3] ?? '']);
    if (args[0] === 'secrets' && args[1] === 'create') {
      before('secret');
      const name = args[2];
      if (!name || state.secrets[name]) throw new Error('duplicate secret');
      state.secrets[name] = input ?? '';
      after('secret');
      return '{}';
    }
    if (args[0] === 'secrets' && args[1] === 'add-iam-policy-binding') {
      before('secretAccess');
      state.bindings.push(args[2] ?? '');
      after('secretAccess');
      return '{}';
    }
    if (args[0] === 'secrets' && args[1] === 'get-iam-policy')
      return JSON.stringify({
        bindings: state.bindings.includes(args[2] ?? '')
          ? [
              {
                role: 'roles/secretmanager.secretAccessor',
                members: ['serviceAccount:agent@fake-project.iam.gserviceaccount.com'],
              },
            ]
          : [],
      });
    if (args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'access') {
      const name = args[args.indexOf('--secret') + 1] ?? '';
      const value = state.secrets[name];
      if (value === undefined) throw new Error('not found');
      return value;
    }
    if (args[0] === 'run' && args[2] === 'update') {
      const name = args[3] ?? '';
      const step = name === 'assistant-agent' ? 'agent' : 'web';
      before(step);
      const service = state.services[name];
      if (!service) throw new Error('missing service');
      const envArg = args.find((arg) => arg.startsWith('--update-env-vars=^|^'));
      for (const pair of envArg?.slice('--update-env-vars=^|^'.length).split('|') ?? []) {
        const separator = pair.indexOf('=');
        const key = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        const env = service.spec.template.spec.containers[0]?.env;
        if (!env) throw new Error('missing env');
        const existing = env.find((entry) => entry.name === key);
        if (existing) existing.value = value;
        else env.push({ name: key, value });
      }
      const secret = args.find((arg) => arg.startsWith('--update-secrets=TWILIO_AUTH_TOKEN='));
      if (secret) {
        const [secretName, version] = secret
          .slice('--update-secrets=TWILIO_AUTH_TOKEN='.length)
          .split(':');
        service.spec.template.spec.containers[0]?.env.push({
          name: 'TWILIO_AUTH_TOKEN',
          valueFrom: { secretKeyRef: { name: secretName ?? '', key: version ?? '' } },
        });
        service.spec.template.spec.timeoutSeconds = 3600;
      }
      service.status.latestCreatedRevisionName = `${name}-new`;
      service.status.latestReadyRevisionName = `${name}-new`;
      after(step);
      return '{}';
    }
    throw new Error(`Unhandled fake command ${args.slice(0, 4).join(' ')}`);
  };
  const twilio: PhoneApi = async <T>(url: string, form?: Record<string, string>) => {
    state.requests.push({ url, ...(form ? { form } : {}) });
    if (url.endsWith(`${syntheticAccount}.json`))
      return { sid: syntheticAccount, status: 'active' } as T;
    if (url.includes('pricing.twilio.com'))
      return {
        price_unit: 'USD',
        phone_number_prices: [{ number_type: 'local', current_price: state.monthly }],
      } as T;
    if (form?.PhoneNumber) {
      before('number');
      if (state.number) throw new Error('duplicate purchase');
      state.number = syntheticNumber();
      after('number');
      await options.afterMutation?.('number');
      return state.number as T;
    }
    if (url.includes('IncomingPhoneNumbers.json?'))
      return { incoming_phone_numbers: state.number ? [state.number] : [] } as T;
    if (url.includes(`/IncomingPhoneNumbers/${syntheticSid}.json`)) {
      if (!state.number) throw new Error('number missing');
      if (form) {
        before('routing');
        Object.assign(state.number, {
          voice_url: form.VoiceUrl,
          voice_method: form.VoiceMethod,
          sms_url: form.SmsUrl,
          sms_method: form.SmsMethod,
        });
        after('routing');
      }
      return state.number as T;
    }
    throw new Error('Unhandled fake Twilio URL');
  };
  const ports = createPhoneSetupPorts({
    gcloud,
    twilio,
    cloud: async (_url, permissions) =>
      permissions.filter((permission) => permission !== state.missingPermission),
    token: syntheticToken,
  });
  return { gcloud, ports };
}
export function fakePhonePlan(
  state: FakePhoneState,
  modules: string | undefined = 'minimal',
): PhoneSetupPlan {
  const { gcloud } = fakePhonePorts(state);
  return validatePhoneSetupPlan({
    project: 'fake-project',
    region: 'us-west1',
    account: syntheticAccount,
    ...phoneSetupInputs({
      agentModules: modules,
      webModules: modules,
      agentUrl: 'https://assistant-agent.example',
      webUrl: 'https://assistant-web.example',
      ownerPhone: '+14155550999',
    }),
    vertex: false,
    serviceAccount: 'agent@fake-project.iam.gserviceaccount.com',
    webServiceAccount: 'agent@fake-project.iam.gserviceaccount.com',
    agentBefore: describePhoneService(gcloud, 'assistant-agent', 'fake-project', 'us-west1')
      .snapshot,
    webBefore: describePhoneService(gcloud, 'assistant-web', 'fake-project', 'us-west1').snapshot,
    number: state.number
      ? {
          kind: 'existing',
          sid: syntheticSid,
          phone: syntheticPhone,
          routingBefore: phoneRouting(state.number),
        }
      : { kind: 'purchase', phone: syntheticPhone, monthlyUsd: '1.15' },
    transitionApproved: true,
    purchaseApproved: !state.number,
  });
}
