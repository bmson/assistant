import { createHash } from 'node:crypto';
import { decryptStoredCredential } from '@assistant/core/mcp-secrets';
import type { CalendarAccount, CalendarAccountRepository } from '@assistant/persistence';
import { GoogleClient, type GoogleClientOptions } from './client.js';

const CAL = 'https://www.googleapis.com/calendar/v3';
const READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
type Source = {
  id: string;
  client: GoogleClient;
  account?: CalendarAccount;
  unavailable?: boolean;
};
type Entry = { id: string; primary?: boolean; accessRole?: string; [key: string]: unknown };
type Roster = { items?: Entry[]; nextPageToken?: string; accountErrors?: string[] };

/**
 * Calendar reads only. All credentials remain with their own Google client;
 * calendar IDs stay provider-native for event links, approvals, and point reads.
 */
export class ConnectedCalendarClient extends GoogleClient {
  private readonly clients = new Map<string, GoogleClient>();
  private readonly routes = new Map<string, string>();
  private readonly routeRanks = new Map<string, number>();
  private accountFingerprint = '';

  constructor(
    private readonly bot: GoogleClient,
    private readonly credentials: Pick<GoogleClientOptions, 'clientId' | 'clientSecret'>,
    private readonly accounts: CalendarAccountRepository,
    private readonly open: (value: string) => string = decryptStoredCredential,
    private readonly makeClient: (options: GoogleClientOptions) => GoogleClient = (options) =>
      new GoogleClient(options),
  ) {
    // Cursor encryption is independent of any connected account or bot token.
    super({ ...credentials, refreshToken: 'calendar-account-cursors-v1' });
  }

  override configured(): boolean {
    return (
      this.bot.configured() || Boolean(this.credentials.clientId && this.credentials.clientSecret)
    );
  }

  private async sources(): Promise<Source[]> {
    const rows = await this.accounts.list();
    if (rows.length > 10) throw new Error('At most ten calendar accounts are supported');
    const previousFingerprint = this.accountFingerprint;
    this.accountFingerprint = createHash('sha256')
      .update(JSON.stringify(rows.map((row) => [row.id, row.refreshTokenEncrypted, row.clientId])))
      .digest('hex');
    if (previousFingerprint !== this.accountFingerprint) {
      this.routes.clear();
      this.routeRanks.clear();
    }
    const current = new Set(rows.map((row) => row.refreshTokenEncrypted));
    for (const key of this.clients.keys()) if (!current.has(key)) this.clients.delete(key);
    return [
      ...(this.bot.configured() ? [{ id: 'bot', client: this.bot }] : []),
      ...rows.map((account): Source => {
        try {
          if (
            account.clientId !== this.credentials.clientId ||
            !account.scopes.includes(READ_SCOPE)
          )
            throw new Error('Reconnect required');
          let client = this.clients.get(account.refreshTokenEncrypted);
          if (!client) {
            client = this.makeClient({
              ...this.credentials,
              refreshToken: this.open(account.refreshTokenEncrypted),
            });
            this.clients.set(account.refreshTokenEncrypted, client);
          }
          return { id: account.id, account, client };
        } catch {
          return { id: account.id, account, client: this.bot, unavailable: true };
        }
      }),
    ];
  }

  private async request<T>(source: Source, url: string, init: RequestInit): Promise<T> {
    try {
      if (source.unavailable) throw new Error('Reconnect required');
      const result = await source.client.api<T>(url, init);
      if (source.account?.lastError)
        await this.accounts.recordError(
          source.account.id,
          source.account.refreshTokenEncrypted,
          null,
        );
      return result;
    } catch {
      // Provider errors may contain sensitive response bodies. Persist and expose only this message.
      const message = source.account
        ? `Calendar account ${source.account.email} is unavailable. Reconnect it in Settings; your organization may require approval.`
        : 'The assistant calendar is unavailable.';
      if (source.account)
        await this.accounts.recordError(
          source.account.id,
          source.account.refreshTokenEncrypted,
          message,
        );
      throw new Error(message);
    }
  }

  override signOpaqueToken(value: string): string {
    return super.signOpaqueToken(JSON.stringify({ accounts: this.accountFingerprint, value }));
  }

  override verifyOpaqueToken(token: string): string | null {
    try {
      const decoded = super.verifyOpaqueToken(token);
      if (!decoded) return null;
      const envelope = JSON.parse(decoded) as { accounts: string; value: string };
      return envelope.accounts === this.accountFingerprint && typeof envelope.value === 'string'
        ? envelope.value
        : null;
    } catch {
      return null;
    }
  }

  private async roster(sources: Source[], url: URL, init: RequestInit): Promise<Roster> {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify(sources.map((source) => [source.id, source.account?.refreshTokenEncrypted])),
      )
      .digest('hex');
    const supplied = url.searchParams.get('pageToken');
    let tokens: Record<string, string | null> = {};
    if (supplied) {
      const decoded = this.verifyOpaqueToken(supplied);
      if (!decoded) throw new Error('Invalid connected calendar page token');
      const cursor = JSON.parse(decoded) as {
        fingerprint: string;
        tokens: Record<string, string | null>;
      };
      if (cursor.fingerprint !== fingerprint || !cursor.tokens || typeof cursor.tokens !== 'object')
        throw new Error('Calendar accounts changed; restart the calendar search');
      tokens = cursor.tokens;
    }
    const merged = new Map<string, Entry>();
    const next: Record<string, string | null> = {};
    const accountErrors: string[] = [];
    const results = await Promise.allSettled(
      sources.map(async (source) => {
        if (tokens[source.id] === null) return null;
        const target = new URL(url);
        target.searchParams.delete('pageToken');
        const token = tokens[source.id];
        if (token) target.searchParams.set('pageToken', token);
        return this.request<Roster>(source, target.href, init);
      }),
    );
    // Apply parallel responses in stable account order, preferring calendar owners.
    for (const [index, source] of sources.entries()) {
      const result = results[index];
      if (!result || result.status === 'rejected') {
        next[source.id] = null;
        accountErrors.push(
          result?.status === 'rejected' && result.reason instanceof Error
            ? result.reason.message
            : 'Calendar account unavailable',
        );
        continue;
      }
      const page = result.value;
      next[source.id] = page?.nextPageToken ?? null;
      for (const entry of page?.items ?? []) {
        if (!entry.id) continue;
        const currentRoute = this.routes.get(entry.id);
        const ownCalendar =
          entry.primary ||
          entry.accessRole === 'owner' ||
          source.account?.email.toLowerCase() === entry.id.toLowerCase();
        const rank = ownCalendar
          ? 100
          : entry.accessRole === 'writer'
            ? 50
            : source.account
              ? 20
              : 10;
        if (
          !currentRoute ||
          currentRoute === source.id ||
          rank > (this.routeRanks.get(entry.id) ?? 0)
        ) {
          this.routes.set(entry.id, source.id);
          this.routeRanks.set(entry.id, rank);
        }
        if (!merged.has(entry.id) || this.routes.get(entry.id) === source.id)
          merged.set(entry.id, {
            ...entry,
            primary: source.id === 'bot' && entry.primary === true,
            ...(source.account
              ? { accessRole: 'reader', connectedAccount: source.account.email }
              : {}),
          });
      }
    }
    return {
      items: [...merged.values()],
      ...(Object.values(next).some((token) => token !== null)
        ? { nextPageToken: this.signOpaqueToken(JSON.stringify({ fingerprint, tokens: next })) }
        : {}),
      ...(accountErrors.length ? { accountErrors } : {}),
    };
  }

  override async api<T>(value: string, init: RequestInit = {}): Promise<T> {
    init = {
      ...init,
      signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]),
    };
    const url = new URL(value);
    const method = (init.method ?? 'GET').toUpperCase();
    // This adapter cannot be used to send mail, RSVP, or mutate any calendar.
    if (url.origin !== 'https://www.googleapis.com' || !url.pathname.startsWith('/calendar/v3/'))
      throw new Error('Connected accounts support calendar reads only');
    const freeBusy = url.pathname === '/calendar/v3/freeBusy' && method === 'POST';
    if (method !== 'GET' && !freeBusy) throw new Error('Connected calendars are read-only');
    const sources = await this.sources();
    if (!sources.length) throw new Error('Connect a Google calendar account in Settings');
    if (url.pathname === '/calendar/v3/users/me/calendarList')
      return (await this.roster(sources, url, init)) as T;

    // Point reads may arrive without a preceding roster call (briefing reconciliation).
    const needsRoute = freeBusy
      ? JSON.parse(String(init.body)).items?.some(
          (item: { id: string }) => !this.routes.has(item.id),
        )
      : !this.routes.has(decodeURIComponent(url.pathname.split('/')[4] ?? ''));
    if (needsRoute) {
      let pageToken: string | undefined;
      for (let page = 0; page < 10; page++) {
        const rosterURL = new URL(
          `${CAL}/users/me/calendarList?minAccessRole=reader&maxResults=250`,
        );
        if (pageToken) rosterURL.searchParams.set('pageToken', pageToken);
        const roster = await this.roster(sources, rosterURL, { signal: init.signal });
        pageToken = roster.nextPageToken;
        if (!pageToken) break;
      }
    }
    const route = (id: string): Source | undefined =>
      sources.find((source) => source.id === this.routes.get(id)) ??
      sources.find((source) => source.id === 'bot');
    if (freeBusy) {
      const body = JSON.parse(String(init.body)) as {
        items: Array<{ id: string }>;
        [key: string]: unknown;
      };
      const calendars: Record<string, unknown> = {};
      for (const source of sources) {
        const items = body.items.filter((item) => route(item.id)?.id === source.id);
        if (!items.length) continue;
        try {
          const response = await this.request<{ calendars?: Record<string, unknown> }>(
            source,
            value,
            { ...init, body: JSON.stringify({ ...body, items }) },
          );
          Object.assign(calendars, response.calendars);
        } catch {
          for (const item of items)
            calendars[item.id] = { errors: [{ reason: 'accountUnavailable' }] };
        }
      }
      return { calendars } as T;
    }
    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/[^/]+)?$/.exec(url.pathname);
    if (!match?.[1]) throw new Error('Unsupported connected calendar read');
    const calendarId = decodeURIComponent(match[1]);
    const source = route(calendarId);
    if (!source) throw new Error('Calendar account is no longer connected');
    return this.request<T>(source, value, init);
  }
}

export function connectedCalendarClient(
  bot: GoogleClient,
  config: { GOOGLE_OAUTH_CLIENT_ID: string; GOOGLE_OAUTH_CLIENT_SECRET: string },
  accounts?: CalendarAccountRepository,
): GoogleClient {
  return accounts
    ? new ConnectedCalendarClient(
        bot,
        {
          clientId: config.GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
        },
        accounts,
      )
    : bot;
}
