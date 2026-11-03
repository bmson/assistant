export type MobileBearerPrincipal =
  | { kind: 'configured_installation_bearer' }
  | { kind: 'owner_device_bearer'; deviceId: string };

export type MobileOwnerResolution =
  | { ok: true; ownerId: string }
  | { ok: false; reason: 'unavailable' };
