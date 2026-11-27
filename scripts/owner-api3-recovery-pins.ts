/** Reviewed evidence for the serving API 3 build, before the ordinary upgrade. */
export const ORDINARY_IDENTITY = {
  object:
    'owner-serving-image-identity/d6954975b72e5cf41357f050d9d6b036ccad7753/a6584d645f1f5b97e30b5a184d61bb599e3a3ad6e3b79fd04c59576e05f97265.json',
  generation: '1795755407667542',
  sha256: 'a6584d645f1f5b97e30b5a184d61bb599e3a3ad6e3b79fd04c59576e05f97265',
} as const;

/** All three replacement jobs were restored and exercised in the isolated project. */
export const ORDINARY_WORKERS = {
  object:
    'worker-recovery-qualification/b333b3c17cd1c3349dde13597c8d5261b138df15/1db51a47ac8130088790125ded674c1d3b409c63d33b7e6d78ce46d46ba0d99a.json',
  generation: '1795756807643462',
  sha256: '1db51a47ac8130088790125ded674c1d3b409c63d33b7e6d78ce46d46ba0d99a',
} as const;
