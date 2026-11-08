import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionTable } from "@opencode/core/permission/sql"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { ShellParse } from "@opencode/core/shell/parse"
import { ShellSpacing } from "@opencode/core/shell/spacing"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, PermissionSaved.node, Agent.node, Permission.node]),
    [Location.node.replace(current)],
  ),
)

function setup(rules: Permission.Ruleset = [], sessionID = Session.ID.make("ses_test")) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: Agent.ID.make("test"),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: Permission.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<Permission.AssertInput> = {}) {
  return {
    id: Permission.ID.create("per_test"),
    sessionID: Session.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies Permission.AssertInput
}

function waitForRequest(input: Partial<Permission.AssertInput> = {}) {
  return Effect.gen(function* () {
    const value = assertion(input)
    const service = yield* Permission.Service
    const bus = yield* Bus.Service
    const asked = yield* Deferred.make<Permission.Request>()
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type !== Permission.Event.Asked.type) return Effect.void
      const request = event.data as Permission.Request
      return request.id === value.id ? Deferred.succeed(asked, request).pipe(Effect.asVoid) : Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(value).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("Permission", () => {
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* Permission.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: Agent.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: Agent.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(Permission.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("checks for a deny without asking", () =>
    Effect.gen(function* () {
      yield* setup([])
      const service = yield* Permission.Service
      yield* service.assertNotDenied(assertion())
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.assertNotDenied(assertion()).pipe(Effect.flip)).toBeInstanceOf(Permission.BlockedError)
    }),
  )

  it.effect("reports whether a request is already allowed without asking", () =>
    Effect.gen(function* () {
      yield* setup([])
      const service = yield* Permission.Service
      expect(yield* service.allows(assertion())).toBe(false)
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "allow" }])
      expect(yield* service.allows(assertion())).toBe(true)
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.allows(assertion())).toBe(false)
    }),
  )

  test("matches Windows rule resources against slash-normalized file access resources", () => {
    const rules: Permission.Ruleset = [
      { action: "external_directory", resource: "C:\\Users\\x\\proj\\*", effect: "allow" },
    ]
    expect(Permission.evaluate("external_directory", "C:/Users/x/proj/src/*", rules).effect).toBe("allow")
    expect(Permission.evaluate("external_directory", "C:/Users/x/other/*", rules).effect).toBe("ask")
  })

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* Permission.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "custom", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion({ action: "custom", resources: ["*"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => {
        editor.remove(Agent.ID.make("test"))
        editor.remove(Agent.ID.make("build"))
      })

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: Permission.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: Permission.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("merges session rules after agent rules and before saved approvals", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const { db } = yield* Database.Service
      const service = yield* Permission.Service
      const setSession = (permission: Permission.Ruleset) =>
        db
          .update(SessionTable)
          .set({ permission })
          .where(eq(SessionTable.id, Session.ID.make("ses_test")))
          .run()
          .pipe(Effect.orDie)

      yield* setSession([{ action: "edit", resource: "/original/**", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "edit", resources: ["/original/src/index.ts"] }))).toMatchObject({
        effect: "deny",
      })

      yield* setRules([])
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })
      yield* setSession([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toMatchObject({ effect: "deny" })
      yield* setSession([{ action: "bash", resource: "*", effect: "ask" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(Session.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("drops undefined metadata values so pending requests encode as JSON", () =>
    Effect.gen(function* () {
      yield* setup()
      // Tools copy optional model inputs straight into metadata, so omitted inputs arrive as undefined values.
      const { service, request } = yield* waitForRequest({
        action: "glob",
        resources: ["/project"],
        metadata: { root: "/project", path: undefined, hidden: undefined, limit: undefined },
      })
      expect(request.metadata).toStrictEqual({ root: "/project" })
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      // HttpApi encodes JSON success bodies through Schema.toCodecJson, which rejects undefined values in Unknown.
      const encode = Schema.encodeEffect(Schema.toCodecJson(Schema.Struct({ data: Schema.Array(Permission.Request) })))
      expect(yield* encode({ data: yield* service.forSession(request.sessionID) })).toEqual({
        data: [
          {
            id: request.id,
            sessionID: request.sessionID,
            action: "glob",
            resources: ["/project"],
            metadata: { root: "/project" },
          },
        ],
      })
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* Permission.Service
      const asked = yield* Deferred.make<Permission.Request>()
      const bus = yield* Bus.Service
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Permission.Event.Asked.type
          ? Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toMatchObject([
        { id, projectID: Project.ID.global, action: "read", resource: "src/*" },
      ])
      yield* service.assert(assertion({ id: Permission.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )

  it.effect("edits saved approvals and enforces the edited rule", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      const service = yield* Permission.Service
      yield* saved.add({ projectID: Project.ID.global, action: "read", resources: ["src/*", "docs/*"] })
      const src = (yield* saved.list()).find((item) => item.resource === "src/*")

      expect(yield* saved.update({ id: src!.id, resource: "src/allowed.ts" })).toMatchObject({
        id: src!.id,
        projectID: Project.ID.global,
        action: "read",
        resource: "src/allowed.ts",
      })
      expect(
        yield* service.ask(assertion({ id: Permission.ID.create("per_allowed"), resources: ["src/allowed.ts"] })),
      ).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ id: Permission.ID.create("per_other"), resources: ["src/other.ts"] })),
      ).toMatchObject({ effect: "ask" })

      expect(yield* saved.update({ id: src!.id, resource: "docs/*" }).pipe(Effect.flip)).toMatchObject({
        _tag: "PermissionSaved.ConflictError",
        id: src!.id,
        resource: "docs/*",
      })
      expect(
        yield* saved.update({ id: PermissionSaved.ID.make("psv_missing"), action: "edit" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "PermissionSaved.NotFoundError" })
    }),
  )

  for (const guard of ["configured deny", "missing Session"] as const) {
    it.effect(`skips pending auto-approval after always for ${guard}`, () =>
      Effect.gen(function* () {
        yield* setup()
        yield* setup([], Session.ID.make("ses_other"))
        const agents = yield* Agent.Service
        yield* agents.transform((editor) =>
          editor.update(Agent.ID.make("reviewer"), (agent) => {
            agent.permissions = []
          }),
        )
        const selected = yield* waitForRequest({ save: ["src/*"] })
        const other = yield* waitForRequest({
          id: Permission.ID.create("per_other"),
          sessionID: Session.ID.make("ses_other"),
          agent: Agent.ID.make("reviewer"),
        })
        if (guard === "configured deny") {
          yield* agents.transform((editor) =>
            editor.update(Agent.ID.make("reviewer"), (agent) => {
              agent.permissions = [{ action: "read", resource: "*", effect: "deny" }]
            }),
          )
        }
        if (guard === "missing Session") {
          const { db } = yield* Database.Service
          yield* db.delete(SessionTable).where(eq(SessionTable.id, other.request.sessionID)).run().pipe(Effect.orDie)
        }
        yield* selected.service.reply({ requestID: selected.request.id, reply: "always" })
        yield* Fiber.join(selected.fiber)
        expect(yield* selected.service.list()).toEqual([other.request])
        expect(other.fiber.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(other.fiber)
        expect(yield* selected.service.list()).toEqual([])
      }),
    )
  }
})

describe("shell scanner permission impact", () => {
  // Fixed cases require matching outcomes; remaining differences are investigation snapshots, not contracts.
  // These service-level cases all have command resources; tool tests cover skipped checks and directories.
  // Outcome pairs are [legacy, native].
  for (const fixture of [
    {
      name: "timed command saves the wrapper with what it runs",
      shell: "bash",
      command: "time -p git status",
      approved: ["time -p git status *"],
      exact: ["time -p git status"],
      denied: "time -p git status",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "coprocess command saves the wrapper with what it runs",
      shell: "bash",
      command: "coproc git status",
      approved: ["coproc git status *"],
      exact: ["coproc git status"],
      denied: "coproc git status",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "declarations and unset",
      shell: "bash",
      command: "export X=value; unset X; git status",
      approved: ["git status *"],
      exact: ["git status"],
      denied: "export *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "export with an approved command substitution",
      shell: "bash",
      command: "export VERSION=$(git describe --tags); npm run build",
      approved: ["git describe *", "npm run build *"],
      exact: ["git describe --tags", "npm run build"],
      denied: "export *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "export retains checks on the command substitution",
      shell: "bash",
      command: "export VERSION=$(git describe --tags); npm run build",
      approved: ["git describe *", "npm run build *"],
      exact: ["git describe --tags", "npm run build"],
      denied: "git describe *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "redirect after a conditional list",
      shell: "bash",
      command: "printf ok && git status > output",
      approved: ["printf *", "git status *"],
      exact: ["printf ok", "git status"],
      denied: "git status *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "redirect after a pipeline",
      shell: "bash",
      command: "printf ok | cat < input > output",
      approved: ["printf *", "cat *"],
      exact: ["printf ok", "cat"],
      denied: "cat *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "assignment redirect followed by a command",
      shell: "bash",
      command: "FOO=bar > output; printf done",
      approved: ["printf *"],
      exact: ["printf done"],
      denied: "FOO=bar > output",
      savedEffect: ["ask", "ask"],
      exactEffect: ["ask", "ask"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "assignment redirect with an approved command substitution",
      shell: "bash",
      command: "VERSION=$(git describe --tags) > build/version.txt",
      approved: ["git describe *"],
      exact: ["git describe --tags"],
      denied: "VERSION=$(git describe --tags) > build/version.txt",
      savedEffect: ["ask", "ask"],
      exactEffect: ["ask", "ask"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "substitution in a saved prefix",
      shell: "bash",
      command: "git $(printf diff) --stat",
      approved: ["git *", "printf *"],
      exact: ["git $(printf diff) --stat", "printf diff"],
      denied: "git $(printf diff) --stat",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "standalone PowerShell scriptblock caller",
      shell: "pwsh",
      command: "ForEach-Object { Write-Output value }",
      approved: ["Write-Output *"],
      exact: ["Write-Output value"],
      denied: "ForEach-Object *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "tab-separated PowerShell command",
      shell: "pwsh",
      command: "git\tstatus; Write-Output done",
      approved: ["git status *", "Write-Output *"],
      exact: ["git status", "Write-Output done"],
      denied: "git\tstatus",
      // Shell commands and rules are matched with their unquoted spacing collapsed.
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "deny"],
    },
    {
      name: "PowerShell equals-joined argument",
      shell: "pwsh",
      command: "git --work-tree=src status",
      approved: ["git --work-tree *"],
      exact: ["git --work-tree"],
      denied: "git --work-tree",
      savedEffect: ["allow", "ask"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["deny", "allow"],
    },
    {
      name: "trailing redirect after list operator",
      shell: "bash",
      command: "true && cat > secret",
      approved: ["true *", "cat *"],
      exact: ["true", "cat"],
      denied: "* > secret*",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["allow", "deny"],
    },
    {
      name: "commandless redirect write",
      shell: "zsh",
      command: ">> ~/.zshrc <<< 'x'",
      approved: [">> *"],
      exact: [">> ~/.zshrc <<< 'x'"],
      denied: ">> *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "PowerShell .NET method invocation",
      shell: "pwsh",
      command: '[IO.File]::Delete("C:\\victim")',
      approved: ["[IO.File]::Delete(*"],
      exact: ['[IO.File]::Delete("C:\\victim")'],
      denied: "*Delete(*",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
  ] as const) {
    for (const scenario of [
      { name: "no approval", saved: [], rules: [], expected: ["ask", "ask"] },
      { name: "saved wildcard", saved: ["*"], rules: [], expected: ["allow", "allow"] },
      { name: "saved command approvals", saved: fixture.approved, rules: [], expected: fixture.savedEffect },
      {
        name: "exact configured approvals",
        saved: [],
        rules: fixture.exact.map((resource): Permission.Rule => ({ action: "shell", resource, effect: "allow" })),
        expected: fixture.exactEffect,
      },
      {
        name: "exact saved approvals",
        saved: fixture.exact,
        rules: [],
        expected: fixture.exactEffect,
      },
      {
        name: "configured deny despite saved wildcard",
        saved: ["*"],
        rules: [{ action: "shell", resource: fixture.denied, effect: "deny" }] satisfies Permission.Ruleset,
        expected: fixture.deniedEffect,
      },
    ] as const) {
      it.live(`${fixture.name}: ${scenario.name}`, () =>
        Effect.gen(function* () {
          yield* setup(scenario.rules)
          const saved = yield* PermissionSaved.Service
          yield* saved.add({ projectID: Project.ID.global, action: "shell", resources: scenario.saved })
          const service = yield* Permission.Service

          const parsed = yield* ShellParse.scan(fixture.command, fixture.shell, "/project")
          expect(parsed.commands.length).toBeGreaterThan(0)
          expect(parsed.directories).toEqual([])
          const result = yield* service.ask(
            assertion({
              action: "shell",
              resources: parsed.commands.map((command) => command.resource),
              save: parsed.commands.map((command) => command.save),
            }),
          )
          expect(result.effect).toBe(scenario.expected[1])
          const pending = yield* service.list()
          expect(pending).toHaveLength(result.effect === "ask" ? 1 : 0)
          if (result.effect === "ask") {
            expect(pending[0]?.resources).toEqual(parsed.commands.map((command) => command.resource))
            expect(pending[0]?.save).toEqual(parsed.commands.map((command) => command.save))
            yield* service.reply({ requestID: result.id, reply: "once" })
            expect(yield* service.list()).toEqual([])
          }
        }),
      )
    }
  }

  // Grant/repeat rows select the granting parser; repeat columns select the parser used afterwards.
  for (const fixture of [
    {
      name: "numeric npm script prefix",
      shell: "bash",
      command: "npm run 123",
      grants: [["npm run *"], ["npm run 123 *"]],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: "npm run build",
      nextEffect: ["allow", "ask"],
    },
    {
      name: "numeric AWS option prefix",
      shell: "bash",
      command: "aws --cli-read-timeout 60 s3 ls",
      grants: [["aws --cli-read-timeout s3 *"], ["aws --cli-read-timeout 60 *"]],
      repeat: [
        ["ask", "ask"],
        ["allow", "allow"],
      ],
      next: "aws --cli-read-timeout 60 ec2 describe-instances",
      nextEffect: ["ask", "allow"],
    },
    {
      name: "substitution prefix",
      shell: "bash",
      command: "git $(printf diff) --stat",
      grants: [
        ["git --stat *", "printf *"],
        ["git $(printf diff) *", "printf *"],
      ],
      repeat: [
        ["ask", "ask"],
        ["allow", "allow"],
      ],
      next: "git --stat",
      nextEffect: ["allow", "ask"],
    },
    {
      name: "redirect prefix",
      shell: "bash",
      command: "printf ok && git status > output",
      grants: [
        ["printf *", "git status *"],
        ["printf *", "git status *"],
      ],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: "git status --short",
      nextEffect: ["allow", "allow"],
    },
    {
      name: "assignment prefix",
      shell: "bash",
      command: "FOO=bar git status",
      grants: [["FOO=bar git status *"], ["FOO=bar git status *"]],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: "git status",
      nextEffect: ["ask", "ask"],
    },
    {
      name: "leading redirect prefix",
      shell: "bash",
      command: "2>/dev/null curl -s https://example.com",
      grants: [["2>/dev/null curl *"], ["2>/dev/null curl *"]],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: "curl -s https://example.com",
      nextEffect: ["ask", "ask"],
    },
    {
      name: "assignment redirect prefix",
      shell: "bash",
      command: "FOO=bar > output; printf done",
      grants: [
        ["printf *"],
        ["FOO=bar > *", "printf *"],
      ],
      repeat: [
        ["ask", "allow"],
        ["ask", "allow"],
      ],
      next: "FOO=bar rm -rf /",
      nextEffect: ["ask", "ask"],
    },
    {
      name: "PowerShell method prefix",
      shell: "pwsh",
      command: '[IO.File]::Delete("C:\\first")',
      grants: [
        ["[IO.File]::Delete(*"],
        ["[IO.File]::Delete(*"],
      ],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: '[IO.File]::WriteAllText("C:\\first", "x")',
      nextEffect: ["ask", "ask"],
    },
    {
      name: "PowerShell tab prefix",
      shell: "pwsh",
      command: "git\tstatus; Write-Output done",
      grants: [["Write-Output *"], ["git\tstatus *", "Write-Output *"]],
      repeat: [
        ["allow", "ask"],
        ["allow", "allow"],
      ],
      next: "git status",
      // The saved `git\tstatus *` matches however the command is spaced.
      nextEffect: ["ask", "allow"],
    },
  ] as const) {
    it.live(`${fixture.name}: always allow covers repeat execution and narrows prefix scope`, () =>
      Effect.gen(function* () {
        yield* setup()
        const service = yield* Permission.Service
        const saved = yield* PermissionSaved.Service
        const parsed = yield* ShellParse.scan(fixture.command, fixture.shell, "/project")
        const first = yield* service.ask(
          assertion({
            action: "shell",
            resources: parsed.commands.map((command) => command.resource),
            save: parsed.commands.map((command) => command.save),
          }),
        )
        expect(first.effect).toBe("ask")
        expect(yield* service.list()).toHaveLength(1)
        yield* service.reply({ requestID: first.id, reply: "always" })
        expect(yield* service.list()).toEqual([])
        expect((yield* saved.list({ projectID: Project.ID.global })).map((rule) => rule.resource).sort()).toEqual(
          [...fixture.grants[1]].sort(),
        )

        for (const command of [fixture.command, fixture.next]) {
          const parsed = yield* ShellParse.scan(command, fixture.shell, "/project")
          const result = yield* service.ask(
            assertion({
              action: "shell",
              resources: parsed.commands.map((command) => command.resource),
              save: parsed.commands.map((command) => command.save),
            }),
          )
          expect(result.effect, command).toBe(command === fixture.next ? fixture.nextEffect[1] : fixture.repeat[1]?.[1])
          if (result.effect === "ask") yield* service.reply({ requestID: result.id, reply: "once" })
          expect(yield* service.list()).toEqual([])
        }
      }),
    )
  }
})

describe("shell rules through wrapper commands", () => {
  const request = (command: string) =>
    Effect.gen(function* () {
      const parsed = yield* ShellParse.scan(command, "bash", "/project")
      return assertion({
        action: "shell",
        resources: parsed.commands.map((item) => item.resource),
        save: parsed.unsavable ? undefined : parsed.commands.map((item) => item.save),
        guards: parsed.guards,
        opaque: parsed.opaque,
      })
    })
  const ask = (command: string) =>
    Effect.gen(function* () {
      const service = yield* Permission.Service
      return yield* service.ask(yield* request(command))
    })

  for (const command of [
    "time rm x",
    "command rm x",
    "builtin rm x",
    "env rm x",
    "env X=1 rm x",
    "env -i PATH=/bin rm x",
    "FOO=1 rm x",
    "FOO=1 env rm x",
    "nohup rm x",
    "timeout 5 rm x",
    "nice -n 5 rm x",
    "sudo -u root rm x",
    "xargs rm <<< x",
    "echo x | xargs rm",
    "bash -c 'rm x'",
    "sh -c 'rm x'",
    "bash -lc 'git status && rm x'",
    "eval 'rm x'",
    "find . -name x -exec rm {} \\;",
    "find . -name x -exec rm {} +",
    "sudo env FOO=1 bash -c 'rm x'",
    "sudo FOO=1 rm x",
    "sudo env FOO=1 rm x",
    "2>/dev/null rm x",
    "> out rm x",
    "2>/dev/null env rm x",
    "env 2>/dev/null rm x",
    "timeout 5 >/dev/null rm x",
    "sudo 2>&1 rm x",
    "xargs >out rm",
  ])
    it.live(`a deny for the wrapped command applies to ${command}`, () =>
      Effect.gen(function* () {
        yield* setup([
          { action: "*", resource: "*", effect: "allow" },
          { action: "shell", resource: "rm *", effect: "deny" },
        ])
        expect((yield* ask(command)).effect).toBe("deny")
      }),
    )

  it.live("leaves unrelated wrapped commands allowed", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "allow" },
        { action: "shell", resource: "rm *", effect: "deny" },
      ])
      for (const command of ["time git status", "env FOO=1 ls", "bash -c 'git status'", "echo x | xargs ls"])
        expect((yield* ask(command)).effect, command).toBe("allow")
    }),
  )

  it.live("adds guards only for commands that run another command", () =>
    Effect.gen(function* () {
      for (const command of ["git status", "rm -rf x", "ls > out", "export FOO=1", "cd /tmp", "npm run build"])
        expect((yield* ShellParse.scan(command, "bash", "/project")).guards, command).toBeUndefined()
      for (const [command, guards] of [
        ["FOO=bar git status", ["git status"]],
        ["timeout 10 git status", ["git status"]],
        ["FOO=1 env rm x", ["env rm x", "rm x"]],
        [
          "sudo env FOO=1 bash -c 'rm x'",
          [
            "sudo env FOO=1 bash -c rm x",
            "env FOO=1 bash -c 'rm x'",
            "env FOO=1 bash -c rm x",
            "bash -c 'rm x'",
            "bash -c rm x",
            "rm x",
          ],
        ],
        ["sudo FOO=1 rm x", ["rm x"]],
        ["2>/dev/null rm x", ["rm x"]],
        ["command -v rm", undefined],
      ] as const)
        expect((yield* ShellParse.scan(command, "bash", "/project")).guards, command).toEqual(guards && [...guards])
    }),
  )

  it.live("marks a script the outer shell expands as opaque", () =>
    Effect.gen(function* () {
      for (const command of ['bash -c "rm $X"', "env $CMD x", 'eval "$x"'])
        expect((yield* ShellParse.scan(command, "bash", "/project")).opaque, command).toBe(true)
    }),
  )

  it.live("a rule allowing only the wrapped command does not allow the wrapper", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "shell", resource: "*", effect: "ask" },
        { action: "shell", resource: "git status *", effect: "allow" },
      ])
      const service = yield* Permission.Service
      expect((yield* ask("git status")).effect).toBe("allow")
      for (const command of ["timeout 10 git status", "FOO=bar git status", "env git status"]) {
        const result = yield* ask(command)
        expect(result.effect, command).toBe("ask")
        yield* service.reply({ requestID: result.id, reply: "once" })
      }
    }),
  )

  it.live("always saves the full command line with what it runs, and the prompt shows only full commands", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "shell", resource: "*", effect: "ask" }])
      const service = yield* Permission.Service
      const saved = yield* PermissionSaved.Service
      for (const [command, grant] of [
        ["timeout 10 git status", "timeout 10 git status *"],
        ["FOO=bar git status", "FOO=bar git status *"],
        ["FOO=1 env rm x", "FOO=1 env rm *"],
        ["sudo FOO=1 rm x", "sudo FOO=1 rm *"],
        ["bash -c 'rm x'", "bash -c 'rm x'"],
        ["timeout 5 >/dev/null rm x", "timeout 5 >/dev/null rm x"],
      ] as const) {
        const input = yield* request(command)
        expect(input.save, command).toEqual([grant])
        const first = yield* service.ask(input)
        expect(first.effect, command).toBe("ask")
        expect((yield* service.list()).map((item) => [item.resources, item.save, "guards" in item])).toEqual([
          [[command], [grant], false],
        ])
        yield* service.reply({ requestID: first.id, reply: "always" })
        expect((yield* ask(command)).effect, command).toBe("allow")
      }
      expect((yield* saved.list({ projectID: Project.ID.global })).map((rule) => rule.resource)).not.toContain(
        "git status *",
      )
    }),
  )

  it.live("offers no always when the exact save would hold a wildcard from the command", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "shell", resource: "*", effect: "ask" }])
      const service = yield* Permission.Service
      const saved = yield* PermissionSaved.Service
      for (const command of [
        "env X=* rm x",
        "find . -name '*.log' -exec rm {} \\;",
        "bash -c 'rm *.tmp'",
        "bash -c 'rm ?'",
      ]) {
        const input = yield* request(command)
        expect(input.save, command).toBeUndefined()
        const first = yield* service.ask(input)
        expect(first.effect, command).toBe("ask")
        expect((yield* service.list())[0]?.save, command).toBeUndefined()
        yield* service.reply({ requestID: first.id, reply: "always" })
        const again = yield* ask(command)
        expect(again.effect, command).toBe("ask")
        yield* service.reply({ requestID: again.id, reply: "once" })
      }
      expect(yield* saved.list({ projectID: Project.ID.global })).toEqual([])
      // A wildcard only in what the wrapper runs, past the saved prefix, keeps "always".
      expect((yield* request("timeout 5 rm *.tmp")).save).toEqual(["timeout 5 rm *"])
    }),
  )

  it.live("a configured deny for a guard applies whatever its order", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "shell", resource: "*", effect: "deny" },
        { action: "shell", resource: "timeout *", effect: "allow" },
      ])
      expect((yield* ask("timeout 5 make")).effect).toBe("deny")
      yield* setup([
        { action: "shell", resource: "rm *", effect: "deny" },
        { action: "shell", resource: "timeout *", effect: "allow" },
      ])
      expect((yield* ask("timeout 5 rm x")).effect).toBe("deny")
      expect((yield* ask("timeout 5 make")).effect).toBe("allow")
    }),
  )

  for (const command of ["timeout 10 git status", "FOO=bar git status"])
    it.live(`approving ${command} always approves neither the bare command nor other wrapped commands`, () =>
      Effect.gen(function* () {
        yield* setup([{ action: "shell", resource: "*", effect: "ask" }])
        const service = yield* Permission.Service
        const first = yield* ask(command)
        yield* service.reply({ requestID: first.id, reply: "always" })
        expect((yield* ask(command)).effect).toBe("allow")
        for (const next of ["git status", "timeout 5 rm x", "timeout 10 rm x", "FOO=bar rm x", "env git status"]) {
          const result = yield* ask(next)
          expect(result.effect, next).toBe("ask")
          yield* service.reply({ requestID: result.id, reply: "once" })
        }
      }),
    )

  it.live("an ask rule for the wrapped command asks when it overrides the rule allowing the wrapper", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "allow" },
        { action: "shell", resource: "git push *", effect: "ask" },
      ])
      const service = yield* Permission.Service
      for (const command of ["env git push", "FOO=1 git push", "timeout 5 git push", "git status && env git push"]) {
        const result = yield* ask(command)
        expect(result.effect, command).toBe("ask")
        yield* service.reply({ requestID: result.id, reply: "once" })
      }
      expect((yield* ask("env git status")).effect).toBe("allow")

      // "Always" on the full command line settles its guards, as it settles the plain command's ask rule.
      const first = yield* ask("timeout 5 git push")
      yield* service.reply({ requestID: first.id, reply: "always" })
      expect((yield* ask("timeout 5 git push")).effect).toBe("allow")
    }),
  )

  it.live("an ask rule the wrapper's allow rule overrides does not ask", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "shell", resource: "git push *", effect: "ask" },
        { action: "*", resource: "*", effect: "allow" },
      ])
      expect((yield* ask("git push")).effect).toBe("allow")
      expect((yield* ask("env git push")).effect).toBe("allow")
    }),
  )

  it.live("unattended rules settle guard asks but never guard denies", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "shell", resource: "git push *", effect: "ask" },
        { action: "shell", resource: "rm *", effect: "deny" },
      ])
      const service = yield* Permission.Service
      const unattended = (command: string) =>
        Effect.gen(function* () {
          const input = yield* request(command)
          return yield* service.ask(input).pipe(
            Effect.provideService(
              Permission.Unattended,
              input.resources.map((resource) => ({ action: "shell", resource, effect: "allow" as const })),
            ),
          )
        })
      expect((yield* unattended("env git push")).effect).toBe("allow")
      expect((yield* unattended("env rm x")).effect).toBe("deny")
    }),
  )

  for (const command of [
    "/usr/bin/env rm x",
    "./env rm x",
    "/bin/sudo rm x",
    "bin/timeout 5 rm x",
    "sudo -R /r rm x",
    "sudo --chroot /r rm x",
    "sudo -D /tmp rm x",
    "sudo -uroot rm x",
    "sudo FOO=* rm x",
    "xargs -J % rm %",
    "xargs -R 1 rm",
    "env -a foo rm x",
    "env -P /bin rm x",
    "doas -a style rm x",
    "doas -u root rm x",
    "chroot --userspec u:g / rm x",
    "nice --adjustment 5 rm x",
    "ionice -c 3 -t rm x",
    "bash --rcfile /dev/null -c 'rm x'",
    "bash --init-file f -c 'rm x'",
    "/bin/sh -c 'rm x'",
    "watch rm x",
    "watch -n 5 rm x",
    "watch -n5 'ls; rm x'",
    "strace -o f rm x",
    "strace -e trace=open rm x",
    "ltrace -o f rm x",
    "su -c 'rm x'",
    "su root -c 'rm x'",
    "busybox rm x",
    "flock /tmp/l rm x",
    "flock -w 5 /tmp/l rm x",
    "flock /tmp/l -c 'rm x'",
    "chronic rm x",
    "unbuffer rm x",
    "firejail --private rm x",
    "'rm' x",
    '"rm" x',
    "r'm' x",
    "env 'rm' x",
    "command -p rm x",
    "exec -a NAME rm x",
    "! rm x",
    "time -p rm x",
    "coproc rm x",
    "builtin rm x",
    "find . -execdir rm {} \\;",
    "find . -ok rm {} \\;",
  ])
    it.live(`a deny for the wrapped command also applies to ${command}`, () =>
      Effect.gen(function* () {
        yield* setup([
          { action: "*", resource: "*", effect: "allow" },
          { action: "shell", resource: "rm *", effect: "deny" },
        ])
        expect((yield* ask(command)).effect).toBe("deny")
      }),
    )

  it.live("a deny holds through quoted words and spacing", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "allow" },
        { action: "shell", resource: "rm -rf *", effect: "deny" },
        { action: "shell", resource: "git push *", effect: "deny" },
      ])
      for (const command of ["rm '-rf' x", 'rm "-rf" x', "git  push", "git\tpush origin", "env git  push"])
        expect((yield* ask(command)).effect, command).toBe("deny")
      expect((yield* ask("rm -f x")).effect).toBe("allow")
    }),
  )

  for (const command of [
    'bash -c "$X"',
    'bash -c "$CMD"',
    'eval "$x"',
    'eval "\\$X"',
    "env $CMD x",
    "find . -exec $X {} \\;",
    "bash -c 'rm x; (('",
    "bash -c 'rm x; \\'",
    "bash <<EOF\nrm x\nEOF",
    "echo rm x | bash",
    "bash -s",
    "su",
    "su - root",
    "sudo -i",
    "sudo -s",
    "env env env env env env env env env env rm x",
  ])
    it.live(`a command it cannot read always asks and offers no always: ${command}`, () =>
      Effect.gen(function* () {
        yield* setup([
          { action: "*", resource: "*", effect: "allow" },
          { action: "shell", resource: "git push *", effect: "deny" },
        ])
        const service = yield* Permission.Service
        const input = yield* request(command)
        expect(input.opaque, command).toBe(true)
        expect(input.save, command).toBeUndefined()
        const first = yield* service.ask(input)
        expect(first.effect, command).toBe("ask")
        yield* service.reply({ requestID: first.id, reply: "always" })
        const again = yield* ask(command)
        expect(again.effect, command).toBe("ask")
        yield* service.reply({ requestID: again.id, reply: "once" })
      }),
    )

  it.live("a command it cannot read is still denied by a deny it can see", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "allow" },
        { action: "shell", resource: "rm *", effect: "deny" },
      ])
      expect((yield* ask('rm x; bash -c "$X"')).effect).toBe("deny")
      expect((yield* ask('env rm x "$(bash -c "$X")"')).effect).toBe("deny")
    }),
  )

  it.live("unattended rules settle a command it cannot read", () =>
    Effect.gen(function* () {
      yield* setup([])
      const service = yield* Permission.Service
      const input = yield* request('bash -c "$X"')
      const result = yield* service.ask(input).pipe(
        Effect.provideService(
          Permission.Unattended,
          input.resources.map((resource) => ({ action: "shell", resource, effect: "allow" as const })),
        ),
      )
      expect(result.effect).toBe("allow")
    }),
  )

  it.live("reads what it can parse instead of asking", () =>
    Effect.gen(function* () {
      for (const command of [
        "bash -c 'rm x '",
        "bash script.sh",
        "timeout 5",
        "env -u X",
        "command -v rm",
        "xargs",
        "find . -name x",
        "env env env env env env env rm x",
      ])
        expect((yield* request(command)).opaque, command).toBeUndefined()
    }),
  )

  it.live("find saves every action exactly", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "shell", resource: "*", effect: "ask" }])
      const service = yield* Permission.Service
      for (const [command, save] of [
        ["find . -exec rm {} \\;", ["find . -exec rm {} \\;"]],
        ["find . -exec rm {} \\; -exec curl x \\;", ["find . -exec rm {} \\; -exec curl x \\;"]],
        ["find . -name x -exec rm {} + -delete", ["find . -name x -exec rm {} + -delete"]],
        ["find . -delete", ["find . -delete"]],
        ["find . -name x", ["find *"]],
        ["find . -name '*.log' -delete", undefined],
      ] as const)
        expect((yield* request(command)).save, command).toEqual(save && [...save])
      const first = yield* ask("find . -exec rm {} \\;")
      yield* service.reply({ requestID: first.id, reply: "always" })
      expect((yield* ask("find . -exec rm {} \\;")).effect).toBe("allow")
      for (const command of ["find . -exec rm {} \\; -exec curl x \\;", "find . -exec rm {} \\; -delete"]) {
        const result = yield* ask(command)
        expect(result.effect, command).toBe("ask")
        yield* service.reply({ requestID: result.id, reply: "once" })
      }
    }),
  )

  it.live("a wildcard in leading assignments or redirects offers no always", () =>
    Effect.gen(function* () {
      for (const command of ["FOO=* git status", "FOO=a? git status", ">out* printf hello"])
        expect((yield* request(command)).save, command).toBeUndefined()
      expect((yield* request("FOO=a git status")).save).toEqual(["FOO=a git status *"])
    }),
  )

  it.live("spacing outside quotes does not change what a saved approval matches", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "shell", resource: "*", effect: "ask" }])
      const service = yield* Permission.Service
      for (const [command, resources, save] of [
        ["timeout  10 git status", ["timeout 10 git status"], ["timeout 10 git status *"]],
        ["timeout\t10  git   status", ["timeout 10 git status"], ["timeout 10 git status *"]],
        ["FOO=bar  git status", ["FOO=bar git status"], ["FOO=bar git status *"]],
        ['echo "a  b"  c', ['echo "a  b" c'], ["echo *"]],
        ["echo 'a  b'", ["echo 'a  b'"], ["echo *"]],
        ["echo $(ls  -la)  x", ["echo $(ls  -la)  x", "ls -la"], ["echo *", "ls *"]],
      ] as const) {
        const input = yield* request(command)
        expect([input.resources, input.save], command).toEqual([[...resources], [...save]])
      }
      const first = yield* ask("timeout 10 git status")
      yield* service.reply({ requestID: first.id, reply: "always" })
      expect((yield* ask("timeout  10\tgit status")).effect).toBe("allow")
      const quoted = yield* ask("timeout 10 git status 'a  b'")
      expect(quoted.effect).toBe("allow")
    }),
  )
  describe("commands a wrapper hides", () => {
    for (const command of [
      "watch -x sh -c 'rm -rf x'",
      "watch --exec bash -c 'rm -rf x'",
      "watch -x rm -rf x",
      "strace --trace open rm -rf x",
      "strace --signal SIGINT --status failed rm -rf x",
      "strace --trace=open rm -rf x",
      "strace --inject open:error=ENOENT --detach-on execve rm -rf x",
      "ltrace --config f --where 3 rm -rf x",
      "bash -euo pipefail -c 'rm -rf x'",
      "bash -eo pipefail -c 'rm -rf x'",
      "sh -eo pipefail -c 'rm -rf x'",
      "zsh -o pipefail -c 'rm -rf x'",
      "bash -O extglob -c 'rm -rf x'",
      "env -S'rm -rf x'",
      "env -iS'rm -rf x'",
      "env -S 'rm -rf x'",
      "rm\t-rf\t$(pwd)",
      "rm 2>/dev/null -rf x",
    ])
      it.live(`a deny for the wrapped command applies to ${command}`, () =>
        Effect.gen(function* () {
          yield* setup([
            { action: "*", resource: "*", effect: "allow" },
            { action: "shell", resource: "rm -rf *", effect: "deny" },
          ])
          expect((yield* ask(command)).effect).toBe("deny")
        }),
      )

    for (const command of [
      "echo 'rm x' | xargs sh -c",
      "printf 'rm x' | xargs -I{} sh -c '{}'",
      "echo rm x | xargs env",
      "echo rm x | xargs sudo",
      "echo x | xargs timeout 5",
      "echo x | xargs bash",
      "echo x | xargs -I% % y",
      "find . -exec {} \\;",
      "find . -name x -exec sh -c {} \\;",
      "find . -exec sh -c 'echo {}' \\;",
      "sh -c",
      "bash /dev/stdin",
      "$CMD x",
      '"$BIN" x',
      "X=rm; $X -rf /",
    ])
      it.live(`cannot read ${command}`, () =>
        Effect.gen(function* () {
          const input = yield* request(command)
          expect(input.opaque, command).toBe(true)
          expect(input.save, command).toBeUndefined()
        }),
      )

    it.live("still reads commands whose input only adds arguments", () =>
      Effect.gen(function* () {
        for (const command of [
          "xargs rm",
          "xargs -I{} rm {}",
          "find . -exec rm {} \\;",
          "find . -exec env \\;",
          "bash script.sh",
          "echo x | xargs sh -c 'echo $1' _",
        ])
          expect((yield* request(command)).opaque, command).toBeUndefined()
      }),
    )

    it.live("a command it cannot read asks only when a rule could stop a hidden command", () =>
      Effect.gen(function* () {
        const service = yield* Permission.Service
        for (const [rules, effect] of [
          [[{ action: "*", resource: "*", effect: "allow" }], "allow"],
          [
            [
              { action: "*", resource: "*", effect: "deny" },
              { action: "shell", resource: "*", effect: "allow" },
            ],
            "allow",
          ],
          [
            [
              { action: "*", resource: "*", effect: "allow" },
              { action: "read", resource: "*.env", effect: "ask" },
            ],
            "allow",
          ],
          [
            [
              { action: "*", resource: "*", effect: "allow" },
              { action: "shell", resource: "git push *", effect: "deny" },
            ],
            "ask",
          ],
          [
            [
              { action: "shell", resource: "*", effect: "allow" },
              { action: "shell", resource: "git push *", effect: "ask" },
            ],
            "ask",
          ],
          [[{ action: "shell", resource: "*", effect: "ask" }], "ask"],
        ] satisfies Array<[Permission.Ruleset, "allow" | "ask"]>) {
          yield* setup(rules)
          const result = yield* ask('bash -c "$X"')
          expect(result.effect, JSON.stringify(rules)).toBe(effect)
          if (result.effect === "ask") yield* service.reply({ requestID: result.id, reply: "once" })
        }
      }),
    )

    it.live("offers no always when a saved prefix word holds a wildcard", () =>
      Effect.gen(function* () {
        for (const command of ["git '*'", "npm run '*'", "git s? x", "git 's*' x"])
          expect((yield* request(command)).save, command).toBeUndefined()
        expect((yield* request("git status 'a*'")).save).toEqual(["git status *"])
      }),
    )

    it.live("saves a shell running a script file with that file", () =>
      Effect.gen(function* () {
        yield* setup([{ action: "shell", resource: "*", effect: "ask" }])
        const service = yield* Permission.Service
        expect((yield* request("bash script.sh")).save).toEqual(["bash script.sh *"])
        expect((yield* request("bash -x script.sh a")).save).toEqual(["bash -x script.sh *"])
        const first = yield* ask("bash script.sh")
        yield* service.reply({ requestID: first.id, reply: "always" })
        expect((yield* ask("bash script.sh --flag")).effect).toBe("allow")
        for (const command of ["bash -c 'rm x'", "bash other.sh"]) {
          const result = yield* ask(command)
          expect(result.effect, command).toBe("ask")
          yield* service.reply({ requestID: result.id, reply: "once" })
        }
      }),
    )

    it.live("configured and saved rules match however they are spaced", () =>
      Effect.gen(function* () {
        yield* setup([
          { action: "*", resource: "*", effect: "allow" },
          { action: "shell", resource: "rm  -rf *", effect: "deny" },
          { action: "shell", resource: "git\tpush *", effect: "ask" },
        ])
        const service = yield* Permission.Service
        for (const command of ["rm -rf x", "rm  -rf x", "timeout 5 rm -rf x"])
          expect((yield* ask(command)).effect, command).toBe("deny")
        const push = yield* ask("git push")
        expect(push.effect).toBe("ask")
        yield* service.reply({ requestID: push.id, reply: "once" })

        yield* setRules([{ action: "shell", resource: "*", effect: "ask" }])
        const saved = yield* PermissionSaved.Service
        yield* saved.add({ projectID: Project.ID.global, action: "shell", resources: ["timeout  10 git status *"] })
        expect((yield* ask("timeout 10 git status")).effect).toBe("allow")
        // A rule written with spacing inside quotes keeps it.
        yield* setRules([
          { action: "*", resource: "*", effect: "allow" },
          { action: "shell", resource: "echo 'a  b'", effect: "deny" },
        ])
        expect((yield* ask("echo 'a  b'")).effect).toBe("deny")
        expect((yield* ask("echo 'a b'")).effect).toBe("allow")
      }),
    )
    for (const command of [
      "bash -co pipefail 'rm -rf x'",
      "bash +o pipefail -c 'rm -rf x'",
      "bash -c -o pipefail 'rm -rf x'",
      "bash --norc -c 'rm -rf x'",
      "env -S'-i rm -rf x'",
      "env -S '-u X rm -rf x'",
      "env -vS'rm -rf x'",
      "env -uS'rm -rf x' rm -rf y",
      "env -C/tmp -S'rm -rf x'",
      "env --split-string='rm -rf x'",
      "env --split-str='-i rm -rf x'",
      "watch -n 1 -x rm -rf x",
      "watch -xn1 rm -rf x",
      "timeout --sig KILL 5 rm -rf x",
      "timeout --kill 3 5 rm -rf x",
      "strace --const-print-style raw rm -rf x",
      "strace --summary-columns time rm -rf x",
      "strace --syscall-limit 5 rm -rf x",
      "strace --str 5 rm -rf x",
      "nice --adj 5 rm -rf x",
      "sudo --us root rm -rf x",
      "firejail --net none rm -rf x",
      "/usr/bin/rm -rf x",
      "./rm -rf x",
      "env /bin/rm -rf x",
      "\\rm -rf x",
      "rm\t-rf\tx",
      "FOO=1\trm\t-rf\t$(pwd)",
      "rm  -rf  `pwd`",
    ])
      it.live(`a deny holds through ${command}`, () =>
        Effect.gen(function* () {
          yield* setup([
            { action: "*", resource: "*", effect: "allow" },
            { action: "shell", resource: "rm -rf *", effect: "deny" },
          ])
          expect((yield* ask(command)).effect).toBe("deny")
        }),
      )

    for (const command of [
      "echo x | xargs -0I{} sh -c '{}'",
      "echo x | xargs -rI{} {} y",
      "echo x | xargs -0i sh -c '{}'",
      "echo x | xargs --replace sh -c '{}'",
      "echo x | xargs --rep=% sh -c '%'",
      "echo x | xargs flock /tmp/l -c",
      "echo x | xargs su -c",
      "echo x | xargs env -S",
      "find . -exec su -c {} \\;",
      "bash -o",
      "bash $F",
      "echo 'rm -rf x' | bash /dev/./stdin",
      "echo 'rm -rf x' | bash /proc/thread-self/fd/0",
      "echo 'rm -rf x' | bash //dev/stdin",
      "echo 'rm -rf x' | bash /proc/$$/fd/0",
      "bash <(echo rm -rf x)",
      "/bin/r? -rf x",
      "/bin/r[m] -rf x",
      "/bin/r* -rf x",
      "r{m,} -rf x",
      "${X} -rf x",
      "`echo rm` -rf x",
    ])
      it.live(`cannot read, so a deny rule makes it ask: ${command}`, () =>
        Effect.gen(function* () {
          yield* setup([
            { action: "*", resource: "*", effect: "allow" },
            { action: "shell", resource: "rm -rf *", effect: "deny" },
          ])
          const service = yield* Permission.Service
          expect((yield* request(command)).opaque, command).toBe(true)
          const result = yield* ask(command)
          expect(result.effect, command).not.toBe("allow")
          if (result.effect === "ask") yield* service.reply({ requestID: result.id, reply: "once" })
        }),
      )

    it.live("reads plain forms the new checks leave alone", () =>
      Effect.gen(function* () {
        for (const command of [
          "echo x | xargs bash script.sh",
          "[ -f x ] && echo y",
          "echo x | xargs -0 -r rm",
          "bash script.sh",
          "timeout --foreground 5 make",
        ])
          expect((yield* request(command)).opaque, command).toBeUndefined()
        expect((yield* request("/usr/bin/git status")).guards).toEqual(["git status"])
      }),
    )

    it.live("spacing after a PowerShell stop-parsing token or with curly quotes is kept", () =>
      Effect.gen(function* () {
        expect(ShellSpacing.collapse("icacls x  --%  /grant  a")).toBe("icacls x  --%  /grant  a")
        expect(ShellSpacing.collapse("echo “a  b”  ‘c  d’  e")).toBe("echo “a  b”  ‘c  d’  e")
        expect(ShellSpacing.collapse("echo  a")).toBe("echo a")
      }),
    )
    for (const command of [
      "strace --decode-pids comm rm -rf x",
      "xargs --max-lines rm -rf x",
      "env --a1 --a2 --a3 --a4 --a5 --a6 --a7 --a8 --a9 --a10 --a11 --a12 --a13 --a14 --a15 --a16 --a17 --a18 --a19 --a20 --a21 --a22 --a23 --a24 --a25 --a26 --a27 --a28 --a29 --a30 --a31 --a32 --a33 --a34 --a35 --a36 --a37 --a38 --a39 --a40 rm -rf x",
      "env -S'rm -rf x'",
    ])
      it.live(`a deny still holds through ${command.slice(0, 60)}`, () =>
        Effect.gen(function* () {
          yield* setup([
            { action: "*", resource: "*", effect: "allow" },
            { action: "shell", resource: "rm -rf *", effect: "deny" },
          ])
          expect((yield* ask(command)).effect).toBe("deny")
        }),
      )

    for (const command of [
      `env -S'r"m" -rf x'`,
      `env -S'rm "-rf" x'`,
      "env -S'rm\\_-rf\\_x'",
      "echo x | xargs --r sh -c '{}'",
      "echo x | xargs --r=% sh -c '%'",
      "echo x | xargs -I X -i sh -c '{}'",
      "echo x | xargs -I X -I Y sh -c Y",
      "bash /dev/std[i]n",
      "bash /dev/stdi?",
      "bash /proc/self/task/*/fd/0",
      "bash /proc/1/task/1/fd/0",
      "sh ~/../../dev/stdin",
      "/bin/r[]m] -rf x",
      "timeout 5 /bin/r[]m] -rf x",
    ])
      it.live(`cannot read, so a deny rule makes it ask: ${command}`, () =>
        Effect.gen(function* () {
          yield* setup([
            { action: "*", resource: "*", effect: "allow" },
            { action: "shell", resource: "rm -rf *", effect: "deny" },
          ])
          const service = yield* Permission.Service
          expect((yield* request(command)).opaque, command).toBe(true)
          const result = yield* ask(command)
          expect(result.effect, command).not.toBe("allow")
          if (result.effect === "ask") yield* service.reply({ requestID: result.id, reply: "once" })
        }),
      )

    it.live("zsh path expansion and glob qualifiers in a command name cannot be read", () =>
      Effect.gen(function* () {
        for (const command of ["=rm -rf x", "/bin/rm(N) -rf x", "timeout 5 =rm -rf x"])
          expect((yield* ShellParse.scan(command, "zsh", "/project")).opaque, command).toBe(true)
        expect((yield* ShellParse.scan("[ -f x ] && [[ -d y ]]", "bash", "/project")).opaque).toBeUndefined()
        expect((yield* ShellParse.scan("[ -f x ] && [[ -d y ]]", "zsh", "/project")).opaque).toBeUndefined()
      }),
    )

    it.live("keeps the exact spacing of any text with curly quotes", () =>
      Effect.gen(function* () {
        expect(ShellSpacing.collapse("echo ‘x'a  b'")).toBe("echo ‘x'a  b'")
        expect(ShellSpacing.collapse("echo “a  b”  c")).toBe("echo “a  b”  c")
      }),
    )
    for (const command of [
      "env -S$'rm\\v-rf\\vx'",
      "env -S$'rm\\f-rf\\fx'",
      "env -S$'rm\\r-rf\\rx'",
      "echo 'rm -rf x' | xargs -I Q -L 1 env",
      "echo 'rm -rf x' | xargs -I Q -L1 env",
      "echo 'rm -rf x' | xargs -IQ --max-lines=1 env",
      "echo 'rm -rf x' | xargs -i -l env",
      "echo 'rm -rf x' | xargs --r -L1 env",
      "echo 'rm -rf x' | xargs -L 1 -I Q sh -c Q",
      "echo 'rm -rf x' | xargs -I Q -n 1 sh -c Q",
      "echo x | xargs -I Q --max-lines env",
    ])
      it.live(`cannot read, so a deny rule makes it ask: ${command}`, () =>
        Effect.gen(function* () {
          yield* setup([
            { action: "*", resource: "*", effect: "allow" },
            { action: "shell", resource: "rm -rf *", effect: "deny" },
          ])
          const service = yield* Permission.Service
          expect((yield* request(command)).opaque, command).toBe(true)
          const result = yield* ask(command)
          expect(result.effect, command).not.toBe("allow")
          if (result.effect === "ask") yield* service.reply({ requestID: result.id, reply: "once" })
        }),
      )

    it.live("a replace option given after a max-lines option still replaces", () =>
      Effect.gen(function* () {
        for (const command of ["echo x | xargs -L 1 -I Q env", "echo x | xargs -I Q -n 1 env"])
          expect((yield* request(command)).opaque, command).toBeUndefined()
      }),
    )
  })
})
