# OpenCode Native v2 Free-Tier Request Shaping — Deltas & Decision Log

Decision log and conformance audit comparing native OpenCode v2 client (`/workspace/projects/devel/opencode/opencode-v2 @ 238d4cf5ca`) with OmniRoute's `OpencodeExecutor` and header synthesis pipeline.

---

## Summary of Decisions

| #   | Delta Topic                                    | Decision                              | Primary Rationale & Contract                                                                                                                                                                                                               |
| --- | ---------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | User-Agent preservation guard                  | **Aligned to native**                 | Preserve `opencode/...` (native v2) alongside legacy `opencode-cli/...`; replace only generic client UAs (curl, python, SDKs).                                                                                                             |
| 2   | `x-opencode-session` & `x-opencode-session-id` | **Aligned + Kept with documentation** | Forward client-supplied `x-opencode-session-id` and `x-opencode-session`; retain conversation-stable 16-hex fingerprint fallback (`generateSessionId()`) for prompt-cache & sticky provider affinity; no accidental injection when absent. |
| 3   | Native header set completeness                 | **Aligned to native**                 | Add `x-opencode-session-id`, `x-opencode-parent-session-id`, `x-session-affinity`, `x-parent-session-id` to forwarded headers (case-insensitive, client-wins).                                                                             |
| 4   | DeepSeek effort-tier model rewrite             | **Kept with documentation**           | DeepSeek V4 models via opencode-go require flat `reasoning_effort` in request body (#4647); other model families retain the `-<tier>` model ID suffix (#10788).                                                                            |
| 5   | `json_schema` -> `json_object` fallback        | **Kept with documentation**           | `deepseek-v4-flash-free` on opencode.ai free endpoint rejects `json_schema` with HTTP 400; fallback downgrades to `json_object` and injects schema into system instructions.                                                               |
| 6   | Low-risk transforms                            | **Kept with documentation**           | Strip `client_metadata` (prevents 400 Extra inputs), inject placeholder `reasoning_content` for thinking models, enforce UUID for `muse-spark` in Responses API.                                                                           |

---

## Detailed Deltas Analysis

### 1. User-Agent Preservation Guard

- **Native Reference**:
  - `packages/core/src/app.ts:24-26`: `export function useragent(app: Info) { return \`opencode/${app.channel}/${app.version}/${app.name}\`; }`
  - `packages/core/src/session/model-request.ts:271`: `"User-Agent": App.useragent(app)`
- **OmniRoute Source**: `open-sse/utils/opencodeHeaders.ts:135-140`
- **Issue**:
  The UA check previously used `/^opencode-cli\//i`, which only preserved legacy CLI User-Agents. A real native opencode v2 client sending `opencode/{channel}/{version}/{name}` (e.g. `opencode/stable/2.1.0/opencode`) was improperly classified as non-CLI and replaced with the synthesized default (`opencode`).
- **Decision: ALIGNED TO NATIVE**
  Updated guard regex in `applyCliDefaults` to `/^(opencode-cli|opencode)\//i.test(existingUa.trim())`.
  - Preserves native v2 UAs (`opencode/...`) and legacy CLI UAs (`opencode-cli/...`).
  - Replaces truly generic UAs (curl, python-requests, node-fetch, OpenAI SDKs) to prevent Cloudflare 429 `FreeUsageLimitError` on datacenter IPs per #5997 and #10229.

### 2. `x-opencode-session` & `x-opencode-session-id`

- **Native Reference**:
  - `packages/core/src/session/model-request.ts:266,273`:
    ```ts
    "x-opencode-session-id": session.id,
    "x-opencode-session": affinity,
    ```
  - `packages/schema/src/session-id.ts:8`: `schema.make("ses_" + descending())`
  - `packages/core/src/session/affinity.ts:7`: `session.parentID ?? session.fork?.sessionID ?? session.id`
  - `packages/console/app/src/routes/zen/util/handler.ts:150-151`:
    `const stickyId = sessionId ? sessionId : (authInfo?.workspaceID ?? ip);`
    `const stickyTracker = createStickyTracker(modelInfo.id, modelInfo.stickyProvider, stickyId);`
- **OmniRoute Source**:
  - `open-sse/utils/opencodeHeaders.ts:9-14, 96-107, 144-145`
  - `open-sse/services/sessionManager.ts:103-145`
  - `open-sse/executors/opencode.ts:781-789`
- **Analysis & Trade-Offs**:
  - Native OpenCode sessions are structured strings (`"ses_" + descending()`), not UUIDs.
  - Upstream `opencode.ai/zen` uses `x-opencode-session` as `stickyId` for provider routing and prompt caching.
  - If OmniRoute synthesized a fresh random UUID per request for non-OpenCode clients (e.g. multi-turn chats from curl or external tools), prompt cache would miss on every turn, and sticky routing would churn.
  - PR #10571 introduced `generateSessionId(sessionBody)` to compute a deterministic 16-hex hash across turns with the same model, system prompt, opening user message, and tools.
  - For `muse-spark` under OpenAI Responses API, `opencode.ts:781-789` forces a UUID because that specific endpoint schema enforces a UUID regex.
- **Decision: ALIGNED + KEPT WITH DOCUMENTATION**
  - Added `x-opencode-session-id` to `OPENCODE_HEADER_KEYS` so native clients sending `x-opencode-session-id` are faithfully forwarded.
  - In `synthesizeRequestId`, if `x-opencode-session` is absent, allow `x-opencode-session-id` to be used as fallback affinity.
  - Do NOT synthesize or inject `x-opencode-session-id` when absent (no accidental header injection).
  - Retain conversation-stable fingerprint (`generateSessionId(sessionBody)`) for synthesized `x-opencode-session` when client does not supply a session header, falling back to `randomUUID()` when no body is provided.

### 3. Native Header Set Completeness

- **Native Reference**:
  - `packages/core/src/session/model-request.ts:266-274`:
    ```ts
    "x-opencode-session-id": session.id,
    ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
    "x-session-affinity": affinity,
    "X-Session-Id": affinity,
    ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
    "User-Agent": App.useragent(app),
    "x-opencode-project": session.projectID,
    "x-opencode-session": affinity,
    "x-opencode-client": app.name,
    ```
- **OmniRoute Source**: `open-sse/utils/opencodeHeaders.ts:9-24, 80-94`
- **Issue**:
  Previously, only `x-opencode-session`, `x-opencode-request`, `x-opencode-project`, `x-opencode-client` (in `OPENCODE_HEADER_KEYS`) and `x-session-id`, `x-title` (in `AGENT_METADATA_HEADER_KEYS`) were forwarded. Native parent lineage and affinity headers (`x-opencode-session-id`, `x-opencode-parent-session-id`, `x-session-affinity`, `x-parent-session-id`) were dropped.
- **Decision: ALIGNED TO NATIVE**
  - Expanded `OPENCODE_HEADER_KEYS` to include:
    `"x-opencode-session-id"`, `"x-opencode-parent-session-id"`, `"x-session-affinity"`, `"x-parent-session-id"`.
  - Headers are matched case-insensitively via `findHeader`.
  - Client values win. No headers are fabricated if omitted by client.
  - `x-session-id` (and case-variants like `X-Session-Id`) continue to be forwarded via `AGENT_METADATA_HEADER_KEYS` without duplicate key collision.

### 4. DeepSeek Effort-Tier Model Rewrite

- **Native Reference**:
  - `packages/ai/src/protocols/openai-chat.ts:796`: `...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {})`
  - `packages/console/app/src/routes/zen/util/handler.ts:119`: `"model.variant": variant`
- **OmniRoute Source**: `open-sse/executors/opencode.ts:888-907`
- **Analysis**:
  - For `deepseek-v4-pro` and `deepseek-v4-flash`, the opencode-go upstream proxies the native DeepSeek contract which accepts a flat `reasoning_effort` field in the request body (#4647). Mapping `deepseek-v4-pro-<effort>` -> `model: "deepseek-v4-pro", reasoning_effort: effort` is the correct mechanism.
  - Per #10788, other model families on opencode-go (e.g. Kimi) do not accept flat `reasoning_effort` and instead define effort tiers as discrete model IDs with `-<tier>` suffixes in the catalog.
- **Decision: KEPT WITH DOCUMENTATION**
  Confirmed behavior matches upstream contract. Maintained existing rewrite logic in `opencode.ts:888-907`.

### 5. `json_schema` -> `json_object` Downgrade

- **Native Reference**:
  - `packages/ai/src/protocols/openai-chat.ts`: Native OpenCode does not emit `json_schema` for opencode-zen free models.
- **OmniRoute Source**: `open-sse/executors/opencode.ts:802-865`
- **Analysis**:
  - `deepseek-v4-flash-free` on the free tier `opencode.ai/zen/v1` endpoint rejects `response_format: { type: "json_schema" }` with HTTP 400.
  - OmniRoute downgrades `response_format.type` to `json_object` and injects the schema as strict instructions into the system prompt.
  - Standard/paid models (such as `deepseek-v4-pro`) preserve `json_schema`.
- **Decision: KEPT WITH DOCUMENTATION**
  The fallback prevents upstream 400s while guaranteeing valid JSON conforming to the requested schema. Verified and retained.

### 6. Low-Risk Transforms

- **OmniRoute Source**: `open-sse/executors/opencode.ts:781-789, 875-887, 909-916`
- **Transforms Reviewed**:
  1. **`client_metadata` strip** (`opencode.ts:880-887`): 9router#1442. OpenCode upstreams reject unrecognized fields like `client_metadata` (passed by Claude Code/Codex CLI) with HTTP 400 "Extra inputs are not permitted". Stripping is verified correct.
  2. **`reasoning_content` injection** (`opencode.ts:909-916`): #1543. Thinking-mode upstreams (DeepSeek V4 Flash, Kimi, MiniMax) require `reasoning_content` echoed on assistant messages across turns. OmniRoute injects a placeholder for affected models when OpenAI clients drop it. Verified correct.
  3. **`muse-spark` UUID enforcement** (`opencode.ts:781-789`): Muse's Responses endpoint validates that `x-opencode-session` matches a UUID pattern. Verified correct and retained.
  4. **IP-bucketed rotation & sticky routing**: Standard OpenCode session routing logic. Verified correct.
- **Decision: KEPT WITH DOCUMENTATION**
  All transforms are proven compatibility layers. Verified with automated regression tests.
