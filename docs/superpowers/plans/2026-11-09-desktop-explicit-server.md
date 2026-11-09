# Desktop Explicit Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `OPENCODE_EXPERIMENTAL_DESKTOP_SERVER` is set, the desktop uses only that loopback server as its built-in
sidecar and never starts, replaces, stops or signals a service. The desktop and the CLI also share an
`OPENCODE_PASSWORD_FILE` reader.

**Architecture:** A util reader (`@opencode/util/password-file`) checks and reads the password file. The CLI's
`Env.password` falls back to it. A new desktop module, `service/explicit-server.ts`, has no `electron` imports. It parses
the launch environment once in `index.ts`, keeps the result, and probes `/api/info` on every connect. The existing
`BackgroundServiceMachine` takes it as its `ensure`. Small branches in the probe, the CLI resolver, the shell merge and the
plugin host turn off everything that touches a service.

**Tech Stack:** TypeScript, Bun (`bun test`, `Bun.serve` stubs), Effect 4.1.0 (`Config`, `ConfigProvider`, `Effect.fn`),
Electron 44 main process, `node:fs`.

**Spec:** `docs/superpowers/specs/2026-11-09-desktop-explicit-server-design.md` (owner-approved r4, binding, including
its assumptions and "Review points declined"). Read it before any task. It cites lines on 7d5b722508. This plan cites the
same lines, re-checked on the worktree base 6aef6aa81e, where they still match.

## Global Constraints

- Worktree: `/home/rq279/GitHub/opencode/.worktrees/desktop-server`, branch `desktop-server`. Run tests from package
  directories only, never from the root.
- Environment preamble for every shell that runs `bun`:
  ```bash
  export BUN_TMPDIR=$TMPDIR/buntmp BUN_INSTALL_CACHE_DIR=$TMPDIR/buncache \
    XDG_DATA_HOME=$TMPDIR/xdg/data XDG_CONFIG_HOME=$TMPDIR/xdg/config XDG_CACHE_HOME=$TMPDIR/xdg/cache XDG_STATE_HOME=$TMPDIR/xdg/state
  mkdir -p "$BUN_TMPDIR" "$BUN_INSTALL_CACHE_DIR" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
  ```
  In auto mode, write commands in their `rtk` form (`~/.claude/RTK.md`). `git` stays unprefixed.
- Commit recipe. `<title>` is the step's conventional title:
  ```bash
  GIT_AUTHOR_NAME=Project579 GIT_COMMITTER_NAME=Project579 GIT_AUTHOR_EMAIL=star579avatar@gmail.com GIT_COMMITTER_EMAIL=star579avatar@gmail.com \
    git -c commit.gpgsign=false commit -m "<title>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MTg66vrTtvfX9f4eFX5AEp"
  ```
- Variable names, verbatim: `OPENCODE_EXPERIMENTAL_DESKTOP_SERVER`, `OPENCODE_PASSWORD_FILE`, `OPENCODE_PASSWORD`,
  `OPENCODE_SERVER_PASSWORD`.
- Explicit mode means `OPENCODE_EXPERIMENTAL_DESKTOP_SERVER` is set and non-empty, whether or not it parses. A parse
  failure is kept as the error that every connect raises. There is never a fallback to the managed service.
- URL rules: the value must parse, use `http:`, have host `127.0.0.1` or `localhost`, have no path other than `/`, no
  query and no userinfo. Use `url.origin`.
- Password precedence, the same in the desktop and the CLI: `OPENCODE_PASSWORD`, then `OPENCODE_SERVER_PASSWORD`, then
  `OPENCODE_PASSWORD_FILE`. If the file variable is reached and the file fails, that is an error, never a fall-through.
  With none set, no Authorization header is sent.
- File checks: open with `O_RDONLY | O_NOFOLLOW`, then `fstat`. The file must be regular, owned by `process.getuid()`,
  and have `(mode & 0o077) === 0`. Read at most 4 KiB (4096 bytes). Trim with `String.prototype.trim`. An empty result is
  an error. Reject on `process.platform === "win32"` (one line, not unit tested, no test-only parameter).
- Probe: `GET <origin>/api/info`, Basic auth, `AbortSignal.timeout(5_000)`. Only a 200 whose body has a string `version`
  counts as connected.
- `packages/desktop/src/main/service/explicit-server.ts` imports nothing from `electron`, `../constants` or
  `@opencode/client/service` (type imports included), so it loads under plain `bun test`.
- New i18n keys go at the end of `DESKTOP_NATIVE_ENGLISH`, after `"desktop.contextMenu.spellcheckLanguages"`
  (`packages/app/src/runtime/i18n/desktop-native.ts:318`). `hr.ts`, `hu.ts`, `is.ts` and `lt.ts` (`:75`) map
  translations to keys by array index, so inserting keys mid-list would shift their translations. Add no locale files.
- Desktop rules (`packages/desktop/AGENTS.md`, `packages/app/AGENTS.md` Tests): no test-only parameters or exports, write
  contract tests as tables, and run `bun test <file>` for every test file you touch (`bun typecheck` skips tests).
- Tests that need POSIX file semantics (modes, `O_NOFOLLOW`, symlinks, FIFOs) use `skipIf(process.platform === "win32")`
  with a comment that the platform lacks the capability (unit-tests skill). Never add a sleep, `mock.module` or
  `--isolate`. Bind stubs to port 0.
- Root `AGENTS.md` style: `const`, no `else`, no import aliases, no star imports, no `any`. Avoid `try`/`catch` outside
  the file reader. The client, protocol and server are untouched, so skip `bun run generate` and add no `.changeset`.
- No locale or translation work, no UI or settings, no new CLI flag, no runtime switch back to a managed service. Leave
  out #52156's `service set password_file`, config `password_file` and `--credential-name`.

## Review Focus

1. **A port that serves something other than OpenCode** (another dev server returns 200 with HTML or `{}`): the desktop
   reports the incompatible error and does not treat it as connected. Test: Task 3, rows in "maps failed probes to
   errors".
2. **A password path that is a FIFO or another non-regular file**: it is rejected at once with reason `type`, and the
   main process never blocks in `open`. That needs `O_NONBLOCK` in the open flags. Test: Task 1, row in "rejects
   files it cannot trust".
3. **A login shell that exports `OPENCODE_PASSWORD`, `OPENCODE_EXPERIMENTAL_DESKTOP_SERVER` or `OPENCODE_PASSWORD_FILE`**:
   the shell cannot switch the mode or inject a password. In stock mode the shell's `OPENCODE_PASSWORD` still passes
   through, as it does today. Test: Task 3, "keeps server variables and explicit-mode passwords out of the shell merge".
4. **A wrapper that exports `OPENCODE_EXPERIMENTAL_DESKTOP_SERVER=""`**: the desktop takes the stock path and does not
   delete `OPENCODE_PASSWORD`. Test: Task 3, "empty" row of the environment table.
5. **A plain password together with a missing or unsafe `OPENCODE_PASSWORD_FILE`**: the plain variable wins and the file
   is never opened, in the desktop and in the CLI. Test: Task 2, row in the precedence table. Task 3, "prefers a plain
   password without opening the file".

---

### Task 1: Shared password-file reader in util

**Files:**
- Create: `packages/util/src/password-file.ts`
- Test: `packages/util/src/password-file.test.ts` (colocated, like `bom.test.ts`. `tsconfig.build.json` already excludes
  `src/**/*.test.ts`)

**Interfaces:**
- Consumes: nothing.
- Produces (`@opencode/util/password-file`; util exports `./*`):
  - `export type PasswordFileReason = "missing" | "symlink" | "type" | "owner" | "mode" | "size" | "empty" | "unreadable" | "platform"`
  - `export class PasswordFileError extends Error { readonly reason: PasswordFileReason; readonly path: string }`,
    constructed as `new PasswordFileError(reason, path, { cause })`, with `name = "PasswordFileError"` and message
    `` `Password file ${path} rejected: ${reason}` ``.
  - `export function readPasswordFile(path: string): string`. It is synchronous, returns the trimmed password, and throws
    only `PasswordFileError`.

- [ ] **Step 1: Install dependencies**

Run from the worktree root, with the preamble: `bun install`
Expected: exits 0 and `node_modules/` exists.

- [ ] **Step 2: Write the failing tests**

The whole `describe` is `describe.skipIf(process.platform === "win32")`, with a comment that Windows has no
`O_NOFOLLOW` and the reader rejects it. Use `fs.mkdtempSync(path.join(os.tmpdir(), "opencode-password-file-"))` in
`beforeEach` and `fs.rmSync(dir, { recursive: true, force: true })` in `afterEach`. Add a local helper
`write(name, content, mode = 0o600)` that writes the file and then calls `chmodSync(file, mode)`, so the umask does not
matter. Add `reason(file)`, which calls `readPasswordFile` and returns the caught `PasswordFileError`'s `reason`. It
fails the test if anything else is thrown or nothing is thrown.

```ts
test.each([
  ["newline", "secret\n"],
  ["CRLF", "secret\r\n"],
  ["spaces", "  secret \n"],
])("accepts a 0600 file and trims surrounding whitespace (%s)", (_, content) => {
  expect(readPasswordFile(write("pw", content))).toBe("secret")
})

test("accepts a file of exactly 4096 bytes", () => {
  expect(readPasswordFile(write("pw", "a".repeat(4096)))).toBe("a".repeat(4096))
})

test.each([
  ["group-readable 0640", () => write("pw", "secret", 0o640), "mode"],
  ["world-readable 0604", () => write("pw", "secret", 0o604), "mode"],
  ["symlink to a 0600 file", () => symlink(write("target", "secret"), "link"), "symlink"],
  ["directory", () => mkdir("dir", 0o700), "type"],
  ["FIFO", () => mkfifo("fifo"), "type"], // Review Focus 2: must not block in open
  ["over 4 KiB", () => write("pw", "a".repeat(4097)), "size"],
  ["whitespace only", () => write("pw", " \n"), "empty"],
  ["missing", () => path.join(dir, "absent"), "missing"],
] as const)("rejects files it cannot trust: %s", (_, make, expected) => {
  expect(reason(make())).toBe(expected)
})
```

`mkfifo(name)` runs `Bun.spawnSync(["mkfifo", file])` and asserts exit code 0. `symlink` and `mkdir` are thin
`node:fs` helpers that return the path. Owner mismatch needs root and is not tested (spec).

- [ ] **Step 3: Run the tests to confirm they fail**

Run, from `packages/util`: `bun test src/password-file.test.ts`
Expected: FAIL with `Cannot find module './password-file'` (or similar resolution error).

- [ ] **Step 4: Implement `readPasswordFile(path: string): string` in `packages/util/src/password-file.ts`**

Check in this order: platform, then `openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)`, then `fstatSync(fd)`.
`O_NONBLOCK` keeps a FIFO from blocking the open. Map open errors by `code`: `ENOENT` and `ENOTDIR` to `missing`,
`ELOOP` to `symlink`, anything else to `unreadable`. Then check `!isFile()` (`type`), `uid !== process.getuid()`
(`owner`), `mode & 0o077` (`mode`) and `size > 4096` (`size`). Read into a 4096-byte buffer with `readSync`, decode it
as UTF-8 and trim it. An empty result is `empty`. Close the fd in a `finally`. Add a comment on why each open flag is
there.

- [ ] **Step 5: Run the tests to confirm they pass, and typecheck**

Run, from `packages/util`: `bun test src/password-file.test.ts --rerun-each 10 && bun typecheck`
Expected: all tests pass on every rerun, and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/util/src/password-file.ts packages/util/src/password-file.test.ts
# commit recipe, title: feat(util): add a checked password-file reader
```

---

### Task 2: `OPENCODE_PASSWORD_FILE` in the CLI

**Files:**
- Modify: `packages/cli/src/env.ts:7-22` (`password`, `session`)
- Modify: `packages/cli/src/server-process.ts:85-90`
- Test: `packages/cli/test/env.test.ts` (extend)

**Interfaces:**
- Consumes: `readPasswordFile`, `PasswordFileError` (Task 1).
- Produces: `Env.password` stays a `Config<Redacted<string> | undefined>`. `Env.session()` keeps its signature. Callers do
  not change (`services/server-connection.ts:35`, `server-process.ts:85`, and the `Env.session()` callers
  `commands/handlers/default.ts:145`, `mini.ts:43`, `run/run.ts:106`).

- [ ] **Step 1: Write the failing tests**

In `packages/cli/test/env.test.ts`, add a local helper that drives the real config with an explicit provider, so no
test mutates `process.env`:

```ts
const resolve = (env: Record<string, string>) =>
  Effect.runPromise(Env.password.parse(ConfigProvider.fromEnv({ env }))).then((value) => value && Redacted.value(value))
```

It also needs a `mkdtempSync` temp dir with `afterEach` cleanup and `secret(content, mode = 0o600)`, which writes the
file, chmods it and returns its path. Both new tests use `test.skipIf(process.platform === "win32")`, with a comment
that the reader rejects Windows.

```ts
test.skipIf(process.platform === "win32")(
  "password prefers OPENCODE_PASSWORD, then OPENCODE_SERVER_PASSWORD, then OPENCODE_PASSWORD_FILE",
  async () => {
    const file = secret("from-file\n")
    expect(await resolve({ OPENCODE_PASSWORD: "plain", OPENCODE_SERVER_PASSWORD: "legacy", OPENCODE_PASSWORD_FILE: file })).toBe("plain")
    expect(await resolve({ OPENCODE_SERVER_PASSWORD: "legacy", OPENCODE_PASSWORD_FILE: file })).toBe("legacy")
    expect(await resolve({ OPENCODE_PASSWORD_FILE: file })).toBe("from-file")
    expect(await resolve({})).toBeUndefined()
    // Review Focus 5: a plain password never opens the file.
    expect(await resolve({ OPENCODE_PASSWORD: "plain", OPENCODE_PASSWORD_FILE: secret("x", 0o644) })).toBe("plain")
  },
)

test.skipIf(process.platform === "win32")("an unusable OPENCODE_PASSWORD_FILE fails instead of falling through", async () => {
  const fail = (env: Record<string, string>) =>
    Effect.runPromise(Effect.flip(Env.password.parse(ConfigProvider.fromEnv({ env }))))
  expect((await fail({ OPENCODE_PASSWORD_FILE: secret("x", 0o644) })).message).toContain("mode")
  expect((await fail({ OPENCODE_PASSWORD_FILE: "/nonexistent/opencode-password" })).message).toContain("missing")
})
```

Extend the existing test "session environment omits server credentials" so that it also sets and restores
`OPENCODE_PASSWORD_FILE` and asserts `expect(environment.OPENCODE_PASSWORD_FILE).toBeUndefined()`.

- [ ] **Step 2: Run the tests to confirm they fail**

Run, from `packages/cli`: `bun test --timeout 30000 test/env.test.ts`
Expected: FAIL. The `from-file` assertion gets `undefined`, the unusable-file test resolves instead of failing, and the
session test sees `OPENCODE_PASSWORD_FILE`.

- [ ] **Step 3: Implement the `Env.password` fallback and the `session()` filter in `packages/cli/src/env.ts`**

Insert this before `Config.withDefault(undefined)`:
`Config.orElse(() => Config.String("OPENCODE_PASSWORD_FILE").pipe(Config.mapEffect(...)))`. The mapper runs
`readPasswordFile` in `Effect.try`. It maps success to `Redacted.make(value)`. It maps failure to
`` new Config.ConfigError(new ConfigProvider.SourceError({ message: `OPENCODE_PASSWORD_FILE: ${error.message}`, cause: error })) ``.
In effect 4.1.0 that is `Config.ts:474` and `ConfigProvider.ts:214-217`. There is no `mapOrFail`, and `withDefault`
lets source errors propagate. Update the comment above `password` to name the file variable and its precedence. In
`session()`, also filter out `OPENCODE_PASSWORD_FILE`.

- [ ] **Step 4: Update `packages/cli/src/server-process.ts:85-90`**

- In stdio mode, also run `delete process.env.OPENCODE_PASSWORD_FILE` next to the two existing deletes.
- Read `Env.password` only outside service mode:
  `const environmentPassword = options.mode === "service" ? undefined : yield* Env.password`. Service mode already
  ignores the value (`:91-93`). Without this guard, a broken file inherited by `serve --service` would stop the service
  from starting. Add a comment that says so.

- [ ] **Step 5: Run the tests to confirm they pass, and typecheck**

Run, from `packages/cli`: `bun test --timeout 30000 test/env.test.ts --rerun-each 10 && bun typecheck`
Expected: all tests pass on every rerun, and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/env.ts packages/cli/src/server-process.ts packages/cli/test/env.test.ts
# commit recipe, title: feat(cli): read the server password from OPENCODE_PASSWORD_FILE
```

---

### Task 3: Desktop explicit-server module, its i18n keys and tests

**Files:**
- Create: `packages/desktop/src/main/service/explicit-server.ts`
- Test: `packages/desktop/src/main/service/explicit-server.test.ts`
- Modify: `packages/app/src/runtime/i18n/desktop-native.ts:318` (append 5 keys)
- Modify: `packages/desktop/package.json:35-40` (add `"@opencode/util": "workspace:*"` to `devDependencies`, sorted
  after `@opencode/ui`. electron-vite bundles devDependencies, as it does the other `@opencode/*` packages.)
- Modify: `bun.lock` (from `bun install`)

**Interfaces:**
- Consumes: `readPasswordFile`, `PasswordFileError` (Task 1). `nativeT` from `../native/translations` (it has no
  electron import). `import type { Data } from "./sidecar-credentials"` and `authorization` from the same module, which
  builds the Basic header.
- Produces (`export * as ExplicitServer from "./explicit-server"` at the top, as in the other `service/` modules):
  - `export type Server = { readonly type: "valid"; readonly origin: string; readonly password: string | undefined; readonly passwordFile: string | undefined } | { readonly type: "invalid" }`.
    `password` is the plain variable captured at launch (`OPENCODE_PASSWORD`, then `OPENCODE_SERVER_PASSWORD`).
  - `export function explicitServer(env: Record<string, string | undefined>): Server | undefined`. When the variable is
    unset or empty, it returns `undefined` and leaves `env` untouched. Otherwise it deletes `OPENCODE_PASSWORD` and
    `OPENCODE_SERVER_PASSWORD` from `env` and returns the parse result. In both cases it stores the result for
    `configured()`.
  - `export function configured(): Server | undefined` returns what the last `explicitServer` call stored.
  - `export function shellOverrides(shellEnv: Readonly<Record<string, string>>): Record<string, string>` returns
    `shellEnv` without `OPENCODE_EXPERIMENTAL_DESKTOP_SERVER` and `OPENCODE_PASSWORD_FILE`. When `configured()` is
    defined, it also drops `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD`.
  - `export const connectExplicit: (server: Server, bundled: string | undefined) => Effect.Effect<SidecarCredentials.Data, Error>`,
    built with `Effect.fn("ExplicitServer.connect")`.
- i18n keys (exact English, appended at the end of `DESKTOP_NATIVE_ENGLISH`):

| Key | English |
|---|---|
| `desktop.server.explicit.invalid` | `OPENCODE_EXPERIMENTAL_DESKTOP_SERVER must be http://127.0.0.1:<port> or http://localhost:<port>` |
| `desktop.server.explicit.unavailable` | `The OpenCode server at {{origin}} is not reachable or not ready` |
| `desktop.server.explicit.unauthorized` | `The OpenCode server at {{origin}} rejected the password` |
| `desktop.server.explicit.incompatible` | `The server at {{origin}} is not a compatible OpenCode server` |
| `desktop.server.explicit.passwordFile` | `Cannot use the password file {{path}}: it must be a regular file owned by you and readable only by you` |

- [ ] **Step 1: Add the dependency and the i18n keys**

Edit `packages/desktop/package.json` and `desktop-native.ts` as listed above. Then run `bun install` from the root with
the preamble.
Expected: exits 0, and `git diff --stat bun.lock` shows the lockfile picking up the new workspace edge (no change is also
acceptable).

- [ ] **Step 2: Write the failing tests**

In `explicit-server.test.ts`, add the constants `SERVER = "OPENCODE_EXPERIMENTAL_DESKTOP_SERVER"` and
`FILE = "OPENCODE_PASSWORD_FILE"`. Add `stub(respond)`, which starts
`Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })`, records each request's pathname and `authorization` header, and
returns `{ origin, requests }`. It keeps the server in a module-level `let server` for `afterEach`. `afterEach` runs
`server?.stop(true)` and removes the temp dir (a `mkdtempSync` dir made in `beforeEach`). Add `write(name, content,
mode = 0o600)`, the same helper as in Task 1, which returns the path. Add
`connect(env, bundled = "1.0.0")`, which runs `explicitServer(env)`, fails the test if the result is `undefined`, and
returns `connectExplicit(result, bundled)` run with `Effect.runPromise`. Add `failure(env)`, the same with
`Effect.flip`, which returns the error.

Environment table (one table, spec "explicit-server.test.ts"; Review Focus 4 is the `empty` row):

```ts
const passwords = { OPENCODE_PASSWORD: "plain", OPENCODE_SERVER_PASSWORD: "legacy", [FILE]: "/run/opencode/pw" }
test.each([
  { name: "unset", env: { ...passwords }, expected: undefined, remaining: { ...passwords } },
  { name: "empty", env: { [SERVER]: "", ...passwords }, expected: undefined, remaining: { [SERVER]: "", ...passwords } },
  { name: "127.0.0.1", env: { [SERVER]: "http://127.0.0.1:4096", ...passwords },
    expected: { type: "valid", origin: "http://127.0.0.1:4096", password: "plain", passwordFile: "/run/opencode/pw" },
    remaining: { [SERVER]: "http://127.0.0.1:4096", [FILE]: "/run/opencode/pw" } },
  { name: "localhost with trailing slash", env: { [SERVER]: "http://localhost:4096/", OPENCODE_SERVER_PASSWORD: "legacy" },
    expected: { type: "valid", origin: "http://localhost:4096", password: "legacy", passwordFile: undefined },
    remaining: { [SERVER]: "http://localhost:4096/" } },
  ...["https://127.0.0.1:4096", "http://example.com:4096", "http://[::1]:4096", "http://127.0.0.1:4096/api",
      "http://127.0.0.1:4096/?a=1", "http://user:pw@127.0.0.1:4096", "not a url"].map((value) => ({
    name: value, env: { [SERVER]: value, ...passwords }, expected: { type: "invalid" },
    remaining: { [SERVER]: value, [FILE]: "/run/opencode/pw" } })),
])("reads the launch environment: $name", (row) => {
  const env = { ...row.env }
  expect(explicitServer(env)).toEqual(row.expected)
  expect(configured()).toEqual(row.expected)
  expect(env).toEqual(row.remaining)
})
```

Connect tests:

```ts
test("connects with the password and returns the origin", async () => {
  const { origin, requests } = stub(() => Response.json({ version: "1.0.0", pid: 1, urls: [], paths: {} }))
  expect(await connect({ [SERVER]: origin, OPENCODE_PASSWORD: "secret" })).toEqual({ url: origin, password: "secret" })
  expect(requests).toEqual([{ path: "/api/info", authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}` }])
})

test("sends no Authorization header without a password", async () => {
  const { origin, requests } = stub(() => Response.json({ version: "1.0.0" }))
  expect(await connect({ [SERVER]: origin })).toEqual({ url: origin, password: null })
  expect(requests).toEqual([{ path: "/api/info", authorization: null }])
})

test.each([
  { name: "401", respond: () => new Response(null, { status: 401 }), message: (o: string) => `The OpenCode server at ${o} rejected the password` },
  { name: "404", respond: () => new Response(null, { status: 404 }), message: (o: string) => `The server at ${o} is not a compatible OpenCode server` },
  { name: "503", respond: () => new Response(null, { status: 503, headers: { "retry-after": "1" } }), message: (o: string) => `The OpenCode server at ${o} is not reachable or not ready` },
  { name: "500", respond: () => new Response(null, { status: 500 }), message: (o: string) => `The OpenCode server at ${o} is not reachable or not ready` },
  // Review Focus 1: something else listens on the port.
  { name: "200 without version", respond: () => Response.json({}), message: (o: string) => `The server at ${o} is not a compatible OpenCode server` },
  { name: "200 HTML", respond: () => new Response("<html></html>", { headers: { "content-type": "text/html" } }), message: (o: string) => `The server at ${o} is not a compatible OpenCode server` },
])("maps failed probes to errors: $name", async (row) => {
  const { origin } = stub(row.respond)
  expect((await failure({ [SERVER]: origin, OPENCODE_PASSWORD: "secret" })).message).toBe(row.message(origin))
})

test("a closed port is unavailable", async () => {
  const { origin } = stub(() => Response.json({ version: "1.0.0" }))
  server?.stop(true)
  expect((await failure({ [SERVER]: origin })).message).toBe(`The OpenCode server at ${origin} is not reachable or not ready`)
})

test("connects despite a version mismatch", async () => {
  const { origin } = stub(() => Response.json({ version: "0.0.1" }))
  expect(await connect({ [SERVER]: origin }, "9.9.9")).toEqual({ url: origin, password: null })
})

test("an invalid value fails every connect without a request", async () => {
  const { requests } = stub(() => Response.json({ version: "1.0.0" }))
  const message = "OPENCODE_EXPERIMENTAL_DESKTOP_SERVER must be http://127.0.0.1:<port> or http://localhost:<port>"
  expect((await failure({ [SERVER]: "https://127.0.0.1:1" })).message).toBe(message)
  expect(requests).toEqual([])
})

test("prefers a plain password without opening the file", async () => { // Review Focus 5
  const { origin } = stub(() => Response.json({ version: "1.0.0" }))
  expect(await connect({ [SERVER]: origin, OPENCODE_PASSWORD: "plain", [FILE]: "/nonexistent/pw" })).toEqual({ url: origin, password: "plain" })
})
```

POSIX-only (`test.skipIf(process.platform === "win32")`, with a comment that the reader rejects Windows):

```ts
test("re-reads the password file on every connect", async () => {
  const { origin } = stub(() => Response.json({ version: "1.0.0" }))
  const explicit = explicitServer({ [SERVER]: origin, [FILE]: write("pw", "one\n") })
  if (!explicit) throw new Error("expected explicit mode")
  expect(await Effect.runPromise(connectExplicit(explicit, "1.0.0"))).toEqual({ url: origin, password: "one" })
  write("pw", "two\n")
  expect(await Effect.runPromise(connectExplicit(explicit, "1.0.0"))).toEqual({ url: origin, password: "two" })
})

test("an unsafe password file fails without a request", async () => {
  const { origin, requests } = stub(() => Response.json({ version: "1.0.0" }))
  const file = write("pw", "secret", 0o644)
  expect((await failure({ [SERVER]: origin, [FILE]: file })).message).toBe(
    `Cannot use the password file ${file}: it must be a regular file owned by you and readable only by you`)
  expect(requests).toEqual([])
})
```

Shell merge (Review Focus 3):

```ts
test("keeps server variables and explicit-mode passwords out of the shell merge", () => {
  const shell = { PATH: "/bin", [SERVER]: "http://127.0.0.1:1", [FILE]: "/x", OPENCODE_PASSWORD: "p", OPENCODE_SERVER_PASSWORD: "l" }
  explicitServer({})
  expect(shellOverrides(shell)).toEqual({ PATH: "/bin", OPENCODE_PASSWORD: "p", OPENCODE_SERVER_PASSWORD: "l" })
  explicitServer({ [SERVER]: "http://127.0.0.1:4096" })
  expect(shellOverrides(shell)).toEqual({ PATH: "/bin" })
})
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run, from `packages/desktop`: `bun test --timeout 30000 src/main/service/explicit-server.test.ts`
Expected: FAIL with a module resolution error for `./explicit-server`.

- [ ] **Step 4: Implement `explicit-server.ts`**

- `explicitServer` parses with `URL.canParse` and `new URL`, applying the URL rules from Global Constraints. It captures
  the plain password before deleting both plain variables, and assigns the module-level `current`.
- `connectExplicit`:
  - For `type: "invalid"`, it fails with `new Error(nativeT("desktop.server.explicit.invalid"))`, built at connect time
    so that the current locale applies.
  - Otherwise it resolves the password as `server.password ?? (server.passwordFile && readPasswordFile(server.passwordFile))`.
    It calls the reader inside `Effect.try` and maps a `PasswordFileError` to
    `nativeT("desktop.server.explicit.passwordFile", { path })`.
  - It fetches with `authorization({ url: origin, password }, origin)` as the header (none when it is `undefined`) and
    `signal: AbortSignal.timeout(5_000)`.
  - Status mapping: 401 is unauthorized. 500, 503, network errors and timeouts are unavailable. Any other non-200 status,
    and a 200 whose JSON body does not decode as `Schema.Struct({ version: Schema.String })`, are incompatible.
  - When `bundled !== undefined && version !== bundled`, it logs
    `Effect.logWarning("explicit server version differs", { origin, version, bundled })` and continues.
  - It returns `{ url: origin, password: password ?? null }`.
- Add a top comment: this module must not import `electron`, `../constants` or `@opencode/client/service`.

- [ ] **Step 5: Run the tests to confirm they pass, and typecheck both packages**

Run, from `packages/desktop`: `bun test --timeout 30000 src/main/service/explicit-server.test.ts --rerun-each 10 && bun typecheck`
Run, from `packages/app`: `bun typecheck && bun test src/runtime/i18n/desktop-native.test.ts`
Expected: all pass on every rerun, and both typechecks exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/main/service/explicit-server.ts packages/desktop/src/main/service/explicit-server.test.ts \
  packages/desktop/package.json packages/app/src/runtime/i18n/desktop-native.ts bun.lock
# commit recipe, title: feat(desktop): connect to an explicit loopback server
```

---

### Task 4: Desktop wiring for explicit mode

None of these files loads under `bun test` (all import `electron`, and `desktop-cli.ts` also imports `install?raw`).
Their behaviour is checked by typecheck, the existing suites, review and Task 6. The spec dropped a `desktop-cli` unit
test in favour of the manual check (declined points I3 and M5).

**Files:**
- Modify: `packages/desktop/src/main/index.ts:15` (call after `configureApplication()`)
- Modify: `packages/desktop/src/main/service/sidecar-probe.ts:14-20, 30-36`
- Modify: `packages/desktop/src/main/service/background-service.ts:26-44`
- Modify: `packages/desktop/src/main/service/desktop-cli.ts:82-95, 101-113`
- Modify: `packages/desktop/src/main/lifecycle/environment.ts:47-54`
- Modify: `packages/desktop/src/main/plugin/host.ts:206-207`

**Interfaces:**
- Consumes: `explicitServer`, `ExplicitServer.configured`, `ExplicitServer.connectExplicit` and
  `ExplicitServer.shellOverrides` (Task 3).
- Produces: `sidecar-probe.ts` newly exports `bundledVersion(): string` (no other change to that function).

- [ ] **Step 1: Parse the launch environment in `index.ts`**

Import `{ explicitServer } from "./service/explicit-server"` and call `explicitServer(process.env)` on the line after
`configureApplication()` (`:15`). That is before `acquireApplicationLock()`, before `startSidecarProbe()` (`:26`) and
before any child process. Add a one-line comment: the call clears plain password variables before any child process
inherits them.

- [ ] **Step 2: Skip the early probe and export `bundledVersion` in `sidecar-probe.ts`**

Make `if (ExplicitServer.configured()) return` the first line of `startSidecarProbe` (before `app.isPackaged`), so that
`Service.discover` and the `@opencode/client/service` import never run. Export `bundledVersion`.

- [ ] **Step 3: Branch the layer in `background-service.ts`**

Inside the layer's generator, read `const server = ExplicitServer.configured()`. When it is defined, pass
`probe: Effect.succeed(undefined)` and `ensure: () => ExplicitServer.connectExplicit(server, bundled)`, where
`bundled = CHANNEL === "beta" ? undefined : bundledVersion() || undefined`. Otherwise pass the existing `probe()` and
`ensure(mode)`. `publish` is unchanged. This skips `prepare`, `Service.ensure`, `cleanStages`, the registry read and the
`@opencode/client/service` import. `OPENCODE_DESKTOP_SERVER_CHANNEL` and `OPENCODE_DESKTOP_ISOLATED_SERVER` (`:104,112`)
are then ignored by the connection.

- [ ] **Step 4: Add the explicit branch to `resolveBundledCli` in `desktop-cli.ts`**

Extract the synchronous `opencode-cli.version` read (`:105-113`) into `shippedVersion(bundled: string): string`, which
returns `""` when the file is missing. `bundledVersion` keeps using it. After the `"v2 CLI executable resolved"` log
(`:90`), when `ExplicitServer.configured()` is defined, return
`{ version: shippedVersion(bundled) || VERSION, binary: bundled, command: [bundled] }` without calling `bundledVersion`
(no `--version` spawn) or `installCli` (no stage). Import `VERSION` from `../constants`. The fallback stays at this call
site.

- [ ] **Step 5: Filter the shell merge in `environment.ts`**

In `preferApplicationEnvironment`, replace `...shellEnv` with `...(shellEnv ? ExplicitServer.shellOverrides(shellEnv) : {})`.
Leave the `XDG_STATE_HOME` line (`:48`) as it is.

- [ ] **Step 6: Leave the pairing built-in out in `plugin/host.ts`**

At `:207`, filter `local` with `runsOn(definition, os) && !(ExplicitServer.configured() && definition.id === "pairing")`.
Add a comment that the pairing main runs `service` commands that stop and ensure services through the host registry,
and that its renderer page stays listed but inert. Filter `local`, not `definitions` (`:206`):
`definitions` also feeds the built-in id list (`:211`), the reserved ids (`:575`) and the built-in storage flag
(`:815`). Keeping `"pairing"` in those keeps a shipped plugin from taking the id. `local` feeds activation, the listing
and `known` (`:362`, `:904-907`, `:981`, `:1006`), so the pairing main never loads.

- [ ] **Step 7: Leave `windows/security.ts` unchanged**

Check that `security.ts:105` calls `SidecarCredentials.get()` on every request, so a republished password is used with
no further change.

- [ ] **Step 8: Typecheck and run the affected existing suites**

Run, from `packages/desktop`:
`bun typecheck && bun test --timeout 30000 src/main/service src/main/plugin electron.vite.config.test.ts`
Expected: typecheck exits 0 and every test passes. The `electron.vite.config.test.ts` case "keeping native dependencies
external" confirms that `@opencode/util` did not land in `dependencies`. Some suites import `electron`, which needs the
Electron binary. If one fails only because that download is blocked in the sandbox, report it as a blocker and do not
work around it.

- [ ] **Step 9: Commit**

```bash
git add packages/desktop/src/main/index.ts packages/desktop/src/main/service/sidecar-probe.ts \
  packages/desktop/src/main/service/background-service.ts packages/desktop/src/main/service/desktop-cli.ts \
  packages/desktop/src/main/lifecycle/environment.ts packages/desktop/src/main/plugin/host.ts
# commit recipe, title: feat(desktop): use the explicit server without touching services
```

---

### Task 5: Documentation and full check

**Files:**
- Modify: `packages/desktop/README.md` (new section before `## Startup benchmark`, `:49`)
- Modify: `packages/web/src/content/docs/cli.mdx:775` (new row after `OPENCODE_SERVER_PASSWORD`). Translated `cli.mdx`
  copies are not touched.

**Interfaces:** none.

- [ ] **Step 1: Add `## Explicit server (experimental)` to the desktop README**

About 10 lines, covering:
- the three variables and their precedence;
- loopback `http` only, and why `127.0.0.1` is preferred;
- the file checks;
- that the desktop never starts, stops, replaces or signals a service, and never stages or runs the CLI for the
  connection;
- that the server must stay up on its own (no restart from the desktop), and a relaunch stays in explicit mode;
- that Pairing is inert;
- that SSH askpass and the macOS CLI installer still run the bundled CLI and create OpenCode folders in the home when
  used.

- [ ] **Step 2: Add the `cli.mdx` row**

```
| `OPENCODE_PASSWORD_FILE`              | string  | Read the server password from a file (after `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD`); it must be a regular file owned by you with mode 0600 or stricter |
```

Pad the first two columns to the table's existing widths.

- [ ] **Step 3: Run the full check**

Run, from the worktree root with the preamble: `bun run check`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/README.md packages/web/src/content/docs/cli.mdx
# commit recipe, title: docs: explicit desktop server and OPENCODE_PASSWORD_FILE
```

---

### Task 6: Manual live checks (owner sessions only; implementers do not run this)

Run these in the owner's `opencode-test-setup` session (the test environment) and the `aursandbox` session (the home
unit, with `Restart=always` and no idle stop, the launcher and the `.desktop` `Exec` line). Use a packaged build of this
branch, launched through `aursandbox desktop` with `OPENCODE_EXPERIMENTAL_DESKTOP_SERVER=http://127.0.0.1:<port>` and
`OPENCODE_PASSWORD_FILE`. Record pass or fail for each item:

- [ ] `systemctl --user restart <home unit>` with an explicit rotation while the desktop is open: requests fail, then
  resume after the reconnect reads the new password.
- [ ] Menu Relaunch: the app comes back in explicit mode and connects.
- [ ] As long as SSH remotes and the CLI installer are not used, the host never gets `~/.config/opencode`,
  `~/.cache/opencode`, `service.json` or `<userData>/cli/` stages. Repeat with `opencode-cli.version` removed from the
  resources (this covers the `desktop-cli.ts` branch).
- [ ] The Pairing page is inert: the Pair button is disabled, no message shows, and the remote and screen rows are
  hidden.
- [ ] Start the desktop while the unit is stopped: the error page shows the unavailable message. Start the unit, then
  click Restart: it connects.
- [ ] CLI: `opencode --server http://127.0.0.1:<port>` with only `OPENCODE_PASSWORD_FILE` set connects. With the file
  chmodded to 0644, it fails with the `OPENCODE_PASSWORD_FILE` message.
- [ ] The main log has no `Service.ensure`, `cleanStages`, `v2 CLI command started` or `v2 CLI executable staged`
  lines.
