/** A calendar-only Google grant, separate from the assistant's mailbox identity. */
export interface CalendarAccount {
  /** Verified Google subject, stable when the address changes. */
  id: string;
  email: string;
  clientId: string;
  refreshTokenEncrypted: string;
  scopes: string[];
  lastError: string | null;
  updatedAt: Date;
}

export interface CalendarAccountRepository {
  list(): Promise<CalendarAccount[]>;
  save(account: CalendarAccount): Promise<void>;
  remove(id: string): Promise<void>;
  /** Credential comparison prevents an old request from overwriting a reconnect. */
  recordError(id: string, credential: string, error: string | null): Promise<void>;
}
