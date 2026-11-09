import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const api = await readFile(new URL("../api/index.php", import.meta.url), "utf8");
function load(name, context) {
  const start = source.indexOf(`async function ${name}(`);
  vm.runInContext(source.slice(start, source.indexOf("\nfunction ", start + 1)).split(`\nasync function `)[0], context);
}
function fixture(overrides = {}) {
  const nodes = new Map();
  const calls = [];
  const context = vm.createContext({
    $: (key) => {
      if (!nodes.has(key)) nodes.set(key, {});
      return nodes.get(key);
    },
    remoteSession: { role: "owner" }, backupBusy: false, pendingConfirm: null,
    pendingRemoteBoardIds: new Set(), remoteWritesInFlight: 0, remoteSyncInFlight: false,
    remoteVersions: new Map([["root", 2]]), boardRecords: new Map(),
    saveTimer: null, board: { id: "root" }, history: ["old"], redoHistory: [],
    async saveImmediately() { calls.push("save"); },
    async apiRequest(action, request) {
      calls.push([action, request]);
      return action === "boards"
        ? { boards: [{ id: "root", version: 3, data: { id: "root", items: ["restored"] } }] }
        : { backups: [{ slot: "approved", revision: 1, saved_at: "2026-11-09" }] };
    },
    async deserializeBoard(value) { return value; }, normalizeBoard: (value) => value,
    remoteCacheRecord: (value) => value, async writeRecords() { calls.push("cache"); },
    renderBoard() {}, updateHistoryButtons() {}, showToast() {}, showDialog() { calls.push("dialog"); },
    ...overrides,
  });
  load("executeBackupAction", context);
  load("prepareBackupAction", context);
  return { context, nodes, calls };
}

test("members cannot request or execute backup actions in UI", async () => {
  const { context, calls } = fixture({ remoteSession: { role: "member" } });
  await context.prepareBackupAction("approve");
  await context.executeBackupAction("restore", "approved", 1);
  assert.equal(calls.length, 0);
});

test("backup preparation reports missing migration and missing protected copy", async () => {
  const failure = fixture({ apiRequest: async () => { throw new Error("Importez migration-backups.sql"); } });
  await failure.context.prepareBackupAction("approve");
  assert.match(failure.nodes.get("#backup-status").textContent, /migration-backups/);
  const empty = fixture({ apiRequest: async () => ({ backups: [] }) });
  await empty.context.prepareBackupAction("restore");
  assert.equal(empty.context.pendingConfirm, null);
  assert.match(empty.nodes.get("#backup-status").textContent, /Aucune version/);
});

test("approval is explicit, flushes current work and sends expected server versions", async () => {
  const { context, calls, nodes } = fixture();
  await context.prepareBackupAction("approve");
  assert.equal(calls.filter((call) => Array.isArray(call) && call[1]?.method === "POST").length, 0);
  await context.pendingConfirm();
  const post = calls.find((call) => Array.isArray(call) && call[1]?.method === "POST");
  assert.equal(calls.indexOf("save") < calls.indexOf(post), true);
  assert.equal(post[1].body.versions.root, 2);
  assert.equal(post[1].body.operation, "approve");
  assert.equal(context.backupBusy, false);
  assert.equal(nodes.get(".app-shell").inert, false);
});

test("conflicts and ongoing requests prevent backup mutations", async () => {
  for (const overrides of [
    { pendingRemoteBoardIds: new Set(["root"]) }, { remoteWritesInFlight: 1 }, { remoteSyncInFlight: true },
  ]) {
    const { context, calls, nodes } = fixture(overrides);
    await context.executeBackupAction("restore", "approved", 1);
    assert.equal(calls.length, 0);
    assert.match(nodes.get("#backup-status").textContent, /conflit/);
  }
});

test("restoration refreshes versions and cache and clears pre-restore undo history", async () => {
  const { context, nodes, calls } = fixture();
  await context.executeBackupAction("restore", "approved", 1);
  assert.equal(context.remoteVersions.get("root"), 3);
  assert.equal(context.board.items[0], "restored");
  assert.equal(context.history.length, 0);
  assert.equal(calls.includes("cache"), true);
  assert.match(nodes.get("#backup-status").textContent, /récupérable/);
});

test("reload failure after successful restore blocks stale writes and explains recovery", async () => {
  const { context, nodes } = fixture({
    async apiRequest(action) {
      if (action === "boards") throw new Error("Hors ligne");
      return { saved: true };
    },
  });
  await context.executeBackupAction("restore", "approved", 1);
  assert.equal(context.pendingRemoteBoardIds.has("root"), true);
  assert.match(nodes.get("#backup-status").textContent, /Restauration effectuée.*rechargement incomplet/);
  assert.equal(nodes.get(".app-shell").inert, false);
});

test("API backup route enforces owner, CSRF, workspace isolation and shared transaction lock", () => {
  const route = api.slice(api.indexOf("if ($action === 'backup'"), api.indexOf("if ($action === 'boards'"));
  assert.ok(route.indexOf("pixelboard_require_owner($user)") < route.indexOf("$method === 'GET'"));
  assert.ok(route.indexOf("pixelboard_require_csrf()") < route.indexOf("$db->beginTransaction()"));
  assert.ok(route.indexOf("pixelboard_require_csrf()") < route.indexOf("pixelboard_install_backups($db)"));
  assert.match(route, /'backups' => \[\], 'installed' => false/);
  assert.match(route, /WHERE workspace_id = \? AND slot = \? FOR UPDATE/);
  assert.match(route, /pixelboard_backup_versions_match/);
  assert.match(route, /pixelboard_valid_backup_records/);
  assert.match(route, /'before_restore'/);
  assert.doesNotMatch(route, /DELETE FROM/);
  const normalWrite = api.slice(api.indexOf("if ($action === 'board' && $method === 'PUT')"));
  assert.match(normalWrite, /SELECT id FROM workspaces WHERE id = \? FOR UPDATE/);
  assert.doesNotMatch(normalWrite, /UPDATE workspace_backups|INSERT INTO workspace_backups/);
});

test("backup auto-install is additive and idempotent and matches the manual schema", async () => {
  const lib = await readFile(new URL("../api/lib.php", import.meta.url), "utf8");
  const migration = await readFile(new URL("../api/migration-backups.sql", import.meta.url), "utf8");
  const sql = lib.match(/\$db->exec\("(CREATE TABLE IF NOT EXISTS workspace_backups[\s\S]*?)"\);/)[1];
  const normalize = (value) => value.replace(/IF NOT EXISTS /, "").replace(/;\s*$/, "").replace(/\s+/g, " ").trim();
  assert.equal(normalize(sql), normalize(migration));
  assert.doesNotMatch(sql, /\b(DROP TABLE|DELETE FROM|TRUNCATE|ALTER TABLE)\b/i);
});
