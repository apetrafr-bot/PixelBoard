import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
function load(name, context) {
  const start = source.indexOf(`function ${name}(`);
  vm.runInContext(source.slice(start, source.indexOf("\nfunction ", start + 1)), context);
}
let sequence = 0;
const newId = () => `entry-${++sequence}`;

test("legacy lists retain checked state and attribution, explicit unassignment stays unassigned", () => {
  const context = vm.createContext({ newId });
  load("prepareChecklist", context);
  const item = { assigneeId: "alice", entries: [
    { text: "A", done: true }, { text: "B", done: false },
    { text: "C", status: "doing", assigneeId: null },
  ] };
  context.prepareChecklist(item);
  assert.deepEqual(item.entries.map((entry) => entry.status), ["done", "todo", "doing"]);
  assert.deepEqual(item.entries.map((entry) => entry.assigneeId), ["alice", "alice", null]);
  const ids = item.entries.map((entry) => entry.id);
  item.entries[0].assigneeId = null;
  context.prepareChecklist(item);
  assert.equal(item.entries[0].assigneeId, null);
  assert.deepEqual(item.entries.map((entry) => entry.id), ids);
});

test("list progress handles empty, doing and completed rows", () => {
  const context = vm.createContext({});
  load("updateChecklistStatus", context);
  const item = { entries: [] };
  context.updateChecklistStatus(item);
  assert.equal(item.status, "todo");
  item.entries = [{ status: "doing" }, { status: "todo" }];
  context.updateChecklistStatus(item);
  assert.equal(item.status, "doing");
  item.entries.forEach((entry) => { entry.status = "done"; });
  context.updateChecklistStatus(item);
  assert.equal(item.status, "done");
  assert.ok(item.entries.every((entry) => entry.done));
});

test("team tasks enumerate individual list rows and preserve classic tasks", () => {
  const context = vm.createContext({
    newId, allStoredBoards: () => [{ id: "board", title: "Projet", items: [
      { id: "list", type: "todo", title: "Dessin", entries: [
        { id: "a", text: "A", status: "doing", assigneeId: "alice" },
        { id: "b", text: "B", status: "todo", assigneeId: "bob" },
      ] },
      { id: "task", type: "todo", title: "Ancienne tâche", status: "done" },
    ] }],
  });
  load("prepareChecklist", context);
  load("allTasks", context);
  const tasks = context.allTasks();
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].entryId, "a");
  assert.equal(tasks[0].assigneeId, "alice");
  assert.equal(tasks[1].assigneeId, "bob");
  assert.equal(tasks[2].title, "Ancienne tâche");
  assert.equal(tasks[0].id, "list");
});

test("list UI edits per-row tags, adds unassigned rows and removes independently", () => {
  class Element {
    children = [];
    events = {};
    classList = { add() {} };
    style = { setProperty() {} };
    append(...elements) { this.children.push(...elements); }
    add(element) { this.append(element); }
    setAttribute() {}
    addEventListener(name, callback) { this.events[name] = callback; }
  }
  let saved = 0;
  const context = vm.createContext({
    newId, document: { createElement: () => new Element() },
    Option: class {}, members: [{ id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }],
    getMember() {}, snapshotState() {}, renderBoard() {},
    scheduleSave() { saved++; },
    canvas: { querySelector() { return null; } }, CSS: { escape: (value) => value },
  });
  for (const name of ["prepareChecklist", "updateChecklistStatus", "renderChecklistCard", "renderTodoCard"]) load(name, context);
  const item = { id: "list", title: "", entries: [{ text: "", done: false }, { text: "B", done: false }] };
  const card = new Element();
  context.renderTodoCard(card, item);
  const [title, list, add] = card.children[0].children;
  assert.equal(title.placeholder, "Titre (facultatif)");
  const [check, text, remove, tags] = list.children[0].children;
  text.value = "Préparer le dessin";
  text.events.input();
  assert.equal(item.entries[0].text, text.value);
  const [assignee, status] = tags.children;
  assignee.value = "alice";
  assignee.events.change();
  assert.equal(item.entries[0].assigneeId, "alice");
  assert.equal(item.entries[1].assigneeId, null);
  status.value = "doing";
  status.events.change();
  assert.equal(item.entries[0].status, "doing");
  assert.equal(item.status, "doing");
  check.checked = true;
  check.events.change();
  assert.equal(item.entries[0].status, "done");
  assert.equal(item.entries[1].status, "todo");
  add.events.click();
  assert.equal(item.entries.length, 3);
  assert.equal(item.entries[2].assigneeId, null);
  remove.events.click();
  assert.equal(item.entries.length, 2);
  assert.equal(saved, 6);
});

test("team status changes affect only the targeted list row, active or background board", async () => {
  for (const active of [true, false]) {
    const item = { id: "list", entries: [
      { id: "a", status: "doing", assigneeId: "alice" }, { id: "b", status: "todo", assigneeId: "bob" },
    ] };
    const target = { id: "board", items: [item] };
    let persisted;
    const context = vm.createContext({
      structuredClone, board: active ? target : { id: "elsewhere" },
      boardRecords: new Map([[target.id, target]]), snapshotState() {}, renderBoard() {}, renderTeam() {},
      persistRecords: (records) => { persisted = records[0]; return Promise.resolve(); },
      WORKSPACE_ID: "workspace", members: [], setSaveStatus() {}, reportSaveError() {},
    });
    load("updateChecklistStatus", context);
    load("updateTaskStatus", context);
    context.updateTaskStatus({ id: "list", boardId: "board", entryId: "a" }, "done");
    assert.equal(item.entries[0].status, "done");
    assert.equal(item.entries[1].status, "todo");
    assert.equal(item.entries[1].assigneeId, "bob");
    assert.equal(persisted.id, "board");
    await Promise.resolve();
  }
});
