# fix/opencode-native-deltas — Align OmniRoute's opencode handling with native opencode v2

## Base

Cut from `feat/v3.9.0-lab-staging` @ 33c99f2548. Worktree: `worktrees/fix-opencode-native-deltas`.

## Goal

Close the identified deltas between how native opencode (v2 line) shapes free-tier requests
to `https://opencode.ai/zen/v1/chat/completions` and how OmniRoute's OpencodeExecutor re-sends
them, where a delta risks rejection, degrade, or identity mismatch. The audit compared the
native client source (see below) against `open-sse/executors/opencode.ts` +
`open-sse/utils/opencodeHeaders.ts` + `open-sse/services/sessionManager.ts`.

## Native reference (what the real client sends)

Local clone: `/workspace/projects/devel/opencode/opencode-v2` (origin/v2 @ 238d4cf5ca).

- baseURL `https://opencode.ai/zen/v1` — `packages/ai/src/providers/opencode-zen.ts:6`
- keyless free tier → `Authorization: Bearer public` — `packages/core/src/plugin/provider/opencode.ts:319-325`
- `User-Agent: opencode/{channel}/{version}/{name}` — `packages/core/src/session/model-request.ts:271`, `packages/core/src/app.ts:24-26`
- headers `x-opencode-client`, `x-opencode-session-id`, `x-opencode-session`, `x-session-affinity`, `X-Session-Id`,
  `x-opencode-project`, `x-opencode-parent-session-id`, `x-parent-session-id` — `model-request.ts:266-274`
- body: OpenAI chat, `stream:true` + `stream_options.include_usage`, `max_completion_tokens`
  (NOT max_tokens), NO `store` field — `packages/ai/src/protocols/shared.ts` / `openai-chat.ts`
- SSE response with `[DONE]`

## Identified deltas to handle (from audit; verify each against native source before/while fixing)

### 1. User-Agent preservation guard is stale (MEDIUM risk)

`open-sse/utils/opencodeHeaders.ts:135-140`: non-CLI UAs are REPLACED with the synthesized CLI UA;
only `^opencode-cli/` is preserved. But native opencode v2 sends `opencode/{channel}/{version}/{name}`
— a real native UA would be **replaced** with the bare `opencode` default. Fix: also preserve UAs
starting `opencode/...` (the modern format), keeping `opencode-cli/` and `opencode/` both intact;
only generic UAs (curl/python/SDK) get replaced (that's the intended #5997/#10229 behavior).

### 2. x-opencode-session synthesized as non-UUID fingerprint (MEDIUM risk)

`open-sse/utils/opencodeHeaders.ts:144-145` + `open-sse/services/sessionManager.ts:103-145`:
when the client doesn't supply it, x-opencode-session is a 16-hex SHA-256 fingerprint of
model+system+first-user+tools. Native sends a **real UUID per session** (and muse-spark's
endpoint already forces a UUID at `open-sse/executors/opencode.ts:781-789`). Decide: keep the
conversation-stable fingerprint for prompt-cache affinity (document why) or synthesize a real
UUID; align Chat and Responses behavior. Adding `x-opencode-session-id` (native key) to the
forward/allow list may be needed — native sends it and it is currently NOT forwarded
(`OPENCODE_HEADER_KEYS` at opencodeHeaders.ts:9-14 only has session/request/project/client).

### 3. Native header set completeness (LOW-MEDIUM)

`x-opencode-parent-session-id`, `x-parent-session-id`, `x-session-affinity`, `X-Session-Id` are
sent natively; only x-opencode-session/x-opencode-request/x-opencode-project/x-opencode-client +
x-session-id/x-title are forwarded. Forward the remaining affinity/parent lineage headers
faithfully when present (case-insensitive, client wins).

### 4. DeepSeek effort-tier model rewrite (MEDIUM)

`open-sse/executors/opencode.ts:888-907`: `-low/-high/-max` suffix → base id + `reasoning_effort`
for deepseek-v4-pro/flash. Verify against native opencode-go contract; confirm this is still the
correct mechanism and document; otherwise align.

### 5. json_schema → json_object downgrade (MEDIUM)

`open-sse/executors/opencode.ts:802-865` for deepseek-v4-flash-free (free endpoint 400s
json_schema). Verify still required against current free endpoint contract; keep if yes,
document; ensure schema is injected as system instruction so behavior is preserved.

### 6. Other verified transformations — verify & document, change only if wrong

client_metadata strip, reasoning_content placeholder injection for thinking models,
muse-spark min-tokens/finish_reason rewrite, IP-bucketed rotation. Low risk; confirm each
matches current native/v2 behavior, add tests.

## Constraints

- NO live calls to opencode.ai/zen/v1 (IP-bucketed; audit is source-based only).
- No `git stash` anywhere (repo Hard Rule #22). Compare with `git show <ref>:<path>`.
- Follow repo AGENTS.md: tests in `tests/unit/` (e.g. `tests/unit/...opencode...`), Prettier
  style, no test files at repo root.
- Do NOT change opencode-ai npm pin or add version envs — that's the sibling
  feat/opencode-client-version worktree.

## Definition of done

- Each delta resolved with a decision: aligned-to-native, kept-with-documentation, or rejected
  (with file:line rationale) recorded in a short `DELTAS.md` at the worktree root.
- Unit tests added for each behavior changed.
- Only behavior-delta commits, nothing from the version-tracking card.
