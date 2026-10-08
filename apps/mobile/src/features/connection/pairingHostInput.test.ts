import { describe, expect, it } from "vite-plus/test";

import { applyPairingHostInput } from "./pairingHostInput";

const withCode = {
  host: "backend.example",
  code: "entered-code",
  queryParameters: [{ key: "route", value: "old" }],
};

describe("applyPairingHostInput", () => {
  it("keeps the entered pairing code when a tokenless parameter URL is pasted", () => {
    expect(applyPairingHostInput(withCode, "https://other.example?route=one&route=two")).toEqual({
      host: "https://other.example",
      code: "entered-code",
      queryParameters: [
        { key: "route", value: "one" },
        { key: "route", value: "two" },
      ],
    });
  });

  it("replaces the code when the pasted URL carries one", () => {
    expect(
      applyPairingHostInput(withCode, "https://other.example/pair#token=pasted-token"),
    ).toEqual({
      host: "https://other.example",
      code: "pasted-token",
      queryParameters: [],
    });
  });

  it("treats a bare host paste as plain host text and keeps code and parameters", () => {
    expect(applyPairingHostInput(withCode, "10.0.0.8:3773")).toEqual({
      host: "10.0.0.8:3773",
      code: "entered-code",
      queryParameters: [{ key: "route", value: "old" }],
    });
  });

  it("imports an empty fields state from a full pairing URL without entered text", () => {
    expect(
      applyPairingHostInput(
        { host: "", code: "", queryParameters: [] },
        "https://backend.example?route=one#token=pairing-token",
      ),
    ).toEqual({
      host: "https://backend.example",
      code: "pairing-token",
      queryParameters: [{ key: "route", value: "one" }],
    });
  });

  it("keeps the code when a tokenless URL only has parameters that fail normalization", () => {
    // Empty-key parameters still read as a URL paste; they pass through unnormalized
    // and are rejected later by buildPairingConnectionInput, but the code survives.
    expect(applyPairingHostInput(withCode, "https://other.example?=dropped&=again")).toEqual({
      host: "https://other.example",
      code: "entered-code",
      queryParameters: [
        { key: "", value: "dropped" },
        { key: "", value: "again" },
      ],
    });
  });
});
