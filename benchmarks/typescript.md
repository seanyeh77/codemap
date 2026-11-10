# TypeScript backend benchmark

The baseline for the TypeScript backend's accuracy and cost on real projects. Rerun it after a change
to the backend and compare; a change that loses repository edges, or changes a resolution, needs a
reason.

## Setup

- codemap: the commit that adds this file. TypeScript is the project's own when it is 5.x or 6.x,
  otherwise codemap's pinned 5.9.3.
- Machine: 2 CPU cores, 7 GB of memory, Node.js 22.23.4, Linux.
- Projects, at these commits:

| Project | Commit | Lockfile | Install |
|---|---|---|---|
| shadcn-ui/taxonomy | 298a8857c712 | pnpm-lock.yaml (lockfile 6.0) | pnpm 8, `--frozen-lockfile --ignore-scripts`: done; its TypeScript is 4.7.4, so codemap used 5.9.3 |
| excalidraw/excalidraw | 701b901a0f1b | yarn.lock | yarn 1.22.22, `--frozen-lockfile --ignore-scripts`: done; TypeScript 5.9.3 |
| TanStack/query | 8f6da1e2a1b5 | pnpm-lock.yaml (lockfile 9.0) | pnpm 12.4.2 (its packageManager), `--frozen-lockfile --ignore-scripts`: done; TypeScript 6.0.3 |
| brocoders/nestjs-boilerplate | 9620f159eefe | package-lock.json | `npm ci --ignore-scripts` failed: the lockfile is out of sync with package.json (`Missing: gcp-metadata@7.0.1 from lock file`); not repaired, so it is measured without types only |
| seanyeh77/cf-portal (web/) | c85aad1dbb4b | package-lock.json | `npm ci --ignore-scripts`: done; TypeScript 5.9.3 |

Every install ran in a copy of the project, with no lifecycle scripts and with no credentials in the
environment (only PATH, an empty HOME, and the proxy and CA settings).

Time and memory are the helper's own (`stats.ms`, `stats.max_rss_mb`); `CODEMAP_TS_DEBUG=1` adds
the time of each phase.

## Results

Repo calls are calls between the project's own definitions; library calls go to `ext:` nodes.

| Project | Types | Files (個) | Programs (個) | TypeScript | Time (s) | Peak RSS (MB) | Repo calls exact (條) | Inferred (條) | Ambiguous (條) | Library calls (條) | Refs (條) | Unresolved (處) | Packages not found (個) | Incomplete files (個) |
|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| shadcn-ui/taxonomy | without node_modules | 129 | 1 | 5.9.3 | 2.6 | 217 | 382 | 11 | 0 | 620 | 89 | 166 | 50 | 109 |
| shadcn-ui/taxonomy | with node_modules | 129 | 1 | 5.9.3 | 11.5 | 733 | 382 | 11 | 0 | 743 | 89 | 43 | 1 | 14 |
| excalidraw/excalidraw | without node_modules | 710 | 5 | 5.9.3 | 40.1 | 871 | 27816 | 627 | 1157 | 12317 | 8682 | 24212 | 60 | 496 |
| excalidraw/excalidraw | with node_modules | 710 | 5 | 5.9.3 | 56.3 | 1449 | 27984 | 693 | 1349 | 33916 | 8682 | 2262 | 5 | 37 |
| TanStack/query | without node_modules | 2153 | 54 | 5.9.3 | 66.7 | 1341 | 23509 | 1169 | 2011 | 42381 | 16127 | 24717 | 117 | 1546 |
| TanStack/query | with node_modules | 2153 | 54 | 6.0.3 | 209.3 | 1862 | 23942 | 1183 | 2099 | 59873 | 16128 | 6746 | 8 | 107 |
| seanyeh77/cf-portal (web) | without node_modules | 42 | 1 | 5.9.3 | 3.2 | 235 | 818 | 1 | 67 | 1004 | 611 | 1273 | 7 | 30 |
| seanyeh77/cf-portal (web) | with node_modules | 42 | 1 | 5.9.3 | 9.0 | 428 | 820 | 1 | 67 | 2224 | 611 | 51 | 0 | 2 |
| brocoders/nestjs-boilerplate | without node_modules | 173 | 1 | 5.9.3 | 2.4 | 216 | 206 | 0 | 0 | 1167 | 166 | 616 | 36 | 131 |

| Project | Types | Programs (ms) | Values pass (ms) | Diagnostics (ms) | Calls (ms) |
|---|---|---:|---:|---:|---:|
| shadcn-ui/taxonomy | without node_modules | 1485 | 544 | 281 | 550 |
| shadcn-ui/taxonomy | with node_modules | 6538 | 3584 | 1090 | 1319 |
| excalidraw/excalidraw | without node_modules | 10337 | 20106 | 4120 | 9606 |
| excalidraw/excalidraw | with node_modules | 18086 | 26976 | 5943 | 11134 |
| TanStack/query | without node_modules | 31153 | 22970 | 5289 | 12465 |
| TanStack/query | with node_modules | 108321 | 71447 | 18532 | 29289 |
| seanyeh77/cf-portal (web) | without node_modules | 1262 | 1145 | 384 | 753 |
| seanyeh77/cf-portal (web) | with node_modules | 2912 | 3894 | 1712 | 2154 |

## Typed against untyped

Installing the dependencies never removed a call between the project's own definitions and never
changed the resolution of one: what was found without types is found with them, the same way.

| Project | Repo edges without types (條) | With types (條) | Only without types (條) | Only with types (條) | Resolution changed (條) |
|---|---:|---:|---:|---:|---:|
| shadcn-ui/taxonomy | 482 | 482 | 0 | 0 | 0 |
| excalidraw/excalidraw | 38282 | 38708 | 0 | 426 | 0 |
| TanStack/query | 42816 | 43352 | 0 | 536 | 0 |
| seanyeh77/cf-portal (web) | 1497 | 1499 | 0 | 2 | 0 |

What types add is mostly calls on values a library returns or types: `setX()` from `useState`
(`react.Dispatch`), solid-js accessors and setters, `.then`/`.catch` on promises, methods of a
library's objects, and calls on the project's own classes reached through a library's generic
(`queryClient.invalidateQueries`, `observer.trackResult`).

## Spot checks (with types)

Each was read against the source:

- React hooks: `setIsSubmitting(true)`, `setState(state + 1)` go to `ext:react.Dispatch`, inferred
  (excalidraw 223, TanStack Query 139 React and 131 Preact, cf-portal 177).
- Promise: `.then` 1761, `.catch` 372, `.finally` 5 calls in TanStack Query, named `Promise.then`.
- Generics: `this.#queryCache.build(this, defaultedOptions)`, `onlineManager.subscribe(...)`,
  `query.isDisabled()` in `QueryClient` resolve exactly through generic classes.
- Decorators: 88 in TanStack Query's Angular packages (`@Component` 65, `@Injectable` 22,
  `@Directive` 1) and 576 in nestjs-boilerplate, each from its class.
- Dependency injection: Angular's `injectQueryClient()` values reach `QueryClient.isMutating`,
  `QueryClient.getQueryCache` exactly (33 of 38 calls into query-core by type); Nest services called
  through constructor parameters resolve by type (without types: the repository's own services).
- Values: `mutation.mutateAsync` reaches `MutationObserver.mutate` (a bound method),
  `retryDelay ?? defaultRetryDelay` stays ambiguous and partial.

## Profiling the programs

`CODEMAP_TS_PROFILE=1` (with `CODEMAP_TS_DEBUG=1`) adds, per program, the files it loaded by where
they come from and what parsing them cost, the time of each phase, and the heap after a forced
collection; and, per file, how many programs loaded it. Type checking now runs before extraction,
so the extraction time is reading the checker's results, not checking. The graph is the same as
before the reordering (every edge and node compared on TanStack Query).

Both projects with their dependencies installed, same machine as above:

| Project | Programs (個) | Total (ms) | Config (ms) | Program creation (ms) | Type checking (ms) | Extraction (ms) | Peak RSS (MB) | Largest heap after a program (MB) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| excalidraw | 5 | 58678 | 103 | 16445 | 29546 | 8691 | 1943 | 858 |
| TanStack Query | 54 | 224891 | 610 | 104591 | 85901 | 14333 | 1843 | 1601 |

| Project | Files from | Different files (個) | Loads over all programs (個) | Loads per file | Parsed text (MB) | Parse time (ms) |
|---|---|---:|---:|---:|---:|---:|
| excalidraw | TypeScript lib.*.d.ts | 87 | 381 | 4.4 | 12 | 1200 |
| excalidraw | node_modules | 1198 | 2149 | 1.8 | 28 | 4599 |
| excalidraw | repository source | 713 | 2254 | 3.2 | 28 | 5049 |
| excalidraw | repository .d.ts | 13 | 24 | 1.8 | 0 | 5 |
| TanStack Query | TypeScript lib.*.d.ts | 99 | 3996 | 40.4 | 172 | 18757 |
| TanStack Query | node_modules | 4650 | 27057 | 5.8 | 312 | 43366 |
| TanStack Query | repository source | 2181 | 5882 | 2.7 | 40 | 8338 |
| TanStack Query | repository .d.ts | 107 | 108 | 1.0 | 0 | 5 |

Program creation is reading and parsing files plus module resolution: in TanStack Query 70 s of the
105 s is parsing, 43 s of it `node_modules` declaration files. Each of the 4,650 different
`node_modules` files is parsed by 5.8 programs on average and each of the 99 `lib.*.d.ts` files by
40. 36 of the 54 programs own 20 files or fewer (example and integration apps), and they take 59 s of
the 105 s: each loads 300 to 1,000 library files for a handful of its own. Type checking is the
compiler's own work and is dominated by the largest program (`tsconfig.json` and 14 configs with the
same options: 23 s of the 86 s).

### What was tried

Each run on TanStack Query with its dependencies; the graph (every edge and node) was compared with
the first run and was the same in every one that finished.

| Change | Total (ms) | Program creation (ms) | Peak RSS (MB) | Kept |
|---|---:|---:|---:|---|
| None (the helper's own resolution without a cache) | 237270 | 117106 | 1849 | the control |
| A module-resolution cache per program, as the compiler keeps when it resolves by itself | 224891 | 104591 | 1843 | yes: the compiler's normal behavior, same graph |
| `oldProgram`: each program created from the one before | 216128 | 104271 | 1850 | no: no file is reused (27,057 `node_modules` loads either way), because programs with the same options are already one program and the compiler reuses nothing across different options; the shorter total is run-to-run noise in type checking |
| Parsed `node_modules` and `lib` files shared between programs with the same parse options | killed | killed | over 7 GB | no: the process ran out of memory; the shared files and every checker's data on them stay alive |
| Only `lib.*.d.ts` shared | 261367 | 104544 | 3422 | no: no time saved, memory almost doubled |

Configs with different options are not merged into one program: `paths`, `strict`, `jsx`,
`moduleResolution`, `target` and `module` change what the code means. Only configs that differ in
what they emit share a program.

### Open options

- Run programs in parallel worker processes: shorter on a machine with more cores, memory
  multiplied by the workers.
- Leave example and integration apps out with the existing `"scope"` in `.codemap/rules.json`
  when they are not what the map is for: they are two thirds of TanStack Query's programs and more
  than half of its program creation.
- Keep each program's result keyed by the hashes of the files it loaded, and skip a program whose
  files did not change on the next index.

## Program cache

Each program's results are kept with every question the program asked while it was built and
analyzed (files read and a hash of their content, files and directories looked for, `realpath`,
`@types` directories, which files are the repository's and which are tests), under a key of the
helper's own code, the TypeScript and Node versions, the configs' options and file lists, the files
the program owns and the workspace packages. A run asks the questions again and replays a program
when every answer is the same; otherwise it builds and analyzes the program as before.

Six cases on TanStack Query with its dependencies, applied one after another to the isolated copy and
then reverted. Each was compared with a run without the cache on the same tree: every edge (in
order), every node and every count was the same in all of them.

| Case | Change | Programs replayed (個) | Programs built (個) | Why rebuilt | With the cache (ms) | Without the cache (ms) | Graph |
|---|---|---:|---:|---|---:|---:|---|
| 1 | none, empty cache (first run) | 0 | 54 | no entry | 176771 | 213267 | same; cache written: 54 entries, 78 MB |
| 2 | none, warm (two runs) | 54 | 0 | | 1696 and 1802 | 213267 | same |
| 3 | two calls added in `examples/react/basic/src/index.tsx` | 53 | 1 | content | 9834 | 168650 | same; 2 edges more than case 2 |
| 4 | one call added in `packages/query-core/src/queryClient.ts` | 4 | 50 | content: 50 programs read query-core's source | 168051 | 173132 | same; 2 edges more |
| 5a | a new file in `examples/react/simple/src` | 53 | 1 | its program owns another file | 9393 | 172789 | same |
| 5b | `packages/query-core/src/__tests__/subscribable.test.tsx` deleted | 53 | 1 | its program owns one file fewer | 29136 | 169127 | same; 94 edges fewer |
| 6 | an option in `examples/vue/basic/tsconfig.json` and a line in goober's `.d.ts` in `node_modules` | 23 | 31 | 1 config, 30 programs that read goober | 112522 | 172606 | same |

Times are the helper's own; the run without the cache varied between 168 s and 213 s on this
machine. A warm run spends its time reading the configs (0.5 s) and asking the questions again
(reading and hashing every file the programs read). The unit test (`TsProgramCache`) covers the same
kinds of change on the fixture, including a missing package that gets installed (a lookup, not a
content change).

### Real development history

The last 30 commits of TanStack Query (3ccb007 to 8f6da1e, 2026-11-05 to 2026-11-07), checked out
one after another in the isolated copy and indexed after each with the cache; `node_modules` stayed
as installed from the newest lockfile, as in a checkout where nobody reinstalls. Step 00 starts with
an empty cache. "Before" is the first run of this replay; the second run records each lookup of a
workspace package as one of the program's questions, so a change to a package a program never
imports no longer rebuilds it (step 11: a new entry in two devtools packages' `exports`, 54 programs
rebuilt before, 12 after).

| Step | Commit | Files changed (個) | TS/JS changed (個) | Kind | Rebuilt before (個) | Time before (s) | Replayed (個) | Rebuilt (個) | Why rebuilt | Time (s) |
|---:|---|---:|---:|---|---:|---:|---:|---:|---|---:|
| 00 | 3ccb007 | 0 | 0 | cold | 54 | 155.9 | 0 | 54 | no entry 54 | 177.5 |
| 01 | 8f5144b | 1 | 0 | docs | 0 | 1.6 | 54 | 0 |  | 1.8 |
| 02 | f69b28a | 12 | 10 | docs/tests/source | 29 | 98.0 | 25 | 29 | content 28, no entry 1 | 96.8 |
| 03 | e712412 | 3 | 2 | docs/tests/source | 7 | 39.7 | 47 | 7 | content 6, no entry 1 | 42.6 |
| 04 | 16d863a | 1 | 0 | docs | 0 | 1.6 | 54 | 0 |  | 1.6 |
| 05 | 925168e | 205 | 0 | package.json/docs | 50 | 160.7 | 4 | 50 | content 50 | 173.1 |
| 06 | f078a2b | 8 | 5 | package.json/docs/tests/source | 10 | 37.5 | 44 | 10 | content 9, no entry 1 | 42.3 |
| 07 | b165677 | 3 | 1 | package.json/source | 1 | 5.7 | 53 | 1 | content 1 | 5.9 |
| 08 | c4ed956 | 7 | 6 | docs/tests/source | 30 | 99.8 | 24 | 30 | content 30 | 108.6 |
| 09 | 284abac | 201 | 0 | package.json/docs | 50 | 173.4 | 4 | 50 | content 50 | 177.5 |
| 10 | 9dbf992 | 1 | 0 | docs | 0 | 1.8 | 54 | 0 |  | 2.0 |
| 11 | a8c2a17 | 14 | 5 | package.json/docs/tests/source | 54 | 167.6 | 42 | 12 | content 10, no entry 2 | 70.9 |
| 12 | c34ce05 | 2 | 0 | docs | 0 | 1.7 | 54 | 0 |  | 2.1 |
| 13 | 2cdba60 | 5 | 4 | docs/tests/source | 7 | 41.2 | 47 | 7 | content 7 | 43.4 |
| 14 | d07ed19 | 5 | 0 | docs | 0 | 1.8 | 54 | 0 |  | 1.9 |
| 15 | 00dc8de | 3 | 2 | docs/tests/source | 7 | 42.9 | 47 | 7 | content 7 | 42.7 |
| 16 | b6add89 | 3 | 2 | docs/tests/source | 50 | 169.1 | 4 | 50 | content 50 | 177.0 |
| 17 | 172fd2a | 14 | 0 | docs | 0 | 1.6 | 54 | 0 |  | 1.8 |
| 18 | a4d72f7 | 8 | 7 | docs/tests/source | 30 | 106.5 | 24 | 30 | content 30 | 104.0 |
| 19 | d01e358 | 204 | 0 | package.json/docs | 50 | 169.5 | 4 | 50 | content 50 | 171.3 |
| 20 | 025773a | 8 | 7 | docs/tests/source | 7 | 41.3 | 47 | 7 | content 7 | 43.6 |
| 21 | f4199ab | 6 | 4 | docs/tests/source | 7 | 42.1 | 47 | 7 | content 7 | 42.8 |
| 22 | 82fe952 | 14 | 0 | docs | 0 | 1.8 | 54 | 0 |  | 1.4 |
| 23 | 3875d1d | 201 | 0 | package.json/docs | 50 | 172.5 | 4 | 50 | content 50 | 171.6 |
| 24 | 9705a4c | 1 | 1 | tests | 1 | 16.4 | 53 | 1 | content 1 | 16.1 |
| 25 | ef6f3e0 | 1 | 1 | tests | 1 | 15.7 | 53 | 1 | content 1 | 15.7 |
| 26 | cb755b9 | 7 | 1 | docs/source | 4 | 26.0 | 50 | 4 | content 4 | 26.2 |
| 27 | 5174c71 | 6 | 0 | docs | 0 | 1.7 | 54 | 0 |  | 1.7 |
| 28 | e676aa7 | 2 | 1 | docs/source | 7 | 44.0 | 47 | 7 | content 7 | 41.5 |
| 29 | 9a9ded3 | 10 | 3 | docs/source | 7 | 44.6 | 47 | 7 | content 7 | 43.2 |
| 30 | 8f6da1e | 7 | 0 | docs | 0 | 1.9 | 54 | 0 |  | 1.7 |

- Programs rebuilt over the 30 steps: 459 of 1,620 (28 %) before, 417 (26 %) after. Total time:
  1,730 s before, 1,673 s after; without the cache each step takes 162 s to 172 s on this machine
  (steps 05, 15 and 30, measured), about 5,000 s for the 30.
- Nine steps change only documentation: every program replayed, 1.4 s to 2.1 s.
- Four steps (05, 09, 19, 23) are releases: about 200 `package.json` versions and changelogs, no
  TypeScript or JavaScript. Each rebuilds 50 programs, 200 of the 417, because the compiler reads the
  workspace packages' `package.json` through their `node_modules` links, and it uses `version` (in
  the package id it gives files of `node_modules` packages). The cache keeps that answer as it is.
- Steps that change `query-core` (16) or the devtools (02, 08, 18) rebuild 30 to 50 programs: the
  limit of a program as the unit.
- At steps 05, 15 and 30 the graph was compared with a run without the cache on the same commit:
  every edge (in order), node and count was the same. The regression run below compares every step.
- The cache ended at 54 entries, 78 MB: an entry is replaced when its program is rebuilt, and the
  entries an earlier format of the prototype left were removed.

### Correctness regression: every commit compared

`benchmarks/ts_cache_regression.py` replays the same 30 commits from an empty cache and, at every
commit, indexes with the cache and without it and compares the two: every edge in order, every node,
every count. It is the regression suite for the cache: rerun it after any change to the helper.

    uv run python benchmarks/ts_cache_regression.py /path/to/a/copy --commits 30 --out /tmp/regress

The run with the code of this commit (the checksum covering the whole entry):

| Step | Commit | Files changed (個) | TS/JS changed (個) | Replayed (個) | Rebuilt (個) | Why rebuilt | With the cache (s) | Without (s) | Edges (條) | Same graph |
|---:|---|---:|---:|---:|---:|---|---:|---:|---:|---|
| 00 | 3ccb007 | 0 | 0 | 0 | 54 | no entry 54 | 174.2 | 163.8 | 101303 | yes |
| 01 | 8f5144b | 1 | 0 | 54 | 0 |  | 3.7 | 159.5 | 101303 | yes |
| 02 | f69b28a | 12 | 10 | 25 | 29 | content 28, no entry 1 | 100.5 | 163.6 | 102412 | yes |
| 03 | e712412 | 3 | 2 | 47 | 7 | content 6, no entry 1 | 42.9 | 168.0 | 102485 | yes |
| 04 | 16d863a | 1 | 0 | 54 | 0 |  | 4.1 | 159.4 | 102485 | yes |
| 05 | 925168e | 205 | 0 | 4 | 50 | content 50 | 165.8 | 167.5 | 102485 | yes |
| 06 | f078a2b | 8 | 5 | 44 | 10 | content 9, no entry 1 | 40.6 | 158.8 | 102454 | yes |
| 07 | b165677 | 3 | 1 | 53 | 1 | content 1 | 8.1 | 161.8 | 102454 | yes |
| 08 | c4ed956 | 7 | 6 | 24 | 30 | content 30 | 101.8 | 165.8 | 102517 | yes |
| 09 | 284abac | 201 | 0 | 4 | 50 | content 50 | 178.6 | 189.7 | 102517 | yes |
| 10 | 9dbf992 | 1 | 0 | 54 | 0 |  | 4.2 | 166.9 | 102517 | yes |
| 11 | a8c2a17 | 14 | 5 | 42 | 12 | content 10, no entry 2 | 70.5 | 167.1 | 102529 | yes |
| 12 | c34ce05 | 2 | 0 | 54 | 0 |  | 4.4 | 168.5 | 102529 | yes |
| 13 | 2cdba60 | 5 | 4 | 47 | 7 | content 7 | 46.2 | 173.4 | 102558 | yes |
| 14 | d07ed19 | 5 | 0 | 54 | 0 |  | 3.6 | 168.1 | 102558 | yes |
| 15 | 00dc8de | 3 | 2 | 47 | 7 | content 7 | 48.6 | 166.5 | 102583 | yes |
| 16 | b6add89 | 3 | 2 | 4 | 50 | content 50 | 181.5 | 172.1 | 102596 | yes |
| 17 | 172fd2a | 14 | 0 | 54 | 0 |  | 4.0 | 153.5 | 102596 | yes |
| 18 | a4d72f7 | 8 | 7 | 24 | 30 | content 30 | 95.3 | 169.0 | 103007 | yes |
| 19 | d01e358 | 204 | 0 | 4 | 50 | content 50 | 171.1 | 172.0 | 103007 | yes |
| 20 | 025773a | 8 | 7 | 47 | 7 | content 7 | 47.2 | 159.9 | 103066 | yes |
| 21 | f4199ab | 6 | 4 | 47 | 7 | content 7 | 41.3 | 167.1 | 103232 | yes |
| 22 | 82fe952 | 14 | 0 | 54 | 0 |  | 4.0 | 171.8 | 103232 | yes |
| 23 | 3875d1d | 201 | 0 | 4 | 50 | content 50 | 165.5 | 155.9 | 103232 | yes |
| 24 | 9705a4c | 1 | 1 | 53 | 1 | content 1 | 18.2 | 156.5 | 103232 | yes |
| 25 | ef6f3e0 | 1 | 1 | 53 | 1 | content 1 | 17.8 | 162.0 | 103232 | yes |
| 26 | cb755b9 | 7 | 1 | 50 | 4 | content 4 | 27.3 | 174.3 | 103232 | yes |
| 27 | 5174c71 | 6 | 0 | 54 | 0 |  | 4.4 | 167.5 | 103232 | yes |
| 28 | e676aa7 | 2 | 1 | 47 | 7 | content 7 | 42.9 | 171.9 | 103232 | yes |
| 29 | 9a9ded3 | 10 | 3 | 47 | 7 | content 7 | 41.6 | 152.0 | 103232 | yes |
| 30 | 8f6da1e | 7 | 0 | 54 | 0 |  | 3.5 | 152.7 | 103232 | yes |

- The graph with the cache was the same as without it at all 31 commits (101,303 to 103,232 edges).
- Steps 1 to 30: 417 of 1,620 programs rebuilt; 1,689.2 s with the cache (median 41.5 s), 4,962.8 s
  without it (median 167.0 s, from 152.0 s to 189.7 s). The cache's per-step times include the
  questions asked again (about 2 s on a warm step).

A program is the unit: case 4 shows its limit. A body changed in a package that 50 programs import
rebuilds those 50, though only one function's calls changed.

## Cost to watch

TanStack Query with its dependencies: 54 programs (36 of them a single example or integration app
with options of its own), 209 s and 1.9 GB peak memory in this run (4.8 GB in another run of the
same code: the peak depends on when Node collects); 108 s of it is building the programs, each
loading the libraries' types again. This is the case to optimize on its own.
