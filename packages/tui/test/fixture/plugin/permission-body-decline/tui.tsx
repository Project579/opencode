import { Plugin } from "@opencode/plugin/tui"

// Claims the body of a permission prompt but declines it, rendering the host's own body.
export default Plugin.define({
  id: "fixture.permission-body-decline",
  setup(context) {
    context.ui.slot({
      replace: "experimental.session.permission.body",
      render: (input) => input.fallback(),
    })
  },
})
