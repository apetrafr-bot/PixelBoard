import test from "node:test";
import assert from "node:assert/strict";
import { apiResponse } from "../src/api-response.js";
import { createLocalStore } from "../src/local-store.js";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("API settles stalled headers and stalled JSON body without accepting a late response", async () => {
  const original = globalThis.fetch;
  try {
    let signal;
    globalThis.fetch = async (_, options) => { signal = options.signal; return new Promise(() => {}); };
    await assert.rejects(apiResponse("/auth", {}, 10), /délai prévu/);
    assert.equal(signal.aborted, true);
    globalThis.fetch = async () => ({ headers: new Headers({ "content-type": "application/json" }), json: () => new Promise(() => {}) });
    await assert.rejects(apiResponse("/auth", {}, 10), /délai prévu/);
    globalThis.fetch = async () => new Response("null", { headers: { "content-type": "application/json" } });
    await assert.rejects(apiResponse("/auth", {}, 10), /invalide/);
    globalThis.fetch = async () => new Response("PHP absent");
    await assert.rejects(apiResponse("/auth", {}, 10), { apiMissing: true });
    globalThis.fetch = async () => new Response('{"user":null}', { headers: { "content-type": "application/json" } });
    assert.equal((await apiResponse("/auth", {}, 10)).payload.user, null);
  } finally { globalThis.fetch = original; }
});

test("startup storage unavailable, blocked open and hung transaction settle explicitly without clearing data", async () => {
  await assert.rejects(createLocalStore(undefined, "db", "boards").read(), /indisponible/);
  const blocked = createLocalStore({ open: () => ({}) }, "db", "boards", 10);
  await assert.rejects(blocked.read(), /bloqué/);
  let aborted = 0, closed = 0;
  const hanging = createLocalStore({ open() {
    const request = {};
    queueMicrotask(() => {
      request.result = { close() { closed++; }, transaction() {
        return { objectStore: () => ({ getAll() {} }), abort() { aborted++; this.onabort(); } };
      } };
      request.onsuccess();
    });
    return request;
  } }, "db", "boards", 10);
  await assert.rejects(hanging.read(), { name: "TimeoutError" });
  assert.equal(aborted, 1); assert.equal(closed, 1);
});

test("retry settles auth failure, remains locked and permits a second successful attempt without reload", async () => {
  const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function retrySession("), source.indexOf("\nasync function start("));
  const button = {};
  let attempts = 0, rendered = 0, gates = 0;
  const context = vm.createContext({
    $: () => button, readAllRecords: async () => [],
    apiRequest: async () => { if (++attempts === 1) throw Error("offline"); return { user: null }; },
    remoteSession: null, apiState: "error", apiMessage: "", apiReady: false, setupAvailable: false,
    remoteSyncTimer: null, clearInterval() {}, console: { error() {} },
    loadRemoteWorkspace() { throw Error("must not authenticate"); },
    renderBoard() { rendered++; }, renderAuthControls() { gates++; },
  });
  vm.runInContext(body, context);
  await context.retrySession();
  assert.equal(context.apiState, "error"); assert.equal(context.remoteSession, null);
  assert.equal(button.disabled, false); assert.equal(gates, 1);
  await context.retrySession();
  assert.equal(context.apiState, "ready"); assert.equal(context.remoteSession, null);
  assert.equal(rendered, 1); assert.equal(gates, 2);
  assert.doesNotMatch(body, /location.reload|deleteDatabase/);
});
