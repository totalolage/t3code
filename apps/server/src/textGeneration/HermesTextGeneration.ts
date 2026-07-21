import { TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { HermesGatewayClient } from "../provider/hermes/HermesGatewayClient.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

export function makeHermesTextGeneration(
  client: HermesGatewayClient | undefined,
): TextGeneration.TextGeneration["Service"] {
  const runJson = <A>(input: {
    readonly operation: string;
    readonly prompt: string;
    readonly schema: Schema.Codec<A, unknown>;
    readonly model: string;
  }) =>
    Effect.gen(function* () {
      if (!client) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Configure the Hermes gateway before using it for text generation.",
        });
      }
      const output = yield* Effect.tryPromise({
        try: (signal) =>
          client.chatCompletion(
            {
              model: input.model,
              messages: [{ role: "user", content: input.prompt }],
            },
            signal,
          ),
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Hermes text generation failed.",
            cause,
          }),
      });
      const decodeOutput = Schema.decodeUnknownEffect(input.schema);
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
    });

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
          prompt,
          schema: outputSchema,
          model: input.modelSelection.model,
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
        prompt,
        schema: outputSchema,
        model: input.modelSelection.model,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    }),
    generateBranchName: Effect.fn("HermesTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt(input);
      const generated = yield* runJson({
        operation: "generateBranchName",
        prompt,
        schema: outputSchema,
        model: input.modelSelection.model,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    }),
    generateThreadTitle: Effect.fn("HermesTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt(input);
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        prompt,
        schema: outputSchema,
        model: input.modelSelection.model,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    }),
  };
}
