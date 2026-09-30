import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { updateQoderModelsCache } from "../catalog.js";
import { getMachineId } from "../cosy.js";
import { getQoderRefreshURL, getQoderRegionConfig, type QoderMode } from "../region.js";
import { interactiveLogin } from "./login.js";
import { credentialsFromPat, decodePatRefresh, fetchUserInfo, isPatRefresh } from "./pat.js";

export interface QoderCredentials extends OAuthCredentials {
  userID: string;
  email: string;
  name: string;
  machineID: string;
}

const identityCache = new Map<string, QoderCredentials>();

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

/**
 * omp keeps the authoritative credential in its own agent.db. This sidecar only
 * stores the COSY identity (uid/email/name) that the signed requests need and
 * that cannot be derived from the job token alone.
 */
function getAuthFilePath(): string {
  return join(getHomeDir(), ".omp", "agent", "qoder-credentials.json");
}

/** Memoized parse of auth.json; invalidated on save. undefined = not loaded. */
let authFileMem: { path: string; data: Record<string, unknown> } | null | undefined;

/** Clear process-memory auth caches (used by tests that mutate auth.json). */
export function clearQoderAuthMemCache(): void {
  authFileMem = undefined;
  identityCache.clear();
}

function readAuthFileCached(): Record<string, unknown> | null {
  const authPath = getAuthFilePath();
  if (authFileMem !== undefined) {
    if (authFileMem === null) return null;
    if (authFileMem.path === authPath) return authFileMem.data;
  }
  if (!existsSync(authPath)) {
    authFileMem = null;
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
    authFileMem = { path: authPath, data };
    return data;
  } catch {
    authFileMem = null;
    return null;
  }
}

/** The PAT exposed through the environment for a provider mode, plus its variable name. */
export function getQoderPatForMode(mode: QoderMode): { pat: string; envName: string } {
  for (const envName of getQoderRegionConfig(mode).patEnvNames) {
    const value = process.env[envName];
    if (value) return { pat: value, envName };
  }
  return { pat: "", envName: getQoderRegionConfig(mode).patEnvNames[0] };
}

function saveCredentialsToAuthFile(providerID: string, credentials: OAuthCredentials): void {
  try {
    const authPath = getAuthFilePath();
    const dir = dirname(authPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const existing = readAuthFileCached();
    const auth: Record<string, unknown> = existing ? { ...existing } : {};
    auth[providerID] = { type: "oauth", ...credentials };
    writeFileSync(authPath, JSON.stringify(auth, null, 2), { encoding: "utf-8", mode: 0o600 });
    authFileMem = { path: authPath, data: auth };
    const q = credentials as QoderCredentials;
    if (q.access && q.userID) {
      identityCache.set(`${providerID}:${q.access}`, q);
    }
  } catch (err) {
    console.error(`[omp-provider-qoder] Failed to write auth storage for ${providerID}:`, err);
  }
}

/**
 * Read the Qoder identity (userID/email/name/machineID) from this provider's own
 * credential sidecar. omp owns the authoritative token in agent.db; the sidecar
 * exists because the COSY signature also needs the account identity, which the
 * token alone does not carry.
 *
 * Best-effort: a missing or unreadable sidecar returns null so callers can fall
 * back to a live userinfo lookup.
 */
export function getCachedCredentials(_accessToken: string, providerID = "qoder"): QoderCredentials | null {
  const auth = readAuthFileCached();
  if (!auth) return null;
  const creds = (auth[providerID] || (providerID === "qoder" ? auth.qoder : null)) as QoderCredentials | null;
  if (creds?.userID || creds?.access) {
    if (creds.access && creds.userID) {
      identityCache.set(`${providerID}:${creds.access}`, creds);
    }
    return creds;
  }
  return null;
}

/**
 * Resolve the Qoder identity (userID/email/name/machineID) for a chat request.
 * omp stores the credential in its own agent.db, which carries no account
 * identity, so the sidecar is frequently empty and the COSY payload would fall
 * back to uid "qoder-user" -> Qoder CN rejects it with "Login expired" (105).
 * Fetch the identity from the job token when the cache misses (in-memory
 * cached), and persist it so later requests skip the fetch.
 */
export async function resolveQoderIdentity(
  accessToken: string,
  providerID: string,
  mode: QoderMode,
): Promise<QoderCredentials> {
  const region = getQoderRegionConfig(mode);
  const cacheKey = `${providerID}:${accessToken}`;
  const mem = identityCache.get(cacheKey);
  if (mem?.userID) return mem;

  const cached = getCachedCredentials(accessToken, providerID);
  if (cached?.userID) {
    identityCache.set(cacheKey, cached);
    return cached;
  }

  const info = await fetchUserInfo(accessToken, mode);
  const machineID = getMachineId();
  const creds: QoderCredentials = {
    access: accessToken,
    userID: info.userID || "qoder-user",
    email: info.email || region.userEmailFallback,
    name: info.name || region.userNameFallback,
    machineID,
    refresh: "",
    expires: 0,
  };
  identityCache.set(cacheKey, creds);
  saveCredentialsToAuthFile(providerID, creds);
  return creds;
}

export async function loginQoderForMode(callbacks: OAuthLoginCallbacks, mode: QoderMode): Promise<OAuthCredentials> {
  const providerID = getQoderRegionConfig(mode).providerID;
  // 1. A PAT in the environment is authoritative. It must be exchanged for a
  //    short-lived job token before it can be used; credentialsFromPat does the
  //    exchange plus identity resolution. Report a rejected PAT instead of
  //    silently falling through to the prompt, otherwise the user cannot tell
  //    why the login hung on an input box.
  const { pat, envName } = getQoderPatForMode(mode);
  if (pat) {
    try {
      const creds = await credentialsFromPat(pat, mode);
      const qCreds = creds as QoderCredentials;
      // Model catalog refresh is background work; login must not wait on it.
      updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch(() => {});
      // omp keeps the token in agent.db but not the account identity, and COSY
      // signing needs the real uid/email — without this sidecar the chat request
      // falls back to uid "qoder-user" and Qoder CN rejects it ("Login expired" 105).
      saveCredentialsToAuthFile(providerID, creds);
      return creds;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${envName} was rejected by Qoder: ${message}`);
    }
  }

  // 2. Interactive login (CN prompts for a PAT; global can fall back to the device flow).
  const creds = await interactiveLogin(callbacks, mode);

  // Cache models in background.
  try {
    const qCreds = creds as QoderCredentials;
    updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch(() => {});
  } catch {}

  // Persist the resolved identity locally (see note above).
  saveCredentialsToAuthFile(providerID, creds);
  return creds;
}

export async function refreshQoderTokenForMode(
  credentials: OAuthCredentials,
  mode: QoderMode,
): Promise<OAuthCredentials> {
  // PAT-based credentials: re-exchange the stored PAT for a fresh job token.
  if (isPatRefresh(credentials.refresh)) {
    const { pat } = decodePatRefresh(credentials.refresh);
    if (pat) {
      try {
        const refreshed = await credentialsFromPat(pat, mode);
        const qCreds = refreshed as QoderCredentials;
        updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch(() => {});
        return refreshed;
      } catch {
        // Fall through to validity extension below.
      }
    }
    return {
      ...credentials,
      expires: Date.now() + 60 * 60 * 1000, // extend 1 hour to retry later
    };
  }

  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] || "";
  const userID = parts[1] || "";
  const machineID = parts[2] || getMachineId();
  const prev = credentials as Partial<QoderCredentials>;
  const prevName = prev.name || "";
  const prevEmail = prev.email || "";

  const refreshURL = getQoderRefreshURL(mode);
  try {
    const response = await fetch(refreshURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.access}`,
        Accept: "application/json",
        "User-Agent": "omp-provider-qoder",
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        token: string;
        refresh_token?: string;
        expires_at?: string;
        expires_in?: number;
      };

      const newAccess = data.token;
      const newRefresh = data.refresh_token || refreshToken;

      let expireMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
      if (data.expires_at) {
        const parsed = Date.parse(data.expires_at);
        if (!Number.isNaN(parsed)) expireMs = parsed;
      } else if (data.expires_in) {
        expireMs = Date.now() + data.expires_in * 1000;
      }

      const refreshed = {
        ...credentials,
        refresh: `${newRefresh}|${userID}|${machineID}`,
        access: newAccess,
        expires: expireMs - 5 * 60 * 1000,
        userID,
        email: prevEmail,
        name: prevName,
        machineID,
      };

      // pi persists the refreshed credentials in auth.json itself.
      // Cache models in background
      updateQoderModelsCache(newAccess, userID, prevName, prevEmail, mode).catch(() => {});

      return refreshed;
    }
  } catch {}

  // Fallback: Extend validity slightly to buy time, as Qoder tokens are long-lived
  const refreshedFallback = {
    ...credentials,
    expires: Date.now() + 60 * 60 * 1000, // extend for 1 hour
  };
  return refreshedFallback;
}
