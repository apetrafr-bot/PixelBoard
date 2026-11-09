import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
function load(name, context) {
  const start = source.indexOf(`function ${name}(`);
  vm.runInContext(source.slice(start, source.indexOf("\nfunction ", start + 1)), context);
}

test("checklist status follows empty, partial and complete lists", () => {
  const context = vm.createContext({});
  load("updateChecklistStatus", context);
  const item = { title: "", entries: [] };
  context.updateChecklistStatus(item);
  assert.equal(item.status, "todo");
  item.entries.push({ text: "Dessiner", done: false }, { text: "Publier", done: false });
  context.updateChecklistStatus(item);
  assert.equal(item.status, "todo");
  item.entries[0].done = true;
  context.updateChecklistStatus(item);
  assert.equal(item.status, "doing");
  item.entries[1].done = true;
  context.updateChecklistStatus(item);
  assert.equal(item.status, "done");
  item.entries = [];
  context.updateChecklistStatus(item);
  assert.equal(item.status, "todo");
  assert.equal(item.title, "");
});

test("lists and existing tasks both remain in team tasks", () => {
  const context = vm.createContext({
    allStoredBoards: () => [{ id: "board", title: "Projet", items: [
      { id: "list", type: "todo", title: "", entries: [], status: "todo" },
      { id: "task", type: "todo", title: "Ancienne tâche", status: "done" },
    ] }],
  });

  load("allTasks", context);
  const tasks = context.allTasks();
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].title, "Liste sans titre");
  assert.equal(tasks[1].title, "Ancienne tâche");
});

test("list card supports optional title, editing, checking, adding and removing rows", () => {
    class Element {
      children = [];
      events = {};
      style = { setProperty() {} };
      append(...elements) { this.children.push(...elements); }
      prepend(...elements) { this.children.unshift(...elements); }
      add(element) { this.append(element); }
      setAttribute() {}
      addEventListener(name, callback) { this.events[name] = callback; }
      insertBefore(element, before) { this.children.splice(this.children.indexOf(before), 0, element); }
    }
    let saved = 0;
    const context = vm.createContext({
      document: { createElement: () => new Element() },
      Option: class {}, members: [], getMember() {}, snapshotState() {},
      renderBoard() {}, scheduleSave() { saved++; },
      canvas: { querySelector() { return null; } }, CSS: { escape: (value) => value },
    });
    load("updateChecklistStatus", context);
    load("renderTodoCard", context);
    const item = { id: "list", title: "", entries: [{ text: "", done: false }] };
    const card = new Element();
    context.renderTodoCard(card, item);
    const content = card.children[0];
    assert.equal(content.children[1].placeholder, "Titre de la liste (facultatif)");
    const list = content.children.find((element) => element.className === "checklist-entries");
    const [check, text, remove] = list.children[0].children;
    text.value = "Préparer le dessin";
    text.events.input();
    assert.equal(item.entries[0].text, text.value);
    check.checked = true;
    check.events.change();
    assert.equal(item.status, "done");
    content.children.find((element) => element.className === "checklist-add").events.click();
    assert.equal(item.entries.length, 2);
    assert.equal(item.status, "doing");
    remove.events.click();
    assert.equal(item.entries.length, 1);
    assert.equal(item.status, "todo");
    assert.equal(saved, 4);
  });

test("team status changes check all list entries without losing partial progress for doing", () => {
  const item = { id: "list", type: "todo", entries: [{ text: "A", done: true }, { text: "B", done: false }] };
  const board = { id: "board", items: [item] };
  const context = vm.createContext({
    board, boardRecords: new Map(), snapshotState() {}, renderBoard() {},
    persistRecords: () => Promise.resolve(), WORKSPACE_ID: "workspace", members: [],
    setSaveStatus() {}, reportSaveError() {},
  });
  load("updateTaskStatus", context);
  context.updateTaskStatus({ id: item.id, boardId: board.id }, "doing");
  assert.deepEqual(item.entries.map((entry) => entry.done), [true, false]);
  context.updateTaskStatus({ id: item.id, boardId: board.id }, "done");
  assert.ok(item.entries.every((entry) => entry.done));
  context.updateTaskStatus({ id: item.id, boardId: board.id }, "todo");
  assert.ok(item.entries.every((entry) => !entry.done));
});
