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

## Cost to watch

TanStack Query with its dependencies: 54 programs (36 of them a single example or integration app
with options of its own), 209 s and 1.9 GB peak memory in this run (4.8 GB in another run of the
same code: the peak depends on when Node collects); 108 s of it is building the programs, each
loading the libraries' types again. This is the case to optimize on its own.
