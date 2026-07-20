import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { executeEnvironmentHttpRequest } from "./http.ts";

describe("remote environment HTTP errors", () => {
  it.effect("redacts query values from user-facing request errors", () =>
    Effect.gen(function* () {
      const error = yield* executeEnvironmentHttpRequest(
        "https://remote.example.test/api/test?proxy=secret-value&tag=one&tag=two",
        1_000,
        Effect.fail("network failed"),
      ).pipe(Effect.flip);

      expect(error.message).toContain("proxy=%5BREDACTED%5D");
      expect(error.message).toContain("tag=%5BREDACTED%5D");
      expect(error.message).not.toContain("secret-value");
      expect(error.message).not.toContain("tag=one");
    }),
  );
});
