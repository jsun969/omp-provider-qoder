import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { getCachedCredentials, loginQoderForMode, refreshQoderTokenForMode } from "./auth/oauth.js";
import { getCachedModels, isCacheStale, staticCnModels, staticModels, updateQoderModelsCache } from "./catalog.js";
import { streamQoder } from "./protocol/stream.js";
import { getQoderBaseUrl, getQoderRegionConfig, type QoderMode } from "./region.js";

const QODER_API = "qoder-api" as Api;

// Qoder runs two independent gateways. Only the CN one is registered by default;
// add "global" to also expose api3.qoder.sh accounts.
const QODER_PROVIDER_MODES: readonly QoderMode[] = ["cn"];

function modelsForProvider(mode: QoderMode, providerID: string): Model<Api>[] {
  const cached = getCachedModels(mode);
  const modelsToUse = cached.length > 0 ? cached : mode === "cn" ? staticCnModels : staticModels;

  return modelsToUse.map((m) => ({
    ...m,
    provider: providerID,
    baseUrl: getQoderBaseUrl(mode),
  })) as unknown as Model<Api>[];
}

function registerQoderProvider(pi: ExtensionAPI, mode: QoderMode): void {
  const region = getQoderRegionConfig(mode);
  const oauth: NonNullable<ProviderConfig["oauth"]> = {
    name: region.loginName,
    login: (callbacks) => loginQoderForMode(callbacks, mode),
    refreshToken: (credentials) => refreshQoderTokenForMode(credentials, mode),
    getApiKey: (credentials) => credentials.access,
  };

  pi.registerProvider(region.providerID, {
    baseUrl: region.baseUrl,
    api: QODER_API,
    models: modelsForProvider(mode, region.providerID) as unknown as ProviderConfig["models"],
    oauth,
    streamSimple: streamQoder as unknown as ProviderConfig["streamSimple"],
  });
}

export default function qoderProviderExtension(pi: ExtensionAPI): void {
  // Registration must finish before the first await: omp processes provider
  // registrations while the factory is still synchronous.
  for (const mode of QODER_PROVIDER_MODES) registerQoderProvider(pi, mode);

  // Rebuild the model cache once per session when it is missing or stale (>1h),
  // covering the case where the cache was deleted while the token is still valid.
  // Login and token refresh are the other rebuild triggers.
  pi.on("session_start", async (_event, ctx) => {
    for (const mode of QODER_PROVIDER_MODES) {
      try {
        const region = getQoderRegionConfig(mode);
        const accessToken = await ctx.modelRegistry.getApiKeyForProvider(region.providerID);
        if (!accessToken || !isCacheStale(mode)) continue;
        const creds = getCachedCredentials(accessToken, region.providerID);
        await updateQoderModelsCache(
          accessToken,
          creds?.userID || "qoder-user",
          creds?.name || region.userNameFallback,
          creds?.email || region.userEmailFallback,
          mode,
        );
      } catch {
        // Best-effort: keep serving the existing cache / static models.
      }
    }
  });
}
