// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makeHermesAdapter } from "./HermesAdapter.ts";
import { checkHermesProviderStatus } from "./HermesProvider.ts";

const realHermesBinary = process.env.T3_HERMES_REAL_BINARY?.trim();
const expectedOutput = process.env.T3_HERMES_REAL_EXPECTED_OUTPUT?.trim();
const decodeSettings = Schema.decodeSync(HermesSettings);
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-real-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

if (!realHermesBinary || !expectedOutput) {
  it.skip("runs a turn through a real Hermes ACP process (set T3_HERMES_REAL_BINARY and T3_HERMES_REAL_EXPECTED_OUTPUT)", () => {});
} else {
  it.layer(testLayer)("HermesAdapter real ACP smoke test", (it) => {
    it.effect(
      "runs a complete turn through the configured Hermes executable",
      () =>
        Effect.gen(function* () {
          const provider = yield* checkHermesProviderStatus(
            decodeSettings({
              enabled: true,
              binaryPath: realHermesBinary,
            }),
            process.env,
          );
          assert.equal(provider.status, "ready");
          assert.equal(provider.auth.status, "authenticated");
          assert.isTrue(provider.models.some((model) => model.slug === "custom:t3-hermes-smoke"));

          const instanceId = ProviderInstanceId.make("hermes_real");
          const adapter = yield* makeHermesAdapter(
            decodeSettings({ binaryPath: realHermesBinary }),
            { instanceId },
          );
          const threadId = ThreadId.make(`hermes-real-${Date.now()}`);
          const completed = yield* Deferred.make<void>();
          const events: ProviderRuntimeEvent[] = [];
          const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => events.push(event)).pipe(
              Effect.andThen(
                event.type === "turn.completed"
                  ? Deferred.succeed(completed, undefined)
                  : Effect.void,
              ),
            ),
          ).pipe(Effect.forkChild);

          const session = yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("hermes"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: { instanceId, model: "custom:t3-hermes-smoke-selected" },
          });
          assert.equal(session.model, "custom:t3-hermes-smoke-selected");
          yield* adapter.sendTurn({
            threadId,
            input: "Reply with the exact smoke-test text supplied by the model.",
            attachments: [],
          });
          yield* Deferred.await(completed);
          yield* Fiber.interrupt(eventFiber);

          const output = events
            .filter(
              (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
                event.type === "content.delta",
            )
            .map((event) => event.payload.delta)
            .join("");
          assert.include(output, expectedOutput);
        }).pipe(Effect.timeout("3 minutes")),
      180_000,
    );
  });
}
