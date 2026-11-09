import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { newCatalogue, fieldDefault, migrateValues, schemaChanges, snapshotMerge, itemSyncState, catalogueId } from "../src/items-model.js";
import { initItemsUI } from "../src/items-ui.js";

const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const schema = { families: [{ type: "TilesClass", fields: [
  { name: "name", kind: "string", default: "Bloc" },
  { name: "drops", kind: "list", element: { name: "element", kind: "object", fields: [
    { name: "amount", kind: "int", default: 1 }, { name: "sprite", kind: "asset", type: "UnityEngine.Sprite" },
  ] } },
] }] };
const unity = { guid: "c".repeat(32), file_id: "9223372036854775806", fingerprint: hash, type: "TilesClass", name: "Pierre", values: { name: "Pierre", drops: [] } };
const snapshot = { schema, schema_hash: hash, items: [unity], assets: [] };

test("new catalogue is typed, reserved and contains no board card copies", () => {
  const record = newCatalogue("project", snapshot);
  assert.equal(record.id, catalogueId("project"));
  assert.equal(record.recordType, "item-catalogue");
  assert.deepEqual(record.items, []);
  assert.deepEqual(record.definitions, []);
});

test("recursive defaults are cloned and preserve fileID precision and explicit null references", () => {
  const template = schema.families[0].fields[1].element;
  assert.deepEqual(fieldDefault(template), { amount: 1, sprite: null });
  const first = fieldDefault(template);
  first.amount = 99;
  assert.equal(fieldDefault(template).amount, 1);
  const ref = fieldDefault({ kind: "asset", default: { guid: unity.guid, file_id: unity.file_id } });
  assert.equal(ref.file_id, "9223372036854775806");
});

test("Unity merge imports once, preserves website edits and requires explicit conflict choice", () => {
  let sequence = 0;
  const createId = () => `item-${++sequence}`;
  const initial = snapshotMerge(newCatalogue("p", snapshot), snapshot, createId).catalogue;
  assert.equal(initial.definitions.length, 1);
  const repeat = snapshotMerge(initial, snapshot, createId);
  assert.equal(repeat.catalogue.definitions.length, 1);
  assert.equal(repeat.conflicts.length, 0);
  initial.definitions[0].values.name = "Pierre modifiée sur le site";
  const conflict = snapshotMerge(initial, snapshot, createId);
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.catalogue.definitions[0].values.name, "Pierre modifiée sur le site");
  const accepted = snapshotMerge(initial, snapshot, createId, new Set(["item-1"]));
  assert.equal(accepted.catalogue.definitions[0].values.name, "Pierre");
  assert.equal(accepted.catalogue.definitions[0].revision, 2);
  assert.equal(initial.definitions[0].values.name, "Pierre modifiée sur le site");
});

test("schema review preserves removed and incompatible values and adds nested defaults", () => {
  const previous = { families: [{ type: "TilesClass", fields: [{ name: "old", kind: "int" }, { name: "name", kind: "int" }] }] };
  const changes = schemaChanges(previous, schema);
  assert.ok(changes.some((change) => change.startsWith("Retrait : TilesClass.old")));
  assert.ok(changes.some((change) => change.startsWith("Type modifié : TilesClass.name")));
  const migrated = migrateValues(schema.families[0].fields, { old: 42, name: 7 });
  assert.deepEqual(migrated, { old: 42, name: 7, drops: [] });
  const nested = migrateValues(schema.families[0].fields, { name: "A", drops: [{ amount: 5 }] });
  assert.equal(nested.drops[0].sprite, null);
});

test("sync states distinguish missing assets, changed schema and pending local edits", () => {
  const item = snapshotMerge(newCatalogue("p", snapshot), snapshot, () => "id").catalogue.definitions[0];
  assert.equal(itemSyncState(item, snapshot), "synced");
  assert.equal(itemSyncState(item, null), "offline");
  assert.equal(itemSyncState({ ...item, unity: null }, snapshot), "new");
  assert.equal(itemSyncState({ ...item, schemaHash: otherHash }, snapshot), "schema");
  assert.equal(itemSyncState(item, { ...snapshot, items: [] }), "missing");
  assert.equal(itemSyncState(item, { ...snapshot, items: [{ ...unity, fingerprint: otherHash }] }), "conflict");
  assert.equal(itemSyncState({ ...item, values: { ...item.values, name: "Modified" } }, snapshot), "modified");
});

test("wire routes enforce owner writes, scoped bearer, rechecks and immutable snapshot job storage", async () => {
  const api = await readFile(new URL("../api/unity.php", import.meta.url), "utf8");
  assert.match(api, /pixelboard_require_csrf\(\)/);
  assert.match(api, /pixelboard_require_owner\(\$user\)/);
  assert.match(api, /token_hash=\? FOR UPDATE/);
  assert.match(api, /WHERE workspace_id = \? AND project_id = \? AND id = \? FOR UPDATE/);
  assert.match(api, /role !== 'owner'/);
  assert.match(api, /unity-authorize/);
  assert.match(api, /payload_hash/);
  assert.match(api, /Résultat terminal différent/);
  assert.match(api, /json_encode\(pb_unity_wire_shape\(\$payload\)/, "immutable JSON snapshot copied into job");
  const sql = await readFile(new URL("../api/unity-schema.sql", import.meta.url), "utf8");
  assert.match(sql, /UNIQUE KEY unity_request_unique/);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/);
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(main, /if \(isCatalogue\(record\)\) continue/);
  assert.match(main, /type: "item-ref", projectId, itemId/);
});

test("catalogue rejects delayed responses across logout and immediately hides owner actions for members", async () => {
  const previousDocument = globalThis.document;
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, value: "", textContent: "", children: [], attributes: {},
      addEventListener() {}, focus() {}, setAttribute(key, value) { this.attributes[key] = value; },
      replaceChildren(...children) { this.children = children; },
    });
    return elements.get(id);
  };
  globalThis.document = { querySelector: element };
  let session = { id: "owner", role: "owner" };
  let reply;
  try {
    const ui = initItemsUI({ session: () => session, records: () => [], api: () => new Promise((resolve) => { reply = resolve; }) });
    ui.openItem("project", "item");
    session = null;
    ui.sessionChanged();
    reply({ project: { published_at: "old private timestamp" }, snapshot });
    await new Promise(setImmediate);
    assert.equal(element("#items-panel").hidden, true);
    assert.equal(element("#items-status").textContent, "");
    assert.deepEqual(element("#items-content").children, []);
    session = { id: "member", role: "member" };
    ui.sessionChanged();
    assert.equal(element("#items-import").hidden, true);
    assert.equal(element("#items-import-all").hidden, true);
    assert.equal(element("#items-pair-controls").hidden, true);
  } finally { globalThis.document = previousDocument; }
});
