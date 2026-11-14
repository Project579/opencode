const readline = require("node:readline")

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const request = JSON.parse(line)
    if (request.id === undefined) return
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "wrapped-test", version: "1" },
          }
        : { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }] }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n")
  })
  .on("close", () => process.exit(0))
