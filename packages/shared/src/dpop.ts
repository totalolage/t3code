import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  DpopPublicJwk as DpopPublicJwkSchema,
  normalizeDpopHtuOption,
  type DpopPublicJwk as DpopPublicJwkType,
} from "./dpopCommon.ts";
import { stableStringify } from "./relaySigning.ts";

export const DpopPublicJwk = DpopPublicJwkSchema;
export type DpopPublicJwk = DpopPublicJwkType;
export { normalizeDpopHtu, normalizeDpopHtuOption } from "./dpopCommon.ts";

const DPOP_TYP = "dpop+jwt";
const DPOP_ALG = "ES256";
const DEFAULT_MAX_AGE_SECONDS = 300;

interface DpopJwtPayload {
  readonly htm: string;
  readonly htu: string;
  readonly jti: string;
  readonly iat: number;
  readonly ath?: string | undefined;
}

const DpopJwtHeaderSchema = Schema.Struct({
  typ: Schema.Literal(DPOP_TYP),
  alg: Schema.Literal(DPOP_ALG),
  jwk: DpopPublicJwkSchema,
});
const decodeDpopJwtHeader = Schema.decodeUnknownOption(DpopJwtHeaderSchema);

const DpopJwtPayloadSchema = Schema.Struct({
  htm: Schema.String.check(Schema.isNonEmpty()),
  htu: Schema.String.check(Schema.isNonEmpty()),
  jti: Schema.String.check(Schema.isNonEmpty()),
  iat: Schema.Number.check(Schema.isInt()),
  ath: Schema.optional(Schema.String),
});
const decodeDpopJwtPayload = Schema.decodeUnknownOption(DpopJwtPayloadSchema);

const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export type DpopVerificationResult =
  | {
      readonly ok: true;
      readonly thumbprint: string;
      readonly jti: string;
      readonly iat: number;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

function base64UrlToBytes(value: string): Uint8Array {
  return Result.getOrThrow(Encoding.decodeBase64Url(value));
}

function decodeBase64UrlJson(value: string): Option.Option<unknown> {
  const decoded = Encoding.decodeBase64UrlString(value);
  return Result.isSuccess(decoded) ? decodeJsonString(decoded.success) : Option.none();
}

function dpopJwtHeaderHasPrivateJwkMaterial(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const jwk = (value as Record<string, unknown>).jwk;
  return typeof jwk === "object" && jwk !== null && "d" in jwk;
}

function decodeDpopJwtPayloadPart(value: string): Option.Option<DpopJwtPayload> {
  return decodeBase64UrlJson(value).pipe(Option.flatMap(decodeDpopJwtPayload));
}

function dpopThumbprintInput(jwk: DpopPublicJwkType): string {
  return stableStringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
}

export function computeDpopJwkThumbprint(jwk: DpopPublicJwkType): string {
  return Encoding.encodeBase64Url(sha256(new TextEncoder().encode(dpopThumbprintInput(jwk))));
}

export function computeDpopAccessTokenHash(accessToken: string): string {
  return Encoding.encodeBase64Url(sha256(new TextEncoder().encode(accessToken)));
}

function publicKeyBytesFromJwk(jwk: DpopPublicJwkType): Uint8Array {
  const x = base64UrlToBytes(jwk.x);
  const y = base64UrlToBytes(jwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("Invalid P-256 public key coordinate length.");
  }
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(x, 1);
  publicKey.set(y, 33);
  return publicKey;
}

export function verifyDpopProof(input: {
  readonly proof: string | null | undefined;
  readonly method: string;
  readonly url: string;
  readonly nowEpochSeconds: number;
  readonly expectedThumbprint?: string;
  readonly expectedAccessToken?: string;
  readonly maxAgeSeconds?: number;
}): DpopVerificationResult {
  if (!input.proof?.trim()) {
    return { ok: false, reason: "Missing DPoP proof." };
  }

  const parts = input.proof.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, reason: "Invalid DPoP compact JWT." };
  }

  try {
    const rawHeader = Option.getOrNull(decodeBase64UrlJson(parts[0]));
    const header = rawHeader === null ? null : Option.getOrNull(decodeDpopJwtHeader(rawHeader));
    const payload = Option.getOrNull(decodeDpopJwtPayloadPart(parts[1]));
    if (header === null || dpopJwtHeaderHasPrivateJwkMaterial(rawHeader)) {
      return { ok: false, reason: "Invalid DPoP JWT header." };
    }
    if (payload === null) {
      return { ok: false, reason: "Invalid DPoP JWT payload." };
    }

    const thumbprint = computeDpopJwkThumbprint(header.jwk);
    if (input.expectedThumbprint && thumbprint !== input.expectedThumbprint) {
      return { ok: false, reason: "DPoP key thumbprint mismatch." };
    }
    if (payload.htm.toUpperCase() !== input.method.toUpperCase()) {
      return { ok: false, reason: "DPoP method mismatch." };
    }
    const normalizedHtu = Option.getOrNull(normalizeDpopHtuOption(input.url));
    if (normalizedHtu === null || payload.htu !== normalizedHtu) {
      return { ok: false, reason: "DPoP URL mismatch." };
    }
    if (input.expectedAccessToken) {
      const expectedAth = computeDpopAccessTokenHash(input.expectedAccessToken);
      if (payload.ath !== expectedAth) {
        return { ok: false, reason: "DPoP access token hash mismatch." };
      }
    }

    const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    if (
      payload.iat > input.nowEpochSeconds + 5 ||
      input.nowEpochSeconds - payload.iat > maxAgeSeconds
    ) {
      return { ok: false, reason: "DPoP proof is outside the allowed time window." };
    }

    const signature = base64UrlToBytes(parts[2]);
    const signatureInputHash = sha256(new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    const verified = p256.verify(signature, signatureInputHash, publicKeyBytesFromJwk(header.jwk), {
      prehash: false,
      format: "compact",
    });
    return verified
      ? {
          ok: true,
          thumbprint,
          jti: payload.jti,
          iat: payload.iat,
        }
      : { ok: false, reason: "Invalid DPoP signature." };
  } catch {
    return { ok: false, reason: "Invalid DPoP proof." };
  }
}
