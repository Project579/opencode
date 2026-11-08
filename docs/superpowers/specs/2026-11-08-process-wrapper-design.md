# Process wrapper: run OpenCode's child processes through an external sandbox

Status: design, owner-approved direction (route B, environment variable only); builder check done, findings folded in. Date: 2026-11-08. Owner: Project579.
Research: `/home/rq279/GitHub/opencode/.worktrees/research/reports/Spawn wrapper research.md` and `Process spawn map.md` (spawn-site tables with file:line).

## Why

The owner runs OpenCode inside an external sandbox (nono). The server process gets the owner's chosen rights, which are broader than any single tool needs (for example, read access to the Claude config folder). Agent shell commands already run tighter: `SHELL` points at a wrapper script that starts bash in a fresh, narrower sandbox. Every other process the server starts skips that wrapper and inherits the server's full rights: MCP servers (third-party code the agent drives), formatters (which load project config such as `prettier.config.js`), the worktree start command, integration auth commands, git and ripgrep.

The owner wants one generic way to route all of them through a wrapper of the user's choice, not tied to nono, shaped so upstream could accept it as the way to plug in any external sandbox system (nono, bubblewrap, firejail, a container runner, …).

## Goals

- When a wrapper is configured, every process started through the server's host process spawner runs as `<wrapper argv…> <command> <args…>`, with the command's own cwd and env passed through.
- When no wrapper is configured, behaviour is byte-for-byte unchanged.
- Sandbox-agnostic: the wrapper is just an argv prefix; OpenCode knows nothing about what it does.
- Smallest core footprint that covers the shared spawner (estimate: about 6 files, about 50 lines), in the shape upstream already uses for server settings.
- Acceptance test (from the owner's sandbox test session): with the wrapper set, a stdio MCP server's process runs under it and cannot list the Claude config folder; with it unset, nothing changes.

## Non-goals

- Interactive terminals (PTY: `core/src/pty.ts`, `core/src/persistent-pty`), the `opencode-pty` daemon binary and its shells, the `claude` CLI started by the Claude Agent SDK, and pacote's internal `git`. These do not go through the shared spawner; the owner chose to leave them out.
- Processes started on the client host (opening URLs, `$EDITOR`, the npm launcher) and the CLI's own process graph (updater, `lsof`/`ps`, pager, the `opencode serve` re-exec). The CLI builds its own spawner; leaving it unwrapped is correct.
- LSP processes: the v2 core starts none today (port tracked in upstream issue #38528). When it does, they should inherit the wrapper by using the shared spawner.
- Per-kind wrappers or profiles (one for MCP, another for formatters). One wrapper for everything.
- A plugin hook. Plugins are scoped to one project location, and most spawns (git, worktree, pooled MCP, the global `AppProcess`) happen outside that scope, so a hook could reach only 5 of 31 sites without a larger refactor.

## Anti-goals (failure even if it "works")

- Any behaviour change when the option is unset.
- Naming or assuming a specific sandbox tool anywhere in core.
- Wrapping a spawn more than once: the prefix is applied once per spawn (the spawner never re-enters itself for a segment); double wrapping through `SHELL` is a docs matter.
- Breaking process-group termination: OpenCode kills the whole process group, so a wrapper that started a new session would orphan children.
- A repo's `opencode.json` being able to remove or change the wrapper (see Decided).

## Constraints

- Plugin first, core minimal (owner rule). No plugin route reaches the shared spawner (see Non-goals), so this is one small core change built on existing patterns.
- Upstream conventions (repo `AGENTS.md`): new options start `experimental`; options that are inert when unset don't need a feature flag (say so in the PR body); after changing the public server options, regenerate the client if the options surface is part of it (`bun run generate` in `packages/client`).
- Keep local for now (owner): branch `process-wrapper` off `origin/dev`, added to `local-build.sh`; issue and PR drafts later if the owner decides to go upstream.

## Decided (by the owner)

- Route B: a server option, not a custom launcher, so it applies to every way a server starts (`opencode serve`, the managed service the TUI starts, the desktop app's `serve --service`) as long as the environment variable is set in that process's environment (see below).
- Scope: everything that goes through the shared host spawner (`util/src/cross-spawn-spawner.ts`); the terminals and the four unreachable processes above are skipped.
- Generic, not nono-specific; one wrapper.
- **The environment variable is the only input, documented as "set it wherever the server starts"** (owner, 2026-11-08). It behaves like every other start-time server setting (`OPENCODE_CONFIG_DIR`, `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_GIT_BASH_PATH`, the file-watcher switches): it is read when the server starts; a client that attaches to an already-running server does not pass its value; the desktop app started from the desktop menu sees the login environment, not a shell's. Document both cases (for desktop: set it in the login environment, for example `~/.config/environment.d/`). No server-info field, no client mismatch check, no global-config key: those would make this one setting behave differently from the rest. A general "this server was started with different settings" check for all start-time settings is a possible separate follow-up.

## Decided (by the designer, open to the owner's veto)

- **Shape, mirroring the Windows Git Bash setting** (`OPENCODE_GIT_BASH_PATH` → `ServerOptions.windows.gitbash` → `ShellSelect.node.replace(ShellSelect.configured({ gitbash }))` in `server/src/routes.ts:144`):
  1. Server option under an `experimental` key carrying the wrapper argv, for example `experimental.process.wrapper: string[]` in `server/src/options.ts`.
  2. `CrossSpawnSpawner.configured({ wrapper })` in `util/src/cross-spawn-spawner.ts`: prefixes the wrapper in the `StandardCommand` case; returns the existing layer unchanged when the wrapper is empty or absent.
  3. One standard replacement in `server/src/routes.ts`: `CrossSpawnSpawner.node.replace(CrossSpawnSpawner.configured({ wrapper: options.experimental?.process?.wrapper }))`. Embedders that replace the spawner themselves (workerd, `server/src/workerd.ts:84`) keep working because their replacement is applied after the standard ones.
  4. The CLI maps an environment variable, `OPENCODE_PROCESS_WRAPPER` (a JSON array of strings), to that option in `cli/src/server-process.ts`, next to `gitbash`. Invalid JSON or a non-array fails at server start with a clear error rather than running unwrapped.
- **A repo cannot turn it off.** Project `opencode.json` never reaches server options, so the wrapper holds regardless of repo config. This matches the owner's sandbox test session, whose spec requires the sandbox to protect itself from repo config.
- **One exemption:** the macOS managed-policy read (`plutil` in `core/src/config.ts:253`) is never wrapped, because a sandbox denial there would silently drop managed policy. Implement as an explicit bypass on that one call (for example a context reference or a spawn option), not a name check.
- **Docs, not code, for wrapper behaviour:** document that the wrapper must `exec` its child (no extra layer that swallows signals), must not start a new session or process group (for example `bwrap --new-session`), and that `SHELL` should be plain bash when the wrapper is set, or shell commands get wrapped twice. With `SHELL` plain, the interactive terminal panes (out of scope) run unwrapped like a normal terminal on that machine; the owner considers that a positive (2026-11-08): those panes are the user's own shells, the agent has no tool that types into them, and the agent's commands still go through the wrapper.

## Facts the builder check confirmed (2026-11-08, origin/dev caf8d6a554)

- The Git Bash path is `cli/src/server-process.ts:136` → `server/src/options.ts:43-47` → `server/src/routes.ts:144` → `core/src/shell/select.ts:226-230` (`configured(options)`, with `node = configured()`).
- `routes.ts:154-160` builds `[...standard, instances, ...overrides]`, so workerd's and simulation's later replacements win over the new standard one.
- The prefix belongs in the `StandardCommand` case (`util/src/cross-spawn-spawner.ts:544`): `PipedCommand` (line 637) calls `spawnCommand` per segment, so piped commands are covered too. Wrapping at the service level with `mapLayer` would miss those segments.
- `cross-spawn-spawner.ts` has no `configured` export today: `layer` is a private constant (lines 687-692), so this means turning it into a factory used with `makeGlobalNode` (ShellSelect uses `makeLocationNode`).
- `ServerOptions` has no `experimental` key yet; adding one is a new top-level schema field.
- The plutil call goes through `AppProcess.run`, which spawns in the caller's fiber (`util/src/process.ts:144-148,199`), so a context reference set around that one call reaches `spawnCommand`. Use a context reference for the bypass; a new spawn option would need a change to Effect's own `ChildProcess.CommandOptions` type.
- No other in-scope spawn goes around the shared spawner: the only raw `node:child_process` use outside it in core, server, util and plugin source is `core/src/persistent-pty/daemon.ts` (a non-goal). Desktop doesn't embed a server; it runs the CLI `serve --service` (`desktop/src/main/service/background-service.ts:67-72`).

## Testing

- Unit (util): with a wrapper, a spawned command's argv is `[...wrapper, command, ...args]` with cwd and env unchanged; without, identical to today; the bypass.
- Server-level: with the option set, a stdio MCP server started by OpenCode runs under a test wrapper that records its argv (a small script), proving the MCP path goes through the shared spawner; same for one formatter and the shell tool.
- Owner's acceptance test, run live by the sandbox test session: wrapper = a nono profile without the Claude config folder; the MCP server cannot list it; unset → unchanged.
- CLI: the parser accepts a JSON array of strings and rejects anything else; the wiring into the server options is typechecked (as for `gitbash`).

## Left to the builder

- Exact option name under `experimental` and whether it belongs in client-generated types.
- `configured(...)` layer versus a context reference for the prefix and the bypass; follow whatever the spawner module already does.
- Windows: the worktree start command runs with `shell: true` there; the wrapper is POSIX-first. Pick behaviour that cannot break Windows when the option is unset, and document what happens when it is set.
- Where the wrapper docs live (server options docs or a sandboxing page).
