import { readPasswordFile } from "@opencode/util/password-file"
import { Config, ConfigProvider, Effect, Redacted } from "effect"

// Every environment variable the CLI reads, in one place. Consumers yield
// these instead of touching process.env so the full surface stays visible,
// typed, and redacted where secret.

// The opencode server password: sent by clients connecting to an explicit
// --server, and adopted by a manually run or standalone server. The legacy
// name is still honored. OPENCODE_PASSWORD_FILE is consulted last, only when
// neither variable is set; a file that cannot be trusted is an error, never a
// fall-through to "no password".
export const password = Config.Redacted("OPENCODE_PASSWORD").pipe(
  Config.orElse(() => Config.Redacted("OPENCODE_SERVER_PASSWORD")),
  Config.orElse(() =>
    Config.String("OPENCODE_PASSWORD_FILE").pipe(
      Config.mapEffect((file) =>
        Effect.try({
          try: () => Redacted.make(readPasswordFile(file)),
          catch: (error) =>
            new Config.ConfigError(
              new ConfigProvider.SourceError({
                message: `OPENCODE_PASSWORD_FILE: ${error instanceof Error ? error.message : String(error)}`,
                cause: error,
              }),
            ),
        }),
      ),
    ),
  ),
  Config.withDefault(undefined),
)

export function session() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== "OPENCODE_PASSWORD" &&
        entry[0] !== "OPENCODE_SERVER_PASSWORD" &&
        entry[0] !== "OPENCODE_PASSWORD_FILE",
    ),
  )
}

export * as Env from "./env"
