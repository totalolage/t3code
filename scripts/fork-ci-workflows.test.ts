// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const readWorkflow = (name: string) =>
  NodeFS.readFileSync(NodePath.join(repoRoot, ".github/workflows", name), "utf8");

it("runs the complete CI suite on hosted runners outside the upstream repository", () => {
  const workflow = readWorkflow("ci.yml");

  assert.strictEqual(workflow.match(/^    runs-on:/gmu)?.length, 4);
  assert.strictEqual(workflow.match(/github\.repository == 'pingdotgg\/t3code'/gu)?.length, 4);
  assert.strictEqual(workflow.match(/\|\| 'ubuntu-24\.04'/gu)?.length, 3);
  assert.strictEqual(workflow.match(/\|\| 'macos-15'/gu)?.length, 1);
  assert.include(workflow, "blacksmith-8vcpu-ubuntu-2404");
  assert.include(workflow, "blacksmith-12vcpu-macos-26");
});

it("keeps upstream-owned deployment workflows disabled in forks", () => {
  const gatedWorkflows = [
    "deploy-relay.yml",
    "mobile-eas-preview.yml",
    "mobile-eas-production.yml",
    "mobile-showcase-screenshots.yml",
    "release.yml",
  ];

  for (const name of gatedWorkflows) {
    assert.include(readWorkflow(name), "github.repository == 'pingdotgg/t3code'", name);
  }

  assert.notInclude(readWorkflow("f8y-release.yml"), "github.repository == 'pingdotgg/t3code'");
});
