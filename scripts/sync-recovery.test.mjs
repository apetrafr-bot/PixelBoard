import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { pendingBoardAction, sameRemoteBoard, withLocalView } from "../src/sync-model.js";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from) + 1));
const syncCode = slice("function workspaceBusy()", "\nfunction scheduleRemoteMemberSave");
const persistenceCode = slice("async function persistRecords(", "\nfunction localWorkspaceRecords(");
const schedulingCode = slice("function scheduleSave(", "\nfunction imageDataUrl(");
const apiCode = slice("async function apiRequest(", "\nasync function serializeBoard(");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function workspace(extra = {}) {
  const context = vm.createContext({
    remoteSession: { id: "1", workspaceId: "7" }, suspendedSession: null,
    document: { activeElement: null }, canvas: { contains: () => false, querySelectorAll: () => [] },
    teamPanel: { contains: () => false }, viewport: { scrollLeft: 10, scrollTop: 20 },
    board: { id: "root", title: "local", items: [] }, boardRecords: new Map(),
    remoteVersions: new Map([["root", 1]]), remoteBaseVersions: new Map([["root", 1]]),
    localRevisions: new Map(), pendingRemoteBoardIds: new Set(), conflictedRemoteBoardIds: new Set(),
    remoteSyncInFlight: false, remoteWritesInFlight: 0, backupBusy: false, saveTimer: null,
    panGesture: null, drawingGesture: null, connectionGesture: null, connectorResizeGesture: null,
    activeBoardPointers: new Set(), marqueeGesture: null,
    syncEpoch: 0, lastAuthCheck: Date.now(), members: [], structuredClone, console,
    deserializeBoard: async (record) => structuredClone(record),
    serializeBoard: async (record) => structuredClone(record),
    normalizeBoard: (record) => record, isCatalogue: () => false, remoteMemberRecord: (record) => record,
    renderTeam() {}, renderAuthControls() {}, renderBoard() {}, renderBoardPicker() {}, setSaveStatus() {},
    pendingBoardAction, writeRecords: async () => {},
    ...extra,
  });
  vm.runInContext(syncCode, context);
  return context;
}

test("pending reconciliation only retries the known base or acknowledges identical committed payload", () => {
  const draft = { id: "root", items: [{ id: "a", checked: false }], title: "draft" };
  assert.equal(pendingBoardAction({ version: 3, data: draft }, 2, draft), "acknowledge");
  assert.equal(pendingBoardAction({ version: 2, data: { ...draft, title: "old" } }, 2, draft), "retry");
  assert.equal(pendingBoardAction({ version: 3, data: { ...draft, title: "someone else" } }, 2, draft), "conflict");
  assert.equal(pendingBoardAction({ version: 3, data: { ...draft, title: "unknown base" } }, null, draft), "conflict");
  assert.equal(pendingBoardAction(undefined, 0, draft), "retry");
  assert.equal(pendingBoardAction(undefined, 2, draft), "conflict");
  assert.equal(sameRemoteBoard(draft, { title: "draft", items: [{ checked: false, id: "a" }], id: "root", remoteUpdatedAt: "now" }), true);
  assert.equal(sameRemoteBoard({ ...draft, zoom: 2, viewX: 500 }, { ...draft, zoom: 1, viewX: 20 }), true);
});

for (const interruption of ["local-edit", "account-switch", "focus-editor"]) {
  test(`server read cannot replace memory after ${interruption} while awaiting response`, async () => {
    const gate = deferred();
    const context = workspace({
      apiRequest: async (action) => action === "boards" ? gate.promise : { members: [] },
    });
    const reading = context.syncRemoteChanges();
    if (interruption === "local-edit") { context.syncEpoch++; context.board.title = "typed during network"; }
    if (interruption === "account-switch") context.remoteSession = { id: "2" };
    if (interruption === "focus-editor") {
      context.document.activeElement = { isContentEditable: true };
      context.canvas.contains = () => true;
    }
    gate.resolve({ boards: [{ id: "root", version: 2, data: { id: "root", title: "server", items: [] } }] });
    await reading;
    assert.notEqual(context.board.title, "server");
    assert.equal(context.remoteVersions.get("root"), 1);
    assert.equal(context.remoteSyncInFlight, false);
  });
}

test("late media decoding is guarded again before applying the server batch", async () => {
  const gate = deferred(), started = deferred();
  const context = workspace({
    apiRequest: async (action) => action === "boards"
      ? { boards: [{ id: "root", version: 2, data: { id: "root", title: "server", items: [] } }] }
      : { members: [] },
    deserializeBoard: async (record) => { started.resolve(); await gate.promise; return record; },
  });
  const reading = context.syncRemoteChanges();
  await started.promise;
  context.syncEpoch++; context.board.title = "new local";
  gate.resolve(); await reading;
  assert.equal(context.board.title, "new local");
  assert.equal(context.remoteVersions.get("root"), 1);
});

for (const situation of ["offline-before-put", "response-lost", "other-writer", "legacy-cache"]) {
  test(`pending ${situation} preserves both copies and only uploads when proven safe`, async () => {
    let uploads = 0;
    const cached = [];
    const context = workspace({
      localRevisions: new Map([["root", 1]]), pendingRemoteBoardIds: new Set(["root"]),
      remoteCacheRecord: (record, pending) => ({ ...record, pendingRemoteSync: pending }),
      writeRecords: async (records) => cached.push(...structuredClone(records)),
    });
    const server = { id: "root", version: 1, data: { id: "root", title: "original", items: [] } };
    if (situation === "response-lost") { server.version = 2; server.data = structuredClone(context.board); }
    if (situation === "other-writer") { server.version = 2; server.data.title = "other person"; }
    if (situation === "legacy-cache") context.remoteBaseVersions.set("root", null);
    context.remoteVersions.set("root", server.version);
    context.apiRequest = async (action) => action === "boards" ? { boards: [structuredClone(server)] } : { members: [] };
    context.saveRemoteBoard = async (record) => {
      uploads++; server.data = structuredClone(record); server.version++;
      context.remoteVersions.set("root", server.version);
    };
    await context.syncRemoteChanges();
    assert.equal(context.board.title, "local");
    if (situation === "other-writer" || situation === "legacy-cache") {
      assert.equal(uploads, 0);
      assert.equal(context.conflictedRemoteBoardIds.has("root"), true);
      assert.equal(context.pendingRemoteBoardIds.has("root"), true);
    } else {
      assert.equal(uploads, situation === "offline-before-put" ? 1 : 0);
      assert.equal(context.pendingRemoteBoardIds.size, 0);
      assert.equal(context.localRevisions.size, 0);
      assert.equal(cached.at(-1).pendingRemoteSync, false);
      assert.equal(context.remoteVersions.get("root"), 2, "stale GET version must not roll back an acknowledgement");
    }
  });
}

test("all draft records are cached before first PUT; queued writes cannot clear a newer revision", async () => {
  const caches = [], gate = deferred(), uploaded = deferred();
  const context = workspace({
    WORKSPACE_ID: "workspace", REMOTE_CACHE_PREFIX: "cache:", persistenceQueue: Promise.resolve(),
    writeRecords: async (records) => caches.push(structuredClone(records)),
    saveRemoteBoard: async (record) => {
      uploaded.resolve(); await gate.promise;
      context.remoteVersions.set(record.id, (context.remoteVersions.get(record.id) || 0) + 1);
    },
  });
  vm.runInContext(persistenceCode, context);
  const first = context.persistRecords([{ id: "root", title: "older" }, { id: "child", title: "child" }]);
  await uploaded.promise;
  assert.equal(caches[0].length, 2);
  assert.ok(caches[0].every((record) => record.pendingRemoteSync));
  const second = context.persistRecords([{ id: "root", title: "newer" }]);
  context.board = { id: "root", title: "newer", items: [] };
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(context.board.title, "newer");
  assert.equal(context.boardRecords.get("root").title, "newer");
  assert.equal(caches.at(-1)[0].title, "newer");
  assert.equal(context.localRevisions.size, 0);
});

test("scroll or later edits cannot drop additional boards from an earlier debounce batch", async () => {
  let callback, saved;
  const context = workspace({
    scheduledRecords: new Map(), WORKSPACE_ID: "workspace",
    clearTimeout() {}, setTimeout(fn) { callback = fn; return 1; },
    $: () => ({ dataset: {} }),
    persistRecords: async (records) => { saved = structuredClone(records); context.localRevisions.clear(); },
    showToast() {},
  });
  vm.runInContext(schedulingCode, context);
  context.scheduleSave([{ id: "child", title: "new nested board", items: [] }]);
  context.board.title = "later edit after scroll";
  context.scheduleSave();
  await callback();
  assert.equal(saved.find((record) => record.id === "child").title, "new nested board");
  assert.equal(saved.find((record) => record.id === "root").title, "later edit after scroll");
});

test("view-only scrolling never writes a stale full board to server or cancels an edit batch", async () => {
  let callback, cache;
  const context = workspace({
    scheduledRecords: new Map([["child", { id: "child", title: "pending" }]]),
    viewSaveTimer: null, clearTimeout() {}, setTimeout(fn) { callback = fn; return 1; },
    remoteCacheRecord: (record, pending) => ({ ...record, pendingRemoteSync: pending }),
    writeRecords: async (records) => { cache = records[0]; },
    scheduleSave() { throw Error("must not schedule a server mutation"); },
  });
  vm.runInContext(slice("function saveAfterQuietScroll()", "\nfunction focusWorldPoint("), context);
  context.saveAfterQuietScroll(); await callback();
  assert.equal(cache.pendingRemoteSync, false);
  assert.equal(context.scheduledRecords.has("child"), true);
  context.localRevisions.set("root", 1);
  context.saveAfterQuietScroll(); await callback();
  assert.equal(cache.pendingRemoteSync, true, "view cache must never clear dirty state");
  assert.deepEqual(withLocalView({ id: "root", title: "server" }, { zoom: 2, viewX: 600, title: "not content", viewY: NaN }), {
    id: "root", title: "server", zoom: 2, viewX: 600,
  });
});
function apiWorkspace(handler) {
  const nodes = new Map(), caches = [];
  const context = workspace({
    csrfToken: "old", API_URL: "/api", authRefresh: null, lastAuthCheck: 0,
    apiReady: true, apiState: "ready", apiMessage: "", remoteSyncTimer: null, suspendedSession: null,
    apiResponse: handler, clearInterval() {}, clearTimeout() {},
    allStoredBoards: () => [context.board],
    remoteCacheRecord: (record, pending, account) => ({ ...record, id: `cache:${account.id}:${record.id}`, pending }),
    writeRecords: async (records) => caches.push(...records),
    $: (key) => { if (!nodes.has(key)) nodes.set(key, {}); return nodes.get(key); },
  });
  vm.runInContext(apiCode, context);
  return { context, caches };
}

test("CSRF refresh is coalesced, same-account checked, retried once and never bypasses permissions", async () => {
  let authCalls = 0, mutations = 0;
  const { context } = apiWorkspace(async (url, options) => {
    if (url.includes("action=auth")) {
      authCalls++; await new Promise((done) => setTimeout(done, 2));
      return { response: { ok: true }, payload: { csrf: "fresh", user: { id: 1, workspace_id: 7 } } };
    }
    mutations++;
    return options.headers["X-CSRF-Token"] === "fresh"
      ? { response: { ok: true }, payload: { version: 2 } }
      : { response: { ok: false, status: 403 }, payload: { code: "csrf_expired", error: "CSRF" } };
  });
  await Promise.all([context.apiRequest("board", { method: "PUT", body: {} }), context.apiRequest("board", { method: "PUT", body: {} })]);
  assert.equal(authCalls, 1); assert.equal(mutations, 4);
  context.apiResponse = async () => ({ response: { ok: false, status: 403 }, payload: { error: "owner only" } });
  await assert.rejects(context.apiRequest("member", { method: "PATCH" }), /owner only/);
  assert.equal(authCalls, 1);
  let repeated = 0;
  context.apiResponse = async (url) => {
    if (url.includes("action=auth")) return { response: { ok: true }, payload: { csrf: "still rejected", user: { id: 1, workspace_id: 7 } } };
    repeated++;
    return { response: { ok: false, status: 403 }, payload: { error: "repeated CSRF", code: "csrf_expired" } };
  };
  await assert.rejects(context.apiRequest("board", { method: "PUT" }), /repeated CSRF/);
  assert.equal(repeated, 2, "one retry only, never a request loop");
});

for (const mode of ["expired", "different-account"]) {
  test(`${mode} locks access but retains and caches memory drafts for export`, async () => {
    let mutations = 0;
    const { context, caches } = apiWorkspace(async (url) => {
      if (url.includes("action=auth")) return {
        response: { ok: true }, payload: { csrf: "new", user: mode === "expired" ? null : { id: 2, workspace_id: 7 } },
      };
      mutations++;
      return { response: { ok: false, status: 401 }, payload: { error: "expired" } };
    });
    context.localRevisions.set("root", 1);
    if (mode === "expired") await assert.rejects(context.apiRequest("boards"), /expired/);
    else await assert.rejects(context.refreshRemoteSession(), /session a changé/);
    assert.equal(context.remoteSession, null);
    assert.equal(context.suspendedSession.id, "1");
    assert.equal(context.board.title, "local");
    assert.equal(context.localRevisions.size, 1);
    assert.equal(caches[0].id, "cache:1:root");
    assert.equal(mutations, mode === "expired" ? 1 : 0);
    vm.runInContext(schedulingCode, context);
    await context.saveImmediately();
    assert.ok(caches.every((record) => record.id === "cache:1:root"), "suspended account never writes drafts into unscoped local boards");
  });
}

test("stale account response cannot update CSRF or lock the new session", async () => {
  const gate = deferred();
  const { context } = apiWorkspace(async () => gate.promise);
  const request = context.apiRequest("boards");
  context.remoteSession = { id: "2", workspaceId: "7" };
  gate.resolve({ response: { ok: false, status: 401 }, payload: { csrf: "wrong-old-token", error: "old session" } });
  await assert.rejects(request, /Compte modifié/);
  assert.equal(context.csrfToken, "old");
  assert.equal(context.remoteSession.id, "2");
});

test("cache acknowledgement failure never clears pending memory even when server already committed", async () => {
  const context = workspace({
    localRevisions: new Map([["root", 1]]), pendingRemoteBoardIds: new Set(["root"]),
    remoteCacheRecord: (record) => record,
    writeRecords: async () => { throw new DOMException("Full", "QuotaExceededError"); },
  });
  context.apiRequest = async (action) => action === "boards"
    ? { boards: [{ id: "root", version: 2, data: structuredClone(context.board) }] }
    : { members: [] };
  const oldError = context.console;
  context.console = { error() {} };
  await context.syncRemoteChanges();
  context.console = oldError;
  assert.equal(context.pendingRemoteBoardIds.has("root"), true);
  assert.equal(context.localRevisions.has("root"), true);
  assert.equal(context.board.title, "local");
});

test("explicit conflict replacement only touches reviewed conflicts, not interrupted unrelated drafts", async () => {
  const uploaded = [];
  const context = workspace({
    pendingRemoteBoardIds: new Set(["root", "other"]),
    conflictedRemoteBoardIds: new Set(["root"]),
    localRevisions: new Map([["root", 1], ["other", 1]]),
    apiRequest: async () => ({ boards: [{ id: "root", version: 5 }] }),
    remoteCacheRecord: (record) => record, showToast() {},
    saveRemoteBoard: async (record) => {
      uploaded.push(record.id);
      assert.equal(context.remoteVersions.get(record.id), 5);
      context.remoteVersions.set(record.id, 6);
    },
  });
  vm.runInContext(slice("async function resolvePendingCopies(", "\nfunction confirmConflictResolution("), context);
  await context.resolvePendingCopies("publish");
  assert.deepEqual(uploaded, ["root"]);
  assert.equal(context.pendingRemoteBoardIds.has("other"), true);
  assert.equal(context.localRevisions.has("other"), true);
  assert.equal(context.remoteWritesInFlight, 0);
});

test("typing during explicit server reload retains the newer memory and pending cache", async () => {
  const gate = deferred(), writing = deferred(), caches = [];
  const context = workspace({
    pendingRemoteBoardIds: new Set(["root"]), conflictedRemoteBoardIds: new Set(["root"]),
    localRevisions: new Map([["root", 1]]),
    apiRequest: async () => ({ boards: [{ id: "root", version: 5, data: { id: "root", title: "chosen server", items: [] } }] }),
    remoteCacheRecord: (record, pending) => ({ ...record, pendingRemoteSync: pending }), showToast() {},
    writeRecords: async (records) => {
      caches.push(structuredClone(records));
      if (caches.length === 1) { writing.resolve(); await gate.promise; }
    },
  });
  context.console = { error() {} };
  vm.runInContext(slice("async function resolvePendingCopies(", "\nfunction confirmConflictResolution("), context);
  const resolving = context.resolvePendingCopies("reload");
  await writing.promise;
  context.syncEpoch++;
  context.board.title = "typed while reload pending";
  context.boardRecords.set("root", structuredClone(context.board));
  gate.resolve(); await resolving;
  assert.equal(context.board.title, "typed while reload pending");
  assert.equal(caches.at(-1)[0].title, context.board.title);
  assert.equal(caches.at(-1)[0].pendingRemoteSync, true);
  assert.equal(context.pendingRemoteBoardIds.has("root"), true);
});
