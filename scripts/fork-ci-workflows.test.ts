// @effect-diagnostics nodeBuiltinImport:off - Executes workflow expressions and shell fixtures with Node APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";
const Permissions = Schema.Record(Schema.String, Schema.Literals(["read", "write", "none"]));
const TriggerWithBranches = Schema.Union([
  Schema.Null,
  Schema.Struct({ branches: Schema.optionalKey(Schema.Array(Schema.String)) }),
]);
const TriggerWithInputs = Schema.Union([
  Schema.Null,
  Schema.Struct({ inputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }),
]);
// prettier-ignore
const Triggers = Schema.Struct({ pull_request: Schema.optionalKey(Schema.Unknown), pull_request_target: Schema.optionalKey(Schema.Unknown), push: Schema.optionalKey(TriggerWithBranches), workflow_dispatch: Schema.optionalKey(TriggerWithInputs), schedule: Schema.optionalKey(Schema.Unknown), issues: Schema.optionalKey(Schema.Unknown), discussion: Schema.optionalKey(Schema.Unknown), workflow_run: Schema.optionalKey(Schema.Unknown) });
const Scalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);
const ActionInputs = Schema.Record(Schema.String, Scalar);
const StepSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(ActionInputs),
  "continue-on-error": Schema.optionalKey(Schema.Boolean),
});
const StrategySchema = Schema.Struct({
  "fail-fast": Schema.optionalKey(Schema.Boolean),
  matrix: Schema.optionalKey(
    Schema.Struct({ shard: Schema.optionalKey(Schema.Array(Schema.Finite)) }),
  ),
});
const NeedsSchema = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const JobSchema = Schema.Struct({
  if: Schema.optionalKey(Schema.String),
  "runs-on": Schema.optionalKey(Schema.String),
  needs: Schema.optionalKey(NeedsSchema),
  permissions: Schema.optionalKey(Permissions),
  strategy: Schema.optionalKey(StrategySchema),
  with: Schema.optionalKey(ActionInputs),
  steps: Schema.optionalKey(Schema.Array(StepSchema)),
});
const WorkflowSchema = Schema.Struct({
  on: Triggers,
  permissions: Schema.optionalKey(Permissions),
  jobs: Schema.Record(Schema.String, JobSchema),
});
type Workflow = Schema.Schema.Type<typeof WorkflowSchema>;
type Job = Schema.Schema.Type<typeof JobSchema>;
type Step = Schema.Schema.Type<typeof StepSchema>;
type Need = {
  readonly result: "success" | "failure" | "cancelled" | "skipped";
  readonly outputs: Readonly<Record<string, string>>;
};
type FixtureOptions = {
  readonly repository?: string;
  readonly eventName?: string;
  readonly action?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly labelName?: string;
  readonly headRepository?: string;
  readonly ref?: string;
  readonly workflowRunEvent?: string;
  readonly workflowRunConclusion?: string;
  readonly needs?: Readonly<Record<string, Need>>;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly cancelled?: boolean;
  readonly failure?: boolean;
};
const decodeWorkflow = Schema.decodeUnknownSync(fromYaml(WorkflowSchema));
const decodeExpressionResult = Schema.decodeUnknownSync(
  Schema.Union([Schema.Boolean, Schema.String]),
);
const workflowsDirectory = NodePath.resolve(import.meta.dirname, "../.github/workflows");
const canonical = "pingdotgg/t3code";
const fork = "f8y/t3code";
const other = "pingdotgg/t3code-copy";
const ciRequiredJobs = [
  "lint",
  "typecheck",
  "build",
  "test",
  "test_web",
  "test_server",
  "transfer-report",
  "rust",
  "mobile_native_changes",
  "mobile_native_static_analysis",
  "release_smoke",
  "standalone-smoke",
  "check",
];
const ciTestCommand =
  "vp run --parallel --concurrency-limit 4 --filter '!t3' --filter '!@t3tools/monorepo' --filter '!@t3tools/web' test";
const releaseNeedCases = [
  ["preflight", "resolve_commit"],
  ["relay_public_config", "resolve_commit"],
  ["quality", "preflight"],
  ["test", "preflight"],
  ["test_server", "preflight"],
  ["build_bundle", "preflight"],
  ["desktop_mac_arm64", "build_bundle"],
  ["publish_cli", "quality"],
  ["release", "publish_cli"],
  ["publish_aur", "release"],
  ["build_web", "relay_public_config"],
  ["deploy_web", "release"],
  ["build_marketing", "preflight"],
  ["deploy_marketing", "release"],
  ["finalize", "release"],
  ["announce_discord", "release"],
] as const;
const releaseCanonicalJobs = [
  "relay_public_config",
  "desktop_mac_arm64",
  "desktop_mac_x64",
  "desktop_linux_x64",
  "desktop_linux_arm64",
  "desktop_win_x64",
  "desktop_win_arm64",
  "publish_cli",
  "release",
  "publish_aur",
  "build_web",
  "deploy_web",
  "build_marketing",
  "deploy_marketing",
  "finalize",
  "announce_discord",
];
const canonicalOnlyJobCases = [
  ["deploy-relay.yml", ["deploy_relay"]],
  ["mobile-eas-preview.yml", ["preview"]],
  ["mobile-eas-production.yml", ["production"]],
  ["web-preview.yml", ["deploy"]],
  ["cursor-hygiene-webhook.yml", ["forward"]],
] as const;
const electronCommand = "vp run --filter @t3tools/desktop ensure:electron";
const testCommand =
  "vp run --parallel --concurrency-limit 4 --filter '!t3' --filter '!@t3tools/monorepo' test";
const serverTestCommand =
  "vp run --filter t3 test --shard ${{ matrix.shard }}/${{ strategy.job-total }}";
const windowsElectronCommand = 'vp run --filter "@t3tools/desktop" ensure:electron';
const iosToolchainRun = `sudo xcode-select --switch /Applications/Xcode_26.2.app/Contents/Developer
test "$(xcrun --sdk iphonesimulator --show-sdk-version)" = "26.2"
xcrun simctl list runtimes --json | jq -e '.runtimes | any(.isAvailable and .identifier == "com.apple.CoreSimulator.SimRuntime.iOS-26-2")'`;
// prettier-ignore
const staticCases = [["true", false, true], ["false", false, false], ["", false, true], ["true", true, false]] as const;
// prettier-ignore
const showcaseCases = [["ios", "all", true], ["ios", "android", false], ["android", "all", true], ["android", "ios", false]] as const;
const ownedWorkflowFiles = [
  "ci.yml",
  "cursor-hygiene-webhook.yml",
  "deploy-relay.yml",
  "desktop-macos-preview.yml",
  "desktop-macos-preview-publish.yml",
  "mobile-eas-preview.yml",
  "mobile-eas-production.yml",
  "mobile-fingerprint-check.yml",
  "mobile-showcase-screenshots.yml",
  "release.yml",
  "web-preview.yml",
  "windows-tests.yml",
];
const runnerCases = [
  ["ci.yml", "lint", "blacksmith-8vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["ci.yml", "typecheck", "blacksmith-8vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["ci.yml", "build", "blacksmith-8vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["ci.yml", "test", "blacksmith-8vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["ci.yml", "test_web", "blacksmith-8vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["ci.yml", "test_server", "blacksmith-4vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["ci.yml", "rust", "blacksmith-4vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["ci.yml", "mobile_native_changes", "blacksmith-2vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["ci.yml", "mobile_native_static_analysis", "blacksmith-6vcpu-macos-26", "macos-15"],
  ["ci.yml", "release_smoke", "blacksmith-8vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["ci.yml", "check", "blacksmith-2vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["release.yml", "resolve_commit", "blacksmith-8vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["release.yml", "preflight", "blacksmith-8vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["release.yml", "quality", "blacksmith-8vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["release.yml", "test", "blacksmith-8vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["release.yml", "test_server", "blacksmith-8vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["release.yml", "build_bundle", "blacksmith-32vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["windows-tests.yml", "test", "blacksmith-8vcpu-windows-2025", "windows-2025"],
  ["mobile-fingerprint-check.yml", "fingerprint", "blacksmith-8vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["mobile-showcase-screenshots.yml", "ios", "blacksmith-12vcpu-macos-26", "macos-15"],
  ["mobile-showcase-screenshots.yml", "android", "blacksmith-16vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["desktop-macos-preview.yml", "build", "blacksmith-32vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["desktop-macos-preview-publish.yml", "publish", "blacksmith-8vcpu-ubuntu-2404", "ubuntu-24.04"],
] as const;
function loadWorkflow(fileName: string): Workflow {
  return decodeWorkflow(NodeFS.readFileSync(NodePath.join(workflowsDirectory, fileName), "utf8"));
}
function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
function requiredJob(workflow: Workflow, jobId: string): Job {
  return required(workflow.jobs[jobId], `Missing job '${jobId}'.`);
}
function requiredStep(job: Job, stepName: string): Step {
  return required(
    job.steps?.find((step) => step.name === stepName),
    `Missing step '${stepName}'.`,
  );
}
function requiredActionStep(job: Job, action: string): Step {
  const matches = job.steps?.filter((step) => step.uses === action) ?? [];
  return required(matches.length === 1 ? matches[0] : undefined, `Expected one '${action}' step.`);
}
function requiredString(value: string | undefined, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}
function jobString(workflow: Workflow, jobId: string, field: "if" | "runs-on"): string {
  return requiredString(requiredJob(workflow, jobId)[field], `Missing ${field} for '${jobId}'.`);
}
function stepRun(job: Job, stepName: string): string {
  return requiredString(requiredStep(job, stepName).run, `Missing run for '${stepName}'.`);
}
function makeFixture(options: FixtureOptions = {}) {
  const repository = options.repository ?? canonical;
  const labels = (
    options.labels ?? ["preview:web", "preview:mac", "🚀 Mobile Continuous Deployment"]
  ).map((name) => ({ name }));
  const event = {
    action: options.action ?? "synchronize",
    ...(options.labelName === undefined ? {} : { label: { name: options.labelName } }),
    workflow_run: {
      event: options.workflowRunEvent ?? "pull_request",
      conclusion: options.workflowRunConclusion ?? "success",
    },
    pull_request: {
      labels,
      head: { repo: { full_name: options.headRepository ?? repository } },
    },
  };
  return {
    github: {
      repository,
      ref: options.ref ?? "refs/tags/v1.2.3",
      event_name: options.eventName ?? "pull_request",
      event,
    },
    needs: options.needs ?? {},
    inputs: options.inputs ?? {},
    cancelled: options.cancelled ?? false,
    failure: options.failure ?? false,
  };
}
type Fixture = ReturnType<typeof makeFixture>;
function releaseNeeds(channel: string): Readonly<Record<string, Need>> {
  const success = { result: "success" as const, outputs: {} };
  return {
    resolve_commit: { ...success, outputs: { has_changes: "true", ref: "sha" } },
    preflight: { ...success, outputs: { release_channel: channel } },
    relay_public_config: success,
    quality: success,
    test: success,
    test_server: success,
    build_bundle: success,
    desktop_mac_arm64: success,
    desktop_mac_x64: success,
    desktop_linux_x64: success,
    desktop_linux_arm64: success,
    desktop_win_x64: success,
    desktop_win_arm64: success,
    publish_cli: success,
    release: success,
    build_web: success,
    deploy_web: success,
    build_marketing: success,
    deploy_marketing: success,
    finalize: { result: "skipped", outputs: {} },
  };
}
function releaseHappyFixture(jobId: string, options: FixtureOptions = {}) {
  const channel =
    jobId === "build_marketing" || jobId === "deploy_marketing" ? "nightly" : "stable";
  return makeFixture({
    eventName: "push",
    ...options,
    needs: options.needs ?? releaseNeeds(channel),
  });
}
function canonicalHappyFixture(fileName: string, jobId: string, options: FixtureOptions = {}) {
  switch (fileName) {
    case "release.yml":
      return releaseHappyFixture(jobId, options);
    case "deploy-relay.yml":
      return makeFixture({ eventName: "push", ref: "refs/heads/main", ...options });
    case "mobile-eas-production.yml":
    case "cursor-hygiene-webhook.yml":
      return makeFixture({ eventName: "push", ...options });
    case "mobile-eas-preview.yml":
      return makeFixture({ labels: ["🚀 Mobile Continuous Deployment"], ...options });
    case "web-preview.yml":
      return makeFixture({ labels: ["preview:web"], ...options });
    default:
      throw new Error(`No happy-path fixture for '${fileName}' job '${jobId}'.`);
  }
}
function expressionSource(expression: string): string {
  let source = expression.trim();
  if (source.startsWith("${{") && source.endsWith("}}")) source = source.slice(3, -2).trim();
  return source.replace(
    "github.event.pull_request.labels.*.name",
    "github.event.pull_request.labels.map((label) => label.name)",
  );
}
function evaluateExpression(expression: string, fixture: Fixture) {
  const source = expressionSource(expression);
  if (/^[A-Za-z0-9_.-]+$/.test(source)) return source;
  const result: unknown = NodeVM.runInNewContext(source, {
    github: fixture.github,
    needs: fixture.needs,
    inputs: fixture.inputs,
    always: () => true,
    cancelled: () => fixture.cancelled,
    failure: () => fixture.failure,
    contains: (values: ReadonlyArray<string> | string, value: string) => values.includes(value),
  });
  return decodeExpressionResult(result);
}
const assertExpression = (expression: string, fixture: Fixture, expected: boolean | string) =>
  assert.equal(evaluateExpression(expression, fixture), expected);
const assertJobExpression = (
  workflow: Workflow,
  jobId: string,
  fixture: Fixture,
  expected: boolean,
) => assertExpression(jobString(workflow, jobId, "if"), fixture, expected);
const assertRunner = (workflow: Workflow, jobId: string, repository: string, expected: string) =>
  assertExpression(jobString(workflow, jobId, "runs-on"), makeFixture({ repository }), expected);
const assertRunnerCases = (
  workflow: Workflow,
  jobId: string,
  canonicalRunner: string,
  fallbackRunner: string,
) => {
  for (const repository of [canonical, fork, other])
    assertRunner(
      workflow,
      jobId,
      repository,
      repository === canonical ? canonicalRunner : fallbackRunner,
    );
};
const assertRun = (job: Job, stepName: string, expected: string) =>
  assert.equal(stepRun(job, stepName).trim(), expected);
// prettier-ignore
const staticFixture = (changed: string, cancelled: boolean) => makeFixture({ cancelled, needs: { mobile_native_changes: { result: "success", outputs: { changed } } } });
const assertCanonicalJob = (
  workflow: Workflow,
  fileName: string,
  jobId: string,
  repository: string,
): void =>
  assertJobExpression(
    workflow,
    jobId,
    canonicalHappyFixture(fileName, jobId, { repository }),
    repository === canonical,
  );
function releaseNeedFixture(jobId: string, needId: string, result: "failure" | "cancelled") {
  const needs = releaseNeeds(
    jobId === "build_marketing" || jobId === "deploy_marketing" ? "nightly" : "stable",
  );
  const need = needs[needId];
  if (need === undefined) throw new Error(`Release fixture is missing need '${needId}'.`);
  return releaseHappyFixture(jobId, { needs: { ...needs, [needId]: { ...need, result } } });
}
function scheduleFixture() {
  const needs = releaseNeeds("nightly");
  return makeFixture({
    eventName: "schedule",
    needs: {
      ...needs,
      resolve_commit: { result: "success", outputs: { has_changes: "false" } },
      preflight: { result: "skipped", outputs: { release_channel: "nightly" } },
      relay_public_config: { result: "skipped", outputs: {} },
    },
  });
}
const labelFixture = (label: string, action: string, labelName?: string, headRepository?: string) =>
  makeFixture({
    labels: label ? [label] : [],
    action,
    ...(labelName ? { labelName } : {}),
    ...(headRepository ? { headRepository } : {}),
  });
describe("fork-safe CI workflow regressions", () => {
  it("parses every current workflow in the fork-safe CI surface", () => {
    for (const fileName of ownedWorkflowFiles) loadWorkflow(fileName);
  });
  it("keeps CI's split jobs connected to the required Check result", () => {
    const ci = loadWorkflow("ci.yml");
    assert.deepStrictEqual(Object.keys(ci.on).sort(), ["pull_request", "push"]);
    assert.isNull(ci.on.pull_request);
    assert.deepStrictEqual(ci.on.push?.branches, ["main"]);
    assert.deepStrictEqual(ci.permissions, { contents: "read" });
    const jobs = Object.keys(ci.jobs);
    for (const jobId of ciRequiredJobs) assert.include(jobs, jobId);
    const check = requiredJob(ci, "check");
    const checkNeeds = required(check.needs, "Check must depend on every validation job.");
    if (!Array.isArray(checkNeeds)) throw new Error("Check needs must list its validation jobs.");
    assert.deepStrictEqual(
      [...checkNeeds].sort(),
      jobs.filter((jobId) => jobId !== "check").sort(),
    );
    assert.equal(evaluateExpression(jobString(ci, "check", "if"), makeFixture()), true);
    for (const [jobId, job] of Object.entries(ci.jobs)) {
      for (const permission of Object.values(job.permissions ?? {}))
        assert.equal(permission, "read");
      if (jobId !== "mobile_native_static_analysis" && jobId !== "check")
        assert.isUndefined(job.if);
    }
    const expression = jobString(ci, "mobile_native_static_analysis", "if");
    for (const [changed, cancelled, expected] of staticCases)
      assertExpression(expression, staticFixture(changed, cancelled), expected);
  });
  it("keeps the CI split commands, server shards, and shared setup", () => {
    const ci = loadWorkflow("ci.yml");
    const lint = requiredJob(ci, "lint");
    const typecheck = requiredJob(ci, "typecheck");
    const build = requiredJob(ci, "build");
    const test = requiredJob(ci, "test");
    const testWeb = requiredJob(ci, "test_web");
    const server = requiredJob(ci, "test_server");
    const check = requiredJob(ci, "check");

    assertRun(lint, "Check unused code", "vp run knip:check");
    assertRun(lint, "Check", "vp check");
    assertRun(typecheck, "Typecheck", "vpr typecheck");
    assertRun(build, "Build desktop pipeline", "vp run build:desktop");
    assertRun(
      build,
      "Verify preload bundle output",
      "node apps/desktop/scripts/verify-preload-bundle.mjs",
    );
    assertRun(test, "Test", ciTestCommand);
    assertRun(testWeb, "Test", "vp run --filter @t3tools/web test");
    assertRun(server, "Test", serverTestCommand);

    for (const job of [lint, typecheck, build, test, testWeb, server]) {
      const setup = requiredActionStep(job, "voidzero-dev/setup-vp@v1");
      assert.equal(setup.with?.cache, true);
      assert.equal(setup.with?.["run-install"], true);
    }
    for (const job of [build, test])
      assertRun(job, "Ensure Electron runtime is installed", electronCommand);
    const matrix = required(server.strategy?.matrix, "Server shard matrix is missing.");
    assert.equal(server.strategy?.["fail-fast"], false);
    assert.deepStrictEqual(matrix.shard, [1, 2, 3, 4, 5, 6]);
    const checkScript = stepRun(check, "Require every job to pass");
    assert.include(checkScript, "all(to_entries[];");
    assert.include(checkScript, "mobile_native_static_analysis");
  });
  it("keeps runner fallbacks and evaluates manual/advisory gates on both repositories", () => {
    for (const [fileName, jobId, canonicalRunner, fallbackRunner] of runnerCases) {
      const workflow = loadWorkflow(fileName);
      assertRunnerCases(workflow, jobId, canonicalRunner, fallbackRunner);
    }
    const windows = loadWorkflow("windows-tests.yml");
    // prettier-ignore
    assert.deepStrictEqual(Object.keys(windows.on.workflow_dispatch?.inputs ?? {}).sort(), ["files", "package"]);
    assert.isUndefined(windows.on.pull_request);
    assert.isUndefined(windows.on.push);
    const windowsJob = requiredJob(windows, "test");
    assert.isUndefined(windowsJob.if);
    assertRun(windowsJob, "Install", "vp install");
    assertRun(windowsJob, "Ensure Electron runtime is installed", windowsElectronCommand);
    const windowsTest = stepRun(windowsJob, "Test");
    for (const command of [
      testCommand,
      'vp run --filter "./$package" test',
      "Set-Location $package",
      "vp test run $files.Split(' ')",
    ])
      assert.include(windowsTest, command);
    assert.isUndefined(requiredJob(loadWorkflow("mobile-fingerprint-check.yml"), "fingerprint").if);
    const showcase = loadWorkflow("mobile-showcase-screenshots.yml");
    for (const [jobId, platform, expected] of showcaseCases) {
      for (const repository of [canonical, fork])
        assertJobExpression(
          showcase,
          jobId,
          makeFixture({ repository, inputs: { platform } }),
          expected,
        );
    }
    const ios = requiredJob(showcase, "ios");
    const iosSteps = required(ios.steps, "iOS steps are missing.");
    const toolchain = requiredStep(ios, "Select fork iOS toolchain");
    const toolchainIndex = iosSteps.indexOf(toolchain);
    const setupIndex = iosSteps.findIndex((step) => step.name === "Setup Vite+");
    const captureIndex = iosSteps.findIndex((step) => step.name === "Capture iOS showcase");
    assert.isAtLeast(toolchainIndex, 0);
    assert.isAtLeast(setupIndex, 0);
    assert.isAtLeast(captureIndex, 0);
    assert.isBelow(toolchainIndex, setupIndex);
    assert.isBelow(toolchainIndex, captureIndex);
    const toolchainIf = requiredString(toolchain.if, "iOS toolchain condition is missing.");
    for (const [repository, expected] of [
      [canonical, false],
      [fork, true],
      [other, true],
    ] as const)
      assertExpression(toolchainIf, makeFixture({ repository }), expected);
    const toolchainRun = stepRun(ios, "Select fork iOS toolchain").trim();
    assert.equal(toolchainRun, iosToolchainRun);
    assert.notInclude(toolchainRun, "||true");
    assert.notInclude(toolchainRun, "|| true");
    assert.isUndefined(toolchain["continue-on-error"]);
  });
  it("keeps secret and production jobs canonical-only", () => {
    for (const [fileName, jobIds] of canonicalOnlyJobCases) {
      const workflow = loadWorkflow(fileName);
      for (const jobId of jobIds)
        for (const repository of [canonical, fork, other])
          assertCanonicalJob(workflow, fileName, jobId, repository);
    }

    const release = loadWorkflow("release.yml");
    for (const jobId of releaseCanonicalJobs)
      for (const repository of [canonical, fork, other])
        assertJobExpression(
          release,
          jobId,
          releaseHappyFixture(jobId, { repository }),
          repository === canonical,
        );

    const relay = loadWorkflow("deploy-relay.yml");
    assertJobExpression(
      relay,
      "deploy_relay",
      makeFixture({ eventName: "push", ref: "refs/heads/main" }),
      true,
    );
    assertJobExpression(
      relay,
      "deploy_relay",
      makeFixture({ eventName: "push", ref: "refs/heads/feature" }),
      false,
    );
  });
  it("keeps labeled desktop preview builds and trusted publishing available in forks", () => {
    const desktopBuild = loadWorkflow("desktop-macos-preview.yml");
    for (const repository of [canonical, fork]) {
      assertJobExpression(
        desktopBuild,
        "build",
        makeFixture({
          repository,
          action: "labeled",
          labelName: "preview:mac",
          labels: ["preview:mac"],
        }),
        true,
      );
      assertJobExpression(
        desktopBuild,
        "build",
        makeFixture({ repository, action: "labeled", labelName: "unrelated" }),
        false,
      );
    }

    const publish = loadWorkflow("desktop-macos-preview-publish.yml");
    const packagePreview = requiredJob(publish, "build");
    const macRunner = requiredString(
      packagePreview.with?.runner as string | undefined,
      "Preview macOS runner input is missing.",
    );
    for (const repository of [canonical, fork, other])
      assertExpression(
        macRunner,
        makeFixture({ repository }),
        repository === canonical ? "blacksmith-12vcpu-macos-26" : "macos-15",
      );

    const resolveCondition = jobString(publish, "resolve", "if");
    assertExpression(
      resolveCondition,
      makeFixture({ eventName: "workflow_run", workflowRunEvent: "pull_request" }),
      true,
    );
    for (const fixture of [
      makeFixture({ eventName: "push" }),
      makeFixture({ eventName: "workflow_run", workflowRunConclusion: "failure" }),
      makeFixture({ eventName: "workflow_run", workflowRunEvent: "push" }),
    ])
      assertExpression(resolveCondition, fixture, false);

    const eligibleNeeds = {
      resolve: { result: "success" as const, outputs: { eligible: "true" } },
      build: { result: "success" as const, outputs: {} },
    };
    for (const repository of [canonical, fork]) {
      assertJobExpression(
        publish,
        "build",
        makeFixture({ repository, needs: eligibleNeeds }),
        true,
      );
      assertJobExpression(
        publish,
        "publish",
        makeFixture({ repository, needs: eligibleNeeds }),
        true,
      );
      assertJobExpression(
        publish,
        "publish",
        makeFixture({
          repository,
          needs: { ...eligibleNeeds, build: { result: "failure", outputs: {} } },
        }),
        false,
      );
    }

    const cleanup = jobString(publish, "cleanup", "if");
    assertExpression(
      cleanup,
      makeFixture({ eventName: "pull_request_target", action: "closed" }),
      true,
    );
    assertExpression(
      cleanup,
      makeFixture({
        eventName: "pull_request_target",
        action: "unlabeled",
        labelName: "preview:mac",
      }),
      true,
    );
    assertExpression(
      cleanup,
      makeFixture({
        eventName: "pull_request_target",
        action: "unlabeled",
        labelName: "unrelated",
      }),
      false,
    );
  });
  it("preserves release dependency, schedule, status, and channel gates", () => {
    const release = loadWorkflow("release.yml");
    for (const [jobId, needId] of releaseNeedCases)
      for (const result of ["failure", "cancelled"] as const)
        assertJobExpression(release, jobId, releaseNeedFixture(jobId, needId, result), false);

    const scheduled = scheduleFixture();
    for (const jobId of ["preflight", "relay_public_config", "build_bundle"])
      assertJobExpression(release, jobId, scheduled, false);

    for (const channel of ["stable", "preview", "nightly"]) {
      const fixture = makeFixture({
        repository: canonical,
        eventName: "workflow_dispatch",
        inputs: { channel },
        needs: releaseNeeds(channel),
      });
      assertJobExpression(release, "publish_aur", fixture, channel !== "preview");
      assertJobExpression(release, "build_web", fixture, channel !== "preview");
      assertJobExpression(release, "deploy_web", fixture, channel !== "preview");
      assertJobExpression(release, "build_marketing", fixture, channel === "nightly");
      assertJobExpression(release, "deploy_marketing", fixture, channel === "nightly");
      assertJobExpression(release, "finalize", fixture, channel === "stable");
      assertJobExpression(release, "announce_discord", fixture, channel !== "preview");
    }
  });
  it("evaluates PR label, label-event, and wrong-PR predicates", () => {
    const mobile = jobString(loadWorkflow("mobile-eas-preview.yml"), "preview", "if");
    const web = jobString(loadWorkflow("web-preview.yml"), "deploy", "if");
    const mobileLabel = "🚀 Mobile Continuous Deployment";
    // prettier-ignore
    const labelCases = [[mobile, mobileLabel, "synchronize", undefined, undefined, true], [mobile, "", "synchronize", undefined, undefined, false], [mobile, mobileLabel, "labeled", "unrelated", undefined, false], [mobile, mobileLabel, "labeled", mobileLabel, undefined, true], [web, "preview:web", "synchronize", undefined, undefined, true], [web, "preview:web", "synchronize", undefined, fork, false], [web, "", "synchronize", undefined, undefined, false], [web, "preview:web", "labeled", "preview:mac", undefined, false], [web, "preview:web", "labeled", "preview:web", undefined, true]] as const;
    for (const [expression, label, action, labelName, headRepository, expected] of labelCases)
      assertExpression(
        expression,
        labelFixture(label, action, labelName, headRepository),
        expected,
      );
  });
  it("uses apt mirrors only on Blacksmith and propagates background install failures", () => {
    const mirrorCases = [
      ["ci.yml", "build"],
      ["ci.yml", "test"],
      ["release.yml", "test"],
      ["release.yml", "build_bundle"],
      ["desktop-macos-preview.yml", "build"],
    ] as const;
    for (const [fileName, jobId] of mirrorCases) {
      const step = requiredActionStep(
        requiredJob(loadWorkflow(fileName), jobId),
        "./.github/actions/setup-apt-mirrors",
      );
      const condition = requiredString(
        step.if,
        fileName + ":" + jobId + " mirror gate is missing.",
      );
      assertExpression(condition, makeFixture({ repository: canonical }), true);
      for (const repository of [fork, other])
        assertExpression(condition, makeFixture({ repository }), false);
    }

    const ci = loadWorkflow("ci.yml");
    const build = requiredJob(ci, "build");
    const test = requiredJob(ci, "test");
    const start = stepRun(build, "Start installing browser secret helper build libraries");
    const finish = stepRun(build, "Finish installing browser secret helper build libraries");
    requiredStep(test, "Start installing browser secret helper build libraries");
    requiredStep(test, "Finish installing browser secret helper build libraries");

    for (const repository of [canonical, fork]) {
      const result = runAptLifecycle(start, finish, repository);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.aptStatus, "0");
      assert.include(result.commands, "sudo apt-get update");
      assert.include(result.commands, "sudo apt-get install -y libsecret-1-dev pkg-config");
      if (repository === canonical)
        assert.include(result.commands.join("\n"), "/etc/apt/blacksmith-ubuntu-mirrors.txt");
      else assert.notInclude(result.commands.join("\n"), "blacksmith-ubuntu-mirrors");
    }

    const failed = runAptLifecycle(start, finish, fork, "apt-get update");
    assert.equal(failed.status, 37, failed.stderr);
    assert.equal(failed.aptStatus, "37");
    assert.deepStrictEqual(failed.commands, ["sudo apt-get update"]);
  });
});
function runAptLifecycle(
  startScript: string,
  finishScript: string,
  repository: string,
  failOn = "",
) {
  const tempRoot = NodeProcess.env.TMPDIR ?? NodePath.resolve(".t3/test-tmp/fork-delivery");
  NodeFS.mkdirSync(tempRoot, { recursive: true });
  const tempDirectory = NodeFS.mkdtempSync(NodePath.join(tempRoot, "fork-ci-apt-"));
  const commandLog = NodePath.join(tempDirectory, "sudo-commands.log");
  NodeFS.writeFileSync(commandLog, "");
  const sudoStub = [
    "sudo() {",
    '  printf \'sudo %s\\n\' "$*" >> "$SUDO_LOG"',
    '  if [[ "${APT_FAIL_ON:-}" == "$*" ]]; then return "${APT_FAIL_STATUS:-37}"; fi',
    "  return 0",
    "}",
  ].join("\n");
  try {
    const result = NodeChildProcess.spawnSync(
      "/usr/bin/bash",
      ["-c", [sudoStub, startScript, finishScript].join("\n")],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: NodeProcess.env.PATH ?? "/usr/bin:/bin",
          GITHUB_REPOSITORY: repository,
          RUNNER_TEMP: tempDirectory,
          SUDO_LOG: commandLog,
          APT_FAIL_ON: failOn,
          APT_FAIL_STATUS: "37",
        },
      },
    );
    const commands = NodeFS.readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean);
    const statusPath = NodePath.join(tempDirectory, "apt-status");
    const aptStatus = NodeFS.existsSync(statusPath)
      ? NodeFS.readFileSync(statusPath, "utf8").trim()
      : "";
    return {
      status: result.status,
      stderr: String(result.stderr ?? "") + (result.error ? String(result.error) : ""),
      commands,
      aptStatus,
    };
  } finally {
    NodeFS.rmSync(tempDirectory, { recursive: true, force: true });
  }
}
