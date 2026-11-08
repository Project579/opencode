export * as ShellSpacing from "./spacing.js"

/**
 * Shell text with each run of unquoted blanks as one space, so commands, saved patterns and configured rules match
 * however they are spaced. Text the shell could read differently once respaced, such as expansions, escapes,
 * heredocs or PowerShell's `--%` stop-parsing token, keeps its exact spacing, as does every quoted string. Text with
 * curly quotes also keeps it: PowerShell reads them as quotes and other shells as plain characters, and matching runs
 * without knowing which shell will run the command.
 */
export function collapse(text: string) {
  if (/\$[({'"]|[`\\\n]|<<|--%|[‘’“”]/.test(text)) return text
  return text.replace(/'[^']*'|"[^"]*"|[ \t]+/g, (match) => (/^[ \t]/.test(match) ? " " : match))
}
