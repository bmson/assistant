/** Historical credential record retained only for released schema and backup compatibility. */
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
