### Feature hasn't been suggested before.

- [x] I have verified this feature I'm about to request hasn't been suggested before.

### Describe the enhancement you want to request

**Title:** desktop: connect to an explicit local server instead of managing the background service

**Problem**

The CLI can attach to a server that is already running: `opencode --server <url>`, with the password in
`OPENCODE_PASSWORD`. That path probes `/api/info`, warns on a version mismatch, and leaves the server alone.

The desktop app has no equivalent. It always manages the background service through `Service.ensure`:
- it starts a `serve --service` when none is registered;
- it replaces the registered service when the version differs;
- it terminates it after repeated probe timeouts.

That is a good default. But when a local server is already run and supervised by something else, for example a
systemd user unit, the desktop competes with that supervisor. It can stop the supervised server on an app update, or
start a second, unsupervised one when the supervised one is briefly down. `opencode service set disabled true` does not
affect the desktop (#55861). #55908 describes the same thing from the CLI side.

**Proposal**

An experimental environment variable that makes the desktop use a given local server and never manage one:

- `OPENCODE_EXPERIMENTAL_DESKTOP_SERVER=http://127.0.0.1:<port>` (loopback `http` only, matching the origins the
  desktop already authenticates).
- The password is resolved the way the CLI resolves it for `--server`, extended by #52156 (`OPENCODE_PASSWORD_FILE`).
  The order is `OPENCODE_PASSWORD`, then `OPENCODE_SERVER_PASSWORD`, then `OPENCODE_PASSWORD_FILE`. Surrounding
  whitespace is trimmed, and a missing or unreadable file fails loudly. The desktop would read the password file with
  the same reader as the CLI. That reader also requires a regular file (not a symlink) that is owned by the user and
  not readable by group or others. This builds on #52156 rather than replacing it; the new ask here is the desktop
  server variable.

When the URL variable is set:
- The desktop adopts that server as its built-in local server entry. The renderer, the plugin host and the request
  authentication are unchanged.
- It never discovers, starts, replaces, stops or signals a background service. For the server connection it does not
  stage or run the bundled CLI, and it does not clean CLI stages. User-triggered features that run the CLI, such as
  the SSH askpass helper and the macOS CLI installer, still work.
- A reconnect only re-probes the same URL. With `OPENCODE_PASSWORD_FILE`, it re-reads the file, so a server restarted
  with a new password is picked up.
- A version mismatch is a logged warning, as in the CLI.
- An unreachable server, a rejected password or an invalid value shows the normal startup error page. Its Restart
  button relaunches the app and connects again. There is no fallback to starting a service.
- The plain password variables are removed from the app's environment after reading, so child processes do not
  inherit them.
- The pairing plugin's remote-access toggle drives `opencode service set/start` against the local registry, so its
  main-process side is not loaded in this mode. The Pairing page is then inert: the Pair button stays disabled and no
  message is shown. Devices are paired from wherever the server is managed.

The desktop part is limited to `packages/desktop`, five native i18n keys in `packages/app`, and the reader in
`packages/util`. The password-file part is #52156 (`packages/cli/src/env.ts`),
with its reader in `packages/util` so the desktop can share it. No client, protocol or server changes.

Related: #52156 (`OPENCODE_PASSWORD_FILE`), #55861, #55908, #51430 (loopback connect links for local launchers).
