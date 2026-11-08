# Process Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a wrapper argv is configured at server start, every process the server starts through the shared host spawner runs as `<wrapper…> <command> <args…>`; unset, nothing changes.

**Architecture:** `CrossSpawnSpawner` gains a `configured({ wrapper })` factory and a `Bypass` context reference; the prefix is applied in the `StandardCommand` case so piped segments are covered too. The server takes the wrapper from a new `experimental.process.wrapper` server option and installs the configured spawner as a standard replacement (same path as `windows.gitbash`); the CLI fills the option from `OPENCODE_PROCESS_WRAPPER` (a JSON array).

**Tech Stack:** TypeScript on Bun, Effect (`effect/process` ChildProcess, `Context.Reference`, `Layer`), `LayerNode` (`makeGlobalNode`), `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-08-process-wrapper-design.md` (read it with this plan). Spawn-site map: `/home/rq279/GitHub/opencode/.worktrees/research/reports/Process spawn map.md`.

## Global Constraints

- Branch `process-wrapper` off `origin/dev` (caf8d6a554), worktree `/home/rq279/GitHub/opencode/.worktrees/process-wrapper`. Local only: never push; the owner decides upstream later.
- Unset or empty wrapper → byte-for-byte unchanged behaviour (anti-goal: any change when unset).
- Core names no sandbox tool: no `nono`, `bwrap`, `firejail` in source, option names or messages (tests may use a generic recording wrapper script only).
- Server option name: `experimental.process.wrapper: ReadonlyArray<string>` in `ServerOptions`. Environment variable: `OPENCODE_PROCESS_WRAPPER`, a JSON array of strings. Invalid JSON or a non-array (or an array with a non-string) fails server start with an error naming `OPENCODE_PROCESS_WRAPPER`; it never falls back to unwrapped.
- No feature flag (the option is inert when unset); the PR body must say so.
- Out of scope (do not touch): PTY (`core/src/pty.ts`, `core/src/persistent-pty`), the `opencode-pty` daemon, the Claude Agent SDK's `claude` spawn, pacote's `git`, client-host spawns, the CLI's own spawner graph.
- Style: repo `AGENTS.md` (no `else`, no destructuring, no aliased/star imports, `const`, no `any`, no mocks/`globalThis`, Effect generators bind services to names). Read `.opencode/skills/unit-tests` before writing tests.
- Run `bun install` once in the worktree first (it has no `node_modules` yet). Tests run from package dirs with `bun run test <files>`; in this sandbox prefix `BUN_TMPDIR=$TMPDIR/buntmp BUN_INSTALL_CACHE_DIR=$TMPDIR/buncache BUN_INSTALL=$TMPDIR/buninstall`. Typecheck with `bun typecheck` in each touched package. Known sandbox baseline failures: core 14, server 63, cli 29.
- Git: conventional commits; identity `GIT_AUTHOR_NAME=Project579 GIT_COMMITTER_NAME=Project579 GIT_AUTHOR_EMAIL=star579avatar@gmail.com GIT_COMMITTER_EMAIL=star579avatar@gmail.com`, `git -c commit.gpgsign=false commit`. No bare `git stash`.

## Review Focus

1. `wrapper[0]` is a bare name (`"my-sandbox"`) resolved through `PATH`, not an absolute path → it resolves exactly as a bare command does today (node's own PATH lookup via cross-spawn; `executable()` is only a Windows Store-alias fix). Test in Task 1.
2. A wrapper that stays resident (does not `exec`, like some sandbox launchers) around a long-running process is stopped on timeout → the wrapper and its child both exit, because OpenCode kills the process group. Test in Task 1.
3. Redacted arguments (`Redacted` args to `ChildProcess.make`) under a wrapper → still passed through unredacted to the child and still redacted in logs/errors. Test in Task 1.
4. `OPENCODE_PROCESS_WRAPPER='[]'` or unset → identical to no wrapper; `'"x"'`, `'[1]'`, `'not json'` → server start fails naming the variable. Test in Task 3.
5. A command with `shell: true` (only the Windows worktree start sets it) → on POSIX it is still wrapped (the wrapper becomes the first word the shell runs); on Windows document the behaviour. Test (POSIX) in Task 1.

---

### Task 1: Wrapper in the shared spawner

**Files:**
- Modify: `packages/util/src/cross-spawn-spawner.ts` (`spawnCommand` `StandardCommand` case at :544; `layer`/`node` at :687-692)
- Test: `packages/core/test/effect/cross-spawn-spawner.test.ts` (existing spawner suite; add a `describe.skipIf(process.platform === "win32")("wrapper")` block — CI also runs Windows, the fixture is POSIX sh), fixture `packages/core/test/fixture/record-wrapper.sh`

**Interfaces:**
- Produces (`@opencode/util/cross-spawn-spawner`):
  - `configured(options?: { readonly wrapper?: ReadonlyArray<string> }): LayerNode.Provider<ChildProcessSpawner, …>` — a global node built like today's `node`; `node` becomes `configured()`.
  - `Bypass: Context.Reference<boolean>` (key `"@opencode/CrossSpawnSpawner/Bypass"`, default `false`) — when `true` in the caller's context, the command is not wrapped.
  - Rule: if `wrapper` is non-empty and `Bypass` is false, spawn `wrapper[0]` with args `[...wrapper.slice(1), command.command, ...command.args]` and the original options (cwd, env, stdio, shell, detached). Otherwise spawn as today. Apply after the NUL check of the original command.

- [ ] **Step 1: Fixture** `test/fixture/record-wrapper.sh` (executable, `#!/bin/sh`): `log=$1; shift`; if `$1` is `--resident`, `shift` and run `"$@" & echo $! >> "$log"; wait` (stays resident); otherwise `printf '%s
' "$*" >> "$log"; exec "$@"`. Every test configures `wrapper: [fixture, logpath]` (a wrapper that carries its own arguments).

- [ ] **Step 2: Failing tests** (compile `CrossSpawnSpawner.configured({ wrapper: [fixture, "--flag"] })` with `LayerNode.compile`, as the suite does for `node`):
  - `wraps a command with the configured argv`: run `echo hi`; stdout `hi`; log line `echo hi`.
  - `passes cwd and env through the wrapper`: `pwd` with `cwd: tmp` → `tmp`; `env` with `{ X: "1" }` → contains `X=1`.
  - `leaves commands unchanged without a wrapper`: `configured()` and `configured({ wrapper: [] })` → no log file written.
  - `skips wrapping under Bypass`: `Effect.provideService(CrossSpawnSpawner.Bypass, true)` → no log line.
  - `wraps each segment of a piped command`: `echo a | cat` → two log lines.
  - `resolves a bare wrapper name through PATH` (Review Focus 1): wrapper `["record-wrapper.sh", logpath]` with the fixture dir on `PATH` in the command's env → works.
  - `stops a resident wrapper and its child on timeout` (Review Focus 2, `fx.live` — TestClock never fires timeouts): wrapper `[fixture, logpath, "--resident"]`, command `sleep 30`, 200 ms timeout → fails with timeout; the child pid recorded in the log is gone (the suite's `alive(pid)`).
  - `keeps redacted arguments redacted when a wrapped process is killed` (Review Focus 3): `Redacted.make("s3cret")` arg to wrapped `sleep 30`, killed via timeout (`fx.live`) → the child received `s3cret` (log), and `Cause.pretty`/`inspect` of the failure contains `<redacted>` and not `s3cret`.
  - `wraps a shell: true command` (Review Focus 5).
- [ ] **Step 3: Run** `bun run test test/effect/cross-spawn-spawner.test.ts` in `packages/core` → the new tests FAIL (`configured` not exported).
- [ ] **Step 4: Implement** in `cross-spawn-spawner.ts`: make the spawner factory take the wrapper, read `Bypass` with `yield* Bypass` inside `spawnCommand`, export `configured`, `Bypass`, and `node = configured()`. Keep `makeCrossSpawnSpawner` behaviour identical when the wrapper is empty.
- [ ] **Step 5: Run** the spawner suite and `bun typecheck` in `packages/util` and `packages/core` → PASS; run `core/test/environment.test.ts core/test/mcp.test.ts` → unchanged.
- [ ] **Step 6: Commit** `feat(util): optional argv wrapper for spawned processes`.

### Task 2: Server option, standard replacement and the managed-policy exemption

**Files:**
- Modify: `packages/server/src/options.ts` (add `experimental: Schema.optional(Schema.Struct({ process: Schema.optional(Schema.Struct({ wrapper: Schema.optional(Schema.Array(Schema.String)) })) }))`), `packages/server/src/routes.ts` (standard replacements list next to `ShellSelect` at :144), `packages/core/src/config.ts:251-256` (`loadPreferences`)
- Test: `packages/server/test/options.test.ts`; new `packages/server/test/process-wrapper.test.ts` (MCP part modelled on `server/test/fs.test.ts:20-60`; shell part through the `shell.create` endpoint, `server/src/handlers/shell.ts`, with permission `shell: "allow"` as in `schedule.test.ts:116`); formatter part in `packages/core/test/formatter.test.ts` (add `CrossSpawnSpawner.node.replace(CrossSpawnSpawner.configured({ wrapper }))` to the `AppNodeBuilder.build` replacements at :22-25 and use `withFormatter` with a recording command). Reuse Task 1's `record-wrapper.sh`; skip these on win32.

**Interfaces:**
- Consumes: `CrossSpawnSpawner.configured`, `CrossSpawnSpawner.Bypass` (Task 1).
- Produces: `ServerOptions.experimental.process.wrapper`; standard replacement `CrossSpawnSpawner.node.replace(CrossSpawnSpawner.configured({ wrapper: options.experimental?.process?.wrapper }))`, placed in `standard` so embedder overrides (workerd, simulation) still win (`routes.ts:154-160`).

- [ ] **Step 1: Failing tests:**
  - `options.test.ts`: `accepts an experimental process wrapper` (`{ experimental: { process: { wrapper: ["w", "--"] } } }` decodes); `rejects a non-string wrapper entry` (`[1]` → None).
  - `process-wrapper.test.ts`: with the option set to the recording wrapper, (a) starting a configured stdio MCP server writes its command line to the log and the server answers `tools/list`; (b) a command run through `shell.create` is logged once; (c) in `formatter.test.ts`, a configured formatter runs wrapped; without the option, no log.
  - `config.ts` exemption: a core test that runs `loadPreferences`'s spawn path is macOS-only; instead assert in `process-wrapper.test.ts` that a command run through `AppProcess` with `Bypass` provided is not logged (proves the reference crosses `AppProcess.run`).
- [ ] **Step 2: Run** those tests → FAIL.
- [ ] **Step 3: Implement** the schema field, the standard replacement, and wrap the `processes.run(ChildProcess.make("plutil", …))` effect with `Effect.provideService(CrossSpawnSpawner.Bypass, true)` plus a one-line comment ("a sandbox denial here would silently drop managed policy").
- [ ] **Step 4: Run** the new tests, `bun typecheck` in `packages/server` and `packages/core`. No client regeneration: `ServerOptions` is not in the generated client; the SDK's `CreateOptions` (`sdk/src/internal/host.ts:18`) inherits `experimental.process.wrapper` automatically (note it in the PR body).
- [ ] **Step 5: Commit** `feat(server): experimental process wrapper option`.

### Task 3: CLI environment variable and docs

**Files:**
- Modify: `packages/cli/src/server-process.ts` (options object at :105-145, next to `windows.gitbash` at :136), `packages/web/src/content/docs/cli.mdx` (env table near :753, English page only), plus a short "Process wrapper" subsection where the server/env docs live in that page
- Test: new `packages/cli/test/process-wrapper-env.test.ts`

**Interfaces:**
- Produces (`packages/cli/src/server-process.ts`, exported for the test): `processWrapper(raw: string | undefined): ReadonlyArray<string> | undefined` — `undefined`/empty string → `undefined`; JSON array of strings → the array (empty array → `undefined`); anything else → throws `Error` whose message starts `OPENCODE_PROCESS_WRAPPER must be a JSON array of strings`. Parse with `Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))` (AGENTS.md: Effect schema helpers for untrusted JSON).
- Server options get `experimental: { process: { wrapper: processWrapper(process.env.OPENCODE_PROCESS_WRAPPER) } }`.

- [ ] **Step 1: Failing tests** (`process-wrapper-env.test.ts`): `undefined` → `undefined`; `""` → `undefined`; `'[]'` → `undefined`; `'["w","--"]'` → `["w","--"]`; `'"w"'`, `'[1]'`, `'not json'` → throws with the pinned message prefix (Review Focus 4).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `bun typecheck` in `packages/cli`.
- [ ] **Step 5: Docs** in `cli.mdx`: env table row `| \`OPENCODE_PROCESS_WRAPPER\` | string | JSON array of strings; every process the server starts runs as \`<wrapper…> <command> <args…>\` |`; subsection "Process wrapper" (5–8 lines): read once at server start like the other server variables (set it where the server starts: the service unit, the login environment for the desktop app; an already-running server keeps its own); the wrapper must `exec` its command and must not start a new session or process group; keep `SHELL` plain when the wrapper is set, or shell commands are wrapped twice (interactive terminal panes then run unwrapped, as the user's own terminal); repo `opencode.json` cannot change it; not applied to interactive terminals or the Claude Agent CLI; tested on Linux; on Windows it applies the same way but is untested.
- [ ] **Step 6: Commit** `feat(cli): read the process wrapper from OPENCODE_PROCESS_WRAPPER`.

### Task 4: Local build and live acceptance hand-off

**Files:**
- Modify: `/home/rq279/GitHub/opencode/.worktrees/research/local-build.sh` (`ours=(…)` add `process-wrapper`)

- [ ] **Step 1:** Add the branch to `ours=(…)`; don't run the script.
- [ ] **Step 2 (main session, not a subagent):** Send the `opencode-test-setup` session (SendMessage) the branch, head SHA and the acceptance test: wrapper = its existing inner-sandbox command for shells, set as `OPENCODE_PROCESS_WRAPPER` in the server unit with `SHELL` back to plain bash; a stdio MCP server cannot list the Claude config folder; unset → unchanged; also check a formatter run and the managed-policy read are unaffected. Record the result in `research/reports/Wishlist and status.md`.
