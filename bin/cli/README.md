# bin/cli — OmniRoute CLI internals

This directory contains the CLI runtime, helpers, and commands for the `omniroute` binary.

## Structure

```
bin/cli/
├── CONVENTIONS.md          ← normative design rules (read this first)
├── README.md               ← this file
├── program.mjs             ← Commander setup — global flags, registerCommands()
├── api.mjs                 ← apiFetch() — all HTTP calls + retry/backoff
├── runtime.mjs             ← withRuntime() — server-first / DB-fallback
├── i18n.mjs                ← t() — i18n helper + locale detection
├── output.mjs              ← emit() — table/json/jsonl/csv + printSuccess/printError
├── io.mjs                  ← ask() / askSecret() — interactive prompts
├── data-dir.mjs            ← resolveDataDir() / resolveStoragePath()
├── sqlite.mjs              ← openOmniRouteDb() — DB bootstrap
├── encryption.mjs          ← encrypt/decrypt credentials
├── provider-catalog.mjs    ← static provider catalog
├── provider-store.mjs      ← DB CRUD for provider_connections
├── provider-test.mjs       ← testProviderApiKey()
├── settings-store.mjs      ← DB CRUD for key_value settings
├── locales/
│   └── en.json             ← English strings (the only catalog shipped)
└── commands/
    ├── setup.mjs
    ├── doctor.mjs
    ├── providers.mjs
    ├── config.mjs          ← includes `config lang get/set/list`
    ├── status.mjs
    ├── logs.mjs
    └── update.mjs
```

## Key helpers

### `apiFetch(path, opts)` — `api.mjs`

All HTTP calls to the OmniRoute server must go through this wrapper.

```js
import { apiFetch } from "./api.mjs";

const res = await apiFetch("/api/health");
if (!res.ok) await res.assertOk(); // throws ApiError with mapped exit code
const data = await res.json();
```

Options:

- `baseUrl` — override base URL (default: `OMNIROUTE_BASE_URL` env or `localhost:20128`)
- `apiKey` — override API key (default: `OMNIROUTE_API_KEY`)
- `method`, `body`, `headers` — standard fetch options
- `timeout` — per-attempt ms (default: `30000`)
- `retry` — `false` to disable (default: enabled)
- `retryMax` — total attempts (default: `3`)
- `verbose` — log retry attempts to stderr

### `withRuntime(fn, opts)` — `runtime.mjs`

Provides server-first / DB-fallback transparently.

```js
import { withRuntime } from "./runtime.mjs";

await withRuntime(async (ctx) => {
  if (ctx.kind === "http") {
    const res = await ctx.api("/v1/providers");
    return res.json();
  }
  return ctx.db.prepare("SELECT * FROM provider_connections").all();
});
```

- `opts.requireServer = true` — throws `ServerOfflineError` (exit 3) if offline
- `opts.preferDb = true` — always use DB (skip server check)

### `t(key, vars)` — `i18n.mjs`

Internationalized strings. Catalog loaded from `locales/{locale}.json`.

```js
import { t } from "./i18n.mjs";

console.log(t("common.serverOffline"));
console.log(t("setup.testFailed", { error: err.message }));
```

Locale detection order: `OMNIROUTE_LANG` → `LC_ALL` → `LC_MESSAGES` → `LANG` → `en`.

### `emit(data, opts)` — `output.mjs`

Format-aware output. Reads `opts.output` to select table/json/jsonl/csv.

```js
import { emit, printError, EXIT_CODES } from "./output.mjs";

emit(providers, { output: opts.output ?? "table" });
printError("Something went wrong");
process.exit(EXIT_CODES.SERVER_OFFLINE);
```

## Locale selection

The CLI is **English-only**: `bin/cli/locales/` ships a single catalog
(`en.json`), which `config/i18n.json` also declares as the one supported locale.

The locale plumbing is still there and still reads, in order, the `--lang` flag,
`OMNIROUTE_LANG`, then `LC_ALL` → `LC_MESSAGES` → `LANG` — but every value
resolves to `en`, because there is no other catalog to resolve to. There is no
cross-locale fallback chain any more; a key missing from `en.json` returns the
key itself.

```bash
omniroute config lang list            # lists the one supported locale (en)
omniroute config lang get             # show currently active locale (en)
omniroute config lang set en          # persists OMNIROUTE_LANG=en to ~/.omniroute/.env
```

`config lang set` rejects any code absent from `config/i18n.json` (exit 1), so
`omniroute config lang set de` fails rather than silently serving English.

**Adding a locale** would mean adding an entry to `config/i18n.json` _and_
hand-writing `bin/cli/locales/<code>.json` _and_ restoring a fallback chain in
`bin/cli/i18n.mjs` — deliberately not a one-command operation any more.

## Adding a new command

1. Create `bin/cli/commands/your-command.mjs`
2. Export `registerYourCommand(program)` following the Commander pattern
3. Register in `bin/cli/commands/registry.mjs`
4. Add strings to `locales/en.json`
5. Write test in `tests/unit/cli-your-command.test.ts`

See `CONVENTIONS.md` for exit codes, flag naming, output format, and destructive-action rules.
