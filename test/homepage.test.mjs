import { test } from "node:test";
import assert from "node:assert/strict";
import { addVisit, DAY, normalizeHistory, rankVisits, remapHistory } from "../src/history.ts";
import { readShortcuts, shortcutRows } from "../src/shortcuts.ts";

const now = 100 * DAY;

test("Recent tracks actual recency and repeated pane events do not inflate visits", () => {
  let visits = addVisit([], "Projects/A.md", now, false);
  assert.equal(addVisit(visits, "Projects/A.md", now + 1000, true), visits);
  visits = addVisit(visits, "B.md", now + 2000, false);
  visits = addVisit(visits, "Projects/A.md", now + 3000, false);
  assert.deepEqual(rankVisits(visits, "recent", now + 3000).map(v => v.path), ["Projects/A.md", "B.md"]);
  assert.equal(visits[0].opens.length, 1);
  visits = addVisit(visits, "Projects/A.md", now + 17_000, false);
  assert.equal(visits[0].opens.length, 2);
});

test("Frequent uses real visits, weights freshness and expires the 14-day window", () => {
  const visits = [
    { path: "old.md", last: now - 13 * DAY, opens: [now - 13 * DAY, now - 13 * DAY - 20_000] },
    { path: "fresh.md", last: now, opens: [now] },
    { path: "expired.md", last: now - 15 * DAY, opens: [now - 15 * DAY] }
  ];
  assert.deepEqual(rankVisits(visits, "frequent", now).map(v => v.path), ["fresh.md", "old.md"]);
  assert.equal(rankVisits(visits, "recent", now).length, 3);
});

test("Folder renames and deletes propagate and history remains bounded", () => {
  const opens = Array.from({ length: 5_000 }, (_, i) => now - i * 20_000);
  const many = Array.from({ length: 305 }, (_, i) => ({ path: "A/" + i + ".md", last: now - i, opens }));
  const records = normalizeHistory(many, now);
  assert.equal(records.length, 300);
  assert.ok(records.reduce((sum, v) => sum + v.opens.length, 0) <= 4000);
  const moved = remapHistory(records, "A", "B", now);
  assert.equal(moved[0].path, "B/0.md");
  assert.equal(remapHistory(moved, "B", null, now).length, 0);
});

test("The selected profile preserves shortcut order, aliases, and supported types", () => {
  const config = {
    vaultProfile: "default", syncModes: { vaultProfile: "synced" },
    folderColors: { FreeWM: "#3b82f6" },
    vaultProfiles: [
      { id: "default", shortcuts: [
        { type: "folder", path: "FreeWM", alias: "Current project" },
        { type: "tag", path: "ignore" },
        { type: "note", path: "idea.md" },
        { type: "note", path: "diagram.canvas" }
      ] },
      { id: "device", shortcuts: [{ type: "note", path: "local.md" }] }
    ]
  };
  const initial = readShortcuts(config, "device");
  assert.deepEqual(initial.map(s => s.path), ["FreeWM", "idea.md"]);
  assert.equal(initial[0].alias, "Current project");
  assert.equal(initial[0].color, "#3b82f6");
  config.syncModes.vaultProfile = "local";
  assert.deepEqual(readShortcuts(config, "device").map(s => s.path), ["local.md"]);
  config.vaultProfiles[1].shortcuts = [{ type: "folder", path: "new" }];
  assert.deepEqual(readShortcuts(config, "device").map(s => s.path), ["new"]);
  config.vaultProfiles[1].shortcuts = [];
  assert.deepEqual(readShortcuts(config, "device"), []);
  assert.equal(readShortcuts({ invalid: true }), null);
});

test("Pinned rows group neighboring entries by top-level folder and preserve order", () => {
  const items = [
    { item: { type: "folder", path: "Research/Projects/A" } },
    { item: { type: "folder", path: "Research/Projects/B" } },
    { item: { type: "note", path: "Research/idea.md" } },
    { item: { type: "note", path: "Personal/checklist.md" } },
    { item: { type: "folder", path: "Research/Projects/C" } }
  ];
  const rows = shortcutRows(items);
  assert.deepEqual(rows.map(row => row.length), [3, 1, 1]);
  assert.deepEqual(rows.flat(), items);
});
