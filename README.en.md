# Today models

Connects the account already signed in by the **Today desktop app** to DeepSeek Harness as a model provider named `today`.

> **This is not an ordinary API plugin. Read this before installing.**
>
> 1. **It is not a real model channel.** Today has no OpenAI-compatible completion endpoint; every request is handed to Today's own agent. So replies are **not streamed token by token**, the agent's own personality and memory still shape the answer (the prompt asks it to ignore them, which cannot be fully enforced), and **its own tools cannot be disabled** — it may read files or browse on its own, so any "I did X" answer must not be taken as fact.
> 2. **The model choice is account-wide.** Today stores one active model per account and its message endpoint ignores any per-request model field. Selecting a model in DSH therefore changes it for the whole account, including the Today app on your phone. Concurrency defaults to one to stop two requests on different models from retargeting each other mid-flight.
> 3. **It spends real quota.** Nothing here bypasses billing: every request consumes your allowance under Today's own rules.
> 4. **It depends on upstream internals.** The plugin reads the desktop app's encrypted credentials and calls its private API. An upstream change can break it.
>
> This is an independent interoperability adapter. It is **not affiliated with, authorised by, or endorsed by Today**.

## What it does

- Reads **this account's** own model catalog, so the selector shows exactly the models that account may use, each with Today's usage multiplier (such as `4×`).
- Re-reads that catalog periodically, so account-side changes reach the selector without a restart.
- Pushes the selected model to the account before each turn, so the model you pick is the model that runs.
- Adds a full page under **Settings → Today**: the connected account, the plan and remaining usage, the models (each one can be hidden or given its own context window), editable plugin settings, recent background tasks, and the latest diary entry.

## Install

```bash
# Register this directory as a local bundle in DSH
dsh plugin add /path/to/dsh-today-llm
```

Or point DSH's **Plugins → Add plugin** at this directory. Run `pnpm install` first to fetch the single dependency (`@deepseek-ai/schemastery`).

Requirement: the Today desktop app must be signed in on this machine. The plugin only ever reads the app's credential files, never writes them.

## Settings page

A **Today** entry appears in the Settings panel's left navigation, beside Account, General, Models and Plugins.

### Read-only status

| Area | Content | Source |
| --- | --- | --- |
| Account | Signed-in identifier, credential directory | Local credential files |
| Plan and usage | Plan tier, remaining percentage, reset time, service state | `/v1/pricing/status` |
| Recent tasks | The last eight background tasks and their status | `/v1/tasks` |
| Latest diary | Today's diary title and an excerpt | `/v1/diaries` |

### Editable settings

Edits are **draft-based**: nothing is written until **Save**. Saving goes through the harness `ctx.settings.update`, which validates the candidate, preserves the rest of the profile patch, and restarts the plugin so the new values take effect.

| Setting | Default | Meaning |
| --- | --- | --- |
| Turn timeout | 300 s | How long to wait for one Today turn |
| Poll interval | 700 ms | How often to re-read the conversation while waiting |
| Catalog refresh | 600 s | How often to re-read the model catalog; `0` disables it |
| Default context window | 200000 | Used by every model without its own override |
| Concurrent turns | 1 | See the risk note below |
| Strict JSON protocol | on | Turning it off gives more natural prose but **breaks tool calls** |
| Report estimated usage | on | Turning it off stops emitting token counts |

Each model row also has a visibility toggle and an optional context-window override.

### Data routes

The page uses the host's own HTTP routes, behind the same launch cookie as every other host route:

- `GET /dsh-today-llm/status` — the status snapshot
- `POST /dsh-today-llm/config` — configuration writes (only the fields this page owns)

These paths **must** stay outside `/api`: the connection layer claims that whole prefix with a prefix route, so a resource registered there is never matched.

## The concurrency risk

Today stores the model choice per account. At concurrency 1 the sequence "pin the model, start the turn, wait for the reply" is atomic. At 2 or more, two requests on different models can rewrite the conversation the other is still waiting on. Two requests on the same model are unaffected, so raising it is safe for a fixed workflow — but that is your call to verify.

## Requirements

The Today desktop app must be signed in. The plugin reads its session from `%APPDATA%\Today CN` (macOS: `~/Library/Application Support/Today CN`, Linux: `$XDG_CONFIG_HOME/Today CN`):

- `os_crypt.encrypted_key` in `Local State` is protected by the platform secret store (DPAPI / Keychain / libsecret); the plugin only unwraps it.
- The session itself lives in `account-credentials.slot-*`, encrypted with Chromium's `v10` envelope.

All of this is **read-only**: not one byte of the Today desktop app's files is modified.

## Known limits

| Limit | Explanation |
| --- | --- |
| No token-level streaming | Today has no completion endpoint, so the reply lands in one piece. The adapter emits a single text block. |
| Shaped by the agent's persona | The request goes to Today's own agent, whose persona and long-term memory still colour the answer. |
| Its own tools stay enabled | That agent has file, command and connector tools the API cannot disable. |
| Account-wide model choice | See the risk note above; the setting exists, but the trade-off is real. |
| Estimated usage | Today reports no token counts, so conversation usage is derived from character length. The plan usage on the settings page is a real reading. |
| Isolated conversations | Each request runs in a fresh `new_task` conversation, so it never pollutes your Today main chat and never carries your chat history. |

## Disabling

Disabling or removing the bundle in **Plugins** removes the `today` provider and the Settings page. Your Today account and the desktop app's sign-in state are untouched.

## License

MIT. See [LICENSE](LICENSE).
