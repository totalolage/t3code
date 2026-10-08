import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [{ kind: "npx" }, { kind: "npm-global", prefix: "/opt/node" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    for (const installation of [{ kind: "future-manager" }, { kind: "npm-global" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });
  it("requires an advertised required-worktree bootstrap capability", () => {
    expect(decodeDescriptor(descriptor).capabilities.requiredWorktreeBootstrap).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, requiredWorktreeBootstrap: true },
      }).capabilities.requiredWorktreeBootstrap,
    ).toBe(true);
  });

  it("treats a missing pull-request capability as unsupported under version skew", () => {
    const decoded = decodeDescriptor(descriptor);

    expect(decoded.capabilities).toEqual(descriptor.capabilities);
    expect(decoded.capabilities.pullRequests).toBeUndefined();
  });

  it("preserves an advertised pull-request capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, pullRequests: true },
      }).capabilities.pullRequests,
    ).toBe(true);
  });

  it("decodes missing, false, and true thread-hiding capability values", () => {
    expect(decodeDescriptor(descriptor).capabilities.threadHiding).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, threadHiding: false },
      }).capabilities.threadHiding,
    ).toBe(false);
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, threadHiding: true },
      }).capabilities.threadHiding,
    ).toBe(true);
  });

  it("treats a missing attachment upload capability as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.attachmentUploads).toBeUndefined();
  });

  it("preserves an advertised attachment upload capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, attachmentUploads: true },
      }).capabilities.attachmentUploads,
    ).toBe(true);
  });

  it("treats scheduled service updates as unsupported when the capability is absent", () => {
    expect(decodeDescriptor(descriptor).capabilities.scheduledServiceUpdates).toBeUndefined();
  });

  it("preserves the versioned scheduled service-update capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, scheduledServiceUpdates: 1 },
      }).capabilities.scheduledServiceUpdates,
    ).toBe(1);
    expect(() =>
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, scheduledServiceUpdates: true },
      }),
    ).toThrow();
  });

  it("treats missing orchestration capabilities as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.orchestration).toBeUndefined();
  });

  it("defaults pending interactions and preserves orchestration capability flags", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          orchestration: {
            cliApiVersion: 2,
            serverAuthoritativeCreate: true,
            watchResume: false,
            manualThreadCompaction: true,
          },
        },
      }).capabilities.orchestration,
    ).toEqual({
      pendingInteractions: false,
      cliApiVersion: 2,
      serverAuthoritativeCreate: true,
      watchResume: false,
      manualThreadCompaction: true,
    });
  });

  it("defaults pending interactions when orchestration is present but empty", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, orchestration: {} },
      }).capabilities.orchestration,
    ).toEqual({ pendingInteractions: false });
  });

  it("preserves an explicitly advertised pending-interactions capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          orchestration: { pendingInteractions: true },
        },
      }).capabilities.orchestration?.pendingInteractions,
    ).toBe(true);
  });

  it("preserves the server's generic attachment upload limit", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
        },
      }).capabilities.fileAttachments,
    ).toEqual({ maxUploadBytes: 50 * 1024 * 1024 });
  });

  it("treats missing server-resolved command context as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverResolvedCommandContext).toBeUndefined();
  });

  it("preserves advertised server-resolved command context", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          serverResolvedCommandContext: true,
        },
      }).capabilities.serverResolvedCommandContext,
    ).toBe(true);
  });

  it("preserves each orchestration capability", () => {
    const orchestration = {
      pendingInteractions: true,
      cliApiVersion: 3,
      serverAuthoritativeCreate: true,
      watchResume: false,
      manualThreadCompaction: true,
    } as const;

    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, orchestration },
      }).capabilities.orchestration,
    ).toEqual(orchestration);
  });

  it("rejects a non-integer orchestration CLI API version", () => {
    expect(() =>
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          orchestration: { cliApiVersion: 1.5 },
        },
      }),
    ).toThrow();
  });
});
