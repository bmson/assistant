import { readFileSync, writeFileSync } from 'node:fs';
import { PhoneSetupJournal, runPhoneSetup } from './phone-setup-lifecycle.js';
import { type FakePhoneState, fakePhonePorts } from './phone-setup-test-fixture.js';

const [journalPath, statePath, mode] = process.argv.slice(2);
if (!journalPath || !statePath) throw new Error('Missing inert fixture paths');
const state = JSON.parse(readFileSync(statePath, 'utf8')) as FakePhoneState;
const journal = new PhoneSetupJournal(journalPath);
const record = journal.read();
if (!record) throw new Error('Missing precreated synthetic plan');
const release = journal.lock(mode === 'resume');
try {
  const { ports } = fakePhonePorts(
    state,
    mode === 'crash'
      ? {
          afterMutation: async () => {
            writeFileSync(statePath, JSON.stringify(state));
            process.send?.('purchase-accepted');
            await new Promise(() => {});
          },
        }
      : {},
  );
  await runPhoneSetup(journal, record.plan, ports);
  writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write('complete\n');
} finally {
  release();
}
