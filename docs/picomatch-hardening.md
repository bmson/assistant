# Picomatch repeated-extglob restriction

Picomatch 4.0.7 is affected by [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf). The advisory and npm registry listed no released fix when checked on November 18, 2026. This workspace applies an exact-version local patch to prevent the parser from compiling repeated `+(...)` and `*(...)` extglobs. Compilation raises a `SyntaxError`, including when the caller disables the upstream recursion guard.

This restriction deliberately rejects legitimate repeated patterns such as `+(js|jsx)`. Ordinary globs, braces, optional and single-choice extglobs retain their tested behavior. Arbitrary regular-expression syntax and caller-created parse states remain outside the mitigation; glob patterns should continue to come from trusted tooling configuration.

`package.json` registers `patches/picomatch@4.0.7.patch`, and the lockfile records its hash. The installed-graph regression verifies the exact patch and parser SHA-256, then exercises the reported patterns, a nested counterexample, options, arrays, ignore patterns, exposed fastpaths and ordinary matching in subprocesses with hard timeouts. CI runs this regression before its audit command. All six runtime/migration Docker build contexts copy the patch before frozen installation, and patch changes trigger image qualification.

The audit has one exact advisory exemption because the registry assesses the upstream version without observing these patched bytes. The exemption remains tied to this patch and its mandatory regression, which rejects additional Picomatch versions, unpatched snapshots and unpatched resolved references anywhere in the frozen graph. Updating or removing the patch requires reviewing the restriction, lockfile, exemption and regression together. Replace the local restriction with an upstream fix once that fix is available and qualified.

The inspected resolved graph reaches Picomatch through Vitest, Vite and Tinyglobby. No direct application calls were found in the source search, and the resolved production dependency graph contained no Picomatch entry. Those results describe the source and dependency graph; image qualification and deployed runtime evidence remain separate.

The same release updates Next.js to 16.4.5 for its [root-parameter cache disclosure fixes](https://github.com/vercel/next.js/releases/tag/v16.4.5). Unrelated transitive versions remain pinned.
