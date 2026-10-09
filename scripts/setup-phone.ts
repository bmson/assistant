/** pnpm setup:phone: an approved, resumable transition on the owner's cloud/Twilio account. */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  assertPhoneNumberRouting,
  createPhoneSetupPorts,
  describePhoneService,
  type PhoneApi,
  phoneRouting,
} from './phone-setup-adapters.js';
import {
  PhoneSetupJournal,
  type PhoneSetupPlan,
  runPhoneSetup,
  setupNumber,
  validatePhoneSetupPlan,
} from './phone-setup-lifecycle.js';
import { phoneSetupInputs, requiredPhonePrice } from './phone-setup-plan.js';

function gcloud(args: string[], input?: string): string {
  const result = spawnSync('gcloud', args, {
    input,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `gcloud ${args.slice(0, 3).join(' ')} failed. Inspect the cloud operation and recovery record before resuming.`,
    );
  return result.stdout;
}
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
function ask(question: string, fallback = ''): Promise<string> {
  return new Promise((resolve) =>
    rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `, (answer) =>
      resolve(answer.trim() || fallback),
    ),
  );
}
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const output = rl as unknown as { _writeToOutput?: (text: string) => void };
    const original = output._writeToOutput;
    process.stdout.write(`${question}: `);
    output._writeToOutput = () => {};
    rl.question('', (answer) => {
      output._writeToOutput = original;
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}
async function confirm(question: string): Promise<boolean> {
  return ['y', 'yes'].includes((await ask(`${question} (y/N)`)).toLowerCase());
}
async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new Error('Provider response is too large; inspect recovery.');
  if (!response.ok)
    throw new Error(
      `Provider returned HTTP ${response.status}; inspect recovery before repeating a change.`,
    );
  return JSON.parse(text);
}
function twilio(sid: string, token: string): PhoneApi {
  const authorization = `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
  return async <T>(url: string, form?: Record<string, string>) =>
    requestJson(url, {
      method: form ? 'POST' : 'GET',
      headers: {
        authorization,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form) : undefined,
    }) as Promise<T>;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if ([...args].some((arg) => !['--resume', '--recover-lock'].includes(arg)))
    throw new Error(
      'Use setup:phone, or setup:phone --resume [--recover-lock] after interruption.',
    );
  if (args.has('--recover-lock') && !args.has('--resume'))
    throw new Error('--recover-lock requires --resume.');
  const project = process.env.GCP_PROJECT || gcloud(['config', 'get-value', 'project']).trim();
  const region = process.env.GCP_REGION || 'us-west1';
  if (!/^[a-z0-9][a-z0-9-]{3,62}$/.test(project) || !/^[a-z][a-z0-9-]+$/.test(region))
    throw new Error('Choose a valid Google Cloud project and region.');
  const journal = new PhoneSetupJournal(
    join(
      homedir(),
      '.local',
      'state',
      'assistant',
      'phone-setup',
      `${project}-${region}`,
      'recovery.json',
    ),
  );
  const release = journal.lock(args.has('--recover-lock'));
  try {
    const existing = journal.read();
    if (existing && (existing.plan.project !== project || existing.plan.region !== region))
      throw new Error('Recovery record does not belong to this project and region.');
    if (existing?.complete) {
      console.log(
        `Phone setup was already completed for ${setupNumber(existing).phone}. No purchase or configuration changes were repeated.`,
      );
      return;
    }
    if (existing && !args.has('--resume'))
      throw new Error(
        `An interrupted setup is recorded at ${journal.path}. Use --resume to review it.`,
      );
    if (!existing && args.has('--resume')) throw new Error('There is no recorded setup to resume.');
    console.log(`\nPhone setup for ${project} (${region}). Recovery record: ${journal.path}\n`);
    const agent = describePhoneService(gcloud, 'assistant-agent', project, region);
    const web = describePhoneService(gcloud, 'assistant-web', project, region);
    if (!agent.ready || !web.ready || !agent.serviceAccount || !web.serviceAccount)
      throw new Error(
        'Both services must be ready and the agent must have a service account before setup.',
      );
    const sid =
      existing?.plan.account ??
      (await ask('Twilio Account SID', agent.env.TWILIO_ACCOUNT_SID ?? ''));
    if (!/^AC[0-9a-f]{32}$/i.test(sid)) throw new Error('That is not a Twilio Account SID.');
    const token = await askHidden('Twilio Auth Token (hidden; not stored in the recovery file)');
    if (!/^[0-9a-f]{32}$/i.test(token))
      throw new Error('Auth Token must contain 32 hexadecimal characters.');
    const api = twilio(sid, token);
    const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
    const account = await api<{ status: string; type: string }>(`${base}.json`);
    if (account.status !== 'active') throw new Error('The Twilio account must be active.');
    console.log(
      `Twilio account type: ${account.type}. Calls and messages are billed to this account.`,
    );
    let plan: PhoneSetupPlan;
    if (existing) {
      plan = existing.plan;
      console.log(
        `Resume the same ${plan.number.phone} transition. Recorded effects: ${Object.entries(
          existing.effects,
        )
          .map(([step, value]) => `${step}: ${value.status}`)
          .join(', ')}`,
      );
      if (!(await confirm('Continue this recorded transition?')))
        throw new Error('Stopped before further changes.');
    } else {
      const inputs = phoneSetupInputs({
        agentModules: agent.env.ASSISTANT_MODULES,
        webModules: web.env.ASSISTANT_MODULES,
        agentUrl: agent.env.PUBLIC_URL || agent.url,
        ownerPhone: await ask('Your mobile number (E.164)', agent.env.OWNER_PHONE ?? ''),
        webUrl: await ask('Dashboard URL', agent.env.WEB_URL || web.env.AUTH_URL || web.url),
      });
      const vertex = await confirm(
        'Enable Gemini Live voice access on this project? Voice model use incurs separate Google charges.',
      );
      const owned = await api<{
        incoming_phone_numbers: Array<
          {
            sid: string;
            phone_number: string;
            capabilities: { voice: boolean; sms: boolean };
          } & Record<string, unknown>
        >;
      }>(`${base}/IncomingPhoneNumbers.json?PageSize=50`);
      const availableOwned = owned.incoming_phone_numbers.filter(
        (number) => number.capabilities.voice && number.capabilities.sms,
      );
      let number: PhoneSetupPlan['number'];
      let purchaseApproved = false;
      availableOwned.forEach((number, index) => {
        console.log(`${index + 1}. ${number.phone_number}`);
      });
      const pick = availableOwned.length
        ? await ask('Use which number? Enter its index or "new"', '1')
        : 'new';
      if (pick !== 'new') {
        if (!/^[1-9]\d*$/.test(pick))
          throw new Error('Choose a listed index or explicitly enter "new".');
        const selected = availableOwned[Number(pick) - 1];
        if (!selected) throw new Error('That number index is not available.');
        assertPhoneNumberRouting(selected);
        number = {
          kind: 'existing',
          sid: selected.sid,
          phone: selected.phone_number,
          routingBefore: phoneRouting(selected),
        };
        console.log(
          `Existing routing to preserve in the recovery record:\n${JSON.stringify(number.routingBefore, null, 2)}`,
        );
      } else {
        const area = await ask('US area code for a new number', '415');
        if (!/^\d{3}$/.test(area)) throw new Error('Enter a three-digit US area code.');
        const choices = await api<{ available_phone_numbers: Array<{ phone_number: string }> }>(
          `${base}/AvailablePhoneNumbers/US/Local.json?AreaCode=${area}&VoiceEnabled=true&SmsEnabled=true&PageSize=5`,
        );
        const candidate = choices.available_phone_numbers[0];
        if (!candidate) throw new Error('No voice/SMS number is available in that area.');
        const pricing = await api<{
          price_unit: string;
          phone_number_prices: Array<{ number_type: string; current_price: string }>;
        }>('https://pricing.twilio.com/v1/PhoneNumbers/Countries/US');
        if (pricing.price_unit !== 'USD')
          throw new Error('A verified USD price is required before purchase.');
        const monthlyUsd = requiredPhonePrice(
          pricing.phone_number_prices.find((price) => price.number_type === 'local')?.current_price,
        );
        purchaseApproved = await confirm(
          `Buy ${candidate.phone_number} at USD ${monthlyUsd}/month, plus usage charges?`,
        );
        if (!purchaseApproved) throw new Error('Stopped before purchase.');
        number = { kind: 'purchase', phone: candidate.phone_number, monthlyUsd };
      }
      console.log(
        `Proposed routing: calls → ${inputs.agentUrl}/webhooks/twilio/voice; SMS → ${inputs.agentUrl}/webhooks/twilio/sms (POST).\nAgent modules: ${inputs.agentModules}; web modules: ${inputs.webModules}. Both services will be updated before changing routing.`,
      );
      if (!(await confirm('Approve this exact configuration and number routing transition?')))
        throw new Error('Stopped before changes.');
      plan = validatePhoneSetupPlan({
        project,
        region,
        account: sid,
        ...inputs,
        vertex,
        serviceAccount: agent.serviceAccount,
        webServiceAccount: web.serviceAccount,
        agentBefore: agent.snapshot,
        webBefore: web.snapshot,
        number,
        purchaseApproved,
        transitionApproved: true,
      });
    }
    const cloud = async (url: string, permissions: string[]) => {
      const accessToken = gcloud(['auth', 'print-access-token']).trim();
      const body = (await requestJson(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ permissions }),
      })) as { permissions?: string[] };
      return body.permissions ?? [];
    };
    const result = await runPhoneSetup(
      journal,
      plan,
      createPhoneSetupPorts({ gcloud, twilio: api, cloud, token }),
    );
    console.log(
      `\nDone. The assistant's number is ${setupNumber(result).phone}. Choose a voice model in Settings → AI providers when ready.`,
    );
  } finally {
    release();
  }
}

main()
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
