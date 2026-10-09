/** A validated, freshness-checked owner location observation. */
export interface LocationPingWrite {
  lat: number;
  lng: number;
  label: string;
  accuracyM: number | null;
  source: string;
  timeZone: string | null;
  capturedAt: Date;
  /** Explicit, per-ping consent for short-lived arrival processing. */
  arrivalOptIn?: boolean;
}

export interface LocationPingReference {
  id: string;
  arrivalExpiresAt: Date | null;
}

/** The fields the arrival decision reads from earlier observations. */
export interface RecentLocationPing {
  lat: number;
  lng: number;
  accuracyM: number | null;
  capturedAt: Date;
}

/**
 * Transient owner location pings plus the one lookup the arrival nudge needs.
 * Implementations treat `agentId` as an authorization boundary.
 */
export interface LocationPingRepository {
  readonly kind: 'location-ping-repository';
  record(agentId: string, ping: LocationPingWrite): Promise<LocationPingReference>;
  /** Pings captured in `[from, before)`, newest first. */
  recent(agentId: string, window: { from: Date; before: Date }): Promise<RecentLocationPing[]>;
  /** Whether an arrival nudge task was created for this agent at or after `since`. */
  hasArrivalTaskSince(agentId: string, since: Date): Promise<boolean>;
  /** A reference is usable only for its owner and only until its explicit expiry. */
  isArrivalObservationActive(agentId: string, id: string, now: Date): Promise<boolean>;
}
