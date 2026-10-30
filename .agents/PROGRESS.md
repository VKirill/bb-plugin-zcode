## Now
- BB provider "ZCode" (window): drives the ZCode desktop app via zcbridge/zcax accessibility — send, stop, approve, pick project/model/mode/route; streams answers, tool cards, permissions and usage from the app's local SQLite (read-only); parallel slots with a queue for the free plan, auto project registration, daily token claim.
- BB provider "ZCode CLI" (headless, shipped 2026-10-30): runs the bundled `zcode.cjs` per turn signed in with a Coding Plan API key (`zcode-cli-acp set-key` / `status`, encrypted 0600, one data dir per model), `--resume` per BB session, `--attach` for long prompts, streaming from the same DB, cancel; Start Plan is not available on this path.
- Chat MCP servers are merged into `<project>/.zcode/config.json` (0600, cleaned up at session end); permission requests and usage updates flow into BB for both providers.
- Docs: README EN/RU covering both providers, limits and troubleshooting; agent skill in docs/skill.

## Blocked
- none

## Next
- [ ] Install the updated plugin (`scripts/install.sh`) and run a live BB chat on ZCode CLI to confirm end-to-end

## Last verify
- command: node --test tests/zcode-cli-acp.test.mjs && npm run typecheck
- result: green (5/5 tests pass, tsc clean)
- when: 2026-10-30

## Pointers
- Open todos: none (.agents/todos/ not initialized)
- Plans: .agents/plans/zcode-cli-provider.md (verified facts, done), .agents/plans/items/zcode-cli-provider-key/PLAN.md (shipped)
- Changelog: .agents/CHANGELOG.md
