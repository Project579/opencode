import { Plugin } from "@opencode/plugin/tui"

// Takes over the choices row of a permission prompt and answers nothing by itself.
export default Plugin.define({
  id: "fixture.permission-options",
  setup(context) {
    context.ui.slot({
      replace: "experimental.session.permission.options",
      render: (input) => <text>{`Plugin options for ${input.sessionID} ${input.requestID}`}</text>,
    })
  },
})
