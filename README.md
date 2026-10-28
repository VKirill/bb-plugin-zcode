# bb-plugin-zcode

**ZCode as a BB provider.** Pick "ZCode" in a BB chat and the task runs in the [ZCode](https://zcode.z.ai) desktop app (Z.ai, GLM-5.3-Flash / GLM-5.3) on your Mac, with the app's own model plan. BB shows the streamed answer, tool cards and permission requests like for any other provider.

ZCode has no public API, so a small bridge (`zcbridge`) drives the app's window through the macOS accessibility API, and reads results from ZCode's own local database (read-only). No token is extracted, no Z.ai endpoint is called by this project, and nothing inside `ZCode.app` is changed.

Русская версия: [ниже](#по-русски).

- Licence: Apache-2.0
- Requirements: macOS, the ZCode app (signed in), Python 3, Node 20+, Xcode Command Line Tools (for `swiftc`), BB with plugin SDK >= 0.6.49
- Status: works for me daily, UI-driven, so it can break when ZCode changes its screens. See [Limits](#limits).

## Install

```sh
git clone https://github.com/VKirill/bb-plugin-zcode.git
cd bb-plugin-zcode
scripts/install.sh --default-mode full      # builds zcax, installs zcbridge / zcode-acp, installs the BB plugin
```

What `scripts/install.sh` does (`--dry-run` prints it without doing it; `--uninstall` undoes it):

1. checks macOS, ZCode, Python 3, Node 20+, `swiftc`;
2. builds the accessibility helper `zcax` from `native/zcax.swift`;
3. copies `zcbridge`, `zcax`, `zcode-acp` to `~/.local/share/zcode-bridge` and links them into `--bin-dir` (default `~/.local/bin`; BB's host daemon must have that folder on its PATH, or set the plugin setting **Agent command** to the full path);
4. `--default-mode ask|auto|full` writes `~/.zcode-bridge/config.json` (the mode `zcbridge send` uses when you name none);
5. `--rewards-job` installs a LaunchAgent that claims ZCode's daily token banner (see below);
6. runs `bb plugin install` for this checkout (skip with `--no-plugin`; or install from the BB Community marketplace once listed).

**Grant Accessibility once.** macOS asks the *program that runs zcax* for permission: System Settings > Privacy & Security > Accessibility. Add your terminal (for `zcbridge` by hand) and the program that runs BB's host daemon (usually a `node` binary; `ps -axo comm | grep -i node`). Keep ZCode open and signed in; sign in inside the app, never with `zcode login` (that logs the app out).

Check: `zcbridge doctor`, or Settings > Plugins > **Провайдер ZCode** ("ZCode provider") in BB (status block).

## Settings (BB: Settings > Plugins > Провайдер ZCode)

| Setting | Default | Meaning |
|---|---|---|
| Default ZCode mode | Full access | The mode every session runs in: Plan mode, Ask before changes, Autonomous mode, Full access. |
| Chat permission mode decides | off | When on, the chat's BB permission mode wins: Accept edits runs ZCode in Autonomous mode, Full runs it in Full access. BB gives every chat one of the two, so it is off by default. |
| Autonomous mode: answers on its own | Inside the project folder | In Autonomous mode ZCode still asks for risky actions. "Inside the project folder": the plugin allows *once* file edits whose real path is in the chat folder and puts the rest to BB. "Everything": allow every request once. "Always allow" is never pressed. |
| Model override | empty | A ZCode model name; empty follows ZCode's own default model. |
| Plan that pays | Keep | See [Daily tokens and plans](#daily-tokens-and-plans). |
| Max parallel tasks | 3 | ZCode runs tasks side by side; more wait for a free slot (0 = no limit). |
| Create ZCode projects automatically | on | See [Projects](#projects). |
| Remove auto-created projects under | `~/.lane-pilot/worktrees` | Folder prefixes (one per line). A project this plugin registered for a folder under one of them is removed from ZCode's list when the session ends. |
| Forward BB instructions to ZCode | off | Sends BB's instruction block with the first prompt. ZCode has its own system prompt and reads `AGENTS.md`. |
| Agent command | `zcode-acp` | Change only if the command is not on the host daemon's PATH. |

The status block shows, per machine: ZCode app found, bridge version, running, signed in or "session expired", accessibility, the models your ZCode offers, the plan in use, the last daily-claim attempt, and (button) the quota.

The model list in BB is built from the models **your** ZCode offers (enabled ones in its Model settings), read by `zcbridge models` and cached; a model you disabled in ZCode is not offered. The default follows ZCode's own default model unless you set the override. Whatever the chip shows, the bridge reads ZCode's composer first and selects the requested model only when it differs, so it works whether or not you disabled a model.

## How it works

```
BB chat -> BB host daemon -> zcode-acp (ACP agent, Node) -> zcbridge (CLI, Python) -> zcax (Swift, accessibility)  -> ZCode window
                                                                      \-> ~/.zcode/cli/db/db.sqlite (read-only: status, streamed parts, answers, tokens)
```

- The UI is used only to **send, stop, approve and pick** things: choose project/model/mode, paste the prompt (through the composer's own context menu, ZCode is active for ~0.1-0.3 s), press Send, Stop, Allow once / Deny. Everything else (task state, answers, tool calls, usage) is read from ZCode's local database, opened read-only.
- The UI phase activates ZCode once for reliable menu events, then restores the previous app and the window’s hidden/minimized state after Send. Long prompts stay in that same activation instead of switching focus per chunk. No keystrokes are sent in the default mode. Every UI result carries `focus: {before, after, unchanged}`.
- Configure provider, model and effort in one model-menu pass; read mode and Plan chips before changing them. A cold switch to Start Plan can require another opening after checking Ready in Settings; an already selected provider needs one reading. Follow-up turns keep their task’s model and open no model menu. Results carry `ui_trace` and phase timings. Send waits for the editor to clear, handling the Start Plan suggestion with “Not now” to preserve the requested paid route.
- Tasks started by the bridge begin with a tag `[bb:xxxxxx]`, so later actions (approve, stop, continue) find the task in the sidebar by a unique title, never by a title other tasks share.
- No token extraction: `credentials.json`, cookies and Z.ai endpoints are never touched; `zcode login` is never run.

### Modes

`zcbridge send --mode plan|ask|auto|full`. Plan mode is a toggle on top of Ask: ZCode shows a "Plan" chip while it is on, the bridge turns it on only for `--mode plan` and takes it off again after the session. `--mode auto` needs `--allow-autonomous`, `--mode full` needs `--allow-full` (the plugin passes them because you chose the mode in its settings; the bridge's own `default_mode` in `~/.zcode-bridge/config.json` needs no flag). ZCode has no setting for a default mode: a task you open by hand always starts on Ask before changes.

### Projects

A chat's folder works in the ZCode project of that folder (matched by real path), or of the git repository it lies in (the prompt then says which subfolder to work in). A folder ZCode does not know yet is registered automatically through ZCode's own `zcode://workspace/open` link: ZCode shows its confirmation sheet ("Open this folder in ZCode?") and the bridge presses its **Open folder** button through accessibility. No keystrokes, no folder panel, any characters in the path (Cyrillic works), no ZCode database is written. Turn it off with the setting; `zcbridge project-add DIR` does it by hand, `zcbridge project-remove DIR` takes a project out of the list again (ZCode only marks the registry row deleted; no file of the folder is touched).

### Permission requests

ZCode's permission cards become BB permission requests ("Allow once" / "Deny"). The bridge never presses "Always allow" or the card's "Full access" button. In BB mode Full, BB allows by itself.

### Parallel tasks and slots

ZCode runs different tasks at once. The bridge holds a counting limit (`ZCODE_MAX_PARALLEL`, default 3, set by the plugin setting) over running ZCode tasks; a slot frees when its task ends or when the `zcode-acp` that holds it is gone. When a BB session ends (closed, stopped, process exit), `zcode-acp` cancels its still-running ZCode task (denies a pending card, presses Stop). `zcbridge slots` shows who holds one.

### MCP servers of the chat

The MCP servers BB passes for a thread (for example BB's own `bb-bridge` tools) are merged into `<project>/.zcode/config.json` (`mcp.servers`, names prefixed `bb-`) for the life of the session and removed afterwards. That file may hold BB tokens, so: the file is written `0600`; `.zcode/` is added to the repository's `info/exclude` first (shared by worktrees), so it can never be committed; a `config.json` that git already tracks is left alone; the keys we added (and the file, if we created it) are removed at session end, at process exit, and by the next start after a crash. ZCode reads project-level MCP config per task, so this is the only per-session place; a user-level entry would be shared by all sessions.

Optional, not done by this project: you can put your own MCP gateway into `~/.zcode/cli/config.json` (`mcp.servers`) yourself; ZCode reads it for new tasks.

### Daily tokens and plans

ZCode's server sometimes offers a claimable promo ("Start Plan": free GLM-5.3-Flash tokens each day) as a banner at the bottom left of the sidebar. `zcbridge rewards [--claim]` reports it or presses its action button through accessibility (the Rewards page in the account menu is the referral program and has no claim button). `zcbridge rewards --scheduled` is for launchd (`install.sh --rewards-job`): it acts from 10:59 UTC every minute until 12:00, then every 10 minutes until 15:00, stops after a success, and logs every attempt to `~/.zcode-bridge/rewards-attempts.log`. The schedule is the one announced for the promo I use; adapt `claim_schedule_due` in `bin/zcbridge` to yours.

Which plan pays for a task is ZCode's *connection* (Z.ai plan or Start Plan), selected in the composer's model menu under **Provider**. `zcbridge route` reads that selection, and `zcbridge route --set plan|promo` changes it (refused unless the Start Plan is Ready and no other task runs). Settings > Model settings shows account details; its provider rows do not select the connection. A new draft can restore the default connection, so the bridge selects the route after choosing the task's workspace. The plugin setting **Plan that pays**: Keep (default), Auto (promo for GLM-5.3-Flash while Ready and inside 15:00-01:00 UTC, else the plan), Always plan, Always promo. The **GLM-5.3-Flash · Free** model uses only Start Plan and refuses to start if its status is unavailable or unreadable. `zcbridge usage` has per-provider daily totals (input, cache read, fresh input, output) to compare.

### Bridge performance

Provider, model and effort are configured in one model-menu pass; transitions wait for observed UI state instead of fixed menu delays. Start Plan readiness is cached for 30 seconds and invalidated after a route failure or a rewards attempt. Free still refuses to use a paid connection. Model refreshes share a machine-wide lock and recheck the cache before opening Settings.

The watcher reuses a read-only SQLite connection and reads parts by `time_updated`, with a one-second overlap and deduplication for in-place updates. Continuations retain their event fingerprints; only a restored session needs an initial baseline. Final watch events include usage and pending approvals, avoiding extra status/approval processes. Free and paid aliases of the same physical model do not trigger model cleanup.

Paste retries first re-read the editor to detect a delayed successful paste before clearing it; native logs include phase timings without prompt contents. Install the matching `zcax` helper with `scripts/install.sh --no-plugin` when updating the bridge.

### Usage in BB

Each turn ends with ACP `usage` and a `usage_update` carrying input, cache-read, fresh-input and output tokens from ZCode's database.

## Command line

`zcbridge --help` lists everything: `doctor`, `send`, `continue`, `status`, `wait`, `watch`, `result`, `cancel`, `approvals`, `approve`, `deny`, `archive`, `tasks`, `projects`, `project-add`, `project-remove`, `models`, `usage [--quota]`, `route`, `rewards`, `mode-reset`, `slots`, `automations`, `capabilities`, `ui`, `version`. Every command prints one JSON object. An agent skill describing the safe use is in [`docs/skill/SKILL.md`](docs/skill/SKILL.md) (copy it to `~/.claude/skills/zcode-control/`).

## Limits

- It drives a GUI. A ZCode update that renames a button or moves a menu can break a step (`ui_element_missing`, `mode_not_set`); run `zcbridge ui` to see the labels. Tested with ZCode 3.16.3 (English UI).
- One window operation at a time (a file lock covers only the steps that touch the window, ~1-5 s per start).
- Each ZCode task costs about 40k input tokens before the first word; batch work into fewer, longer prompts.
- A prompt longer than ~15k characters is pasted in chunks of 8000 (ZCode turns one huge paste into an attachment).
- ZCode writes a text part to its database when a model step ends, so the answer streams per step, not per token.
- Locked screen / sleeping Mac: the accessibility API needs an unlocked, awake session.
- Sub-agent sessions of a task are not separate BB tasks.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `no_window` / `ui_element_missing` for everything | Accessibility is not granted to the program running the bridge, or ZCode is closed. Settings > Privacy & Security > Accessibility. |
| `session_expired` | Sign in again inside the ZCode app. Never `zcode login`. |
| `foreground_required` | ZCode did not accept the folder through its link; run `zcbridge project-add DIR --foreground` once while you are away. |
| `parallel_limit` | `ZCODE_MAX_PARALLEL` tasks are running; wait or raise the setting. |
| `busy` / `not_frontmost` | Another bridge command holds the window lock, or (foreground mode) another app has focus: retry. |
| The provider is missing in BB | `zcode-acp` is not on the host daemon's PATH: set the plugin setting **Agent command** to its full path. |
| Logs | `~/.zcode-bridge/bridge.log`, `acp.log`, `rewards-attempts.log`. |

## Development

```sh
npm install
npm run typecheck && npm test       # unit tests drive zcode-acp against a fake zcbridge
bb plugin build                     # builds dist/
```

## Licence

Apache-2.0, see [LICENSE](LICENSE). ZCode and Z.ai are trademarks of their owners; this project is not affiliated with them.

---

# По-русски

**ZCode как провайдер BB.** Выберите «ZCode» в чате BB, и задача выполнится в десктопном приложении [ZCode](https://zcode.z.ai) (Z.ai, GLM-5.3-Flash / GLM-5.3) на вашем Mac, по тарифу самого приложения. В BB виден потоковый ответ, карточки инструментов и запросы разрешений, как у любого провайдера.

У ZCode нет публичного API, поэтому маленький мост (`zcbridge`) управляет окном приложения через доступность macOS (Accessibility) и читает результаты из локальной базы ZCode (только чтение). Токены не извлекаются, к серверам Z.ai проект не обращается, внутри `ZCode.app` ничего не меняется.

**Требования:** macOS, ZCode (вход выполнен), Python 3, Node 20+, Xcode Command Line Tools, BB.

**Установка:** `git clone https://github.com/VKirill/bb-plugin-zcode.git && cd bb-plugin-zcode && scripts/install.sh --default-mode full`. Скрипт собирает `zcax`, ставит `zcbridge` и `zcode-acp` и плагин в BB (`--dry-run` покажет шаги, `--uninstall` откатит). Один раз вручную: Системные настройки > Конфиденциальность и безопасность > Универсальный доступ — добавить терминал и программу, которая запускает хост-демон BB (обычно `node`). ZCode держите открытым; входить нужно только внутри приложения, никогда `zcode login`.

**Настройки** (BB: Настройки > Плагины > Провайдер ZCode): режим ZCode по умолчанию (Plan / Ask / Autonomous / Full access, по умолчанию Full access), «права чата решают» (выкл.), что разрешает Autonomous сам (внутри папки проекта / всё), модель, маршрут (какой тариф платит), число параллельных задач (3), автосоздание проектов (вкл.), удаление автосозданных проектов под заданными папками, передача инструкций BB, команда агента. Блок статуса показывает приложение, версию моста, вход, доступность, модели вашего ZCode, тариф, последнюю попытку получения ежедневных токенов, квоту (по кнопке).

**Как работает:** интерфейс нужен только чтобы отправить, остановить, подтвердить и выбрать (проект, модель, режим); статус, ответы, вызовы инструментов и токены читаются из локальной базы ZCode. На время короткой настройки и отправки мост один раз активирует ZCode, затем возвращает прежнее приложение и свёрнутое/скрытое состояние окна. Длинный текст вставляется в том же проходе, без переключения фокуса на каждый кусок; клавиши в режиме по умолчанию не нажимаются. Тариф, модель и effort настраиваются в одном меню; режим и Plan меняются по показаниям чипов. При первом переходе на Free возможен дополнительный проход после проверки Ready в Settings. Продолжение диалога не открывает меню модели. Send подтверждается очисткой редактора; предложение перейти на Start Plan закрывается кнопкой «Not now», сохраняя выбранный платный тариф. Задачи получают метку `[bb:xxxxxx]`, поэтому одинаковые заголовки не мешают находить нужную задачу.

**Проекты:** чат работает в проекте ZCode своей папки (или git-репозитория, в котором она лежит). Неизвестная папка регистрируется сама через ссылку `zcode://workspace/open`: ZCode показывает своё окно подтверждения, мост нажимает «Open folder» через Accessibility. Кириллица в путях работает, клавиши не нужны, база ZCode не пишется. `zcbridge project-remove DIR` убирает проект из списка (файлы папки не трогаются).

**MCP чата:** серверы MCP, которые BB передаёт треду, на время сессии пишутся в `<проект>/.zcode/config.json` (права 0600), `.zcode/` сначала добавляется в `info/exclude` репозитория (общий для worktree), чтобы токены не попали в коммит; файл, который уже отслеживает git, не трогается; записи убираются при завершении сессии, выходе процесса и при следующем старте после сбоя.

**Ограничения:** это управление через интерфейс, обновление ZCode может сломать шаг; нужен разблокированный экран и не спящий Mac; каждая задача ZCode стоит около 40k входных токенов; ответ приходит по шагам модели, а не по токенам.

**Ежедневные токены:** `zcbridge rewards --claim` нажимает баннер получения (если он выдан сервером), `install.sh --rewards-job` ставит задание launchd; `zcbridge route --set promo` переключает тариф на промо Start Plan. Подробности выше.

**Быстродействие:** тариф, модель и effort настраиваются за один проход меню; переходы ждут состояния интерфейса. Ready кэшируется на 30 секунд с аннулированием после ошибки маршрута или попытки получения токенов. Watch читает изменённые части через одно read-only соединение SQLite; данные токенов и разрешений передаются без дополнительных запросов. Free не вызывает сброс той же физической модели. После обновления моста установите соответствующий помощник `zcax`: `scripts/install.sh --no-plugin`.

**Выбор тарифа:** подключение выбирается в меню модели → Provider → Start Plan Free; строка Start Plan в настройках показывает сведения о тарифе. Мост проверяет выбор в композере после выбора папки задачи. Модель **GLM-5.3-Flash · Free** запускается только на стартовом тарифе; если статус не удалось прочитать, это отдельная ошибка, а не сообщение об отсутствии токенов.

Лицензия: Apache-2.0.
