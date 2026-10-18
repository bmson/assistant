import { createHash } from 'node:crypto';
import { z } from 'zod';

export const REPAIR_SOURCE_SNAPSHOT = 'docs/runtime-support-matrix.generated.json';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const verbs = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];
const Snapshot = z
  .object({
    format: z.literal(1),
    runtimeSources: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    webApiRouteCount: z.number().int().nonnegative(),
    routes: z.record(
      z.string(),
      z
        .object({
          methods: z.array(z.enum(verbs as [string, ...string[]])),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
  })
  .passthrough();

/** Derive evidence from source bytes; never execute generated code or accept model-written metadata. */
export function refreshRepairSourceSnapshot(
  original: string,
  changes: Array<{ path: string; text: string | null }>,
): string | null {
  const base = JSON.parse(original) as z.infer<typeof Snapshot>;
  Snapshot.parse(base);
  const snapshot = structuredClone(base);
  let changed = false;
  for (const file of changes) {
    if (Object.hasOwn(snapshot.runtimeSources, file.path)) {
      if (file.text === null) throw new Error('A required runtime source cannot be deleted');
      const digest = hash(file.text);
      changed ||= snapshot.runtimeSources[file.path] !== digest;
      snapshot.runtimeSources[file.path] = digest;
    }
    if (/^apps\/web\/app\/api\/(?:.+\/)?route\.ts$/.test(file.path)) {
      if (file.text === null) {
        changed ||= Object.hasOwn(snapshot.routes, file.path);
        delete snapshot.routes[file.path];
      } else {
        const text = file.text;
        const route = {
          methods: verbs
            .filter((method) =>
              new RegExp(
                `export\\s+(?:async\\s+)?(?:function\\s+${method}\\b|const\\s+${method}\\b)`,
              ).test(text),
            )
            .sort(),
          sha256: hash(text),
        };
        changed ||= JSON.stringify(snapshot.routes[file.path]) !== JSON.stringify(route);
        snapshot.routes[file.path] = route;
      }
    }
  }
  if (!changed) return null;
  // Match the checked-in generator's directory walk and Biome's short method arrays.
  const comparePath = (a: string, b: string) => {
    const left = a.split('/');
    const right = b.split('/');
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const order = (left[i] ?? '').localeCompare(right[i] ?? '');
      if (order) return order;
    }
    return 0;
  };
  snapshot.routes = Object.fromEntries(
    Object.entries(snapshot.routes).sort(([a], [b]) => comparePath(a, b)),
  );
  snapshot.webApiRouteCount = Object.keys(snapshot.routes).length;
  return `${JSON.stringify(snapshot, null, 2).replace(
    /("methods": )\[[\s\S]*?\]/g,
    (_all, prefix) => {
      const array = JSON.parse(_all.slice(prefix.length));
      return prefix + JSON.stringify(array).replaceAll(',', ', ');
    },
  )}\n`;
}
