import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { ServiceUpdateScheduler } from "./cloud/serviceUpdateScheduler.ts";

import * as ServerConfig from "./config.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as PendingInteractionQuery from "./orchestration-v2/PendingInteractionQuery.ts";
import * as PendingInteractionService from "./orchestration-v2/PendingInteractionService.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as CommandReceiptStore from "./orchestration-v2/CommandReceiptStore.ts";
import * as IdAllocator from "./orchestration-v2/IdAllocator.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as Keybindings from "./keybindings.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ProviderMaintenance from "./provider/providerMaintenance.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as AcpRegistrySupport from "./provider/acp/AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "./provider/acp/AcpRegistryRuntimeCoordinator.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as RuntimeLayer from "./orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as OrchestrationCommandReceipts from "./persistence/OrchestrationCommandReceipts.ts";
import { PendingInteractionResponseRepositoryLive } from "./persistence/PendingInteractionResponses.ts";
import * as ProviderAdapterRegistry from "./orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeRoutesLayer } from "./server.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as CloudCliTokenManager from "./cloud/CliTokenManager.ts";
import * as CloudManagedEndpointRuntime from "./cloud/ManagedEndpointRuntime.ts";
import * as CloudLink from "./cloud/CloudLink.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as GitHubApi from "./sourceControl/GitHubApi.ts";
import * as GitHubCredentials from "./sourceControl/GitHubCredentials.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";
import * as RelayClient from "@t3tools/shared/relayClient";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-service-update-server-rpc-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const databaseLayer = SqlitePersistence.layerMemory.pipe(Layer.orDie);
const applicationEventStoreLayer = OrchestrationEventStore.layer;
const orchestrationCommandReceiptRepositoryLayer = OrchestrationCommandReceipts.layer;
const projectEnrichmentLayer = Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
  peek: () =>
    Effect.succeed({
      repositoryIdentity: null,
      faviconPath: null,
      repositoryIdentityResolved: false,
    }),
  request: () => Effect.void,
  getAvailable: () =>
    Effect.succeed({
      repositoryIdentity: null,
      faviconPath: null,
      repositoryIdentityResolved: false,
    }),
  invalidate: () => Effect.void,
  subscribeChanges: Effect.die("Project enrichment is not used by a status RPC."),
});
const nativeRuntimeLayer = Layer.mergeAll(
  ProviderReplayHarness.layerWithRegistry(
    { name: "service-update-server-rpc" },
    Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
      get: () => Effect.die("No provider adapter should be requested by a status RPC."),
      list: () => Effect.succeed([]),
    }),
    { databaseLayer },
  ),
);
const launcherLayer = ServiceLauncherClient.layer.pipe(
  Layer.provide(Layer.succeed(HostProcessEnvironment, {})),
);
const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(databaseLayer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("service-update-server-rpc")),
    }),
  ),
);
const projectServiceLayer = RuntimeLayer.layerProjectService.pipe(
  Layer.provide(projectEnrichmentLayer),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(nativeRuntimeLayer),
);
const serverSettingsLayer = ServerSettingsService.layerTest({ serviceUpdateRepository: "" });
const worktreeSetupTrackerLayer = Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker, {});
const projectCloneTrackerLayer = Layer.mock(ProjectCloneTracker.ProjectCloneTracker, {});
const terminalManagerLayer = Layer.mock(TerminalManager.TerminalManager, {});
const gitWorkflowLayer = Layer.mock(GitWorkflowService.GitWorkflowService, {});
const projectSetupScriptRunnerLayer = Layer.mock(
  ProjectSetupScriptRunner.ProjectSetupScriptRunner,
  {},
);
const providerRegistryLayer = Layer.mock(ProviderRegistry.ProviderRegistry, {});
const textGenerationLayer = Layer.mock(TextGeneration.TextGeneration, {});
const managedProjectFoldersLayer = Layer.mock(ManagedProjectFolders.ManagedProjectFolders, {
  namedProjectsRoot: process.cwd(),
});
const testBootstrapToken = "service-update-server-rpc-test-bootstrap-token";
const routeTestConfigLayer = Layer.effect(
  ServerConfig.ServerConfig,
  ServerConfig.ServerConfig.pipe(
    Effect.map((config) => ({
      ...config,
      mode: "web" as const,
      host: "127.0.0.1",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make("service-update-server-rpc-test-token"),
      desktopBootstrapToken: testBootstrapToken,
      noBrowser: true,
    })),
  ),
).pipe(Layer.provide(configLayer));
const commandReceiptStoreLayer = CommandReceiptStore.layerFromApplicationReceipts.pipe(
  Layer.provide(orchestrationCommandReceiptRepositoryLayer),
);
const threadManagementLayer = ThreadManagementService.layer.pipe(Layer.provide(nativeRuntimeLayer));
const pendingInteractionQueryLayer = PendingInteractionQuery.PendingInteractionQueryLive.pipe(
  Layer.provide(nativeRuntimeLayer),
);
const pendingInteractionServiceLayer = PendingInteractionService.PendingInteractionServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(PendingInteractionResponseRepositoryLive, pendingInteractionQueryLayer).pipe(
      Layer.provideMerge(nativeRuntimeLayer),
    ),
  ),
);
const threadLaunchLayer = ThreadLaunchService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      applicationEventStoreLayer,
      threadManagementLayer,
      commandReceiptStoreLayer,
      IdAllocator.layer,
      worktreeSetupTrackerLayer,
      projectCloneTrackerLayer,
      terminalManagerLayer,
      gitWorkflowLayer,
      projectSetupScriptRunnerLayer,
      providerRegistryLayer,
      serverSettingsLayer,
      textGenerationLayer,
      managedProjectFoldersLayer,
    ).pipe(Layer.provideMerge(projectServiceLayer)),
  ),
);
const serverRuntimeStartupLayer = Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, {
  awaitCommandReady: Effect.void,
  markHttpListening: Effect.void,
  enqueueCommand: (effect) => effect,
});
const wsBoundaryLayer = Layer.mergeAll(
  Layer.mock(AnalyticsService.AnalyticsService, { record: () => Effect.void }),
  Layer.mock(ScheduledTasks.ScheduledTaskService, {}),
  Layer.mock(SecretRequests.SecretRequests, {}),
  Layer.mock(PullRequestService.PullRequestService, {}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor, {}),
  Layer.mock(DeviceService.DeviceService, {}),
  Layer.mock(UsageService.UsageService, {}),
  Layer.mock(UsageLimitSources.UsageLimitSources, {}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery, {}),
  Layer.mock(Keybindings.Keybindings, {}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService, {}),
  Layer.mock(ExternalLauncher.ExternalLauncher, {}),
  Layer.mock(RemoteOpenTargets.RemoteOpenTargets, {}),
  gitWorkflowLayer,
  Layer.mock(ReviewService.ReviewService, {}),
  Layer.mock(VcsProvisioningService.VcsProvisioningService, {}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster, {}),
  terminalManagerLayer,
  Layer.mock(PreviewManager.PreviewManager, {}),
  Layer.mock(PortScanner.PortDiscovery, {}),
  providerRegistryLayer,
  Layer.mock(ModelManifest.ModelManifest, {}),
  Layer.succeed(
    ProviderMaintenance.ProviderVersionCache,
    new Map<string, ProviderMaintenance.ProviderVersionCacheEntry>(),
  ),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry, {}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog, {}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator, {}),
  Layer.mock(ProviderAuthService.ProviderAuthService, {}),
  ServerLifecycleEvents.layer,
  Layer.mock(WorkspaceEntries.WorkspaceEntries, {}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem, {}),
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("service-update-server-rpc")),
    getDescriptor: Effect.die(
      "The service update status RPC does not use the environment descriptor.",
    ),
  }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy, {}),
  projectCloneTrackerLayer,
  worktreeSetupTrackerLayer,
  projectSetupScriptRunnerLayer,
  managedProjectFoldersLayer,
  textGenerationLayer,
  Layer.mock(AgentSessionImporter.AgentSessionImporter, {}),
  threadLaunchLayer,
  ThreadSearch.layer.pipe(Layer.provide(nativeRuntimeLayer)),
  serverRuntimeStartupLayer,
);
const routeBoundaryMocksLayer = Layer.mergeAll(
  Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay, {}),
  Layer.mock(AntigravityInstallation.AntigravityInstallation, {
    managedDirectory: process.cwd(),
  }),
  Layer.mock(BrowserTraceCollector.BrowserTraceCollector, {}),
  Layer.mock(CloudCliTokenManager.CloudCliTokenManager, {}),
  Layer.mock(CloudManagedEndpointRuntime.CloudManagedEndpointRuntime, {}),
  Layer.mock(CloudLink.CloudLink, {}),
  Layer.mock(DirectEndpoints.DirectEndpoints, { resolve: () => Effect.succeed([]) }),
  Layer.mock(GitHubCredentials.GitHubCredentials, {}),
  Layer.mock(CodexInstallation.CodexInstallation, { managedDirectory: process.cwd() }),
  Layer.mock(GitHubApi.GitHubApi, {}),
  Layer.mock(HostResources.HostResources, {}),
  Layer.mock(McpAppRequests.McpAppRequests, {}),
  Layer.mock(McpSessionRegistry.McpSessionRegistry, {}),
  Layer.mock(NativeAppIconResolver.NativeAppIconResolver, {}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics, {}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor, {}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver, {}),
  Layer.mock(RelayClient.RelayClient, {}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry, {}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService, {}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics, {}),
  OtlpSerialization.layerJson,
);

const routeConsumersLayer = Layer.mergeAll(
  serverSettingsLayer,
  pendingInteractionServiceLayer,
  projectEnrichmentLayer,
  projectServiceLayer,
  threadManagementLayer,
  wsBoundaryLayer,
  routeBoundaryMocksLayer,
  VcsProcess.layer,
).pipe(Layer.provideMerge(authLayer));
const routePersistenceLayer = routeConsumersLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(applicationEventStoreLayer, orchestrationCommandReceiptRepositoryLayer),
  ),
);
const routeNativeLayer = routePersistenceLayer.pipe(Layer.provideMerge(nativeRuntimeLayer));
const routeDependenciesLayer = routeNativeLayer.pipe(
  Layer.provideMerge(routeTestConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const routesLayer = HttpRouter.serve(makeRoutesLayer.pipe(Layer.provide(launcherLayer)), {
  disableListenLog: true,
  routerConfig: { maxParamLength: 512 },
}).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(routeDependenciesLayer));

const encodeBrowserSessionBootstrapRequest = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String })),
);

const authenticatedWsRpcProtocol = Effect.gen(function* () {
  const httpServer = yield* HttpServer.HttpServer;
  const bootstrapResponse = yield* HttpClient.execute(
    HttpClientRequest.make("POST")("/api/auth/browser-session", {
      headers: { "content-type": "application/json" },
    }).pipe(
      HttpClientRequest.bodyText(
        encodeBrowserSessionBootstrapRequest({ credential: testBootstrapToken }),
        "application/json",
      ),
    ),
  );
  assert.equal(bootstrapResponse.status, 200);
  const setCookie = bootstrapResponse.headers["set-cookie"];
  if (typeof setCookie !== "string") {
    assert.fail("The browser-session response did not include a cookie.");
  }
  const cookie = setCookie.split(";")[0] ?? setCookie;
  const wsUrl = new URL("/ws", HttpServer.formatAddress(httpServer.address));
  wsUrl.protocol = "ws:";
  wsUrl.searchParams.set(
    ORCHESTRATION_PROTOCOL_QUERY_PARAM,
    String(ORCHESTRATION_PROTOCOL_VERSION),
  );
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl) =>
      new NodeSocket.NodeWS.WebSocket(socketUrl, {
        headers: { cookie },
      }),
  );
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(wsUrl.toString()).pipe(Layer.provide(webSocketConstructorLayer)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
});

it.effect("serves the scheduled update state on the production lifecycle WebSocket", () =>
  Effect.gen(function* () {
    const socketProtocolLayer = yield* authenticatedWsRpcProtocol;
    const stateResult = yield* Effect.result(
      Effect.scoped(
        RpcClient.make(WsRpcGroup).pipe(
          Effect.flatMap((client) =>
            client[WS_METHODS.subscribeServerLifecycle]({}).pipe(
              Stream.filter((event) => event.type === "serviceUpdate"),
              Stream.runHead,
            ),
          ),
          Effect.provide(socketProtocolLayer),
        ),
      ),
    );
    if (stateResult._tag === "Failure") {
      assert.fail(`The authenticated lifecycle WebSocket failed: ${String(stateResult.failure)}`);
    }
    assert.isTrue(Option.isSome(stateResult.success));
    assert.deepEqual(Option.getOrThrow(stateResult.success).payload, { status: "idle" });
  }).pipe(Effect.scoped, Effect.provide(routesLayer)),
);

it.effect("cancels with the scheduler supplied during route construction", () =>
  Effect.gen(function* () {
    const scheduler = yield* ServiceUpdateScheduler;
    const cancel = vi
      .spyOn(scheduler, "cancelCurrent")
      .mockReturnValue(Effect.succeed({ cancelled: true }));
    yield* Effect.gen(function* () {
      const protocol = yield* authenticatedWsRpcProtocol;
      const result = yield* RpcClient.make(WsRpcGroup).pipe(
        Effect.flatMap((client) => client[WS_METHODS.serverCancelServiceUpdate]({})),
        Effect.provide(protocol),
      );
      assert.deepEqual(result, { cancelled: true });
      assert.equal(cancel.mock.calls.length, 1);
    }).pipe(Effect.ensuring(Effect.sync(() => cancel.mockRestore())));
  }).pipe(Effect.scoped, Effect.provide(routesLayer)),
);
