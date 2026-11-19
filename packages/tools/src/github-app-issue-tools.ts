import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  type createGitHubAppIssueCreator,
  GitHubAppIssueCreateError,
  GitHubIssueCreateInputSchema,
} from './github-app-issue-creator.js';
import type { GitHubAppSelection } from './github-app-tools.js';
import { register } from './register.js';
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';

const NAME = 'github.create_issue';
const BINDING = '_approvalGitHubIssueScope';
const schema = GitHubIssueCreateInputSchema.strip().extend({
  repositoryId: z.number().int().positive().optional(),
  body: GitHubIssueCreateInputSchema.shape.body.max(8_000),
});
type Args = z.infer<typeof schema>;

interface Dependencies {
  enabled(): boolean;
  resolveOwner(): Promise<string | undefined>;
  selection(): GitHubAppSelection | null;
  loadCreator(): Promise<{
    selection: GitHubAppSelection;
    creator: ReturnType<typeof createGitHubAppIssueCreator>;
  } | null>;
}

function target(selection: GitHubAppSelection | null, requested?: number) {
  if (!selection) throw new Error('GitHub issue creation is unavailable.');
  const ids = [...new Set(selection.selectedRepositoryIds)];
  const repositoryId = requested ?? (ids.length === 1 ? ids[0] : undefined);
  if (repositoryId === undefined) throw new Error('Choose one selected GitHub repository first.');
  if (!ids.includes(repositoryId)) throw new Error('This GitHub repository is not selected.');
  return { selection, repositoryId };
}
function digest(args: Args, owner: string, selection: GitHubAppSelection) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        owner,
        selection.appClientId,
        selection.installationId,
        args.repositoryId,
        args.repositoryFullName,
        args.title,
        args.body,
      ]),
    )
    .digest('hex');
}
function unknownResult() {
  return {
    deliveryStatus: 'unknown',
    retrySuppressed: true,
    note: 'GitHub may have created this issue. Check the repository before making another request.',
  };
}

/** Optional outward write: exact owner approval, never a standing/autonomy grant. */
export function registerGitHubAppIssueTools(registry: ToolRegistry, deps: Dependencies) {
  if (!deps.enabled()) return registry;
  async function assertOwner(ctx: ToolContext) {
    if (!deps.enabled()) throw new Error('GitHub issue creation is disabled.');
    if (
      ctx.trust !== 'owner' ||
      ctx.signal.aborted ||
      (await deps.resolveOwner()) !== ctx.agentId ||
      ctx.signal.aborted ||
      !deps.enabled()
    )
      throw new Error('GitHub issue creation requires the configured owner.');
  }
  function assertApproved(args: Args, ctx: ToolContext, selection: GitHubAppSelection | null) {
    if (args.repositoryId === undefined)
      throw new Error('GitHub issue approval must identify a specific repository.');
    const current = target(selection, args.repositoryId);
    if (
      (args as Args & { [BINDING]?: string })[BINDING] !==
      digest(args, ctx.agentId, current.selection)
    )
      throw new Error('GitHub issue scope or content changed. Request fresh approval.');
    return current.repositoryId;
  }
  register(
    registry,
    {
      name: NAME,
      description:
        'Create one issue on a selected GitHub repository only after fresh owner approval of its repository ID, owner/repository name, exact title and exact body. First obtain the repository name via the approved GitHub metadata read if unknown. Body review is limited to 8,000 characters. Never automatically retry an uncertain outcome.',
      inputSchema: schema,
      risk: 'approval',
      acceptsUntrustedInput: false,
      approvalBindingArgument: BINDING,
      prepareSecurity: async (args, ctx, phase) => {
        await assertOwner(ctx);
        if (phase === 'approved') {
          assertApproved(args, ctx, deps.selection());
          return args;
        }
        const selected = target(deps.selection(), args.repositoryId);
        const bound = { ...args, repositoryId: selected.repositoryId };
        return { ...bound, [BINDING]: digest(bound, ctx.agentId, selected.selection) };
      },
      approvalSummary: (args) =>
        `Create GitHub issue in ${args.repositoryFullName} (repository ID ${args.repositoryId}).\nTitle: ${args.title}\nBody:\n${args.body}`,
      execute: async (args, ctx) => {
        if (ctx.execution?.toolName !== NAME || !ctx.execution.dbToolCallId)
          throw new Error('GitHub issue creation requires explicit approval.');
        await assertOwner(ctx);
        const repoId = assertApproved(args, ctx, deps.selection());
        const loaded = await deps.loadCreator();
        if (!loaded) throw new Error('GitHub issue creation is unavailable.');
        assertApproved(args, ctx, loaded.selection);
        const preflight = async () => {
          await assertOwner(ctx);
          assertApproved(args, ctx, deps.selection());
          assertApproved(args, ctx, loaded.selection);
        };
        await preflight();
        let result: Awaited<ReturnType<typeof loaded.creator.createIssue>>;
        try {
          result = await loaded.creator.createIssue(
            repoId,
            Object.freeze({
              repositoryFullName: args.repositoryFullName,
              title: args.title,
              body: args.body,
            }),
            ctx.signal,
            preflight,
          );
        } catch (error) {
          if (error instanceof GitHubAppIssueCreateError && error.effectStatus === 'unknown')
            return unknownResult();
          throw error;
        }
        // A completed provider write is never repeated when its result cannot be
        // released to a changed owner/scope or a now-disabled runtime.
        try {
          await preflight();
        } catch {
          return unknownResult();
        }
        return result;
      },
    },
    {
      ownerOnly: true,
      outwardFacing: true,
      networkEgress: true,
      returnsUntrustedContent: true,
      blanketAllowIneligible: true,
      autonomyFloor: true,
    },
  );
  return registry;
}
