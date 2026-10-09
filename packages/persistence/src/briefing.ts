import type { Records } from './records.js';

export type BriefingBookingOccurrence = Pick<
  Records['emailBookingOccurrences'],
  | 'bookingKey'
  | 'lifecycle'
  | 'dates'
  | 'sourceChannelMessageId'
  | 'sourceReceivedAt'
  | 'sourceAuthenticated'
  | 'version'
>;

/** Mail the briefing reads from the email-ingest pass. */
export interface BriefingMail {
  fromEmail: string;
  fromName: string | null;
  subject: string;
  category: string;
  importance: number;
  dates: unknown;
  channelMessageId: string;
  authenticated: boolean;
}

export interface BriefingInputs {
  /** Mail ingested inside the window, most important first. */
  mail: BriefingMail[];
  /** Latest authenticated, explicitly identified booking lifecycles. */
  bookings: BriefingBookingOccurrence[];
  /** Unarchived work that stopped for the owner inside the window, newest first. */
  attention: Array<{ title: string | null; progress: string }>;
  /** Unexpired approvals on unarchived work. */
  pending: Array<{ shortCode: string; summary: string }>;
  /** Goals changed inside the window, newest first. */
  goalDeltas: Array<{ title: string; status: string; nextAction: string; updatedAt: Date }>;
  /** Watch fires inside the window, newest first. */
  watchHits: Array<{ name: string; summary: string }>;
}

/** The `briefing.compose` job's reads. Composing and posting stay in core. */
export interface BriefingRepository {
  readonly kind: 'briefing-repository';
  inputs(
    agentId: string,
    window: {
      since: Date;
      now: Date;
      attentionLimit: number;
      pendingLimit: number;
      goalLimit: number;
      watchLimit: number;
    },
  ): Promise<BriefingInputs>;
}
