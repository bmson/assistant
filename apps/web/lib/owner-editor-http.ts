import {
  OWNER_EDITOR_BODY_TIMEOUT_MS,
  OWNER_EDITOR_MAX_BODY_BYTES,
  ownerEditorApplyMatchesScope,
  ownerEditorPath,
  parseOwnerEditorRequest,
} from '@assistant/application/owner-editor-wire';
import { ownerEditorRetired, ownerEditorUnknown } from '@assistant/persistence';
import type {
  OwnerEditorApply,
  OwnerEditorOperationRepository,
  OwnerEditorReply,
  OwnerEditorScope,
  OwnerEditorSessionView,
} from '@assistant/persistence/owner-editor';
import { isValidFormSessionScope } from '../app/auth-form-session-scope';
import { readBoundedJson } from './bounded-json';
import { isBasicOwnerEditorCommand } from './owner-editor-release-policy';
import {
  issueOwnerEditorReceiptProof,
  verifyOwnerEditorHandle,
  verifyOwnerEditorReceiptProof,
} from './owner-editor-scope';

export interface OwnerEditorHttpBackend {
  operations: OwnerEditorOperationRepository;
  apply(request: OwnerEditorApply, scope: OwnerEditorScope): Promise<OwnerEditorReply>;
}
export interface OwnerEditorHttpPorts {
  authenticate(): Promise<Pick<OwnerEditorSessionView, 'formSessionScope'> | null>;
  /** Called only after authentication/origin/session-header checks. */
  resolveOwnerId(): Promise<string>;
  origin: string;
  secret: string;
  withBackend(
    scope: OwnerEditorScope,
    run: (backend: OwnerEditorHttpBackend) => Promise<OwnerEditorReply>,
  ): Promise<OwnerEditorReply>;
  now?: () => number;
}
function json(reply: OwnerEditorReply, status?: number): Response {
  const code =
    status ??
    (reply.authority === 'unresolved'
      ? 202
      : reply.authority === 'scope_retirement'
        ? 409
        : reply.outcome === 'conflict'
          ? 409
          : reply.outcome === 'invalid'
            ? 422
            : reply.outcome === 'unavailable'
              ? 503
              : 200);
  return Response.json(reply, { status: code, headers: { 'cache-control': 'no-store' } });
}
function rejection(
  reason: string,
  status: number,
  scope?: OwnerEditorScope,
  fieldErrors?: Record<string, string>,
): Response {
  return json(
    {
      version: 1,
      authority: 'request_rejection',
      outcome: 'invalid',
      originalOperationTerminal: false,
      command: scope?.command ?? null,
      operationId: scope?.operationId ?? null,
      reason,
      ...(fieldErrors ? { fieldErrors } : {}),
    },
    status,
  );
}

/** Exact adapters share guards, but there is no arbitrary action dispatch. */
export function createOwnerEditorHttpHandlers(
  path: '/api/people/editor' | '/api/profile/knowledge/family' | '/api/profile/knowledge/memory',
  ports: OwnerEditorHttpPorts,
) {
  const now = ports.now ?? Date.now;
  async function guarded(request: Request, write: boolean): Promise<Response | OwnerEditorScope> {
    if (request.method !== (write ? 'POST' : 'GET')) return rejection('method_not_allowed', 405);
    const url = new URL(request.url);
    if (url.pathname !== path) return rejection('route_not_found', 404);
    let authenticated: Awaited<ReturnType<OwnerEditorHttpPorts['authenticate']>>;
    try {
      authenticated = await ports.authenticate();
    } catch {
      authenticated = null;
    }
    if (!authenticated) return rejection('owner_required', 401);
    if (write) {
      let origin: string;
      try {
        origin = new URL(ports.origin).origin;
      } catch {
        return rejection('editor_unavailable', 503);
      }
      if (
        !['http:', 'https:'].includes(new URL(origin).protocol) ||
        request.headers.get('origin') !== origin
      )
        return rejection('origin_mismatch', 403);
    }
    if (
      !isValidFormSessionScope(authenticated.formSessionScope) ||
      request.headers.get('x-editor-session-scope') !== authenticated.formSessionScope
    )
      return rejection('session_mismatch', 403);
    if (!ports.secret) return rejection('editor_unavailable', 503);
    const token = request.headers.get('x-editor-form-scope');
    if (!token) return rejection('form_scope_required', 403);
    let ownerId: string;
    try {
      ownerId = await ports.resolveOwnerId();
    } catch {
      return rejection('editor_unavailable', 503);
    }
    const checked = verifyOwnerEditorHandle({
      token,
      session: { ownerId, formSessionScope: authenticated.formSessionScope },
      secret: ports.secret,
      now: now(),
    });
    if (checked.kind === 'invalid') return rejection('invalid_form_scope', 403);
    if (checked.kind === 'retired') return json(ownerEditorRetired(checked.scope));
    if (!isBasicOwnerEditorCommand(checked.scope.command))
      return rejection('command_unavailable', 403, checked.scope);
    if (ownerEditorPath(checked.scope.command) !== path)
      return rejection('issuance_mismatch', 409, checked.scope);
    if (
      !write &&
      (url.searchParams.getAll('operation').length !== 1 ||
        [...url.searchParams.keys()].some((key) => key !== 'operation') ||
        url.searchParams.get('operation') !== token)
    )
      return rejection('invalid_receipt_lookup', 400, checked.scope);
    if (write && url.search) return rejection('unexpected_query', 400, checked.scope);
    return checked.scope;
  }
  return {
    async GET(request: Request): Promise<Response> {
      const scope = await guarded(request, false);
      if (scope instanceof Response) return scope;
      try {
        return json(
          await ports.withBackend(scope, async ({ operations }) => {
            const lookup = await operations.lookup(scope, new Date(now()));
            if (lookup.reply.authority === 'unresolved' && lookup.operation?.status === 'preparing')
              return {
                ...lookup.reply,
                receiptBindingToken: issueOwnerEditorReceiptProof({
                  operation: lookup.operation,
                  scope,
                  secret: ports.secret,
                  now: now(),
                }),
              };
            return lookup.reply;
          }),
        );
      } catch {
        return json(ownerEditorUnknown(scope));
      }
    },
    async POST(request: Request): Promise<Response> {
      const scope = await guarded(request, true);
      if (scope instanceof Response) return scope;
      if (
        request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/json'
      )
        return rejection('json_required', 415, scope);
      const body = await readBoundedJson(
        request,
        OWNER_EDITOR_MAX_BODY_BYTES,
        OWNER_EDITOR_BODY_TIMEOUT_MS,
      );
      if (!body.ok)
        return rejection('invalid_json_body', body.status, scope, { request: body.error });
      const parsed = parseOwnerEditorRequest(body.value, path);
      if (!parsed.ok) return rejection('invalid_command', 422, scope, parsed.fieldErrors);
      const command = parsed.request;
      if (!isBasicOwnerEditorCommand(command.command))
        return rejection('command_unavailable', 403, scope);
      if (command.operationId !== scope.operationId || command.command !== scope.command)
        return rejection('issuance_mismatch', 409, scope);
      if (command.intent === 'apply' && !ownerEditorApplyMatchesScope(command, scope))
        return rejection('issuance_mismatch', 409, scope);
      if (command.intent === 'apply' && now() >= scope.expiresAt)
        return rejection('form_expired', 409, scope);
      try {
        return json(
          await ports.withBackend(scope, async (backend) => {
            if (command.intent === 'apply') return backend.apply(command, scope);
            const proof = verifyOwnerEditorReceiptProof({
              token: command.receiptBindingToken,
              scope,
              secret: ports.secret,
              now: now(),
            });
            return proof
              ? backend.operations.reconcile(proof, new Date(now()))
              : ownerEditorUnknown(scope, 'proof_changed');
          }),
        );
      } catch {
        return json(ownerEditorUnknown(scope));
      }
    },
  };
}
