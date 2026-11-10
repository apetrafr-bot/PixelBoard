import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");

function fixture() {
  let sequence = 0;
  const image = new Blob(["image"], { type: "image/png" });
  const audio = new Blob(["audio"], { type: "audio/wav" });
  const board = { id: "root", items: [
    { id: "a", type: "image", x: -300, y: 120, image, imageZoom: 3, imagePanX: .8 },
    { id: "b", type: "audio", x: 100, y: 240, audio },
    { id: "c", type: "item-ref", x: 500, y: 200, projectId: "unity-project", itemId: "canonical" },
    { id: "d", type: "board", x: 900, y: 200, boardId: "child" },
    { id: "link", type: "connector", fromId: "a", toId: "b", fromAnchor: { x: 1, y: .2 }, curve: 60 },
    { id: "external", type: "connector", fromId: "a", toId: "unselected" },
    { id: "unselected", type: "note", x: 1300, y: 20, body: "intact" },
  ] };
  const child = { id: "child", parentId: "root", title: "Nested", items: [
    { id: "ca", type: "todo", entries: [{ id: "entry", text: "Task", done: true }] },
    { id: "cb", type: "board", boardId: "grandchild" },
    { id: "cl", type: "connector", fromId: "ca", toId: "cb" },
  ] };
  const grandchild = { id: "grandchild", parentId: "child", title: "Deep", items: [
    { id: "deep", type: "item-ref", projectId: "unity-project", itemId: "canonical" },
  ] };
  const catalogue = { id: "catalogue", type: "item-catalogue", items: [], definitions: [{ id: "canonical", values: { enabled: false } }] };
  const nodes = new Map(), saved = [], snapshots = [];
  const context = vm.createContext({
    board, boardRecords: new Map([["child", child], ["grandchild", grandchild], ["catalogue", catalogue]]),
    selectedCardIds: new Set(["a", "b", "c", "d"]), selectedVectorId: null,
    cardClipboard: null, pasteCount: 0, lastZIndex: 10, Blob, structuredClone,
    newId: () => `new-${++sequence}`, normalizeBoard: (value) => value,
    snapshotState() { snapshots.push(structuredClone({ board, records: [...context.boardRecords] })); },
    selectionBounds: () => ({ x: -300, y: 120, width: 1400, height: 300 }),
    viewportCenter: () => ({ x: 600, y: 400 }),
    renderBoard() {}, scheduleSave: (records) => saved.push(records), showToast() {},
    canvas: { querySelectorAll: () => [] },
    $: (selector) => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); },
  });
  vm.runInContext(source.slice(source.indexOf("function selectedCards("), source.indexOf("\nlet cardMenuContext")), context);
  // Geometry is tested separately; use a fixed viewport here to assert rigid translation.
  context.selectionBounds = () => ({ x: -300, y: 120, width: 1400, height: 300 });
  return { context, board, child, grandchild, catalogue, saved, snapshots, nodes };
}

test("one duplication copies the entire selection, remaps internal connectors, preserves media and canonical item refs", async () => {
  const { context: c, board, catalogue, snapshots, saved } = fixture();
  const before = structuredClone(board);
  assert.equal(c.duplicateSelection(), true);
  const copies = board.items.slice(before.items.length);
  assert.equal(copies.length, 5, "four selected cards and their internal connector");
  assert.equal(snapshots.length, 1, "one undo snapshot for the whole lot");
  assert.equal(saved.length, 1, "one scheduled save batch");
  assert.deepEqual(board.items.slice(0, before.items.length), before.items);
  assert.equal(new Set(board.items.map((item) => item.id)).size, board.items.length);
  const [image, audio, item, nested, link] = copies;
  assert.equal(link.fromId, image.id); assert.equal(link.toId, audio.id);
  assert.deepEqual(link.fromAnchor, before.items[4].fromAnchor);
  assert.equal(link.curve, 60);
  assert.equal(audio.x - image.x, 400); assert.equal(audio.y - image.y, 120);
  assert.equal(image.imagePanX, .8); assert.equal(image.imageZoom, 3);
  assert.equal(await image.image.text(), "image"); assert.equal(await audio.audio.text(), "audio");
  assert.equal(item.projectId, "unity-project"); assert.equal(item.itemId, "canonical");
  assert.equal(c.boardRecords.get("catalogue"), catalogue);
  assert.notEqual(nested.boardId, "child");
  assert.deepEqual([...c.selectedCardIds], copies.slice(0, 4).map((value) => value.id));
});

test("nested board duplication remaps every connector and list entry without changing originals", () => {
  const { context: c, child, grandchild } = fixture();
  const before = structuredClone({ child, grandchild });
  c.duplicateSelection();
  const rootCopy = c.board.items.find((item) => item.id !== "d" && item.type === "board");
  const copied = c.boardRecords.get(rootCopy.boardId);
  const [task, nested, link] = copied.items;
  assert.notEqual(task.id, "ca"); assert.notEqual(task.entries[0].id, "entry");
  assert.equal(task.entries[0].done, true);
  assert.equal(link.fromId, task.id); assert.equal(link.toId, nested.id);
  assert.equal(copied.parentId, "root");
  const deep = c.boardRecords.get(nested.boardId);
  assert.equal(deep.parentId, copied.id);
  assert.equal(deep.items[0].itemId, "canonical");
  assert.deepEqual({ child, grandchild }, before);
});

test("selection exposes a counted button; empty selection is inert; keyboard shortcuts exclude text editing", () => {
  const { context: c, nodes, snapshots } = fixture();
  c.applyCardSelection();
  assert.equal(nodes.get("#duplicate-selection").textContent, "Dupliquer (4)");
  assert.equal(nodes.get("#duplicate-selection").hidden, false);
  c.clearCardSelection();
  assert.equal(nodes.get("#duplicate-selection").hidden, true);
  assert.equal(c.duplicateSelection(), false); assert.equal(snapshots.length, 0);
  assert.equal(c.isTextEditingTarget({ closest: () => ({}) }), true);
  assert.equal(c.isTextEditingTarget({ closest: () => null }), false);
  assert.match(source, /if \(\(event.ctrlKey \|\| event.metaKey\) && !editing\)[\s\S]*key === "d" && duplicateSelection/);
  assert.match(source, /#duplicate-selection"\)\.addEventListener\("click", duplicateSelection\)/);
});
