export type MobileWorkspaceSectionAvailability = {
  status: 'available' | 'unavailable';
  version: 1;
  message?: string;
};

export type MobileWorkspaceSectionResult<T> = {
  value: T | null;
  availability: MobileWorkspaceSectionAvailability;
};

/** Bound each dashboard read so one slow integration cannot hold every screen. */
export async function readMobileWorkspaceSection<T>(
  read: Promise<T> | (() => Promise<T>),
  timeoutMs = 4_000,
): Promise<MobileWorkspaceSectionResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = typeof read === 'function' ? read() : read;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('section timeout')), timeoutMs);
    });
    const value = await Promise.race([pending, timeout]);
    return { value, availability: { status: 'available', version: 1 } };
  } catch {
    return {
      value: null,
      availability: {
        status: 'unavailable',
        version: 1,
        message: 'This section could not be loaded. Refresh to try again.',
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
