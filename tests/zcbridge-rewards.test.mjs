import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bridge = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "zcbridge");

// Runs zcbridge's sidebar_banner_buttons on an accessibility dump without starting the bridge.
function bannerButtons(dump) {
  const py = [
    "import importlib.machinery, importlib.util, sys",
    "sys.argv = ['zcbridge']",
    "loader = importlib.machinery.SourceFileLoader('zcb', " + JSON.stringify(bridge) + ")",
    "m = importlib.util.module_from_spec(importlib.util.spec_from_loader('zcb', loader)); loader.exec_module(m)",
    "import json; print(json.dumps(m.sidebar_banner_buttons(sys.stdin.read())))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", py], { input: dump, encoding: "utf8" }));
}

const tasks = [
  '      AXGroup/AXLandmarkRegion d="Tasks"',
  '        AXButton t="Tasks"',
  '        AXButton d="New task"',
  '        AXStaticText v="Some task"',
];
const account = [
  '    AXPopUpButton d="Owner" id=radix-1',
  '      AXStaticText v="Owner"',
  '    AXButton d="Mobile remote control"',
  '    AXButton d="Settings"',
];

test("rewards: the claim banner is found inside the sidebar footer (ZCode 2026-10 layout)", () => {
  const dump = [...tasks, '  AXGroup/AXSectionFooter', '    AXGroup', '      AXButton d="Open"', '      AXButton d="Close"', ...account].join("\n");
  assert.deepEqual(bannerButtons(dump), ["Open", "Close"]);
});

test("rewards: the claim banner is still found above the footer (older layout)", () => {
  const dump = [...tasks, '  AXButton d="Claim 300M tokens"', '  AXButton d="Close"', '  AXGroup/AXSectionFooter', ...account].join("\n");
  assert.deepEqual(bannerButtons(dump), ["Claim 300M tokens", "Close"]);
});

test("rewards: no banner means no buttons (account and settings buttons are not taken for it)", () => {
  const dump = [...tasks, '  AXGroup/AXSectionFooter', ...account].join("\n");
  assert.deepEqual(bannerButtons(dump), []);
});
