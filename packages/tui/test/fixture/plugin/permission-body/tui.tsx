import { Plugin } from "@opencode/plugin/tui"

// Takes over the body of a permission prompt; the header and options stay the host's.
export default Plugin.define({
  id: "fixture.permission-body",
  setup(context) {
    context.ui.slot({
      replace: "experimental.session.permission.body",
      render: (input) => (
        <box>
          <text>Plugin body for</text>
          <text>{input.sessionID}</text>
          <text>{input.requestID}</text>
        </box>
      ),
    })
  },
})
