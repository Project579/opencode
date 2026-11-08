import { Plugin } from "@opencode/plugin/tui"

// Takes over the body of a permission prompt; the header and options stay the host's.
export default Plugin.define({
  id: "fixture.permission-body",
  setup(context) {
    context.ui.slot({
      replace: "experimental.session.permission.body",
      render: (input) => <text>{`Plugin body for ${input.sessionID} ${input.requestID}`}</text>,
    })
  },
})
