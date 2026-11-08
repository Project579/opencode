export * as ShellParse from "./parse.js"

import { Effect, Result } from "effect"
import fs from "fs"
import os from "os"
import path from "path"
import { ShellScan } from "./scan.js"
import { ShellSelect } from "./select.js"
import { ShellSpacing } from "./spacing.js"
import { Wildcard } from "../util/wildcard.js"

type Part = { type: string; text: string; raw: string; unquotedTilde?: boolean }
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const POWERSHELL_LITERAL_FLAG_RE = /^-(?:lp|l(?:i(?:t(?:e(?:r(?:a(?:l(?:p(?:a(?:t(?:h)?)?)?)?)?)?)?)?)?)?|psp(?:a(?:t(?:h)?)?)?):?$/i
const POWERSHELL_STACK_FLAG_RE = /^-(?:stack(?:name|nam|na|n)?|st):?$/i

export type Result = {
  commands: Array<{ resource: string; save: string }>
  directories: string[]
  /**
   * Commands that a wrapper such as `env`, `timeout`, `xargs` or `bash -c`, or leading `NAME=value` assignments, run.
   * Check them so deny rules hold through the wrapper, but never require them to be allowed or save them: the
   * commands above are what a user approves. Absent when no command runs another.
   */
  guards?: string[]
  /**
   * Set when a command's only save would be its exact text holding a * or ?, which would act as a wildcard. The request
   * then offers no "always".
   */
  unsavable?: true
  /**
   * Set when a command runs something that cannot be read, such as a script built at run time, a script read from
   * stdin or wrappers nested too deep. No rule can match it, so the request always asks and offers no "always".
   */
  opaque?: true
}

const ARITY: Record<string, number> = {
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  echo: 1,
  env: 1,
  export: 1,
  grep: 1,
  kill: 1,
  killall: 1,
  ln: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  ps: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sleep: 1,
  source: 1,
  tail: 1,
  touch: 1,
  unset: 1,
  which: 1,
  aws: 3,
  az: 3,
  bazel: 2,
  brew: 2,
  bun: 2,
  "bun run": 3,
  "bun x": 3,
  cargo: 2,
  "cargo add": 3,
  "cargo run": 3,
  cdk: 2,
  cf: 2,
  cmake: 2,
  composer: 2,
  consul: 2,
  "consul kv": 3,
  crictl: 2,
  deno: 2,
  "deno task": 3,
  doctl: 3,
  docker: 2,
  "docker builder": 3,
  "docker compose": 3,
  "docker container": 3,
  "docker image": 3,
  "docker network": 3,
  "docker volume": 3,
  eksctl: 2,
  "eksctl create": 3,
  firebase: 2,
  flyctl: 2,
  gcloud: 3,
  gh: 3,
  git: 2,
  "git config": 3,
  "git remote": 3,
  "git stash": 3,
  go: 2,
  gradle: 2,
  helm: 2,
  heroku: 2,
  hugo: 2,
  ip: 2,
  "ip addr": 3,
  "ip link": 3,
  "ip netns": 3,
  "ip route": 3,
  kind: 2,
  "kind create": 3,
  kubectl: 2,
  "kubectl kustomize": 3,
  "kubectl rollout": 3,
  kustomize: 2,
  make: 2,
  mc: 2,
  "mc admin": 3,
  minikube: 2,
  mongosh: 2,
  mysql: 2,
  mvn: 2,
  ng: 2,
  npm: 2,
  "npm exec": 3,
  "npm init": 3,
  "npm run": 3,
  "npm view": 3,
  npx: 2,
  nvm: 2,
  nx: 2,
  openssl: 2,
  "openssl req": 3,
  "openssl x509": 3,
  pip: 2,
  pipenv: 2,
  pnpm: 2,
  "pnpm dlx": 3,
  "pnpm exec": 3,
  "pnpm run": 3,
  poetry: 2,
  podman: 2,
  "podman container": 3,
  "podman image": 3,
  psql: 2,
  pulumi: 2,
  "pulumi stack": 3,
  python: 2,
  pyenv: 2,
  rake: 2,
  rbenv: 2,
  "redis-cli": 2,
  rustup: 2,
  serverless: 2,
  sfdx: 3,
  skaffold: 2,
  sls: 2,
  sst: 2,
  swift: 2,
  systemctl: 2,
  terraform: 2,
  "terraform workspace": 3,
  tmux: 2,
  turbo: 2,
  ufw: 2,
  vault: 2,
  "vault auth": 3,
  "vault kv": 3,
  vercel: 2,
  volta: 2,
  wp: 2,
  yarn: 2,
  "yarn dlx": 3,
  "yarn run": 3,
}
const PREFIX_LENGTH = Math.max(...Object.values(ARITY))

// Commands that run their operands as another command. `values` lists options that take a separate value, and
// `operands` counts the operands before the command, such as timeout's duration or chroot's directory. `script`
// lists options whose value is a shell script, `joins` marks a wrapper that hands its operands joined by spaces to
// `sh -c`, and `shell` lists options that start an interactive shell when no command follows.
const WRAPPERS: Record<
  string,
  {
    values?: ReadonlyArray<string>
    flags?: ReadonlyArray<string>
    operands?: number
    assignments?: true
    script?: ReadonlyArray<string>
    joins?: true
    shell?: ReadonlyArray<string>
  }
> = {
  builtin: {},
  busybox: {},
  chronic: {},
  chroot: { values: ["--userspec", "--groups"], flags: ["--skip-chdir"], operands: 1 },
  command: {},
  coproc: {},
  doas: { values: ["-a", "-u", "-C"], shell: ["-s"] },
  env: {
    values: ["-a", "-u", "-C", "-P", "--argv0", "--unset", "--chdir"],
    flags: ["--ignore-environment", "--null", "--debug", "--ignore-signal", "--default-signal", "--block-signal"],
    assignments: true,
  },
  exec: { values: ["-a"] },
  firejail: {},
  flock: {
    values: ["-w", "-E", "--wait", "--timeout", "--conflict-exit-code"],
    flags: ["--shared", "--exclusive", "--unlock", "--nonblock", "--close", "--no-fork", "--verbose"],
    operands: 1,
    script: ["-c", "--command"],
  },
  ionice: { values: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"] },
  ltrace: {
    values: [
      ...["-a", "-A", "-D", "-e", "-F", "-l", "-n", "-o", "-p", "-s", "-u", "-w", "-x"],
      ...["--align", "--config", "--debug", "--indent", "--library", "--output", "--where"],
    ],
    flags: ["--demangle"],
  },
  nice: { values: ["-n", "--adjustment"] },
  nocorrect: {},
  noglob: {},
  nohup: {},
  setsid: { flags: ["--ctty", "--fork", "--wait"] },
  stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  strace: {
    values: [
      ...["-a", "-b", "-e", "-E", "-I", "-o", "-O", "-p", "-P", "-s", "-S", "-u", "-U", "-X"],
      ...["--attach", "--columns", "--env", "--output", "--string-limit", "--summary-sort-by"],
      ...["--trace-path", "--user", "--trace", "--signal", "--status", "--abbrev", "--verbose", "--raw"],
      ...["--read", "--write", "--fault", "--inject", "--trace-fds", "--detach-on", "--const-print-style"],
      ...["--decode-pids"],
      ...["--interruptible", "--summary-columns", "--summary-syscall-overhead", "--syscall-limit", "--kvm"],
    ],
    flags: [
      ...["--follow-forks", "--output-separately", "--summary-only", "--summary", "--summary-wall-clock"],
      ...["--no-abbrev", "--instruction-pointer", "--stack-trace", "--timestamps", "--relative-timestamps"],
      ...["--syscall-times", "--seccomp-bpf", "--quiet", "--decode-fds", "--daemonize"],
    ],
  },
  sudo: {
    assignments: true,
    shell: ["-i", "-s", "--login", "--shell"],
    values: [
      ...["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-R", "-t", "-T", "-U"],
      ...["--user", "--group", "--host", "--prompt", "--close-from", "--chdir", "--chroot", "--role", "--type"],
      ...["--command-timeout", "--other-user"],
    ],
    flags: [
      ...["--askpass", "--background", "--bell", "--edit", "--help", "--list", "--login", "--non-interactive"],
      ...["--preserve-env", "--preserve-groups", "--remove-timestamp", "--reset-timestamp", "--set-home"],
      ...["--shell", "--stdin", "--validate", "--version"],
    ],
  },
  time: {
    values: ["-f", "-o", "--format", "--output"],
    flags: ["--append", "--portability", "--quiet", "--verbose"],
  },
  timeout: {
    values: ["-s", "-k", "--signal", "--kill-after"],
    flags: ["--foreground", "--preserve-status", "--verbose"],
    operands: 1,
  },
  unbuffer: {},
  watch: {
    values: ["-n", "-q", "--interval", "--equexit"],
    flags: [
      ...["--beep", "--color", "--no-color", "--differences", "--errexit", "--chgexit", "--exec", "--no-title"],
      ...["--no-wrap", "--precise"],
    ],
    joins: true,
  },
  xargs: {
    values: [
      ...["-a", "-d", "-E", "-I", "-J", "-L", "-n", "-P", "-R", "-s"],
      ...["--arg-file", "--delimiter", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"],
    ],
    flags: [
      ...["--null", "--no-run-if-empty", "--verbose", "--interactive", "--exit", "--open-tty", "--show-limits"],
      ...["--replace", "--eof"],
    ],
  },
}
const SHELLS = new Set(["ash", "bash", "dash", "ksh", "mksh", "sh", "zsh"])
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"])
const MAX_WRAPPER_DEPTH = 8
const RUNNERS = new Set([...Object.keys(WRAPPERS), ...SHELLS, "eval", "find", "su"])
const FIND_WRITES = new Set(["-delete", "-fls", "-fprint", "-fprint0", "-fprintf"])
const STDIN_FILE = /^\/(?:dev\/stdin|dev\/fd\/\d+|proc\/(?:self|thread-self|\d+)(?:\/task\/\d+)?\/fd\/\d+)$/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/

export function scan(command: string, shell: string, cwd: string): Effect.Effect<Result, Error> {
  return Effect.suspend(() => {
    const powershell = ShellSelect.ps(shell)
    const shellName = ShellSelect.name(shell)
    const scanned = powershell
      ? ShellScan.scanPowerShell(command)
      : ShellScan.scan(command, shellName === "bash" || shellName === "zsh" ? shellName : "posix")
    if (scanned.kind === "opaque")
      return Effect.fail(new Error(`Portable shell scanner cannot analyze command: ${scanned.reason}`))

    const dialect = shellName === "bash" || shellName === "zsh" ? shellName : "posix"
    const output: Result = { commands: [], directories: [] }
    for (const entry of scanned.commands) {
      // Commandless redirects keep their exact spacing, which their saved prefix relies on.
      const item = powershell || entry.redirectPrefixEnd !== undefined ? entry : respace(entry)
      // Declarations are skipped as standalone permission resources, while nested substitutions remain.
      if (item.declaration) continue
      if (item.redirectPrefixEnd !== undefined) {
        const head = item.resource.slice(0, item.redirectPrefixEnd)
        const next = item.resource[item.redirectPrefixEnd]
        const separator = next === "\t" || next === "\n" ? next : " "
        output.commands.push({ resource: item.resource, save: `${head}${separator}*` })
        continue
      }
      const words = item.redirectWordCount === undefined ? item.rawWords : item.rawWords.slice(0, item.redirectWordCount)
      // Bare statement-head foreach blocks act as PowerShell control flow rather than cmdlet invocations.
      if (
        powershell &&
        item.statementHead &&
        /^foreach(?:-|$)/i.test(words[0] ?? "") &&
        words.length > 1 &&
        words.slice(1).every((word) => word.startsWith("{"))
      )
        continue
      const parts = powershell
        ? words.flatMap((raw, index): Part[] => {
            const text =
              !raw.includes("`$") && /['"`]/.test(raw) ? (item.words[index] ?? raw) : raw.replaceAll("`$", "\0")
            if (!/^-[A-Za-z_?][\w?-]*(?::|$)/.test(raw)) return [{ type: "word", text, raw }]
            const colon = text.indexOf(":")
            if (colon >= 0) {
              const rawColon = raw.indexOf(":")
              return colon + 1 < text.length
                ? [
                    { type: "command_parameter", text: text.slice(0, colon), raw: raw.slice(0, rawColon) },
                    { type: "word", text: text.slice(colon + 1), raw: rawColon >= 0 ? raw.slice(rawColon + 1) : raw },
                  ]
                : [{ type: "command_parameter", text: text.slice(0, colon), raw }]
            }
            return [{ type: "command_parameter", text, raw }]
          })
        : item.rawWords.map((raw, index): Part => {
            const word = item.words[index] ?? raw
            return {
              type: "word",
              text: isStaticBashWord(raw) ? word.replaceAll("$", "\0") : "$",
              raw,
              unquotedTilde: raw.startsWith("~"),
            }
          })
      const directoryCommand = unwrapDirectoryCommand(powershell ? words : item.rawWords, parts, powershell)
      if (directoryCommand) {
        const resolved = directoryArgs(directoryCommand, powershell, cwd, shell)
        output.directories.push(...resolved.directories)
        if (directoryCommand === parts && resolved.complete) continue
      }
      const selected = prefix(words.slice(0, PREFIX_LENGTH))
      const head = item.resource.slice(0, item.commandOffset ?? 0)
      // A * or ? in the head would turn into a wildcard and widen the grant, so it keeps the bare prefix.
      const conventional = `${/[*?]/.test(head) ? "" : head}${selected.join(" ")} *`
      const end = item.wordEnds?.[selected.length - 1]
      // Keep existing grants stable unless normalized spacing loses the original source boundary.
      const save =
        !powershell || end === undefined || Wildcard.match(item.resource, conventional)
          ? conventional
          : item.resource[end] === "("
            ? `${item.resource.slice(0, end)}(*`
            : (() => {
                const boundary =
                  item.wordEnds?.find(
                    (value) => value >= end && (value >= item.resource.length || /\s/.test(item.resource[value])),
                  ) ?? end
                const separator = /^\s+(?:`(?:\r\n|\r|\n)\s*)?/.exec(item.resource.slice(boundary))?.[0]
                return `${item.resource.slice(0, boundary)}${separator ?? " "}*`
              })()
      // Redirect targets are not words, so a redirect between a wrapper and its command does not hide the command.
      const wrapped = powershell ? undefined : unwrap(item.words, item.rawWords, dialect)
      // A wrapper saves itself with what it runs, never `<wrapper> *`. When what it runs cannot be matched by rules,
      // a redirect splits its words, or the pattern would hold a * or ? wildcard, it saves the exact command.
      const pattern = item.redirectWordCount === undefined && wrapped?.prefix && `${head}${wrapped.prefix.join(" ")}`
      const exact = wrapped !== undefined && !(pattern && !/[*?]/.test(pattern))
      // A * or ? from the command in an exact save, the head or the saved prefix words would act as a wildcard, so the
      // request offers no "always" instead.
      if ((exact && /[*?]/.test(item.resource)) || /[*?]/.test(head) || (!wrapped && /[*?]/.test(save.slice(0, -1))))
        output.unsavable = true
      // A command name the shell expands or globs at run time cannot be matched by rules.
      if (
        wrapped?.opaque ||
        (!powershell && (!isStaticBashWord(item.rawWords[0] ?? "") || globbedName(item.rawWords[0] ?? "", dialect)))
      ) {
        output.opaque = true
        output.unsavable = true
      }
      output.commands.push({
        resource: item.resource,
        save: !wrapped ? save : exact ? item.resource : `${pattern} *`,
      })
      if (powershell) continue
      // Assignments, redirects and spacing the resource keeps, and quotes in its words, would hide the command from
      // its rules, so it gets guards without them; a wrapper adds guards for each command it runs.
      const plain = !ShellScan.declarations.has(words[0] ?? "") && !CWD.has(words[0] ?? "")
      const guards = [
        ...(plain && !item.resource.startsWith(item.rawWords.join(" ")) ? [item.rawWords.join(" ")] : []),
        ...(plain && item.rawWords.some((raw, index) => raw !== item.words[index]) ? [item.words.join(" ")] : []),
        ...(plain ? basenamed(item.words, item.rawWords) : []),
        ...(wrapped?.guards ?? []),
      ]
      if (guards.length > 0) output.guards = [...(output.guards ?? []), ...guards]
    }
    return Effect.succeed(output)
  })
}

function unwrapDirectoryCommand(rawWords: string[], parts: Part[], powershell: boolean) {
  const head = powershell ? rawWords[0]?.toLowerCase() : rawWords[0]
  if (CWD.has(head ?? "")) return parts
  if (powershell) return
  let index = 0
  while (rawWords[index] === "builtin" || rawWords[index] === "command") {
    const wrapper = rawWords[index]
    index++
    while (rawWords[index]?.startsWith("-")) {
      const flag = rawWords[index]
      index++
      if (flag === "--") break
      if (wrapper === "command" && /^-[p]*[vV]/.test(flag)) return
    }
  }
  return index > 0 && CWD.has(rawWords[index] ?? "") ? parts.slice(index) : undefined
}

function isStaticBashWord(raw: string) {
  let quote: "'" | '"' | "$'" | undefined
  let segmentStarted = false
  let segmentLeadingDot = false
  let segmentGlob = false
  let hasAnsiEscape = false
  let hasUnquotedGlob = false
  const braces: boolean[] = []
  const recordChar = (char: string, unquotedGlob = false) => {
    if (unquotedGlob) hasUnquotedGlob = true
    if (hasAnsiEscape && hasUnquotedGlob) return false
    if (char === "/") {
      segmentStarted = false
      segmentLeadingDot = false
      segmentGlob = false
      return true
    }
    if (!segmentStarted) {
      segmentStarted = true
      segmentLeadingDot = char === "."
    }
    if (unquotedGlob) segmentGlob = true
    return !(segmentLeadingDot && segmentGlob)
  }

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    const next = raw[index + 1] ?? ""
    if (quote === "'") {
      if (char === "'") {
        quote = undefined
        continue
      }
      if (!recordChar(char)) return false
      continue
    }
    if (quote === "$'") {
      if (char === "\\") {
        hasAnsiEscape = true
        if (hasUnquotedGlob) return false
        index++
        continue
      }
      if (char === "'") {
        quote = undefined
        continue
      }
      if (!recordChar(char)) return false
      continue
    }
    if (quote === '"') {
      if (char === "\\" && '$`"\\\n'.includes(next)) {
        index++
        if (next !== "\n" && !recordChar(next)) return false
        continue
      }
      if (char === '"') {
        quote = undefined
        continue
      }
      if (char === "`" || (char === "$" && (/[A-Za-z_0-9@*#?$!({[-]/.test(next) || raw.startsWith("\\\n", index + 1))))
        return false
      if (!recordChar(char)) return false
      continue
    }
    if (char === "\\") {
      index++
      if (next !== "\n" && !recordChar(next)) return false
      continue
    }
    if (char === "'") {
      quote = "'"
      continue
    }
    if (char === '"') {
      quote = '"'
      continue
    }
    if (char === "$" && next === "'") {
      quote = "$'"
      index++
      continue
    }
    if (char === "$" && next === '"') {
      quote = '"'
      index++
      continue
    }
    if (
      char === "`" ||
      ((char === "<" || char === ">" || char === "=") && next === "(") ||
      (char === "$" && (/[A-Za-z_0-9@*#?$!({[-]/.test(next) || raw.startsWith("\\\n", index + 1)))
    )
      return false
    if (char === "{") {
      braces.push(false)
      if (!recordChar(char)) return false
      continue
    }
    if (braces.length > 0 && (char === "," || (char === "." && next === "."))) {
      braces[braces.length - 1] = true
    }
    if (char === "}" && braces.length > 0) {
      if (braces.pop()) return false
      if (!recordChar(char)) return false
      continue
    }
    if (!recordChar(char, char === "*" || char === "?" || char === "[")) return false
  }
  return quote === undefined
}

function hasPowerShellDotWildcard(raw: string) {
  let quote: "'" | '"' | undefined
  let segmentStarted = false
  let segmentLeadingDot = false
  let segmentGlob = false
  let hasQuoteEscape = false
  let hasUnquotedGlob = false
  const recordChar = (char: string, unquotedGlob = false) => {
    if (unquotedGlob) hasUnquotedGlob = true
    if (hasQuoteEscape && hasUnquotedGlob) return true
    if (char === "/" || char === "\\") {
      segmentStarted = false
      segmentLeadingDot = false
      segmentGlob = false
      return false
    }
    if (!segmentStarted) {
      segmentStarted = true
      segmentLeadingDot = char === "."
    }
    if (unquotedGlob) segmentGlob = true
    return segmentLeadingDot && segmentGlob
  }

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    const next = raw[index + 1] ?? ""
    if (quote === "'") {
      if (char === "'" && next === "'") {
        index++
        if (recordChar("'")) return true
        continue
      }
      if (char === "'") {
        quote = undefined
        continue
      }
      if (recordChar(char)) return true
      continue
    }
    if (quote === '"') {
      if (char === "`") {
        hasQuoteEscape = true
        if (hasUnquotedGlob) return true
        index++
        continue
      }
      if (char === '"' && next === '"') {
        index++
        if (recordChar('"')) return true
        continue
      }
      if (char === '"') {
        quote = undefined
        continue
      }
      if (recordChar(char)) return true
      continue
    }
    if (char === "`") {
      index++
      if (recordChar(next)) return true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (recordChar(char, char === "*" || char === "?" || char === "[")) return true
  }
  return false
}

function directoryArgs(command: Part[], powershell: boolean, cwd: string, shell: string) {
  const head = command[0]?.text.toLowerCase() ?? ""
  if (head === "popd" || head === "pop-location") return { directories: [], complete: false }

  if (!powershell) {
    let endOfOptions = false
    const operands = command.slice(1).filter((part) => {
      if (endOfOptions) return true
      if (part.text === "--") {
        endOfOptions = true
        return false
      }
      if (part.text === "-") return true
      return !part.text.startsWith("-")
    })
    if (operands.length === 0) return { directories: [], complete: false }
    const resolved = operands.map((part) =>
      part.text === "-" ? undefined : directoryArgument(part.text, false, cwd, shell, part.unquotedTilde),
    )
    const directories = resolved.filter((item): item is string => item !== undefined)
    return { directories, complete: directories.length === operands.length }
  }

  const directories: string[] = []
  let pathFlag = false
  let literalFlag = false
  let endOfParameters = false
  let sawOperand = false
  let complete = true
  for (const part of command.slice(1)) {
    if (!endOfParameters && part.text === "--") {
      endOfParameters = true
      continue
    }
    if (pathFlag) {
      sawOperand = true
      const value =
        !literalFlag && (hasPowerShellDotWildcard(part.raw) || part.text === "-" || part.text === "+")
          ? undefined
          : directoryArgument(part.text, true, cwd, shell)
      if (value) directories.push(value)
      if (!value) complete = false
      pathFlag = false
      literalFlag = false
      continue
    }
    if (!endOfParameters && part.type === "command_parameter") {
      if (POWERSHELL_STACK_FLAG_RE.test(part.text)) {
        complete = false
        return { directories, complete }
      }
      literalFlag = POWERSHELL_LITERAL_FLAG_RE.test(part.text)
      pathFlag = literalFlag || /^-p(?:ath|at|a)?:?$/i.test(part.text)
      continue
    }
    sawOperand = true
    const value =
      hasPowerShellDotWildcard(part.raw) || (!endOfParameters && (part.raw === "-" || part.raw === "+"))
        ? undefined
        : directoryArgument(part.text, true, cwd, shell)
    if (value) directories.push(value)
    if (!value) complete = false
  }
  return { directories, complete: sawOperand && complete }
}

function directoryArgument(value: string, powershell: boolean, cwd: string, shell: string, unquotedTilde = false) {
  if (!powershell) return expandKnownDirectory(value, false, cwd, unquotedTilde)
  const quote = value[0]
  const text = (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value

  // PowerShell exposes environment variables through $env:NAME and provides these
  // automatic directory variables. Expand only values we can determine without executing code.
  return expandKnownDirectory(
    text
      .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => environment(key) ?? "")
      .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => environment(key) ?? "")
      .replace(/\$(?:\{(HOME|PWD|PSHOME)\}|(HOME|PWD|PSHOME)(?=$|[\\/]))/gi, (_, braced?: string, bare?: string) => {
        const key = (braced ?? bare ?? "").toUpperCase()
        if (key === "HOME") return os.homedir()
        if (key === "PWD") return cwd
        return path.dirname(shell)
      }),
    true,
    cwd,
  )
}

function expandKnownDirectory(value: string, powershell: boolean, cwd: string, unquotedTilde = false) {
  // Unknown shell expressions cannot be resolved safely during permission analysis.
  if (value.includes("$") || value.includes("`") || (powershell && value.startsWith("("))) return
  const resolved = value.replaceAll("\0", "$")
  if (resolved === "~") return os.homedir()
  if (resolved.startsWith("~/") || (process.platform === "win32" && resolved.startsWith("~\\"))) {
    return path.join(os.homedir(), resolved.slice(2))
  }
  if (unquotedTilde && process.platform !== "win32") {
    if (resolved === "~+") return cwd
    if (resolved.startsWith("~+/")) return path.join(cwd, resolved.slice(3))
    if (/^~(?:[-+](?:\d+)?|\d+)(?=$|\/)/.test(resolved)) return
    const userMatch = /^~([A-Za-z_][A-Za-z0-9._-]*)(?=$|\/)/.exec(resolved)
    if (userMatch) {
      const user = userMatch[1]
      const home = resolveUserHome(user)
      if (!home) return
      return path.join(home, resolved.slice(user.length + 1))
    }
  }
  return resolved
}

let cachedPasswdHomes: ReadonlyMap<string, string> | undefined

function passwdHomes() {
  if (cachedPasswdHomes) return cachedPasswdHomes
  const content = Result.try(() => fs.readFileSync("/etc/passwd", "utf8"))
  const entries = Result.isSuccess(content)
    ? content.success.split("\n").flatMap((line): Array<[string, string]> => {
        if (!line || line.startsWith("#")) return []
        const fields = line.split(":")
        const name = fields[0]
        const home = fields[5]
        return name && home ? [[name, home]] : []
      })
    : []
  cachedPasswdHomes = new Map(entries)
  return cachedPasswdHomes
}

function resolveUserHome(user: string) {
  const current = Result.try(() => os.userInfo())
  if (Result.isSuccess(current) && current.success.username === user && current.success.homedir) {
    return current.success.homedir
  }
  const fromPasswd = passwdHomes().get(user)
  if (fromPasswd) return fromPasswd
  if (process.platform === "darwin") {
    const candidate = path.join("/Users", user)
    const exists = Result.try(() => fs.statSync(candidate).isDirectory())
    if (Result.isSuccess(exists) && exists.success) return candidate
  }
}

function environment(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function prefix(tokens: string[]) {
  for (let length = tokens.length; length > 0; length--) {
    const arity = ARITY[tokens.slice(0, length).join(" ")]
    if (arity !== undefined) return tokens.slice(0, arity)
  }
  return tokens.slice(0, 1)
}

type Wrapped = { prefix?: string[]; guards: string[]; opaque?: true }
const OPAQUE: Wrapped = { guards: [], opaque: true }
/**
 * Input xargs or find adds to the command they run: `replace` is the text that stands for it, and `appended` means
 * xargs appends it as further arguments.
 */
type Supply = { replace?: string; appended?: true }
/** Where a wrapped command starts, the words `env -S` splits into a new env command line, or no command. */
type Start = number | { split: string[]; index: number; quoted: boolean } | undefined

/**
 * What a wrapper such as `env`, `xargs`, `find -exec` or `bash -c` runs: a guard for each command, so rules for it
 * apply through the wrapper, and the `prefix` "always" saves for the wrapper itself. Without a prefix the wrapper is
 * saved exactly, never as `<wrapper> *`. `opaque` means it runs something no rule can match. `undefined` means the
 * command wraps nothing.
 */
function unwrap(
  words: string[],
  raw: string[],
  dialect: ShellScan.Dialect,
  depth = 0,
  supply?: Supply,
): Wrapped | undefined {
  // A path such as /usr/bin/env runs the same wrapper.
  const head = path.posix.basename(words[0] ?? "")
  if (head === "eval")
    return script(words.slice(1).join(" "), raw.slice(1).every(isStaticBashWord), dialect, depth, supply)
  if (SHELLS.has(head)) return shell(words, raw, head, depth, supply)
  if (head === "su") return su(words, raw, dialect, depth, supply)
  if (head === "find") return findExec(words, raw, dialect, depth)
  const spec = WRAPPERS[head]
  if (!spec) return
  const parsed = commandStart(words, head, spec)
  const run = (start: Start): Wrapped => {
    // Without a command, a wrapper under xargs runs its input, and a login shell option reads stdin.
    if (start === undefined)
      return supply?.appended || words.slice(1).some((word) => spec.shell?.some((option) => clusterHas(word, option)))
        ? OPAQUE
        : { guards: [] }
    // `env -S` splits its text into a new env command line, options included.
    if (typeof start === "object") {
      // Quotes and escapes inside the text follow env's own tokenizer, which is not modelled.
      if (start.quoted || !raw.slice(start.index).every(isStaticBashWord)) return OPAQUE
      return unwrap(["env", ...start.split], ["env", ...start.split], dialect, depth + 1, supply) ?? { guards: [] }
    }
    if (spec.script?.includes(words[start]))
      return start + 1 < words.length
        ? script(words[start + 1], isStaticBashWord(raw[start + 1]), dialect, depth, supply)
        : supply?.appended
          ? OPAQUE
          : { guards: [] }
    // `watch` hands its operands, joined by spaces, to `sh -c`, unless `-x` runs them directly.
    if (spec.joins && !words.slice(1, start).some((word) => clusterHas(word, "-x") || word === "--exec"))
      return script(words.slice(start).join(" "), raw.slice(start).every(isStaticBashWord), "posix", depth, supply)
    const inner = command(
      words.slice(start),
      raw.slice(start),
      dialect,
      depth,
      head === "xargs" ? xargsSupply(words.slice(1, start)) : supply,
    )
    return { ...inner, prefix: inner.prefix && [...raw.slice(0, start), ...inner.prefix] }
  }
  const primary = run(parsed.start)
  const others = parsed.alternatives.filter((start) => start !== parsed.start).map(run)
  return {
    // A save covering one reading of an option the table does not pin could cover a different command in another.
    prefix: parsed.alternatives.length > 0 ? undefined : primary.prefix,
    guards: [...primary.guards, ...others.flatMap((item) => item.guards)],
    ...(primary.opaque || others.some((item) => item.opaque) ? { opaque: true as const } : {}),
  }
}

function command(words: string[], raw: string[], dialect: ShellScan.Dialect, depth: number, supply?: Supply): Wrapped {
  // Like their unwrapped forms, directory changes are checked as directories and declarations are not resources.
  if (CWD.has(words[0] ?? "") || ShellScan.declarations.has(words[0] ?? ""))
    return { prefix: raw.slice(0, 1), guards: [] }
  const exact = raw.join(" ")
  // A command name the shell expands or globs at run time, or that xargs or find fill in from input, cannot be matched.
  if (
    !isStaticBashWord(raw[0] ?? "") ||
    globbedName(raw[0] ?? "", dialect) ||
    (supply?.replace !== undefined && (words[0] ?? "").includes(supply.replace))
  )
    return { guards: [exact], opaque: true }
  const unquoted = words.join(" ")
  const nested =
    depth < MAX_WRAPPER_DEPTH
      ? unwrap(words, raw, dialect, depth + 1, supply)
      : RUNNERS.has(path.posix.basename(words[0] ?? ""))
        ? OPAQUE
        : undefined
  return {
    prefix: nested ? nested.prefix : prefix(raw.slice(0, PREFIX_LENGTH)),
    guards: [exact, ...(unquoted === exact ? [] : [unquoted]), ...basenamed(words, raw), ...(nested?.guards ?? [])],
    ...(nested?.opaque ? { opaque: true as const } : {}),
  }
}

/**
 * A script whose text the outer shell expands, that xargs or find fill in from input, or that the scanner cannot
 * analyze cannot be matched by rules.
 */
function script(text: string, isStatic: boolean, dialect: ShellScan.Dialect, depth: number, supply?: Supply): Wrapped {
  if (!isStatic || depth >= MAX_WRAPPER_DEPTH || (supply?.replace !== undefined && text.includes(supply.replace)))
    return OPAQUE
  const scanned = ShellScan.scan(text, dialect)
  if (scanned.kind === "opaque") return OPAQUE
  const inner = scanned.commands
    .filter((item) => !item.declaration)
    .map((item) => command(item.words, item.rawWords, dialect, depth + 1))
  return {
    guards: inner.flatMap((item) => item.guards),
    ...(inner.some((item) => item.opaque) ? { opaque: true as const } : {}),
  }
}

/**
 * A shell runs its `-c` script, a script file, which "always" saves with the file so it never covers `bash -c`, or a
 * script read from stdin, such as a heredoc or a pipe.
 */
function shell(words: string[], raw: string[], head: string, depth: number, supply?: Supply): Wrapped {
  const operand = shellOperand(words)
  if (operand.kind === "stdin") return OPAQUE
  const file = words[operand.index]
  const dialect = head === "zsh" || head === "bash" ? head : "posix"
  if (operand.kind === "inline")
    return file === undefined ? OPAQUE : script(file, isStaticBashWord(raw[operand.index]), dialect, depth, supply)
  // A file the shell expands or globs, a process substitution, a path to stdin or input xargs or find supply is
  // unreadable.
  if (
    !isStaticBashWord(raw[operand.index]) ||
    globbed(raw[operand.index]) ||
    raw[operand.index].startsWith("~") ||
    /^[<>=]\(/.test(file) ||
    STDIN_FILE.test(path.posix.normalize(file)) ||
    (supply?.replace !== undefined && file.includes(supply.replace))
  )
    return OPAQUE
  return { prefix: raw.slice(0, operand.index + 1), guards: [] }
}

/** Where a shell's `-c` script or script file is, or that it reads its script from stdin. */
function shellOperand(words: string[]) {
  let index = 1
  let inline = false
  let stdin = false
  while (index < words.length && /^[-+]/.test(words[index])) {
    const word = words[index]
    index++
    if (word === "--" || word === "-") break
    if (word === "--rcfile" || word === "--init-file") index++
    if (word.startsWith("--")) continue
    // A cluster ending in o or O, such as `-euo pipefail`, takes the next word as the option name.
    if (/[oO]$/.test(word)) index++
    if (word.startsWith("-") && word.includes("c")) inline = true
    else if (word.startsWith("-") && word.includes("s")) stdin = true
  }
  if (inline) return { kind: "inline" as const, index }
  if (stdin || index >= words.length) return { kind: "stdin" as const, index }
  return { kind: "file" as const, index }
}

// `su` runs its `-c` script, or an interactive shell that reads stdin.
function su(words: string[], raw: string[], dialect: ShellScan.Dialect, depth: number, supply?: Supply): Wrapped {
  const index = words.findIndex((word, next) => next > 0 && (/^-[^-]*c$/.test(word) || word === "--command"))
  if (index >= 0)
    return index + 1 < words.length
      ? script(words[index + 1], isStaticBashWord(raw[index + 1]), dialect, depth, supply)
      : supply?.appended
        ? OPAQUE
        : { guards: [] }
  const inline = words.findIndex((word) => word.startsWith("--command="))
  if (inline >= 0)
    return script(words[inline].slice("--command=".length), isStaticBashWord(raw[inline]), dialect, depth, supply)
  return OPAQUE
}

// A find that runs or writes is saved exactly, so the saved pattern pins every action.
function findExec(words: string[], raw: string[], dialect: ShellScan.Dialect, depth: number): Wrapped | undefined {
  const inner = words.flatMap((word, index) => {
    if (!FIND_EXEC.has(word)) return []
    const found = words.findIndex((item, next) => next > index && (item === ";" || item === "+"))
    const end = found < 0 ? words.length : found
    return [command(words.slice(index + 1, end), raw.slice(index + 1, end), dialect, depth, { replace: "{}" })]
  })
  if (inner.length === 0) return words.some((word) => FIND_WRITES.has(word)) ? { guards: [] } : undefined
  return {
    guards: inner.flatMap((item) => item.guards),
    ...(inner.some((item) => item.opaque) ? { opaque: true as const } : {}),
  }
}

/**
 * xargs appends its input as arguments, or puts it where its replace string (`-I`, `-i`, `-J`, `--replace`) is. As
 * in GNU xargs, options apply in order: the last replace option wins, and a later max-lines option (`-L`, `-l`,
 * `--max-lines`) turns replacing off again. The replace string is kept even then, so text holding it stays unread.
 */
function xargsSupply(options: string[]): Supply {
  const state = options.reduce<{ replace?: string; appended: boolean }>(
    (current, word, index) => {
      if (word.startsWith("--")) {
        const equals = word.indexOf("=")
        const name = equals < 0 ? word : word.slice(0, equals)
        if (name.length >= 3 && "--replace".startsWith(name))
          return { replace: equals < 0 ? "{}" : word.slice(equals + 1), appended: false }
        if (name.length >= "--max-l".length && "--max-lines".startsWith(name)) return { ...current, appended: true }
        return current
      }
      if (!word.startsWith("-")) return current
      // In a cluster such as `-0I{}`, the first option that takes a value takes the rest of the word or the next word.
      const position = [...word.slice(1)].findIndex((letter) => "IJiadeELlnPsR".includes(letter))
      if (position < 0) return current
      const letter = word[position + 1]
      const rest = word.slice(position + 2)
      if (letter === "I" || letter === "J") return { replace: rest || (options[index + 1] ?? ""), appended: false }
      if (letter === "i") return { replace: rest || "{}", appended: false }
      if (letter === "L" || letter === "l") return { ...current, appended: true }
      return current
    },
    { appended: true },
  )
  return {
    ...(state.replace === undefined ? {} : { replace: state.replace }),
    ...(state.appended ? { appended: true as const } : {}),
  }
}

/** The command named by the basename of a path such as /usr/bin/rm, which rules name it by. */
function basenamed(words: string[], raw: string[]) {
  const name = words[0] ?? ""
  const base = path.posix.basename(name)
  return name.includes("/") && base && base !== name ? [[base, ...raw.slice(1)].join(" ")] : []
}

/** Whether a word holds an unquoted `*`, `?` or `[`, which the shell may expand into other names. */
function globbed(raw: string) {
  return /[[*?]/.test(unquoted(raw))
}

/**
 * Whether a command name picks its program at run time: an unquoted glob other than the `[` and `[[` commands, or in
 * zsh a leading `=` path expansion or a trailing glob qualifier.
 */
function globbedName(raw: string, dialect: ShellScan.Dialect) {
  if (raw === "[" || raw === "[[") return false
  const text = unquoted(raw)
  return globbed(raw) || (dialect === "zsh" && (text.startsWith("=") || text.endsWith(")")))
}

/** A raw word without its quoted and escaped parts. */
function unquoted(raw: string) {
  return raw.replace(/'[^']*'|"[^"]*"|\\./g, "")
}

/** Whether an option word, alone or in a cluster such as `-iu`, is the given option. */
function clusterHas(word: string, option: string) {
  if (option.startsWith("--") || word.startsWith("--")) return word === option
  return word.startsWith("-") && word.slice(1).includes(option.slice(1))
}

/** The command with its unquoted spacing collapsed, and its command offset moved to match. */
function respace<Item extends { resource: string; commandOffset?: number }>(item: Item): Item {
  const resource = ShellSpacing.collapse(item.resource)
  if (resource === item.resource) return item
  return {
    ...item,
    resource,
    ...(item.commandOffset === undefined
      ? {}
      : { commandOffset: ShellSpacing.collapse(item.resource.slice(0, item.commandOffset)).length }),
  }
}

/**
 * Where the wrapped command starts. `alternatives` are the starts under the other reading of each long option the
 * table does not name exactly: GNU accepts any unambiguous prefix, and a table can miss an option, so such an option
 * might or might not take the next word, and the command is guarded under both readings.
 */
function commandStart(words: string[], head: string, spec: (typeof WRAPPERS)[string]) {
  // Each word index is read once, so many such options cost quadratic, not exponential, time.
  const memo = new Map<number, { start: Start; alternatives: Start[] }>()
  const from = (first: number): { start: Start; alternatives: Start[] } => {
    const known = memo.get(first)
    if (known) return known
    const result = walk(first)
    memo.set(first, result)
    return result
  }
  const walk = (first: number): { start: Start; alternatives: Start[] } => {
    let index = first
    const alternatives: Start[] = []
    while (index < words.length) {
      const word = words[index]
      if (word === "--") {
        index++
        break
      }
      if (word === "-" && head === "env") {
        index++
        continue
      }
      if (!word.startsWith("-") || word === "-") break
      // `command -v` and `sudo -e` look up or edit their operands instead of running them.
      if (head === "command" && /^-p*[vV]/.test(word)) return { start: undefined, alternatives }
      if (head === "sudo" && (word === "-e" || word === "--edit")) return { start: undefined, alternatives }
      if (head === "env") {
        const split = splitString(words, index)
        if (split !== undefined) return { start: { ...split, index }, alternatives }
      }
      if (word.startsWith("--")) {
        if (word.includes("=") || spec.flags?.includes(word)) {
          index++
          continue
        }
        if (spec.values?.includes(word)) {
          index += 2
          continue
        }
        const valued =
          word.length >= 3 && (spec.values ?? []).some((option) => option.startsWith("--") && option.startsWith(word))
        const other = from(index + (valued ? 1 : 2))
        alternatives.push(other.start, ...other.alternatives)
        index += valued ? 2 : 1
        continue
      }
      // In a cluster such as `-un`, a value option takes the next word only when it comes last.
      const valued = [...word.slice(1)].findIndex((letter) => spec.values?.includes(`-${letter}`))
      index += valued >= 0 && valued === word.length - 2 ? 2 : 1
    }
    if (spec.assignments) while (ASSIGNMENT.test(words[index] ?? "")) index++
    index += spec.operands ?? 0
    return { start: index < words.length ? index : undefined, alternatives: [...new Set(alternatives)] }
  }
  return from(1)
}

/**
 * The words of the new env command line `env -S` splits its text into, when the option at index is `-S`,
 * `--split-string` or a prefix of it, or ends a cluster.
 */
function splitString(words: string[], index: number) {
  const word = words[index]
  const equals = word.indexOf("=")
  const name = equals < 0 ? word : word.slice(0, equals)
  const value = (() => {
    if (name.startsWith("--"))
      return name.length >= 3 && "--split-string".startsWith(name)
        ? equals < 0
          ? { text: words[index + 1] ?? "", next: index + 2 }
          : { text: word.slice(equals + 1), next: index + 1 }
        : undefined
    // Like getopt, the first option in a cluster that takes a value takes the rest of the word, as `-iS'cmd'` does.
    const letter = [...word.slice(1)].findIndex((char) => char === "S" || WRAPPERS.env.values?.includes(`-${char}`))
    if (letter < 0 || word[letter + 1] !== "S") return
    const attached = word.slice(letter + 2)
    return attached ? { text: attached, next: index + 1 } : { text: words[index + 1] ?? "", next: index + 2 }
  })()
  if (!value) return
  return {
    split: [...value.text.split(/[ \t\n]+/).filter(Boolean), ...words.slice(value.next)],
    // env's tokenizer also splits at \v, \f and \r, which the split above does not.
    quoted: /['"\\\v\f\r]/.test(value.text),
  }
}
