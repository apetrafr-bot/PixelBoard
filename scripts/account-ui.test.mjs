import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const render = source.slice(source.indexOf("function renderAuthControls()"), source.indexOf("\nfunction renderMembers()"));
const renderTeam = source.slice(source.indexOf("function renderTeam()"), source.indexOf("\nfunction renderAuthControls()"));
const submitSetup = source.slice(source.indexOf("async function submitOwnerSetup("), source.indexOf("\nfunction renderAuthControls()"));

for (const outcome of ["success", "wrong-secret", "already-initialized", "http"]) {
  test(`owner setup submission handles ${outcome} without retaining secrets`, async () => {
    const form = {
      elements: { setup_secret: { value: "private-secret" }, password: { value: "private-password" } },
      reset() { this.elements.setup_secret.value = ""; this.elements.password.value = ""; },
    };
    const nodes = {
      "#owner-setup-status": {},
      "#login-form": { elements: { email: {} } },
    };
    const calls = [];
    const context = vm.createContext({
      $: (selector) => nodes[selector],
      setupAvailable: true, setupBusy: false, apiState: "ready", registerMode: false,
      location: { protocol: outcome === "http" ? "http:" : "https:" },
      FormData: class {
        entries() { return Object.entries({ name: "Owner", workspace: "Team", email: "owner@example.com", password: "private-password", setup_secret: "private-secret" }); }
      },
      renderAuthControls() {}, showToast() {},
      async apiRequest(action, options) {
        if (action === "auth") return { setup_available: outcome !== "already-initialized" };
        calls.push({ header: options.headers["X-Setup-Secret"], bodyKeys: Object.keys(options.body) });
        if (outcome !== "success") throw new Error("Setup refused");
        return {};
      },
    });
    vm.runInContext(submitSetup, context);
    await context.submitOwnerSetup({ preventDefault() {}, currentTarget: form });
    assert.equal(context.setupBusy, false);
    if (outcome === "http") {
      assert.equal(calls.length, 0);
      assert.match(nodes["#owner-setup-status"].textContent, /HTTPS/);
    } else {
      assert.equal(calls.length, 1);
      assert.equal(calls[0].header, "private-secret");
      assert.equal(calls[0].bodyKeys.includes("setup_secret"), false);
      assert.equal(form.elements.setup_secret.value, "");
      assert.equal(form.elements.password.value, "");
      assert.equal(context.setupAvailable, outcome === "wrong-secret");
    }
  });
}

for (const role of [null, "member", "owner"]) {
  test(`member administration is owner-only for ${role ?? "local"} session, tasks remain available`, () => {
    const nodes = new Map();
    const $ = (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, { replaceChildren() {}, hidden: false });
      return nodes.get(selector);
    };
    let membersRendered = false;
    let tasksRendered = false;
    vm.runInNewContext(`${renderTeam}\nrenderTeam();`, {
      $, remoteSession: role ? { role, workspace: "Équipe" } : null,
      apiReady: true, members: [], renderAuthControls() {},
      renderMembers() { membersRendered = true; },
      renderAssigneeOptions() {}, renderTasks() { tasksRendered = true; },
    });
    assert.equal($("#member-management").hidden, role !== "owner");
    assert.equal(membersRendered, role === "owner");
    assert.equal(tasksRendered, true);
    assert.equal($("#member-form").hidden, true);
    assert.match($("#team-storage-notice").textContent, role ? /serveur/ : /appareil/);
  });
}

for (const state of ["checking", "missing", "error", "ready"]) {
  test(`account access stays visible when API is ${state}`, () => {
    const nodes = new Map();
    const $ = (selector) => {
      if (!nodes.has(selector)) {
        nodes.set(selector, {
          hidden: true, dataset: {}, attributes: {}, controls: [{ disabled: false }],
          setAttribute(key, value) { this.attributes[key] = value; },
          getAttribute(key) { return this.attributes[key]; },
          querySelectorAll() { return this.controls; },
        });
      }
      return nodes.get(selector);
    };
    vm.runInNewContext(`${render}\nrenderAuthControls();`, {
      $, apiState: state, apiMessage: "Configuration MySQL absente",
      renderAccessGate() {},
      remoteSession: null, registerMode: false, pendingRemoteBoardIds: new Set(), inviteCodeValue: "",
      setupAvailable: false, setupBusy: false,
    });
    assert.equal($("#auth-section").hidden, false);
    assert.equal($("#auth-forms").hidden, false);
    assert.equal($("#profile-button").textContent, "Connexion");
    assert.equal($("#login-form").controls[0].disabled, state !== "ready");
    assert.equal($("#register-form").controls[0].disabled, state !== "ready");
    assert.equal($("#account-setup").open, state === "missing" || state === "error");
    assert.ok($("#auth-description").textContent.length > 0);
    if (state === "missing") assert.match($("#auth-description").textContent, /dist\/api/);
    if (state === "error") assert.match($("#auth-description").textContent, /Configuration MySQL absente/);
  });
}

for (const [state, available, session, visible] of [
  ["ready", true, null, true],
  ["ready", false, null, false],
  ["error", true, null, false],
  ["checking", true, null, false],
  ["ready", true, { role: "owner" }, false],
]) {
  test(`owner setup visibility: ${state}, available=${available}, signedIn=${!!session}`, () => {
    const nodes = new Map();
    const $ = (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, {
        dataset: {}, attributes: {}, controls: [{}],
        setAttribute(key, value) { this.attributes[key] = value; },
        getAttribute(key) { return this.attributes[key]; },
        querySelectorAll() { return this.controls; },
      });
      return nodes.get(selector);
    };
    vm.runInNewContext(`${render}\nrenderAuthControls();`, {
      $, apiState: state, apiMessage: "", remoteSession: session, registerMode: false,
      renderAccessGate() {},
      pendingRemoteBoardIds: new Set(), inviteCodeValue: "", setupAvailable: available, setupBusy: false,
    });
    assert.equal($("#owner-setup").hidden, !visible);
    assert.equal($("#owner-setup-form").controls[0].disabled, !visible);
    if (visible) {
      assert.equal($("#login-form").hidden, true);
      assert.equal($("#register-form").hidden, true);
      assert.equal($("#auth-mode-toggle").hidden, true);
    }

  });
}

    for (const signedIn of [false, true]) {
      test(`access gate hides and disables workspace when signedIn=${signedIn}`, () => {
        const nodes = new Map();
        const $ = (selector) => {
          if (!nodes.has(selector)) nodes.set(selector, { append(child) { child.parentElement = this; } });
          return nodes.get(selector);
        };
        let locked;
        const gate = source.slice(source.indexOf("function renderAccessGate()"), source.indexOf("\nfunction renderAuthControls()"));
        vm.runInNewContext(`${gate}\nrenderAccessGate();`, {
          $, remoteSession: signedIn ? { id: "1" } : null, apiState: "ready",
          document: { body: { classList: { toggle(name, value) { locked = value; } } } },
        });
        assert.equal(locked, !signedIn);
        assert.equal($(".app-shell").inert, !signedIn);
        assert.equal($("#login-page").hidden, signedIn);
        assert.equal($("#auth-section").parentElement, signedIn ? $("#account-slot") : $("#login-content"));
  });
}
