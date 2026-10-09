import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractOwnerIntent } from '@assistant/core/workflow/owner-intent';
import {
  FirestoreApprovalPolicyRepository,
  FirestoreApprovalRepository,
  FirestoreCostRepository,
  FirestoreToolExecutionRepository,
} from '@assistant/firestore';
import type { ToolContext } from '@assistant/tools';
import {
  registerPortableWebWorkspaceTools,
  ToolDispatcher,
  ToolRegistry,
  type WebFetchIo,
} from '@assistant/tools';
import { LocalWorkspaceStore } from '@assistant/tools/workspace';
import { describe, expect, it } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

function htmlBody(value: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield new TextEncoder().encode(value);
  })();
}

describe('Firestore portable web and workspace tool composition', () => {
  describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('with PostgreSQL unavailable', () => {
    it('executes web and workspace tools through Firestore persistence with preserved gates', async () => {
      const store = emulatorStore();
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'assistant-firestore-workspace-'));
      const workspace = new LocalWorkspaceStore(workspaceRoot);
      const agentId = randomUUID();
      const taskId = randomUUID();
      let webFetchRequests = 0;
      try {
        await store.doc('agents', agentId).set({ id: agentId });
        await store.doc('tasks', taskId).set({
          id: taskId,
          agentId,
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
        });

        const db = new Proxy({} as ToolContext['db'], {
          get(_target, property) {
            throw new Error(`Unexpected PostgreSQL access: ${String(property)}`);
          },
        });
        const webFetchIo: WebFetchIo = {
          resolve: async () => [{ address: '93.184.216.34', family: 4 }],
          get: async (url) => {
            webFetchRequests += 1;
            return {
              status: 200,
              headers: { contentType: 'text/html', contentEncoding: '' },
              body: htmlBody(`<html><body>Page at ${url.hostname}</body></html>`),
              cancel: () => {},
            };
          },
        };
        const registry = registerPortableWebWorkspaceTools(new ToolRegistry(), {
          workspace,
          webFetchIo,
        });
        expect(registry.get('web.fetch')?.flags).toMatchObject({
          networkEgress: true,
          returnsUntrustedContent: true,
          blanketAllowIneligible: true,
        });
        expect(registry.get('workspace.write')?.flags).toMatchObject({ writesWorkspace: true });
        expect(registry.get('workspace.read')?.flags).toMatchObject({
          confidentialRead: true,
          returnsUntrustedContent: true,
        });
        expect(registry.get('workspace.list')?.flags).toMatchObject({
          confidentialRead: true,
          returnsUntrustedContent: true,
        });

        const approvals = new FirestoreApprovalRepository(store);
        const dispatcher = new ToolDispatcher(
          db,
          registry,
          new FirestoreToolExecutionRepository(store),
          new FirestoreCostRepository(store),
          approvals,
          new FirestoreApprovalPolicyRepository(store),
        );
        const task = {
          id: taskId,
          agentId,
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
          createdAt: new Date(),
          trigger: null,
          conversationId: null,
          goalId: null,
        } as never;
        const ctx = {
          taskId,
          agentId,
          trust: 'owner',
          tainted: false,
          db,
          now: () => new Date(),
          signal: new AbortController().signal,
          log: async () => {},
        } as ToolContext;
        let step = 0;
        const dispatch = (toolName: string, args: Record<string, unknown>, context = ctx) =>
          dispatcher.dispatch({
            task,
            step: ++step,
            toolName,
            args,
            ctx: context,
            provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
          });

        await expect(
          dispatch('workspace.write', { path: 'notes/plan.txt', content: 'Keep the source.' }),
        ).resolves.toMatchObject({ kind: 'executed', result: { written: 'notes/plan.txt' } });
        await expect(dispatch('workspace.read', { path: 'notes/plan.txt' })).resolves.toMatchObject(
          {
            kind: 'executed',
            result: { path: 'notes/plan.txt', content: 'Keep the source.' },
          },
        );
        await expect(dispatch('workspace.list', { path: 'notes' })).resolves.toMatchObject({
          kind: 'executed',
          result: { entries: [{ name: 'plan.txt', dir: false }] },
        });
        await expect(
          dispatch('web.fetch', { url: 'https://example.com/article' }),
        ).resolves.toMatchObject({
          kind: 'executed',
          result: { status: 200, text: 'Page at example.com' },
        });

        // Same taint policy as the PostgreSQL dispatcher: private workspace writes
        // stay autonomous, while network egress needs exact-argument approval.
        const taintedContext = {
          ...ctx,
          tainted: true,
          ownerIntent: extractOwnerIntent({
            trust: 'owner',
            text: 'Write this source to my workspace file and read the public article.',
          }),
        } as ToolContext;
        await expect(
          dispatch(
            'workspace.write',
            { path: 'notes/tainted.txt', content: 'Untrusted content.' },
            taintedContext,
          ),
        ).resolves.toMatchObject({ kind: 'executed', result: { written: 'notes/tainted.txt' } });

        const gatedFetch = await dispatch(
          'web.fetch',
          { url: 'https://example.com/tainted' },
          taintedContext,
        );
        expect(gatedFetch.kind).toBe('awaiting_approval');
        expect(webFetchRequests).toBe(1);
        if (gatedFetch.kind !== 'awaiting_approval')
          throw new Error('Tainted web egress was not approval gated');
        expect(
          await approvals.resolve({
            approvalId: gatedFetch.approvalId,
            decision: 'approved',
            via: 'web',
            deferNotification: true,
          }),
        ).toMatchObject({ ok: true });
        await expect(
          dispatcher.executeApproved(gatedFetch.toolCallId, taintedContext),
        ).resolves.toMatchObject({ kind: 'executed' });
        expect(webFetchRequests).toBe(2);
      } finally {
        await disposeStore(store);
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    }, 30_000);
  });
});
