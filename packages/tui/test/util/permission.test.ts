import { expect, test } from "bun:test"
import { permissionPresentation } from "../../src/util/permission"

test("preserves permission roots and self-contained metadata", () => {
  expect(permissionPresentation({ action: "external_directory", resources: ["/*"] }).title).toBe(
    "Access external directory /",
  )
  expect(permissionPresentation({ action: "external_directory", resources: ["C:/*"] }).title).toBe(
    "Access external directory C:/",
  )
  expect(
    permissionPresentation({ action: "webfetch", resources: [], metadata: { url: "https://example.com" } }),
  ).toMatchObject({
    title: "WebFetch https://example.com",
    lines: ["URL: https://example.com"],
  })
  expect(permissionPresentation({ action: "websearch", resources: [], metadata: { query: "releases" } })).toMatchObject(
    {
      title: 'Web Search "releases"',
      lines: ["Query: releases"],
    },
  )
})

test("shows the call's arguments and resources for tools without their own presentation", () => {
  expect(
    permissionPresentation({
      action: "docs_lookup",
      resources: ["docs/intro"],
      input: { query: "install", options: { limit: 3 } },
    }),
  ).toEqual({
    icon: "⚙",
    title: "Call tool docs_lookup",
    lines: ["Tool: docs_lookup", "query: install", 'options: {"limit":3}', "- docs/intro"],
  })
  // A tool-wide request adds nothing beyond the tool name.
  expect(permissionPresentation({ action: "docs_lookup", resources: ["*"] }).lines).toEqual(["Tool: docs_lookup"])
})

test("prefers the input the request carries over the tool part it points at", () => {
  // A nested Code Mode call points at the outer `execute` part, whose input is the script.
  expect(
    permissionPresentation({
      action: "mymcp_search",
      resources: ["*"],
      metadata: { input: { query: "releases" } },
      input: { code: "await tools.mymcp.search({ query: 'releases' })" },
    }).lines,
  ).toEqual(["Tool: mymcp_search", "query: releases"])
})

test("shortens long arguments and caps how many are shown", () => {
  const input = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`key${index}`, "x".repeat(300)]))
  const lines = permissionPresentation({ action: "bulk", resources: ["*"], input }).lines
  expect(lines).toHaveLength(9)
  expect(lines[1]).toHaveLength(160)
  expect(lines[1]!.endsWith("…")).toBe(true)
  expect(lines[8]).toBe("… 3 more")
})
