import { expect, test } from "bun:test"
import type { PermissionRequest, SessionInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { copyPlugin, tmpdir } from "./fixture/fixture"

test("a permission prompt without a plugin claim keeps its options and keys", async () => {
  await using state = await tmpdir()
  await using setup = await createPermissionFixture(state.path)
  await setup.waitForFrame((frame) => frame.includes("Allow once") && frame.includes("Reject"))
  expect(setup.captureCharFrame()).toContain("Permission required")
  expect(setup.captureCharFrame()).toContain("echo permission-fixture")

  setup.mockInput.pressArrow("right")
  setup.mockInput.pressArrow("left")
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.requests.length === 1)
  expect(setup.requests).toEqual([{ decision: "once" }])
})

test("the built-in options keep their fullscreen toggle across the remount it causes", async () => {
  await using state = await tmpdir()
  await using setup = await createPermissionFixture(state.path)
  await setup.waitForFrame((frame) => frame.includes("fullscreen"))

  setup.mockInput.pressKey("f", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("minimize"))
  setup.mockInput.pressKey("f", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("fullscreen") && !frame.includes("minimize"))
  expect(setup.requests).toHaveLength(0)

  // The keymap registered again after the remount.
  setup.mockInput.pressArrow("right")
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.requests.length === 1)
  expect(setup.requests).toEqual([{ decision: "reject" }])
})

test("a replace claim swaps the options and their keys while the request stays visible", async () => {
  await using plugin = await copyPlugin("permission-options")
  await using state = await tmpdir()
  await using setup = await createPermissionFixture(state.path, [plugin.directory])
  await setup.waitForFrame((frame) => frame.includes(`Plugin options for ${setup.session.id} ${setup.permission.id}`))

  const frame = setup.captureCharFrame()
  expect(frame).toContain("Permission required")
  expect(frame).toContain("echo permission-fixture")
  expect(frame).not.toContain("Allow once")
  expect(frame).not.toContain("Reject")
  expect(frame).not.toContain("confirm")

  // The built-in keymap is gone with the row, so no key answers the request.
  setup.mockInput.pressArrow("right")
  setup.mockInput.pressEnter()
  await setup.flush()
  expect(setup.requests).toHaveLength(0)
})

test.each([120, 60])(
  "a body claim replaces the request's body while the header and options stay at width %d",
  async (width) => {
    await using plugin = await copyPlugin("permission-body")
    await using state = await tmpdir()
    await using setup = await createPermissionFixture(state.path, [plugin.directory], undefined, width)
    await setup.waitForFrame(
      (frame) =>
        frame.includes("Plugin body for") && frame.includes(setup.session.id) && frame.includes(setup.permission.id),
    )

    const frame = setup.captureCharFrame()
    expect(frame).toContain("Permission required")
    expect(frame).toContain("Allow once")
    expect(frame).not.toContain("echo permission-fixture")

    // The options and their keys stay the host's.
    setup.mockInput.pressEnter()
    await setup.waitFor(() => setup.requests.length === 1)
    expect(setup.requests).toEqual([{ decision: "once" }])
  },
)

test("a body claim that returns the fallback shows the host's body, which still follows the selection", async () => {
  await using plugin = await copyPlugin("permission-body-decline")
  await using state = await tmpdir()
  await using setup = await createPermissionFixture(state.path, [plugin.directory], ["echo *"])
  await setup.waitForFrame((frame) => frame.includes("echo permission-fixture") && frame.includes("Allow once"))

  setup.mockInput.pressArrow("right")
  await setup.waitForFrame(
    (frame) => frame.includes("always allow the following patterns") && !frame.includes("echo permission-fixture"),
  )
  setup.mockInput.pressArrow("left")
  await setup.waitForFrame((frame) => frame.includes("echo permission-fixture"))
})

test("fullscreen stays with the prompt while a plugin claims the options", async () => {
  await using plugin = await copyPlugin("permission-options")
  await using state = await tmpdir()
  await using setup = await createPermissionFixture(state.path, [plugin.directory])
  await setup.waitForFrame((frame) => frame.includes("Plugin options for"))
  const row = () =>
    setup
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("Permission required"))
  const docked = row()

  setup.mockInput.pressKey("f", { ctrl: true })
  await setup.waitFor(() => row() < docked)
  setup.mockInput.pressKey("f", { ctrl: true })
  await setup.waitFor(() => row() === docked)
  expect(setup.requests).toHaveLength(0)
})

test.each([
  ["without a plugin claim", undefined, "Allow once"],
  ["under an options claim", "permission-options", "Plugin options for"],
  ["under a body claim", "permission-body", "Plugin body for"],
] as const)("ctrl+c at a permission prompt %s rejects the request instead of exiting", async (_name, name, ready) => {
  await using plugin = await copyPlugin(name ?? "permission-options")
  await using state = await tmpdir()
  await using setup = await createPermissionFixture(state.path, name ? [plugin.directory] : [])
  await setup.waitForFrame((frame) => frame.includes(ready))

  setup.mockInput.pressKey("c", { ctrl: true })
  await setup.waitFor(() => setup.requests.length === 1)
  expect(setup.requests).toEqual([{ decision: "reject" }])
  expect(setup.renderer.isDestroyed).toBe(false)
})

async function createPermissionFixture(state: string, plugins: string[] = [], save?: string[], width = 120) {
  const session = {
    id: `ses_slot_${crypto.randomUUID()}`,
    title: "Slot fixture",
    projectID: "proj_slot",
    location: { directory },
    agent: "build",
    model: { providerID: "fixture", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  } satisfies SessionInfo
  const permission = {
    id: `per_slot_${crypto.randomUUID()}`,
    sessionID: session.id,
    action: "shell",
    resources: ["echo permission-fixture"],
    ...(save ? { save } : {}),
  } satisfies PermissionRequest
  const location = { directory, project: { id: session.projectID, directory, canonical: directory } }
  const requests: unknown[] = []
  const setup = await createAppFixture({
    width,
    height: 30,
    state,
    args: { sessionID: session.id },
    config: { animations: false, plugins, session: { sidebar: "hide" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "fixture", name: "Model", variants: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "fixture", name: "Fixture" }] })
      if (url.pathname === "/api/vcs") return json({ location, data: { branch: { current: "slot", default: "v2" } } })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [permission] })
      if (url.pathname === `/api/session/${session.id}/form`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/permission/${permission.id}/reply`) {
        requests.push(await request.json())
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })
  return Object.assign(setup, { requests, session, permission })
}
