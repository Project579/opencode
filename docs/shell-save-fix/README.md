# shell-save-fix: reference for aurgate

Not headed upstream and not merged into local-build (dropped 2026-11-09). It stays on the Project579 fork as a
reference for aurgate, which takes over correct "always" saves for shell commands.

## The problem

A shell permission request carries `save`: the patterns core stores as allow rules when the user answers "Allow
always". Core computes them in `packages/core/src/shell/parse.ts` from an arity table, and matches saved rules with
`Wildcard.match`, which treats `*`/`?` as wildcards and reads `\` as `/`. The saved pattern is often wider than what
the user approved: `timeout 10 git status` saves `timeout *`, which then allows `timeout 5 rm -rf ~`.

## What the branch does (commits b5f9a74163, 1a8e36272a, edd057d99e)

- A wrapper saves itself with what it runs: `timeout 10 git status *`, `sudo FOO=1 git status *`, `bash script.sh *`.
- Leading assignments and redirects stay in the save (scanner `commandOffset`, as in upstream #61442).
- A wrapper with options, a script runner (`bash -c`, `eval`, `su`, `watch`), a `find` that runs or writes, or a
  redirect between a wrapper's words saves the exact command.
- No save (no "always" offered) when the save would hold a `*`/`?` from the command, or a `\` in the head, wrapper or
  exact save other than `\;` or a line continuation.
- Tests: `packages/core/test/permission.test.ts` ("saves the exact command…", "offers no always…").

## Gaps found

`gaps.md` lists 15 gaps, each run through the real scanner on this branch and on dev. Probes and cases are in
`probe/`. Summary:

- High widening, all also on dev: shells fed on stdin (`curl … | sh`), xargs into a shell, variables in saved words
  (`$EDITOR *`), options before the subcommand (`git -C x push` saves `git -C *`), `find . -name x` saves `find *`,
  interpreters and `source` (`python3 *`), unhandled shells and runners (`fish`, `pwsh`, `parallel`, `uvx`, `bunx`,
  PowerShell `iex`), options that run code (`sed`, `awk`, `rg --pre`, `git fetch --upload-pack`).
- Medium: `git >out push` saves `git *`; `> out.txt` saves `> *`; `'git' push` saves `'git' *`.
- Usability: tab or line break after the program (rule never matches), `sudo  rm x` exact only, `command -v git`
  exact only.
- Also known: unmodelled wrappers (`pkexec`, `unshare`, `runuser`, `nsenter`, `taskset`, `script -c`) save
  `<name> *`; plain commands with a backslash widen (`\git push` saves `\git *`, which matches `/git`). The owner
  chose to refuse saves with a backslash.

## How aurgate can cover this without more core changes

The core hooks in local-build are enough:

1. **Veto.** The `permission.evaluate` hook runs when a core saved rule allowed a request and marks it
   (`experimental.rules[].saved: true`, permission-provenance). aurgate sets `ask` unless one of its own rules covers
   the command. Core re-evaluates pending requests after an "always" reply through the same hook
   (`permission.ts:370`), so there is no window.
2. **Translate stock "always".** Server plugins can subscribe to events. On `permission.asked` record the command and
   core's `save`; on `permission.replied` with `always`, add aurgate's own narrow or exact rule. (Check that the asked
   event carries `save`.)
3. **Own choices.** Extend `src/candidates.ts` with the gaps above: backslash words, options before the subcommand,
   interpreters/runners, the missing wrappers, `find`, stdin-fed shells (offer only the exact command line), variables,
   and spacing (aurgate's own matching can compare text as written).
4. **Old rules.** Treat core saved rules made without aurgate the same way; the TUI/GUI can move them
   (`legacy` + `client.permission.saved.remove`).

## Not possible without core

- Changing core's `save` text: stock prompts (ACP, SDK/API, TUI or desktop without aurgate's prompt) still show
  "Always allows: `timeout *`".
- Hiding stock "Allow always" for unsavable commands: those clients still offer it. The veto keeps it safe; the label
  misleads and the user is asked again.
- Keeping the wide rule out of core's store: core writes it on reply; server plugins have no saved-rule API. Only
  aurgate's TUI/GUI parts can delete it, while open.
- Protection without aurgate (not loaded, disabled after an error, another machine): fails open to core's wide rules.
- Hook order: a later plugin's evaluate hook could set `allow` again.

## Not possible anywhere (rules match command text)

- A prefix approval of a program that runs code from its arguments or configuration (`make *`, `npm run *`, git
  aliases and hooks, `sed`/`awk` scripts, `ssh host *`, `docker exec *`). aurgate can warn or offer only the exact
  command.
- What scripts do at run time: `./build.sh` after its content changes, write-then-run, PATH changes, aliases.
