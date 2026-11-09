import test from "node:test";
import assert from "node:assert/strict";
import { createUnityPullSync } from "../src/items-sync.js";
import { newCatalogue, snapshotMerge } from "../src/items-model.js";
import { initItemsUI } from "../src/items-ui.js";

const hash = "a".repeat(64);
const snapshot = {
  schema_hash: hash, schema: { families: [{ type: "TilesClass", fields: [{ name: "text", kind: "string" }] }] },
  assets: [], items: [{ guid: "b".repeat(32), file_id: "11400000", fingerprint: hash, type: "TilesClass", name: "Pierre", values: { text: "Unity" } }],
};
const state = (status, data = snapshot) => ({ project: { name: "Mon jeu", published_at: "today" }, snapshot: data, jobs: [{ id: "job", kind: "refresh", state: status }] });
const tick = () => new Promise(setImmediate);

test("one-click pull queues refresh, waits for acknowledged success and merges without duplicates or overwriting conflicts", async () => {
  let catalogue = newCatalogue("p", snapshot), reads = 0, requests = 0, merges = 0, conflicts = [];
  const messages = [];
  const sync = createUnityPullSync({
    request: async (id) => { assert.ok(id); requests++; return { job_id: "job" }; },
    read: async () => state(++reads === 1 ? "queued" : reads === 2 ? "claimed" : "succeeded"),
    merge: async (received) => {
      merges++;
      const merged = snapshotMerge(catalogue, received.snapshot, () => "canonical");
      catalogue = merged.catalogue; conflicts = merged.conflicts;
    },
    status: (text) => messages.push(text), wait: async () => { assert.equal(merges, 0); },
  });
  await sync.synchronize();
  assert.equal(requests, 1);
  assert.equal(reads, 3);
  assert.equal(catalogue.definitions.length, 1);
  assert.equal(sync.pending, false);
  assert.ok(messages.some((text) => text.includes("En attente")));
  catalogue.definitions[0].values.text = "Edit on website";
  await sync.synchronize();
  assert.equal(catalogue.definitions.length, 1);
  assert.equal(catalogue.definitions[0].values.text, "Edit on website");
  assert.equal(conflicts.length, 1);
});

test("timeout remains pending; next click checks the same job without creating another", async () => {
  let requests = 0, merges = 0, succeeded = false;
  const messages = [];
  const sync = createUnityPullSync({
    request: async () => { requests++; return { job_id: "job" }; },
    read: async () => state(succeeded ? "succeeded" : "queued"),
    merge: async () => { merges++; }, status: (text) => messages.push(text),
    wait: async () => {}, maxPolls: 2,
  });
  await sync.synchronize();
  assert.equal(merges, 0);
  assert.equal(sync.pending, true);
  assert.match(messages.at(-1), /Toujours en attente/);
  succeeded = true;
  await sync.synchronize();
  assert.equal(requests, 1);
  assert.equal(merges, 1);
});

for (const status of ["failed", "cancelled", "expired", "declined"]) {
  test(`terminal ${status} never merges and allows an explicit new attempt`, async () => {
    let merges = 0;
    const sync = createUnityPullSync({
      request: async () => ({ job_id: "job" }), read: async () => state(status),
      merge: async () => { merges++; }, status() {},
    });
    await assert.rejects(sync.synchronize(), new RegExp(status));
    assert.equal(sync.pending, false);
    assert.equal(merges, 0);
  });
}

test("network failure after uncertain request reuses idempotency key and does not claim success", async () => {
  const ids = [];
  const sync = createUnityPullSync({
    request: async (id) => { ids.push(id); if (ids.length === 1) throw Error("offline"); return { job_id: "job" }; },
    read: async () => state("succeeded"), merge: async () => {}, status() {},
  });
  await assert.rejects(sync.synchronize(), /offline/);
  assert.equal(sync.pending, true);
  await sync.synchronize();
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test("read error, missing snapshot and failed save keep the job retryable without another refresh", async () => {
  let phase = 0, requests = 0, merges = 0;
  const sync = createUnityPullSync({
    request: async () => { requests++; return { job_id: "job" }; },
    read: async () => { if (!phase) throw Error("offline"); return state("succeeded", phase === 1 ? null : snapshot); },
    merge: async () => { merges++; if (phase === 2) throw Error("version conflict"); }, status() {},
  });
  await assert.rejects(sync.synchronize(), /offline/);
  phase++;
  await assert.rejects(sync.synchronize(), /sans instantané/);
  phase++;
  await assert.rejects(sync.synchronize(), /version conflict/);
  phase++;
  await sync.synchronize();
  assert.equal(requests, 1);
  assert.equal(merges, 2);
  assert.equal(sync.pending, false);
});

test("resuming server pending refresh avoids duplicate request; closing stops polling without merging", async () => {
  let finishRead, merges = 0;
  const sync = createUnityPullSync({
    request: async () => { throw Error("must not queue another job"); },
    read: () => new Promise((resolve) => { finishRead = resolve; }),
    merge: async () => { merges++; }, status() {},
  });
  sync.resume({ id: "job", kind: "refresh", state: "claimed" });
  const running = sync.synchronize();
  sync.stop();
  finishRead(state("succeeded"));
  await running;
  assert.equal(merges, 0);
  assert.equal(sync.pending, true);
  sync.reset();
  assert.equal(sync.pending, false);
});

test("auth reset invalidates late request and does not leave a pending job for the next account", async () => {
  let finishRequest;
  const sync = createUnityPullSync({
    request: () => new Promise((resolve) => { finishRequest = resolve; }),
    read: () => { throw Error("private response must not be used"); },
    merge: () => { throw Error("must not merge"); }, status() {},
  });
  const running = sync.synchronize();
  sync.reset();
  finishRequest({ job_id: "job" });
  await running;
  assert.equal(sync.pending, false);
});

function fakeDOM() {
  const previous = { document: globalThis.document, Option: globalThis.Option };
  class Element {
    hidden = true; value = ""; textContent = ""; children = []; listeners = {}; attributes = {};
    addEventListener(name, action) { this.listeners[name] = action; }
    setAttribute(key, value) { this.attributes[key] = value; }
    replaceChildren(...elements) { this.children = elements; }
    append(...elements) { this.children.push(...elements); }
    prepend(...elements) { this.children.unshift(...elements); }
    focus() {}
  }
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  globalThis.document = { querySelector: get, createElement: () => new Element() };
  globalThis.Option = class extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } };
  return { get, restore() { globalThis.document = previous.document; globalThis.Option = previous.Option; } };
}

test("opening Items automatically selects and loads an existing catalogue, with setup collapsed", async () => {
  const dom = fakeDOM();
  const calls = [];
  try {
    initItemsUI({
      session: () => ({ id: "owner", role: "owner" }),
      records: () => [newCatalogue("existing-project", snapshot)],
      api: async (action, options) => { calls.push([action, options]); return { ...state("queued", null), jobs: [] }; },
    });
    dom.get("#items-open").listeners.click();
    await tick();
    assert.equal(dom.get("#items-project").value, "existing-project");
    assert.equal(calls[0][0], "unity-state");
    assert.match(calls[0][1].query, /existing-project/);
    assert.equal(dom.get("#items-setup").open, false);
    assert.equal(dom.get("#items-project-label").textContent, "Mon jeu");
    assert.equal(calls.length, 1, "opening is read-only and does not request writes or refresh without user action");
  } finally { dom.restore(); }
});

test("one click in Items uses refresh only and automatically creates the catalogue on success", async () => {
  const dom = fakeDOM();
  const calls = [], records = [];
  const received = { ...snapshot, items: [], schema: { families: [] } };
  try {
    initItemsUI({
      session: () => ({ id: "member", role: "member" }), records: () => records,
      api: async (action, options) => {
        calls.push([action, options]);
        if (action === "unity-request") return { job_id: "job" };
        return state("succeeded", received);
      },
      save: async (record) => { records.push(record); },
    });
    dom.get("#items-project").value = "first-project";
    dom.get("#items-load").listeners.click();
    await tick();
    dom.get("#items-refresh").listeners.click();
    await tick();
    assert.equal(records.length, 1);
    assert.equal(records[0].id, "__items__:first-project");
    assert.equal(calls.filter(([action]) => action === "unity-request").length, 1);
    assert.equal(calls.find(([action]) => action === "unity-request")[1].body.kind, "refresh");
    assert.match(dom.get("#items-status").textContent, /Synchronisation terminée/);
    assert.equal(dom.get("#items-refresh").disabled, false);
    assert.equal(dom.get("#items-import").hidden, true);
  } finally { dom.restore(); }
});
