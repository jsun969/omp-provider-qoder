# omp-provider-qoder

**English** | [简体中文](./README.zh-CN.md)

An omp (oh-my-pi) extension that registers **Qoder** as a model provider. Port of `pi-provider-qoder` to omp's extension API.

Both the China (`qoder-cn`, enabled by default) and global (`qoder`) gateways are fully implemented; register both by setting `QODER_PROVIDER_MODES` to `["cn", "global"]` in [`index.ts`](./index.ts).

## Install

```bash
git clone https://github.com/jsun969/omp-provider-qoder ~/.omp/agent/extensions/omp-provider-qoder
```

omp auto-discovers extensions under `~/.omp/agent/extensions/`, and a directory containing `index.ts` is a valid entry. No build step — the TypeScript sources are loaded directly with Bun. Start a new session to pick it up.

## Login

### China Gateway (`qoder-cn`)

```text
/login qoder-cn        # PAT input prompt
```

PAT page: https://qoder.com.cn/account/integrations

### Global Gateway (`qoder`)

```text
/login qoder           # Browser device flow (PKCE + OAuth) or PAT
```

PAT page: https://qoder.com/account/integrations

A PAT (`pt-...`) is exchanged for a short-lived job token; the PAT is kept in the credential's refresh field and re-exchanged on expiry. A PAT set in the environment logs the provider in at startup (first non-empty variable wins):

| Provider | Env vars |
| --- | --- |
| `qoder-cn` | `QODERCN_API_KEY`, `QODERCN_PERSONAL_ACCESS_TOKEN`, `QODERCN_PAT` |
| `qoder` | `QODER_API_KEY`, `QODER_PERSONAL_ACCESS_TOKEN`, `QODER_PAT` |
To enable the global provider, set `QODER_PROVIDER_MODES` to `["cn", "global"]` in [`index.ts`](./index.ts) and restart omp.

## Usage

```bash
omp --provider qoder-cn --model DeepSeek-V4-Flash
```

```text
/login qoder-cn
/model DeepSeek-V4-Flash
```

## Models

A model's omp id is the upstream `display_name` with whitespace stripped (`Qwen3.7 Plus` → `Qwen3.7Plus`). The upstream catalog key (e.g. `qmodel_latest`) is kept in the cache and sent as `X-Model-Key` on requests.

After login the live catalog is cached to `~/.omp/agent/qoder-cn-models-cache.json` and rebuilt at most hourly (on login, token refresh, and `session_start` when stale). When no cache exists, hardcoded fallback catalogs in [`catalog.ts`](./catalog.ts) are used. Context window is the largest option the catalog advertises (1M default); max output is 128K.

## Endpoints

| | Global (`qoder`) | China (`qoder-cn`) |
| --- | --- | --- |
| Chat gateway | `https://api3.qoder.sh/` | `https://gateway.qoder.com.cn/` |
| Model list | `<gateway>algo/api/v2/model/list?Encode=1` | same |
| Chat SSE | `<gateway>algo/api/v2/service/pro/sse/agent_chat_generation?...` | same |
| OpenAPI (PAT exchange, userinfo) | `https://openapi.qoder.sh` | `https://openapi.qoder.com.cn` |
| Token refresh | `https://center.qoder.sh` | `https://gateway.qoder.com.cn` |

## Layout

| File | Responsibility |
| --- | --- |
| `index.ts` | `registerProvider` wiring: models, OAuth hooks, `streamSimple`, cache refresh on `session_start` |
| `region.ts` | Per-region config: provider id, endpoints, env var names, custom base64 URL helpers |
| `auth/oauth.ts` | Credential lifecycle: identity resolution, sidecar persistence, token refresh |
| `auth/login.ts` | Interactive login: PAT prompt, global browser device flow (PKCE + polling) |
| `auth/pat.ts` | PAT → job token exchange, userinfo, `pat\|...` refresh-field encoding |
| `catalog.ts` | Live model catalog fetch, on-disk cache, static fallbacks, thinking-level maps |
| `cosy.ts` | Machine id, COSY request signing (AES + RSA + MD5 signature headers) |
| `protocol/stream.ts` | Chat request assembly, SSE consumption, pi-ai event stream emission |
| `protocol/transform.ts` | pi-ai messages/tools → Qoder wire format |
| `protocol/thinking.ts` | `<thinking>`-style tag extraction, DSML residue cleanup |
| `protocol/encoding.ts` | Qoder's custom base64 body encoding |

## Protocol notes

- **Body encoding** — requests are sent with a custom base64 alphabet plus a one-third block rotation, `$` instead of `=` padding (`protocol/encoding.ts`).
- **Auth** — `Authorization: Bearer COSY.<payload>.<sig>`; the payload carries an AES-128-CBC-encrypted user blob with the AES key RSA-wrapped, and the signature is MD5 over payload/key/timestamp/body/sig-path. Identity (uid/email) is required and comes from the sidecar or a live userinfo lookup, not from the job token.
- **SSE** — the gateway wraps OpenAI-style chunks in `{"statusCodeValue":200,"body":"<json>"}` envelopes; the terminal `[DONE]` arrives bare or wrapped and ends the read loop immediately (the socket otherwise stays open).
- **Usage mapping** — OpenAI semantics (`prompt_tokens` includes cached tokens) are converted to pi's convention: `input = prompt_tokens − cached − cache_write`.
- **Thinking** — `reasoning_content` maps to thinking blocks; literal `<thinking>`/`<think>`/`<reasoning>`/`<thought>` tags that leak into the content channel are parsed out cross-delta. Leaked DSML tool-call markup is stripped; a turn with no text, no tool call, and a DSML tail is surfaced as a retryable `server error` instead of a silent `stop`.
- **Reasoning levels** — `enable_thinking` plus `reasoning_effort` (only for models advertising `thinking_config.enabled.efforts`), driven by omp's thinking level.
- **pi-ai compatibility** — works with both the flat `Context` (systemPrompt/tools, ≤0.85) and the `TranscriptContext` (≥0.86) provider contracts, feature-detected at runtime.

## Local state

| Path | Purpose |
| --- | --- |
| `~/.omp/agent/qoder-cn-models-cache.json` | Live model catalog (also `qoder-models-cache.json` for global) |
| `~/.omp/agent/qoder-credentials.json` | Identity sidecar (uid/email/name/machine id); omp's `agent.db` holds the token but not the identity |
| `~/.omp/agent/qoder-machine-id` | Generated machine id (reuses `~/.qoder/.auth/machine_id` when present) |

Set `QODER_DEBUG=1` to log skipped malformed SSE lines.
