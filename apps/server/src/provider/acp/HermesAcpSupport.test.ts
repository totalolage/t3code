import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyHermesAcpSelection,
  applyHermesRuntimeMode,
  buildHermesAcpSpawnInput,
  resolveHermesRequestedModelId,
} from "./HermesAcpSupport.ts";

describe("HermesAcpSupport", () => {
  it("spawns the Hermes ACP subcommand in the project cwd", () => {
    expect(
      buildHermesAcpSpawnInput({ binaryPath: "/opt/hermes/bin/hermes" }, "/workspace/project", {
        ANTHROPIC_API_KEY: "test-key",
      }),
    ).toEqual({
      command: "/opt/hermes/bin/hermes",
      args: ["acp"],
      cwd: "/workspace/project",
      env: { ANTHROPIC_API_KEY: "test-key" },
    });
  });

  it("treats the fallback model as Hermes' configured default", () => {
    expect(resolveHermesRequestedModelId("hermes-default")).toBeUndefined();
    expect(resolveHermesRequestedModelId("anthropic:claude-sonnet-5")).toBe(
      "anthropic:claude-sonnet-5",
    );
  });

  it.effect("forwards model ids and negotiated ACP configuration options", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, string | boolean]> = [];
      const model = yield* applyHermesAcpSelection({
        runtime: {
          getConfigOptions: Effect.succeed([
            {
              id: "reasoning_effort",
              name: "Reasoning effort",
              type: "select",
              currentValue: "medium",
              options: [
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
              ],
            },
          ]),
          setSessionModel: (modelId) =>
            Effect.sync(() => {
              calls.push(["model", modelId]);
              return {};
            }),
          setConfigOption: (configId, value) =>
            Effect.sync(() => {
              calls.push([configId, value]);
              return { configOptions: [] };
            }),
        },
        currentModelId: "openrouter:old-model",
        selection: {
          model: "anthropic:claude-sonnet-5",
          options: [
            { id: "reasoning_effort", value: "high" },
            { id: "not_advertised", value: true },
          ],
        },
        mapError: ({ cause }) => cause,
      });

      expect(model).toBe("anthropic:claude-sonnet-5");
      expect(calls).toEqual([
        ["model", "anthropic:claude-sonnet-5"],
        ["reasoning_effort", "high"],
      ]);
    }),
  );

  it.effect("maps T3 runtime modes onto Hermes ACP modes", () =>
    Effect.gen(function* () {
      const modes: string[] = [];
      const runtime = {
        setSessionMode: (modeId: string) =>
          Effect.sync(() => {
            modes.push(modeId);
            return {};
          }),
      };
      for (const runtimeMode of [
        "approval-required",
        "auto-accept-edits",
        "full-access",
      ] as const) {
        yield* applyHermesRuntimeMode({
          runtime,
          runtimeMode,
          mapError: (cause) => cause,
        });
      }
      expect(modes).toEqual(["default", "accept_edits", "dont_ask"]);
    }),
  );
});
