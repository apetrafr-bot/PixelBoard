import { ITEM_TYPES, catalogueId, newCatalogue, fieldDefault, defaults, schemaChanges, migrateValues, snapshotMerge, itemSyncState, assetKey } from "./items-model.js";

const stateLabels = { archived: "Archivé", offline: "Unity indisponible", schema: "Champs à vérifier", new: "À créer", missing: "Asset manquant", conflict: "Conflit Unity", synced: "Synchronisé", modified: "Modifié ici" };
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const button = (text, action) => {
  const element = node("button", text, "small-action");
  element.type = "button";
  element.addEventListener("click", action);
  return element;
};

export function initItemsUI(host) {
  const panel = document.querySelector("#items-panel");
  const content = document.querySelector("#items-content");
  const status = document.querySelector("#items-status");
  const projectInput = document.querySelector("#items-project");
  let projectId = "";
  let remote = null;
  let selectedId = null;
  let busy = false;
  let draft = null;
  let baseVersion = 0;
  let requestKey = null;
  let lastFocus = null;
  let generation = 0;
  let sessionId = host.session()?.id;
  const say = (text) => { status.textContent = text; };
  const catalogue = () => host.records().find((record) => record.id === catalogueId(projectId));
  const owner = () => host.session()?.role === "owner";
  const request = async (action, options) => {
    const started = generation;
    const result = await host.api(action, options);
    if (started !== generation || !host.session()) throw new Error("Session modifiée. Rechargez le projet après connexion.");
    return result;
  };
  const call = (action, body) => request(`unity-${action}`, { method: "POST", body: { project_id: projectId, ...body } });
  const run = async (action) => {
    if (busy) return;
    const started = generation;
    busy = true;
    panel.setAttribute("aria-busy", "true");
    try { await action(); } catch (error) { if (started === generation) say(error.message); }
    finally { if (started === generation) { busy = false; panel.setAttribute("aria-busy", "false"); } }
  };
  const save = async (record) => {
    const started = generation;
    await host.save(record);
    if (started !== generation) throw new Error("Session modifiée pendant l’enregistrement.");
    requestKey = null;
  };
  const refresh = async () => {
    remote = null;
    content.replaceChildren();
    remote = await request("unity-state", { query: `&project_id=${encodeURIComponent(projectId)}` });
    say(remote.project.published_at ? `Dernier instantané Unity : ${remote.project.published_at} (UTC).` : "Ouvrez Unity et publiez ses champs et assets.");
    render();
  };
  const confirm = (title, text, action) => host.confirm(title, text, action);

  function renderField(field, value, change, snapshot, level = 0) {
    const wrapper = node("div", undefined, "item-field");
    const caption = node("label", field.label || field.name);
    const id = `field-${crypto.randomUUID()}`;
    caption.htmlFor = id;
    wrapper.append(caption);
    if (field.header) wrapper.prepend(node("strong", field.header));
    if (field.tooltip) wrapper.append(node("small", field.tooltip));
    const kind = field.kind;
    if (level > 12) {
      wrapper.append(node("p", "Imbrication trop profonde : import bloqué."));
      return wrapper;
    }
    if (kind === "object" || kind === "list") {
      const details = node("details");
      details.open = level < 1;
      details.append(node("summary", kind === "list" ? `${Array.isArray(value) ? value.length : "?"} éléments` : "Champs"));
      if (kind === "object" && value && !Array.isArray(value) && typeof value === "object") {
        field.fields.forEach((child) => details.append(renderField(child, value[child.name], (next) => {
          value[child.name] = next; change(value);
        }, snapshot, level + 1)));
        const unknown = Object.keys(value).filter((key) => !field.fields.some((child) => child.name === key));
        if (unknown.length) details.append(node("p", `Anciens champs conservés, import bloqué : ${unknown.join(", ")}`, "item-warning"));
      } else if (kind === "list" && Array.isArray(value)) {
        const draw = () => {
          details.querySelectorAll(".item-list-entry,.item-list-add").forEach((element) => element.remove());
          value.forEach((entry, index) => {
            const row = node("div", undefined, "item-list-entry");
            row.append(renderField({ ...field.element, label: `${index + 1}` }, entry, (next) => { value[index] = next; change(value); }, snapshot, level + 1));
            row.append(button("Retirer cet élément", () => { value.splice(index, 1); change(value); draw(); }));
            details.append(row);
          });
          const add = button("＋ Ajouter un élément", () => {
            value.push(fieldDefault(field.element)); change(value); draw();
          });
          add.classList.add("item-list-add");
          details.append(add);
        };
        draw();
      } else details.append(node("p", "Ancienne valeur incompatible conservée. Corrigez la structure avant import.", "item-warning"));
      wrapper.append(details);
      return wrapper;
    }
    if (["color", "vector2", "vector3", "vector4"].includes(kind)) {
      const components = kind === "color" ? ["r", "g", "b", "a"] : ["x", "y", "z", "w"].slice(0, Number(kind.at(-1)));
      const group = node("div", undefined, "item-components");
      components.forEach((component) => {
        const input = node("input");
        input.type = "number"; input.step = "any"; input.value = value?.[component] ?? "";
        input.setAttribute("aria-label", `${field.label || field.name} ${component}`);
        const label = node("label", component);
        input.addEventListener("change", () => {
          if (input.value === "" || !Number.isFinite(Number(input.value))) return;
          value = { ...value, [component]: Number(input.value) }; change(value);
        });
        label.append(input); group.append(label);
      });
      wrapper.append(group);
      return wrapper;
    }
    let input;
    if (kind === "asset") {
      input = node("select");
      input.append(new Option("Aucune référence", "null"));
      const options = new Map([["null", null]]);
      const compatible = snapshot.assets.filter((asset) => !field.type || asset.type === field.type || asset.types?.includes(field.type));
      compatible.forEach((asset) => {
        const key = assetKey(asset);
        options.set(key, { guid: asset.guid, file_id: asset.file_id });
        input.append(new Option(`${asset.name} · ${asset.path || asset.type} · ${asset.file_id}`, key));
      });
      (catalogue()?.definitions || []).filter((item) => !item.unity && !item.archived
        && (!field.type || [item.type, "UnityEngine.Object", "UnityEngine.ScriptableObject"].includes(field.type))).forEach((item) => {
        const key = `item:${item.id}`;
        options.set(key, { item_id: item.id });
        input.append(new Option(`${item.name} (nouvel item, même lot requis)`, key));
      });
      const key = value?.item_id ? `item:${value.item_id}` : value ? assetKey(value) : "null";
      if (!options.has(key)) {
        input.append(new Option("Référence manquante ou incompatible (conservée)", key));
        wrapper.append(node("small", "Import bloqué tant que cette référence n’est pas résolue.", "item-warning"));
      }
      input.value = key;
      input.addEventListener("change", () => { if (options.has(input.value)) change(structuredClone(options.get(input.value))); });
    } else if (kind === "enum" && !field.flags) {
      input = node("select");
      field.options.forEach((option) => input.append(new Option(option.name, String(option.value))));
      if (!field.options.some((option) => option.value === value)) input.append(new Option(`Valeur inconnue : ${value}`, String(value)));
      input.value = String(value);
      input.addEventListener("change", () => change(Number(input.value)));
    } else if (["string", "bool", "int", "float", "enum"].includes(kind)) {
      input = node(kind === "string" ? "textarea" : "input");
      if (kind === "string") { input.rows = 2; input.value = typeof value === "string" ? value : JSON.stringify(value); }
      else if (kind === "bool") { input.type = "checkbox"; input.checked = value === true; }
      else {
        input.type = "number"; input.step = ["int", "enum"].includes(kind) ? "1" : "any";
        input.value = value ?? "";
        if (field.min !== undefined) input.min = field.min;
        if (field.max !== undefined) input.max = field.max;
      }
      input.addEventListener("input", () => {
        if (kind === "string") change(input.value);
        else if (kind === "bool") change(input.checked);
        else if (input.value !== "" && input.checkValidity() && Number.isFinite(Number(input.value))) change(Number(input.value));
      });
    } else {
      wrapper.append(node("p", `Non pris en charge : ${field.type || kind}. Valeur conservée, import bloqué.`, "item-warning"));
      const raw = node("pre", JSON.stringify(value, null, 2));
      wrapper.append(raw);
      return wrapper;
    }
    input.id = id;
    wrapper.append(input);
    return wrapper;
  }

  function render() {
    content.replaceChildren();
    document.querySelector("#items-pair-controls").hidden = !owner();
    document.querySelector("#items-import").hidden = !owner();
    document.querySelector("#items-import-all").hidden = !owner();
    const snapshot = remote?.snapshot;
    if (!snapshot) {
      content.append(node("p", "Liez votre projet Unity puis publiez ses champs depuis l’Editor. Aucun champ de jeu n’est deviné par le site."));
      return;
    }
    let record = catalogue();
    if (!record) {
      content.append(button("Créer le catalogue avec les assets Unity", () => run(async () => {
        const merged = snapshotMerge(newCatalogue(projectId, snapshot), snapshot, crypto.randomUUID.bind(crypto));
        await save(merged.catalogue); render();
      })));
      return;
    }
    if (record.schemaHash !== snapshot.schema_hash) {
      const warning = node("details", undefined, "item-warning");
      warning.open = true;
      warning.append(node("summary", "Les champs Unity ont changé : vérifier avant import"));
      const diff = schemaChanges(record.schema || { families: [] }, snapshot.schema);
      warning.append(node("pre", diff.join("\n") || "Métadonnées ou valeurs initiales modifiées."));
      warning.append(button("Accepter le schéma (conserver les anciennes valeurs)", () => confirm("Mettre à jour les champs ?", "Les nouveaux champs recevront leur valeur initiale. Les anciennes valeurs seront conservées; les champs retirés ou incompatibles bloqueront l’import.", () => run(async () => {
        const next = structuredClone(record);
        next.schemaHash = snapshot.schema_hash; next.schema = structuredClone(snapshot.schema);
        next.definitions.forEach((item) => {
          const family = snapshot.schema.families.find((entry) => entry.type === item.type);
          item.values = migrateValues(family.fields, item.values);
          item.schemaHash = snapshot.schema_hash; item.revision++;
        });
        await save(next); draft = null; render();
      }))));
      content.append(warning);
    }
    const controls = node("div", undefined, "items-filters");
    const search = node("input"); search.placeholder = "Rechercher un item"; search.setAttribute("aria-label", "Rechercher un item");
    const familyFilter = node("select"); familyFilter.setAttribute("aria-label", "Famille d’items");
    familyFilter.append(new Option("Toutes les familles", ""), ...ITEM_TYPES.map((type) => new Option(type, type)));
    const syncFilter = node("select"); syncFilter.setAttribute("aria-label", "État de synchronisation");
    syncFilter.append(new Option("Tous les états", ""), ...Object.entries(stateLabels).map(([key, text]) => new Option(text, key)));
    controls.append(search, familyFilter, syncFilter);
    content.append(controls);
    const list = node("div", undefined, "items-list");
    const drawList = () => {
      list.replaceChildren();
      record.definitions.filter((item) => item.name.toLowerCase().includes(search.value.toLowerCase())
        && (!familyFilter.value || item.type === familyFilter.value)
        && (!syncFilter.value || itemSyncState(item, snapshot) === syncFilter.value)).forEach((item) => {
        const row = node("div", undefined, "items-row");
        const choose = button(item.name || "Item sans nom", () => {
          if (draft) { say("Enregistrez ou abandonnez la fiche ouverte avant de changer d’item."); return; }
          selectedId = item.id; render();
        });
        choose.draggable = !item.archived;
        if (item.illustration) {
          const image = node("img");
          image.src = item.illustration; image.alt = ""; image.className = "item-thumbnail";
          choose.prepend(image);
        }
        choose.addEventListener("dragstart", (event) => {
          event.dataTransfer.setData("application/x-pixelboard-item", JSON.stringify({ projectId, itemId: item.id }));
          event.dataTransfer.effectAllowed = "copy";
        });
        row.append(choose, node("small", `${item.type} · ${stateLabels[itemSyncState(item, snapshot)]}`),
          button("＋ Au tableau", () => host.addReference(projectId, item.id)));
        list.append(row);
      });
      if (!list.childElementCount) list.append(node("p", "Aucun item correspondant."));
    };
    [search, familyFilter, syncFilter].forEach((control) => control.addEventListener("input", drawList));
    drawList(); content.append(list);
    const create = node("div", undefined, "items-actions");
    const typeSelect = node("select"); typeSelect.setAttribute("aria-label", "Famille du nouvel item");
    ITEM_TYPES.forEach((type) => typeSelect.append(new Option(type, type)));
    create.append(typeSelect, button("＋ Nouvel item", () => run(async () => {
      if (draft) throw new Error("Enregistrez ou abandonnez la fiche ouverte.");
      const family = snapshot.schema.families.find((entry) => entry.type === typeSelect.value);
      const next = structuredClone(record);
      const id = crypto.randomUUID();
      next.definitions.push({ id, type: family.type, name: "Nouvel item", values: defaults(family.fields), schemaHash: snapshot.schema_hash, unity: null, revision: 1, archived: false });
      await save(next); selectedId = id; render();
    })));
    content.append(create);
    const selected = record.definitions.find((item) => item.id === selectedId);
    if (!selected) return;
    if (!draft) { draft = structuredClone(selected); baseVersion = host.version(record.id); }
    const editor = node("form", undefined, "item-editor");
    const heading = node("h3", `Fiche · ${selected.type}`);
    const nameLabel = node("label", "Nom dans le catalogue");
    const name = node("input"); name.value = draft.name; name.required = true; name.maxLength = 120;
    name.addEventListener("input", () => { draft.name = name.value; });
    nameLabel.append(name); editor.append(heading, nameLabel);
    const illustrationLabel = node("label", "Miniature illustrative (ne remplace pas un Sprite Unity)");
    const illustration = node("input");
    illustration.type = "file"; illustration.accept = "image/png,image/jpeg,image/webp";
    illustration.addEventListener("change", () => run(async () => {
      const file = illustration.files[0];
      if (!file) return;
      const target = draft;
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 1024 * 1024) throw new Error("Choisissez une image PNG, JPG ou WEBP de 1 Mio maximum.");
      const reader = new FileReader();
      const data = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Lecture de la miniature impossible."));
        reader.readAsDataURL(file);
      });
      if (draft !== target) throw new Error("Fiche fermée pendant la lecture. Rouvrez-la pour ajouter la miniature.");
      draft.illustration = data;
      say("Miniature ajoutée au brouillon. Enregistrez la fiche pour la partager.");
    }));
    illustrationLabel.append(illustration);
    editor.append(illustrationLabel);
    if (draft.illustration) editor.append(button("Retirer la miniature", () => { delete draft.illustration; render(); }));
    const family = (record.schema || snapshot.schema).families.find((entry) => entry.type === selected.type);
    family.fields.forEach((field) => editor.append(renderField(field, draft.values[field.name], (value) => { draft.values[field.name] = value; }, snapshot)));
    const unknown = Object.keys(draft.values).filter((key) => !family.fields.some((field) => field.name === key));
    if (unknown.length) editor.append(node("p", `Champs retirés conservés : ${unknown.join(", ")}. Import bloqué : vérifiez le schéma dans Unity.`, "item-warning"));
    const submit = node("button", "Enregistrer la fiche", "button button-dark"); submit.type = "submit";
    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      run(async () => {
        if (baseVersion !== host.version(record.id)) throw new Error("Catalogue modifié ailleurs. Abandonnez la fiche puis rechargez pour comparer; votre brouillon reste affiché.");
        const next = structuredClone(catalogue());
        draft.revision++; next.definitions[next.definitions.findIndex((item) => item.id === draft.id)] = structuredClone(draft);
        await save(next); draft = null; render(); say("Fiche enregistrée sur le serveur.");
      });
    });
    editor.append(submit, button("Fermer / abandonner le brouillon", () => { draft = null; selectedId = null; render(); }),
      button(selected.archived ? "Désarchiver" : "Archiver (aucun asset supprimé)", () => run(async () => {
        const next = structuredClone(catalogue()); const item = next.definitions.find((item) => item.id === selected.id);
        item.archived = !item.archived; item.revision++; await save(next); draft = null; selectedId = null; render();
      })));
    content.append(editor);
  }

  async function importSnapshot() {
    if (draft) throw new Error("Fermez la fiche avant de comparer l’instantané Unity.");
    await refresh();
    if (!remote.snapshot) throw new Error("Aucun instantané Unity disponible.");
    const current = catalogue() || newCatalogue(projectId, remote.snapshot);
    const merged = snapshotMerge(current, remote.snapshot, crypto.randomUUID.bind(crypto));
    await save(merged.catalogue); render();
    if (!merged.conflicts.length) { say("Assets Unity ajoutés sans doublon."); return; }
    const conflicts = node("section", undefined, "item-warning");
    conflicts.append(node("h3", "Versions différentes : choix requis"));
    merged.conflicts.forEach(({ id, current: before, unity }) => {
      const details = node("details");
      details.append(node("summary", before.name), node("p", "Version du site conservée par défaut."),
        node("pre", `SITE\n${JSON.stringify(before.values, null, 2)}\nUNITY\n${JSON.stringify(unity.values, null, 2)}`),
        button("Remplacer cette fiche par Unity", () => confirm("Remplacer la fiche ?", "La version Unity affichée remplacera cette fiche du catalogue. Vous pouvez exporter l’espace avant de continuer.", () => run(async () => {
          const updated = snapshotMerge(catalogue(), remote.snapshot, crypto.randomUUID.bind(crypto), new Set([id]));
          await save(updated.catalogue); details.remove(); say("Fiche actualisée depuis Unity.");
        }))));
      conflicts.append(details);
    });
    content.prepend(conflicts);
    say(`${merged.conflicts.length} conflit(s) conservé(s) pour comparaison.`);
  }

  async function queue(kind, all = false) {
    const record = catalogue();
    const saved = record?.definitions.find((item) => item.id === selectedId);
    if (draft && (draft.name !== saved?.name || draft.illustration !== saved?.illustration || JSON.stringify(draft.values) !== JSON.stringify(saved?.values))) throw new Error("Enregistrez la fiche avant de demander un import.");
    const items = all ? record?.definitions.filter((item) => !item.archived) : record?.definitions.filter((item) => item.id === selectedId);
    if (kind === "import" && (!owner() || !items?.length)) throw new Error("Sélectionnez un item ou utilisez l’import de tous les items (administrateur uniquement).");
    const send = () => run(async () => {
      await host.flush();
      const signature = JSON.stringify([kind, items.map((item) => item.id)]);
      if (requestKey?.signature !== signature) requestKey = { signature, id: crypto.randomUUID() };
      const result = await call("request", { request_id: requestKey.id, kind, catalogue_version: record ? host.version(record.id) : 0, item_ids: items.map((item) => item.id) });
      requestKey = null;
      say(`Demande ${result.job_id} : ${result.state}. Unity doit être ouvert; confirmez dans l’Editor avant toute écriture.`);
      await refresh();
    });
    // Let run() release its guard before the confirmation invokes send().
    if (kind === "import") confirm("Autoriser cet import Unity ?", `${items.length} fiche(s) seront figées dans cette demande. Les modifications ultérieures ne changeront pas cet import. Une confirmation dans Unity reste obligatoire.`, send);
    else {
      if (requestKey?.signature !== kind) requestKey = { signature: kind, id: crypto.randomUUID() };
      const result = await call("request", { request_id: requestKey.id, kind, item_ids: [] });
      requestKey = null; await refresh(); say(`Vérification en attente (${result.job_id}). Ouvrez Unity.`);
    }
  }

  document.querySelector("#items-open").addEventListener("click", () => {
    lastFocus = document.activeElement;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      const known = host.records().filter((record) => record.recordType === "item-catalogue");
      if (!projectInput.value && known[0]) projectInput.value = known[0].projectId;
      projectInput.focus();
      document.querySelector("#items-pair-controls").hidden = !owner();
    }
  });
  document.querySelector("#items-close").addEventListener("click", () => { panel.hidden = true; lastFocus?.focus(); });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.stopPropagation(); panel.hidden = true; lastFocus?.focus(); }
  });
  document.querySelector("#items-load").addEventListener("click", () => run(async () => {
    if (draft) throw new Error("Enregistrez ou abandonnez la fiche ouverte avant de charger un projet.");
    projectId = projectInput.value.trim();
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(projectId)) throw new Error("Copiez l’identifiant du projet affiché dans Unity.");
    document.querySelector("#items-pair-code").value = "";
    document.querySelector("#items-pair-code").hidden = true;
    selectedId = null; await refresh();
  }));
  document.querySelector("#items-pair").addEventListener("click", () => run(async () => {
    if (!owner()) throw new Error("Appairage réservé à l’administrateur.");
    if (draft) throw new Error("Enregistrez ou abandonnez la fiche ouverte avant de changer la liaison.");
    projectId = projectInput.value.trim();
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(projectId)) throw new Error("Copiez l’identifiant du projet affiché dans Unity.");
    const result = await call("pair-create", { project_name: document.querySelector("#items-project-name").value.trim() });
    selectedId = null;
    await refresh();
    const output = document.querySelector("#items-pair-code");
    output.value = result.pair_code; output.hidden = false;
    say("Code à saisir dans Unity sous 10 minutes. Usage unique; ne le partagez pas publiquement.");
    setTimeout(() => { output.value = ""; output.hidden = true; }, 600000);
  }));
  document.querySelector("#items-revoke").addEventListener("click", () => confirm("Révoquer la liaison ?", "Le jeton Unity et les demandes actives seront annulés.", () => run(async () => { await call("revoke", {}); await refresh(); say("Liaison révoquée."); })));
  document.querySelector("#items-refresh").addEventListener("click", () => run(() => queue("refresh")));
  document.querySelector("#items-read").addEventListener("click", () => run(importSnapshot));
  document.querySelector("#items-import").addEventListener("click", () => run(() => queue("import")));
  document.querySelector("#items-import-all").addEventListener("click", () => run(() => queue("import", true)));
  document.querySelector("#items-jobs").addEventListener("click", () => run(async () => {
    await refresh();
    const jobs = node("section");
    jobs.append(node("h3", "Demandes Unity"));
    remote.jobs.forEach((job) => {
      const details = node("details");
      details.append(node("summary", `${job.kind} · ${job.state} · ${job.created_at} UTC`), node("pre", JSON.stringify(job.result || { message: "En attente de Unity; aucune réussite confirmée." }, null, 2)));
      if (job.catalogue_notes?.length) details.append(node("p", job.catalogue_notes.join(" "), "item-warning"));
      if (owner() && ["queued", "claimed"].includes(job.state)) details.append(button("Annuler", () => run(async () => {
        await call("cancel", { job_id: job.id }); say("Demande annulée."); details.remove();
      })));
      jobs.append(details);
    });
    content.prepend(jobs);
  }));
  return {
    setBlocked(value) { panel.inert = value; },
    openItem(project, id) {
      projectInput.value = project; projectId = project; selectedId = id; draft = null;
      panel.hidden = false;
      run(refresh);
    },
    sessionChanged() {
      document.querySelector("#items-pair-controls").hidden = !owner();
      document.querySelector("#items-import").hidden = !owner();
      document.querySelector("#items-import-all").hidden = !owner();
      if (!host.session() || host.session().id !== sessionId) {
        sessionId = host.session()?.id;
        generation++;
        busy = false; panel.setAttribute("aria-busy", "false");
        panel.hidden = true; content.replaceChildren(); remote = null; draft = null; selectedId = null; projectId = "";
        projectInput.value = ""; say("");
        requestKey = null;
        document.querySelector("#items-pair-code").value = "";
        document.querySelector("#items-pair-code").hidden = true;
      }
    },
  };
}
