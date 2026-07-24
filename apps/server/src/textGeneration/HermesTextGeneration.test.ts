// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { HermesSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { makeHermesTextGeneration } from "./HermesTextGeneration.ts";

const decodeSettings = Schema.decodeSync(HermesSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeHermesWrapper(dir: string, environment: Record<string, string>): string {
  const binaryPath = NodePath.join(dir, "hermes");
  NodeFS.writeFileSync(
    binaryPath,
    [
      "#!/bin/sh",
      ...Object.entries(environment).map(
        ([key, value]) => `export ${key}=${shellSingleQuote(value)}`,
      ),
      'if [ "$1" != "acp" ]; then exit 11; fi',
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

const testLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("HermesTextGeneration", (it) => {
  it.effect("uses ACP and forwards the selected underlying model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-text-acp-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const binaryPath = makeHermesWrapper(tempDir, {
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
            title: "Migrate Hermes to ACP",
          }),
        });
        const textGeneration = yield* makeHermesTextGeneration(decodeSettings({ binaryPath }));
        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "migrate Hermes",
          modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), "grok-mock-alt"),
        });
        expect(generated.title).toBe("Migrate Hermes to ACP");

        const requests = NodeFS.readFileSync(requestLogPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
        expect(
          requests.some(
            (request) =>
              request.method === "session/set_model" && request.params?.modelId === "grok-mock-alt",
          ),
        ).toBe(true);
      }),
    ),
  );
});
