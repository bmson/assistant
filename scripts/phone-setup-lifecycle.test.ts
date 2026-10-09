import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { PhoneSetupJournal, runPhoneSetup } from './phone-setup-lifecycle.js';
import {
  type FakePhoneState,
  fakePhonePlan,
  fakePhonePorts,
  fakePhoneState,
  syntheticToken,
} from './phone-setup-test-fixture.js';

const execute = promisify(execFile);
const directories: string[] = [];
function journal() {
  const directory = mkdtempSync(join(tmpdir(), 'assistant-phone-fake-'));
  directories.push(directory);
  return new PhoneSetupJournal(join(directory, 'recovery.json'));
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('shipped phone setup lifecycle with inert cloud and Twilio transports', () => {
  it.each(['', 'minimal', 'all', 'google,calendar', undefined])(
    'preflights canonical %s modules, deploys both services before routing, and repeats no effects',
    async (modules) => {
      const state = fakePhoneState();
      const plan = fakePhonePlan(state, modules);
      const store = journal();
      const ports = fakePhonePorts(state).ports;
      const result = await runPhoneSetup(store, plan, ports);
      expect(result.complete).toBe(true);
      expect(state.mutations).toEqual(['secret', 'secretAccess', 'agent', 'web', 'routing']);
      expect(state.number?.voice_fallback_url).toBe('https://existing.example/fallback');
      expect(state.number?.status_callback).toBe('https://existing.example/status');
      expect(store.read()?.plan.number).toEqual(plan.number);
      const first = JSON.stringify(state);
      await runPhoneSetup(store, plan, ports);
      expect(JSON.stringify(state)).toBe(first);
      expect(readFileSync(store.path, 'utf8')).not.toContain(syntheticToken);
      expect(statSync(store.path).mode & 0o777).toBe(0o600);
    },
  );

  it.each(['run.services.update', 'secretmanager.secrets.create', 'iam.serviceAccounts.actAs'])(
    'refuses missing %s permissions before the first effect',
    async (permission) => {
      const state = fakePhoneState(true);
      state.missingPermission = permission;
      await expect(
        runPhoneSetup(journal(), fakePhonePlan(state), fakePhonePorts(state).ports),
      ).rejects.toThrow('permission');
      expect(state.mutations).toEqual([]);
      expect(state.number).toBeNull();
    },
  );
  it('refuses unavailable price and unapproved purchase before secret creation or purchase', async () => {
    const state = fakePhoneState(true);
    const plan = fakePhonePlan(state);
    state.monthly = '';
    await expect(runPhoneSetup(journal(), plan, fakePhonePorts(state).ports)).rejects.toThrow(
      'price',
    );
    expect(state.mutations).toEqual([]);
    await expect(
      runPhoneSetup(journal(), { ...plan, purchaseApproved: false }, fakePhonePorts(state).ports),
    ).rejects.toThrow('separate approval');
  });
  it('refuses established application routing and routing drift before first mutation', async () => {
    const state = fakePhoneState();
    const plan = fakePhonePlan(state);
    if (!state.number) throw new Error('Missing number');
    state.number.voice_url = 'https://independent.example/new-route';
    await expect(runPhoneSetup(journal(), plan, fakePhonePorts(state).ports)).rejects.toThrow(
      'routing changed',
    );
    expect(state.mutations).toEqual([]);
    state.number.voice_application_sid = 'AP000';
    await expect(runPhoneSetup(journal(), plan, fakePhonePorts(state).ports)).rejects.toThrow(
      'TwiML',
    );
    expect(state.mutations).toEqual([]);
  });
  it.each([
    ['agent', false],
    ['agent', true],
    ['web', false],
    ['web', true],
  ] as const)(
    'keeps prior routing after a failed %s deployment (purchase=%s); does not repeat ambiguous updates',
    async (step, purchase) => {
      const state = fakePhoneState(purchase);
      const plan = fakePhonePlan(state);
      const store = journal();
      await expect(
        runPhoneSetup(store, plan, fakePhonePorts(state, { failBefore: step }).ports),
      ).rejects.toThrow(`before ${step}`);
      expect(state.number?.voice_url).toBe('https://existing.example/calls');
      expect(state.mutations.filter((value) => value === 'number')).toHaveLength(purchase ? 1 : 0);
      const before = [...state.mutations];
      await expect(runPhoneSetup(store, plan, fakePhonePorts(state).ports)).rejects.toThrow(
        `${step} change has unknown acceptance`,
      );
      expect(state.mutations).toEqual(before);
      expect(store.read()?.effects[step]?.status).toBe('intent');
    },
  );
  it.each(['secret', 'secretAccess', 'number', 'agent', 'web', 'routing'] as const)(
    'reconciles accepted %s after lost receipt without repeating it',
    async (step) => {
      const state = fakePhoneState(true);
      const plan = fakePhonePlan(state);
      const store = journal();
      await expect(
        runPhoneSetup(store, plan, fakePhonePorts(state, { failAfter: step }).ports),
      ).rejects.toThrow(`after ${step}`);
      expect(store.read()?.effects[step]?.status).toBe('intent');
      expect((await runPhoneSetup(store, plan, fakePhonePorts(state).ports)).complete).toBe(true);
      expect(state.mutations.filter((value) => value === step)).toHaveLength(1);
      expect(state.mutations.filter((value) => value === 'number')).toHaveLength(1);
    },
  );
  it('holds a purchase with unknown acceptance rather than making a duplicate purchase', async () => {
    const state = fakePhoneState(true);
    const plan = fakePhonePlan(state);
    const store = journal();
    await expect(
      runPhoneSetup(store, plan, fakePhonePorts(state, { failBefore: 'number' }).ports),
    ).rejects.toThrow('before number');
    await expect(runPhoneSetup(store, plan, fakePhonePorts(state).ports)).rejects.toThrow(
      'number change has unknown acceptance',
    );
    expect(state.number).toBeNull();
    expect(state.mutations).toEqual(['secret', 'secretAccess']);
  });
  it('rejects competing processes, plan replacement and nonprivate journals', async () => {
    const state = fakePhoneState();
    const plan = fakePhonePlan(state);
    const store = journal();
    const release = store.lock();
    try {
      expect(() => store.lock()).toThrow('existing lock');
      expect(() => store.lock(true)).toThrow('still running');
    } finally {
      release();
    }
    await runPhoneSetup(store, plan, fakePhonePorts(state).ports);
    await expect(
      runPhoneSetup(store, { ...plan, ownerPhone: '+14155550000' }, fakePhonePorts(state).ports),
    ).rejects.toThrow('different transition');
    chmodSync(store.path, 0o644);
    expect(() => store.read()).toThrow('nonprivate');
  });
  it('SIGKILLs an accepted purchase and resumes in a fresh process with one purchase and unchanged prior routing until deployments', async () => {
    const state = fakePhoneState(true);
    const plan = fakePhonePlan(state);
    const store = journal();
    store.write({
      format: 'assistant-phone-setup',
      version: 1,
      id: '11111111-1111-4111-8111-111111111111',
      plan,
      effects: {},
      complete: false,
    });
    const statePath = join(directories.at(-1) ?? '', 'fake-provider-state.json');
    writeFileSync(statePath, JSON.stringify(state));
    const worker = fileURLToPath(
      new URL('./phone-setup-crash-worker.test-fixture.ts', import.meta.url),
    );
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', worker, store.path, statePath, 'crash'],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    let output = '';
    child.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });
    try {
      const accepted = await Promise.race([
        once(child, 'message').then(([message]) => message),
        once(child, 'exit').then(() => {
          throw new Error(`Worker exited: ${output}`);
        }),
      ]);
      expect(accepted).toBe('purchase-accepted');
      expect(store.read()?.effects.number?.status).toBe('intent');
      expect(() => store.lock(true)).toThrow('still running');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const killedState = JSON.parse(readFileSync(statePath, 'utf8')) as FakePhoneState;
      expect(killedState.number?.voice_url).toBe('https://existing.example/calls');
      const resumed = await execute(
        process.execPath,
        ['--import', 'tsx', worker, store.path, statePath, 'resume'],
        { timeout: 15000 },
      );
      expect(resumed.stdout).toContain('complete');
      const first = JSON.parse(readFileSync(statePath, 'utf8')) as FakePhoneState;
      expect(first.mutations).toEqual([
        'secret',
        'secretAccess',
        'number',
        'agent',
        'web',
        'routing',
      ]);
      await execute(
        process.execPath,
        ['--import', 'tsx', worker, store.path, statePath, 'resume'],
        { timeout: 15000 },
      );
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(first);
      expect(store.read()?.complete).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  }, 20000);
});
