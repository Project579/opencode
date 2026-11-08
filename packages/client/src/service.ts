/** Connection details for a local OpenCode service. */
export type Endpoint = {
  /** Base URL of the service. */
  readonly url: string
  /** Authentication required by the service, when configured. */
  readonly auth?: {
    /** HTTP authentication scheme. */
    readonly type: "basic"
    /** Basic authentication username. */
    readonly username: string
    /** Basic authentication password. */
    readonly password: string
  }
}

/** Options used to discover the local OpenCode service. */
export type DiscoverOptions = {
  /** Absolute registration file path. Defaults to the XDG state directory. */
  readonly file?: string
  /** Required exact service version or compatibility predicate. */
  readonly version?: string | ((version: string) => boolean)
}

/** Reason ensuring the service requires a new process. */
export type EnsureReason = "missing" | "version-mismatch"

/** Options used to ensure the local OpenCode service is running. */
export type EnsureOptions = DiscoverOptions & {
  /** Service command and arguments. Defaults to `opencode serve --service`. */
  readonly command?: ReadonlyArray<string>
  /** Environment variables added to the inherited service process environment. */
  readonly env?: Readonly<Record<string, string>>
  /** Called once before spawning a new service process. */
  readonly onStart?: (reason: EnsureReason, previousVersion?: string) => void
  /**
   * Start or replace the service when needed. Defaults to `true`. When `false`, only connect: adopt a registered
   * service that answers with a compatible health response whatever its version, and never spawn, replace, or
   * signal a service.
   */
  readonly autostart?: boolean
}

/** No usable local service is running and automatic start is off. */
export class ServiceAutostartDisabledError extends Error {
  readonly _tag = "ServiceAutostartDisabledError"

  constructor() {
    super(
      "The local OpenCode service is not running and automatic start is off (OPENCODE_EXPERIMENTAL_SERVICE_AUTOSTART). Start the service, or unset OPENCODE_EXPERIMENTAL_SERVICE_AUTOSTART to let OpenCode start it.",
    )
    this.name = "ServiceAutostartDisabledError"
  }
}

/** Options used to stop the local OpenCode service. */
export type StopOptions = {
  /** Absolute registration file path. Defaults to the XDG state directory. */
  readonly file?: string
  /** How to handle persistent terminals before stopping the service. */
  readonly pty?: "clear" | "handoff"
}

/** Contents of the local service registration file. */
export type Info = {
  /** Unique service instance identifier. */
  readonly id?: string
  /** OpenCode version served by the process. */
  readonly version?: string
  /** Base URL advertised by the service. */
  readonly url: string
  /** Operating system process identifier. */
  readonly pid: number
  /** Private service password, when authentication is enabled. */
  readonly password?: string
}
