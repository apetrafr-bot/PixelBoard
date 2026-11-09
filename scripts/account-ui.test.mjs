import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const render = source.slice(source.indexOf("function renderAuthControls()"), source.indexOf("\nfunction renderMembers()"));

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
      remoteSession: null, registerMode: false, pendingRemoteBoardIds: new Set(), inviteCodeValue: "",
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
