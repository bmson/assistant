import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { createGitHubAppReader } from './github-app-reader.js';
import { register } from './register.js';
import type { ToolRegistry } from './registry.js';
import type { ToolContext, ToolFlags } from './types.js';

export interface GitHubAppSelection {
  appClientId: string;
  installationId: number;
  selectedRepositoryIds: readonly number[];
}

interface GitHubAppToolDependencies {
  resolveOwner(): Promise<string | undefined>;
  selection(): GitHubAppSelection | null;
  loadReader(): Promise<{
    selection: GitHubAppSelection;
    reader: ReturnType<typeof createGitHubAppReader>;
  } | null>;
}

const bindingArgument = '_approvalGitHubScope';
const id = z.number().int().positive();
const repositoryId = id
  .optional()
  .describe('Selected repository ID. Omit if exactly one repository is selected.');

const ownerOnly = {
  confidentialRead: true,
  ownerOnly: true,
} as const;
const remoteRead = {
  ...ownerOnly,
  networkEgress: true,
  returnsUntrustedContent: true,
  blanketAllowIneligible: true,
  autonomyFloor: true,
} satisfies ToolFlags;

type ReadArgs = { repositoryId?: number; pullRequestNumber?: number };

function requireSelection(selection: GitHubAppSelection | null, requested?: number) {
  if (!selection) throw new Error('GitHub read access is unavailable.');
  const ids = [...new Set(selection.selectedRepositoryIds)];
  const selected = requested ?? (ids.length === 1 ? ids[0] : undefined);
  if (selected === undefined) throw new Error('Choose one selected GitHub repository first.');
  if (!ids.includes(selected)) throw new Error('This GitHub repository is not selected.');
  return { selection, repositoryId: selected };
}

function fingerprint(selection: GitHubAppSelection, ownerId: string, repoId: number, pr?: number) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        ownerId,
        selection.appClientId,
        selection.installationId,
        repoId,
        pr ?? null,
      ]),
    )
    .digest('hex');
}

export function registerGitHubAppTools(registry: ToolRegistry, deps: GitHubAppToolDependencies) {
  async function assertOwner(ctx: ToolContext) {
    if (ctx.trust !== 'owner' || ctx.signal.aborted)
      throw new Error('GitHub reads require the configured owner.');
    if ((await deps.resolveOwner()) !== ctx.agentId || ctx.signal.aborted)
      throw new Error('GitHub reads require the configured owner.');
  }

  function assertApproved(args: ReadArgs, ctx: ToolContext, selection: GitHubAppSelection | null) {
    if (args.repositoryId === undefined)
      throw new Error('GitHub approval must identify a specific repository.');
    const target = requireSelection(selection, args.repositoryId);
    const original = (args as ReadArgs & { [bindingArgument]?: string })[bindingArgument];
    if (
      original !==
      fingerprint(target.selection, ctx.agentId, target.repositoryId, args.pullRequestNumber)
    )
      throw new Error('GitHub read scope changed. Request fresh approval.');
    return target.repositoryId;
  }

  async function prepareSecurity<T extends ReadArgs>(
    args: T,
    ctx: ToolContext,
    phase: 'dispatch' | 'approved',
  ): Promise<T> {
    await assertOwner(ctx);
    if (phase === 'approved') {
      assertApproved(args, ctx, deps.selection());
      return args;
    }
    const target = requireSelection(deps.selection(), args.repositoryId);
    return {
      ...args,
      repositoryId: target.repositoryId,
      [bindingArgument]: fingerprint(
        target.selection,
        ctx.agentId,
        target.repositoryId,
        args.pullRequestNumber,
      ),
    };
  }

  async function executeRead<T>(
    args: ReadArgs,
    ctx: ToolContext,
    toolName: string,
    read: (reader: ReturnType<typeof createGitHubAppReader>, repoId: number) => Promise<T>,
  ) {
    if (ctx.execution?.toolName !== toolName)
      throw new Error('GitHub reads require explicit approval.');
    await assertOwner(ctx);
    const repoId = assertApproved(args, ctx, deps.selection());
    const loaded = await deps.loadReader();
    if (!loaded) throw new Error('GitHub read access is unavailable.');
    assertApproved(args, ctx, loaded.selection);
    // Loading a local key file is asynchronous. Recheck current owner and scope
    // before sending GitHub any request, and again before releasing its result.
    await assertOwner(ctx);
    assertApproved(args, ctx, deps.selection());
    const result = await read(loaded.reader, repoId);
    await assertOwner(ctx);
    assertApproved(args, ctx, deps.selection());
    return result;
  }

  register(
    registry,
    {
      name: 'github.list_selected_repositories',
      description:
        'List locally selected GitHub repository IDs. Does not contact GitHub or disclose repository names. If more than one is selected and the owner has not identified one by ID, ask which repository they intend.',
      inputSchema: z.object({}),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (_args, ctx) => {
        await assertOwner(ctx);
        return { repositoryIds: [...new Set(deps.selection()?.selectedRepositoryIds ?? [])] };
      },
    },
    { ...ownerOnly, ownerVisibleOnly: true },
  );

  const repoName = 'github.get_repository';
  register(
    registry,
    {
      name: repoName,
      description:
        'Request owner approval to read a selected GitHub repository summary. You may omit repositoryId when only one repository is selected. Use github.list_selected_repositories to find the local IDs when needed.',
      inputSchema: z.object({ repositoryId }),
      risk: 'approval',
      acceptsUntrustedInput: false,
      approvalBindingArgument: bindingArgument,
      prepareSecurity,
      approvalSummary: (args) =>
        `Read GitHub repository metadata (repository ID ${args.repositoryId}).`,
      execute: (args, ctx) =>
        executeRead(args, ctx, repoName, (reader, repoId) =>
          reader.getRepository(repoId, ctx.signal),
        ),
    },
    remoteRead,
  );

  const prName = 'github.get_pull_request';
  register(
    registry,
    {
      name: prName,
      description:
        'Request owner approval to read a pull request status from a selected GitHub repository. You may omit repositoryId when only one repository is selected. Use github.list_selected_repositories to find the local IDs when needed.',
      inputSchema: z.object({ repositoryId, pullRequestNumber: id }),
      risk: 'approval',
      acceptsUntrustedInput: false,
      approvalBindingArgument: bindingArgument,
      prepareSecurity,
      approvalSummary: (args) =>
        `Read GitHub pull request #${args.pullRequestNumber} (repository ID ${args.repositoryId}).`,
      execute: (args, ctx) =>
        executeRead(args, ctx, prName, (reader, repoId) =>
          reader.getPullRequest(repoId, args.pullRequestNumber, ctx.signal),
        ),
    },
    remoteRead,
  );
  return registry;
}
