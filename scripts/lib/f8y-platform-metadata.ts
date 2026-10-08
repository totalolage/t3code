const MAX_VERSION_CODE = 2_100_000_000;
const ELF64_HEADER_SIZE = 64;

const F8Y_PLATFORM_VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-f8y\.([0-9]{8})\.([1-9][0-9]*)$/u;
const CANONICAL_VERSION_CODE_PATTERN = /^[1-9][0-9]*$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/iu;
const SHA256_COLON_PATTERN = /^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/iu;
const PACKAGE_ATTRIBUTE_KEY_PATTERN = /(?:^|\s)(name|versionCode|versionName)\s*=/gu;
const PACKAGE_QUOTED_ATTRIBUTE_PATTERN =
  /(?:^|\s)(name|versionCode|versionName)\s*=\s*(['"])([^'"]*)\2(?=\s|$)/gu;
const ANDROID_VERSION_CODE_PATTERN = /(?:^|\s)versionCode='([0-9]+)'(?:\s|$)/u;
const SIGNER_SHA256_PATTERN = /certificate SHA-256 digest:\s*(.*)$/u;

export function parseF8yPlatformVersion(value: string): { version: string; versionCode: number } {
  if (typeof value !== "string") {
    throw new TypeError("F8y platform version must be a string.");
  }

  const match = F8Y_PLATFORM_VERSION_PATTERN.exec(value);
  if (match === null || match[0] !== value) {
    throw new Error("F8y platform version must be canonical X.Y.Z-f8y.YYYYMMDD.RUN.");
  }

  const date = match[4];
  const run = match[5];
  if (date === undefined || run === undefined || !isValidCalendarDate(date)) {
    throw new Error("F8y platform version must contain a valid YYYYMMDD calendar date.");
  }

  return { version: value, versionCode: parseCanonicalVersionCode(run, "Version run") };
}

export function normalizeCertificateSha256(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("Certificate SHA-256 must be a string.");
  }
  const plainMatch = SHA256_HEX_PATTERN.exec(value);
  if (plainMatch !== null && plainMatch[0] === value) {
    return value.toLowerCase();
  }
  const colonMatch = SHA256_COLON_PATTERN.exec(value);
  if (colonMatch !== null && colonMatch[0] === value) {
    return value.replaceAll(":", "").toLowerCase();
  }
  throw new Error("Certificate SHA-256 must be 64 hex characters or 32 colon-separated bytes.");
}

export function validateMacInfoPlist(value: unknown, version: string): string {
  if (typeof version !== "string") {
    throw new TypeError("macOS metadata version must be a string.");
  }

  const plist = requireRecord(value, "macOS Info.plist");
  requireExactField(plist, "CFBundleIdentifier", "dev.f8y.t3code", "macOS Info.plist");
  requireExactField(plist, "CFBundleShortVersionString", version, "macOS Info.plist");

  const executable = plist.CFBundleExecutable;
  if (
    !hasOwn(plist, "CFBundleExecutable") ||
    typeof executable !== "string" ||
    executable.length === 0 ||
    executable === "." ||
    executable === ".." ||
    /[\\/]/u.test(executable)
  ) {
    throw new Error("macOS Info.plist CFBundleExecutable must be one filename.");
  }

  return executable;
}

export function validateMacSignature(output: string): void {
  const lines = requireText(output, "macOS signature output").split(/\r?\n/u);
  const signatureLines = lines.filter((line) => line.startsWith("Signature="));
  if (signatureLines.length !== 1 || signatureLines[0] !== "Signature=adhoc") {
    throw new Error("macOS signature output must contain exactly one Signature=adhoc line.");
  }
}

export function validateMacEntitlements(value: unknown): void {
  const entitlements = requireRecord(value, "macOS entitlements");
  if (hasOwn(entitlements, "com.apple.developer.associated-domains")) {
    throw new Error("macOS entitlements must not contain associated domains.");
  }
}

export function validateArm64Architectures(output: string): void {
  if (requireText(output, "arm64 architecture output").trim() !== "arm64") {
    throw new Error("Architecture output must contain exactly arm64.");
  }
}

export function validateLinuxPackage(value: unknown, version: string): void {
  if (typeof version !== "string") {
    throw new TypeError("Linux package version must be a string.");
  }
  const packageMetadata = requireRecord(value, "Linux package metadata");
  requireExactField(packageMetadata, "version", version, "Linux package metadata");
}

export function validateLinuxUpdater(value: unknown): void {
  const updater = requireRecord(value, "Linux updater metadata");
  const expectedFields = {
    provider: "github",
    owner: "totalolage",
    repo: "t3code",
    channel: "f8y",
  } as const;

  for (const [key, expectedValue] of Object.entries(expectedFields)) {
    requireExactField(updater, key, expectedValue, "Linux updater metadata");
  }
  if (hasOwn(updater, "host")) {
    requireExactField(updater, "host", "github.com", "Linux updater metadata");
  }
  if (hasOwn(updater, "protocol")) {
    requireExactField(updater, "protocol", "https", "Linux updater metadata");
  }
}

export function validateElfX64(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < ELF64_HEADER_SIZE) {
    throw new Error("ELF executable must contain a complete ELF64 header.");
  }

  const hasElfMagic =
    bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
  const machine = (bytes[18] ?? 0) | ((bytes[19] ?? 0) << 8);
  if (!hasElfMagic || bytes[4] !== 2 || bytes[5] !== 1 || machine !== 62) {
    throw new Error("ELF executable must be a little-endian ELF64 x86_64 binary.");
  }
}

export function validateAndroidBadging(output: string, version: string): number {
  if (typeof version !== "string") {
    throw new TypeError("Android package version must be a string.");
  }
  const expected = parseF8yPlatformVersion(version);
  const parsed = parseAndroidBadging(output);
  if (parsed.versionName !== version) {
    throw new Error("Android package versionName must exactly match the f8y version.");
  }
  if (parsed.versionCode !== expected.versionCode) {
    throw new Error("Android package versionCode must equal the f8y version run.");
  }
  return parsed.versionCode;
}

export function parseAndroidBadging(output: string): {
  readonly versionName: string;
  readonly versionCode: number;
} {
  const lines = requireText(output, "Android badging output").split(/\r?\n/u);
  const packageLines = lines.filter((line) => line.startsWith("package:"));
  if (packageLines.length !== 1) {
    throw new Error("Android badging output must contain exactly one package: line.");
  }

  const packageAttributes = parsePackageAttributes(packageLines[0] ?? "");
  const packageName = requireExactlyOnePackageAttribute(packageAttributes, "name");
  const versionCodeText = requireExactlyOnePackageAttribute(packageAttributes, "versionCode");
  const versionName = requireExactlyOnePackageAttribute(packageAttributes, "versionName");

  if (packageName !== "dev.f8y.t3code") {
    throw new Error("Android package name must be dev.f8y.t3code.");
  }
  const parsedVersion = parseF8yPlatformVersion(versionName);
  const versionCode = parseCanonicalVersionCode(versionCodeText, "Android versionCode");
  if (versionCode !== parsedVersion.versionCode) {
    throw new Error("Android package versionCode must equal the f8y version run.");
  }
  return { versionName, versionCode };
}

export function parseAndroidVersionCode(output: string): number {
  const firstLine = requireText(output, "Android badging output").split(/\r?\n/u)[0] ?? "";
  const match = ANDROID_VERSION_CODE_PATTERN.exec(firstLine);
  const versionCodeText = match?.[1];
  if (versionCodeText === undefined) {
    throw new Error("Android package line must contain a numeric versionCode attribute.");
  }
  const versionCode = Number(versionCodeText);
  if (!Number.isSafeInteger(versionCode)) {
    throw new Error("Android package versionCode must be a safe integer.");
  }
  return versionCode;
}

export function validateAndroidSigner(output: string): string {
  const lines = requireText(output, "Android signer output").split(/\r?\n/u);
  const digestLine = lines.find((line) => SIGNER_SHA256_PATTERN.test(line));
  const digest = digestLine === undefined ? undefined : SIGNER_SHA256_PATTERN.exec(digestLine)?.[1];
  if (digest === undefined) {
    throw new Error("Android signer output must contain a certificate SHA-256 digest.");
  }
  return normalizeCertificateSha256(digest);
}

function parseCanonicalVersionCode(value: string, label: string): number {
  const match = typeof value === "string" ? CANONICAL_VERSION_CODE_PATTERN.exec(value) : null;
  if (match === null || match[0] !== value) {
    throw new Error(`${label} must be a canonical decimal from 1 to ${MAX_VERSION_CODE}.`);
  }

  const versionCode = Number(value);
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > MAX_VERSION_CODE) {
    throw new Error(`${label} must be a canonical decimal from 1 to ${MAX_VERSION_CODE}.`);
  }
  return versionCode;
}

function isValidCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) {
    return false;
  }

  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maximumDay = daysInMonth[month - 1];
  return maximumDay !== undefined && day <= maximumDay;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be a record.`);
  }
  return value;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function requireExactField(
  record: Record<string, unknown>,
  key: string,
  expected: string,
  label: string,
): void {
  if (!hasOwn(record, key) || record[key] !== expected) {
    throw new Error(`${label} field ${key} must exactly equal '${expected}'.`);
  }
}

interface ParsedPackageAttributes {
  readonly keyCounts: ReadonlyMap<string, number>;
  readonly quotedValues: ReadonlyMap<string, readonly string[]>;
}

function parsePackageAttributes(line: string): ParsedPackageAttributes {
  const attributeText = line.slice("package:".length);
  const keyCounts = new Map<string, number>();
  for (const match of attributeText.matchAll(PACKAGE_ATTRIBUTE_KEY_PATTERN)) {
    const key = match[1];
    if (key === undefined) continue;
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  const quotedValues = new Map<string, string[]>();
  for (const match of attributeText.matchAll(PACKAGE_QUOTED_ATTRIBUTE_PATTERN)) {
    const key = match[1];
    const value = match[3];
    if (key === undefined || value === undefined) continue;
    const values = quotedValues.get(key) ?? [];
    values.push(value);
    quotedValues.set(key, values);
  }

  return { keyCounts, quotedValues };
}

function requireExactlyOnePackageAttribute(
  attributes: ParsedPackageAttributes,
  key: string,
): string {
  const keyCount = attributes.keyCounts.get(key) ?? 0;
  const values = attributes.quotedValues.get(key) ?? [];
  const value = values[0];
  if (keyCount !== 1 || values.length !== 1 || value === undefined) {
    throw new Error(`Android package line must contain exactly one quoted ${key} attribute.`);
  }
  return value;
}
