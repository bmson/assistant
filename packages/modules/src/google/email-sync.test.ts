import { randomUUID } from 'node:crypto';
import {
  channelBindings,
  conversations,
  createDb,
  createPostgresExecutionPersistence,
  type Db,
  emailIngest,
  emailObserverWork,
  messages,
  tasks,
  writingSamples,
} from '@assistant/db';
import {
  type EmailSyncRepository,
  isValidEmailContentProvenanceSnapshot,
} from '@assistant/persistence';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type EmailSyncDeps,
  emailContentProvenance,
  emailQuotesExternalContent,
  gmailSenderAuthenticated,
  importantEmailNotice,
  MailboxSyncCoordinator,
  type MailboxSyncResult,
  parseSenderName,
  processForwardedIngest,
  processMessage,
} from './email-sync.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const { getAgent } = await import('@assistant/core/chat');
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('email-sync owner-alert tests: database unreachable — skipping');
  }
});

afterAll(async () => {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('MailboxSyncCoordinator', () => {
  it('coalesces concurrent pokes and drains once more when dirtied during each pass', async () => {
    const passes = [
      deferred<MailboxSyncResult>(),
      deferred<MailboxSyncResult>(),
      deferred<MailboxSyncResult>(),
    ];
    const runOnce = vi.fn(() => {
      const pass = passes[runOnce.mock.calls.length - 1];
      if (!pass) throw new Error('unexpected pass');
      return pass.promise;
    });
    const coordinator = new MailboxSyncCoordinator(runOnce);

    const first = coordinator.sync();
    expect(runOnce).toHaveBeenCalledTimes(1);
    const concurrent = coordinator.sync();
    expect(concurrent).toBe(first);
    coordinator.sync(); // multiple pokes still coalesce to one extra pass

    passes[0]?.resolve({ processed: 1 });
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(2));
    coordinator.sync(); // a poke during the second pass must force a third
    passes[1]?.resolve({ processed: 2 });
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(3));
    passes[2]?.resolve({ processed: 3 });

    await expect(first).resolves.toEqual({ processed: 6 });
    await expect(concurrent).resolves.toEqual({ processed: 6 });
    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it('allows a fresh drain after a failed pass', async () => {
    const runOnce = vi
      .fn<() => Promise<MailboxSyncResult>>()
      .mockRejectedValueOnce(new Error('temporary Gmail failure'))
      .mockResolvedValueOnce({ processed: 4 });
    const coordinator = new MailboxSyncCoordinator(runOnce);

    await expect(coordinator.sync()).rejects.toThrow('temporary Gmail failure');
    await expect(coordinator.sync()).resolves.toEqual({ processed: 4 });
    expect(runOnce).toHaveBeenCalledTimes(2);
  });
});

describe('Gmail sender authentication', () => {
  const payload = (authenticationResults: string) => ({
    headers: [{ name: 'Authentication-Results', value: authenticationResults }],
  });

  it('accepts a Gmail-verified, aligned sender domain', () => {
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dmarc=pass (p=reject) header.from=example.com'),
        'owner@example.com',
      ),
    ).toBe(true);
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.i=@example.com header.s=mail'),
        'owner@example.com',
      ),
    ).toBe(true);
  });

  it('accepts the Google Workspace default DKIM key for a domain with no custom key', () => {
    // Verbatim header from bot@bmson.com: a Workspace domain that publishes no
    // SPF/DKIM/DMARC still gets a Google-signed per-tenant gappssmtp key. Before
    // this was accepted, every message from the owner's own domain was dropped.
    expect(
      gmailSenderAuthenticated(
        payload(
          'mx.google.com;       dkim=pass header.i=@bmson-com.20251104.gappssmtp.com header.s=20251104 header.b=qLVdIQJT;       arc=pass (i=1);       spf=none (google.com: bmson@bmson.com does not designate permitted sender hosts) smtp.mailfrom=bmson@bmson.com;       dara=neutral header.i=@bmson.com',
        ),
        'bmson@bmson.com',
      ),
    ).toBe(true);
  });

  it('does not let the gappssmtp exemption authenticate a domain it was not issued for', () => {
    // The tenant label is derived from the domain, so a key issued to one
    // Workspace tenant must never authenticate another domain, and a victim
    // domain smuggled in as a deeper subdomain must not match either.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.i=@attacker-example.20251104.gappssmtp.com'),
        'owner@example.com',
      ),
    ).toBe(false);
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.i=@example-com.evil.20251104.gappssmtp.com'),
        'owner@example.com',
      ),
    ).toBe(false);
    // SPF/DMARC clauses get no such exemption — only Google signs DKIM keys.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; spf=pass smtp.mailfrom=example-com.20251104.gappssmtp.com'),
        'owner@example.com',
      ),
    ).toBe(false);
    // The lossy dots→hyphens map: a subdomain victim (mail.example.com) shares a
    // tenant label with the registrable sibling mail-example.com, so the
    // exemption must not authenticate it — the attacker's mail-example.com key
    // produces the same 'mail-example-com' label.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.i=@mail-example-com.20251104.gappssmtp.com'),
        'user@mail.example.com',
      ),
    ).toBe(false);
    // A hyphenated victim domain is likewise ambiguous and refused.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.i=@my-corp-com.20251104.gappssmtp.com'),
        'owner@my-corp.com',
      ),
    ).toBe(false);
  });

  it('rejects unverified, misaligned, and sender-supplied authentication claims', () => {
    expect(gmailSenderAuthenticated(undefined, 'owner@example.com')).toBe(false);
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dmarc=pass header.from=attacker.example'),
        'owner@example.com',
      ),
    ).toBe(false);
    expect(
      gmailSenderAuthenticated(
        payload('attacker.example; dmarc=pass header.from=example.com'),
        'owner@example.com',
      ),
    ).toBe(false);
  });

  it('accepts relaxed DKIM/SPF organizational alignment for subdomain senders', () => {
    // Very common: a careers portal at jobs.company.com signs DKIM with the
    // organizational domain company.com. Strict-only alignment dropped these.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.d=company.com header.s=sel'),
        'careers@jobs.company.com',
      ),
    ).toBe(true);
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; spf=pass smtp.mailfrom=bounce.company.com'),
        'careers@company.com',
      ),
    ).toBe(true);
  });

  it('does not relax alignment across different orgs or for DMARC', () => {
    // Different second-level domains must never align, even sharing a suffix.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.d=attacker.com header.s=sel'),
        'careers@company.com',
      ),
    ).toBe(false);
    // Two orgs under a shared public suffix are not a subdomain relationship.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.d=attacker.co.uk header.s=sel'),
        'user@victim.co.uk',
      ),
    ).toBe(false);
    // DMARC stays strict: relaxed subdomain alignment must not apply to it.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dmarc=pass header.from=company.com'),
        'careers@jobs.company.com',
      ),
    ).toBe(false);
  });

  it('does not let a sender forge a pass clause inside an SPF comment or quoted mailfrom', () => {
    // The attacker uses an RFC-5321-legal quoted local part in MAIL FROM so
    // Gmail echoes attacker-controlled text — carrying a ';' and a synthetic
    // 'dkim=pass header.d=<owner>' — into the SPF clause. A naive split on ';'
    // would mint that clause and authenticate the spoof.
    expect(
      gmailSenderAuthenticated(
        payload(
          'mx.google.com; spf=softfail (google.com: domain of "; dkim=pass header.d=example.com "@evil.test does not designate) smtp.mailfrom="; dkim=pass header.d=example.com "@evil.test',
        ),
        'owner@example.com',
      ),
    ).toBe(false);
    // The same smuggling attempt via a nested comment must also fail.
    expect(
      gmailSenderAuthenticated(
        payload(
          'mx.google.com; spf=none (a (b; dkim=pass header.d=example.com) c) smtp.mailfrom=x@evil.test',
        ),
        'owner@example.com',
      ),
    ).toBe(false);
    // A genuine comment in a legitimate header does not break real authentication.
    expect(
      gmailSenderAuthenticated(
        payload(
          'mx.google.com; spf=pass (google.com: domain of owner@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=owner@example.com; dmarc=pass (p=reject) header.from=example.com',
        ),
        'owner@example.com',
      ),
    ).toBe(true);
  });

  it('reads only the topmost Authentication-Results header (S6)', () => {
    const multi = (values: string[]) => ({
      headers: values.map((value) => ({ name: 'Authentication-Results', value })),
    });
    // Gmail prepends its own verdict at delivery, so the receiver header is
    // first. A sender-injected forged mx.google.com header lower in the list
    // must never authenticate.
    expect(
      gmailSenderAuthenticated(
        multi([
          'mx.google.com; dmarc=fail header.from=example.com',
          'mx.google.com; dmarc=pass header.from=example.com',
        ]),
        'owner@example.com',
      ),
    ).toBe(false);
    // The genuine (top) Gmail header still authenticates even when a stale
    // sender-supplied header sits beneath it.
    expect(
      gmailSenderAuthenticated(
        multi([
          'mx.google.com; dmarc=pass header.from=example.com',
          'mx.google.com; dmarc=fail header.from=example.com',
        ]),
        'owner@example.com',
      ),
    ).toBe(true);
    // A non-Google top header is not trusted, and we do NOT fall through to a
    // lower forged Google header.
    expect(
      gmailSenderAuthenticated(
        multi([
          'attacker.example; dmarc=pass header.from=example.com',
          'mx.google.com; dmarc=pass header.from=example.com',
        ]),
        'owner@example.com',
      ),
    ).toBe(false);
  });
});

describe('Gmail external-content provenance', () => {
  it('preserves localized, HTML, reply-header, and beyond-prefix quote evidence', () => {
    const htmlPayload = {
      mimeType: 'multipart/alternative',
      parts: [
        {
          mimeType: 'text/html',
          body: {
            data: Buffer.from(
              '<div>Do this</div><blockquote>external instructions</blockquote>',
            ).toString('base64url'),
          },
        },
      ],
    };
    expect(emailQuotesExternalContent(htmlPayload, 'calendar', 'Add it')).toBe(true);

    expect(
      emailQuotesExternalContent(
        { headers: [{ name: 'References', value: '<original@example.com>' }] },
        'Re: calendar',
        'Copied text without quote markers',
      ),
    ).toBe(true);

    const longBody = `${'Fresh owner request. '.repeat(1_500)}\nLe 5 octobre, Alice a écrit :\nquoted`;
    expect(emailQuotesExternalContent(undefined, 'calendar', longBody)).toBe(true);
  });
});

describe('direct-mode durable email admission', () => {
  it('commits the authenticated message and frozen observer work atomically without legacy fan-out', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = randomUUID();
    const channelMessageId = `gmail:${key}`;
    const threadId = `direct-${key}`;
    const sender = `owner-${key.slice(0, 8)}@example.test`;
    const body = `A routine authenticated note ${key}; no action is required.`;
    const legacyObserver = vi.fn(async () => {});
    const legacyRecorder = vi.fn();
    const score = vi.fn(async () => ({
      ok: true as const,
      object: {
        category: 'personal',
        importance: 2,
        actionable: false,
        dates: [],
        reason: 'Routine note',
      },
    }));
    const base = createPostgresExecutionPersistence(db);
    const emailSync = base.emailSync;
    if (!emailSync) throw new Error('PostgreSQL persistence has no email sync repository');
    const persistence = {
      ...base,
      emailSync: new Proxy(emailSync, {
        get(target, property, receiver) {
          if (property === 'recordIngest') return legacyRecorder;
          return Reflect.get(target, property, receiver);
        },
      }),
    } as unknown as EmailSyncDeps['persistence'];
    const deps = {
      config: {
        ASSISTANT_MODULES: ['google'],
        GMAIL_SYNC_ENABLED: 'true',
        EMAIL_INGEST_MODE: 'direct',
        EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 40,
      },
      db,
      persistence,
      router: { object: score },
      workspace: {},
      googleClient: {
        configured: () => true,
        api: async () => ({
          id: key,
          threadId,
          labelIds: ['INBOX'],
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: `Owner ${key.slice(0, 8)} <${sender}>` },
              { name: 'Subject', value: 'Routine note' },
              {
                name: 'Authentication-Results',
                value: 'mx.google.com; dmarc=pass header.from=example.test',
              },
            ],
            body: { data: Buffer.from(body).toString('base64url') },
          },
        }),
      },
      notifyOwner: async () => {},
      observeInboundEmail: legacyObserver,
      durableEmailObservers: [
        { identity: { key: 'test.direct-atomic', version: 1, workClass: 'idempotent_db' } },
        {
          identity: {
            key: 'google.application-confirmation',
            version: 1,
            workClass: 'idempotent_db',
          },
        },
        {
          identity: { key: 'google.direct-email-routing', version: 1, workClass: 'idempotent_db' },
        },
      ],
    } as unknown as EmailSyncDeps;
    let conversationId: string | undefined;
    try {
      await expect(
        processMessage(deps, agentId, 'assistant@example.test', new Map([[sender, 'owner']]), key),
      ).resolves.toBe('triaged');
      expect(legacyObserver).not.toHaveBeenCalled();
      expect(legacyRecorder).not.toHaveBeenCalled();
      expect(score).toHaveBeenCalledTimes(1);
      const [ingest] = await db
        .select()
        .from(emailIngest)
        .where(eq(emailIngest.channelMessageId, channelMessageId));
      conversationId = ingest?.conversationId ?? undefined;
      expect(ingest).toMatchObject({
        ingestMode: 'direct',
        directRouting: 'email_triage',
        authenticated: true,
        classificationStatus: 'prepared',
        preparedClassification: { automated: false },
        messagePersisted: true,
        admittedSourceKind: 'message',
        observerRegistrySnapshot: [
          { key: 'google.direct-email-routing', version: 1, workClass: 'idempotent_db' },
          { key: 'test.direct-atomic', version: 1, workClass: 'idempotent_db' },
        ],
      });
      expect(
        await db.select().from(messages).where(eq(messages.channelMessageId, channelMessageId)),
      ).toHaveLength(1);
      expect(
        await db.select().from(tasks).where(eq(tasks.externalEventId, channelMessageId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(emailObserverWork)
          .where(eq(emailObserverWork.sourceKey, channelMessageId)),
      ).toHaveLength(2);
    } finally {
      await db.delete(emailObserverWork).where(eq(emailObserverWork.sourceKey, channelMessageId));
      await db.delete(tasks).where(eq(tasks.conversationId, conversationId ?? ''));
      await db.delete(emailIngest).where(eq(emailIngest.channelMessageId, channelMessageId));
      await db.delete(messages).where(eq(messages.channelMessageId, channelMessageId));
      if (conversationId) {
        await db.delete(channelBindings).where(eq(channelBindings.externalId, threadId));
        await db.delete(conversations).where(eq(conversations.id, conversationId));
      }
    }
  });
});

describe('forwarded-ingest owner alerts', () => {
  it('composes an SMS-safe heads-up that leads with what to do', () => {
    const text = importantEmailNotice('Alice Example', 'Q3 invoice', {
      category: 'financial',
      importance: 5,
      reason: 'Payment due Friday.',
      nextStep: 'Pay the invoice by Friday',
      dates: [{ iso: '2026-08-28', what: 'payment due' }],
    });
    expect(text).toBe(
      'Email from Alice Example: “Q3 invoice”\nNext: Pay the invoice by Friday\nDates: payment due (2026-08-28)',
    );
    expect(text).not.toContain('Payment due Friday.');
  });

  it('does not expose internal scoring rationale or source newlines', () => {
    const text = importantEmailNotice('Account\nsecurity', '  Login\nnotice  ', {
      category: 'security',
      importance: 5,
      reason: 'The owner should verify; deserves attention but is not urgent.',
      dates: [],
    });
    expect(text).toBe('Email from Account security: “Login notice”');
    expect(
      importantEmailNotice(' ', ' ', {
        category: 'other',
        importance: 4,
        reason: 'internal',
        dates: [],
      }),
    ).toBe('Email from Unknown sender: “(no subject)”');
  });

  it('pings the owner at or above the notify threshold, stays quiet below it', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const stamp = `${Date.now()}`;
    const conversationIds: string[] = [];
    const run = async (importance: number, from = 'alice@example.com', notifyFails = false) => {
      const notified: string[] = [];
      const deps = {
        config: {
          ASSISTANT_MODULES: ['google'] as never[],
          GMAIL_SYNC_ENABLED: 'true',
          EMAIL_INGEST_IMPORTANCE_THRESHOLD: 3,
          EMAIL_INGEST_NOTIFY_THRESHOLD: 4,
          EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 40,
        },
        db,
        persistence: createPostgresExecutionPersistence(db),
        router: {
          object: async () => ({
            ok: true,
            object: {
              category: 'financial',
              importance,
              actionable: true,
              dates: [],
              reason: 'A payment is due.',
            },
          }),
        },
        workspace: {},
        googleClient: { configured: () => false, api: async () => ({}) },
        notifyOwner: async ({ text }: { text: string }) => {
          if (notifyFails) throw new Error('notifier down');
          notified.push(text);
        },
        observeInboundEmail: async () => {},
      } as unknown as EmailSyncDeps;

      const key = `${stamp}-${importance}-${from}-${notifyFails}`;
      const channelMessageId = `gmail:xtest-notify-${key}`;
      const outcome = await processForwardedIngest(deps, {
        agentId,
        message: { id: `m-${key}`, threadId: `t-${key}` },
        from,
        subject: `Invoice ${importance}`,
        text: 'Please pay the attached invoice by Friday.',
        rfcMessageId: '',
        authenticated: true,
        contactTrustByEmail: new Map(),
        channelMessageId,
      });
      const [row] = await db
        .select({ conversationId: emailIngest.conversationId })
        .from(emailIngest)
        .where(eq(emailIngest.channelMessageId, channelMessageId));
      if (row?.conversationId) conversationIds.push(row.conversationId);
      return { outcome, notified };
    };

    try {
      const high = await run(5);
      expect(high.outcome).toBe('triaged');
      expect(high.notified).toHaveLength(1);
      expect(high.notified[0]).toContain('alice@example.com');

      const low = await run(2);
      expect(low.outcome).toBe('skipped');
      expect(low.notified).toHaveLength(0);

      // A burst from one sender is one thing to the owner: the second message
      // still triages, but does not buzz again.
      const burst = await run(4);
      expect(burst.outcome).toBe('triaged');
      expect(burst.notified).toHaveLength(0);

      // A failed alert is not remembered, so it cannot silence the next one.
      await run(5, `bob-${stamp}@example.com`, true);
      expect((await run(4, `bob-${stamp}@example.com`)).notified).toHaveLength(1);
    } finally {
      if (conversationIds.length > 0) {
        await db.delete(tasks).where(inArray(tasks.conversationId, conversationIds));
        await db.delete(emailIngest).where(inArray(emailIngest.conversationId, conversationIds));
        await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
        await db
          .delete(channelBindings)
          .where(inArray(channelBindings.conversationId, conversationIds));
        await db.delete(conversations).where(inArray(conversations.id, conversationIds));
      }
    }
  });

  it('never captures forwarded-mode owner-address mail as an owner voice sample', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = randomUUID();
    const text = `Forwarded source ${key}: Please send this information to the vendor. This copied message is long enough for the automatic writing-sample collector.`;
    const base = createPostgresExecutionPersistence(db);
    const embed = vi.fn(async () => [Array(1536).fill(0.1)]);
    const deps = {
      config: {
        ASSISTANT_MODULES: ['google'],
        GMAIL_SYNC_ENABLED: 'true',
        EMAIL_INGEST_IMPORTANCE_THRESHOLD: 3,
        EMAIL_INGEST_NOTIFY_THRESHOLD: 5,
        EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 1000,
      },
      db,
      persistence: base,
      router: {
        object: async () => ({
          ok: true,
          object: {
            category: 'other',
            importance: 3,
            actionable: true,
            dates: [],
            reason: 'Synthetic source',
          },
        }),
        embed,
      },
      workspace: {},
      googleClient: { configured: () => false, api: async () => ({}) },
      notifyOwner: async () => {},
      observeInboundEmail: async () => {},
    } as unknown as EmailSyncDeps;
    const input = {
      agentId,
      message: { id: key, threadId: key },
      from: 'synthetic-owner@example.test',
      subject: 'Synthetic copied prose',
      text,
      rfcMessageId: '',
      authenticated: true,
      contactTrustByEmail: new Map([['synthetic-owner@example.test', 'owner' as const]]),
      channelMessageId: `gmail:${key}`,
    };
    try {
      expect(await processForwardedIngest(deps, input)).toBe('triaged');
      expect(embed).not.toHaveBeenCalled();
      expect(
        await db.select().from(writingSamples).where(eq(writingSamples.text, text)),
      ).toHaveLength(0);
    } finally {
      await db.delete(writingSamples).where(eq(writingSamples.text, text));
      const [record] = await db
        .select()
        .from(emailIngest)
        .where(eq(emailIngest.channelMessageId, input.channelMessageId));
      if (record?.conversationId) {
        await db.delete(tasks).where(eq(tasks.conversationId, record.conversationId));
        await db.delete(emailIngest).where(eq(emailIngest.id, record.id));
        await db.delete(messages).where(eq(messages.conversationId, record.conversationId));
        await db
          .delete(channelBindings)
          .where(eq(channelBindings.conversationId, record.conversationId));
        await db.delete(conversations).where(eq(conversations.id, record.conversationId));
      }
    }
  });

  it('uses atomic observer admission on the forwarded message path without legacy fan-out', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = randomUUID();
    const channelMessageId = `gmail:${key}`;
    const threadId = `thread-${key}`;
    const body = 'The booking is confirmed for October 20.';
    const legacyObserver = vi.fn(async () => {});
    const score = vi.fn(async () => ({ ok: false as const, reason: 'must not be called' }));
    const base = createPostgresExecutionPersistence(db);
    const emailSync = base.emailSync;
    if (!emailSync) throw new Error('PostgreSQL persistence has no email sync repository');
    const scoreClaims: Array<Parameters<EmailSyncRepository['claimIngestScore']>> = [];
    const persistence = {
      ...base,
      emailSync: new Proxy(emailSync, {
        get(target, property, receiver) {
          if (property === 'claimIngestScore') {
            return async (...args: Parameters<EmailSyncRepository['claimIngestScore']>) => {
              scoreClaims.push(args);
              return emailSync.claimIngestScore(...args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    } as unknown as EmailSyncDeps['persistence'];
    const deps = {
      config: {
        ASSISTANT_MODULES: ['google'],
        GMAIL_SYNC_ENABLED: 'true',
        EMAIL_INGEST_MODE: 'forwarded',
        EMAIL_INGEST_IMPORTANCE_THRESHOLD: 3,
        EMAIL_INGEST_NOTIFY_THRESHOLD: 5,
        EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 40,
      },
      db,
      persistence,
      router: { object: score },
      workspace: {},
      googleClient: {
        configured: () => true,
        api: async () => ({
          id: key,
          threadId,
          labelIds: ['INBOX'],
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'sender@example.test' },
              { name: 'Subject', value: 'Booking confirmation' },
              { name: 'List-Id', value: 'mailing-list.example.test' },
              {
                name: 'Authentication-Results',
                value: 'mx.google.com; dkim=pass header.d=example.test',
              },
            ],
            body: { data: Buffer.from(body).toString('base64url') },
          },
        }),
      },
      notifyOwner: async () => {},
      observeInboundEmail: legacyObserver,
      durableEmailObservers: [
        { identity: { key: 'test.forwarded-atomic', version: 1, workClass: 'idempotent_db' } },
      ],
    } as unknown as EmailSyncDeps;
    let conversationId: string | undefined;
    try {
      await expect(
        processMessage(deps, agentId, 'assistant@example.test', new Map(), key),
      ).resolves.toBe('skipped');
      expect(score).not.toHaveBeenCalled();
      expect(scoreClaims[0]?.[5]).toBe('deterministic_no_model');
      expect(legacyObserver).not.toHaveBeenCalled();
      const [ingest] = await db
        .select()
        .from(emailIngest)
        .where(eq(emailIngest.channelMessageId, channelMessageId));
      conversationId = ingest?.conversationId ?? undefined;
      expect(ingest?.observerRegistrySnapshot).toEqual([
        { key: 'test.forwarded-atomic', version: 1, workClass: 'idempotent_db' },
      ]);
      expect(
        await db.select().from(messages).where(eq(messages.channelMessageId, channelMessageId)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(emailObserverWork)
          .where(eq(emailObserverWork.sourceKey, channelMessageId)),
      ).toHaveLength(1);
    } finally {
      await db.delete(emailObserverWork).where(eq(emailObserverWork.sourceKey, channelMessageId));
      await db.delete(emailIngest).where(eq(emailIngest.channelMessageId, channelMessageId));
      await db.delete(messages).where(eq(messages.channelMessageId, channelMessageId));
      if (conversationId) {
        await db.delete(channelBindings).where(eq(channelBindings.externalId, threadId));
        await db.delete(conversations).where(eq(conversations.id, conversationId));
      }
    }
  });

  it('commits a deterministic fallback once while keeping an ambiguous score attempt unknown', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = randomUUID();
    const channelMessageId = `gmail:${key}`;
    const threadId = `thread-${key}`;
    const base = createPostgresExecutionPersistence(db);
    const emailSync = base.emailSync;
    if (!emailSync) throw new Error('PostgreSQL persistence has no email sync repository');
    const score = vi.fn(async () => {
      throw new Error('synthetic provider outcome unknown');
    });
    let interruptAfterAdmission = true;
    const persistence = {
      ...base,
      emailSync: new Proxy(emailSync, {
        get(target, property, receiver) {
          if (property === 'commitEmailAdmission') {
            return async (...args: Parameters<EmailSyncRepository['commitEmailAdmission']>) => {
              const result = await emailSync.commitEmailAdmission(...args);
              if (interruptAfterAdmission) {
                interruptAfterAdmission = false;
                throw new Error('simulated lost admission response');
              }
              return result;
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    } as unknown as EmailSyncDeps['persistence'];
    const deps = {
      config: {
        ASSISTANT_MODULES: ['google'] as never[],
        GMAIL_SYNC_ENABLED: 'true',
        EMAIL_INGEST_IMPORTANCE_THRESHOLD: 3,
        EMAIL_INGEST_NOTIFY_THRESHOLD: 5,
        EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 40,
      },
      db,
      persistence,
      router: { object: score },
      workspace: {},
      googleClient: { configured: () => false, api: async () => ({}) },
      notifyOwner: async () => {},
      observeInboundEmail: async () => {},
      durableEmailObservers: [
        { identity: { key: 'test.forwarded-fallback', version: 1, workClass: 'idempotent_db' } },
      ],
    } as unknown as EmailSyncDeps;
    const input = {
      agentId,
      message: { id: key, threadId },
      from: 'unknown@example.test',
      subject: 'Routine note',
      text: 'A routine note with no action requested.',
      rfcMessageId: '',
      authenticated: true,
      contactTrustByEmail: new Map(),
      channelMessageId,
    };
    let conversationId: string | undefined;
    try {
      await expect(processForwardedIngest(deps, input)).rejects.toThrow(
        'simulated lost admission response',
      );
      await expect(processForwardedIngest(deps, input)).resolves.toBe('skipped');
      expect(score).toHaveBeenCalledTimes(1);
      const [ingest] = await db
        .select()
        .from(emailIngest)
        .where(eq(emailIngest.channelMessageId, channelMessageId));
      conversationId = ingest?.conversationId ?? undefined;
      expect(ingest).toMatchObject({
        pipelineStage: 'complete',
        scoreStatus: 'unknown',
        scoreOutcome: 'fallback_committed_unknown',
        messagePersisted: true,
        triaged: false,
      });
      expect(
        await db.select().from(messages).where(eq(messages.channelMessageId, channelMessageId)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(emailObserverWork)
          .where(eq(emailObserverWork.sourceKey, channelMessageId)),
      ).toHaveLength(1);
    } finally {
      await db.delete(emailObserverWork).where(eq(emailObserverWork.sourceKey, channelMessageId));
      await db.delete(emailIngest).where(eq(emailIngest.channelMessageId, channelMessageId));
      await db.delete(messages).where(eq(messages.channelMessageId, channelMessageId));
      if (conversationId) {
        await db.delete(channelBindings).where(eq(channelBindings.externalId, threadId));
        await db.delete(conversations).where(eq(conversations.id, conversationId));
      }
    }
  });

  it('resumes a committed source and existing task without rescoring after interrupted checkpoints', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const key = randomUUID();
    const channelMessageId = `gmail:resume-${key}`;
    const threadId = `thread-resume-${key}`;
    const base = createPostgresExecutionPersistence(db);
    const emailSync = base.emailSync;
    if (!emailSync) throw new Error('PostgreSQL persistence has no email sync repository');
    const score = vi.fn(async () => ({
      ok: true as const,
      object: {
        category: 'travel' as const,
        importance: 2,
        actionable: false,
        cardCandidate: true,
        dates: [],
        reason: 'A pass worth keeping.',
      },
    }));
    let interruptAfterBegin = true;
    let interruptAfterPreparedScore = true;
    let interruptAfterAdmission = true;
    let interruptBeforeReceipt = true;
    const persistence = {
      ...base,
      emailSync: new Proxy(emailSync, {
        get(target, property, receiver) {
          if (property === 'beginForwardedIngest') {
            return async (...args: Parameters<EmailSyncRepository['beginForwardedIngest']>) => {
              const result = await emailSync.beginForwardedIngest(...args);
              if (interruptAfterBegin) {
                interruptAfterBegin = false;
                throw new Error('simulated crash after SQL ingest stage creation');
              }
              return result;
            };
          }
          if (property === 'prepareIngestScore') {
            return async (...args: Parameters<EmailSyncRepository['prepareIngestScore']>) => {
              await emailSync.prepareIngestScore(...args);
              if (interruptAfterPreparedScore) {
                interruptAfterPreparedScore = false;
                throw new Error('simulated crash after SQL score checkpoint');
              }
            };
          }
          if (property === 'commitEmailAdmission') {
            return async (...args: Parameters<EmailSyncRepository['commitEmailAdmission']>) => {
              const result = await emailSync.commitEmailAdmission(...args);
              if (interruptAfterAdmission) {
                interruptAfterAdmission = false;
                throw new Error('simulated crash after atomic source and observer admission');
              }
              return result;
            };
          }
          if (property === 'completeForwardedIngest') {
            return async (...args: Parameters<EmailSyncRepository['completeForwardedIngest']>) => {
              if (interruptBeforeReceipt) {
                interruptBeforeReceipt = false;
                throw new Error('simulated crash after task commit');
              }
              return emailSync.completeForwardedIngest(...args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    } as unknown as EmailSyncDeps['persistence'];
    const deps = {
      config: {
        ASSISTANT_MODULES: ['google'] as never[],
        GMAIL_SYNC_ENABLED: 'true',
        EMAIL_INGEST_IMPORTANCE_THRESHOLD: 3,
        EMAIL_INGEST_NOTIFY_THRESHOLD: 4,
        EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 40,
        PROACTIVE_CARDS_ENABLED: true,
      },
      db,
      persistence,
      router: { object: score },
      workspace: {},
      googleClient: { configured: () => false, api: async () => ({}) },
      notifyOwner: async () => {},
      observeInboundEmail: async () => {},
      durableEmailObservers: [
        {
          identity: {
            key: 'test.email-recovery',
            version: 1,
            workClass: 'idempotent_db',
          },
        },
      ],
    } as unknown as EmailSyncDeps;
    const input = {
      agentId,
      message: { id: `provider-${key}`, threadId },
      from: 'sender@example.test',
      subject: 'Travel pass',
      text: 'Keep this pass for the trip.',
      rfcMessageId: '',
      authenticated: true,
      contactTrustByEmail: new Map(),
      channelMessageId,
    };
    let conversationId: string | undefined;
    try {
      await expect(processForwardedIngest(deps, input)).rejects.toThrow(
        'simulated crash after SQL ingest stage creation',
      );
      expect(score).toHaveBeenCalledTimes(0);
      await expect(processForwardedIngest(deps, input)).rejects.toThrow(
        'simulated crash after SQL score checkpoint',
      );
      expect(score).toHaveBeenCalledTimes(1);
      await expect(processForwardedIngest(deps, input)).rejects.toThrow(
        'simulated crash after atomic source and observer admission',
      );
      expect(score).toHaveBeenCalledTimes(1);
      await expect(processForwardedIngest(deps, input)).rejects.toThrow(
        'simulated crash after task commit',
      );
      expect(score).toHaveBeenCalledTimes(1);
      await expect(processForwardedIngest(deps, input)).resolves.toBe('triaged');
      expect(score).toHaveBeenCalledTimes(1);

      const [ingest] = await db
        .select()
        .from(emailIngest)
        .where(eq(emailIngest.channelMessageId, channelMessageId));
      conversationId = ingest?.conversationId ?? undefined;
      expect(ingest).toMatchObject({
        pipelineStage: 'complete',
        scoreStatus: 'prepared',
        messagePersisted: true,
        importance: 2,
        cardCandidate: true,
        triaged: true,
      });
      expect(
        await db.select().from(messages).where(eq(messages.channelMessageId, channelMessageId)),
      ).toHaveLength(1);
      const observerRows = await db
        .select()
        .from(emailObserverWork)
        .where(eq(emailObserverWork.sourceKey, channelMessageId));
      expect(observerRows).toHaveLength(1);
      expect(observerRows[0]).toMatchObject({
        channelMessageId,
        sourceKind: 'message',
        observerKey: 'test.email-recovery',
        observerVersion: 1,
        workClass: 'idempotent_db',
        status: 'pending',
      });
      expect(
        await db.select().from(tasks).where(eq(tasks.externalEventId, channelMessageId)),
      ).toHaveLength(1);
    } finally {
      if (conversationId) {
        await db.delete(tasks).where(eq(tasks.externalEventId, channelMessageId));
        await db.delete(emailObserverWork).where(eq(emailObserverWork.sourceKey, channelMessageId));
        await db.delete(emailIngest).where(eq(emailIngest.channelMessageId, channelMessageId));
        await db.delete(messages).where(eq(messages.channelMessageId, channelMessageId));
        await db.delete(channelBindings).where(eq(channelBindings.externalId, threadId));
        await db.delete(conversations).where(eq(conversations.id, conversationId));
      }
    }
  });
});

describe('parseSenderName', () => {
  it('takes the display name out of a normal From header', () => {
    expect(parseSenderName('Hyundai Motor Finance <hmfusa@servicing.hmfusa.com>')).toBe(
      'Hyundai Motor Finance',
    );
  });

  it('strips the quotes a client wraps a name in', () => {
    expect(parseSenderName('"Innes, Katharine" <katharine.innes@gmail.com>')).toBe(
      'Innes, Katharine',
    );
  });

  it('returns undefined for a bare address, which has no name to show', () => {
    expect(parseSenderName('hmfusa@servicing.hmfusa.com')).toBeUndefined();
    expect(parseSenderName('<hmfusa@servicing.hmfusa.com>')).toBeUndefined();
  });

  it('returns undefined when the name is only the address repeated', () => {
    // Some senders emit `addr <addr>`; showing that is no better than the bare
    // address, and the caller already falls back to it.
    expect(parseSenderName('hmfusa@servicing.hmfusa.com <hmfusa@servicing.hmfusa.com>')).toBe(
      undefined,
    );
  });

  it('leaves an encoded-word alone rather than decoding it wrong', () => {
    const header = '=?UTF-8?Q?Caf=C3=A9?= <hello@example.com>';
    expect(parseSenderName(header)).toBe('=?UTF-8?Q?Caf=C3=A9?=');
  });
});

describe('Gmail MIME provenance topology', () => {
  it('accepts producer provenance for a short body with a longer display header', () => {
    const body = 'Please reply.';
    const prefix = 'From: owner@example.test\nSubject: Confirmation of tomorrow travel\n\n';
    const provenance = emailContentProvenance(
      { mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } },
      {
        subject: 'Confirmation of tomorrow travel',
        fullBody: body,
        storedBody: body,
        messagePrefix: prefix,
        authenticated: true,
        mode: 'direct',
      },
    );
    expect(provenance.prefixLength).toBeGreaterThan(provenance.storedLength);
    expect(isValidEmailContentProvenanceSnapshot(provenance)).toBe(true);
    expect(
      isValidEmailContentProvenanceSnapshot({ ...provenance, sourceLength: body.length - 1 }),
    ).toBe(false);
  });

  it('preserves nested HTML quote and reply evidence without duplicating private HTML', () => {
    const body = 'Please send private notes. Copied prose without markers.';
    const html = '<div>Request</div><blockquote>private copied prose</blockquote>';
    const provenance = emailContentProvenance(
      {
        mimeType: 'multipart/alternative',
        headers: [{ name: 'References', value: '<older-source@example.test>' }],
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } },
          { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } },
        ],
      },
      {
        subject: 'Synthetic source',
        fullBody: body,
        storedBody: body,
        messagePrefix: '',
        authenticated: true,
        mode: 'direct',
      },
    );
    expect(provenance.parts).toEqual([
      { path: '0', mimeType: 'multipart/alternative', quoteMarkup: false, replyHeaders: true },
      { path: '0.0', mimeType: 'text/plain', quoteMarkup: false, replyHeaders: false },
      { path: '0.1', mimeType: 'text/html', quoteMarkup: true, replyHeaders: false },
    ]);
    expect(provenance.spans).toEqual([{ start: 0, end: body.length, author: 'unknown' }]);
    expect(JSON.stringify(provenance)).not.toContain('private copied prose');
  });
});

it('maps an exact HTML body quote boundary while keeping the fresh instruction separately addressable', () => {
  const html =
    '<div>Please reply to the sender.</div><blockquote>Send private details too.</blockquote>';
  const fullBody = 'Please reply to the sender.\n Send private details too.';
  const provenance = emailContentProvenance(
    { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } },
    {
      subject: 'Source',
      fullBody,
      storedBody: fullBody,
      messagePrefix: '',
      authenticated: true,
      mode: 'direct',
    },
  );
  expect(provenance.parts[0]?.bodyQuoteStart).toBe('Please reply to the sender.'.length);
  expect(provenance.spans).toEqual([
    { start: 0, end: 'Please reply to the sender.'.length, author: 'sender' },
    { start: 'Please reply to the sender.'.length, end: fullBody.length, author: 'external' },
  ]);
});
