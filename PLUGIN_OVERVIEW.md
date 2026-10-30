Run BB chats on the ZCode desktop app (Z.ai GLM-5.3-Flash and GLM-5.3) on your Mac, with the app's own plan.

## What you get

- **ZCode as a provider** in the BB composer: streamed answers, tool cards, permission requests, token usage.
- **Two tariffs in one provider**: models named «· Paid» run on the Coding Plan through the ZCode CLI, headless (`zcode-cli-acp set-key`); with the app signed in, «· Free» models run headless on the Start Plan through the CLI too. The window is the fallback, so the app can stay minimized.
- **Modes you choose in Settings > Plugins > ZCode provider**: Full access (default), Autonomous, Ask before changes, Plan.
- **Projects handled for you**: a chat's folder works in the ZCode project of that folder; unknown folders are registered through ZCode's own open-folder link, even with non-ASCII paths.
- **Parallel tasks** (default 3), models read from your ZCode, optional daily free-token claim.
- A **status block** on the settings page: app found, bridge version, signed in, accessibility, models, plan, quota.

## How it works

A small bridge drives the ZCode window through the macOS accessibility API only to send, stop, approve and pick things, and reads task state and answers from ZCode's local database (read-only). No token is extracted, no Z.ai endpoint is called, nothing inside the app is modified. The macOS-only bridge is installed once with `scripts/install.sh` (it builds the accessibility helper and asks you to grant Accessibility).

## Requirements

macOS, the ZCode app signed in, Python 3, Node 20+, Xcode Command Line Tools. ZCode has no public API, so a ZCode update can break a step; see the README for limits and troubleshooting.
