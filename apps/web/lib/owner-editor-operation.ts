import {
  OWNER_EDITOR_MAX_BODY_BYTES,
  ownerEditorCanonicalApply,
  parseOwnerEditorRequest,
} from '@assistant/application/owner-editor-wire';
import type {
  OwnerEditorFormGrant,
  OwnerEditorReply,
  OwnerEditorRequest,
  OwnerEditorSessionView,
} from '@assistant/persistence/owner-editor';
import { readBoundedResponseBody } from './bounded-response';
import {
  clearOwnerEditorPendingMarker,
  decodeOwnerEditorReply,
  type OwnerEditorPendingMarker,
  type OwnerEditorStorage,
  ownerEditorRoute,
  readOwnerEditorPendingMarker,
  writeOwnerEditorPendingMarker,
} from './owner-editor-client';

export interface OwnerEditorOperationState {
  phase: 'checking' | 'ready' | 'pending' | 'resolved' | 'blocked';
  reviewRequired: boolean;
  reviewTargetId: string | null;
  marker: OwnerEditorPendingMarker | null;
  busy: boolean;
  reply: OwnerEditorReply | null;
  fieldErrors: Record<string, string>;
  message: string;
}
const INITIAL: OwnerEditorOperationState = {
  phase: 'checking',
  reviewRequired: false,
  reviewTargetId: null,
  marker: null,
  busy: false,
  reply: null,
  fieldErrors: {},
  message: '',
};
const sameMarker = (a: OwnerEditorPendingMarker | null, b: OwnerEditorPendingMarker) =>
  a?.id === b.id && a.command === b.command && a.targetId === b.targetId;

/** The actual controls use this controller. Only opaque pending metadata is persisted. */
export class OwnerEditorOperation {
  private state = INITIAL;
  private listeners = new Set<() => void>();
  private generation = 0;
  private originalOperationId: string | null = null;
  private originalRequestHash: string | null = null;
  private receiptBindingToken: string | null = null;
  private spent = new Set<string>();
  constructor(
    private readonly session: OwnerEditorSessionView,
    private readonly storage: () => OwnerEditorStorage,
    private readonly request: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}
  getSnapshot = () => this.state;
  getServerSnapshot = () => INITIAL;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<OwnerEditorOperationState>) {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  initialize() {
    if (this.state.phase !== 'checking') return;
    try {
      const marker = this.currentMarker();
      this.publish({
        phase: marker ? 'pending' : 'ready',
        marker,
        message: marker ? ownerEditorUncertaintyMessage(marker.command, true) : '',
      });
    } catch {
      this.blockStorage();
    }
  }
  private currentMarker() {
    return readOwnerEditorPendingMarker(
      this.storage(),
      this.session.ownerId,
      this.session.formSessionScope,
    );
  }
  private blockStorage() {
    this.publish({
      phase: 'blocked',
      busy: false,
      message:
        'This browser cannot safely track saves. No further save will be sent. Keep your draft and check the saved details.',
    });
  }
  /** Conflicts cannot silently adopt a new CAS/grant from refreshed props. */
  acceptFreshSnapshot(grants: OwnerEditorFormGrant[]) {
    if (this.state.reviewRequired) return false;
    return this.adoptFreshSnapshot(grants);
  }
  reviewFreshSnapshot(grants: OwnerEditorFormGrant[]) {
    if (
      !this.state.reviewRequired ||
      grants.some((grant) => grant.command !== this.state.reply?.command)
    )
      return false;
    return this.adoptFreshSnapshot(grants);
  }
  private adoptFreshSnapshot(grants: OwnerEditorFormGrant[]) {
    if (
      this.state.phase !== 'resolved' ||
      grants.length === 0 ||
      grants.some((g) => this.spent.has(g.operationId))
    )
      return false;
    try {
      if (this.currentMarker()) return false;
      this.publish({ phase: 'ready', marker: null, fieldErrors: {}, reviewRequired: false });
      return true;
    } catch {
      this.blockStorage();
      return false;
    }
  }
  async apply(value: unknown, grant: OwnerEditorFormGrant, targetId: string | null) {
    if (this.state.phase !== 'ready' || this.state.busy || this.spent.has(grant.operationId))
      return;
    const path = ownerEditorRoute(grant.command);
    // Shared browser-safe validator is authoritative for local syntax. No mirror.
    const parsed = parseOwnerEditorRequest(value, path);
    if (!parsed.ok) {
      this.publish({ fieldErrors: parsed.fieldErrors, message: 'Check the highlighted fields.' });
      return;
    }
    if (
      parsed.request.intent !== 'apply' ||
      parsed.request.command !== grant.command ||
      parsed.request.operationId !== grant.operationId ||
      !grant.issuedOperationHandle
    ) {
      this.publish({ fieldErrors: { request: 'Refresh this form before saving.' } });
      return;
    }
    if (
      new TextEncoder().encode(JSON.stringify(parsed.request)).byteLength >
      OWNER_EDITOR_MAX_BODY_BYTES
    ) {
      this.publish({
        fieldErrors: { request: 'This form is too large. Shorten the entered fields.' },
      });
      return;
    }
    // Admission is locked before asynchronous browser hashing: a second submit
    // cannot race past ready and reserve a different operation during digest.
    const admission = ++this.generation;
    this.publish({ busy: true });
    let originalHash: string;
    try {
      const subtle = globalThis.crypto?.subtle;
      if (!subtle) throw new Error('Browser cryptography is unavailable');
      const digest = await subtle.digest(
        'SHA-256',
        new TextEncoder().encode(ownerEditorCanonicalApply(parsed.request)),
      );
      originalHash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
    } catch {
      this.publish({
        phase: 'blocked',
        busy: false,
        message: 'This browser cannot verify save identity. No save was sent.',
      });
      return;
    }
    if (admission !== this.generation || this.state.phase !== 'ready') return;
    const marker = { id: grant.issuedOperationHandle, command: grant.command, targetId };
    try {
      writeOwnerEditorPendingMarker(
        this.storage(),
        this.session.ownerId,
        this.session.formSessionScope,
        marker,
      );
    } catch {
      // A sibling mounted control may have reserved the one session marker
      // after initialization. Adopt that exact old handle; never overwrite it.
      try {
        if (this.currentMarker()) {
          this.adoptCurrent();
          return;
        }
      } catch {
        /* Storage itself is unavailable: no dispatch. */
      }
      this.blockStorage();
      return;
    }
    this.originalOperationId = grant.operationId;
    this.originalRequestHash = originalHash;
    this.receiptBindingToken = null;
    this.publish({ phase: 'pending', marker, fieldErrors: {}, reply: null, message: 'Saving…' });
    await this.send(marker, parsed.request);
  }
  async check() {
    const marker = this.state.marker;
    if (this.state.phase !== 'pending' || !marker || this.state.busy) return;
    await this.send(marker, null);
  }
  /** Continue the original operation only when its authenticated proof is available. */
  async checkPendingResult() {
    if (this.canReconcile()) await this.reconcile();
    else await this.check();
  }
  async reconcile() {
    const marker = this.state.marker;
    if (
      this.state.phase !== 'pending' ||
      !marker ||
      this.state.busy ||
      !this.originalOperationId ||
      !this.receiptBindingToken
    )
      return;
    const request = {
      version: 1,
      intent: 'reconcile',
      command: marker.command,
      operationId: this.originalOperationId,
      receiptBindingToken: this.receiptBindingToken,
    };
    const parsed = parseOwnerEditorRequest(request, ownerEditorRoute(marker.command));
    if (!parsed.ok) return;
    const reconciliationProof = this.receiptBindingToken;
    this.receiptBindingToken = null;
    await this.send(marker, parsed.request, reconciliationProof);
  }
  canReconcile() {
    return !!this.receiptBindingToken && !!this.originalOperationId;
  }
  private async send(
    marker: OwnerEditorPendingMarker,
    body: OwnerEditorRequest | null,
    reconciliationProof: string | null = null,
  ) {
    const generation = ++this.generation;
    try {
      if (!sameMarker(this.currentMarker(), marker)) {
        this.adoptCurrent();
        return;
      }
    } catch {
      this.blockStorage();
      return;
    }
    this.publish({ busy: true });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10_000);
    try {
      const path = ownerEditorRoute(marker.command);
      const response = await this.request(
        body ? path : `${path}?operation=${encodeURIComponent(marker.id)}`,
        {
          method: body ? 'POST' : 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          signal: abort.signal,
          headers: {
            'X-Editor-Session-Scope': this.session.formSessionScope,
            'X-Editor-Form-Scope': marker.id,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      const bounded = await readBoundedResponseBody(response, 32_768);
      const reply = bounded.ok
        ? decodeOwnerEditorReply(JSON.parse(new TextDecoder().decode(bounded.bytes)))
        : null;
      if (generation !== this.generation) return;
      if (!sameMarker(this.currentMarker(), marker)) {
        this.adoptCurrent();
        return;
      }
      if (
        !reply ||
        reply.command !== marker.command ||
        (this.originalOperationId !== null && reply.operationId !== this.originalOperationId)
      ) {
        this.unknown();
        return;
      }
      // On reload only the exact captured OLD issued handle establishes the
      // operation UUID. A terminal receipt may establish its hash only after
      // the exact operation's GET-issued reconciliation proof; an unproved
      // POST or a new grant never supplies either binding.
      if (!body && reply.authority !== 'request_rejection') {
        this.originalOperationId = reply.operationId;
        if (this.originalRequestHash === null && reply.authority === 'operation_receipt')
          this.originalRequestHash = reply.requestHash;
      }
      if (reply.authority === 'request_rejection') {
        this.receiptBindingToken = null;
        this.publish({
          reply,
          busy: false,
          message: `This request was not accepted. The earlier ${ownerEditorActionNoun(marker.command)} is still unresolved; check its result.`,
        });
        return;
      }
      if (reply.authority === 'unresolved') {
        this.receiptBindingToken = reply.receiptBindingToken ?? null;
        this.publish({
          reply,
          busy: false,
          message: ownerEditorUncertaintyMessage(marker.command),
        });
        return;
      }
      if (reply.authority === 'operation_receipt') {
        if (
          this.originalRequestHash === null &&
          body?.intent === 'reconcile' &&
          reconciliationProof
        )
          this.originalRequestHash = reply.requestHash;
        if (this.originalRequestHash === null || reply.requestHash !== this.originalRequestHash) {
          this.unknown();
          return;
        }
      }
      const originalId = this.originalOperationId;
      if (
        !originalId ||
        !clearOwnerEditorPendingMarker(
          this.storage(),
          this.session.ownerId,
          this.session.formSessionScope,
          marker,
          reply,
          originalId,
          this.originalRequestHash ?? '',
        )
      ) {
        this.unknown();
        return;
      }
      this.spent.add(originalId);
      this.receiptBindingToken = null;
      this.publish({
        phase: 'resolved',
        reviewRequired: reply.authority === 'operation_receipt' && reply.outcome === 'conflict',
        reviewTargetId: marker.targetId,
        marker: null,
        busy: false,
        reply,
        message: ownerEditorOutcomeMessage(reply),
        fieldErrors:
          reply.authority === 'operation_receipt' && reply.outcome === 'invalid'
            ? reply.fieldErrors
            : {},
      });
    } catch {
      if (generation === this.generation) this.unknown();
    } finally {
      clearTimeout(timeout);
    }
  }
  private adoptCurrent() {
    this.generation++;
    this.originalOperationId = null;
    this.originalRequestHash = null;
    this.receiptBindingToken = null;
    const marker = this.currentMarker();
    this.publish({
      phase: marker ? 'pending' : 'blocked',
      marker,
      busy: false,
      reply: null,
      message: 'The tracked save changed. Check its result or reload the saved details.',
    });
  }
  private unknown() {
    this.publish({
      busy: false,
      message: ownerEditorUncertaintyMessage(this.state.marker?.command),
    });
  }
}

function ownerEditorActionNoun(command: OwnerEditorFormGrant['command'] | null | undefined) {
  return command === 'remove_person'
    ? 'person deletion'
    : command === 'remove_owner_family_relationship'
      ? 'connection removal'
      : command
        ? 'save'
        : 'operation';
}

/** Presentation only; the command comes from the tracked original, never a new form. */
export function ownerEditorUncertaintyMessage(
  command: OwnerEditorFormGrant['command'] | null | undefined,
  earlier = false,
): string {
  const noun = ownerEditorActionNoun(command);
  const subject = earlier ? `An earlier ${noun}` : noun[0].toUpperCase() + noun.slice(1);
  const next =
    command === 'remove_person'
      ? 'trying to delete again'
      : command === 'remove_owner_family_relationship'
        ? 'removing it again'
        : command
          ? 'saving again'
          : 'trying again';
  return `${subject} could not be confirmed. Check its result before ${next}.`;
}

export function ownerEditorOutcomeMessage(reply: OwnerEditorReply): string {
  if (reply.authority === 'scope_retirement')
    return `This earlier form has expired or been retired. This does not confirm whether ${reply.command === 'remove_person' ? 'the person was deleted' : reply.command === 'remove_owner_family_relationship' ? 'the connection was removed' : 'its save happened'}. Refresh saved details before editing again.`;
  if (reply.authority !== 'operation_receipt') return ownerEditorUncertaintyMessage(reply.command);
  switch (reply.outcome) {
    case 'saved':
      if (reply.command === 'remove_person')
        return reply.refreshPending
          ? 'Person deleted. Some derived details still need to refresh.'
          : 'Person deleted.';
      if (reply.command === 'remove_owner_family_relationship')
        return reply.refreshPending
          ? 'Connection removed. Some derived details still need to refresh.'
          : 'Connection removed.';
      return reply.refreshPending ? 'Saved. Some derived details still need to refresh.' : 'Saved.';
    case 'unchanged':
      return 'Already saved. No additional change was needed.';
    case 'not_applied':
      return 'This save was not applied. Refresh the saved details before trying a new edit.';
    case 'conflict':
      return 'Saved details changed. Review the latest saved values before editing again.';
    case 'invalid':
      return 'The save was not applied. Check the fields and refresh the form.';
    case 'unavailable':
      return 'This save was not applied. Editing is unavailable.';
  }
}
