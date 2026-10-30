## Now
- BB provider "ZCode" (window): drives the ZCode desktop app via zcbridge/zcax accessibility — send, stop, approve, pick project/model/mode/route; streams answers, tool cards, permissions and usage from the app's local SQLite (read-only); parallel slots with a queue for the free plan, auto project registration, daily token claim.
- One provider, two tariffs (shipped 2026-10-30): the tariff is in the model name — «· Free» runs on the Start Plan through the window; with a Coding Plan key stored (`zcode-cli-acp set-key`) the CLI-capable models (GLM-5.3-Flash, GLM-5.3) are named «· Paid» and their turns run headless in a `zcode-cli-acp.mjs` child (lazy session/new, respawn on exit); without a key they keep plain names and run on the plan through the window. Switching free↔paid starts a fresh conversation.
- ZCode CLI mechanics (headless): bundled `zcode.cjs` per turn, Coding Plan API key stored encrypted 0600 in a per-model data dir, `--resume` per BB session, `--attach` for long prompts, pretty-printed `--json` result parsed (fixed 2026-10-30), streaming from the app DB, cancel; Start Plan is not available on this path.
- Chat MCP servers are merged into `<project>/.zcode/config.json` (0600, cleaned up at session end); permission requests and usage updates flow into BB for both the window and the CLI backend.
- Docs: README EN/RU covering the one provider, both tariffs, limits and troubleshooting; agent skill in docs/skill.

## Blocked
- none

## Next
- [ ] Install the updated plugin (`scripts/install.sh`) and run a live BB chat on the single "ZCode" provider — one free and one paid turn — to confirm end-to-end

## Last verify
- command: env TMPDIR=/tmp node --test tests/zcode-cli-acp.test.mjs tests/zcode-acp.test.mjs tests/modes-and-safety.test.mjs && npm run typecheck && node .agents/checks/zcode-one-provider.mjs && bash .agents/checks/zcode-cli-pretty-json.sh
- result: green (43/43 tests, tsc clean, both checks pass)
- when: 2026-10-30

## Pointers
- Open todos: none (.agents/todos/ not initialized)
- Plans: .agents/plans/zcode-cli-provider.md (verified CLI facts); items all done 2026-10-30: zcode-cli-provider-key, zcode-cli-pretty-json-fix, zcode-one-provider.3 (zcode-cli-pretty-json closed on the base, fixed by -fix)
- Changelog: .agents/CHANGELOG.md
