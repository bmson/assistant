/** What the proactive pipeline received and sent, for the owner's "Noticing" panel. */
export interface ProactiveHealthCounts {
  /** Counts by stage for the cohort received in the last seven days. */
  mailReceived7d: number;
  mailProcessed7d: number;
  mailPendingOver6h7d: number;
  mailAwaitingAdmissionOver6h7d: number;
  mailScored24h: number;
  mailScored7d: number;
  lastMailAt: Date | null;
  momentsDelivered24h: number;
  pingsDelivered24h: number;
  pingsHeld24h: number;
  /** Registered, non-invalidated push devices. */
  pushDevices: number;
}

export type MailHealthCounts = Pick<
  ProactiveHealthCounts,
  | 'mailReceived7d'
  | 'mailProcessed7d'
  | 'mailPendingOver6h7d'
  | 'mailAwaitingAdmissionOver6h7d'
  | 'mailScored24h'
  | 'mailScored7d'
  | 'lastMailAt'
> & { mailStalledAdmissionByStage: Partial<Record<MailAdmissionStage, number>> };

export interface MailHealthWindow {
  since6h: Date;
  since24h: Date;
  since7d: Date;
}

/** The counts behind the proactive-health view. The warnings stay in core. */
export interface ProactiveHealthRepository {
  readonly kind: 'proactive-health-repository';
  counts(agentId: string, window: MailHealthWindow): Promise<ProactiveHealthCounts>;
}

/** Unfinished, retryable ingress phases. A terminal review row is counted separately by Activity. */
export const PENDING_MAIL_ADMISSION_STAGES = [
  'pending_classification',
  'classifying',
  'pending_score',
  'scoring',
  'score_prepared',
  'message_persisted',
] as const;

export type MailAdmissionStage = (typeof PENDING_MAIL_ADMISSION_STAGES)[number];
