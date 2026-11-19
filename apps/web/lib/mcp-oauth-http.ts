import { loadConfig } from '@assistant/config';
import { isAuthed } from '@/auth';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import {
  authenticateMobileBearer,
  mobileJson,
  mobileUnauthorized,
  resolveAuthenticatedInstallationOwner,
} from '@/mobile-auth';
import {
  type McpOAuthManagementService,
  mcpOAuthIdPattern,
  mcpOAuthNativeReturn,
  mcpOAuthWebReturn,
} from './mcp-oauth-wire';

type Context = { params: Promise<{ id: string }> };

const unavailable = () => mobileJson({ error: 'Tool sign-in is unavailable.' }, { status: 503 });
const notFound = () =>
  mobileJson({ error: 'Connection or sign-in attempt not found.' }, { status: 404 });
const invalid = () => mobileJson({ error: 'Invalid tool sign-in request.' }, { status: 400 });

async function authenticate(request: Request) {
  if (request.headers.has('authorization')) {
    if (!(await authenticateMobileBearer(request)))
      return { response: mobileUnauthorized() } as const;
  } else {
    if (request.method !== 'GET') {
      let origin: URL;
      try {
        origin = new URL(loadConfig().AUTH_URL);
        if (origin.protocol !== 'https:' || origin.username || origin.password) {
          return { response: unavailable() } as const;
        }
      } catch {
        return { response: unavailable() } as const;
      }
      if (request.headers.get('origin') !== origin.origin) {
        return {
          response: mobileJson({ error: 'Invalid request origin.' }, { status: 403 }),
        } as const;
      }
    }
    if (!(await isAuthed())) return { response: mobileUnauthorized() } as const;
  }
  const owner = await resolveAuthenticatedInstallationOwner();
  return owner.ok ? ({ ownerId: owner.ownerId } as const) : ({ response: unavailable() } as const);
}

export function mcpOAuthManagement(getService: () => McpOAuthManagementService | null) {
  async function handle(request: Request, context: Context, flowRoute: boolean): Promise<Response> {
    const method = request.method;
    if (!(flowRoute ? ['GET', 'DELETE'] : ['GET', 'POST', 'DELETE']).includes(method)) {
      return new Response(null, { status: 405, headers: { 'cache-control': 'no-store' } });
    }
    try {
      const auth = await authenticate(request);
      if (auth.response) return auth.response;
      const { id } = await context.params;
      if (!mcpOAuthIdPattern.test(id)) return invalid();
      const query = new URL(request.url).searchParams;
      const flowId = flowRoute ? query.get('flowId') : null;
      const verify =
        !flowRoute && method === 'GET' && query.size === 1 && query.get('verify') === 'provider';
      if (
        flowRoute
          ? query.size !== 1 || !flowId || !mcpOAuthIdPattern.test(flowId)
          : query.size !== 0 && !verify
      ) {
        return invalid();
      }
      if (method === 'POST') {
        const body = await readMobileMutationBody(request, []);
        if (!body.ok) return body.response;
      }
      const service = getService();
      if (!service) return unavailable();
      const result = flowId
        ? await service.flow(auth.ownerId, id, flowId, method === 'DELETE')
        : method === 'GET'
          ? await (verify
              ? service.verifyProvider(auth.ownerId, id)
              : service.status(auth.ownerId, id))
          : method === 'POST'
            ? await service.start(
                auth.ownerId,
                id,
                request.headers.has('authorization') ? 'ios' : 'web',
              )
            : await service.disconnect(auth.ownerId, id);
      return result ? mobileJson(result) : notFound();
    } catch {
      return unavailable();
    }
  }
  return {
    connection: (request: Request, context: Context) => handle(request, context, false),
    flow: (request: Request, context: Context) => handle(request, context, true),
  };
}

const callbackHeaders = {
  'Cache-Control': 'no-store',
  'Content-Type': 'text/plain; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
};

export function mcpOAuthCallback(getService: () => McpOAuthManagementService | null) {
  return async (request: Request): Promise<Response> => {
    const reply = (status: number) =>
      new Response('Return to Assistant to check your tool sign-in status.', {
        status,
        headers: callbackHeaders,
      });
    if (request.method !== 'GET') return reply(405);
    if (request.url.length > 16_384) return reply(400);
    const params = new URL(request.url).searchParams;
    const states = params.getAll('state');
    const codes = params.getAll('code');
    const errors = params.getAll('error');
    if (
      states.length !== 1 ||
      !states[0] ||
      codes.length + errors.length !== 1 ||
      !(codes[0] || errors[0]) ||
      params.getAll('iss').length > 1
    ) {
      return reply(400);
    }
    try {
      const service = getService();
      if (!service) return reply(503);
      const result = await service.callback(params);
      if (
        !result ||
        !['web', 'ios'].includes(result.client) ||
        !mcpOAuthIdPattern.test(result.flowId)
      )
        return reply(400);
      const native = new URL(mcpOAuthNativeReturn);
      native.searchParams.set('flowId', result.flowId);
      const location =
        result.client === 'ios' ? native.href : `${mcpOAuthWebReturn}#connected-tools`;
      return new Response(null, {
        status: 303,
        headers: { ...callbackHeaders, Location: location },
      });
    } catch {
      return reply(503);
    }
  };
}
