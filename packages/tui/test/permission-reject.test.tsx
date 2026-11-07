import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import type { PermissionRequest } from "@opencode/client"
import { PermissionPrompt } from "../src/routes/session/permission"
import { renderLocal, session } from "./fixture/local"

const request = {
  id: "per_reject",
  sessionID: "ses_root",
  action: "shell",
  resources: ["git push"],
} as PermissionRequest

// The renderer is not started, so draw a frame per check until the condition holds.
async function until(setup: Setup, ready: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the screen:\n${setup.captureCharFrame()}`)
    await setup.renderOnce()
    await Bun.sleep(5)
  }
}

type Setup = Awaited<ReturnType<typeof renderLocal>>

async function renderPrompt() {
  const replies: unknown[] = []
  const setup = await renderLocal({
    sessions: [session("ses_root")],
    view: () => <PermissionPrompt request={request} />,
    fetch: async (url, req) => {
      if (url.pathname === `/api/session/ses_root/permission/${request.id}/reply`) {
        replies.push(await req.json())
        return new Response(null, { status: 204 })
      }
    },
  })
  await until(setup, () => setup.captureCharFrame().includes("Permission required"))
  return { setup, replies }
}

async function pressReject(setup: Setup) {
  await setup.mockInput.pressArrow("right")
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await until(
    setup,
    () =>
      setup.captureCharFrame().includes("Reject permission") &&
      setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
  )
}

test("rejecting in a root session offers a reason, and the reason is sent", async () => {
  const { setup, replies } = await renderPrompt()
  await using _ = setup
  await pressReject(setup)
  await setup.mockInput.typeText("use a PR")
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await until(setup, () => replies.length > 0)
  expect(replies).toEqual([{ decision: "reject", message: "use a PR" }])
})

test("rejecting with an empty reason sends no message", async () => {
  const { setup, replies } = await renderPrompt()
  await using _ = setup
  await pressReject(setup)
  setup.mockInput.pressEnter()
  await until(setup, () => replies.length > 0)
  expect(replies).toEqual([{ decision: "reject" }])
})

test("escape on the reason stage returns to the choices without replying", async () => {
  const { setup, replies } = await renderPrompt()
  await using _ = setup
  await pressReject(setup)
  setup.mockInput.pressEscape()
  await until(setup, () => setup.captureCharFrame().includes("Permission required"))
  expect(replies).toEqual([])
})
