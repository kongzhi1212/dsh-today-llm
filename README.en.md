<div align="center">

# Today models

Use the account already signed in by the **Today desktop app** from DeepSeek Harness — one account, and **GLM, Kimi, Qwen, MiniMax, DeepSeek** become available, with per-model usage multipliers, a full settings page and diagnostics.

[中文](README.md) · [Install](#install) · [Models](#which-models-you-get) · [Settings](#settings-page) · [Known limits](#known-limits) · [Changelog](https://github.com/kongzhi1212/dsh-today-llm/releases) · [Issues](https://github.com/kongzhi1212/dsh-today-llm/issues)

[![release](https://img.shields.io/github/v/release/kongzhi1212/dsh-today-llm?color=blue)](https://github.com/kongzhi1212/dsh-today-llm/releases)
[![license](https://img.shields.io/github/license/kongzhi1212/dsh-today-llm?color=green)](https://github.com/kongzhi1212/dsh-today-llm/blob/main/LICENSE)
[![ci](https://img.shields.io/github/actions/workflow/status/kongzhi1212/dsh-today-llm/ci.yml?label=tests)](https://github.com/kongzhi1212/dsh-today-llm/actions/workflows/ci.yml)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#requirements)

</div>

> **This is not an ordinary API plugin. Read this before installing.**
>
> 1. **It is not a real model channel.** Today has no OpenAI-compatible completion endpoint; every request is handed to Today's own agent. So replies are **not streamed token by token**, the agent's own personality and memory still shape the answer (the prompt asks it to ignore them, which cannot be fully enforced), and **its own tools cannot be disabled** — it may read files or browse on its own, so any "I did X" answer must not be taken as fact.
> 2. **The model choice is account-wide.** Today stores one active model per account and its message endpoint ignores any per-request model field. Selecting a model in DSH therefore changes it for the whole account, including the Today app on your phone. Concurrency defaults to one to stop two requests on different models from retargeting each other mid-flight.
> 3. **It spends real quota.** Nothing here bypasses billing: every request consumes your allowance under Today's own rules.
> 4. **It depends on upstream internals.** The plugin reads the desktop app's encrypted credentials and calls its private API. An upstream change can break it.
>
> This is an independent interoperability adapter. It is **not affiliated with, authorised by, or endorsed by Today**.

## Which models you get

The selector is driven by **your account's** Today catalog, not a fixed list. These are the ones connected here today:

| Vendor | Model | Usage multiplier |
| --- | --- | --- |
| DeepSeek | DeepSeek V4.1 Flash | `1×` |
| MiniMax | MiniMax M3.1 Flash | `1×` |
| Zhipu | GLM 5.3 Flash | `1×` |
| Zhipu | GLM 5.3 | `4×` |
| Alibaba | Qwen3.8 Max | `5×` |
| Moonshot | Kimi K3.1 Pro | `8×` |
| Moonshot | Kimi K3.1 Pro Highspeed | `16×` |

The multiplier is Today's own rate, shown as-is. When the catalog changes the selector follows on its own, so this table is a measured snapshot rather than a ceiling.

## What it does

- Reads **this account's** own model catalog, so the selector shows exactly the models that account may use, each with Today's usage multiplier (such as `4×`).
- Re-reads that catalog periodically, so account-side changes reach the selector without a restart.
- Pushes the selected model to the account before each turn, so the model you pick is the model that runs.
- Adds a full page under **Settings → Today**: the connected account, the plan and remaining usage, the models (each one can be hidden or given its own context window), editable plugin settings, recent background tasks, and the latest diary entry.

## Install

Three routes; pick whichever fits.

**① Windows, no command line**

Download the `.tgz` and `install-windows.bat` from [Releases](https://github.com/kongzhi1212/dsh-today-llm/releases) into the same folder, then double-click the `.bat`. It locates the harness itself and installs into the `desktop` profile.

**② Offline bundle, any platform**

```bash
dsh plugin --profile desktop add ./dsh-today-llm-1.5.3.tgz
```

**③ From source, for development**

```bash
pnpm install
dsh plugin --profile desktop add /path/to/dsh-today-llm
```

Or point DSH's **Plugins → Add plugin** at this directory.

> Copying the directory to another machine does not work: the plugin depends on `@deepseek-ai/schemastery` and needs a real `node_modules`. Use the `.tgz`, which installs its dependency too.
>
> This plugin is **not published to npm**, so `dsh plugin add dsh-today-llm` by name will not work — use the offline bundle or the source directory above.

Requirement: the Today desktop app must be signed in on this machine. The plugin only ever reads the app's credential files, never writes them.

### Troubleshooting

One command reports credential state, deployment, token refresh, catalog and allowance:

```bash
node bin/doctor.js          # from the source directory
```

After a `.tgz` install the package lives under the profile, for example:

```powershell
node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-today-llm\bin\doctor.js"
```

Exit code 0 means usable, 1 means something fatal. Read-only throughout.

### Compatibility

| DSH version | Status |
| --- | --- |
| `0.2.2-rc.5` | ✅ Verified here: settings page, diagnostics, event stream, model selection |
| Other `0.2.x` | ⚠️ Untested; should work if no public API changed |
| `0.3.x` | ⚠️ Untested |

Only versions actually exercised are marked verified. An honest "untested" beats a tick mark nobody checked.

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
| Deployment | detect automatically | `auto`, mainland China, or international. The two are separate account systems, so the wrong choice finds no account |
| Turn timeout | 300 s | How long to wait for one Today turn |
| Poll interval | 700 ms | How often to re-read the conversation when falling back to polling |
| Catalog refresh | 600 s | How often to re-read the model catalog; `0` disables it |
| Default context window | 200000 | Used by every model without its own override |
| Concurrent turns | 1 | See the risk note below |
| Strict JSON protocol | on | Turning it off gives more natural prose but **breaks tool calls** |
| Pushed event stream | on | Receive replies over WebSocket; falls back to polling on its own |
| Report estimated usage | on | Turning it off stops emitting token counts |

Each model row also has a visibility toggle and an optional context-window override.

### How replies arrive

Replies come over Today's pushed channel rather than polling:

```
POST /registry/devices -> POST /ws-ticket -> wss://.../ws?ticket=...
  -> device.hello -> chat.message_ready.v2 events -> isFinal closes the turn
```

A reply is therefore delivered as soon as Today writes it, which is faster and cheaper than asking every 700 ms. A failed handshake falls back to the HTTP poll; after three consecutive failures the event stream **pauses for five minutes** and then retries on its own, polling in the meantime — **a broken socket never costs you the answer**. The diagnostics section shows which of the three states it is in: enabled, paused (with the remaining seconds), or switched off. Turn the "Pushed event stream" setting off to force polling.

### New models appear on their own

When Today lists a new model, the plugin notices on its next catalog refresh (ten minutes by default) and emits the harness `llm/models-updated` event, so the model selector reloads **without restarting DSH**. The event fires only when the advertised set actually changed, so a steady catalog does not churn subscribers on every poll.

### Data routes

The page uses the host's own HTTP routes, behind the same launch cookie as every other host route:

- `GET /dsh-today-llm/status` — the status snapshot
- `POST /dsh-today-llm/config` — configuration writes (only the fields this page owns)

These paths **must** stay outside `/api`: the connection layer claims that whole prefix with a prefix route, so a resource registered there is never matched.

## The concurrency risk

Today stores the model choice per account. At concurrency 1 the sequence "pin the model, start the turn, wait for the reply" is atomic. At 2 or more, two requests on different models can rewrite the conversation the other is still waiting on. Two requests on the same model are unaffected, so raising it is safe for a fixed workflow — but that is your call to verify.

## Requirements

The Today desktop app must be signed in. The plugin reads its session from the app's user-data directory.

Today ships **two independent deployments** with separate accounts:

| Region | User-data directory | API / auth hosts |
| --- | --- | --- |
| Mainland China (`cn`) | `Today CN` | `api.todayai.cn` / `auth.todayai.cn` |
| International (`global`) | `Today` | `api.today.ai` / `auth.today.ai` |

With `region` at its default of `auto`, both are probed — CN first — and the settings page shows which one answered.

Credentials come in two envelopes, chosen by the file's own magic rather than by platform:

- **`v10`** — Chromium safeStorage. The key rides in `os_crypt.encrypted_key` inside `Local State`, protected by the platform secret store (DPAPI / Keychain / libsecret).
- **`TDK1`** — Today's own envelope, keyed from the macOS Keychain item `ai.today.desktop.account-credentials`. The macOS build uses this instead of safeStorage.

The session itself lives in `account-credentials.slot-*`. All of this is **read-only**: not one byte of the Today desktop app's files is modified.

## Development

```bash
pnpm install
pnpm test    # node --test, 34 cases
pnpm check   # per-file syntax check
```

The tests cover pure logic only: reply parsing, envelope layout, request headers and failure codes, and the concurrency lock. They **never touch the network or a real credential** — the credential cases redirect the probe path to an empty temporary directory, so a failure message cannot carry your account details.

The Node floor is `>=22.4.0`, not because of new syntax but because `globalThis.WebSocket` only became stable in Node 22.4. Below that the plugin still runs, but the event-stream path silently degrades to polling.

## Known limits

| Limit | Explanation |
| --- | --- |
| No token-level streaming | Today has no completion endpoint, so the reply lands in one piece. The adapter emits a single text block. |
| Shaped by the agent's persona | The request goes to Today's own agent, whose persona and long-term memory still colour the answer. |
| Its own tools stay enabled | That agent has file, command and connector tools the API cannot disable. |
| Account-wide model choice | See the risk note above; the setting exists, but the trade-off is real. |
| Estimated usage | Today reports no token counts, so conversation usage is derived from character length. The plan usage on the settings page is a real reading. |
| Context window is an assumption | **Today's API does not report context length** — the catalog carries only name, usage multiplier and publisher. `defaultContextWindow` is a conservative guess, not a measurement; tune per model via `models` if you know better. |
| Isolated conversations | Each request runs in a fresh `new_task` conversation, so it never pollutes your Today main chat and never carries your chat history. |

## Disabling

Disabling or removing the bundle in **Plugins** removes the `today` provider and the Settings page. Your Today account and the desktop app's sign-in state are untouched.

## Disclaimer

**Unofficial tool.** This is an independent, third-party interoperability project. It has no commercial affiliation, official partnership, or technical authorization with Today AI, DeepSeek AI, or any of their affiliates, and is not endorsed by them. All trademarks belong to their respective owners.

**Usage is billed normally.** This tool only translates network protocols and bridges the local credential. It does not bypass, forge, or cache any part of the billing path. Every call it makes is charged to the account of the person using it, at the upstream provider's published rates.

**Terms-of-service risk.** This tool calls undocumented upstream endpoints, and doing so may violate the upstream platform's terms of service. You accept that risk yourself, including any consequence such as account restriction, quota changes, or loss of access. The author is not responsible for those consequences.

**Takedown on request.** The maintainer respects the intellectual property and commercial interests of others. If a rights holder has a reasonable, legitimate objection to this project, please open a [GitHub Issue](https://github.com/kongzhi1212/dsh-today-llm/issues); the code will be amended or removed within 24–48 hours.

## Acknowledgements

Released as open source under the **MIT License**.

- **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai)** — for a modern Agentic host ecosystem. Everything this plugin stands on comes from it: the plugin contract, the LLM adapter interface, the settings-page slots, and the Host web routes.
- **[dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)** — with particular thanks. This project leaned heavily on its practice and experience around DSH plugin conventions, architecture, and open-source engineering.
- **[xuemei-wintersweet/dsh-today](https://github.com/xuemei-wintersweet/dsh-today)** — an independent take on connecting Today to DSH. This project drew on it for details of the event-stream protocol and for its approach to decrypting the local credential.

## License

MIT. See [LICENSE](https://github.com/kongzhi1212/dsh-today-llm/blob/main/LICENSE). You may use, modify, and redistribute this software, including commercially, provided the copyright and permission notices are retained. It is provided "as is", without warranty of any kind.
