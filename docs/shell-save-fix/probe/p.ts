const { Effect } = await import("/home/rq279/GitHub/opencode/.worktrees/shell-wrapper-deny/node_modules/.bun/effect@4.1.0/node_modules/effect/dist/index.js")
const B = "/home/rq279/GitHub/opencode/.worktrees/shell-save-fix/packages/core/src"
const D = "/home/rq279/GitHub/opencode/.worktrees/dev-baseline/packages/core/src"
const PB = (await import(B + "/shell/parse.ts")).ShellParse
const PD = (await import(D + "/shell/parse.ts")).ShellParse
const { Wildcard } = await import(B + "/util/wildcard.ts")
const shell = process.env.SH ?? "/bin/bash"
const run = async (P: any, c: string) => { const r: any = await Effect.runPromise(Effect.result(P.scan(c, shell, "/p"))); return r.success }
const fmt = (r: any) => !r ? "FAIL" : (r.unsavable ? "U " : "") + r.commands.map((x: any) => JSON.stringify(x.save)).join(" | ")
const covers = (saves: string[], r: any) => !!r && r.commands.length > 0 && r.commands.every((x: any) => saves.some((s) => Wildcard.match(x.resource, s)))
const file = process.argv[2]
for (const line of (await Bun.file(file).text()).split("\n")) {
  if (!line.trim() || line.startsWith("#")) continue
  const [a, ...others] = line.split(" ||| ").map((s) => s.replaceAll("\\t", "\t").replaceAll("\\n", "\n").replaceAll("\\u00a0", " "))
  const b = await run(PB, a), d = await run(PD, a)
  let out = `${JSON.stringify(a)}\tB: ${fmt(b)}\tD: ${fmt(d)}`
  for (const o of others) {
    const ro = await run(PB, o)
    const bs = b && !b.unsavable ? b.commands.map((x: any) => x.save) : []
    const ds = d ? d.commands.map((x: any) => x.save) : []
    out += `\n    other ${JSON.stringify(o)} res=${JSON.stringify(ro?.commands.map((x: any) => x.resource))} B-covers=${covers(bs, ro)} D-covers=${covers(ds, ro)}`
  }
  console.log(out)
}
