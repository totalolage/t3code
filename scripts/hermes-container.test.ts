import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

const launcher = NodePath.resolve(import.meta.dirname, "hermes-container");

function makeFakeEngine(root: string): { readonly engine: string; readonly argsPath: string } {
  const engine = NodePath.join(root, "fake-docker");
  const argsPath = NodePath.join(root, "docker-args");
  NodeFS.writeFileSync(
    engine,
    `#!/usr/bin/env bash
printf "%s\\0" "$@" > "$HERMES_FAKE_ARGS_PATH"
if [[ -n "\${HERMES_FAKE_STDOUT:-}" ]]; then
  printf "%s" "$HERMES_FAKE_STDOUT"
fi
`,
  );
  NodeFS.chmodSync(engine, 0o755);
  return { engine, argsPath };
}

function readArgs(path: string): ReadonlyArray<string> {
  return NodeFS.readFileSync(path).toString().split("\0").slice(0, -1);
}

describe("hermes-container", () => {
  it("runs the pinned image with isolated state, the project mount, and selected environment", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-container-"));
    const workspace = NodePath.join(root, "workspace");
    const dataDirectory = NodePath.join(root, "data");
    NodeFS.mkdirSync(workspace);
    const { engine, argsPath } = makeFakeEngine(root);

    const result = NodeChildProcess.spawnSync(launcher, ["acp"], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_CONTAINER_ENGINE: engine,
        HERMES_CONTAINER_DATA_DIR: dataDirectory,
        HERMES_CONTAINER_RUNTIME: "test-runtime",
        HERMES_CONTAINER_FORWARD_ENV: "OPENROUTER_API_KEY, ANTHROPIC_API_KEY",
        HERMES_FAKE_ARGS_PATH: argsPath,
        HERMES_FAKE_STDOUT: '[stage2] booting\n{"jsonrpc":"2.0","id":1}\nplain log\n',
        OPENROUTER_API_KEY: "not-written-to-argv",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '{"jsonrpc":"2.0","id":1}\n');
    assert.deepStrictEqual(readArgs(argsPath), [
      "run",
      "--rm",
      "-i",
      "--add-host=host.docker.internal:host-gateway",
      "--env",
      `HERMES_UID=${process.getuid?.() ?? 0}`,
      "--env",
      `HERMES_GID=${process.getgid?.() ?? 0}`,
      "--volume",
      `${dataDirectory}:/opt/data`,
      "--volume",
      `${workspace}:${workspace}`,
      "--workdir",
      workspace,
      "--runtime",
      "test-runtime",
      "--env",
      "OPENROUTER_API_KEY",
      "nousresearch/hermes-agent@sha256:24f49688cda7315ad39a9b94ef46347f3747e99863d5e05b5b86ff794baefdb3",
      "acp",
    ]);
    assert.ok(!NodeFS.readFileSync(argsPath, "utf8").includes("not-written-to-argv"));
    assert.ok(!readArgs(argsPath).includes("ANTHROPIC_API_KEY"));
  });

  it("rejects invalid forwarded environment variable names", () => {
    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-hermes-container-invalid-env-"),
    );
    const workspace = NodePath.join(root, "workspace");
    NodeFS.mkdirSync(workspace);
    const { engine, argsPath } = makeFakeEngine(root);

    const result = NodeChildProcess.spawnSync(launcher, ["acp"], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_CONTAINER_ENGINE: engine,
        HERMES_CONTAINER_DATA_DIR: NodePath.join(root, "data"),
        HERMES_CONTAINER_FORWARD_ENV: "OPENROUTER_API_KEY;echo",
        HERMES_FAKE_ARGS_PATH: argsPath,
      },
    });

    assert.equal(result.status, 64);
    assert.match(result.stderr, /Invalid variable name/);
  });
});
