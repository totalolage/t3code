import {
  AuthSessionId,
  CommandId,
  MessageId,
  OrchestrationCliCreateRequest,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type VcsListRefsResult,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import {
  HttpCreatePlanError,
  getHttpCreateIdentity,
  getHttpCreateSemanticHash,
  makeHttpCreatePlanResolver,
} from "./httpCreatePlan.ts";

const NOW = "2026-09-12T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const workspaceRoot = "/workspace/project-one";
const requestSchema = Schema.decodeUnknownSync(OrchestrationCliCreateRequest);
const rowSchema = Schema.decodeUnknownSync(ProjectStore.ProjectRow);
const isHttpCreatePlanError = Schema.is(HttpCreatePlanError);
const identity = getHttpCreateIdentity(AuthSessionId.make("session-1"), " key-1 ");

const makeRequest = (overrides: Record<string, unknown> = {}) =>
  requestSchema({
    project: "Project One",
    message: "Create the requested thread",
    idempotencyKey: "key-1",
    ...overrides,
  });

const makeProject = (overrides: Record<string, unknown> = {}) =>
  rowSchema({
    projectId,
    title: "Project One",
    workspaceRoot,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  });

const defaultListRefs: VcsListRefsResult = {
  refs: [{ name: "main", current: true, isDefault: true, isRemote: false, worktreePath: null }],
  isRepo: true,
  hasPrimaryRemote: false,
  nextCursor: null,
  totalCount: 1,
};

const defaultLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: true,
  refName: "main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

type Dependencies = Parameters<typeof makeHttpCreatePlanResolver>[0];
type ListRefsInput = Parameters<Dependencies["gitWorkflow"]["listRefs"]>[0];

const makeDependencies = (
  projects: ReadonlyArray<ProjectStore.ProjectRow>,
  overrides: {
    readonly listRefs?: Dependencies["gitWorkflow"]["listRefs"];
    readonly localStatus?: Dependencies["gitWorkflow"]["localStatus"];
  } = {},
): Dependencies => ({
  projectStore: { list: () => Effect.succeed(projects) },
  gitWorkflow: {
    listRefs: overrides.listRefs ?? (() => Effect.succeed(defaultListRefs)),
    localStatus: overrides.localStatus ?? (() => Effect.succeed(defaultLocalStatus)),
  } as Pick<GitWorkflowService.GitWorkflowService["Service"], "listRefs" | "localStatus">,
});

const assertPlanError = (exit: Exit.Exit<unknown, unknown>): HttpCreatePlanError => {
  assert.isTrue(Exit.isFailure(exit));
  if (Exit.isFailure(exit)) {
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    if (isHttpCreatePlanError(error)) return error;
  }
  throw new Error("Expected HttpCreatePlanError");
};

it("binds a create key to its authenticated session and normalized semantic payload", () => {
  const first = makeRequest({ project: projectId, title: " A title " });
  const reordered = requestSchema({
    idempotencyKey: "another-key",
    title: " A title ",
    message: "Create the requested thread",
    project: projectId,
  });
  assert.notEqual(
    identity.keyHash,
    getHttpCreateIdentity(AuthSessionId.make("session-2"), "key-1").keyHash,
  );
  assert.equal(
    identity.keyHash,
    getHttpCreateIdentity(AuthSessionId.make("session-1"), "key-1").keyHash,
  );
  assert.equal(getHttpCreateSemanticHash(first), getHttpCreateSemanticHash(reordered));
  assert.notEqual(
    getHttpCreateSemanticHash(first),
    getHttpCreateSemanticHash(makeRequest({ message: "Changed content" })),
  );
  assert.equal(
    getHttpCreateSemanticHash(makeRequest()),
    getHttpCreateSemanticHash(
      makeRequest({
        startFromOrigin: true,
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    ),
  );
});

it.effect("resolves one active project by id, title, or exact workspace root", () =>
  Effect.gen(function* () {
    const project = makeProject();
    const resolver = makeHttpCreatePlanResolver(makeDependencies([project]));
    for (const selector of [project.projectId, project.title, project.workspaceRoot]) {
      const plan = yield* resolver.resolve(makeRequest({ project: selector }), identity);
      assert.equal(plan.projectId, project.projectId);
    }
  }),
);

it.effect("rejects missing, deleted, and ambiguous active project matches", () =>
  Effect.gen(function* () {
    const missing = makeHttpCreatePlanResolver(makeDependencies([makeProject()]));
    assert.isTrue(
      assertPlanError(
        yield* missing.resolve(makeRequest({ project: "missing" }), identity).pipe(Effect.exit),
      ).message.includes("No active project"),
    );

    const deleted = makeHttpCreatePlanResolver(makeDependencies([makeProject({ deletedAt: NOW })]));
    assert.isTrue(
      assertPlanError(
        yield* deleted.resolve(makeRequest(), identity).pipe(Effect.exit),
      ).message.includes("No active project"),
    );

    const ambiguous = makeHttpCreatePlanResolver(
      makeDependencies([
        makeProject({ title: "Shared title" }),
        makeProject({
          projectId: ProjectId.make("project-2"),
          title: "Shared title",
          workspaceRoot: "/workspace/project-two",
        }),
      ]),
    );
    assert.isTrue(
      assertPlanError(
        yield* ambiguous
          .resolve(makeRequest({ project: "Shared title" }), identity)
          .pipe(Effect.exit),
      ).message.includes("Multiple active projects"),
    );
  }),
);

it.effect("freezes project defaults and derives a stable worktree launch plan", () =>
  Effect.gen(function* () {
    const request = makeRequest({
      message: "  first line title  \nsecond line",
      startFromOrigin: false,
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
    });
    const original = structuredClone(request);
    const project = makeProject({
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("custom"),
        model: "custom-model",
      },
    });
    const resolver = makeHttpCreatePlanResolver(makeDependencies([project]));
    const plan = yield* resolver.resolve(request, identity);

    assert.deepEqual(request, original);
    assert.equal(plan.commandId, identity.commandId);
    assert.equal(plan.threadId, identity.threadId);
    assert.equal(plan.messageId, identity.messageId);
    assert.deepEqual(plan.modelSelection, project.defaultModelSelection);
    assert.equal(plan.title, "first line title");
    assert.equal(plan.runtimeMode, "auto-accept-edits");
    assert.equal(plan.interactionMode, "plan");
    assert.deepEqual(plan.workspaceStrategy, {
      type: "worktree",
      baseRef: "main",
      branch: `t3/${identity.keyHash.slice(0, 12)}`,
      startFromOrigin: false,
      runSetupScript: false,
    });
    assert.deepEqual(plan.initialMessage, {
      messageId: identity.messageId,
      text: "first line title  \nsecond line",
      attachments: [],
    });
  }),
);

it.effect("enables HTTP create setup only for a configured worktree script", () =>
  Effect.gen(function* () {
    const configured = makeProject({
      scripts: [
        {
          id: "install",
          name: "Install",
          command: "pnpm install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ],
    });
    const resolver = makeHttpCreatePlanResolver(makeDependencies([configured]));
    const plan = yield* resolver.resolve(makeRequest(), identity);
    assert.equal(plan.workspaceStrategy.type, "worktree");
    if (plan.workspaceStrategy.type === "worktree") {
      assert.equal(plan.workspaceStrategy.runSetupScript, true);
    }
  }),
);

it.effect("uses explicit base branches without Git lookup and paginates default refs", () =>
  Effect.gen(function* () {
    let gitCalls = 0;
    const noGit = makeHttpCreatePlanResolver(
      makeDependencies([makeProject()], {
        listRefs: () => {
          gitCalls += 1;
          return Effect.die("explicit branch should avoid Git lookup");
        },
        localStatus: () => {
          gitCalls += 1;
          return Effect.die("explicit branch should avoid Git lookup");
        },
      }),
    );
    const explicit = yield* noGit.resolve(makeRequest({ baseBranch: "release" }), identity);
    assert.equal(explicit.workspaceStrategy.type, "worktree");
    if (explicit.workspaceStrategy.type === "worktree")
      assert.equal(explicit.workspaceStrategy.baseRef, "release");
    assert.equal(gitCalls, 0);

    const listInputs: Array<ListRefsInput> = [];
    const paginated = makeHttpCreatePlanResolver(
      makeDependencies([makeProject()], {
        listRefs: (input) => {
          listInputs.push(input);
          return Effect.succeed(
            input.cursor === undefined
              ? {
                  ...defaultListRefs,
                  refs: [
                    {
                      name: "feature/current",
                      current: true,
                      isDefault: false,
                      isRemote: false,
                      worktreePath: null,
                    },
                  ],
                  nextCursor: 1,
                  totalCount: 2,
                }
              : defaultListRefs,
          );
        },
      }),
    );
    const plan = yield* paginated.resolve(makeRequest(), identity);
    assert.equal(plan.workspaceStrategy.type, "worktree");
    if (plan.workspaceStrategy.type === "worktree")
      assert.equal(plan.workspaceStrategy.baseRef, "main");
    assert.deepEqual(listInputs, [
      { cwd: workspaceRoot, refKind: "local", limit: 200 },
      { cwd: workspaceRoot, refKind: "local", limit: 200, cursor: 1 },
    ]);
  }),
);

it.effect("rejects repositories without a usable local default branch", () =>
  Effect.gen(function* () {
    const noBranch = makeHttpCreatePlanResolver(
      makeDependencies([makeProject()], {
        listRefs: () => Effect.succeed({ ...defaultListRefs, refs: [] }),
        localStatus: () => Effect.succeed({ ...defaultLocalStatus, refName: null }),
      }),
    );
    assert.isTrue(
      assertPlanError(
        yield* noBranch.resolve(makeRequest(), identity).pipe(Effect.exit),
      ).message.includes("no usable local branch"),
    );
  }),
);

it("derives stable command, thread, and message identities from the scoped key", () => {
  assert.equal(identity.commandId, CommandId.make(`cli-create:${identity.keyHash}`));
  assert.equal(identity.threadId, ThreadId.make(`cli-thread:${identity.keyHash}`));
  assert.equal(identity.messageId, MessageId.make(`cli-create:${identity.keyHash}`));
});
