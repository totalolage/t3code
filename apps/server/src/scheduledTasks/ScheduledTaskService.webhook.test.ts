// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput, SecretRequestError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as EffectScheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

type LaunchInput = ThreadLaunchService.ThreadLaunchInput;

const webhookTaskInput = (overrides: Record<string, unknown> = {}) =>
  decodeUpsertInput({
    id: "scheduled-task:hook",
    title: "Review PRs",
    prompt: "Review this PR: {{body.pull_request.url}}",
    enabled: true,
    schedule: { type: "webhook" },
    projectId: "project-webhook",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

const pullRequestBody = new TextEncoder().encode(
  JSON.stringify({ pull_request: { url: "https://github.com/org/repo/pull/45" } }),
);

const requestFor = (
  task: { readonly id: string; readonly webhook?: { readonly path: string } | undefined },
  overrides: Partial<ScheduledTaskService.WebhookTriggerRequest> = {},
): ScheduledTaskService.WebhookTriggerRequest => ({
  hookId: task.id,
  token: task.webhook?.path.split("/").at(-1) ?? "",
  method: "POST",
  path: `/api/hooks/${task.id}`,
  query: "",
  headers: { "content-type": "application/json" },
  body: pullRequestBody,
  bodyText: new TextDecoder().decode(pullRequestBody),
  ...overrides,
});

/**
 * Runs `body` against a service whose launches are pushed to `launches`;
 * `gate`, when given, holds each launch until the test releases it.
 */
const withService = <A, E>(
  body: (input: {
    readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
    readonly launches: Queue.Queue<LaunchInput>;
    /** Secrets the user entered for an agent, by ref; consuming one removes it. */
    readonly secretsByRef: Map<string, string>;
  }) => Effect.Effect<A, E, never>,
  options: {
    readonly gate?: Deferred.Deferred<void>;
    readonly hookBaseUrl?: string;
    readonly source?: ScheduledTaskService.WebhookOrigin["source"];
    readonly origin?: Context.Service.Shape<typeof ScheduledTaskService.ScheduledTaskWebhookOrigin>;
  } = {},
) =>
  Effect.gen(function* () {
    const launches = yield* Queue.unbounded<LaunchInput>();
    const secretsByRef = new Map<string, string>();
    const layerDependencies = Layer.mergeAll(
      NodePlatformCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          Queue.offer(launches, input).pipe(
            Effect.andThen(options.gate ? Deferred.await(options.gate) : Effect.void),
            Effect.as({ threadId: "thread-1", resumed: false } as never),
          ),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({
        consume: ({ ref }) => {
          const value = secretsByRef.get(ref);
          secretsByRef.delete(ref);
          return value === undefined
            ? Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }))
            : Effect.succeed(value);
        },
      }),
      Layer.succeed(
        ScheduledTaskService.ScheduledTaskWebhookOrigin,
        options.origin ?? {
          current: Effect.succeed({
            hookBaseUrl: options.hookBaseUrl ?? null,
            source: options.source ?? "t3-connect",
          }),
          changes: Stream.empty,
        },
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* body({ service, launches, secretsByRef });
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

it.effect("dispatches exactly the rendered prompt and logs the delivery", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      assert.equal(task.nextRunAt, null);
      assert.isDefined(task.webhook);
      assert.isTrue(task.webhook!.path.startsWith("/api/hooks/scheduled-task%3Ahook/"));
      // Not linked to T3 Connect in tests.
      assert.equal(task.webhook!.url, null);

      const result = yield* service.triggerWebhook(requestFor(task));
      assert.equal(result._tag, "accepted");
      const launched = yield* Queue.take(launches);
      assert.equal(
        launched.initialMessage?.text,
        "Review this PR: https://github.com/org/repo/pull/45",
      );
      assert.equal(
        launched.commandId,
        `scheduled-task:${task.id}:webhook:${result._tag === "accepted" ? result.deliveryId : ""}`,
      );

      const { deliveries } = yield* service.listWebhookDeliveries({ id: task.id });
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]?.outcome, "accepted");
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: deliveries[0]!.id,
      });
      assert.equal(delivery.body, new TextDecoder().decode(pullRequestBody));
      assert.equal(delivery.renderedPrompt, launched.initialMessage?.text);
    }),
  ),
);

it("builds the relay hook URL from the managed tunnel's key, never the environment id", () => {
  const relayUrl = "https://relay.example.com/";
  assert.equal(
    ScheduledTaskService.relayHookBaseUrl({
      relayUrl,
      tunnelName: "t3coderelay-managedendpoint-dev-julius-0123456789abcdef",
    }),
    "https://relay.example.com/v1/hooks/0123456789abcdef",
  );
  for (const tunnelName of [undefined, "t3coderelay-managedendpoint", "x-0123456789ABCDEF"]) {
    assert.isNull(ScheduledTaskService.relayHookBaseUrl({ relayUrl, tunnelName }));
  }
});

it.effect("gives webhook tasks a relay URL when the environment has a managed tunnel", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(yield* webhookTaskInput());
        const token = task.webhook!.path.split("/").at(-1);
        assert.equal(
          task.webhook?.url,
          `https://relay.example.com/v1/hooks/0123456789abcdef/scheduled-task%3Ahook/${token}`,
        );
        assert.equal(task.webhook?.urlSource, "t3-connect");
      }),
    { hookBaseUrl: "https://relay.example.com/v1/hooks/0123456789abcdef" },
  ),
);

describe("resolveWebhookOrigin", () => {
  const relay = "https://relay.example.com/v1/hooks/0123456789abcdef";

  it.effect("prefers a configured public base URL over T3 Connect", () =>
    Effect.gen(function* () {
      const origin = yield* ScheduledTaskService.resolveWebhookOrigin({
        publicBaseUrl: "https://code.example.com/",
        readRelayHookBaseUrl: Effect.die("relay must not be read"),
      });
      assert.deepEqual(origin, {
        hookBaseUrl: "https://code.example.com/api/hooks",
        source: "public-base-url",
      });
    }),
  );

  it.effect("keeps a proxy path prefix and drops trailing slashes", () =>
    Effect.gen(function* () {
      const origin = yield* ScheduledTaskService.resolveWebhookOrigin({
        publicBaseUrl: "https://example.com:8443/t3//",
        readRelayHookBaseUrl: Effect.succeed(relay),
      });
      assert.equal(origin.hookBaseUrl, "https://example.com:8443/t3/api/hooks");
    }),
  );

  it.effect("falls back to T3 Connect when unset or invalid", () =>
    Effect.gen(function* () {
      for (const publicBaseUrl of ["", "http://code.example.com", "not a url"]) {
        const origin = yield* ScheduledTaskService.resolveWebhookOrigin({
          publicBaseUrl,
          readRelayHookBaseUrl: Effect.succeed(relay),
        });
        assert.deepEqual(origin, { hookBaseUrl: relay, source: "t3-connect" });
      }
    }),
  );

  it.effect("has no URL without either", () =>
    Effect.gen(function* () {
      const origin = yield* ScheduledTaskService.resolveWebhookOrigin({
        publicBaseUrl: "",
        readRelayHookBaseUrl: Effect.succeed(null),
      });
      assert.isNull(origin.hookBaseUrl);
    }),
  );
});

it.effect("gives webhook tasks a direct URL under the public base URL", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(yield* webhookTaskInput());
        assert.equal(task.webhook?.url, `https://code.example.com/t3${task.webhook!.path}`);
        assert.equal(task.webhook?.urlSource, "public-base-url");
      }),
    { hookBaseUrl: "https://code.example.com/t3/api/hooks", source: "public-base-url" },
  ),
);

it.effect("re-emits live task lists when the webhook origin changes", () =>
  Effect.gen(function* () {
    const publicBaseUrl = yield* Ref.make("");
    const originChanged = yield* Queue.unbounded<void>();
    yield* withService(
      ({ service }) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* service.upsert(yield* webhookTaskInput());
            const urls = yield* Queue.unbounded<string | null>();
            yield* service.subscribeList().pipe(
              Stream.runForEach(({ tasks }) => Queue.offer(urls, tasks[0]?.webhook?.url ?? null)),
              Effect.forkScoped,
            );
            assert.isNull(yield* Queue.take(urls));

            yield* Ref.set(publicBaseUrl, "https://code.example.com");
            yield* Queue.offer(originChanged, undefined);
            assert.isTrue(
              (yield* Queue.take(urls))?.startsWith("https://code.example.com/api/hooks/"),
            );

            yield* Ref.set(publicBaseUrl, "");
            yield* Queue.offer(originChanged, undefined);
            assert.isNull(yield* Queue.take(urls));
          }),
        ),
      {
        origin: {
          current: Ref.get(publicBaseUrl).pipe(
            Effect.flatMap((url) =>
              ScheduledTaskService.resolveWebhookOrigin({
                publicBaseUrl: url,
                readRelayHookBaseUrl: Effect.succeed(null),
              }),
            ),
          ),
          changes: Stream.fromQueue(originChanged),
        },
      },
    );
  }),
);

it.effect("answers not found for a wrong token or unknown hook without logging", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const wrongToken = yield* service.triggerWebhook(requestFor(task, { token: "nope" }));
      assert.equal(wrongToken._tag, "not_found");
      const unknown = yield* service.triggerWebhook(requestFor(task, { hookId: "missing" }));
      assert.equal(unknown._tag, "not_found");
      assert.equal((yield* service.listWebhookDeliveries({ id: task.id })).deliveries.length, 0);
    }),
  ),
);

it.effect("rotating the token retires the old URL and saving keeps it", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const input = yield* webhookTaskInput();
      const { task } = yield* service.upsert(input);
      const saved = yield* service.upsert(yield* webhookTaskInput({ title: "Renamed" }));
      assert.equal(saved.task.webhook?.path, task.webhook?.path);

      const rotated = yield* service.rotateWebhookToken({ id: task.id });
      assert.notEqual(rotated.task.webhook?.path, task.webhook?.path);
      assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "not_found");
      assert.equal((yield* service.triggerWebhook(requestFor(rotated.task)))._tag, "accepted");
    }),
  ),
);

it.effect("checks the configured signature and keeps the secret write-only", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: {
              header: "X-Hub-Signature-256",
              encoding: "hex",
              prefix: "sha256=",
              secret: "s3cret",
            },
          },
        }),
      );
      assert.deepEqual(task.schedule, {
        type: "webhook",
        signature: {
          scheme: "hmac_sha256",
          header: "x-hub-signature-256",
          encoding: "hex",
          prefix: "sha256=",
        },
        maxDeliveryAgeMinutes: null,
        deliveryId: null,
        deliveryTimestamp: null,
      });
      assert.isTrue(task.webhook?.hasSecret);

      const unsigned = yield* service.triggerWebhook(requestFor(task));
      assert.equal(unsigned._tag, "rejected_signature");

      const signature = `sha256=${NodeCrypto.createHmac("sha256", "s3cret").update(pullRequestBody).digest("hex")}`;
      const signed = yield* service.triggerWebhook(
        requestFor(task, {
          headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        }),
      );
      assert.equal(signed._tag, "accepted");

      // Saving without a secret keeps the stored one.
      const resaved = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
          },
        }),
      );
      assert.isTrue(resaved.task.webhook?.hasSecret);

      const outcomes = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries.map(
        (delivery) => [delivery.outcome, delivery.signatureVerified],
      );
      assert.deepEqual(outcomes.toSorted(), [
        ["accepted", true],
        ["rejected_signature", false],
      ]);
    }),
  ),
);

it.effect("logs but does not run deliveries to a disabled task, and refuses run now", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "disabled");
      assert.equal(yield* Queue.size(launches), 0);
      const runNow = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
      assert.equal(runNow.message, "Webhook tasks run when their URL receives a request.");
    }),
  ),
);

it.effect("queues a burst of deliveries instead of dropping them", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    yield* withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(yield* webhookTaskInput());
          const results = yield* Effect.forEach([1, 2, 3], () =>
            service.triggerWebhook(requestFor(task)),
          );
          assert.deepEqual(
            results.map((result) => result._tag),
            ["accepted", "accepted", "accepted"],
          );
          // Only the first is dispatching; the others wait their turn.
          yield* Queue.take(launches);
          yield* Deferred.succeed(gate, undefined);
          const rest = yield* Effect.all([Queue.take(launches), Queue.take(launches)]);
          assert.equal(new Set(rest.map((launch) => launch.commandId)).size, 2);
        }),
      { gate },
    );
  }),
);

it.effect("rate limits a hook past 60 deliveries a minute", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      const results = yield* Effect.forEach(Array.from({ length: 61 }), () =>
        service.triggerWebhook(requestFor(task)),
      );
      assert.equal(results.at(-2)?._tag, "disabled");
      assert.equal(results.at(-1)?._tag, "rate_limited");
      // Further rejections in the same window are counted, not logged.
      yield* Effect.forEach([1, 2, 3], () => service.triggerWebhook(requestFor(task)));
      const outcomes = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries.map(
        (delivery) => delivery.outcome,
      );
      assert.equal(outcomes.filter((outcome) => outcome === "rate_limited").length, 1);
    }),
  ),
);

it.effect("a save carrying a stale token cannot undo a rotation", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const rotated = yield* service.rotateWebhookToken({ id: task.id });
      // The editor was opened before the rotation and saves afterwards.
      const saved = yield* service.upsert(yield* webhookTaskInput({ title: "Edited" }));
      assert.equal(saved.task.webhook?.path, rotated.task.webhook?.path);
      assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "not_found");
    }),
  ),
);

it.effect("keeps the newest 50 deliveries when they share a timestamp", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      // Paused, so each request is logged without starting a run. The test
      // clock is frozen, so every delivery has the same received_at.
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      const ids = yield* Effect.forEach(Array.from({ length: 55 }), (_, index) =>
        service.triggerWebhook(requestFor(task, { query: `n=${index}` })).pipe(Effect.as(index)),
      );
      const { deliveries } = yield* service.listWebhookDeliveries({ id: task.id });
      assert.equal(deliveries.length, 50);
      const first = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: deliveries[0]!.id,
      });
      const last = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: deliveries.at(-1)!.id,
      });
      assert.equal(first.delivery.query, `n=${ids.at(-1)}`);
      assert.equal(last.delivery.query, "n=5");
    }),
  ),
);

it.effect("keeps credential headers and query values out of the delivery log", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      yield* service.triggerWebhook(
        requestFor(task, {
          query: "page=2&api_key=k",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer sender-token",
            "x-webhook-key": "k",
            "x-github-event": "push",
          },
        }),
      );
      const [summary] = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: summary!.id,
      });
      assert.equal(delivery.query, "page=2&api_key=[redacted]");
      assert.equal(delivery.headers.authorization, "[redacted]");
      assert.equal(delivery.headers["x-webhook-key"], "[redacted]");
      assert.equal(delivery.headers["x-github-event"], "push");
    }),
  ),
);

const queuedDeliveryCases = [
  {
    change: "paused",
    reason: "The task was paused before this delivery ran.",
    apply: (service: ScheduledTaskService.ScheduledTaskService["Service"], id: string) =>
      service.setEnabled({ id: id as never, enabled: false }),
  },
  {
    change: "switched to an interval trigger",
    reason: "The task's trigger changed before this delivery ran.",
    apply: (service: ScheduledTaskService.ScheduledTaskService["Service"]) =>
      webhookTaskInput({ schedule: { type: "interval", everyMs: 3_600_000 } }).pipe(
        Effect.flatMap(service.upsert),
      ),
  },
] as const;

it.effect.each(queuedDeliveryCases)(
  "a delivery queued behind a run does not start once the task is $change",
  ({ reason, apply }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      yield* withService(
        ({ service, launches }) =>
          Effect.gen(function* () {
            const { task } = yield* service.upsert(yield* webhookTaskInput());
            yield* service.triggerWebhook(requestFor(task));
            const queued = yield* service.triggerWebhook(requestFor(task));
            yield* Queue.take(launches);
            yield* apply(service, task.id);
            yield* Deferred.succeed(gate, undefined);
            // The queued delivery is marked failed instead of launching.
            const deliveryId = queued._tag === "accepted" ? queued.deliveryId : undefined;
            let delivery = (yield* service.getWebhookDelivery({
              id: task.id,
              deliveryId: deliveryId!,
            })).delivery;
            while (delivery.outcome === "accepted") {
              yield* Effect.yieldNow;
              delivery = (yield* service.getWebhookDelivery({
                id: task.id,
                deliveryId: deliveryId!,
              })).delivery;
            }
            assert.equal(delivery.outcome, "dispatch_failed");
            assert.equal(delivery.error, reason);
            assert.equal(yield* Queue.size(launches), 0);
          }),
        { gate },
      );
    }),
);

it.effect("a save without a secret keeps a secret changed after it was read", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const signature = { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" };
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: { type: "webhook", signature: { ...signature, secret: "old" } },
        }),
      );
      yield* service.upsert(
        yield* webhookTaskInput({
          schedule: { type: "webhook", signature: { ...signature, secret: "new" } },
        }),
      );
      // A form opened before the change saves without sending a secret.
      yield* service.upsert(
        yield* webhookTaskInput({ title: "Edited", schedule: { type: "webhook", signature } }),
      );
      const sign = (secret: string) =>
        `sha256=${NodeCrypto.createHmac("sha256", secret).update(pullRequestBody).digest("hex")}`;
      const withSignature = (secret: string) =>
        requestFor(task, {
          headers: { "content-type": "application/json", "x-hub-signature-256": sign(secret) },
        });
      assert.equal(
        (yield* service.triggerWebhook(withSignature("old")))._tag,
        "rejected_signature",
      );
      assert.equal((yield* service.triggerWebhook(withSignature("new")))._tag, "accepted");
    }),
  ),
);

it.effect("caps deliveries waiting behind a stuck run", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    yield* withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(yield* webhookTaskInput());
          yield* service.triggerWebhook(requestFor(task));
          yield* Queue.take(launches);
          // The cap counts the running delivery too: 19 more wait, the next is refused.
          const waiting = yield* Effect.forEach(Array.from({ length: 20 }), () =>
            service.triggerWebhook(requestFor(task)),
          );
          assert.equal(waiting.filter((result) => result._tag === "accepted").length, 19);
          assert.equal(waiting.at(-1)?._tag, "rate_limited");
          // The refused request is not logged.
          const logged = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
          assert.equal(logged.length, 20);
          yield* Deferred.succeed(gate, undefined);
        }),
      { gate },
    );
  }),
);

it.effect("logs a body's first 64 KiB by bytes, not characters", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      // 30 000 three-byte characters: under 64 Ki characters, over 64 KiB.
      const text = "界".repeat(30_000);
      const body = new TextEncoder().encode(text);
      yield* service.triggerWebhook(requestFor(task, { body, bodyText: text }));
      const [summary] = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: summary!.id,
      });
      assert.isTrue(delivery.bodyTruncated);
      assert.isAtMost(new TextEncoder().encode(delivery.body).byteLength, 64 * 1024 + 3);
    }),
  ),
);

it.effect("counts the prompt as the provider does, without surrounding whitespace", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ prompt: "{{body.text}}" }));
      // Over the limit as sent, within it once the padding is trimmed.
      const text = `{"text":"${" ".repeat(1_000)}${"x".repeat(119_990)}${"\\n".repeat(1_000)}"}`;
      const result = yield* service.triggerWebhook(
        requestFor(task, { body: new TextEncoder().encode(text), bodyText: text }),
      );
      assert.equal(result._tag, "accepted");
      yield* Queue.take(launches);
    }),
  ),
);

it.effect("does not start a run when the filled-in prompt is too long", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ prompt: "{{body}}" }));
      const text = "x".repeat(200_000);
      const body = new TextEncoder().encode(text);
      const result = yield* service.triggerWebhook(requestFor(task, { body, bodyText: text }));
      assert.equal(result._tag, "accepted");
      assert.equal(yield* Queue.size(launches), 0);
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: result._tag === "accepted" ? result.deliveryId : ("" as never),
      });
      assert.equal(delivery.outcome, "dispatch_failed");
      assert.equal(delivery.error, "The filled-in prompt is too long.");
      assert.equal(delivery.renderedPrompt?.length, 64 * 1024);
      // The queue slot was never taken: a normal delivery still runs.
      const ok = yield* service.triggerWebhook(requestFor(task));
      assert.equal(ok._tag, "accepted");
      yield* Queue.take(launches);
    }),
  ),
);

it.effect("a held request already delivered directly runs only once", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const direct = yield* service.triggerWebhook(
        requestFor(task, { relayDeliveryId: "relay-1" }),
      );
      const replayed = yield* service.triggerWebhook(
        requestFor(task, { relayDeliveryId: "relay-1", receivedAt: "2026-10-04T10:00:00.000Z" }),
      );
      assert.equal(direct._tag, "accepted");
      // Same delivery, answered the same way, but recorded as a duplicate.
      assert.deepEqual(replayed, { ...direct, outcome: "duplicate" } as typeof replayed);
      yield* Queue.take(launches);
      const logged = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      assert.equal(logged.length, 1);
    }),
  ),
);

it.effect("a held request whose sender hung up mid-request still runs", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      // The relay times out and the request fiber is interrupted. A small
      // operation budget makes the request yield often, so stepping the
      // interrupt one yield later each time lands it at every point in the
      // request (one takes about 40 yields), then the relay retries.
      for (let step = 0; step < 60; step++) {
        const request = requestFor(task, { relayDeliveryId: `hung-up-${step}` });
        const fiber = yield* service
          .triggerWebhook(request)
          .pipe(Effect.provideService(EffectScheduler.MaxOpsBeforeYield, 8), Effect.forkChild);
        for (let yields = 0; yields < step; yields++) yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        const retried = yield* service.triggerWebhook(request);
        assert.equal(retried._tag, "accepted");
        const deliveryId = retried._tag === "accepted" ? retried.deliveryId : undefined;
        // Logged and run exactly once, whether or not the first attempt got through.
        yield* service.getWebhookDelivery({ id: task.id, deliveryId: deliveryId! });
        const launch = yield* Queue.take(launches);
        assert.include(launch.commandId, `hung-up-${step}`);
        // Keep each step in a fresh rate-limit window.
        yield* TestClock.adjust("61 seconds");
      }
      assert.equal(yield* Queue.size(launches), 0);
    }),
  ),
);

it.effect("a held request runs once even after the log has trimmed it", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const first = yield* service.triggerWebhook(requestFor(task, { relayDeliveryId: "kept" }));
      assert.equal(first._tag, "accepted");
      yield* Queue.take(launches);
      // Push the original row out of the 50-row delivery log.
      const paused = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      yield* Effect.forEach(Array.from({ length: 55 }), () =>
        service.triggerWebhook(requestFor(paused.task)),
      );
      yield* service.upsert(yield* webhookTaskInput());
      const replay = yield* service.triggerWebhook(requestFor(task, { relayDeliveryId: "kept" }));
      assert.equal(replay._tag, "accepted");
      assert.equal(yield* Queue.size(launches), 0);
    }),
  ),
);

it.effect("a rate-limited held request can run on a later pass", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      // Spend the task's 60-a-minute budget.
      yield* Effect.forEach(Array.from({ length: 60 }), () =>
        service.triggerWebhook(requestFor(task)),
      );
      const limited = yield* service.triggerWebhook(requestFor(task, { relayDeliveryId: "later" }));
      assert.equal(limited._tag, "rate_limited");
      yield* service.upsert(yield* webhookTaskInput());
      yield* TestClock.adjust("61 seconds");
      const retried = yield* service.triggerWebhook(requestFor(task, { relayDeliveryId: "later" }));
      assert.equal(retried._tag, "accepted");
      yield* Queue.take(launches);
    }),
  ),
);

it.effect("logs a held request at the time the relay received it", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      const receivedAt = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 5 }));
      yield* service.triggerWebhook(requestFor(task, { relayDeliveryId: "relay-2", receivedAt }));
      const [delivery] = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      assert.equal(delivery?.receivedAt, receivedAt);
    }),
  ),
);

it.effect("a receive time in the future counts as now", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({ schedule: { type: "webhook", maxDeliveryAgeMinutes: 30 } }),
      );
      const now = yield* DateTime.now;
      const result = yield* service.triggerWebhook(
        requestFor(task, {
          relayDeliveryId: "future",
          receivedAt: DateTime.formatIso(DateTime.add(now, { days: 365 })),
        }),
      );
      assert.equal(result._tag, "accepted");
      yield* Queue.take(launches);
      const [delivery] = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      assert.equal(delivery?.receivedAt, DateTime.formatIso(now));
    }),
  ),
);

it.effect("skips a held request older than the task's max age", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({ schedule: { type: "webhook", maxDeliveryAgeMinutes: 30 } }),
      );
      const now = yield* DateTime.now;
      const old = DateTime.formatIso(DateTime.subtract(now, { minutes: 31 }));
      const fresh = DateTime.formatIso(DateTime.subtract(now, { minutes: 5 }));
      const tooOld = yield* service.triggerWebhook(
        requestFor(task, { relayDeliveryId: "old", receivedAt: old }),
      );
      assert.equal(tooOld._tag, "expired");
      assert.equal(yield* Queue.size(launches), 0);
      const ok = yield* service.triggerWebhook(
        requestFor(task, { relayDeliveryId: "fresh", receivedAt: fresh }),
      );
      assert.equal(ok._tag, "accepted");
      const outcomes = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries.map(
        (delivery) => delivery.outcome,
      );
      assert.includeMembers(outcomes, ["expired", "accepted"]);
    }),
  ),
);

it.effect("runs a held request of any age when no max age is set", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const now = yield* DateTime.now;
      const result = yield* service.triggerWebhook(
        requestFor(task, {
          relayDeliveryId: "ancient",
          receivedAt: DateTime.formatIso(DateTime.subtract(now, { hours: 23 })),
        }),
      );
      assert.equal(result._tag, "accepted");
    }),
  ),
);

it.effect("deleting a task removes its delivery log", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      yield* service.triggerWebhook(requestFor(task));
      yield* service.delete({ id: task.id });
      assert.equal((yield* service.listWebhookDeliveries({ id: task.id })).deliveries.length, 0);
    }),
  ),
);

const githubSignature = (secret: string) =>
  `sha256=${NodeCrypto.createHmac("sha256", secret).update(pullRequestBody).digest("hex")}`;

it.effect("a signature can take the user's secret by ref, which works only once", () =>
  withService(({ service, launches, secretsByRef }) =>
    Effect.gen(function* () {
      secretsByRef.set("secret-ref:00000000000000000000000000000001", "github-secret");
      const githubSchedule = (secretRef: string) => ({
        type: "webhook",
        signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=", secretRef },
      });
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: githubSchedule("secret-ref:00000000000000000000000000000001"),
        }),
      );
      assert.isTrue(task.webhook!.hasSecret);
      const signed = yield* service.triggerWebhook(
        requestFor(task, {
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": githubSignature("github-secret"),
          },
        }),
      );
      assert.equal(signed._tag, "accepted");
      yield* Queue.take(launches);

      // The ref was consumed by that save.
      const reused = yield* service
        .upsert(
          yield* webhookTaskInput({
            id: "scheduled-task:other",
            schedule: githubSchedule("secret-ref:00000000000000000000000000000001"),
          }),
        )
        .pipe(Effect.flip);
      assert.include(reused.message, "already used");
    }),
  ),
);

it.effect("a retried save with an already used secretRef keeps the stored secret", () =>
  withService(({ service, launches, secretsByRef }) =>
    Effect.gen(function* () {
      secretsByRef.set("secret-ref:00000000000000000000000000000002", "github-secret");
      const save = webhookTaskInput({
        id: undefined,
        commandId: "command:mcp:schedule-task:release-hook",
        schedule: {
          type: "webhook",
          signature: {
            header: "x-hub-signature-256",
            encoding: "hex",
            prefix: "sha256=",
            secretRef: "secret-ref:00000000000000000000000000000002",
          },
        },
      });
      const first = yield* service.upsert(yield* save);
      // The agent never saw the first result, so it sends the same call again,
      // this time with a plain secret alongside the used ref.
      const retried = yield* service.upsert(
        yield* webhookTaskInput({
          id: undefined,
          commandId: "command:mcp:schedule-task:release-hook",
          schedule: {
            type: "webhook",
            signature: {
              header: "x-hub-signature-256",
              encoding: "hex",
              prefix: "sha256=",
              secretRef: "secret-ref:00000000000000000000000000000002",
              secret: "made-up-secret",
            },
          },
        }),
      );
      assert.equal(retried.task.id, first.task.id);
      const signed = yield* service.triggerWebhook(
        requestFor(retried.task, {
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": githubSignature("github-secret"),
          },
        }),
      );
      assert.equal(signed._tag, "accepted");
      yield* Queue.take(launches);
    }),
  ),
);

it.effect("a signature without any secret is refused", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const failure = yield* service
        .upsert(
          yield* webhookTaskInput({
            schedule: {
              type: "webhook",
              signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
            },
          }),
        )
        .pipe(Effect.flip);
      assert.include(failure.message, "needs a signing secret");
    }),
  ),
);

const standardWebhooksSecret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;

/** Standard Webhooks headers for `pullRequestBody`, signed as PostHog and Svix do. */
const standardWebhooksHeaders = (input: { readonly id: string; readonly timestampMs: number }) => {
  const timestamp = Math.floor(input.timestampMs / 1000);
  const key = Buffer.from(standardWebhooksSecret.slice("whsec_".length), "base64");
  const digest = NodeCrypto.createHmac("sha256", key)
    .update(`${input.id}.${timestamp}.`)
    .update(pullRequestBody)
    .digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": input.id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${digest}`,
  };
};

it.effect("checks Standard Webhooks signatures against when the request arrived", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      // Room for a held request received before the 5-minute tolerance.
      yield* TestClock.adjust("10 minutes");
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: { scheme: "standard_webhooks", secret: standardWebhooksSecret },
          },
        }),
      );
      assert.deepEqual(task.schedule, {
        type: "webhook",
        signature: { scheme: "standard_webhooks" },
        maxDeliveryAgeMinutes: null,
        deliveryId: null,
        deliveryTimestamp: null,
      });
      const now = DateTime.toEpochMillis(yield* DateTime.now);

      const signed = yield* service.triggerWebhook(
        requestFor(task, { headers: standardWebhooksHeaders({ id: "msg_1", timestampMs: now }) }),
      );
      assert.equal(signed._tag, "accepted");
      yield* Queue.take(launches);

      // Signed more than 5 minutes before it reached T3.
      const stale = yield* service.triggerWebhook(
        requestFor(task, {
          headers: standardWebhooksHeaders({ id: "msg_2", timestampMs: now - 6 * 60_000 }),
        }),
      );
      assert.equal(stale._tag, "rejected_signature");

      // The same age is fine when the relay received it on time and held it.
      const held = yield* service.triggerWebhook(
        requestFor(task, {
          relayDeliveryId: "relay-held",
          receivedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 6 * 60_000 + 1_000)),
          headers: standardWebhooksHeaders({ id: "msg_3", timestampMs: now - 6 * 60_000 }),
        }),
      );
      assert.equal(held._tag, "accepted");
      yield* Queue.take(launches);

      const unsigned = yield* service.triggerWebhook(requestFor(task));
      assert.equal(unsigned._tag, "rejected_signature");
    }),
  ),
);

it.effect("a Standard Webhooks signature needs a base64 secret of at least 24 bytes", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const invalid = yield* service
        .upsert(
          yield* webhookTaskInput({
            schedule: {
              type: "webhook",
              signature: { scheme: "standard_webhooks", secret: "shared-secret" },
            },
          }),
        )
        .pipe(Effect.flip);
      assert.include(invalid.message, "Standard Webhooks signing secret");

      // Switching an HMAC task over without a new secret would keep the old one.
      yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: {
              header: "x-hub-signature-256",
              encoding: "hex",
              prefix: "sha256=",
              secret: "github-secret",
            },
          },
        }),
      );
      const switched = yield* service
        .upsert(
          yield* webhookTaskInput({
            schedule: { type: "webhook", signature: { scheme: "standard_webhooks" } },
          }),
        )
        .pipe(Effect.flip);
      assert.include(switched.message, "Standard Webhooks signing secret");
    }),
  ),
);

const signatureFor = (secret: string) =>
  `sha256=${NodeCrypto.createHmac("sha256", secret).update(pullRequestBody).digest("hex")}`;

/** Count recorded by `t3_webhook_deliveries_total` for one outcome and source. */
const deliveriesCounted = (outcome: string, source: "relay" | "direct") =>
  Metric.snapshot.pipe(
    Effect.map((snapshots) => {
      const found = snapshots.find(
        (snapshot) =>
          snapshot.id === "t3_webhook_deliveries_total" &&
          snapshot.attributes?.outcome === outcome &&
          snapshot.attributes?.source === source,
      );
      return found?.type === "Counter" ? Number(found.state.count) : 0;
    }),
  );

it.effect("counts each handled request by what happened to it", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: {
              header: "x-hub-signature-256",
              encoding: "hex",
              prefix: "sha256=",
              secret: "github-secret",
            },
          },
        }),
      );
      const before = {
        accepted: yield* deliveriesCounted("accepted", "direct"),
        rejected: yield* deliveriesCounted("rejected_signature", "direct"),
        notFound: yield* deliveriesCounted("not_found", "direct"),
        relayAccepted: yield* deliveriesCounted("accepted", "relay"),
        duplicate: yield* deliveriesCounted("duplicate", "relay"),
      };
      const signed = {
        "content-type": "application/json",
        "x-hub-signature-256": signatureFor("github-secret"),
      };
      yield* service.triggerWebhook(requestFor(task, { headers: signed }));
      yield* Queue.take(launches);
      yield* service.triggerWebhook(requestFor(task));
      yield* service.triggerWebhook(requestFor(task, { token: "wrong" }));
      // A request the relay held, then the same request again.
      const relayed = requestFor(task, { headers: signed, relayDeliveryId: "relay-1" });
      yield* service.triggerWebhook(relayed);
      yield* Queue.take(launches);
      yield* service.triggerWebhook(relayed);

      assert.equal((yield* deliveriesCounted("accepted", "direct")) - before.accepted, 1);
      assert.equal((yield* deliveriesCounted("rejected_signature", "direct")) - before.rejected, 1);
      assert.equal((yield* deliveriesCounted("not_found", "direct")) - before.notFound, 1);
      assert.equal((yield* deliveriesCounted("accepted", "relay")) - before.relayAccepted, 1);
      assert.equal((yield* deliveriesCounted("duplicate", "relay")) - before.duplicate, 1);
    }),
  ),
);

/** A JSON request, signed with `secret` over its raw body when one is given. */
const jsonRequestFor = (
  task: Parameters<typeof requestFor>[0],
  value: unknown,
  options: { readonly secret?: string; readonly headers?: Record<string, string> } = {},
) => {
  const bodyText = JSON.stringify(value);
  const body = new TextEncoder().encode(bodyText);
  const signature =
    options.secret === undefined
      ? {}
      : {
          "x-hub-signature-256": `sha256=${NodeCrypto.createHmac("sha256", options.secret).update(body).digest("hex")}`,
        };
  return requestFor(task, {
    body,
    bodyText,
    headers: { "content-type": "application/json", ...signature, ...options.headers },
  });
};

const signedWebhook = {
  type: "webhook",
  signature: {
    header: "x-hub-signature-256",
    encoding: "hex",
    prefix: "sha256=",
    secret: "s3cret",
  },
} as const;

it.effect("a sender's retry of the same delivery id runs once and is logged as a duplicate", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: { type: "webhook", deliveryId: { type: "header", name: "X-GitHub-Delivery" } },
        }),
      );
      assert.deepEqual(task.schedule.type === "webhook" ? task.schedule.deliveryId : null, {
        type: "header",
        name: "x-github-delivery",
      });
      const withId = (id: string) =>
        requestFor(task, {
          headers: { "content-type": "application/json", "x-github-delivery": id },
        });
      const first = yield* service.triggerWebhook(withId("abc"));
      assert.equal(first._tag === "accepted" && first.outcome, "accepted");
      yield* Queue.take(launches);
      const retry = yield* service.triggerWebhook(withId("abc"));
      assert.equal(retry._tag === "accepted" && retry.outcome, "duplicate");
      const other = yield* service.triggerWebhook(withId("def"));
      assert.equal(other._tag === "accepted" && other.outcome, "accepted");
      yield* Queue.take(launches);
      assert.equal(yield* Queue.size(launches), 0);

      const logged = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      assert.deepEqual(logged.map((delivery) => delivery.outcome).toSorted(), [
        "accepted",
        "accepted",
        "duplicate",
      ]);
      // The duplicate has its own entry; the original stays as it was.
      assert.equal(
        logged.find(
          (delivery) => delivery.id === (first._tag === "accepted" ? first.deliveryId : ""),
        )?.outcome,
        "accepted",
      );
    }),
  ),
);

it.effect(
  "a signed body delivery id stops replays, and only an authenticated request claims it",
  () =>
    withService(({ service, launches }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({
            schedule: { ...signedWebhook, deliveryId: { type: "body", path: "delivery.id" } },
          }),
        );
        const value = { delivery: { id: 42 }, pull_request: { url: "https://example.com/pr/1" } };
        // A forged request carrying the id must not burn it for the real one.
        const forged = yield* service.triggerWebhook(
          jsonRequestFor(task, value, { secret: "wrong" }),
        );
        assert.equal(forged._tag, "rejected_signature");
        const signed = yield* service.triggerWebhook(
          jsonRequestFor(task, value, { secret: "s3cret" }),
        );
        assert.equal(signed._tag === "accepted" && signed.outcome, "accepted");
        yield* Queue.take(launches);
        const replayed = yield* service.triggerWebhook(
          jsonRequestFor(task, value, { secret: "s3cret" }),
        );
        assert.equal(replayed._tag === "accepted" && replayed.outcome, "duplicate");
        // The content type is not signed, so changing it must not change the id read.
        const relabeled = yield* service.triggerWebhook(
          jsonRequestFor(task, value, {
            secret: "s3cret",
            headers: { "content-type": "application/x-www-form-urlencoded" },
          }),
        );
        assert.equal(relabeled._tag === "accepted" && relabeled.outcome, "duplicate");
        assert.equal(yield* Queue.size(launches), 0);
      }),
    ),
);

it.effect("a Standard Webhooks webhook-id is the signed delivery id", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: { scheme: "standard_webhooks", secret: standardWebhooksSecret },
            deliveryId: { type: "header", name: "webhook-id" },
          },
        }),
      );
      const headers = standardWebhooksHeaders({
        id: "msg_1",
        timestampMs: DateTime.toEpochMillis(yield* DateTime.now),
      });
      const first = yield* service.triggerWebhook(requestFor(task, { headers }));
      assert.equal(first._tag === "accepted" && first.outcome, "accepted");
      yield* Queue.take(launches);
      const replayed = yield* service.triggerWebhook(requestFor(task, { headers }));
      assert.equal(replayed._tag === "accepted" && replayed.outcome, "duplicate");
      // The signature covers the trimmed id, so padding it must not dodge the claim.
      const padded = yield* service.triggerWebhook(
        requestFor(task, { headers: { ...headers, "webhook-id": " msg_1 " } }),
      );
      assert.equal(padded._tag === "accepted" && padded.outcome, "duplicate");
      assert.equal(yield* Queue.size(launches), 0);
    }),
  ),
);

it.effect("refuses a request without the configured delivery id", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: { type: "webhook", deliveryId: { type: "body", path: "delivery.id" } },
        }),
      );
      for (const value of [{}, { delivery: { id: "  " } }, { delivery: { id: { nested: 1 } } }]) {
        assert.equal(
          (yield* service.triggerWebhook(jsonRequestFor(task, value)))._tag,
          "invalid_request",
        );
      }
      assert.equal(yield* Queue.size(launches), 0);
      const [delivery] = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      assert.equal(delivery?.outcome, "invalid_request");
      assert.equal(delivery?.error, "The body has no delivery id at delivery.id.");
    }),
  ),
);

it.effect("a delivery refused for a full queue gives its id back for the retry", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    yield* withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            yield* webhookTaskInput({
              schedule: { type: "webhook", deliveryId: { type: "header", name: "x-id" } },
            }),
          );
          const withId = (id: string) =>
            requestFor(task, { headers: { "content-type": "application/json", "x-id": id } });
          yield* service.triggerWebhook(withId("running"));
          yield* Queue.take(launches);
          yield* Effect.forEach(
            Array.from({ length: 19 }, (_, index) => index),
            (index) => service.triggerWebhook(withId(`waiting-${index}`)),
          );
          const refused = yield* service.triggerWebhook(withId("late"));
          assert.deepEqual(refused, { _tag: "rate_limited", outcome: "queue_full" });
          // Still refused for the full queue, not answered as already delivered.
          const retried = yield* service.triggerWebhook(withId("late"));
          assert.deepEqual(retried, { _tag: "rate_limited", outcome: "queue_full" });
          yield* Deferred.succeed(gate, undefined);
        }),
      { gate },
    );
  }),
);

it.effect("refuses a request whose body timestamp is outside the tolerance", () =>
  Effect.gen(function* () {
    // Before the service starts, so its schedulers do not replay 56 years.
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-09T12:00:00Z")));
    yield* withService(({ service, launches }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({
            schedule: {
              ...signedWebhook,
              deliveryTimestamp: { path: "sent_at", toleranceSeconds: 300 },
            },
          }),
        );
        const send = (sentAt: unknown) =>
          service.triggerWebhook(jsonRequestFor(task, { sent_at: sentAt }, { secret: "s3cret" }));
        const nowSeconds = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);

        assert.equal((yield* send(nowSeconds - 600))._tag, "expired");
        assert.equal((yield* send(String((nowSeconds + 600) * 1000)))._tag, "expired");
        assert.equal((yield* send("not a time"))._tag, "invalid_request");
        assert.equal((yield* send(undefined))._tag, "invalid_request");
        assert.equal(yield* Queue.size(launches), 0);

        assert.equal((yield* send(nowSeconds - 60))._tag, "accepted");
        assert.equal((yield* send("2026-10-09T11:58:00Z"))._tag, "accepted");
        assert.equal((yield* send(`${(nowSeconds + 60) * 1000}`))._tag, "accepted");
        yield* Queue.take(launches);

        const expired = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries.find(
          (delivery) => delivery.outcome === "expired",
        );
        assert.equal(
          expired?.error,
          "The delivery timestamp is more than 300 seconds from when it arrived.",
        );
      }),
    );
  }),
);

it.effect("a save that omits replay protection keeps it, and null turns it off", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const deliveryId = { type: "body", path: "id" } as const;
      const deliveryTimestamp = { path: "sent_at", toleranceSeconds: 60 };
      yield* service.upsert(
        yield* webhookTaskInput({ schedule: { type: "webhook", deliveryId, deliveryTimestamp } }),
      );
      const kept = yield* service.upsert(
        yield* webhookTaskInput({ schedule: { type: "webhook", maxDeliveryAgeMinutes: 5 } }),
      );
      assert.deepInclude(kept.task.schedule, { deliveryId, deliveryTimestamp });
      const cleared = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: { type: "webhook", deliveryId: null, deliveryTimestamp: null },
        }),
      );
      assert.deepInclude(cleared.task.schedule, { deliveryId: null, deliveryTimestamp: null });
    }),
  ),
);
