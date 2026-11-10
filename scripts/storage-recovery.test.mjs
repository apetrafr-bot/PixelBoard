import test from "node:test";
import assert from "node:assert/strict";
import { createLocalStore } from "../src/local-store.js";
import { memoryExport } from "../src/emergency-export.js";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

function fakeIDB() {
  const rows = new Map(), connections = [];
  let failure = null, opens = 0, active = 0, maximum = 0;
  const idb = { open() {
    opens++;
    const request = {};
    queueMicrotask(() => {
      const db = { closed: false, close() { this.closed = true; },
        transaction() {
          if (db.closed) throw new DOMException("The database connection is closing", "InvalidStateError");
          if (failure) { const error = failure; failure = null; throw error; }
          active++; maximum = Math.max(maximum, active);
          const writes = [], transaction = { abort() { queueMicrotask(() => this.onabort()); }, objectStore() { return {
            put: (record) => writes.push(record),
            delete: (id) => writes.push({ delete: id }),
            getAll: () => ({ get result() { return [...rows.values()]; } }),
          }; } };
          setTimeout(() => {
            writes.forEach((value) => value.delete ? rows.delete(value.delete) : rows.set(value.id, value));
            active--; transaction.oncomplete();
          }, 1);
          return transaction;
        },
      };
      connections.push(db); request.result = db; request.onsuccess();
    });
    return request;
  } };
  return { idb, rows, connections, fail: (error) => { failure = error; }, get opens() { return opens; }, get maximum() { return maximum; } };
}

test("closed IDB connection reopens once and writes latest records without duplicates", async () => {
  const fake = fakeIDB(), store = createLocalStore(fake.idb, "db", "boards");
  await store.write([{ id: "board", title: "before" }]);
  fake.connections[0].close();
  await store.write([{ id: "board", title: "current" }]);
  assert.equal(fake.opens, 2);
  assert.equal(fake.rows.size, 1);
  assert.equal((await store.read())[0].title, "current");
});

test("versionchange/close invalidate connections; concurrent writes retain invocation order", async () => {
  const fake = fakeIDB(), store = createLocalStore(fake.idb, "db", "boards");
  await store.open(); fake.connections[0].onversionchange();
  assert.equal(fake.connections[0].closed, true);
  await Promise.all([store.write([{ id: "board", n: 1 }]), store.write([{ id: "board", n: 2 }]), store.write([{ id: "other" }])]);
  assert.equal(fake.maximum, 1);
  assert.equal(fake.rows.get("board").n, 2);
  fake.connections[1].onclose();
  await store.read(); assert.equal(fake.opens, 3);
});

test("quota failures remain explicit and do not poison queue or trigger replay", async () => {
  const fake = fakeIDB(), store = createLocalStore(fake.idb, "db", "boards");
  fake.fail(new DOMException("Full", "QuotaExceededError"));
  await assert.rejects(store.write([{ id: "board" }]), { name: "QuotaExceededError" });
  assert.equal(fake.opens, 1); assert.equal(fake.rows.size, 0);
  await store.write([{ id: "board", title: "retry" }]);
  assert.equal(fake.rows.size, 1);
});

test("aborted transaction retries once, persistent abort rejects rather than looping", async () => {
  const fake = fakeIDB(), store = createLocalStore(fake.idb, "db", "boards");
  fake.fail(new DOMException("Aborted", "AbortError"));
  await store.write([{ id: "board", n: 1 }]);
  assert.equal(fake.opens, 2);
  assert.equal(fake.rows.size, 1);
  const broken = { open() {
    const request = {};
    queueMicrotask(() => {
      request.result = { close() {}, transaction() { throw new DOMException("closing", "InvalidStateError"); } };
      request.onsuccess();
    });
    return request;
  } };
  await assert.rejects(createLocalStore(broken, "db", "boards").write([{ id: "board" }]), { name: "InvalidStateError" });
});

test("emergency export captures current memory before async work, including exact image/cover/audio bytes", async () => {
  const records = [{ id: "board", title: "unsaved", items: [{
    id: "media", image: new Blob(["image"], { type: "image/png" }),
    coverImage: new Blob(["cover"], { type: "image/webp" }), audio: new Blob(["audio"], { type: "audio/wav" }),
  }] }];
  const dataUrl = async (blob) => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`;
  const exporting = memoryExport(records, [{ id: "member" }], "__workspace__", dataUrl);
  records[0].title = "later edit";
  const data = JSON.parse(await exporting);
  assert.equal(data.records[0].title, "unsaved");
  for (const [key, expected] of [["image", "image"], ["coverImage", "cover"], ["audio", "audio"]]) {
    assert.equal(Buffer.from(data.records[0].items[0][key].split(",")[1], "base64").toString(), expected);
  }
  assert.equal(data.records[1].members[0].id, "member");
  await assert.rejects(memoryExport(records, [], "workspace", async () => { throw Error("unreadable media"); }), /unreadable/);
});

test("export bypasses save/IDB/network and exposes persistent download plus copy fallback", async () => {
  const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function exportWorkspace("), source.indexOf("\nfunction allStoredBoards("));
  assert.doesNotMatch(body, /saveImmediately|readAllRecords|apiRequest|writeRecords/);
  const nodes = new Map(), calls = [];
  const $ = (key) => { if (!nodes.has(key)) nodes.set(key, {
    click() { calls.push("click"); }, showModal() { this.open = true; },
  }); return nodes.get(key); };
  const context = vm.createContext({
    $, exportBusy: false, exportUrl: null, remoteSession: { id: 1 }, Blob, console, WORKSPACE_ID: "workspace", members: [],
    allStoredBoards: () => [{ id: "board", items: [] }], imageDataUrl() {},
    memoryExport: async () => '{"current":true}',
    URL: { createObjectURL: () => "blob:export", revokeObjectURL() { throw Error("revoked before user download"); } },
    showToast() {},
  });
  vm.runInContext(body, context);
  await context.exportWorkspace();
  assert.equal($("#export-json").value, '{"current":true}');
  assert.equal($("#export-download").href, "blob:export");
  assert.equal($("#export-copy").disabled, false);
  assert.equal($("#emergency-export").hidden, false);
  assert.equal($("#emergency-export").open, true);
  assert.match($("#export-status").textContent, /si rien ne se passe, copiez/);
  assert.deepEqual(calls, ["click"]);
});

test("clipboard denial leaves JSON selected for manual copy when download is suppressed", async () => {
  const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const start = source.indexOf("async function copyEmergencyExport(");
  const code = source.slice(start, source.indexOf("\nfunction ", start + 1));
  let selected = false, focused = false, offered;
  const text = { value: '{"unsaved":true}', focus() { focused = true; }, select() { selected = true; } };
  const status = {};
  const context = vm.createContext({
    $: (key) => key === "#export-json" ? text : status,
    navigator: { clipboard: { async writeText(value) { offered = value; throw Error("Permission denied"); } } },
  });
  vm.runInContext(code, context);
  await context.copyEmergencyExport();
  assert.equal(offered, text.value);
  assert.equal(selected && focused, true);
  assert.match(status.textContent, /Ctrl\+C/);
});

test("local-cache failure blocks remote mutation and version advance; recovered cache permits exactly one server write", async () => {
  const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const start = source.indexOf("async function persistRecords(");
  const body = source.slice(start, source.indexOf("\nfunction remoteCacheRecord(", start));
  let broken = true, uploads = 0;
  const context = vm.createContext({
    remoteSession: { id: "1" }, persistenceQueue: Promise.resolve(), structuredClone,
    remoteWritesInFlight: 0, WORKSPACE_ID: "workspace",
    pendingRemoteBoardIds: new Set(), remoteCacheRecord: (record) => record,
    writeRecords: async () => { if (broken) throw Error("closing"); },
    saveRemoteBoard: async () => { uploads++; }, renderAuthControls() {},
  });
  vm.runInContext(body, context);
  await assert.rejects(context.persistRecords([{ id: "board" }]), /closing/);
  assert.equal(uploads, 0); assert.equal(context.remoteWritesInFlight, 0);
  broken = false;
  await context.persistRecords([{ id: "board" }]);
  assert.equal(uploads, 1);
  let active = 0, maximum = 0;
  context.saveRemoteBoard = async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active--; uploads++;
  };
  await Promise.all([context.persistRecords([{ id: "board" }]), context.persistRecords([{ id: "board" }])]);
  assert.equal(maximum, 1, "cache+server+ack batches serialize, preserving optimistic version order");
  const queued = context.persistRecords([{ id: "board" }]);
  context.remoteSession = { id: "2" };
  await assert.rejects(queued, /Compte modifié/);
  const previousUploads = uploads;
  context.writeRecords = async () => { context.remoteSession = { id: "3" }; };
  await assert.rejects(context.persistRecords([{ id: "board" }]), /aucun envoi serveur/);
  assert.equal(uploads, previousUploads);
});
