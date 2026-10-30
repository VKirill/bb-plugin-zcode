# Context — > **Почему Free пока нельзя пустить так же, как Paid.** Бесплатный Start Plan с…

Goal: > **Почему Free пока нельзя пустить так же, как Paid.** Бесплатный Start Plan сервер выдаёт только сессии приложения. Хост приложения передаёт его своим внутренним процессам. Отдельно запущенный движок, как у Paid, Start Plan не получает. Это я проверил ещё утром.

вот как мы можем все это программно воссоздать чтобы могли приложение держать просто свернутым? Без проблемной работы и большей интегрированность чтобы была с бб

## Appetite
Medium appetite: 1 phase, 1–2 days, ~200–300 lines of code across bridge and helper modules. Focus is strictly on keeping ZCode minimized/background without focus theft.

Scope: medium; recommendation: go_with_conditions; confidence: 92.

## Decisions
- **D1** (locked): Start Plan cannot be used via standalone `zcode -p` without host authorization; the standalone CLI fails with missing model entitlement (account:zai-start-plan).
- **D2** (locked): Start Plan operates under strict 15:00–01:00 UTC promo window and concurrency limit of 1 task; requests outside hours or exceeding concurrency must be queued or refused gracefully.
- **D3** (locked): Zero modifications allowed to files, scripts, or ASAR packages inside `/Applications/ZCode.app`.
- **D4** (free): Planner chooses implementation mechanism: Option 1 (stdio host emulator for `zcode.cjs app-server`), Option 2 (direct Anthropic Messages API client to Start Plan endpoint), or Option 3 (non-intrusive off-screen windowing in `native/zcax.swift`).
- **D5** (deferred): Standalone Start Plan operation without the desktop app being signed in (requires reverse-engineering OAuth web login, which invalidates the desktop app session).

## No-gos
- Modifying `/Applications/ZCode.app` binaries or ASAR packages.
- Extracting or sending tokens over the network to any third-party endpoints.
- Attempting to bypass the Z.ai 15:00–01:00 UTC Start Plan time window or 429 concurrency limits.
- Breaking or altering the existing Paid headless CLI path in `bin/zcode-cli-acp.mjs`.

## Risks
- value: Start Plan is active only between 15:00 and 01:00 UTC (16:00–02:00 Madrid); outside this window requests fail with quota error regardless of window state.
- usability: In the current AX implementation, `app.activate()` in `native/zcax.swift:244` interrupts user typing; if window is moved off-screen, user cannot visually inspect conversation in GUI.
- feasibility: Future ZCode desktop updates could alter internal `app-server` JSON-RPC messages or change encryption key derivation for `credentials.json`.
- viability: High concurrency triggers HTTP 429 («user concurrency limit exceeded»); the free queue in `bin/zcode-acp.mjs:580` must strictly serialize free turns.
- security: If session JWT is read from `~/.zcode/v2/credentials.json`, the decryption key and token must never be logged, committed, or exposed outside 0600 local process memory.

## Open questions
- Does the owner prefer zero token extraction via off-screen windowing / mobile relay, or local JWT session reading for pure headless execution?
- When Start Plan is invoked after 15:00 UTC, does `app-server` require any runtime headers beyond `Bearer <zcodejwttoken>`?

Written by Lane Pilot from the analysis (lp.analyze); the plan stands on this file.