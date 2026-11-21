# Desktop explicit server (replaces `service-autostart`)

Status: design, approved by the owner on 2026-11-09 after three spec reviews.

Revision r4: the owner's decisions and the re-review fixes are folded in. The target is the fork (`local-build`), kept
upstream-shaped.

Base: `origin/dev` 7d5b722508; line numbers are on that commit. This replaces the fork branch `service-autostart`
(27149b0226, merge-base a9a067f12d).

## Intent / why

The owner runs a sandboxed per-machine "home" `serve --service`: bwrap/nono, a systemd unit, `127.0.0.1:<port>`, and a
password that survives restarts and rotates only on an explicit rotate, forget or reinstall.

Stock desktop runs `Service.ensure` in Electron main. That call can replace the registered service on a version
mismatch, or terminate it after 3 probe timeouts, using `process.kill(<registry pid>)`
(`packages/client/src/promise/service.ts`, replace and `terminate()`). Under `bwrap --unshare-pid` that pid is a
namespace pid, so the kill can hit an unrelated host process.

The CLI already has a safe path. `--server` plus `OPENCODE_PASSWORD` probes `/api/info`, warns on a version mismatch,
and never ensures, stops or kills (`packages/cli/src/services/server-connection.ts:34-50`). This change gives desktop
the same path. It also adds a password-file variable that the desktop and the CLI share. Client, protocol and server
are untouched.

## Goals

- When an explicit server URL is set, the desktop's built-in "sidecar" entry uses only that server.
- In explicit mode desktop never starts, replaces, stops or signals a service, and never runs or stages the CLI on its
  own. Concretely, it never:
  - calls `Service.discover`, `Service.ensure` or `Service.stop`;
  - spawns a contender, runs `cleanStages` or reads the registry;
  - stages the bundled CLI or runs `--version` for the server connection;
  - runs the pairing plugin's `service` commands.
- Two user-triggered paths still run the bundled CLI, by design (step 6), and both create OpenCode folders in the real
  home when used: the SSH askpass helper and the CLI installer (macOS only, `desktop-cli.ts:44`).
- The password never reaches a child process or the renderer. A reconnect picks up a rotated password, but after a
  rotation the renderer does not ask for one: the user reloads the window or relaunches (found in the 2026-11-09 live
  check).
- One password-file reader is shared by the desktop and the CLI, with the same checks and the same precedence.

## Non-goals and assumptions

- No new CLI flag or connection behaviour; the owner's wrapper passes `--server`. No UI, settings or persisted state for
  the explicit server. No runtime switch back to a managed service.
- Only loopback `http` servers. Remote servers keep using the existing HTTP and GUI-plugin entries.
- Nothing in desktop restarts a stopped server. The home unit must use `Restart=always` with no idle stop (aursandbox).
- Cold launches go through the aursandbox launcher (`aursandbox desktop`, the `Exec` line of the `.desktop` file). That
  includes `opencode://` links, which the desktop entry handles. A launch without the variables takes the stock path.
- The home service keeps its password across restarts. It rotates the password only on an explicit rotate, forget or
  reinstall (aursandbox decision). So long-lived `--server` TUI and CLI clients, which read the password once, need no
  reconnect change. The desktop still re-reads `_FILE` on every connect, so a reload or relaunch follows an explicit
  rotation. The renderer marks the server unauthorized and does not ask main to reconnect (found in the 2026-11-09 live
  check).
- The aursandbox launchers build the environment from an allowlist and scrub any inherited `OPENCODE_PASSWORD` or
  `OPENCODE_SERVER_PASSWORD`. That lets the #52156 order (plain variables before the file) stand.

## Interface

| Variable | Value | Read by | Kept in `process.env`? |
|---|---|---|---|
| `OPENCODE_EXPERIMENTAL_DESKTOP_SERVER` | `http://127.0.0.1:<port>` (or `http://localhost:<port>`) | desktop | yes: not secret, survives relaunch |
| `OPENCODE_PASSWORD_FILE` (new) | absolute path to the password file | desktop, CLI | yes (only a path); CLI child sessions strip it |
| `OPENCODE_PASSWORD`, then `OPENCODE_SERVER_PASSWORD` | the password | desktop, CLI (`packages/cli/src/env.ts:10-13`) | desktop deletes them in explicit mode |

- **Explicit mode** means `OPENCODE_EXPERIMENTAL_DESKTOP_SERVER` is set and non-empty, whether or not it parses.
  - These all key off that: the early-probe skip, the deletes, the `DesktopCli` branch, the pairing exclusion and the
    `background-service.ts` branch.
  - A parse failure is kept and becomes the error every connect raises. There is never a fallback to the managed
    service.
- `explicitServer(env)` lives in the new `packages/desktop/src/main/service/explicit-server.ts`.
  - It reads the variables from the `env` it is given and removes the two plain password variables from it.
  - It runs once in `packages/desktop/src/main/index.ts`, after `configureApplication()` (`:15`), before
    `startSidecarProbe()` (`:26`) and before any spawn.
  - The module keeps the result. When the variable is unset, nothing is deleted (stock behaviour).
- URL rules:
  - It must parse, use `http:`, have host `127.0.0.1` or `localhost`, and have no path other than `/`, no query and no
    userinfo. The desktop uses `url.origin`.
  - Loopback only, because the renderer's requests get the Authorization header only for `http://127.0.0.1/*` and
    `http://localhost/*` (`windows/security.ts:101-105`).
  - Prefer `127.0.0.1`. `localhost` relies on Node falling back from IPv6 to IPv4 when the service listens on IPv4 only.
- Password precedence, the same in the desktop and the CLI, following upstream #52156: `OPENCODE_PASSWORD`, then
  `OPENCODE_SERVER_PASSWORD`, then `OPENCODE_PASSWORD_FILE`.
  - If the file variable is reached and the file is missing or fails a check, that is an error, not a fall-through.
  - With none set, no Authorization header is sent, as in the CLI today.
  - Putting the plain variables first breaks no security property:
    - The desktop reads only its launch environment.
    - The login-shell merge happens later and drops the plain variables in explicit mode (step 8).
    - A plain value is only ever sent to the explicit loopback origin. A stale one gets a 401, so it fails closed.
  - The cost of this order is robustness, not security. A stray inherited plain variable shadows the file and stops
    rotation. The launchers scrub such variables (see assumptions).
  - The desktop deletes the plain variables in explicit mode in either case.
- Shared reader `readPasswordFile(path)` (no other parameters) in `packages/util/src/password-file.ts` (`@opencode/util/password-file`; util
  exports `./*`):
  - Opens with `O_RDONLY | O_NOFOLLOW`, then calls `fstat`.
  - The file must be regular, owned by `process.getuid()`, and have `(mode & 0o077) === 0`.
  - Reads at most 4 KiB and trims all surrounding whitespace (`String.prototype.trim`), as #52156 asks.
    - Why trim all of it: systemd credentials and editor-written files end in `\n`, sometimes `\r\n`, and sometimes
      have stray spaces. Generated passwords are base64url (`packages/cli/src/server-process.ts:93`).
    - A password that needs a leading or trailing space can still be given in the plain variable, which is not
      trimmed.
    - An empty result after trimming is an error.
  - Rejected on Windows, where there is no `O_NOFOLLOW`. This is a one-line `process.platform` check and is not unit
    tested (no test-only parameter).
  - It throws a typed error with a reason (`symlink`, `owner`, `mode`, `size`, `missing`, `platform`), and each caller
    maps that to its own message.
  - Why util: the CLI already depends on it. The desktop gets it through `@opencode/app`, `@opencode/plugin` and
    `@opencode/gui-plugins`, and adds a direct `workspace:*` dependency. The other shared dependency, `@opencode/client`,
    is a published SDK with an explicit export list, and a `node:fs` helper does not belong on that surface.
    `@opencode/schema` holds pure schemas. util is not part of the AGENTS.md Schema/Core/Protocol/Server/Client rule.
- `OPENCODE_DESKTOP_SERVER_CHANNEL` and `OPENCODE_DESKTOP_ISOLATED_SERVER` are ignored by the service connection in
  explicit mode (`background-service.ts:104,112`). `desktop-cli.ts:77` still reads the isolated flag in dev builds.

## Desktop behaviour per flow step

The explicit server becomes the existing built-in `sidecar` entry. The renderer is unchanged and only learns the origin:
- `SidecarCredentials.ready`, `sidecar-credentials.ts:31-33`;
- `ServerConnection.Sidecar`, `packages/app/src/runtime/server/registry.tsx:160-165`;
- `packages/desktop/src/renderer/desktop-app.tsx:91-102`.

Main keeps the password in `SidecarCredentials` and adds it to each request (`windows/security.ts:105` computes the
header, `:107-108` add it; `plugin/host.ts:303-327`).
`BackgroundServiceMachine` is unchanged.

1. **Early probe** (`service/sidecar-probe.ts:14-20`): in explicit mode it returns before `Service.discover`.
2. **Layer** (`background-service.ts:27-44`): explicit mode passes `probe: Effect.succeed(undefined)` and
   `ensure: () => connectExplicit(server, bundled)`. Here `bundled` is the `opencode-cli.version` text, or undefined on
   beta or when the file is empty; `background-service.ts` gets it from `sidecar-probe.ts:30-36` (exported) and
   `CHANNEL`. `explicit-server.ts` imports nothing from `electron` or `constants.ts`, so its tests, including the
   `Bun.serve` ones, run under plain `bun test`. This skips:
   - `prepare` (`:100-121`);
   - `Service.ensure` and its versioned retry (`:57-83`);
   - `cleanStages` (`:90-95`);
   - the registry read in `adopt` (`:123-155`);
   - the import of `@opencode/client/service`.
3. **`connectExplicit`**:
   - throws the stored parse error, if there is one;
   - resolves the password, re-reading the file when `_FILE` is set;
   - sends `GET <origin>/api/info` with Basic auth and `AbortSignal.timeout(5_000)`, the CLI's timeout.
   Only a 200 whose body has a string `version` counts as connected (the body is `{ version, pid, urls, paths }`,
   `packages/server/src/process.ts:221`). The other outcomes map to errors:
   - 401: the password error;
   - 404: the incompatible error;
   - 500 or 503 (`packages/server/src/process.ts:219-224`), network errors and timeouts: the unavailable error.
   On success it returns `{ url: origin, password }`.
4. **Reconnect and retry**: every later connect runs the same `connectExplicit`. That covers a reconnect
   (`background-service-machine.ts:299-311`) and a new initial attempt after a failed first connect (`:103-118`).
   - `same()` compares the URL and the password (`:244-246`). A rotated password is therefore published, and
     `SidecarCredentials.set` updates the header in `security.ts`. The plugin host follows it through
     `SidecarCredentials.onChange` (`plugin/host.ts:449`).
   - A failure rejects only the reconnect waiters (`:190-195`). Nothing is killed or spawned.
5. **Version**: the probed version is compared with the `bundled` argument from step 2. The check is skipped when
   that argument is undefined. A mismatch logs `Effect.logWarning`, and the
   connection continues.
6. **Bundled CLI** (`desktop-cli.ts:82-95`): in explicit mode `resolveBundledCli` returns
   `{ version: <opencode-cli.version> || VERSION (constants.ts:9), binary: bundled, command: [bundled] }`.
   - It never stages (`installCli`, `:144-169`) and never runs `--version` (`:132`); see the next section for why.
   - The plugin host still gets a `Cli` (`plugin/index.ts:46-57`). SSH uploads `cli.binary` and also runs it on the
     host as the askpass program:
     - `packages/gui-plugins/src/ssh/controller.ts:162-165,181-182` sets the helper;
     - `packages/gui-plugins/src/ssh/askpass.ts:81-82` passes it as `SSH_ASKPASS` with `SSH_ASKPASS_REQUIRE=force`.
   - The user-triggered CLI installer (macOS only, `desktop-cli.ts:44`; `ipc.ts:53`, `desktop-cli.ts:199-215`) runs
     `"$APP" --version` through the install script.
   - The `VERSION` fallback (`constants.ts:9`) stays at this call site in `desktop-cli.ts`, not in `explicit-server.ts`.
   - Owner decision: both stay available in explicit mode. Neither touches a service. Each creates OpenCode folders in
     the real home when used (see the next section).
7. **Pairing** (owner decision): in explicit mode main filters the `pairing` built-in out of `definitions`
   (`plugin/host.ts:206`, which takes `builtins`; pairing enters through `packages/gui-plugins/src/main.ts:28`; the id
   is `"pairing"`, `pairing/contract.ts:10`), so no `service` command can run.
   - Its remote-access toggle runs the host CLI: `service get remote`, `service set remote <bool>` and `service start`
     (`pairing/main.ts:86-97`, `main-machine.ts:172,210,230`). Those commands stop and ensure services through the
     host registry.
   - The renderer is unchanged and does not learn explicit mode. It mounts the `@opencode/gui-plugins/renderer`
     built-ins on its own (`packages/app/src/runtime/plugin/root.tsx:53`), so the Pairing page stays listed.
   - The whole Pairing page is inert, not only its toggle.
     - The Ipc has no main provider, so it stays `pending` (`packages/app/src/runtime/plugin/host.tsx:246-254,663`).
     - `pairDisabled` is therefore true (`gui-plugins/src/pairing/machine.ts:801,805`), so the Pair button is disabled.
     - No "unavailable" message shows, because that needs `inactive` (`:820`).
     - The remote and screen settings rows are hidden (`pairing/renderer.tsx:33`).
   - Accepted as is: the owner chose no renderer change. Devices are paired, and remote access is configured, from the
     sandbox. Showing the message would mean listing pairing as disabled to the renderer, which adds scope.
8. **Shell env merge** (`lifecycle/environment.ts:44-56`): before `Object.assign`, the merge drops these from `shellEnv`:
   - `OPENCODE_EXPERIMENTAL_DESKTOP_SERVER` and `OPENCODE_PASSWORD_FILE`, in every mode;
   - the two plain password variables, in explicit mode only.
   So the launch environment alone decides the mode, and a login shell cannot re-add a password.
9. **Quit and relaunch**: quit is unchanged. A relaunch (`lifecycle/index.ts:76`; from the menu, the recovery dialog or
   a plugin restart) inherits `process.env`, so it stays in explicit mode.
   - With `_FILE` alone it works.
   - With a plain password, the deleted variable leaves only `_FILE`, if it is set. Otherwise the relaunch fails closed
     with the password error.

## CLI change (`OPENCODE_PASSWORD_FILE`)

This builds on upstream #52156 ("add OPENCODE_PASSWORD_FILE", systemd credentials). The author offered a PR there. If
that lands first, this hunk shrinks to what it lacks: the shared checks, the `Env.session()` strip and the desktop use.

- `Env.password` (`packages/cli/src/env.ts:10-13`) becomes, in the #52156 order:
  1. `OPENCODE_PASSWORD`;
  2. `orElse` `OPENCODE_SERVER_PASSWORD`;
  3. `orElse` `Config.String("OPENCODE_PASSWORD_FILE")`, mapped through `readPasswordFile` into a `Redacted` value with
     `Config.mapEffect`. A reader error fails with
     `new ConfigError(new SourceError({ message: <reason>, cause }))`. This is effect 4.1.0: `Config.ts:474` and
     `ConfigProvider.ts:214-217`; there is no `mapOrFail`. `withDefault` lets source errors propagate (`Config.ts:847`);
  4. the existing `withDefault(undefined)`.
  - An unreadable file is an error, not a fall-through to no password.
  - Not in scope from #52156: `service set password_file`, a config `password_file` for service mode, and
    `--credential-name`. Service mode keeps `config.password || random` (`packages/cli/src/server-process.ts:91-93`).
- `Env.session()` (`env.ts:15-21`) filters out only `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD` today. Add
  `OPENCODE_PASSWORD_FILE` to that filter. It is used at:
  - `packages/cli/src/commands/handlers/default.ts:145`;
  - `packages/cli/src/mini.ts:43`;
  - `packages/cli/src/run/run.ts:106`.
- `packages/cli/src/server-process.ts:87-90` deletes the plain variables in stdio mode; it also deletes `OPENCODE_PASSWORD_FILE`.
- Consumers are unchanged:
  - the explicit `--server` path (`packages/cli/src/services/server-connection.ts:35`) gets the file password;
  - a manual or stdio `serve` (`packages/cli/src/server-process.ts:85`) adopts it as its own password;
  - service mode ignores it, as it ignores the plain variables (`:91-93`).
- The file is read once per process. `Env.password` is read once in `ServerConnection.resolve`, and the explicit path
  has no reconnect (`server-connection.ts:49`, no `service`). Managed reconnects use the registry password and never
  call `Env.password`. Once per process is enough, because the home service keeps its password across restarts (see
  assumptions).

## Verified: `opencode --version` writes to the real home

- `--version` is handled inside `Runtime.run` (`packages/cli/src/index.ts:130`).
- That effect is provided with `Global.layerWith(...)` (`:141-149`). Building the layer runs `acquire`, which runs
  `mkdir -p` on the data, config, state, log, cache/bin, repos and tmp paths (`packages/util/src/global.ts:63-72`)
  before any command runs.
- Stock desktop runs `--version` only when `opencode-cli.version` is missing (`desktop-cli.ts:101-132`). It stages a
  copy on every packaged launch (`:92`). Explicit mode does neither (step 6).

## Failure modes (desktop)

| Case | Result |
|---|---|
| Server down at launch, or still starting (503 with `retry-after: 1`, `process.ts:223-224`) | Unavailable error. The machine goes to `failed` (`background-service-machine.ts:151-155`) and does not retry in process. `desktop-app.tsx:233-235` dispatches `startup.failed`, and the error page (`packages/app/src/shell/errors/error.tsx:207`) has one action, Restart (`:429-430`), which is `app.relaunch()` (step 9). With `_FILE` the relaunch stays in explicit mode and runs `connectExplicit` again. With a plain-variable password it fails closed with the password error. Nothing is started. |
| Wrong or missing password, or the file not yet rewritten | 401 gives the password error. With `_FILE`, the next attempt re-reads the file. |
| Password file is a symlink, owned by another user, group- or world-readable, too large, or missing | Password-file error; no request is sent. |
| 404 on `/api/info` | Incompatible error. |
| Version mismatch | A warning in the main log; the connection continues (CLI parity, `server-connection.ts:45-48`). |
| Password rotated explicitly (the server restarts) | Requests get 401. The renderer does not ask main to reconnect, so `_FILE` is not re-read until the user reloads the window (View > Reload) or relaunches; then the changed password is published and requests resume. A restart with the same password reconnects by itself. This needs a fixed port. A plain-variable password cannot rotate. Found in the 2026-11-09 live check. |
| Relaunch | Stays in explicit mode (step 9). A plain-variable password is gone after the first launch. |
| Invalid URL value | Invalid-URL error on every connect. No discover and no fallback; the password variables are still cleared. |

Accepted risk: a launch that races the unit's start or restart gets a 503 or a refused connection, and ends on the
error page. Stock mode does not hit this, because `Service.ensure` waits for the service it starts. It is accepted
because the aursandbox launcher runs `aursandbox home ensure` before it execs the desktop. A possible follow-up, not in
scope here: `connectExplicit` could retry 503 and connection-refused for a bounded window, honouring `retry-after`.

Errors are thrown as `new Error(nativeT(key, params))`, the same pattern as `files/attachment-picker.ts:103`. The error
page shows `cause.message` (`packages/app/src/shell/errors/error.tsx:207`).

There are five English keys in `DESKTOP_NATIVE_ENGLISH` (`packages/app/src/runtime/i18n/desktop-native.ts`):
| Key | English copy (proposed, for owner review) |
|---|---|
| `desktop.server.explicit.invalid` | `OPENCODE_EXPERIMENTAL_DESKTOP_SERVER must be http://127.0.0.1:<port> or http://localhost:<port>` |
| `desktop.server.explicit.unavailable` | `The OpenCode server at {{origin}} is not reachable or not ready` |
| `desktop.server.explicit.unauthorized` | `The OpenCode server at {{origin}} rejected the password` |
| `desktop.server.explicit.incompatible` | `The server at {{origin}} is not a compatible OpenCode server` |
| `desktop.server.explicit.passwordFile` | `Cannot use the password file {{path}}: it must be a regular file owned by you and readable only by you` |

No locale files are added (owner decision). Locale files are typed as `satisfies Partial<Record<Keys, string>>`, so
English is the fallback. CLI errors are plain stderr text, like the existing CLI messages.

## Security notes

- The password stays in main (`SidecarCredentials`). It is sent only to the explicit origin and never reaches the
  renderer (`ready()` strips it).
- Deleting the plain variables keeps them out of later desktop children: the login-shell probe
  (`service/shell-env.ts:38`), open-in-app (`files/index.ts:143,161`), the installer (`desktop-cli.ts:199-203`) and
  GUI-plugin processes.
- The plain variables still sit in the initial environ of the Electron main process. On Linux they are also in the
  initial environ of the zygote and of the renderer, GPU and network processes forked from it. Only same-uid processes
  can read those, and the preload exposes no `process.env`.
- `_FILE` avoids that exposure, because only the path is in any environ. Same-uid processes can read the file, as with
  any per-user secret. The checks stop a symlink swap and a world- or group-readable secret.
- No explicit-mode path can signal a pid. The only `process.kill` callers are in `@opencode/client/service`, which is
  not imported, and in the pairing CLI commands, whose main side is left out. That leaves the Pairing page inert
  (step 7).

## Dropped from the old branch

All of `git diff a9a067f12d..service-autostart` (438 lines added, 35 removed) is dropped:
- CLI: the `env.ts` `serviceAutostart` variable, `service-config.ts`, `server-connection.ts`, `pair.ts`,
  `service/start.ts`, `service/restart.ts`, their tests and the `cli.mdx` line.
- Client: `EnsureOptions.manage`, `ServiceUnavailableError`, the `manage:false` branches and their tests.
- Desktop: `service-autostart.ts` and its test, and the `manage` wiring.

Only one pattern is reused: a parser over an `env` object, with a table test.

## Size (approximate)

| Area | Lines |
|---|---|
| Source | ~150 |
| Tests | ~180 |
| **Total** | **~330**, against 438 added and 35 removed in the old branch |

Source:
- `util/src/password-file.ts`: ~35.
- `desktop/.../explicit-server.ts`: ~60.
- `background-service.ts`, `sidecar-probe.ts`, `index.ts`, `environment.ts`, `desktop-cli.ts`, `plugin/host.ts`, and
  `desktop/package.json`: ~30 in total.
- `packages/cli/src/env.ts` and `packages/cli/src/server-process.ts`: ~12.
- 5 i18n keys.
- Docs: a desktop README section, plus a `cli.mdx` env-table row for `OPENCODE_PASSWORD_FILE`. About 10 lines.

## Tests

- **`packages/util`, `password-file.test.ts`**, using temp files:
  - 0600 is accepted, and surrounding whitespace (`\n`, `\r\n`, spaces) is trimmed;
  - a file that holds only whitespace is rejected;
  - rejected: 0640, 0604, a symlink to a 0600 file, a directory, a file over 4 KiB, and a missing file;
  - Owner mismatch needs root, so it is not tested.
- **`packages/cli`, `env.test.ts`** (extend):
  - `OPENCODE_PASSWORD` beats `OPENCODE_SERVER_PASSWORD`, which beats `_FILE`;
  - `_FILE` is used when it is the only one set;
  - a bad file fails and does not fall through;
  - `Env.session()` omits all three variables.
- **`packages/desktop`, `explicit-server.test.ts`**, one table over `env` objects:
  - unset or empty: off, and `env` is untouched;
  - valid `127.0.0.1` and `localhost` origins;
  - rejected: https, other hosts, `[::1]`, a path, a query, userinfo, and garbage. Explicit mode is still on, the error
    is kept, and the password variables are removed.
  - The URL and `_FILE` variables stay in `env`.
- **`connectExplicit`**, against a `Bun.serve` stub. It can load because `explicit-server.ts` imports neither `electron`
  nor `constants.ts`; the test passes `bundled` directly:
  - 200 returns the origin and password, and the request carries the expected Authorization header;
  - 401 gives the password error, 404 the incompatible error, and a 503 or closed port the unavailable error;
  - a version mismatch still connects;
  - rewriting the file between two calls returns the new password.
- **Manual**, using the launcher and the home service:
  - `systemctl --user restart` with desktop open: with the same password the session resumes; after a rotation it
    resumes only after View > Reload or a relaunch (2026-11-09 live check);
  - menu Relaunch;
  - `~/.config/opencode`, `~/.cache/opencode`, `service.json` and `<userData>/cli/` stages are never created on the host
    as long as SSH remotes and the CLI installer are not used (SSH askpass and, on macOS, the installer create the
    folders by design, step 6). Repeat this with `opencode-cli.version` removed. It covers the `desktop-cli.ts`
    explicit branch, which cannot load under `bun test` (`install?raw` import, `electron` in `constants.ts`);
  - the Pairing page is inert: the Pair button is disabled and no message is shown;
  - start the desktop while the unit is stopped: it shows the error page, and Restart connects once the unit is up;
  - the CLI connects with `--server` plus `OPENCODE_PASSWORD_FILE`.

## Review points declined

None. From the first review, M5 (the machine-level test) was dropped as advised: the machine is unchanged and already
covered. From the clean review:
- I3: the `desktop-cli` unit test was dropped in favour of the manual check.
- M4: the `platform` parameter and the win32 test were dropped, not kept as test-only.

## Upstream

- Ships on the fork (`local-build`) first. The upstream issue draft goes to the owner before anything is filed:
  `2026-11-09-desktop-explicit-server-issue.md`, next to this spec.
- #52156 (open, rektide): `OPENCODE_PASSWORD_FILE`. The CLI half of this spec follows its order and trimming.
  - Its comments are from the author, users and the `opencodejr` bot. No maintainer decision is visible.
- Related open issues, none with a maintainer comment (bot and user comments only), so acceptance is unknown:
  - #55908, never autostart a detached `serve --service`;
  - #55861, desktop ignores `service set disabled`;
  - #51430, loopback `opencode://connect` links.
- Open PR #60683 edits `background-service.ts`, `sidecar-probe.ts` and `desktop-cli.ts`, so a rebase conflict is
  likely. #55311 touches only the managed path.
- An upstream PR would likely be asked for translations: about 60 locale files with 5 keys each, checked against
  corpora.

- The file reader requires the file to be owned by the current uid. #52156 targets systemd system-service credentials,
  and their ownership under `User=` has not been verified here. Upstream review may ask to relax that check to allow
  root-owned files that the user can read. This does not affect the fork: aursandbox writes the file as the user.

## Open questions for the owner

None. Pairing, the password-file variable in the CLI, the target, the password-rotation model and the precedence order
are all decided (see assumptions and Interface).
