/**
 * Whether Desktop may start or replace the local service, from `OPENCODE_EXPERIMENTAL_SERVICE_AUTOSTART`. `0` or
 * `false` (any case) turns it off, so Desktop only connects to a service that is already running.
 */
export function serviceAutostart(value: string | undefined) {
  if (value === undefined) return true
  return !(value === "0" || value.toLowerCase() === "false")
}
