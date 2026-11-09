import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const start = source.indexOf("async function syncRemoteChanges()");
const end = source.indexOf("\nfunction ", start);
const sync = source.slice(start, end);

test("connector tips stop at card borders instead of inside content", () => {
  const code = source.slice(source.indexOf("function connectorBorderPoint("), source.indexOf("\nfunction cardAnchor("));
  const context = vm.createContext({});
  vm.runInContext(code, context);
  const rect = { x: 100, y: 200, width: 200, height: 100 };
  for (const [toward, expected] of [
    [{ x: 200, y: 0 }, { x: 200, y: 200 }],
    [{ x: 200, y: 700 }, { x: 200, y: 300 }],
    [{ x: 0, y: 250 }, { x: 100, y: 250 }],
    [{ x: 900, y: 250 }, { x: 300, y: 250 }],
  ]) {
    const result = context.connectorBorderPoint(rect, { x: 200, y: 250 }, toward);
    assert.equal(result.x, expected.x);
    assert.equal(result.y, expected.y);
  }
});

test("connector curves bend on either side while preserving endpoints", () => {
  const code = source.slice(source.indexOf("function connectorPath("), source.indexOf("\nfunction anchorAtWorldPoint("));
  const context = vm.createContext({});
  vm.runInContext(code, context);
  const endpoints = { start: { x: 0, y: 0 }, end: { x: 100, y: 0 } };
  assert.equal(context.connectorPath(endpoints, 0), "M 0 0 Q 50 0 100 0");
  assert.equal(context.connectorPath(endpoints, 80), "M 0 0 Q 50 80 100 0");
  assert.equal(context.connectorPath(endpoints, -80), "M 0 0 Q 50 -80 100 0");
});

test("recenter uses card bounds in both dimensions", () => {
  const fit = source.slice(source.indexOf("function fitBoardContent()"), source.indexOf("\nfunction updateZoom()"));
  let center;
  const context = vm.createContext({
    canvas: { querySelectorAll: () => [
      { offsetLeft: 100, offsetTop: 200, offsetWidth: 200, offsetHeight: 100 },
      { offsetLeft: 900, offsetTop: 1000, offsetWidth: 300, offsetHeight: 200 },
    ] },
    board: { zoom: 1 }, viewport: { clientWidth: 800, clientHeight: 600 },
    MIN_ZOOM: .3, updateZoom() {}, updateViewSave() {},
    focusWorldPoint(x, y) { center = [x, y]; },
  });
  vm.runInContext(`${fit}\nfitBoardContent();`, context);
  assert.deepEqual(center, [650, 700]);
  assert.equal(context.board.zoom, .52);
});

for (const editing of [false, true]) {
  test(`remote boards synchronize with focused canvas when editing=${editing}`, async () => {
    let requests = 0;
    let pickerUpdated = false;
    const active = { isContentEditable: editing, matches: () => false };
    const context = vm.createContext({
      document: { activeElement: active }, canvas: { contains: () => true },
      teamPanel: { contains: () => false }, remoteSession: { id: 1 },
      backupBusy: false, remoteSyncInFlight: false, remoteWritesInFlight: 0, saveTimer: null,
      panGesture: null, drawingGesture: null, connectionGesture: null, connectorResizeGesture: null,
      pendingRemoteBoardIds: new Set(), remoteVersions: new Map(), boardRecords: new Map(),
      board: { id: "root" }, members: [], structuredClone, console,
      async apiRequest(action) {
        requests++;
        return action === "boards"
          ? { boards: [{ id: "new-board", version: 1, data: { id: "new-board" } }] }
          : { members: [] };
      },
      async deserializeBoard(record) { return record; },
      remoteMemberRecord: (record) => record,
      renderTeam() {}, renderBoardPicker() { pickerUpdated = true; },
      setSaveStatus() {},
    });
    vm.runInContext(sync, context);
    await context.syncRemoteChanges();
    assert.equal(requests, editing ? 0 : 2);
    assert.equal(context.boardRecords.has("new-board"), !editing);
    assert.equal(pickerUpdated, !editing);
    assert.equal(context.remoteSyncInFlight, false);
  });
}
