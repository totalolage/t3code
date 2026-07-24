import { type HermesSettings, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  applyHermesAcpSelection,
  currentHermesModelIdFromSessionSetup,
  makeHermesAcpRuntime,
} from "../provider/acp/HermesAcpSupport.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const HERMES_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

export const makeHermesTextGeneration = Effect.fn("makeHermesTextGeneration")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runJson = <A>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly schema: Schema.Codec<A, unknown>;
    readonly modelSelection: ModelSelection;
  }) =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeHermesAcpRuntime({
        hermesSettings,
        environment,
        childProcessSpawner,
        cwd: input.cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      yield* runtime.handleRequestPermission((request) =>
        Effect.succeed({
          outcome: request.options.find((option) => option.kind === "reject_once")
            ? {
                outcome: "selected" as const,
                optionId: request.options.find((option) => option.kind === "reject_once")!.optionId,
              }
            : ({ outcome: "cancelled" } as const),
        }),
      );
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") return Effect.void;
        const content = update.content;
        return content.type === "text"
          ? Ref.update(outputRef, (current) => current + content.text)
          : Effect.void;
      });

      const promptResult = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        yield* applyHermesAcpSelection({
          runtime,
          currentModelId: currentHermesModelIdFromSessionSetup(started.sessionSetupResult),
          selection: input.modelSelection,
          mapError: ({ cause, method }) =>
            new TextGenerationError({
              operation: input.operation,
              detail: `Failed to configure Hermes through ACP (${method}).`,
              cause,
            }),
        });
        return yield* runtime.prompt({
          prompt: [{ type: "text", text: input.prompt }],
        });
      }).pipe(
        Effect.timeoutOption(HERMES_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: "Hermes ACP request timed out.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "Hermes ACP request failed.",
                cause,
              }),
        ),
      );

      const output = (yield* Ref.get(outputRef)).trim();
      if (!output) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Hermes ACP request was cancelled."
              : "Hermes returned empty output.",
        });
      }
      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.schema));
      return yield* decodeOutput(extractJsonObject(output)).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Hermes returned invalid structured text-generation output.",
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: "Hermes ACP text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  return {
    generateCommitMessage: Effect.fn("HermesTextGeneration.generateCommitMessage")(
      function* (input) {
        const { prompt, outputSchema } = buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch ?? false,
        });
        const generated = yield* runJson({
          operation: "generateCommitMessage",
          cwd: input.cwd,
          prompt,
          schema: outputSchema,
          modelSelection: input.modelSelection,
        });
        return {
          subject: sanitizeCommitSubject(generated.subject),
          body: generated.body.trim(),
          ...("branch" in generated
            ? { branch: sanitizeFeatureBranchName(String(generated.branch)) }
            : {}),
        };
      },
    ),
    generatePrContent: Effect.fn("HermesTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt(input);
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        schema: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    }),
    generateBranchName: Effect.fn("HermesTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt(input);
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        schema: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    }),
    generateThreadTitle: Effect.fn("HermesTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt(input);
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        schema: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    }),
  };
});
