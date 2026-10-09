import type {
  PhoneServiceSnapshot,
  PhoneSetupPlan,
  PhoneSetupPorts,
  PhoneSetupRecord,
} from './phone-setup-lifecycle.js';
import { setupNumber, setupSecretName, setupSecretVersion } from './phone-setup-lifecycle.js';
import { requiredPhonePrice } from './phone-setup-plan.js';

export type PhoneGcloud = (args: string[], input?: string) => string;
export type PhoneApi = <T>(url: string, form?: Record<string, string>) => Promise<T>;
export type PhoneCloudApi = (url: string, permissions: string[]) => Promise<string[]>;
const configuredKeys = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_FROM_NUMBER',
  'TWILIO_VOICE_FROM_NUMBER',
  'OWNER_PHONE',
  'WEB_URL',
  'ASSISTANT_MODULES',
  'VERTEX_PROJECT',
  'VERTEX_LOCATION',
];
const routingKeys = [
  'voice_url',
  'voice_method',
  'sms_url',
  'sms_method',
  'voice_application_sid',
  'sms_application_sid',
  'trunk_sid',
  'voice_fallback_url',
  'voice_fallback_method',
  'sms_fallback_url',
  'sms_fallback_method',
  'status_callback',
  'status_callback_method',
];
type IncomingNumber = {
  sid: string;
  phone_number: string;
  capabilities: { voice: boolean; sms: boolean };
} & Record<string, unknown>;

export function phoneRouting(number: IncomingNumber): Record<string, string> {
  return Object.fromEntries(routingKeys.map((key) => [key, String(number[key] ?? '')]));
}
export function assertPhoneNumberRouting(number: IncomingNumber) {
  if (!number.capabilities.voice || !number.capabilities.sms)
    throw new Error('The selected number must support both calls and SMS.');
  if (number.voice_application_sid || number.sms_application_sid || number.trunk_sid)
    throw new Error(
      'This number belongs to a TwiML application or trunk. Review and detach that routing in Twilio before choosing it.',
    );
}

export function describePhoneService(
  gcloud: PhoneGcloud,
  service: string,
  project: string,
  region: string,
) {
  const json = JSON.parse(
    gcloud([
      'run',
      'services',
      'describe',
      service,
      '--region',
      region,
      '--project',
      project,
      '--format=json',
    ]),
  ) as {
    status?: {
      url?: string;
      latestCreatedRevisionName?: string;
      latestReadyRevisionName?: string;
      conditions?: Array<{ type: string; status: string }>;
    };
    spec: {
      template: {
        spec: {
          serviceAccountName?: string;
          timeoutSeconds?: number;
          containers: Array<{
            env?: Array<{
              name: string;
              value?: string;
              valueFrom?: { secretKeyRef?: { name: string; key: string } };
            }>;
          }>;
        };
      };
    };
  };
  const spec = json.spec.template.spec;
  const entries = spec.containers[0]?.env ?? [];
  const env = Object.fromEntries(
    entries
      .filter((entry) => entry.value !== undefined)
      .map((entry) => [entry.name, entry.value ?? '']),
  );
  if (entries.some((entry) => entry.name === 'TWILIO_AUTH_TOKEN' && entry.value !== undefined))
    throw new Error('Replace the inline Twilio token with a secret reference before phone setup.');
  const ref = entries.find((entry) => entry.name === 'TWILIO_AUTH_TOKEN')?.valueFrom?.secretKeyRef;
  const snapshot: PhoneServiceSnapshot = {
    env: Object.fromEntries(
      configuredKeys.filter((key) => env[key] !== undefined).map((key) => [key, env[key] ?? '']),
    ),
    tokenReference: ref ? `${ref.name}:${ref.key}` : null,
    timeout: spec.timeoutSeconds ?? 300,
    revision: json.status?.latestReadyRevisionName ?? '',
  };
  return {
    env,
    snapshot,
    url: json.status?.url ?? '',
    serviceAccount: spec.serviceAccountName ?? '',
    ready:
      json.status?.conditions?.some(
        (condition) => condition.type === 'Ready' && condition.status === 'True',
      ) === true &&
      Boolean(json.status.latestReadyRevisionName) &&
      json.status.latestReadyRevisionName === json.status.latestCreatedRevisionName,
  };
}

export function phoneServiceUpdates(record: PhoneSetupRecord, service: 'agent' | 'web') {
  const plan = record.plan;
  const before = service === 'agent' ? plan.agentBefore : plan.webBefore;
  return {
    ASSISTANT_MODULES: service === 'agent' ? plan.agentModules : plan.webModules,
    ...(service === 'agent'
      ? {
          TWILIO_ACCOUNT_SID: plan.account,
          TWILIO_FROM_NUMBER: setupNumber(record).phone,
          TWILIO_VOICE_FROM_NUMBER: setupNumber(record).phone,
          ...(plan.ownerPhone ? { OWNER_PHONE: plan.ownerPhone } : {}),
          ...(plan.webUrl ? { WEB_URL: plan.webUrl } : {}),
        }
      : {}),
    ...(plan.vertex && !before.env.VERTEX_PROJECT
      ? { VERTEX_PROJECT: plan.project, VERTEX_LOCATION: 'us-central1' }
      : {}),
  };
}
function desiredService(
  record: PhoneSetupRecord,
  service: 'agent' | 'web',
  snapshot: PhoneServiceSnapshot,
) {
  return (
    Object.entries(phoneServiceUpdates(record, service)).every(
      ([key, value]) => snapshot.env[key] === value,
    ) &&
    (service === 'web' ||
      (snapshot.tokenReference === `${setupSecretName(record)}:${setupSecretVersion(record)}` &&
        snapshot.timeout === 3600))
  );
}
function desiredRouting(record: PhoneSetupRecord) {
  return {
    VoiceUrl: new URL('/webhooks/twilio/voice', record.plan.agentUrl).toString(),
    VoiceMethod: 'POST',
    SmsUrl: new URL('/webhooks/twilio/sms', record.plan.agentUrl).toString(),
    SmsMethod: 'POST',
  };
}
function routingMatchesDesired(record: PhoneSetupRecord, routing: Record<string, string>) {
  const desired = desiredRouting(record);
  const previous = setupNumber(record).routingBefore;
  return (
    routing.voice_url === desired.VoiceUrl &&
    routing.voice_method === desired.VoiceMethod &&
    routing.sms_url === desired.SmsUrl &&
    routing.sms_method === desired.SmsMethod &&
    Object.entries(previous).every(
      ([key, value]) =>
        ['voice_url', 'voice_method', 'sms_url', 'sms_method'].includes(key) ||
        routing[key] === value,
    )
  );
}

/** Explicit transports let qualification exercise the shipped command and form builders. */
export function createPhoneSetupPorts(input: {
  gcloud: PhoneGcloud;
  twilio: PhoneApi;
  cloud: PhoneCloudApi;
  token: string;
}): PhoneSetupPorts {
  const { gcloud, twilio, cloud, token } = input;
  const service = (plan: PhoneSetupPlan, which: 'agent' | 'web') =>
    describePhoneService(gcloud, `assistant-${which}`, plan.project, plan.region);
  const base = (plan: PhoneSetupPlan) =>
    `https://api.twilio.com/2010-04-01/Accounts/${plan.account}`;
  const currentNumber = (record: PhoneSetupRecord) =>
    twilio<IncomingNumber>(
      `${base(record.plan)}/IncomingPhoneNumbers/${setupNumber(record).sid}.json`,
    );
  const hasBinding = (record: PhoneSetupRecord, resource: 'secret' | 'project', role: string) => {
    const args =
      resource === 'secret'
        ? [
            'secrets',
            'get-iam-policy',
            setupSecretName(record),
            '--project',
            record.plan.project,
            '--format=json',
          ]
        : ['projects', 'get-iam-policy', record.plan.project, '--format=json'];
    const policy = JSON.parse(gcloud(args)) as {
      bindings?: Array<{ role: string; members?: string[]; condition?: unknown }>;
    };
    return (
      policy.bindings?.some(
        (binding) =>
          binding.role === role &&
          !binding.condition &&
          binding.members?.includes(`serviceAccount:${record.plan.serviceAccount}`),
      ) === true
    );
  };
  return {
    async preflight(record) {
      const plan = record.plan;
      const account = await twilio<{ sid: string; status: string }>(`${base(plan)}.json`);
      if (account.sid !== plan.account || account.status !== 'active')
        throw new Error('The approved Twilio account is not active.');
      for (const which of ['agent', 'web'] as const) {
        const current = service(plan, which);
        const approvedAccount = which === 'agent' ? plan.serviceAccount : plan.webServiceAccount;
        if (!current.ready || current.serviceAccount !== approvedAccount)
          throw new Error(`The ${which} service is not ready with the approved identity.`);
        const effect = record.effects[which];
        const before = which === 'agent' ? plan.agentBefore : plan.webBefore;
        if (!effect && JSON.stringify(current.snapshot) !== JSON.stringify(before))
          throw new Error(
            `The ${which} configuration changed since approval. Stopped before further effects.`,
          );
        if (effect?.status === 'done' && !desiredService(record, which, current.snapshot))
          throw new Error(
            `The completed ${which} configuration has changed. Inspect recovery before continuing.`,
          );
        const permissions = ['run.services.get', 'run.services.update'];
        const granted = await cloud(
          `https://run.googleapis.com/v2/projects/${plan.project}/locations/${plan.region}/services/assistant-${which}:testIamPermissions`,
          permissions,
        );
        if (permissions.some((permission) => !granted.includes(permission)))
          throw new Error(
            `Missing Cloud Run ${which} update permissions. Stopped before further effects.`,
          );
      }
      const permissions = [
        'secretmanager.secrets.create',
        'secretmanager.secrets.setIamPolicy',
        'secretmanager.secrets.getIamPolicy',
        'secretmanager.versions.access',
      ];
      if (plan.vertex)
        permissions.push(
          'serviceusage.services.enable',
          'resourcemanager.projects.getIamPolicy',
          'resourcemanager.projects.setIamPolicy',
        );
      const granted = await cloud(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${plan.project}:testIamPermissions`,
        permissions,
      );
      if (permissions.some((permission) => !granted.includes(permission)))
        throw new Error(
          'Missing secret or voice-access permissions. Stopped before further effects.',
        );
      for (const account of new Set([plan.serviceAccount, plan.webServiceAccount])) {
        const canUseAccount = await cloud(
          `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(account)}:testIamPermissions`,
          ['iam.serviceAccounts.actAs'],
        );
        if (!canUseAccount.includes('iam.serviceAccounts.actAs'))
          throw new Error(
            'Missing permission to use a service account. Stopped before further effects.',
          );
      }
      const enabledApis = gcloud([
        'services',
        'list',
        '--enabled',
        '--project',
        plan.project,
        '--format=value(config.name)',
      ]).split('\n');
      if (
        !enabledApis.includes('secretmanager.googleapis.com') ||
        !enabledApis.includes('run.googleapis.com')
      )
        throw new Error('Cloud Run and Secret Manager APIs must be enabled before phone setup.');
      if (plan.number.kind === 'existing') {
        const number = await twilio<IncomingNumber>(
          `${base(plan)}/IncomingPhoneNumbers/${plan.number.sid}.json`,
        );
        assertPhoneNumberRouting(number);
        if (number.phone_number !== plan.number.phone)
          throw new Error('The approved phone number identity changed.');
        if (
          !record.effects.routing &&
          JSON.stringify(phoneRouting(number)) !== JSON.stringify(plan.number.routingBefore)
        )
          throw new Error(
            'Existing phone routing changed since approval. Stopped before further effects.',
          );
      } else if (!record.effects.number) {
        const quote = await twilio<{
          price_unit: string;
          phone_number_prices: Array<{ number_type: string; current_price: string }>;
        }>('https://pricing.twilio.com/v1/PhoneNumbers/Countries/US');
        const price = requiredPhonePrice(
          quote.phone_number_prices.find((price) => price.number_type === 'local')?.current_price,
        );
        if (quote.price_unit !== 'USD' || price !== plan.number.monthlyUsd)
          throw new Error(
            'The approved USD price is unavailable or changed. Stopped before purchase.',
          );
      }
    },
    async apply(step, record) {
      const plan = record.plan;
      switch (step) {
        case 'secret':
          gcloud(
            [
              'secrets',
              'create',
              setupSecretName(record),
              '--project',
              plan.project,
              '--replication-policy=automatic',
              '--data-file=-',
            ],
            token,
          );
          return '1';
        case 'secretAccess':
          gcloud([
            'secrets',
            'add-iam-policy-binding',
            setupSecretName(record),
            '--project',
            plan.project,
            `--member=serviceAccount:${plan.serviceAccount}`,
            '--role=roles/secretmanager.secretAccessor',
            '--quiet',
          ]);
          return true;
        case 'number': {
          if (plan.number.kind === 'existing')
            return {
              sid: plan.number.sid,
              phone: plan.number.phone,
              routingBefore: plan.number.routingBefore,
            };
          const quote = await twilio<{
            price_unit: string;
            phone_number_prices: Array<{ number_type: string; current_price: string }>;
          }>('https://pricing.twilio.com/v1/PhoneNumbers/Countries/US');
          if (
            quote.price_unit !== 'USD' ||
            requiredPhonePrice(
              quote.phone_number_prices.find((price) => price.number_type === 'local')
                ?.current_price,
            ) !== plan.number.monthlyUsd
          )
            throw new Error('Price changed before purchase. No purchase was repeated.');
          const number = await twilio<IncomingNumber>(`${base(plan)}/IncomingPhoneNumbers.json`, {
            PhoneNumber: plan.number.phone,
          });
          assertPhoneNumberRouting(number);
          return {
            sid: number.sid,
            phone: number.phone_number,
            routingBefore: phoneRouting(number),
          };
        }
        case 'voiceAccess':
          if (plan.vertex) {
            gcloud(['services', 'enable', 'aiplatform.googleapis.com', '--project', plan.project]);
            gcloud([
              'projects',
              'add-iam-policy-binding',
              plan.project,
              `--member=serviceAccount:${plan.serviceAccount}`,
              '--role=roles/aiplatform.user',
              '--condition=None',
              '--quiet',
            ]);
          }
          return true;
        case 'agent':
        case 'web': {
          const before = step === 'agent' ? plan.agentBefore : plan.webBefore;
          const preceding = service(plan, step);
          if (!preceding.ready || JSON.stringify(preceding.snapshot) !== JSON.stringify(before))
            throw new Error(
              `The ${step} configuration changed before its update. It has not been overwritten.`,
            );
          const updates = phoneServiceUpdates(record, step);
          gcloud([
            'run',
            'services',
            'update',
            `assistant-${step}`,
            '--region',
            plan.region,
            '--project',
            plan.project,
            `--update-env-vars=^|^${Object.entries(updates)
              .map(([key, value]) => `${key}=${value}`)
              .join('|')}`,
            ...(step === 'agent'
              ? [
                  `--update-secrets=TWILIO_AUTH_TOKEN=${setupSecretName(record)}:${setupSecretVersion(record)}`,
                  '--timeout=3600',
                ]
              : []),
            '--quiet',
          ]);
          const current = service(plan, step);
          if (!current.ready || !desiredService(record, step, current.snapshot))
            throw new Error(`The ${step} update is not confirmed ready. Routing is unchanged.`);
          return current.snapshot.revision;
        }
        case 'routing': {
          await this.preflight(record);
          const number = await currentNumber(record);
          assertPhoneNumberRouting(number);
          if (
            JSON.stringify(phoneRouting(number)) !==
            JSON.stringify(setupNumber(record).routingBefore)
          )
            throw new Error(
              'Phone routing changed before activation. It has not been overwritten.',
            );
          await twilio(
            `${base(plan)}/IncomingPhoneNumbers/${setupNumber(record).sid}.json`,
            desiredRouting(record),
          );
          if (!routingMatchesDesired(record, phoneRouting(await currentNumber(record))))
            throw new Error(
              'The routing result could not be verified. Inspect recovery before continuing.',
            );
          return true;
        }
      }
    },
    async reconcile(step, record) {
      const plan = record.plan;
      switch (step) {
        case 'secret': {
          try {
            const current = gcloud([
              'secrets',
              'versions',
              'access',
              '1',
              '--secret',
              setupSecretName(record),
              '--project',
              plan.project,
            ]);
            return current === token ? '1' : undefined;
          } catch {
            return undefined;
          }
        }
        case 'secretAccess':
          return hasBinding(record, 'secret', 'roles/secretmanager.secretAccessor')
            ? true
            : undefined;
        case 'number': {
          if (plan.number.kind === 'existing')
            return {
              sid: plan.number.sid,
              phone: plan.number.phone,
              routingBefore: plan.number.routingBefore,
            };
          const numbers = await twilio<{ incoming_phone_numbers: IncomingNumber[] }>(
            `${base(plan)}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(plan.number.phone)}&PageSize=50`,
          );
          const matches = numbers.incoming_phone_numbers.filter(
            (number) => number.phone_number === plan.number.phone,
          );
          if (matches.length !== 1 || !matches[0]) return undefined;
          assertPhoneNumberRouting(matches[0]);
          return {
            sid: matches[0].sid,
            phone: matches[0].phone_number,
            routingBefore: phoneRouting(matches[0]),
          };
        }
        case 'voiceAccess': {
          if (!plan.vertex) return true;
          const enabled = gcloud([
            'services',
            'list',
            '--enabled',
            '--project',
            plan.project,
            '--format=value(config.name)',
          ]);
          return enabled.split('\n').includes('aiplatform.googleapis.com') &&
            hasBinding(record, 'project', 'roles/aiplatform.user')
            ? true
            : undefined;
        }
        case 'agent':
        case 'web': {
          const current = service(plan, step);
          return current.ready && desiredService(record, step, current.snapshot)
            ? current.snapshot.revision
            : undefined;
        }
        case 'routing':
          return routingMatchesDesired(record, phoneRouting(await currentNumber(record)))
            ? true
            : undefined;
      }
    },
  };
}
