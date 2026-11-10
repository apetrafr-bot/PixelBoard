import "./styles.css";
import { initItemsUI } from "./items-ui.js";
import { isCatalogue, catalogueId, itemThumbnail } from "./items-model.js";
import { AUDIO_ACCEPT, audioMime, prepareAudio, restoreAudio } from "./audio.js";

const DB_NAME = "pixelboard-local";
const STORE_NAME = "boards";
const ROOT_ID = "atelier-personnel";
const WORKSPACE_ID = "__pixelboard_workspace__";
const REMOTE_CACHE_PREFIX = "__pixelboard_remote_cache__";
const ORIGIN = { x: 1500, y: 1000 };
const INITIAL_SIZE = { width: 4200, height: 3200 };
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.4;
const HISTORY_LIMIT = 40;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const API_URL = "/api/index.php";

const $ = (selector, root = document) => root.querySelector(selector);
const canvas = $("#board-canvas");
const boardStage = $("#board-stage");
const viewport = $("#canvas-viewport");
const connectorLayer = $("#connector-layer");
const imageInput = $("#image-input");
const audioInput = $("#audio-input");
const saveStatus = $("#save-status");
const infoDialog = $("#info-dialog");
const dialogTitle = $("#dialog-title");
const dialogCopy = $("#dialog-copy");
const dialogNote = $("#dialog-note");
const toast = $("#toast");
const teamPanel = $("#team-panel");

let db;
let board;
let members = [];
let boardRecords = new Map();
let activeTool = "select";
let selectedVectorId = null;
let selectedCardIds = new Set();
let cardClipboard = null;
let pasteCount = 0;
let marqueeGesture = null;
let saveTimer;
let toastTimer;
let lastZIndex = 5;
let history = [];
let redoHistory = [];
let panGesture = null;
let drawingGesture = null;
let connectionGesture = null;
let cardResizeObserver = null;
let edgeTimer;
let taskFilter = "all";
let selectedMember = null;
let pendingConfirm = null;
let spacePressed = false;
let connectorResizeGesture = null;
let apiState = "checking";
let apiMessage = "";
let apiReady = false;
let remoteSession = null;
let csrfToken = "";
let remoteVersions = new Map();
let pendingRemoteBoardIds = new Set();
let remoteSyncTimer;
let remoteWritesInFlight = 0;
let remoteSyncInFlight = false;
let registerMode = false;
let inviteCodeValue = "";
let setupAvailable = false;
let setupBusy = false;
let backupBusy = false;
let itemsUI;

const newId = () => crypto.randomUUID();

async function apiRequest(action, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (csrfToken && options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(`${API_URL}?action=${encodeURIComponent(action)}${options.query || ""}`, {
    method: options.method || "GET",
    credentials: "same-origin",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.headers.get("content-type")?.includes("application/json")) {
    const error = new Error("L’API équipe PHP n’est pas installée à cette adresse.");
    error.apiMissing = true;
    throw error;
  }
  const payload = await response.json();
  if (payload.csrf) csrfToken = payload.csrf;
  if (!response.ok) {
    if (response.status === 401 && remoteSession) {
      canvas.querySelectorAll("audio").forEach((player) => player.pause());
      remoteSession = null;
      clearInterval(remoteSyncTimer);
      apiMessage = "Votre session a expiré. Reconnectez-vous pour continuer.";
      renderAuthControls();
    }
    const error = new Error(payload.error || `Erreur serveur (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function serializeBoard(record) {
  const data = structuredClone(record);
  for (const item of data.items || []) {
    if (item.image instanceof Blob) item.image = await imageDataUrl(item.image);
    if (item.coverImage instanceof Blob) item.coverImage = await imageDataUrl(item.coverImage);
    if (item.type === "audio") item.audio = await imageDataUrl(await restoreAudio(item.audio));
  }
  return data;
}

async function deserializeBoard(record) {
  const data = structuredClone(record);
  for (const item of data.items || []) {
    if (typeof item.image === "string" && item.image.startsWith("data:image/")) item.image = await (await fetch(item.image)).blob();
    if (typeof item.coverImage === "string" && item.coverImage.startsWith("data:image/")) item.coverImage = await (await fetch(item.coverImage)).blob();
    if (item.type === "audio") item.audio = await restoreAudio(item.audio);
  }
  return normalizeBoard(data);
}

function remoteMemberRecord(member) {
  return {
    id: `user:${member.id}`,
    name: member.display_name,
    role: member.tag || "",
    color: safeHexColor(member.color, "#d7f36a"),
    email: member.email,
    accountRole: member.role,
  };
}

async function saveRemoteBoard(record) {
  const data = await serializeBoard(record);
  const response = await apiRequest("board", {
    method: "PUT",
    body: { id: record.id, version: remoteVersions.get(record.id) || 0, data },
  });
  remoteVersions.set(record.id, response.version);
}

async function persistRecords(records) {
  if (!remoteSession) {
    await writeRecords(records);
    return;
  }
  remoteWritesInFlight += 1;
  try {
    for (const record of records) {
      if (record.id === WORKSPACE_ID) continue;
      const cachedRecord = remoteCacheRecord(record, true);
      try {
        await writeRecords([cachedRecord]);
      } catch (error) {
        error.localBackupSaved = false;
        throw error;
      }
      try {
        if (pendingRemoteBoardIds.has(record.id)) {
          const error = new Error("Conflit en attente : ouvrez Mon compte → Recharger la copie serveur. Exportez d’abord votre copie pour conserver vos modifications.");
          error.localBackupSaved = true;
          throw error;
        }
        await saveRemoteBoard(record);
        pendingRemoteBoardIds.delete(record.id);
        await writeRecords([remoteCacheRecord(record, false)]);
      } catch (error) {
        pendingRemoteBoardIds.add(record.id);
        error.localBackupSaved = true;
        renderAuthControls();
        throw error;
      }
    }
  } finally {
    remoteWritesInFlight -= 1;
  }
}

function remoteCacheRecord(record, pendingRemoteSync) {
  const cached = {
    ...structuredClone(record),
    id: `${REMOTE_CACHE_PREFIX}${remoteSession.id}:${record.id}`,
    remoteBoardId: record.id,
    pendingRemoteSync,
  };
  return cached;
}

function localWorkspaceRecords(records) {
  return records.filter((record) => record.id !== WORKSPACE_ID && !record.id.startsWith(REMOTE_CACHE_PREFIX));
}

async function loadRemoteWorkspace(auth, localRecords) {
  remoteSession = {
    id: String(auth.user.id),
    name: auth.user.display_name,
    email: auth.user.email,
    role: auth.user.role,
    avatar: auth.user.avatar_data || "",
    workspace: auth.workspace?.name || "Espace partagé",
  };
  const [memberResponse, boardResponse] = await Promise.all([
    apiRequest("members"),
    apiRequest("boards"),
  ]);
  history = [];
  redoHistory = [];
  updateHistoryButtons();
  members = memberResponse.members.map(remoteMemberRecord);
  const self = members.find((member) => member.id === `user:${remoteSession.id}`);
  if (self) remoteSession.name = self.name;
  remoteVersions = new Map();
  pendingRemoteBoardIds = new Set();
  const remoteBoards = [];
  for (const entry of boardResponse.boards) {
    const record = await deserializeBoard(entry.data);
    record.remoteUpdatedAt = entry.updated_at;
    remoteVersions.set(record.id, entry.version);
    remoteBoards.push(record);
  }
  const pendingRecords = localRecords.filter((record) =>
    record.id.startsWith(`${REMOTE_CACHE_PREFIX}${remoteSession.id}:`) && record.pendingRemoteSync && record.remoteBoardId,
  );
  const remoteBoardMap = new Map(remoteBoards.map((record) => [record.id, record]));
  pendingRecords.forEach((cached) => {
    const data = { ...cached };
    delete data.id;
    delete data.remoteBoardId;
    delete data.pendingRemoteSync;
    const record = normalizeBoard({ ...data, id: cached.remoteBoardId });
    remoteBoardMap.set(record.id, record);
    pendingRemoteBoardIds.add(record.id);
  });
  boardRecords = remoteBoardMap;
  remoteBoards.splice(0, remoteBoards.length, ...remoteBoardMap.values());
  const normalBoards = remoteBoards.filter((record) => !isCatalogue(record));
  if (normalBoards.length) {
    board = normalizeBoard(normalBoards.find((record) => record.id === ROOT_ID) || normalBoards[0]);
    boardRecords.set(board.id, structuredClone(board));
  } else {
    board = {
      id: ROOT_ID,
      title: "Mon premier tableau",
      parentId: null,
      zoom: 1,
      originX: ORIGIN.x,
      originY: ORIGIN.y,
      worldWidth: INITIAL_SIZE.width,
      worldHeight: INITIAL_SIZE.height,
      viewX: ORIGIN.x,
      viewY: ORIGIN.y,
      items: [],
    };
    boardRecords.set(board.id, structuredClone(board));
    await persistRecords([board]);
  }
  const localBoards = localWorkspaceRecords(localRecords);
  const canImport = !pendingRemoteBoardIds.size && localBoards.length > 0;
  $("#import-local").dataset.available = canImport ? "true" : "false";
  clearInterval(remoteSyncTimer);
  remoteSyncTimer = setInterval(syncRemoteChanges, 15000);
}

async function syncRemoteChanges() {
  const active = document.activeElement;
  const editing = active && (canvas.contains(active) || teamPanel.contains(active))
    && (active.isContentEditable || active.matches("input,textarea,select"));
  if (!remoteSession || backupBusy || remoteSyncInFlight || remoteWritesInFlight || saveTimer || editing
      || panGesture || drawingGesture || connectionGesture || connectorResizeGesture) return;
  remoteSyncInFlight = true;
  try {
    const [boardResponse, memberResponse] = await Promise.all([
      apiRequest("boards"),
      apiRequest("members"),
    ]);
    let activeBoardChanged = false;
    for (const entry of boardResponse.boards) {
      if (pendingRemoteBoardIds.has(entry.id) || remoteVersions.get(entry.id) === entry.version) continue;
      const record = await deserializeBoard(entry.data);
      record.remoteUpdatedAt = entry.updated_at;
      remoteVersions.set(record.id, entry.version);
      boardRecords.set(record.id, structuredClone(record));
      if (isCatalogue(record)) activeBoardChanged = true;
      if (board.id === record.id) {
        board = normalizeBoard({ ...record, zoom: board.zoom, viewX: viewport.scrollLeft, viewY: viewport.scrollTop });
        activeBoardChanged = true;
      }
    }
    members = memberResponse.members.map(remoteMemberRecord);
    const self = members.find((member) => member.id === `user:${remoteSession.id}`);
    if (self) remoteSession.name = self.name;
    if (activeBoardChanged) {
      renderBoard();
      viewport.scrollLeft = board.viewX;
      viewport.scrollTop = board.viewY;
    }
    renderTeam();
    renderBoardPicker();
  } catch (error) {
    console.error("Échec de synchronisation avec l’espace partagé.", error);
    setSaveStatus("Sync. interrompue", "has-error");
  } finally {
    remoteSyncInFlight = false;
  }
}

function scheduleRemoteMemberSave(member) {
  if (!remoteSession || !member.id.startsWith("user:")) return;
  clearTimeout(member.remoteSaveTimer);
  member.remoteSaveTimer = setTimeout(async () => {
    try {
      const isOwner = remoteSession.role === "owner";
      const body = { display_name: member.name };
      if (isOwner) {
        body.tag = member.role;
        body.color = member.color;
      }
      const result = await apiRequest("member", {
        method: "PATCH",
        query: `&id=${encodeURIComponent(member.id.slice(5))}`,
        body,
      });
      const updated = remoteMemberRecord(result.member);
      Object.assign(member, updated);
      if (member.id === `user:${remoteSession.id}`) remoteSession.name = member.name;
      $("#account-summary").textContent = `${remoteSession.name} · ${remoteSession.email} · ${remoteSession.workspace}`;
      setSaveStatus("Enregistré");
    } catch (error) {
      console.error("Échec de la mise à jour du profil.", error);
      setSaveStatus("Non enregistré", "has-error");
      showToast(error.message);
    }
  }, 350);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Impossible d’ouvrir le stockage local."));
  });
}

function readAllRecords() {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Impossible de lire l’espace de travail."));
  });
}

function writeRecords(records) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    records.forEach((record) => store.put(structuredClone(record)));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Impossible d’enregistrer l’espace de travail."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Enregistrement interrompu."));
  });
}

function deleteRecord(id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Impossible de supprimer la copie locale."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Suppression interrompue."));
  });
}

function defaultMembers() {
  return [
    { id: "member-ava", name: "Ava Moreau", role: "Artiste pixel", color: "#f18f70" },
    { id: "member-eli", name: "Eli Martin", role: "Développeur", color: "#79cbb1" },
    { id: "member-noe", name: "Noé Laurent", role: "Direction créative", color: "#a9a0f0" },
  ];
}

function makeDefaultBoard() {
  const art = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16" viewBox="0 0 24 16" shape-rendering="crispEdges"><rect width="24" height="16" fill="#a8d7dc"/><path fill="#f4cf63" d="M2 2h3v2H2zm15 1h2v2h-2zM8 1h2v1H8z"/><path fill="#668c99" d="M0 7h4V5h3v2h3v2h4V7h3V5h2v2h3V6h2v5H0z"/><path fill="#76b86b" d="M0 10h5V8h3v2h4V8h3v2h3V9h3v2h3v5H0z"/><path fill="#34794f" d="M0 13h3v1h3v-2h2v4H0zm12 1h4v-2h2v4h-6zM20 12h4v4h-4z"/><path fill="#f3da87" d="M9 10h3v2H9zm-2 2h2v2H7zm5-1h2v2h-2z"/><path fill="#da7959" d="M15 5h5v2h-5zM14 7h7v1h-7z"/><path fill="#efc66c" d="M14 4h7v1h-7z"/><path fill="#3e4b40" d="M15 8h5v3h-5z"/><path fill="#5fbdce" d="M17 8h1v2h-1z"/><path fill="#e9a458" d="M14 11h2v2h-2zM21 10h1v2h-1z"/></svg>`;
  const sprite = new Blob([art], { type: "image/svg+xml" });
  return {
    id: ROOT_ID,
    title: "Pixel art — références",
    parentId: null,
    zoom: 1,
    originX: ORIGIN.x,
    originY: ORIGIN.y,
    worldWidth: INITIAL_SIZE.width,
    worldHeight: INITIAL_SIZE.height,
    viewX: ORIGIN.x,
    viewY: ORIGIN.y,
    items: [
      { id: newId(), type: "note", x: 82, y: 82, z: 1, title: "Une palette, pas une règle", body: "Limiter les teintes, garder du contraste. La silhouette doit rester lisible à sa taille réelle.", color: "sage" },
      { id: newId(), type: "image", x: 422, y: 72, z: 2, title: "Jardin miniature", fileName: "pixel-garden.svg", image: sprite, imageZoom: 1 },
      { id: newId(), type: "note", x: 808, y: 145, z: 3, title: "Notes de lumière", body: "Les ombres peuvent être une couleur à part entière. Essayer une teinte froide plutôt que du noir.", color: "ochre" },
    ],
  };
}

function normalizeBoard(record) {
  return {
    ...record,
    parentId: record.parentId ?? null,
    items: Array.isArray(record.items) ? record.items : [],
    zoom: Number.isFinite(record.zoom) ? record.zoom : 1,
    originX: Number.isFinite(record.originX) ? record.originX : ORIGIN.x,
    originY: Number.isFinite(record.originY) ? record.originY : ORIGIN.y,
    worldWidth: Math.max(record.worldWidth ?? INITIAL_SIZE.width, INITIAL_SIZE.width),
    worldHeight: Math.max(record.worldHeight ?? INITIAL_SIZE.height, INITIAL_SIZE.height),
    viewX: Number.isFinite(record.viewX) ? record.viewX : (record.originX ?? ORIGIN.x) * (record.zoom ?? 1),
    viewY: Number.isFinite(record.viewY) ? record.viewY : (record.originY ?? ORIGIN.y) * (record.zoom ?? 1),
  };
}

function snapshotState() {
  history.push(structuredClone({ boards: allStoredBoards(), members, activeBoardId: board.id }));
  if (history.length > HISTORY_LIMIT) history.shift();
  redoHistory = [];
  updateHistoryButtons();
}

function restoreHistoryState(state) {
  boardRecords = new Map(state.boards.map((record) => [record.id, normalizeBoard(record)]));
  board = normalizeBoard(boardRecords.get(state.activeBoardId) || state.boards[0]);
  boardRecords.set(board.id, structuredClone(board));
  members = state.members;
  renderBoard();
  viewport.scrollLeft = board.viewX;
  viewport.scrollTop = board.viewY;
  persistRecords([...boardRecords.values(), { id: WORKSPACE_ID, members }]).catch(reportSaveError);
}

function updateHistoryButtons() {
  $("#undo-button").disabled = history.length === 0;
  $("#redo-button").disabled = redoHistory.length === 0;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3400);
}

function setSaveStatus(text, className = "") {
  saveStatus.textContent = text;
  saveStatus.className = `save-status ${className}`.trim();
}

function scheduleSave(additionalRecords = []) {
  setSaveStatus("Enregistrement…", "is-saving");
  clearTimeout(saveTimer);
  const boardToSave = structuredClone(board);
  const membersToSave = structuredClone(members);
  const records = new Map([[boardToSave.id, boardToSave]]);
  additionalRecords.forEach((record) => records.set(record.id, structuredClone(record)));
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await persistRecords([...records.values(), { id: WORKSPACE_ID, members: membersToSave }]);
      records.forEach((record, id) => boardRecords.set(id, record));
      if (remoteSession && remoteVersions.size) $("#import-local").dataset.available = "false";
      setSaveStatus("Enregistré");
    } catch (error) {
      console.error("Échec de l’enregistrement de l’espace de travail.", error);
      setSaveStatus("Non enregistré", "has-error");
      showToast(remoteSession
        ? error.localBackupSaved
          ? `Synchronisation refusée : ${error.message}. Une copie locale est conservée.`
          : `Impossible d’enregistrer la copie locale : ${error.message}. Les changements sont encore en mémoire.`
        : "Stockage local indisponible ou plein. Exportez vos tableaux avant de fermer cette page.");
    }
  }, 300);
}

function saveImmediately() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (remoteSession) return persistRecords(allStoredBoards());
  return writeRecords([board, { id: WORKSPACE_ID, members }]);
}

function imageDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error("Impossible de préparer le média pour l’export."));
    reader.readAsDataURL(blob);
  });
}

function iconButton(label, title, action, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `card-action ${className}`.trim();
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.dataset.action = action;
  return button;
}

const NOTE_HTML_TAGS = new Set(["BR", "DIV", "P", "SPAN", "B", "STRONG", "I", "EM", "U", "UL", "OL", "LI"]);
const NOTE_FONT_STEPS = [9, 11, 13, 16, 20, 26];
const NOTE_DEFAULT_FONT_SIZE = 11;

const escapeNoteHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
}[character]));

function noteHtmlFromText(text) {
  return String(text ?? "").split("\n").map(escapeNoteHtml).join("<br>");
}

function sanitizeNoteHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html ?? "");
  const clean = (parent) => {
    for (const child of [...parent.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }
      clean(child);
      if (!NOTE_HTML_TAGS.has(child.tagName)) { child.replaceWith(...child.childNodes); continue; }
      for (const attribute of [...child.attributes]) {
        const keepStyle = child.tagName === "SPAN" && attribute.name === "style";
        if (!keepStyle) child.removeAttribute(attribute.name);
      }
      if (child.tagName === "SPAN") {
        const size = child.style.fontSize;
        child.removeAttribute("style");
        if (/^\d{1,2}(\.\d+)?px$/.test(size)) child.style.fontSize = size;
      }
    }
  };
  clean(template.content);
  return template.innerHTML;
}

function noteBodyHtml(item) {
  if (typeof item.bodyHtml === "string" && item.bodyHtml) return sanitizeNoteHtml(item.bodyHtml);
  return noteHtmlFromText(item.body);
}

function syncNoteBody(item, editor) {
  const html = sanitizeNoteHtml(editor.innerHTML);
  item.bodyHtml = html;
  item.body = editor.innerText.replace(/\r/g, "");
}

function nextFontStep(current, direction) {
  if (direction > 0) return NOTE_FONT_STEPS.find((size) => size > current + .5) ?? NOTE_FONT_STEPS.at(-1);
  return [...NOTE_FONT_STEPS].reverse().find((size) => size < current - .5) ?? NOTE_FONT_STEPS[0];
}

function wrapRangeFontSize(range, size, selection) {
  const container = range.commonAncestorContainer;
  const root = container.nodeType === Node.TEXT_NODE ? container.parentNode : container;
  if (!root) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue && range.intersectsNode(node)) textNodes.push(node);
  }
  const spans = [];
  for (const textNode of textNodes) {
    const length = textNode.nodeValue.length;
    const start = textNode === range.startContainer ? range.startOffset : 0;
    const end = textNode === range.endContainer ? range.endOffset : length;
    if (start >= end) continue;
    if (end < length) textNode.splitText(end);
    const target = start > 0 ? textNode.splitText(start) : textNode;
    const span = document.createElement("span");
    span.style.fontSize = `${size}px`;
    target.replaceWith(span);
    span.append(target);
    spans.push(span);
  }
  if (spans.length && selection) {
    const restored = document.createRange();
    const first = spans[0];
    const last = spans.at(-1);
    restored.setStart(first.firstChild ?? first, 0);
    restored.setEnd(last.firstChild ?? last, last.firstChild?.length ?? 0);
    selection.removeAllRanges();
    selection.addRange(restored);
  }
  return spans;
}

function applyNoteFontStep(editor, direction, savedRange = null) {
  if (!editor) return false;
  const card = editor.closest(".board-card");
  const item = board.items.find((candidate) => candidate.id === card?.dataset.id);
  if (!item) return false;
  const selection = window.getSelection();
  let range = savedRange;
  if (!range || !editor.contains(range.commonAncestorContainer)) {
    if (selection?.rangeCount && editor.contains(selection.anchorNode)) range = selection.getRangeAt(0).cloneRange();
    else { range = document.createRange(); range.selectNodeContents(editor); }
  }
  if (range.collapsed) range.selectNodeContents(editor);
  const anchor = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer : range.startContainer.parentElement;
  const current = parseFloat(getComputedStyle(anchor || editor).fontSize) || NOTE_DEFAULT_FONT_SIZE;
  const size = direction === 0 ? NOTE_DEFAULT_FONT_SIZE : nextFontStep(current, direction);
  snapshotState();
  wrapRangeFontSize(range, size, selection);
  syncNoteBody(item, editor);
  editor.focus({ preventScroll: true });
  scheduleSave();
  return true;
}

function selectedCards() {
  return board.items.filter((item) => selectedCardIds.has(item.id) && !["connector", "drawing"].includes(item.type));
}

function applyCardSelection() {
  canvas.querySelectorAll(".board-card").forEach((card) => {
    card.classList.toggle("is-selected", selectedCardIds.has(card.dataset.id));
  });
}

function clearCardSelection() {
  if (!selectedCardIds.size) return;
  selectedCardIds = new Set();
  applyCardSelection();
}

function focusSelectedCard(card, event = null) {
  if (!card) return;
  if (selectedVectorId) {
    selectedVectorId = null;
    renderVectorItems();
  }
  const id = card.dataset.id;
  const additive = Boolean(event && (event.ctrlKey || event.metaKey || event.shiftKey));
  if (additive) {
    if (selectedCardIds.has(id)) selectedCardIds.delete(id);
    else selectedCardIds.add(id);
  } else if (!selectedCardIds.has(id)) {
    selectedCardIds = new Set([id]);
  }
  applyCardSelection();
  if (selectedCardIds.has(id)) card.style.zIndex = String(++lastZIndex);
}

function isTextEditingTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

function itemWorldRect(item) {
  if (item.type === "drawing") {
    const points = item.points?.length ? item.points : [{ x: item.x1 ?? 0, y: item.y1 ?? 0 }];
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  if (item.type === "connector") {
    const start = cardAnchor(item.fromId, item.fromAnchor) || { x: item.x1 ?? 0, y: item.y1 ?? 0 };
    const end = cardAnchor(item.toId, item.toAnchor) || { x: item.x2 ?? 0, y: item.y2 ?? 0 };
    return {
      x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
    };
  }
  const card = canvas.querySelector(`[data-id="${CSS.escape(item.id)}"]`);
  return {
    x: item.x ?? 0, y: item.y ?? 0,
    width: Number.isFinite(item.width) ? item.width : card?.offsetWidth ?? 260,
    height: Number.isFinite(item.height) ? item.height : card?.offsetHeight ?? 180,
  };
}

function selectionBounds(items) {
  const rects = items.map(itemWorldRect);
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function deleteItems(ids, { announce = true } = {}) {
  if (!ids.size) return 0;
  const before = board.items.length;
  board.items = board.items.filter((item) => {
    if (ids.has(item.id)) return false;
    if (item.type === "connector" && (ids.has(item.fromId) || ids.has(item.toId))) return false;
    return true;
  });
  const removed = before - board.items.length;
  ids.forEach((id) => selectedCardIds.delete(id));
  if (selectedVectorId && ids.has(selectedVectorId)) selectedVectorId = null;
  renderBoard();
  scheduleSave();
  if (announce && removed) showToast(`${removed} élément${removed > 1 ? "s" : ""} supprimé${removed > 1 ? "s" : ""}.`);
  return removed;
}

function deleteSelection() {
  const ids = new Set(selectedCardIds);
  if (selectedVectorId) ids.add(selectedVectorId);
  if (!ids.size) return false;
  snapshotState();
  return deleteItems(ids) > 0;
}

function copySelection({ cut = false, silent = false } = {}) {
  const cards = selectedCards();
  const vector = board.items.find((item) => item.id === selectedVectorId && ["connector", "drawing"].includes(item.type));
  if (!cards.length && !vector) return false;
  const copied = [...cards];
  if (!vector && cards.length) {
    const ids = new Set(cards.map((item) => item.id));
    board.items
      .filter((item) => item.type === "connector" && ids.has(item.fromId) && ids.has(item.toId))
      .forEach((item) => copied.push(item));
  }
  if (vector) copied.push(vector);
  cardClipboard = {
    items: structuredClone(copied),
    fromBoardId: board.id,
  };
  pasteCount = 0;
  if (cut) {
    snapshotState();
    const ids = new Set(copied.map((item) => item.id));
    deleteItems(ids, { announce: false });
  }
  if (!silent) {
    const count = copied.length;
    showToast(`${count} élément${count > 1 ? "s" : ""} ${cut ? "coupé" : "copié"}${count > 1 ? "s" : ""}.${cut ? "" : " Collez avec Ctrl+V."}`);
  }
  return true;
}

function cloneBoardSubtree(sourceId, copies, parentId) {
  const source = sourceId === board.id ? board : boardRecords.get(sourceId);
  if (!source) return null;
  if (copies.has(sourceId)) return copies.get(sourceId);
  const copy = structuredClone(normalizeBoard(source));
  copy.id = newId();
  copy.parentId = parentId;
  copy.title = `${copy.title || "Tableau"} (copie)`;
  copies.set(sourceId, copy);
  copy.items = copy.items.map((item) => {
    const clone = structuredClone(item);
    clone.id = newId();
    if (clone.type === "board" && clone.boardId) {
      const nested = cloneBoardSubtree(clone.boardId, copies, copy.id);
      if (nested) clone.boardId = nested.id;
    }
    if (clone.type === "todo" && Array.isArray(clone.entries)) {
      clone.entries.forEach((entry) => { if (entry.id) entry.id = newId(); });
    }
    return clone;
  });
  return copy;
}

function pasteClipboard() {
  if (!cardClipboard?.items.length) return false;
  snapshotState();
  pasteCount += 1;
  const copies = new Map();
  const idMap = new Map();
  const items = structuredClone(cardClipboard.items);
  items.forEach((item) => idMap.set(item.id, newId()));
  for (const item of items) {
    if (item.type === "board" && item.boardId) {
      const copiedBoard = cloneBoardSubtree(item.boardId, copies, board.id);
      if (copiedBoard) item.boardId = copiedBoard.id;
    }
    if (item.type === "todo" && Array.isArray(item.entries)) {
      item.entries.forEach((entry) => { entry.id = newId(); });
    }
  }
  const bounds = selectionBounds(items);
  const center = viewportCenter();
  const step = 26 * pasteCount;
  const dx = Math.round(center.x - (bounds.x + bounds.width / 2) + step);
  const dy = Math.round(center.y - (bounds.y + bounds.height / 2) + step);
  const pasted = [];
  for (const item of items) {
    item.id = idMap.get(item.id);
    item.z = ++lastZIndex;
    if (item.type === "connector") {
      item.fromId = idMap.get(item.fromId) ?? item.fromId;
      item.toId = idMap.get(item.toId) ?? item.toId;
      item.x1 = (item.x1 ?? 0) + dx;
      item.y1 = (item.y1 ?? 0) + dy;
      item.x2 = (item.x2 ?? 0) + dx;
      item.y2 = (item.y2 ?? 0) + dy;
    } else if (item.type === "drawing") {
      item.points = (item.points || []).map((point) => ({ x: point.x + dx, y: point.y + dy }));
    } else {
      item.x = (item.x ?? 0) + dx;
      item.y = (item.y ?? 0) + dy;
    }
    pasted.push(item);
  }
  board.items.push(...pasted);
  selectedCardIds = new Set(pasted.filter((item) => !["connector", "drawing"].includes(item.type)).map((item) => item.id));
  selectedVectorId = null;
  copies.forEach((record) => boardRecords.set(record.id, record));
  renderBoard();
  scheduleSave([...copies.values()]);
  const count = pasted.length;
  showToast(`${count} élément${count > 1 ? "s" : ""} collé${count > 1 ? "s" : ""}.`);
  return true;
}

function duplicateSelection() {
  if (!copySelection({ silent: true })) return false;
  return pasteClipboard();
}

let cardMenuContext = null;

function noteEditorForCard(card) {
  return card?.querySelector(".note-body[contenteditable='true']") ?? null;
}

function savedTextRange(editor) {
  if (!editor) return null;
  const selection = window.getSelection();
  if (selection?.rangeCount && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)) {
    return selection.getRangeAt(0).cloneRange();
  }
  return null;
}

function openCardMenu(clientX, clientY, card) {
  const menu = $("#card-menu");
  if (!menu) return;
  const noteEditor = noteEditorForCard(card);
  cardMenuContext = { card, noteEditor, range: savedTextRange(noteEditor) };
  menu.querySelector('[data-menu-action="copy"]').disabled = !selectedCardIds.size && !selectedVectorId;
  menu.querySelector('[data-menu-action="cut"]').disabled = !selectedCardIds.size && !selectedVectorId;
  menu.querySelector('[data-menu-action="duplicate"]').disabled = !selectedCardIds.size && !selectedVectorId;
  menu.querySelector('[data-menu-action="delete"]').disabled = !selectedCardIds.size && !selectedVectorId;
  menu.querySelector('[data-menu-action="paste"]').disabled = !cardClipboard?.items.length;
  menu.querySelectorAll("[data-font-step]").forEach((button) => { button.disabled = !noteEditor; });
  const count = selectedCardIds.size;
  const summary = selectedVectorId ? "Connecteur ou dessin sélectionné"
    : count > 1 ? `${count} cartes sélectionnées`
    : count === 1 ? "1 carte sélectionnée"
    : "Aucune carte sélectionnée";
  menu.querySelector(".card-menu-summary").textContent = summary;
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8))}px`;
  menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
}

function closeCardMenu() {
  const menu = $("#card-menu");
  if (menu) menu.hidden = true;
  cardMenuContext = null;
}

function addDeleteControl(actions) {
  actions.append(iconButton("×", "Supprimer cet élément", "delete", "delete"));
}

function buildCard(item) {
  const card = document.createElement("article");
  card.className = `board-card ${item.type}-card ${item.type === "note" ? `note-${safeColor(item.color)}` : ""}`;
  if (selectedCardIds.has(item.id)) card.classList.add("is-selected");
  card.dataset.id = item.id;
  card.style.left = `${item.x}px`;
  card.style.top = `${item.y}px`;
  card.style.zIndex = String(item.z ?? 1);
  if (Number.isFinite(item.width)) card.style.width = `${item.width}px`;
  if (Number.isFinite(item.height)) card.style.height = `${item.height}px`;
  if (item.type === "connector" || item.type === "drawing") return card;

  const grip = document.createElement("div");
  grip.className = "card-grip";
  grip.dataset.dragHandle = "";
  grip.tabIndex = 0;
  grip.setAttribute("role", "button");
  grip.setAttribute("aria-label", `Déplacer ${cardDescription(item)}`);
  grip.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown ArrowLeft ArrowRight");

  const labels = { note: "Note", image: "Image", audio: "Son / musique", link: "Lien", board: "Tableau", "item-ref": "Item Unity", todo: Array.isArray(item.entries) ? "Liste" : "Tâche" };
  const label = document.createElement("span");
  label.className = "grip-label";
  label.innerHTML = `<span class="grip-symbol" aria-hidden="true">⠿</span><span>${labels[item.type] ?? "Carte"}</span>`;
  const actions = document.createElement("div");
  actions.className = "card-actions";
  if (item.type === "image") {
    actions.append(
      iconButton("−", "Réduire le zoom de l’image", "zoom-out"),
      iconButton("+", "Agrandir le zoom de l’image", "zoom-in"),
      iconButton("⤢", "Ajuster l’image entière dans la carte", "fit-image"),
      iconButton("⟲", "Tourner l’image de 90° vers la gauche", "rotate-left"),
      iconButton("⟳", "Tourner l’image de 90° vers la droite", "rotate-right"),
    );
    const color = document.createElement("input");
    color.type = "color";
    color.className = "frame-color-picker";
    color.value = safeHexColor(item.frameColor, "#d3ded0");
    color.title = "Couleur de la marge de l’image";
    color.setAttribute("aria-label", "Couleur de la marge de l’image");
    color.addEventListener("focus", snapshotState, { once: true });
    color.addEventListener("input", () => {
      item.frameColor = color.value;
      const plate = card.querySelector(".image-plate");
      plate.style.backgroundColor = color.value;
      plate.style.borderColor = color.value;
      scheduleSave();
    });
    actions.append(color);
  }
  if (item.type === "board") {
    actions.append(iconButton("▧", "Choisir l’image d’aperçu", "choose-cover"));
    if (item.coverImage instanceof Blob) actions.append(iconButton("−", "Retirer l’image d’aperçu", "remove-cover"));
    actions.append(iconButton("↗", "Ouvrir ce tableau", "open-board"));
  }
  addDeleteControl(actions);
  grip.append(label, actions);
  card.append(grip);

  if (item.type === "image") renderImageCard(card, item);
  else if (item.type === "audio") renderAudioCard(card, item);
  else if (item.type === "note") renderNoteCard(card, item);
  else if (item.type === "link") renderLinkCard(card, item);
  else if (item.type === "board") renderNestedBoard(card, item);
  else if (item.type === "todo") renderTodoCard(card, item);
  else if (item.type === "item-ref") renderItemReference(card, item);
  for (const corner of ["nw", "ne", "sw", "se"]) {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = `card-resize card-resize-${corner}`;
    handle.setAttribute("aria-label", `Redimensionner la carte (${corner}). Flèches pour ajuster.`);
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      snapshotState();
      const start = { x: event.clientX, y: event.clientY, width: card.offsetWidth, height: card.offsetHeight, left: item.x, top: item.y };
      handle.setPointerCapture(event.pointerId);
      const move = (e) => {
        const dx = (e.clientX - start.x) / board.zoom;
        const dy = (e.clientY - start.y) / board.zoom;
        item.width = Math.max(180, start.width + (corner.includes("w") ? -dx : dx));
        item.height = Math.max(140, start.height + (corner.includes("n") ? -dy : dy));
        item.x = corner.includes("w") ? start.left + start.width - item.width : start.left;
        item.y = corner.includes("n") ? start.top + start.height - item.height : start.top;
        Object.assign(card.style, { width: `${item.width}px`, height: `${item.height}px`, left: `${item.x}px`, top: `${item.y}px` });
        if (item.type === "image") applyImageTransform(card.querySelector(".image-plate"), item);
        renderVectorItems();
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        scheduleSave();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });
    handle.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      snapshotState();
      item.width = Math.max(180, card.offsetWidth + (event.key === "ArrowRight" ? 10 : event.key === "ArrowLeft" ? -10 : 0));
      item.height = Math.max(140, card.offsetHeight + (event.key === "ArrowDown" ? 10 : event.key === "ArrowUp" ? -10 : 0));
      card.style.width = `${item.width}px`;
      card.style.height = `${item.height}px`;
      if (item.type === "image") applyImageTransform(card.querySelector(".image-plate"), item);
      renderVectorItems();
      scheduleSave();
    });
    card.append(handle);
  }

  card.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button, input, textarea, select, [contenteditable='true']")) focusSelectedCard(card);
    else focusSelectedCard(card, event);
  });
  grip.addEventListener("keydown", (event) => moveCardByKeyboard(event, card, item));
  return card;
}

function cardDescription(item) {
  const descriptions = { image: "l’image", audio: "le son", note: "la note", link: "le lien", board: "le tableau", todo: "la tâche" };
  return `${descriptions[item.type] ?? "la carte"} ${item.title || "sans titre"}`;
}

function renderAudioCard(card, item) {
  const content = document.createElement("div");
  content.className = "audio-content";
  const title = createGripContent(item, "du son", content, "title");
  const player = document.createElement("audio");
  player.controls = true;
  player.preload = "metadata";
  player.setAttribute("aria-label", `Écouter ${item.title || item.fileName || "le son"}`);
  const status = document.createElement("p");
  status.className = "audio-status";
  status.setAttribute("role", "status");
  status.textContent = item.fileName || "Son enregistré";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Réessayer la lecture";
  retry.hidden = true;
  retry.addEventListener("click", () => { retry.hidden = true; status.textContent = "Chargement du son…"; player.load(); });
  player.addEventListener("error", () => {
    status.textContent = "Lecture impossible : fichier endommagé ou codec non pris en charge par ce navigateur. Réessayez ou ajoutez un MP3/WAV compatible.";
    retry.hidden = false;
  });
  player.addEventListener("loadedmetadata", () => { status.textContent = item.fileName || "Son enregistré"; retry.hidden = true; });
  title.addEventListener("input", () => player.setAttribute("aria-label", `Écouter ${item.title || "le son"}`));
  for (const control of [player, retry]) {
    control.addEventListener("pointerdown", (event) => event.stopPropagation());
    control.addEventListener("keydown", (event) => event.stopPropagation());
  }
  if (item.audio instanceof Blob) player.src = URL.createObjectURL(item.audio);
  else {
    status.textContent = "Son indisponible dans cette copie. Rechargez la copie sauvegardée ou ajoutez de nouveau le fichier.";
  }
  content.append(player, status, retry);
  card.append(content);
}

function safeColor(value) {
  return ["sage", "ochre", "rose", "blue"].includes(value) ? value : "sage";
}

function safeHexColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(value || "") ? value : fallback;
}

function createGripContent(item, type, content, field, maxLength = 100) {
  const input = document.createElement("input");
  input.value = item[field] || "";
  input.maxLength = maxLength;
  input.placeholder = `Titre ${type}`;
  input.setAttribute("aria-label", `Titre ${type}`);
  input.addEventListener("focus", snapshotState, { once: true });
  input.addEventListener("input", () => {
    item[field] = input.value;
    scheduleSave();
  });
  content.append(input);
  return input;
}

function renderImageCard(card, item) {
  const plate = document.createElement("div");
  plate.className = "image-plate";
  plate.tabIndex = 0;
  plate.setAttribute("role", "group");
  plate.setAttribute("aria-label", "Image. Boutons ⟲ et ⟳ pour tourner par pas de 90°, ⤢ pour ajuster l’image entière. Après zoom, faites glisser l’image ou utilisez les flèches du clavier pour la déplacer.");
  const frameColor = safeHexColor(item.frameColor, "#d3ded0");
  plate.style.backgroundColor = frameColor;
  plate.style.borderColor = frameColor;
  const image = document.createElement("img");
  image.alt = item.title || "Image de référence";
  image.draggable = false;
  image.src = URL.createObjectURL(item.image);
  image.addEventListener("load", () => applyImageTransform(plate, item));
  plate.append(image);
  applyImageTransform(plate, item);
  plate.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target !== image || activeTool !== "select" || spacePressed || (item.imageZoom ?? 1) <= 1) return;
    event.preventDefault();
    event.stopPropagation();
    snapshotState();
    const metrics = imageElementMetrics(plate);
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = item.imagePanX ?? 0;
    const originY = item.imagePanY ?? 0;
    const screenWidth = Math.max(1, metrics.elementWidth * board.zoom);
    const screenHeight = Math.max(1, metrics.elementHeight * board.zoom);
    plate.setPointerCapture(event.pointerId);
    plate.classList.add("is-panning");
    const move = (moveEvent) => {
      const limits = imagePanLimits(plate, item) ?? { x: 0, y: 0 };
      item.imagePanX = Math.max(-limits.x, Math.min(limits.x, originX + (moveEvent.clientX - startX) / screenWidth));
      item.imagePanY = Math.max(-limits.y, Math.min(limits.y, originY + (moveEvent.clientY - startY) / screenHeight));
      applyImageTransform(plate, item);
    };
    const stop = () => {
      plate.classList.remove("is-panning");
      plate.removeEventListener("pointermove", move);
      plate.removeEventListener("pointerup", stop);
      plate.removeEventListener("pointercancel", stop);
      scheduleSave();
    };
    plate.addEventListener("pointermove", move);
    plate.addEventListener("pointerup", stop, { once: true });
    plate.addEventListener("pointercancel", stop, { once: true });
  });
  plate.addEventListener("keydown", (event) => {
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (!direction || (item.imageZoom ?? 1) <= 1) return;
    event.preventDefault();
    event.stopPropagation();
    snapshotState();
    const step = event.shiftKey ? .08 : .025;
    const limits = imagePanLimits(plate, item) ?? { x: 0, y: 0 };
    item.imagePanX = Math.max(-limits.x, Math.min(limits.x, (item.imagePanX ?? 0) + direction[0] * step));
    item.imagePanY = Math.max(-limits.y, Math.min(limits.y, (item.imagePanY ?? 0) + direction[1] * step));
    applyImageTransform(plate, item);
    scheduleSave();
  });
  const caption = document.createElement("div");
  caption.className = "image-caption";
  const title = createGripContent(item, "l’image", caption, "title");
  title.addEventListener("input", () => { image.alt = item.title || "Image de référence"; });
  const filename = document.createElement("small");
  filename.textContent = item.fileName || "Image";
  caption.append(filename);
  card.append(plate, caption);
  image.addEventListener("error", () => {
    plate.textContent = "Cette image ne peut pas être affichée.";
    plate.classList.add("image-error");
  }, { once: true });
}

function normalizedImageRotation(value) {
  return ((Math.round((Number(value) || 0) / 90) * 90) % 360 + 360) % 360;
}

function imageElementMetrics(plate) {
  const quarterTurn = ["90", "270"].includes(plate.dataset.rotation);
  const plateWidth = plate.clientWidth;
  const plateHeight = plate.clientHeight;
  return {
    plateWidth,
    plateHeight,
    quarterTurn,
    elementWidth: quarterTurn ? plateHeight : plateWidth,
    elementHeight: quarterTurn ? plateWidth : plateHeight,
  };
}

function imagePanLimits(plate, item) {
  if (!plate) return null;
  const image = $("img", plate);
  const { plateWidth, plateHeight, quarterTurn, elementWidth, elementHeight } = imageElementMetrics(plate);
  if (!image?.naturalWidth || !image.naturalHeight || !plateWidth || !plateHeight || !elementWidth || !elementHeight) return null;
  const zoom = Math.max(1, item.imageZoom ?? 1);
  const fit = Math.min(elementWidth / image.naturalWidth, elementHeight / image.naturalHeight);
  const contentWidth = image.naturalWidth * fit;
  const contentHeight = image.naturalHeight * fit;
  const visibleWidth = (quarterTurn ? contentHeight : contentWidth) * zoom;
  const visibleHeight = (quarterTurn ? contentWidth : contentHeight) * zoom;
  return {
    x: Math.max(0, visibleWidth - plateWidth) / (2 * elementWidth),
    y: Math.max(0, visibleHeight - plateHeight) / (2 * elementHeight),
  };
}

function clampImagePan(item, plate) {
  const limits = imagePanLimits(plate, item);
  if (!limits) return null;
  item.imagePanX = Math.max(-limits.x, Math.min(limits.x, item.imagePanX ?? 0));
  item.imagePanY = Math.max(-limits.y, Math.min(limits.y, item.imagePanY ?? 0));
  return limits;
}

function applyImageTransform(plate, item) {
  if (!plate) return;
  const image = $("img", plate);
  const zoom = item.imageZoom ?? 1;
  const rotation = normalizedImageRotation(item.imageRotation);
  plate.dataset.rotation = String(rotation);
  const limits = clampImagePan(item, plate);
  plate.classList.toggle("is-pannable", limits ? limits.x > 0 || limits.y > 0 : zoom > 1);
  image?.style.setProperty("--image-zoom", String(zoom));
  image?.style.setProperty("--image-pan-x", `${(item.imagePanX ?? 0) * 100}%`);
  image?.style.setProperty("--image-pan-y", `${(item.imagePanY ?? 0) * 100}%`);
  image?.style.setProperty("--image-rotation", `${rotation}deg`);
}

function renderNoteCard(card, item) {
  const content = document.createElement("div");
  content.className = "note-content";
  const title = document.createElement("input");
  title.className = "note-title";
  title.value = item.title || "";
  title.placeholder = "Titre de la note";
  title.setAttribute("aria-label", "Titre de la note");
  title.maxLength = 100;
  const body = document.createElement("div");
  body.className = "note-body";
  body.contentEditable = "true";
  body.spellcheck = true;
  body.dataset.placeholder = "Écrivez votre idée…";
  body.setAttribute("role", "textbox");
  body.setAttribute("aria-multiline", "true");
  body.setAttribute("aria-label", "Contenu de la note. Sélectionnez du texte puis utilisez Ctrl+Maj+. ou Ctrl+Maj+, pour changer sa taille.");
  body.innerHTML = noteBodyHtml(item);
  const mark = document.createElement("div");
  mark.className = `note-color-mark ${safeColor(item.color)}`;
  title.addEventListener("focus", snapshotState, { once: true });
  title.addEventListener("input", () => { item.title = title.value; scheduleSave(); });
  body.addEventListener("focus", snapshotState, { once: true });
  body.addEventListener("input", () => {
    if (!body.textContent && body.innerHTML === "<br>") body.innerHTML = "";
    syncNoteBody(item, body);
    scheduleSave();
  });
  body.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (text == null) return;
    event.preventDefault();
    document.execCommand("insertText", false, text);
    syncNoteBody(item, body);
    scheduleSave();
  });
  body.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
    if (event.code === "Period" || event.key === ">" || event.key === ".") {
      event.preventDefault();
      applyNoteFontStep(body, 1);
    } else if (event.code === "Comma" || event.key === "<" || event.key === ",") {
      event.preventDefault();
      applyNoteFontStep(body, -1);
    }
  });
  content.append(title, body, mark);
  card.append(content);
}

function renderLinkCard(card, item) {
  const content = document.createElement("div");
  content.className = "link-content";
  const title = document.createElement("input");
  title.className = "note-title";
  title.value = item.title || "";
  title.placeholder = "Titre du lien";
  title.setAttribute("aria-label", "Titre du lien");
  title.addEventListener("focus", snapshotState, { once: true });
  title.addEventListener("input", () => { item.title = title.value; scheduleSave(); });
  const url = document.createElement("input");
  url.className = "link-url";
  url.type = "url";
  url.value = item.url || "";
  url.placeholder = "https://…";
  url.setAttribute("aria-label", "Adresse web");
  const anchor = document.createElement("a");
  anchor.className = "link-open";
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = "Ouvrir le lien ↗";
  const updateLink = () => {
    item.url = url.value.trim();
    try {
      const parsed = new URL(item.url);
      anchor.href = ["https:", "http:"].includes(parsed.protocol) ? parsed.href : "#";
      anchor.setAttribute("aria-disabled", anchor.href === "#" ? "true" : "false");
    } catch {
      anchor.href = "#";
      anchor.setAttribute("aria-disabled", "true");
    }
    scheduleSave();
  };
  url.addEventListener("focus", snapshotState, { once: true });
  url.addEventListener("input", updateLink);
  anchor.addEventListener("click", (event) => {
    if (anchor.getAttribute("aria-disabled") === "true") event.preventDefault();
  });
  updateLink();
  content.append(title, url, anchor);
  card.append(content);
}

function renderNestedBoard(card, item) {
  const preview = document.createElement("div");
  preview.className = "nested-board-preview";
  const art = document.createElement("div");
  art.className = "nested-board-art";
  if (item.coverImage instanceof Blob) {
    const image = document.createElement("img");
    image.src = URL.createObjectURL(item.coverImage);
    image.alt = item.coverImageName ? `Aperçu : ${item.coverImageName}` : "Image d’aperçu du tableau";
    art.append(image);
  } else {
    const miniBoard = document.createElement("span");
    miniBoard.className = "mini-board";
    miniBoard.setAttribute("aria-hidden", "true");
    miniBoard.innerHTML = "<i></i><i></i><i></i>";
    art.append(miniBoard);
  }
  const title = document.createElement("input");
  title.className = "nested-board-title";
  title.value = item.title || "Tableau sans titre";
  title.maxLength = 80;
  title.setAttribute("aria-label", "Nom du tableau imbriqué");
  title.addEventListener("focus", snapshotState, { once: true });
  title.addEventListener("input", () => {
    item.title = title.value;
    const child = boardRecords.get(item.boardId);
    if (child) {
      child.title = title.value;
      boardRecords.set(child.id, structuredClone(child));
      scheduleSave([child]);
    } else scheduleSave();
  });
  const open = document.createElement("button");
  open.type = "button";
  open.className = "nested-board-open";
  open.dataset.action = "open-board";
  open.textContent = "Ouvrir le tableau ↗";
  const coverInput = document.createElement("input");
  coverInput.className = "nested-board-cover-input";
  coverInput.type = "file";
  coverInput.accept = [...MIME_TYPES].join(",");
  coverInput.hidden = true;
  coverInput.setAttribute("aria-label", "Choisir une image d’aperçu");
  coverInput.addEventListener("change", () => {
    const file = coverInput.files?.[0];
    if (!file) return;
    if (!MIME_TYPES.has(file.type) || file.size > 15 * 1024 * 1024) {
      showToast(file.size > 15 * 1024 * 1024 ? "Chaque image doit faire moins de 15 Mo." : "Choisissez une image PNG, JPG, WEBP ou GIF.");
      coverInput.value = "";
      return;
    }
    snapshotState();
    item.coverImage = file;
    item.coverImageName = file.name;
    renderBoard();
    scheduleSave();
  });
  preview.append(art, title, open);
  card.append(preview, coverInput);
}

function getMember(memberId) {
  return members.find((member) => member.id === memberId);
}

function renderTodoCard(card, item) {
  if (Array.isArray(item.entries)) {
    renderChecklistCard(card, item);
    return;
  }
  const content = document.createElement("div");
  content.className = "todo-content";
  const checkbox = document.createElement("button");
  checkbox.type = "button";
  checkbox.className = `todo-check ${item.status === "done" ? "is-done" : ""}`;
  checkbox.setAttribute("aria-label", item.status === "done" ? "Marquer à faire" : "Marquer terminée");
  checkbox.textContent = item.status === "done" ? "✓" : "";
  checkbox.addEventListener("click", () => {
    snapshotState();
    item.status = item.status === "done" ? "todo" : "done";
    renderBoard();
    scheduleSave();
  });
  const title = document.createElement("textarea");
  title.className = `todo-title ${item.status === "done" ? "is-done" : ""}`;
  title.rows = 2;
  title.placeholder = "Une tâche…";
  title.value = item.title || "";
  title.maxLength = 120;
  title.setAttribute("aria-label", "Description de la tâche");
  title.addEventListener("focus", snapshotState, { once: true });
  title.addEventListener("input", () => { item.title = title.value; scheduleSave(); });
  const details = document.createElement("div");
  details.className = "todo-meta checklist-tags";
  const status = document.createElement("select");
  status.className = `task-tag task-tag-status status-${item.status || "todo"}`;
  status.setAttribute("aria-label", "État de la tâche");
  [["todo", "À faire"], ["doing", "En cours"], ["done", "Terminée"]].forEach(([value, text]) => {
    const option = new Option(text, value, false, value === (item.status || "todo"));
    status.add(option);
  });
  status.addEventListener("change", () => {
    snapshotState();
    item.status = status.value;
    renderBoard();
    scheduleSave();
  });
  const assignee = document.createElement("select");
  assignee.className = "task-tag task-tag-assignee";
  assignee.setAttribute("aria-label", "Membre assigné");
  assignee.add(new Option("＋ Responsable", "", false, !item.assigneeId));
  members.forEach((member) => assignee.add(new Option(member.name, member.id, false, member.id === item.assigneeId)));
  assignee.addEventListener("change", () => {
    snapshotState();
    item.assigneeId = assignee.value || null;
    renderBoard();
    scheduleSave();
  });
  const responsible = getMember(item.assigneeId);
  if (responsible) assignee.style.setProperty("--member-color", responsible.color);
  details.append(assignee, status);
  content.append(checkbox, title, details);
  card.append(content);
}

function addItemReference(projectId, itemId, position = viewportCenter()) {
  const record = boardRecords.get(catalogueId(projectId));
  const definition = record?.definitions.find((item) => item.id === itemId);
  if (!remoteSession || !definition || definition.archived) throw new Error("Item absent ou archivé. Rechargez le catalogue.");
  snapshotState();
  board.items.push({ id: newId(), type: "item-ref", projectId, itemId, x: position.x, y: position.y, z: ++lastZIndex });
  renderBoard();
  scheduleSave();
}

function renderItemReference(card, item) {
  const definition = boardRecords.get(catalogueId(item.projectId))?.definitions.find((entry) => entry.id === item.itemId);
  const content = document.createElement("div");
  content.className = "item-ref-content";
  const name = document.createElement("strong");
  name.textContent = definition?.name || "Référence item introuvable";
  const inspect = document.createElement("button");
  inspect.type = "button";
  inspect.className = "item-reference-inspect";
  inspect.setAttribute("aria-label", `Inspecter ${definition?.name || "cet item"} dans le catalogue Unity`);
  inspect.addEventListener("click", () => itemsUI?.openItem(item.projectId, item.itemId));
  const detail = document.createElement("small");
  const syncLabel = definition?.archived ? "Archivé" : !definition?.unity ? "À créer dans Unity"
    : JSON.stringify(definition.values) === JSON.stringify(definition.lastUnityValues) ? "Dernière liaison confirmée" : "Modifié ici";
  detail.textContent = definition ? `${definition.type} · ${syncLabel}`
    : "Catalogue non chargé ou fiche absente. Aucun asset n’a été supprimé.";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "small-action";
  open.textContent = "Ouvrir la fiche centrale";
  open.addEventListener("click", () => itemsUI?.openItem(item.projectId, item.itemId));
  const source = itemThumbnail(definition);
  if (source) {
    const image = document.createElement("img");
    image.src = source; image.alt = ""; image.className = "item-thumbnail";
    inspect.append(image);
  } else {
    const empty = document.createElement("span");
    empty.className = "item-thumbnail-empty";
    empty.textContent = "Sans image";
    inspect.append(empty);
  }
  inspect.append(name);
  content.append(inspect, detail, open);
  card.append(content);
}

function prepareChecklist(item) {
  item.entries.forEach((entry) => {
    entry.id ||= newId();
    entry.status ||= entry.done ? "done" : "todo";
    if (entry.assigneeId === undefined) entry.assigneeId = item.assigneeId || null;
  });
}

function renderChecklistCard(card, item) {
    prepareChecklist(item);
    card.classList.add("checklist-card");
    const content = document.createElement("div");
    content.className = "checklist-content";
    const title = document.createElement("textarea");
    title.rows = 2;
    title.className = "checklist-title";
    title.value = item.title || "";
    title.placeholder = "Titre (facultatif)";
    title.maxLength = 120;
    title.setAttribute("aria-label", "Titre de la liste (facultatif)");
    title.addEventListener("focus", snapshotState, { once: true });
    title.addEventListener("input", () => { item.title = title.value; scheduleSave(); });
    const list = document.createElement("div");
    list.className = "checklist-entries";
    item.entries.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "checklist-row";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = entry.status === "done";
      check.setAttribute("aria-label", `Terminer ${entry.text || "cette tâche"}`);
      check.addEventListener("change", () => {
        snapshotState();
        entry.status = check.checked ? "done" : "todo";
        updateChecklistStatus(item);
        renderBoard();
        scheduleSave();
      });
      const text = document.createElement("textarea");
      text.rows = 2;
      text.className = `todo-title ${entry.status === "done" ? "is-done" : ""}`;
      text.value = entry.text;
      text.maxLength = 120;
      text.placeholder = "Une tâche…";
      text.setAttribute("aria-label", "Description de la tâche de liste");
      text.addEventListener("focus", snapshotState, { once: true });
      text.addEventListener("input", () => {
        entry.text = text.value;
        check.setAttribute("aria-label", `Terminer ${entry.text || "cette tâche"}`);
        scheduleSave();
      });
      const tags = document.createElement("div");
      tags.className = "checklist-tags";
      const assignee = document.createElement("select");
      assignee.className = "task-tag task-tag-assignee";
      assignee.setAttribute("aria-label", `Responsable de ${entry.text || "cette tâche"}`);
      assignee.add(new Option("＋ Responsable", "", false, !entry.assigneeId));
      members.forEach((member) => assignee.add(new Option(member.name, member.id, false, member.id === entry.assigneeId)));
      const responsible = getMember(entry.assigneeId);
      if (responsible) assignee.style.setProperty("--member-color", responsible.color);
      assignee.addEventListener("change", () => {
        snapshotState();
        entry.assigneeId = assignee.value || null;
        renderBoard();
        scheduleSave();
      });
      const status = document.createElement("select");
      status.className = `task-tag task-tag-status status-${entry.status}`;
      status.setAttribute("aria-label", `État de ${entry.text || "cette tâche"}`);
      [["todo", "À faire"], ["doing", "En cours"], ["done", "Terminée"]].forEach(([value, label]) => {
        status.add(new Option(label, value, false, entry.status === value));
      });
      status.addEventListener("change", () => {
        snapshotState();
        entry.status = status.value;
        updateChecklistStatus(item);
        renderBoard();
        scheduleSave();
      });
      tags.append(assignee, status);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "checklist-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Supprimer cette tâche de la liste");
      remove.addEventListener("click", () => {
        snapshotState();
        item.entries = item.entries.filter((candidate) => candidate !== entry);
        updateChecklistStatus(item);
        renderBoard();
        scheduleSave();
      });
      row.append(check, text, remove, tags);
      list.append(row);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "checklist-add";
    add.textContent = "＋ Ajouter une tâche";
    add.addEventListener("click", () => {
      snapshotState();
      item.entries.push({ id: newId(), text: "", status: "todo", assigneeId: null });
      updateChecklistStatus(item);
      renderBoard();
      scheduleSave();
      canvas.querySelector(`[data-id="${CSS.escape(item.id)}"] .checklist-row:last-child .todo-title`)?.focus();
    });
    content.append(title, list, add);
    card.append(content);
}

function updateChecklistStatus(item) {
  item.entries.forEach((entry) => { entry.done = entry.status === "done"; });
  item.status = item.entries.length && item.entries.every((entry) => entry.status === "done")
    ? "done" : item.entries.some((entry) => entry.status === "done" || entry.status === "doing") ? "doing" : "todo";
}

function renderVectorItems() {
  connectorLayer.setAttribute("width", board.worldWidth);
  connectorLayer.setAttribute("height", board.worldHeight);
  connectorLayer.innerHTML = "";
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.id = "pixelboard-arrowhead";
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "5");
  marker.setAttribute("markerHeight", "5");
  marker.setAttribute("orient", "auto-start-reverse");
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  arrow.setAttribute("fill", "context-stroke");
  marker.append(arrow);
  defs.append(marker);
  connectorLayer.append(defs);
  board.items.filter((item) => item.type === "connector" || item.type === "drawing").forEach((item) => {
    if (item.type === "connector") {
      const endpoints = connectorEndpoints(item);
      const hitArea = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const d = connectorPath(endpoints, item.curve || 0);
      hitArea.setAttribute("d", d);
      prepareVectorSelection(hitArea, item, "Connecteur");
      connectorLayer.append(hitArea);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      line.setAttribute("d", d);
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", item.color || "#000000");
      line.setAttribute("stroke-width", "2");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("marker-end", "url(#pixelboard-arrowhead)");
      line.dataset.id = item.id;
      line.classList.add("canvas-vector");
      line.classList.toggle("is-selected", item.id === selectedVectorId);
      connectorLayer.append(line);
      if (item.id === selectedVectorId && item.fromId && item.toId) {
        appendConnectorHandle(item, "from", endpoints.start);
        appendConnectorHandle(item, "to", endpoints.end);
      }
    } else {
      const hitArea = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      hitArea.setAttribute("points", (item.points || []).map((point) => `${point.x},${point.y}`).join(" "));
      prepareVectorSelection(hitArea, item, "Dessin");
      connectorLayer.append(hitArea);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      path.setAttribute("points", (item.points || []).map((point) => `${point.x},${point.y}`).join(" "));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", item.color || "#d7f36a");
      path.setAttribute("stroke-width", "5");
      path.setAttribute("stroke-linecap", "square");
      path.setAttribute("stroke-linejoin", "miter");
      path.dataset.id = item.id;
      path.classList.add("canvas-vector");
      path.classList.toggle("is-selected", item.id === selectedVectorId);
      connectorLayer.append(path);
    }
  });
  if (connectionGesture) drawTemporaryVector();
  updateVectorDeleteButton();
}

function appendConnectorHandle(item, endpoint, point) {
  const handle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  handle.classList.add("connector-anchor-handle");
  handle.setAttribute("cx", String(point.x));
  handle.setAttribute("cy", String(point.y));
  handle.setAttribute("r", String(22 / board.zoom));
  handle.setAttribute("tabindex", "0");
  handle.setAttribute("role", "button");
  handle.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown ArrowLeft ArrowRight");
  handle.setAttribute("aria-label", `${endpoint === "from" ? "Début" : "Fin"} du connecteur. Utilisez les flèches pour déplacer l’ancrage sur la carte.`);
  handle.dataset.connectorId = item.id;
  handle.dataset.endpoint = endpoint;
  const mark = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  mark.classList.add("connector-anchor-mark");
  mark.setAttribute("cx", String(point.x));
  mark.setAttribute("cy", String(point.y));
  mark.setAttribute("r", String(8 / board.zoom));
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    snapshotState();
    selectedVectorId = item.id;
    connectorResizeGesture = { pointerId: event.pointerId, itemId: item.id, endpoint };
    viewport.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("keydown", (event) => {
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const vector = board.items.find((candidate) => candidate.id === item.id);
    if (!vector) return;
    snapshotState();
    const key = endpoint === "from" ? "fromAnchor" : "toAnchor";
    const anchor = { ...(vector[key] || { x: .5, y: .5 }) };
    const step = event.shiftKey ? .1 : .02;
    anchor.x = Math.max(0, Math.min(1, anchor.x + direction[0] * step));
    anchor.y = Math.max(0, Math.min(1, anchor.y + direction[1] * step));
    vector[key] = anchor;
    renderVectorItems();
    connectorLayer.querySelector(`[data-connector-id="${CSS.escape(item.id)}"][data-endpoint="${endpoint}"]`)?.focus();
    scheduleSave();
  });
  connectorLayer.append(handle, mark);
}

function connectorPath({ start, end }, curve) {
  const control = connectorControlPoint(start, end, curve);
  return `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
}

function connectorControlPoint(start, end, curve) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: (start.x + end.x) / 2 - dy / length * curve, y: (start.y + end.y) / 2 + dx / length * curve };
}

function anchorAtWorldPoint(itemId, point) {
  const card = itemId && canvas.querySelector(`[data-id="${CSS.escape(itemId)}"]`);
  if (!card) return { x: .5, y: .5 };
  return {
    x: Math.max(0, Math.min(1, (point.x - card.offsetLeft) / card.offsetWidth)),
    y: Math.max(0, Math.min(1, (point.y - card.offsetTop) / card.offsetHeight)),
  };
}

function prepareVectorSelection(vector, item, label) {
  vector.dataset.id = item.id;
  vector.classList.add("vector-hit-area");
  vector.setAttribute("tabindex", "0");
  vector.setAttribute("role", "button");
  vector.setAttribute("aria-label", `${label} — sélectionner, puis supprimer`);
  vector.classList.toggle("is-selected", item.id === selectedVectorId);
  vector.addEventListener("pointerdown", (event) => event.stopPropagation());
  vector.addEventListener("click", () => selectVector(item.id));
  vector.addEventListener("dblclick", deleteSelectedVector);
  vector.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectVector(item.id);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      selectVector(item.id);
      deleteSelectedVector();
    }
  });
}

function selectVector(vectorId) {
  selectedVectorId = vectorId;
  if (selectedCardIds.size) {
    selectedCardIds = new Set();
    applyCardSelection();
  }
  renderVectorItems();
  connectorLayer.querySelector(`.vector-hit-area[data-id="${CSS.escape(vectorId)}"]`)?.focus();
}

function updateVectorDeleteButton() {
  const button = $("#delete-vector-button");
  if (!button) return;
  const selected = board.items.find((item) => item.id === selectedVectorId && (item.type === "connector" || item.type === "drawing"));
  button.hidden = !selected;
  const controls = $("#connector-controls");
  controls.hidden = !selected || selected.type !== "connector";
  if (selected?.type === "connector") {
    $("#connector-curve").value = selected.curve || 0;
    $("#connector-color").value = selected.color || "#000000";
  }
  if (selected) {
    const label = selected.type === "connector" ? "Supprimer le connecteur" : "Supprimer le dessin";
    button.textContent = `× ${label}`;
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}

function deleteSelectedVector() {
  const selected = board.items.find((item) => item.id === selectedVectorId && (item.type === "connector" || item.type === "drawing"));
  if (!selected) return;
  snapshotState();
  board.items = board.items.filter((item) => item.id !== selected.id);
  selectedVectorId = null;
  renderBoard();
  scheduleSave();
  showToast(selected.type === "connector" ? "Connecteur supprimé." : "Dessin supprimé.");
}

function connectorEndpoints(item) {
  const start = cardAnchor(item.fromId, item.fromAnchor);
  const end = cardAnchor(item.toId, item.toAnchor);
  const rawStart = start || { x: item.x1 ?? 0, y: item.y1 ?? 0 };
  const rawEnd = end || { x: item.x2 ?? 0, y: item.y2 ?? 0 };
  const control = connectorControlPoint(rawStart, rawEnd, item.curve || 0);
  const borderPoint = (id, point, toward) => {
    const card = id && canvas.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!card) return point;
    return connectorBorderPoint({
      x: card.offsetLeft, y: card.offsetTop,
      width: card.offsetWidth, height: card.offsetHeight,
    }, point, toward);
  };
  return {
    start: borderPoint(item.fromId, rawStart, control),
    end: borderPoint(item.toId, rawEnd, control),
  };
}

function connectorBorderPoint(rect, point, toward) {
  let dx = toward.x - point.x;
  let dy = toward.y - point.y;
  if (Math.abs(dx) + Math.abs(dy) < .001) {
    dx = point.x - (rect.x + rect.width / 2);
    dy = point.y - (rect.y + rect.height / 2);
    if (Math.abs(dx) + Math.abs(dy) < .001) dy = 1;
  }
  const tx = dx > 0 ? (rect.x + rect.width - point.x) / dx : dx < 0 ? (rect.x - point.x) / dx : Infinity;
  const ty = dy > 0 ? (rect.y + rect.height - point.y) / dy : dy < 0 ? (rect.y - point.y) / dy : Infinity;
  const t = Math.max(0, Math.min(tx, ty));
  return { x: point.x + dx * t, y: point.y + dy * t };
}

function cardAnchor(itemId, anchor = { x: .5, y: .5 }) {
  const card = itemId && canvas.querySelector(`[data-id="${CSS.escape(itemId)}"]`);
  if (!card) return null;
  return {
    x: card.offsetLeft + card.offsetWidth * (anchor?.x ?? .5),
    y: card.offsetTop + card.offsetHeight * (anchor?.y ?? .5),
  };
}

function anchorAtPointer(card, event) {
  const rect = card.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  };
}

function renderBoard() {
  if (!board.items.some((item) => item.id === selectedVectorId)) selectedVectorId = null;
  const itemIds = new Set(board.items.map((item) => item.id));
  selectedCardIds = new Set([...selectedCardIds].filter((id) => itemIds.has(id)));
  canvas.querySelectorAll("audio").forEach((player) => { player.pause(); URL.revokeObjectURL(player.src); player.removeAttribute("src"); player.load(); });
  canvas.querySelectorAll("img").forEach((image) => URL.revokeObjectURL(image.src));
  cardResizeObserver?.disconnect();
  canvas.replaceChildren(...board.items.filter((item) => !["connector", "drawing"].includes(item.type)).map(buildCard));
  if (typeof ResizeObserver !== "undefined") {
    cardResizeObserver = new ResizeObserver((entries) => {
      for (const { target } of entries) {
        const item = board.items.find((candidate) => candidate.id === target.dataset.id);
        if (item?.type === "image") applyImageTransform(target.querySelector(".image-plate"), item);
      }
      renderVectorItems();
    });
    canvas.querySelectorAll(".board-card").forEach((card) => cardResizeObserver.observe(card));
  }
  renderVectorItems();
  $("#empty-state").hidden = board.items.length > 0;
  const count = board.items.length;
  $("#item-count").textContent = `${count} élément${count > 1 ? "s" : ""}`;
  updateZoom();
  renderBreadcrumbs();
  renderBoardPicker();
  renderTeam();
}

function renderBoardPicker() {
  const picker = $("#board-picker");
  picker.replaceChildren();
  const records = new Map(boardRecords);
  records.set(board.id, board);
  for (const record of records.values()) {
    if (isCatalogue(record)) continue;
    const option = document.createElement("option");
    option.value = record.id;
    option.textContent = record.title || "Sans titre";
    picker.append(option);
  }
  picker.value = board.id;
}

function fitBoardContent() {
  const cards = [...canvas.querySelectorAll(".board-card")];
  if (!cards.length) {
    board.zoom = 1;
    updateZoom();
    focusWorldPoint(0, 0);
  } else {
    const left = Math.min(...cards.map((card) => card.offsetLeft));
    const top = Math.min(...cards.map((card) => card.offsetTop));
    const right = Math.max(...cards.map((card) => card.offsetLeft + card.offsetWidth));
    const bottom = Math.max(...cards.map((card) => card.offsetTop + card.offsetHeight));
    board.zoom = Math.max(MIN_ZOOM, Math.min(1,
      Math.max(1, viewport.clientWidth - 80) / Math.max(1, right - left),
      Math.max(1, viewport.clientHeight - 80) / Math.max(1, bottom - top)));
    updateZoom();
    focusWorldPoint((left + right) / 2, (top + bottom) / 2);
  }
  updateViewSave();
}

function updateZoom() {
  board.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, board.zoom ?? 1));
  const transform = `translate(${board.originX * board.zoom}px, ${board.originY * board.zoom}px) scale(${board.zoom})`;
  canvas.style.transform = transform;
  connectorLayer.style.transform = transform;
  boardStage.style.width = `${board.worldWidth * board.zoom}px`;
  boardStage.style.height = `${board.worldHeight * board.zoom}px`;
  $("#zoom-level").innerHTML = `${Math.round(board.zoom * 100)}&nbsp;%`;
  if (selectedVectorId) renderVectorItems();
}

function updateViewSave() {
  board.viewX = viewport.scrollLeft;
  board.viewY = viewport.scrollTop;
  ensureInfiniteSpace();
  scheduleSave();
}

function ensureInfiniteSpace() {
  const margin = 420;
  const growth = 1800;
  let shifted = false;
  if (viewport.scrollLeft < margin * board.zoom) {
    board.originX += growth;
    board.worldWidth += growth;
    viewport.scrollLeft += growth * board.zoom;
    shifted = true;
  } else if (viewport.scrollLeft + viewport.clientWidth > (board.worldWidth - margin) * board.zoom) {
    board.worldWidth += growth;
    shifted = true;
  }
  if (viewport.scrollTop < margin * board.zoom) {
    board.originY += growth;
    board.worldHeight += growth;
    viewport.scrollTop += growth * board.zoom;
    shifted = true;
  } else if (viewport.scrollTop + viewport.clientHeight > (board.worldHeight - margin) * board.zoom) {
    board.worldHeight += growth;
    shifted = true;
  }
  if (shifted) {
    updateZoom();
    board.viewX = viewport.scrollLeft;
    board.viewY = viewport.scrollTop;
    saveAfterQuietScroll();
  }
}

function saveAfterQuietScroll() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistRecords([board, { id: WORKSPACE_ID, members }]).then(() => setSaveStatus("Enregistré")).catch((error) => {
      console.error("Impossible d’enregistrer la position du tableau.", error);
      reportSaveError(error);
    });
  }, 500);
}

function focusWorldPoint(x, y) {
  viewport.scrollLeft = Math.max(0, (board.originX + x) * board.zoom - viewport.clientWidth / 2);
  viewport.scrollTop = Math.max(0, (board.originY + y) * board.zoom - viewport.clientHeight / 2);
  board.viewX = viewport.scrollLeft;
  board.viewY = viewport.scrollTop;
}

function canvasPoint(event) {
  const rect = viewport.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left + viewport.scrollLeft) / board.zoom,
    y: (event.clientY - rect.top + viewport.scrollTop) / board.zoom,
  };
}

function worldPoint(event) {
  const point = canvasPoint(event);
  return { x: point.x - board.originX, y: point.y - board.originY };
}

function setTool(tool) {
  activeTool = tool;
  document.querySelectorAll(".rail-link[data-tool]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tool === tool);
    if (button.dataset.tool === tool) button.setAttribute("aria-current", "tool");
    else button.removeAttribute("aria-current");
  });
  const canvasHint = $("#canvas-hint");
  canvasHint.hidden = false;
  canvasHint.innerHTML = tool === "select"
      ? '<span class="hint-drag" aria-hidden="true">▭</span> Glissez pour entourer des cartes · Espace + glisser pour déplacer'
      : tool === "line"
        ? '<span class="hint-drag" aria-hidden="true">↗</span> Tirez d’une carte vers une autre pour les relier'
        : '<span class="hint-drag" aria-hidden="true">✎</span> Dessinez librement · double-cliquez un tracé pour le supprimer';
}

function addNote(position = viewportCenter()) {
  snapshotState();
  board.items.push({ id: newId(), type: "note", x: position.x, y: position.y, z: ++lastZIndex, title: "", body: "", color: ["sage", "ochre", "rose", "blue"][board.items.length % 4] });
  renderBoard();
  scheduleSave();
  requestAnimationFrame(() => canvas.querySelector(`[data-id="${CSS.escape(board.items.at(-1).id)}"] .note-title`)?.focus());
}

function addLink(position = viewportCenter()) {
  snapshotState();
  board.items.push({ id: newId(), type: "link", x: position.x, y: position.y, z: ++lastZIndex, title: "", url: "" });
  renderBoard();
  scheduleSave();
  requestAnimationFrame(() => canvas.querySelector(`[data-id="${CSS.escape(board.items.at(-1).id)}"] .link-url`)?.focus());
}

function addTask(position = viewportCenter(), values = {}) {
  snapshotState();
  board.items.push({ id: newId(), type: "todo", x: position.x, y: position.y, z: ++lastZIndex, title: values.title || "", status: values.status || "todo", assigneeId: values.assigneeId || null, ...(values.entries ? { entries: values.entries } : {}) });
  renderBoard();
  scheduleSave();
}

function addNestedBoard(position = viewportCenter(), parentId = board.id) {
  snapshotState();
  const childId = newId();
  const child = normalizeBoard({
    id: childId,
    parentId,
    title: "Nouveau tableau",
    zoom: 1,
    originX: ORIGIN.x,
    originY: ORIGIN.y,
    worldWidth: INITIAL_SIZE.width,
    worldHeight: INITIAL_SIZE.height,
    viewX: ORIGIN.x,
    viewY: ORIGIN.y,
    items: [],
  });
  boardRecords.set(childId, child);
  board.items.push({ id: newId(), type: "board", x: position.x, y: position.y, z: ++lastZIndex, title: child.title, boardId: childId });
  renderBoard();
  persistRecords([board, child, { id: WORKSPACE_ID, members }])
    .then(() => setSaveStatus("Enregistré"))
    .catch(reportSaveError);
}

function viewportCenter() {
  const center = worldPoint({ clientX: viewport.getBoundingClientRect().left + viewport.clientWidth / 2, clientY: viewport.getBoundingClientRect().top + viewport.clientHeight / 2 });
  return { x: Math.max(24, Math.round(center.x)), y: Math.max(24, Math.round(center.y)) };
}

function renderBreadcrumbs() {
  const nav = $("#breadcrumbs");
  nav.replaceChildren();
  const chain = [];
  let cursor = board;
  while (cursor) {
    chain.unshift(cursor);
    cursor = cursor.parentId ? boardRecords.get(cursor.parentId) : null;
  }
  chain.forEach((entry, index) => {
    if (index) {
      const slash = document.createElement("span");
      slash.className = "crumb-slash";
      slash.textContent = "/";
      nav.append(slash);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = entry.title;
    if (index === chain.length - 1) {
      button.setAttribute("aria-current", "page");
      button.setAttribute("contenteditable", "plaintext-only");
      button.setAttribute("aria-label", "Nom du tableau, modifiable");
      button.spellcheck = false;
      button.addEventListener("focus", snapshotState, { once: true });
      button.addEventListener("input", () => {
        board.title = button.textContent.trim().slice(0, 80) || "Tableau sans titre";
        const parent = board.parentId && boardRecords.get(board.parentId);
        const parentItem = parent?.items.find((item) => item.type === "board" && item.boardId === board.id);
        if (parentItem) {
          parentItem.title = board.title;
          boardRecords.set(parent.id, structuredClone(parent));
          scheduleSave([parent]);
        } else scheduleSave();
      });
      button.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          button.blur();
        }
      });
    } else button.addEventListener("click", () => openBoard(entry.id));
    nav.append(button);
  });
}

function openBoard(boardId) {
  const next = boardRecords.get(boardId);
  if (!next || isCatalogue(next)) return;
  board = normalizeBoard(next);
  selectedCardIds = new Set();
  selectedVectorId = null;
  closeCardMenu();
  renderBoard();
  viewport.scrollLeft = board.viewX;
  viewport.scrollTop = board.viewY;
}

function moveCardByKeyboard(event, card, item) {
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const direction = directions[event.key];
  if (!direction) return;
  event.preventDefault();
  snapshotState();
  const step = event.shiftKey ? 40 : 10;
  item.x += direction[0] * step;
  item.y += direction[1] * step;
  card.style.left = `${item.x}px`;
  card.style.top = `${item.y}px`;
  updateCardConnectors();
  scheduleSave();
}

function updateCardConnectors() {
  if (board.items.some((item) => item.type === "connector" && (item.fromId || item.toId))) renderVectorItems();
}

function adjustZoom(delta, anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2) {
  const pointX = (viewport.scrollLeft + anchorX) / board.zoom;
  const pointY = (viewport.scrollTop + anchorY) / board.zoom;
  board.zoom = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, board.zoom + delta)) * 100) / 100;
  updateZoom();
  viewport.scrollLeft = pointX * board.zoom - anchorX;
  viewport.scrollTop = pointY * board.zoom - anchorY;
  updateViewSave();
}

async function addImageFiles(files, clientX, clientY) {
  if (Array.from(files).some((file) => !MIME_TYPES.has(file.type))) throw new Error("Choisissez une image PNG, JPG, WEBP ou GIF.");
  await addMediaFiles(files, clientX, clientY);
}

async function addMediaFiles(files, clientX, clientY) {
  const entries = Array.from(files);
  if (!entries.length) return;
  const targetBoard = board;
  const sessionId = remoteSession?.id;
  const prepared = [];
  for (const file of entries) {
    if (["audio/mpeg", "audio/wav", "audio/ogg"].includes(audioMime(file))) {
      prepared.push({ type: "audio", file, audio: await prepareAudio(file) });
    } else if (MIME_TYPES.has(file.type) && file.size > 0 && file.size <= 15 * 1024 * 1024) {
      prepared.push({ type: "image", file });
    } else {
      throw new Error("Choisissez une image PNG/JPG/WEBP/GIF ou un son MP3/WAV/OGG de 15 Mio maximum par fichier.");
    }
  }
  if (board !== targetBoard || remoteSession?.id !== sessionId) throw new Error("Le tableau ou le compte a changé. Ajoutez vos fichiers de nouveau.");
  const point = Number.isFinite(clientX) ? worldPoint({ clientX, clientY }) : viewportCenter();
  snapshotState();
  prepared.forEach(({ type, file, audio }, index) => board.items.push({
    id: newId(), type, x: Math.max(0, point.x + index * 36), y: Math.max(0, point.y + index * 36),
    z: ++lastZIndex, title: file.name.replace(/\.[^.]+$/, ""), fileName: file.name,
    ...(type === "audio" ? { audio } : { image: file, imageZoom: 1 }),
  }));
  renderBoard();
  scheduleSave();
  showToast(`${prepared.length} média${prepared.length > 1 ? "s ajoutés" : " ajouté"} au tableau.${prepared.some((entry) => entry.type === "audio") ? " Lancez la lecture des sons avec ▶." : ""}`);
}

function startCardDrag(event, grip) {
  if (event.button !== 0 || event.target.closest("button, input, textarea, select, a, audio, [contenteditable='true'], .card-resize")) return false;
  const card = grip.closest(".board-card");
  const item = board.items.find((candidate) => candidate.id === card.dataset.id);
  if (!item) return false;
  if (!selectedCardIds.has(item.id)) {
    selectedCardIds = new Set([item.id]);
    applyCardSelection();
  }
  const moving = selectedCards();
  if (!moving.some((candidate) => candidate.id === item.id)) moving.push(item);
  const origins = moving.map((candidate) => ({
    item: candidate,
    card: canvas.querySelector(`[data-id="${CSS.escape(candidate.id)}"]`),
    x: candidate.x,
    y: candidate.y,
  }));
  const startX = event.clientX;
  const startY = event.clientY;
  let snapshotTaken = false;
  grip.setPointerCapture(event.pointerId);
  event.preventDefault();
  const move = (moveEvent) => {
    const dx = (moveEvent.clientX - startX) / board.zoom;
    const dy = (moveEvent.clientY - startY) / board.zoom;
    if (!snapshotTaken && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
      snapshotState();
      snapshotTaken = true;
    }
    if (!snapshotTaken) return;
    origins.forEach(({ item: candidate, card: targetCard, x, y }) => {
      candidate.x = x + dx;
      candidate.y = y + dy;
      if (targetCard) {
        targetCard.style.left = `${candidate.x}px`;
        targetCard.style.top = `${candidate.y}px`;
      }
      ensureItemBounds(candidate);
    });
    updateCardConnectors();
  };
  const stop = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", stop);
    grip.removeEventListener("pointercancel", stop);
    if (snapshotTaken) scheduleSave();
    else if (!event.ctrlKey && !event.metaKey && !event.shiftKey && selectedCardIds.size > 1) {
      selectedCardIds = new Set([item.id]);
      applyCardSelection();
    }
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", stop, { once: true });
  grip.addEventListener("pointercancel", stop, { once: true });
  return true;
}

function ensureItemBounds(item) {
  if (item.x + board.originX > board.worldWidth - 600) board.worldWidth += 1800;
  if (item.y + board.originY > board.worldHeight - 500) board.worldHeight += 1800;
  updateZoom();
}

function beginMarquee(event) {
  const start = worldPoint(event);
  const box = document.createElement("div");
  box.className = "selection-marquee";
  canvas.append(box);
  marqueeGesture = { start, box, pointerId: event.pointerId, additive: event.ctrlKey || event.metaKey || event.shiftKey };
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add("is-marquee-select");
  event.preventDefault();
  return true;
}

function moveMarquee(event) {
  if (!marqueeGesture) return;
  const point = worldPoint(event);
  const x = Math.min(marqueeGesture.start.x, point.x);
  const y = Math.min(marqueeGesture.start.y, point.y);
  const width = Math.abs(point.x - marqueeGesture.start.x);
  const height = Math.abs(point.y - marqueeGesture.start.y);
  Object.assign(marqueeGesture.box.style, {
    left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`,
  });
}

function endMarquee() {
  if (!marqueeGesture) return;
  const { box, additive } = marqueeGesture;
  const rect = {
    x: parseFloat(box.style.left) || 0,
    y: parseFloat(box.style.top) || 0,
    width: parseFloat(box.style.width) || 0,
    height: parseFloat(box.style.height) || 0,
  };
  box.remove();
  marqueeGesture = null;
  viewport.classList.remove("is-marquee-select");
  if (rect.width < 4 && rect.height < 4) {
    if (!additive) {
      clearCardSelection();
      if (selectedVectorId) {
        selectedVectorId = null;
        renderVectorItems();
      }
    }
    return;
  }
  const hits = new Set(additive ? selectedCardIds : []);
  board.items.forEach((item) => {
    if (["connector", "drawing"].includes(item.type)) return;
    const bounds = itemWorldRect(item);
    const overlaps = bounds.x < rect.x + rect.width && bounds.x + bounds.width > rect.x
      && bounds.y < rect.y + rect.height && bounds.y + bounds.height > rect.y;
    if (overlaps) hits.add(item.id);
  });
  selectedCardIds = hits;
  selectedVectorId = null;
  applyCardSelection();
  renderVectorItems();
}

function beginPan(event) {
  if (event.button !== 0 && event.button !== 1) return false;
  if (event.button === 0 && !spacePressed && event.pointerType !== "touch") return false;
  if (event.pointerType === "touch" && !spacePressed && event.button === 0
    && event.target.closest(".board-card, .vector-hit-area, .connector-anchor-handle")) return false;
  if (event.target.closest("button, a, input, textarea, select, audio, [contenteditable='true']")) return false;
  panGesture = { x: event.clientX, y: event.clientY, scrollX: viewport.scrollLeft, scrollY: viewport.scrollTop };
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add("is-panning");
  event.preventDefault();
  return true;
}

function panMove(event) {
  if (!panGesture) return;
  viewport.scrollLeft = panGesture.scrollX - (event.clientX - panGesture.x);
  viewport.scrollTop = panGesture.scrollY - (event.clientY - panGesture.y);
  ensureInfiniteSpace();
}

function beginVector(event) {
  if (event.button !== 0 || activeTool === "select") return;
  if (activeTool === "line") {
    const source = event.target.closest(".board-card");
    if (!source || event.target.closest("input, textarea, select, a, audio, .audio-content button")) return;
    const item = board.items.find((candidate) => candidate.id === source.dataset.id);
    if (!item) return;
    connectionGesture = {
      pointerId: event.pointerId,
      fromId: item.id,
      fromAnchor: anchorAtPointer(source, event),
      end: worldPoint(event),
    };
    viewport.setPointerCapture(event.pointerId);
    event.preventDefault();
    drawTemporaryVector();
    return;
  }
  if (event.target.closest(".board-card")) return;
  const point = worldPoint(event);
  drawingGesture = { pointerId: event.pointerId, type: activeTool, points: [point], start: point };
  viewport.setPointerCapture(event.pointerId);
  event.preventDefault();
  drawTemporaryVector();
}

function drawTemporaryVector() {
  connectorLayer.querySelector(".temporary-vector")?.remove();
  if (connectionGesture) {
    const start = cardAnchor(connectionGesture.fromId, connectionGesture.fromAnchor);
    if (!start) return;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.classList.add("temporary-vector");
    line.setAttribute("x1", start.x);
    line.setAttribute("y1", start.y);
    line.setAttribute("x2", connectionGesture.end.x);
    line.setAttribute("y2", connectionGesture.end.y);
    line.setAttribute("stroke", "#d7f36a");
    line.setAttribute("stroke-width", "3");
    line.setAttribute("marker-end", "url(#pixelboard-arrowhead)");
    connectorLayer.append(line);
    return;
  }
  if (!drawingGesture) return;
  const shape = document.createElementNS("http://www.w3.org/2000/svg", drawingGesture.type === "line" ? "line" : "polyline");
  shape.classList.add("temporary-vector");
  shape.setAttribute("stroke", "#d7f36a");
  shape.setAttribute("stroke-width", "5");
  shape.setAttribute("stroke-linecap", "square");
  shape.setAttribute("fill", "none");
  if (drawingGesture.type === "line") {
    shape.setAttribute("x1", drawingGesture.start.x);
    shape.setAttribute("y1", drawingGesture.start.y);
    const end = drawingGesture.points.at(-1);
    shape.setAttribute("x2", end.x);
    shape.setAttribute("y2", end.y);
  } else shape.setAttribute("points", drawingGesture.points.map((point) => `${point.x},${point.y}`).join(" "));
  connectorLayer.append(shape);
}

function moveVector(event) {
  if (connectorResizeGesture) {
    const item = board.items.find((candidate) => candidate.id === connectorResizeGesture.itemId);
    if (!item) return;
    const anchorKey = connectorResizeGesture.endpoint === "from" ? "fromAnchor" : "toAnchor";
    item[anchorKey] = anchorAtWorldPoint(
      connectorResizeGesture.endpoint === "from" ? item.fromId : item.toId,
      worldPoint(event),
    );
    renderVectorItems();
    return;
  }
  if (connectionGesture) {
    connectionGesture.end = worldPoint(event);
    drawTemporaryVector();
    return;
  }
  if (!drawingGesture) return;
  const point = worldPoint(event);
  if (drawingGesture.type === "line") drawingGesture.points[1] = point;
  else drawingGesture.points.push(point);
  drawTemporaryVector();
}

function endVector(event) {
  if (connectionGesture) {
    const gesture = connectionGesture;
    connectionGesture = null;
    connectorLayer.querySelector(".temporary-vector")?.remove();
    if (!event) return;
    const target = event ? document.elementFromPoint(event.clientX, event.clientY)?.closest(".board-card") : null;
    const targetItem = target && board.items.find((candidate) => candidate.id === target.dataset.id);
    if (!targetItem || targetItem.id === gesture.fromId) {
      showToast("Reliez le premier point à une autre carte.");
      return;
    }
    const endpoints = {
      start: cardAnchor(gesture.fromId, gesture.fromAnchor),
      end: cardAnchor(targetItem.id, anchorAtPointer(target, event)),
    };
    snapshotState();
    board.items.push({
      id: newId(),
      type: "connector",
      fromId: gesture.fromId,
      toId: targetItem.id,
      fromAnchor: gesture.fromAnchor,
      toAnchor: anchorAtPointer(target, event),
      x1: endpoints.start.x,
      y1: endpoints.start.y,
      x2: endpoints.end.x,
      y2: endpoints.end.y,
      color: "#000000",
    });
    renderBoard();
    scheduleSave();
    return;
  }
  if (!drawingGesture) return;
  const gesture = drawingGesture;
  drawingGesture = null;
  connectorLayer.querySelector(".temporary-vector")?.remove();
  if (gesture.points.length < 2) return;
  snapshotState();
  if (gesture.type === "line") {
    const end = gesture.points.at(-1);
    board.items.push({ id: newId(), type: "connector", x1: gesture.start.x, y1: gesture.start.y, x2: end.x, y2: end.y, color: "#000000" });
  } else board.items.push({ id: newId(), type: "drawing", points: gesture.points, color: "#d7f36a" });
  renderBoard();
  scheduleSave();
}

function showDialog(title, copy, note = "", confirmLabel = "") {
  dialogTitle.textContent = title;
  dialogCopy.textContent = copy;
  dialogNote.textContent = note;
  dialogNote.hidden = !note;
  const confirmButton = $("#dialog-confirm");
  confirmButton.hidden = !confirmLabel;
  confirmButton.textContent = confirmLabel;
  infoDialog.showModal();
}

function showImportNotice() {
  showDialog("L’import Milanote n’est pas disponible.", "Nous n’avons pas trouvé d’intégration publique officiellement documentée permettant d’importer des tableaux Milanote dans PixelBoard.", "Aucun mot de passe n’est demandé. Pour continuer, ajoutez ici manuellement vos notes et images.");
}

function showLocalNotice(title, copy, note = "") {
  showDialog(title, copy, note);
}

function showCurrentStorageNotice() {
  if (remoteSession) {
    showLocalNotice("Espace partagé", `Vous êtes connecté à « ${remoteSession.workspace} ». Les tableaux sont enregistrés sur le serveur et se synchronisent entre les membres.`, "Les écritures utilisent un numéro de version pour détecter les modifications concurrentes.");
  } else {
    showLocalNotice("Espace local sur cet appareil", "Les tableaux sont enregistrés dans IndexedDB sur cet appareil.", apiReady
      ? "Connectez-vous ou créez un compte avec une invitation pour accéder à l’espace partagé."
      : "Les comptes d’équipe et la synchronisation nécessitent l’installation de l’API PHP/MySQL.");
  }
}

function confirmEmptyBoard() {
  pendingConfirm = () => {
    snapshotState();
    board.items = [];
    renderBoard();
    scheduleSave();
    showToast("Le tableau est vide.");
  };
  showDialog("Vider ce tableau ?", "Cette action retire toutes les notes, images, sons, tâches, dessins et connecteurs de ce tableau.", "Les autres tableaux et les profils de l’équipe seront conservés.", "Tout supprimer");
}

async function exportWorkspace() {
  try {
    let syncWarning = "";
    try {
      await saveImmediately();
    } catch (error) {
      if (!remoteSession) throw error;
      syncWarning = ` Export local créé malgré une erreur de synchronisation : ${error.message}`;
    }
    const records = remoteSession
      ? allStoredBoards()
      : (await readAllRecords()).filter((record) => !record.id.startsWith(REMOTE_CACHE_PREFIX));
    const exported = [];
    for (const record of records) {
      if (record.id === WORKSPACE_ID) {
        exported.push({ id: record.id, members: record.members });
        continue;
      }
      const copy = { ...record, items: [] };
      for (const item of record.items || []) {
        const exportedItem = { ...item };
        if (item.image instanceof Blob) exportedItem.image = await imageDataUrl(item.image);
        if (item.coverImage instanceof Blob) exportedItem.coverImage = await imageDataUrl(item.coverImage);
        if (item.type === "audio") exportedItem.audio = await imageDataUrl(await restoreAudio(item.audio));
        copy.items.push(exportedItem);
      }
      exported.push(copy);
    }
    const blob = new Blob([JSON.stringify({ format: "pixelboard", version: 1, exportedAt: new Date().toISOString(), records: exported }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "pixelboard-espace.json";
    link.click();
    URL.revokeObjectURL(link.href);
    showToast(syncWarning || "Copie JSON de l’espace téléchargée.");
  } catch (error) {
    console.error("Échec de l’export PixelBoard.", error);
    showToast("Impossible de préparer l’export. Vérifiez l’espace disponible dans le navigateur.");
  }
}

function allStoredBoards() {
  const result = new Map(boardRecords);
  result.set(board.id, board);
  return [...result.values()].filter((entry) => entry.id !== WORKSPACE_ID);
}

function allTasks() {
  return allStoredBoards().flatMap((record) => (record.items || [])
    .filter((item) => item.type === "todo")
    .flatMap((item) => {
      const location = { boardTitle: record.title, boardId: record.id, id: item.id };
      if (!Array.isArray(item.entries)) return [{ ...item, ...location }];
      prepareChecklist(item);
      return item.entries.map((entry) => ({
        ...location, entryId: entry.id, title: entry.text, status: entry.status,
        assigneeId: entry.assigneeId, listTitle: item.title,
      }));
    }));
}

function avatarInitials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

async function submitAccountForm(event, action) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  let authenticated = false;
  try {
    const result = await apiRequest(action, { method: "POST", body: values });
    authenticated = true;
    apiReady = true;
    apiState = "ready";
    inviteCodeValue = "";
    await loadRemoteWorkspace(result, await readAllRecords());
    renderBoard();
    viewport.scrollLeft = board.viewX;
    viewport.scrollTop = board.viewY;
    renderTeam();
    showToast(action === "register" ? "Compte créé, vous êtes connecté à l’espace partagé." : "Connexion à l’espace partagé réussie.");
  } catch (error) {
    console.error("Échec de connexion à l’espace partagé.", error);
    if (authenticated) {
      remoteSession = null;
      apiReady = false;
      apiState = "error";
      apiMessage = `Connexion obtenue, mais chargement impossible : ${error.message}. Rechargez la page pour réessayer.`;
      const localRecords = await readAllRecords();
      boardRecords = new Map(localWorkspaceRecords(localRecords).map((record) => [record.id, normalizeBoard(record)]));
      const meta = localRecords.find((record) => record.id === WORKSPACE_ID);
      members = Array.isArray(meta?.members) ? meta.members : defaultMembers();
      board = normalizeBoard(boardRecords.get(ROOT_ID) || makeDefaultBoard());
      boardRecords.set(board.id, structuredClone(board));
      renderBoard();
    }
    showToast(error.message);
  }
}

async function signOutAccount() {
  try {
    try {
      await saveImmediately();
    } catch (error) {
      if (!pendingRemoteBoardIds.size) throw error;
      console.error("Déconnexion avec des modifications locales en attente.", error);
    }
    await apiRequest("logout", { method: "POST", body: {} });
    clearInterval(remoteSyncTimer);
    remoteSession = null;
    remoteVersions = new Map();
    history = [];
    redoHistory = [];
    updateHistoryButtons();
    inviteCodeValue = "";
    const records = await readAllRecords();
    boardRecords = new Map(localWorkspaceRecords(records).map((record) => [record.id, normalizeBoard(record)]));
    const meta = records.find((record) => record.id === WORKSPACE_ID);
    members = Array.isArray(meta?.members) ? meta.members : defaultMembers();
    board = normalizeBoard(boardRecords.get(ROOT_ID) || makeDefaultBoard());
    boardRecords.set(board.id, structuredClone(board));
    renderBoard();
    renderTeam();
    showToast(pendingRemoteBoardIds.size
      ? "Déconnecté. Une copie non synchronisée reste conservée; reconnectez-vous pour l’exporter."
      : "Déconnecté. Connectez-vous pour retrouver votre équipe.");
  } catch (error) {
    console.error("Échec de déconnexion.", error);
    showToast(`Déconnexion impossible : ${error.message}`);
  }
}

async function createInviteCode() {
  try {
    const result = await apiRequest("invite", { method: "POST", body: {} });
    inviteCodeValue = result.invite_code;
    renderAuthControls();
  } catch (error) {
    showToast(error.message);
  }
}

async function importLocalBoards() {
  const records = localWorkspaceRecords(await readAllRecords());
  if (!records.length) return;
  try {
    const importedBySource = new Map(allStoredBoards()
      .filter((record) => record.importSourceId)
      .map((record) => [record.importSourceId, record]));
    const boardIdMap = new Map(records.map((record) => [
      record.id,
      importedBySource.get(record.id)?.id || newId(),
    ]));
    const memberIds = new Set(members.map((member) => member.id));
    for (const record of records) {
      let copy = importedBySource.get(record.id);
      if (!copy) {
        copy = structuredClone(record);
        copy.id = boardIdMap.get(record.id);
        copy.importSourceId = record.id;
        copy.parentId = boardIdMap.get(record.parentId) || null;
        copy.items = (copy.items || []).map((item) => {
          if (item.type === "board" && boardIdMap.has(item.boardId)) item.boardId = boardIdMap.get(item.boardId);
          if (item.type === "todo" && item.assigneeId && !memberIds.has(item.assigneeId)) item.assigneeId = null;
          if (item.type === "todo" && Array.isArray(item.entries)) {
            item.entries.forEach((entry) => {
              if (entry.assigneeId && !memberIds.has(entry.assigneeId)) entry.assigneeId = null;
            });
          }
          return item;
        });
        copy = normalizeBoard(copy);
        boardRecords.set(copy.id, copy);
        remoteVersions.set(copy.id, 0);
        importedBySource.set(record.id, copy);
      }
      if (remoteVersions.get(copy.id) === 0) await persistRecords([copy]);
    }
    const imported = [...importedBySource.values()].find((record) => record.parentId === null) || records[0];
    board = normalizeBoard(imported);
    boardRecords.set(board.id, structuredClone(board));
    $("#import-local").dataset.available = "false";
    renderBoard();
    renderTeam();
    showToast(`${records.length} tableau${records.length === 1 ? "" : "x"} importé${records.length === 1 ? "" : "s"} dans l’espace partagé.`);
  } catch (error) {
    console.error("Échec de l’import des tableaux locaux.", error);
    setSaveStatus("Import incomplet", "has-error");
    showToast(`Import interrompu : ${error.message}. Les tableaux d’origine restent dans ce navigateur.`);
  }
}

async function resolvePendingCopies(mode) {
  if (!remoteSession || !pendingRemoteBoardIds.size) return;
  try {
    const response = await apiRequest("boards");
    const serverBoards = new Map(response.boards.map((entry) => [entry.id, entry]));
    for (const id of [...pendingRemoteBoardIds]) {
      const serverEntry = serverBoards.get(id);
      if (mode === "publish") {
        const draft = id === board.id ? board : boardRecords.get(id);
        if (!draft) continue;
        remoteVersions.set(id, serverEntry?.version || 0);
        await saveRemoteBoard(draft);
        await writeRecords([remoteCacheRecord(draft, false)]);
        pendingRemoteBoardIds.delete(id);
        continue;
      }
      if (serverEntry) {
        const serverBoard = await deserializeBoard(serverEntry.data);
        remoteVersions.set(id, serverEntry.version);
        boardRecords.set(id, serverBoard);
        await writeRecords([remoteCacheRecord(serverBoard, false)]);
      } else {
        remoteVersions.delete(id);
        boardRecords.delete(id);
        await deleteRecord(`${REMOTE_CACHE_PREFIX}${remoteSession.id}:${id}`);
      }
      pendingRemoteBoardIds.delete(id);
    }
    if (mode === "reload" && pendingRemoteBoardIds.size === 0 && !boardRecords.has(board.id)) {
      board = normalizeBoard(boardRecords.get(ROOT_ID) || boardRecords.values().next().value || {
        id: ROOT_ID, title: "Mon premier tableau", parentId: null, zoom: 1,
        originX: ORIGIN.x, originY: ORIGIN.y, worldWidth: INITIAL_SIZE.width,
        worldHeight: INITIAL_SIZE.height, viewX: ORIGIN.x, viewY: ORIGIN.y, items: [],
      });
    } else if (mode === "reload" && boardRecords.has(board.id)) {
      board = normalizeBoard(boardRecords.get(board.id));
    }
    renderBoard();
    renderTeam();
    showToast(mode === "publish" ? "La copie locale a été publiée sur le serveur." : "La version serveur a été rechargée.");
  } catch (error) {
    console.error("Échec de résolution du conflit de synchronisation.", error);
    renderAuthControls();
    showToast(`Conflit non résolu : ${error.message}. La copie locale reste conservée.`);
  }
}

function confirmConflictResolution(mode) {
  const publish = mode === "publish";
  pendingConfirm = () => resolvePendingCopies(mode);
  showDialog(
    publish ? "Remplacer la version serveur ?" : "Abandonner la copie locale ?",
    publish
      ? "La copie locale en conflit remplacera la version serveur actuelle pour les tableaux concernés."
      : "La version serveur remplacera la copie locale en conflit dans l’espace de travail courant.",
    "Exportez l’espace avant de continuer si vous souhaitez conserver les deux versions.",
    publish ? "Publier ma copie" : "Recharger le serveur",
  );
}

async function prepareBackupAction(operation, slot = "approved") {
  if (remoteSession?.role !== "owner" || backupBusy) return;
  const status = $("#backup-status");
  status.textContent = "Vérification des copies serveur…";
  try {
    const result = await apiRequest("backup");
    const backup = result.backups.find((entry) => entry.slot === slot);
    if (operation === "restore" && !backup) {
      status.textContent = slot === "approved" ? "Aucune version validée. Cliquez d’abord sur « Valider cette version »."
        : "Aucune restauration précédente à annuler.";
      return;
    }
    status.textContent = backup ? `Copie enregistrée le ${backup.saved_at} (heure serveur).` : "Aucune version validée pour le moment.";
    pendingConfirm = () => executeBackupAction(operation, slot, backup?.revision);
    showDialog(
      operation === "approve" ? "Valider tous les tableaux ?" : "Restaurer les tableaux ?",
      operation === "approve"
        ? "La version de travail enregistrée de tous les tableaux remplacera la copie protégée précédente."
        : "Les tableaux de cette copie remplaceront leur version de travail. Les tableaux créés après la copie seront conservés.",
      operation === "approve"
        ? "Seul l’administrateur peut remplacer cette référence."
        : "Le travail actuel sera conservé dans une copie serveur avant restauration. Les comptes et membres ne changent pas.",
      operation === "approve" ? "Valider cette version" : "Restaurer la copie",
    );
  } catch (error) {
    status.textContent = error.message;
  }
}

async function executeBackupAction(operation, slot, revision) {
  if (remoteSession?.role !== "owner" || backupBusy) return;
  const status = $("#backup-status");
  if (pendingRemoteBoardIds.size || remoteWritesInFlight || remoteSyncInFlight) {
    status.textContent = "Synchronisation en cours ou conflit non résolu. Attendez puis réessayez, ou rechargez la copie serveur.";
    return;
  }
  backupBusy = true;
  if (typeof itemsUI !== "undefined") itemsUI?.setBlocked(true);
  $(".app-shell").inert = true;
  let restored = false;
  try {
    status.textContent = "Enregistrement du travail et protection serveur…";
    await saveImmediately();
    saveTimer = null;
    await apiRequest("backup", {
      method: "POST",
      body: { operation, slot, revision, versions: Object.fromEntries(remoteVersions) },
    });
    if (operation === "restore") {
      restored = true;
      const response = await apiRequest("boards");
      for (const entry of response.boards) {
        const record = await deserializeBoard(entry.data);
        remoteVersions.set(entry.id, entry.version);
        boardRecords.set(entry.id, record);
        await writeRecords([remoteCacheRecord(record, false)]);
      }
      board = normalizeBoard(boardRecords.get(board.id) || boardRecords.values().next().value);
      history = [];
      redoHistory = [];
      updateHistoryButtons();
      renderBoard();
    }
    status.textContent = operation === "approve"
      ? "Version validée conservée sur le serveur. Les modifications des membres ne la remplaceront pas."
      : "Copie restaurée. Le travail remplacé reste récupérable avec « Récupérer le travail avant restauration ».";
    showToast(operation === "approve" ? "Version administrateur protégée." : "Version serveur restaurée.");
  } catch (error) {
    if (restored) {
      remoteVersions.forEach((value, id) => pendingRemoteBoardIds.add(id));
      status.textContent = `Restauration effectuée sur le serveur, mais rechargement incomplet : ${error.message}. Rechargez la copie serveur avant toute modification.`;
    } else {
      status.textContent = `Opération non confirmée : ${error.message}. Aucune réussite ne peut être garantie; vérifiez la copie serveur avant de réessayer.`;
    }
  } finally {
    backupBusy = false;
    if (typeof itemsUI !== "undefined") itemsUI?.setBlocked(false);
    $(".app-shell").inert = !remoteSession;
  }
}

function renderTeam() {
  if (!$("#member-list")) return;
  renderAuthControls();
  const canManageMembers = remoteSession?.role === "owner";
  $("#member-management").hidden = !canManageMembers;
  $("#add-member-toggle").hidden = true;
  $("#member-form").hidden = true;
  $("#team-storage-notice").textContent = remoteSession
    ? "Espace partagé : les tâches sont enregistrées sur le serveur. Le propriétaire administre les membres."
    : "Mode local : les profils et tâches restent sur cet appareil. Connectez-vous pour accéder à votre équipe.";
  $("#local-notice").textContent = remoteSession
    ? `Espace partagé « ${remoteSession.workspace} ». Les tableaux et tâches sont enregistrés sur le serveur et visibles par les membres connectés.`
    : apiReady
      ? "Mode local sur cet appareil. Pour partager les tableaux, connectez-vous à l’espace de votre équipe."
      : "Équipe locale enregistrée sur cet appareil. Les invitations et la synchronisation partagée ne sont pas connectées.";
  $("#storage-label").textContent = remoteSession ? "Espace partagé" : "Enregistré ici";
  $("#storage-note").textContent = remoteSession
    ? "Tableau partagé · synchronisation serveur active"
    : "Canvas sans limites · enregistré dans ce navigateur";
  $("#help-link").textContent = remoteSession ? "Espace partagé" : "Données locales";
  const avatars = $("#rail-avatars");
  avatars.replaceChildren();
  members.slice(0, 4).forEach((member) => {
    const avatar = document.createElement("button");
    avatar.type = "button";
    avatar.className = "member-avatar";
    avatar.textContent = avatarInitials(member.name);
    avatar.title = `${member.name} · ${member.role}`;
    avatar.style.setProperty("--member-color", member.color);
    avatar.addEventListener("click", () => {
      selectedMember = member.id;
      teamPanel.hidden = false;
      renderTeam();
    });
    avatars.append(avatar);
  });
  $("#team-count").textContent = String(members.length);
  if (canManageMembers) renderMembers();
  else $("#member-list").replaceChildren();
  renderAssigneeOptions();
  renderTasks();
}

async function submitOwnerSetup(event) {
  event.preventDefault();
  if (setupBusy || !setupAvailable || apiState !== "ready") return;
  const form = event.currentTarget;
  const status = $("#owner-setup-status");
  if (location.protocol !== "https:") {
    status.textContent = "Ouvrez le site en HTTPS avant de saisir votre secret d’installation.";
    return;
  }
  const values = Object.fromEntries(new FormData(form).entries());
  const secret = values.setup_secret;
  delete values.setup_secret;
  setupBusy = true;
  status.textContent = "Création du compte administrateur…";
  renderAuthControls();
  try {
    await apiRequest("setup", { method: "POST", headers: { "X-Setup-Secret": secret }, body: values });
    setupAvailable = false;
    registerMode = false;
    $("#login-form").elements.email.value = values.email;
    form.reset();
    showToast("Compte administrateur créé. Connectez-vous avec votre adresse e-mail et votre mot de passe.");
  } catch (error) {
    status.textContent = error.message;
    try {
      const auth = await apiRequest("auth");
      setupAvailable = auth.setup_available === true;
      if (!setupAvailable) showToast("Installation déjà terminée. Connectez-vous avec votre compte.");
    } catch {
      status.textContent += " Impossible de vérifier l’état du serveur. Rechargez la page avant de réessayer.";
    }
  } finally {
    form.elements.setup_secret.value = "";
    form.elements.password.value = "";
    delete values.password;
    setupBusy = false;
    renderAuthControls();
  }
}

async function saveProfilePhoto(data) {
  if (!remoteSession) return;
  const result = await apiRequest("member", {
    method: "PATCH", query: `&id=${encodeURIComponent(remoteSession.id)}`,
    body: { avatar_data: data },
  });
  remoteSession.avatar = result.member.avatar_data || "";
  renderAuthControls();
  showToast("Photo de profil enregistrée.");
}

async function uploadProfilePhoto(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      throw new Error("Choisissez une image PNG, JPG ou WEBP de moins de 5 Mo.");
    }
    const bitmap = await createImageBitmap(file);
    const picture = document.createElement("canvas");
    picture.width = picture.height = 128;
    const context = picture.getContext("2d");
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 128, 128);
    bitmap.close();
    await saveProfilePhoto(picture.toDataURL("image/png"));
  } catch (error) {
    showToast(`Photo non enregistrée : ${error.message}`);
  } finally {
    event.target.value = "";
  }
}

function renderAccessGate() {
  const locked = !remoteSession;
  const shell = $(".app-shell");
  shell.inert = locked;
  document.body.classList.toggle("auth-locked", locked);
  $("#login-page").hidden = !locked;
  $("#login-loading").hidden = true;
  $("#auth-retry").hidden = apiState !== "error" && apiState !== "missing";
  const destination = locked ? $("#login-content") : $("#account-slot");
  const section = $("#auth-section");
  if (section.parentElement !== destination) destination.append(section);
}

function renderAuthControls() {
  if (typeof itemsUI !== "undefined") itemsUI?.sessionChanged();
  renderAccessGate();
  const section = $("#auth-section");
  section.hidden = false;
  const forms = $("#auth-forms");
  const account = $("#account-controls");
  forms.hidden = Boolean(remoteSession);
  account.hidden = !remoteSession;
  const entry = $("#profile-button");
  $("#remove-profile-photo").hidden = !remoteSession?.avatar;
  const preview = $("#profile-photo-preview");
  preview.hidden = !remoteSession?.avatar;
  preview.setAttribute("src", remoteSession?.avatar || "");
  entry.textContent = remoteSession ? "Mon compte" : "Connexion";
  if (remoteSession?.avatar) {
    const photo = document.createElement("img");
    photo.src = remoteSession.avatar;
    photo.alt = "";
    photo.className = "account-photo";
    entry.prepend(photo);
  }
  entry.setAttribute("aria-label", remoteSession ? "Ouvrir mon compte" : "Connexion et création de compte");
  entry.title = entry.getAttribute("aria-label");
  $("#account-setup").open = apiState === "missing" || apiState === "error";
  const showSetup = !remoteSession && apiState === "ready" && setupAvailable;
  $("#owner-setup").hidden = !showSetup;
  $("#owner-setup-form").querySelectorAll("input,button").forEach((input) => { input.disabled = setupBusy || !showSetup; });
  $("#auth-description").textContent = apiState === "error"
    ? `Serveur équipe indisponible : ${apiMessage} Vérifiez pixelboard-config.php à côté de public_html et la base MySQL, puis rechargez cette page. Vos données restent locales.`
    : apiState === "missing"
      ? "API PHP absente : publiez aussi le dossier dist/api dans public_html/api sur Hostinger, puis rechargez cette page. Les comptes et le partage ne sont pas actifs; vos données restent locales."
      : apiState === "checking"
        ? "Vérification du serveur de comptes…"
        : showSetup ? "Le serveur est prêt. Créez votre premier compte administrateur ci-dessous."
          : "Connectez-vous avec votre compte ou créez-en un avec le code transmis par le propriétaire.";
  $("#login-form").hidden = showSetup || registerMode;
  $("#register-form").hidden = showSetup || !registerMode;
  $("#auth-mode-toggle").hidden = showSetup;
  $("#auth-heading").textContent = showSetup ? "Première installation" : registerMode ? "Créer un compte membre" : "Accéder à l’espace partagé";
  $("#auth-mode-toggle").textContent = registerMode ? "J’ai déjà un compte" : "Créer un compte avec une invitation";
  $("#account-summary").textContent = remoteSession
    ? `${remoteSession.name} · ${remoteSession.email} · ${remoteSession.workspace}`
    : "";
  const syncWarning = $("#sync-warning");
  syncWarning.hidden = !remoteSession || !pendingRemoteBoardIds.size;
  syncWarning.textContent = pendingRemoteBoardIds.size
    ? `Conflit de synchronisation : ouvrez Mon compte puis choisissez « Recharger la copie serveur » pour récupérer la version partagée. Exportez d’abord votre copie si vous souhaitez conserver vos modifications locales.`
    : "";
  $("#invite-create").hidden = remoteSession?.role !== "owner";
  $("#backup-controls").hidden = remoteSession?.role !== "owner";
  $("#import-local").hidden = $("#import-local").dataset.available !== "true" || Boolean(!remoteSession);
  $("#publish-local-copy").hidden = !remoteSession || !pendingRemoteBoardIds.size;
  $("#reload-shared-copy").hidden = !remoteSession || !pendingRemoteBoardIds.size;
  $("#invite-display").hidden = !inviteCodeValue;
  $("#invite-code").value = inviteCodeValue;
  $("#login-form").querySelectorAll("input,button").forEach((input) => { input.disabled = apiState !== "ready"; });
  $("#register-form").querySelectorAll("input,button").forEach((input) => { input.disabled = apiState !== "ready"; });
}

function renderMembers() {
  const list = $("#member-list");
  list.replaceChildren();
  if (!members.length) {
    list.append(emptyMessage("Aucun profil pour le moment.", "Ajoutez les personnes qui participeront au projet."));
    return;
  }
  if (selectedMember) {
    const selected = getMember(selectedMember);
    if (!selected) selectedMember = null;
    else {
      const back = document.createElement("button");
      back.type = "button";
      back.className = "profile-back";
      back.textContent = "← Toute l’équipe";
      back.addEventListener("click", () => { selectedMember = null; renderTeam(); });
      list.append(back, createMemberRow(selected, true));
      const tasks = allTasks().filter((task) => task.assigneeId === selected.id);
      const title = document.createElement("h4");
      title.className = "profile-subhead";
      title.textContent = `Tâches de ${selected.name.split(" ")[0]}`;
      list.append(title, ...tasks.map(renderProfileTask));
      if (!tasks.length) list.append(emptyMessage("Pas encore de tâche assignée.", "Les tâches assignées apparaîtront ici."));
      return;
    }
  }
  members.forEach((member) => list.append(createMemberRow(member, false)));
}

function createMemberRow(member, profileView) {
  const row = document.createElement("div");
  row.className = "member-row";
  const avatar = document.createElement("button");
  avatar.type = "button";
  avatar.className = "member-avatar";
  avatar.textContent = avatarInitials(member.name);
  avatar.style.setProperty("--member-color", member.color);
  avatar.setAttribute("aria-label", `Profil de ${member.name}`);
  avatar.addEventListener("click", () => { selectedMember = member.id; renderTeam(); });
  const copy = document.createElement("div");
  copy.className = "member-copy";
  const name = document.createElement("input");
  name.className = "member-name-edit";
  name.value = member.name;
  name.maxLength = 80;
  name.setAttribute("aria-label", `Nom de ${member.name}`);
  const role = document.createElement("input");
  role.className = profileView ? "member-role-edit" : "member-role-edit role-tag";
  role.value = member.role;
  role.maxLength = 40;
  role.setAttribute("aria-label", `Rôle de ${member.name}`);
  const canEditName = !remoteSession || remoteSession.role === "owner" || member.id === `user:${remoteSession.id}`;
  const canEditTag = !remoteSession || remoteSession.role === "owner";
  name.disabled = !canEditName;
  role.disabled = !canEditTag;
  if (!remoteSession) [name, role].forEach((input) => input.addEventListener("focus", snapshotState, { once: true }));
  name.addEventListener("input", () => {
    member.name = name.value;
    name.setAttribute("aria-label", `Nom de ${member.name || "ce membre"}`);
    avatar.textContent = avatarInitials(member.name);
    avatar.setAttribute("aria-label", `Profil de ${member.name}`);
    renderRailAvatars();
    renderAssigneeOptions();
    renderTasks();
    const subhead = $(".profile-subhead");
    if (profileView && subhead) subhead.textContent = `Tâches de ${member.name.split(" ")[0] || member.name}`;
    if (remoteSession) scheduleRemoteMemberSave(member);
    else scheduleSave();
  });
  role.addEventListener("input", () => {
    member.role = role.value;
    role.setAttribute("aria-label", `Rôle de ${member.name || "ce membre"}`);
    renderRailAvatars();
    renderAssigneeOptions();
    renderTasks();
    if (remoteSession) scheduleRemoteMemberSave(member);
    else scheduleSave();
  });
  copy.append(name, role);
  const color = document.createElement("input");
  color.type = "color";
  color.className = "member-color";
  color.value = member.color;
  color.setAttribute("aria-label", `Couleur de ${member.name}`);
  color.disabled = !canEditTag;
  if (!remoteSession) color.addEventListener("focus", snapshotState, { once: true });
  color.addEventListener("input", () => {
    member.color = color.value;
    avatar.style.setProperty("--member-color", member.color);
    document.querySelectorAll(`[data-assignee-color="${member.id}"]`).forEach((node) => node.style.setProperty("--member-color", member.color));
    renderRailAvatars();
    if (remoteSession) scheduleRemoteMemberSave(member);
    else scheduleSave();
  });
  const open = document.createElement("button");
  open.type = "button";
  open.className = "member-open";
  open.textContent = "›";
  open.setAttribute("aria-label", `Voir le profil de ${member.name}`);
  open.addEventListener("click", () => { selectedMember = member.id; renderTeam(); });
  row.append(avatar, copy, color);
  if (!profileView) row.append(open);
  return row;
}

function renderRailAvatars() {
  const avatars = $("#rail-avatars");
  avatars.replaceChildren();
  members.slice(0, 4).forEach((member) => {
    const avatar = document.createElement("button");
    avatar.type = "button";
    avatar.className = "member-avatar";
    avatar.textContent = avatarInitials(member.name);
    avatar.title = `${member.name} · ${member.role}`;
    avatar.style.setProperty("--member-color", member.color);
    avatar.addEventListener("click", () => { selectedMember = member.id; teamPanel.hidden = false; renderTeam(); });
    avatars.append(avatar);
  });
}

function renderAssigneeOptions() {
  const selects = [
    $('#task-form select[name="assignee"]'),
    ...canvas.querySelectorAll('.todo-meta select[aria-label="Membre assigné"]'),
  ].filter(Boolean);
  selects.forEach((select) => {
    const previous = select.value;
    select.replaceChildren(new Option(select.closest("#task-form") ? "Sans assignation" : "Non assignée", ""));
    members.forEach((member) => select.add(new Option(`${member.name} · ${member.role}`, member.id)));
    if (members.some((member) => member.id === previous)) select.value = previous;
  });
}

function renderProfileTask(task) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `profile-task status-${task.status || "todo"}`;
  button.innerHTML = `<span class="task-status-mark"></span><span></span><small></small>`;
  $("span:nth-child(2)", button).textContent = task.title || "Tâche sans titre";
  $("small", button).textContent = `${statusLabel(task.status)} · ${task.boardTitle}`;
  button.addEventListener("click", () => jumpToTask(task.boardId, task.id));
  return button;
}

function statusLabel(status) {
  return ({ todo: "À faire", doing: "En cours", done: "Terminée" })[status] || "À faire";
}

function renderTasks() {
  const list = $("#task-list");
  list.replaceChildren();
  const tasks = allTasks().filter((task) => taskFilter === "all" || task.status === taskFilter);
  if (!tasks.length) {
    list.append(emptyMessage(taskFilter === "done" ? "Aucune tâche terminée." : "Aucune tâche ici.", "Créez une tâche et assignez-la à un membre."));
    return;
  }
  tasks.forEach((task) => {
    const row = document.createElement("div");
    row.className = `task-row status-${task.status || "todo"}`;
    const check = document.createElement("button");
    check.type = "button";
    check.className = "task-status-mark";
    check.textContent = task.status === "done" ? "✓" : "";
    check.setAttribute("aria-label", task.status === "done" ? "Marquer à faire" : "Marquer terminée");
    check.addEventListener("click", () => updateTaskStatus(task, task.status === "done" ? "todo" : "done"));
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "task-copy";
    const title = document.createElement("strong");
    title.textContent = task.title || "Tâche sans titre";
    const meta = document.createElement("span");
    const assignee = getMember(task.assigneeId);
    meta.textContent = `${assignee ? assignee.name : "Non assignée"} · ${task.boardTitle}`;
    if (assignee) {
      meta.dataset.assigneeColor = assignee.id;
      meta.style.setProperty("--member-color", assignee.color);
    }
    copy.append(title, meta);
    copy.addEventListener("click", () => jumpToTask(task.boardId, task.id));
    const state = document.createElement("select");
    state.className = "task-state-select";
    state.setAttribute("aria-label", `État de ${task.title || "la tâche"}`);
    [["todo", "À faire"], ["doing", "En cours"], ["done", "Terminée"]].forEach(([value, label]) => state.add(new Option(label, value, false, task.status === value)));
    state.addEventListener("change", () => updateTaskStatus(task, state.value));
    row.append(check, copy, state);
    list.append(row);
  });
}

function emptyMessage(titleText, detailText) {
  const node = document.createElement("div");
  node.className = "team-empty";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const detail = document.createElement("span");
  detail.textContent = detailText;
  node.append(title, detail);
  return node;
}

function updateTaskStatus(task, status) {
  const record = boardRecords.get(task.boardId);
  const targetBoard = task.boardId === board.id ? board : record;
  const card = targetBoard?.items.find((candidate) => candidate.id === task.id);
  const item = task.entryId ? card?.entries?.find((entry) => entry.id === task.entryId) : card;
  if (!item) return;
  snapshotState();
  item.status = status;
  if (task.entryId) updateChecklistStatus(card);
  if (targetBoard.id === board.id) renderBoard();
  else {
    boardRecords.set(targetBoard.id, structuredClone(targetBoard));
    renderTeam();
  }
  persistRecords([targetBoard, { id: WORKSPACE_ID, members }]).then(() => setSaveStatus("Enregistré")).catch(reportSaveError);
}

function jumpToTask(boardId, taskId) {
  teamPanel.hidden = true;
  if (board.id !== boardId) openBoard(boardId);
  const task = board.items.find((item) => item.id === taskId);
  if (!task) return;
  focusWorldPoint(task.x, task.y);
  requestAnimationFrame(() => {
    const card = canvas.querySelector(`[data-id="${CSS.escape(taskId)}"]`);
    if (card) focusSelectedCard(card);
  });
}

function reportSaveError(error) {
  console.error("Échec de la sauvegarde.", error);
  setSaveStatus("Non enregistré", "has-error");
  showToast(remoteSession
    ? error.localBackupSaved
      ? `Synchronisation refusée : ${error.message}. Une copie locale est conservée.`
      : `Sauvegarde impossible : ${error.message}. Exportez la copie encore ouverte avant de quitter.`
    : "Impossible d’enregistrer. Vérifiez le stockage local.");
}

async function addMemberFromForm(event) {
  event.preventDefault();
  showToast("Les comptes membres se créent avec un code d’invitation transmis par le propriétaire.");
}

function addTaskFromForm(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const title = String(data.get("title") || "").trim();
  if (!title) return;
  addTask(viewportCenter(), { title, assigneeId: String(data.get("assignee") || "") || null });
  event.currentTarget.reset();
  event.currentTarget.hidden = true;
  showToast("Tâche créée sur le tableau.");
}

function handleUndo() {
  if (!history.length) return;
  redoHistory.push(structuredClone({ boards: allStoredBoards(), members, activeBoardId: board.id }));
  const previous = history.pop();
  restoreHistoryState(previous);
  updateHistoryButtons();
}

function handleRedo() {
  if (!redoHistory.length) return;
  history.push(structuredClone({ boards: allStoredBoards(), members, activeBoardId: board.id }));
  const next = redoHistory.pop();
  restoreHistoryState(next);
  updateHistoryButtons();
}

function renderAfterBoardSwitch(record) {
  board = normalizeBoard(record);
  renderBoard();
  requestAnimationFrame(() => {
    viewport.scrollLeft = board.viewX;
    viewport.scrollTop = board.viewY;
  });
}

function initEvents() {
  const railToggle = $("#rail-toggle");
  const railQuery = window.matchMedia("(max-width: 950px)");
  const updateRailToggle = () => {
    const collapsed = railQuery.matches || $(".app-shell").classList.contains("is-rail-collapsed");
    const label = collapsed ? "Déployer le panneau d’outils" : "Réduire le panneau d’outils";
    railToggle.hidden = railQuery.matches;
    railToggle.setAttribute("aria-expanded", String(!collapsed));
    railToggle.setAttribute("aria-label", label);
    railToggle.title = label;
  };
  railToggle.addEventListener("click", () => {
    $(".app-shell").classList.toggle("is-rail-collapsed");
    updateRailToggle();
  });
  updateRailToggle();
  $("#empty-add-note").addEventListener("click", () => addNote());
  $("#tool-note").addEventListener("click", () => addNote());
  $("#tool-link").addEventListener("click", () => addLink());
  $("#tool-todo").addEventListener("click", () => addTask());
  $("#tool-checklist").addEventListener("click", () => addTask(viewportCenter(), { entries: [{ text: "", done: false }] }));
  $("#tool-board").addEventListener("click", () => addNestedBoard());
  $("#tool-image").addEventListener("click", () => imageInput.click());
  audioInput.accept = AUDIO_ACCEPT;
  $("#tool-audio").addEventListener("click", () => audioInput.click());
  $("#tool-trash").addEventListener("click", confirmEmptyBoard);
  $("#import-button").addEventListener("click", showImportNotice);
  $("#help-button").addEventListener("click", showCurrentStorageNotice);
  $("#help-link").addEventListener("click", (event) => { event.preventDefault(); showCurrentStorageNotice(); });
  $("#share-button").addEventListener("click", showCurrentStorageNotice);
  $("#export-button").addEventListener("click", exportWorkspace);
  $("#undo-button").addEventListener("click", handleUndo);
  $("#redo-button").addEventListener("click", handleRedo);
  $("#zoom-in").addEventListener("click", () => adjustZoom(.1));
  $("#zoom-out").addEventListener("click", () => adjustZoom(-.1));
  $("#fit-board").addEventListener("click", fitBoardContent);
  $("#board-picker").addEventListener("change", (event) => openBoard(event.target.value));
  $("#sync-now").addEventListener("click", () => {
    if (!remoteSession) {
      showToast("Connectez-vous pour synchroniser les tableaux de votre équipe.");
      return;
    }
    syncRemoteChanges();
  });
  $("#delete-vector-button").addEventListener("click", deleteSelectedVector);
  for (const [selector, property] of [["#connector-curve", "curve"], ["#connector-color", "color"]]) {
    $(selector).addEventListener("focus", snapshotState);
    $(selector).addEventListener("input", (event) => {
      const selected = board.items.find((item) => item.id === selectedVectorId && item.type === "connector");
      if (!selected) return;
      selected[property] = property === "curve" ? Number(event.target.value) : event.target.value;
      renderVectorItems();
      scheduleSave();
    });
  }
  document.querySelectorAll(".rail-link[data-tool]").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
  $("#profile-button").addEventListener("click", () => {
    teamPanel.hidden = false;
    selectedMember = null;
    renderTeam();
  });
  $("#team-toggle").addEventListener("click", () => { teamPanel.hidden = !teamPanel.hidden; selectedMember = null; renderTeam(); });
  $("#team-close").addEventListener("click", () => { teamPanel.hidden = true; });
  $("#add-member-toggle").addEventListener("click", () => { $("#member-form").hidden = !$("#member-form").hidden; });
  $("#add-task-toggle").addEventListener("click", () => { $("#task-form").hidden = !$("#task-form").hidden; });
  $("#member-form").addEventListener("submit", addMemberFromForm);
  $("#task-form").addEventListener("submit", addTaskFromForm);
  $("#login-form").addEventListener("submit", (event) => submitAccountForm(event, "login"));
  $("#register-form").addEventListener("submit", (event) => submitAccountForm(event, "register"));
  $("#auth-retry").addEventListener("click", () => location.reload());
  $("#owner-setup-form").addEventListener("submit", submitOwnerSetup);
  $("#profile-photo").addEventListener("change", uploadProfilePhoto);
  $("#remove-profile-photo").addEventListener("click", () => saveProfilePhoto("").catch((error) => showToast(`Photo non enregistrée : ${error.message}`)));
  $("#auth-mode-toggle").addEventListener("click", () => { registerMode = !registerMode; renderAuthControls(); });
  $("#logout-button").addEventListener("click", signOutAccount);
  $("#invite-create").addEventListener("click", createInviteCode);
  $("#publish-local-copy").addEventListener("click", () => confirmConflictResolution("publish"));
  $("#reload-shared-copy").addEventListener("click", () => confirmConflictResolution("reload"));
  $("#backup-approve").addEventListener("click", () => prepareBackupAction("approve"));
  $("#backup-restore").addEventListener("click", () => prepareBackupAction("restore"));
  $("#backup-undo-restore").addEventListener("click", () => prepareBackupAction("restore", "before_restore"));
  $("#invite-copy").addEventListener("click", async () => {
    const input = $("#invite-code");
    try {
      await navigator.clipboard.writeText(input.value);
      showToast("Code d’invitation copié.");
    } catch {
      input.focus();
      input.select();
      showToast("Sélectionnez le code pour le copier manuellement.");
    }
  });
  $("#import-local").addEventListener("click", () => {
    pendingConfirm = importLocalBoards;
    showDialog("Importer les tableaux locaux ?", "Une copie des tableaux enregistrés sur cet appareil sera ajoutée à l’espace partagé.", "Aucun tableau local ne sera supprimé. Les autres membres pourront voir les tableaux importés.", "Importer les tableaux");
  });
  document.querySelectorAll(".filter-chip").forEach((button) => button.addEventListener("click", () => {
    taskFilter = button.dataset.filter;
    document.querySelectorAll(".filter-chip").forEach((chip) => chip.classList.toggle("is-active", chip === button));
    renderTasks();
  }));
  $("#dialog-dismiss").addEventListener("click", () => infoDialog.close());
  $("#dialog-close").addEventListener("click", () => infoDialog.close());
  $("#dialog-done").addEventListener("click", () => infoDialog.close());
  $("#dialog-confirm").addEventListener("click", () => {
    pendingConfirm?.();
    pendingConfirm = null;
    infoDialog.close();
  });

  canvas.addEventListener("pointerdown", (event) => {
    if (activeTool !== "select" || spacePressed || event.button !== 0) return;
    const card = event.target.closest(".board-card");
    if (!card) return;
    startCardDrag(event, card);
  });
  canvas.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const card = button.closest(".board-card");
    const item = board.items.find((candidate) => candidate.id === card?.dataset.id);
    if (!item) return;
    if (button.dataset.action === "delete") {
      snapshotState();
      board.items = board.items.filter((candidate) => candidate.id !== item.id);
      renderBoard();
      scheduleSave();
    } else if (button.dataset.action === "open-board") {
      openBoard(item.boardId);
    } else if (button.dataset.action === "choose-cover") {
      card.querySelector(".nested-board-cover-input")?.click();
    } else if (button.dataset.action === "remove-cover") {
      snapshotState();
      delete item.coverImage;
      delete item.coverImageName;
      renderBoard();
      scheduleSave();
    } else if (button.dataset.action === "zoom-in" || button.dataset.action === "zoom-out") {
      snapshotState();
      item.imageZoom = Math.max(1, Math.min(7, Math.round(((item.imageZoom ?? 1) + (button.dataset.action === "zoom-in" ? .35 : -.35)) * 10) / 10));
      applyImageTransform(card.querySelector(".image-plate"), item);
      scheduleSave();
    } else if (button.dataset.action === "fit-image") {
      snapshotState();
      item.imageZoom = 1;
      item.imagePanX = 0;
      item.imagePanY = 0;
      applyImageTransform(card.querySelector(".image-plate"), item);
      scheduleSave();
    } else if (button.dataset.action === "rotate-left" || button.dataset.action === "rotate-right") {
      snapshotState();
      const delta = button.dataset.action === "rotate-right" ? 90 : -90;
      item.imageRotation = normalizedImageRotation((item.imageRotation ?? 0) + delta);
      applyImageTransform(card.querySelector(".image-plate"), item);
      scheduleSave();
    }
  });

  viewport.addEventListener("contextmenu", (event) => {
    const vector = event.target.closest?.(".vector-hit-area");
    if (vector) {
      event.preventDefault();
      selectVector(vector.dataset.id);
      openCardMenu(event.clientX, event.clientY, null);
      return;
    }
    const card = event.target.closest(".board-card");
    const editable = event.target.closest("input, textarea, select, [contenteditable='true']");
    const selection = window.getSelection();
    const inNote = Boolean(selection && !selection.isCollapsed && selection.anchorNode?.parentElement?.closest?.(".note-body"));
    if (editable && !inNote) return;
    event.preventDefault();
    if (card) {
      if (selectedVectorId) {
        selectedVectorId = null;
        renderVectorItems();
      }
      if (!selectedCardIds.has(card.dataset.id)) {
        selectedCardIds = new Set([card.dataset.id]);
        applyCardSelection();
      }
      openCardMenu(event.clientX, event.clientY, card);
    } else {
      clearCardSelection();
      if (selectedVectorId) {
        selectedVectorId = null;
        renderVectorItems();
      }
      openCardMenu(event.clientX, event.clientY, null);
    }
  });
  const cardMenu = $("#card-menu");
  cardMenu.addEventListener("click", (event) => {
    const fontButton = event.target.closest("[data-font-step]");
    if (fontButton && !fontButton.disabled) {
      const context = cardMenuContext;
      if (context) applyNoteFontStep(context.noteEditor, Number(fontButton.dataset.fontStep), context.range);
      closeCardMenu();
      return;
    }
    const action = event.target.closest("[data-menu-action]");
    if (!action || action.disabled) return;
    const command = action.dataset.menuAction;
    closeCardMenu();
    if (command === "copy") copySelection();
    else if (command === "cut") copySelection({ cut: true });
    else if (command === "paste") pasteClipboard();
    else if (command === "duplicate") duplicateSelection();
    else if (command === "delete") deleteSelection();
  });
  document.addEventListener("pointerdown", (event) => {
    const menu = $("#card-menu");
    if (menu && !menu.hidden && !event.target.closest("#card-menu")) closeCardMenu();
  });

  viewport.addEventListener("mousedown", (event) => {
    if (event.button === 1) event.preventDefault();
  });
  viewport.addEventListener("pointerdown", (event) => {
    if (marqueeGesture) return;
    if (event.button === 1 || (event.button === 0 && spacePressed)) {
      beginPan(event);
      return;
    }
    if (activeTool !== "select") {
      beginVector(event);
      return;
    }
    const onCanvasControl = event.target.closest(".board-card, .vector-hit-area, .connector-anchor-handle, button, input, textarea, select, a, audio");
    if (event.button === 0 && event.pointerType !== "touch" && !onCanvasControl) {
      beginMarquee(event);
      return;
    }
    if (event.button === 0 && !event.target.closest(".board-card, .vector-hit-area, .connector-anchor-handle")) {
      clearCardSelection();
      if (selectedVectorId) {
        selectedVectorId = null;
        renderVectorItems();
      }
    }
    beginPan(event);
  });
  viewport.addEventListener("pointermove", (event) => {
    if (marqueeGesture) moveMarquee(event);
    if (panGesture) panMove(event);
    if (drawingGesture || connectionGesture || connectorResizeGesture) moveVector(event);
  });
  const endViewportPointer = (event) => {
    if (marqueeGesture) endMarquee();
    if (panGesture) {
      panGesture = null;
      viewport.classList.remove("is-panning");
      updateViewSave();
    }
    if (connectorResizeGesture && connectorResizeGesture.pointerId === event.pointerId) {
      connectorResizeGesture = null;
      scheduleSave();
    }
    if (drawingGesture || connectionGesture) endVector(event.type === "pointerup" ? event : null);
  };
  viewport.addEventListener("pointerup", endViewportPointer);
  viewport.addEventListener("pointercancel", endViewportPointer);

  viewport.addEventListener("scroll", () => {
    board.viewX = viewport.scrollLeft;
    board.viewY = viewport.scrollTop;
    clearTimeout(edgeTimer);
    edgeTimer = setTimeout(() => {
      ensureInfiniteSpace();
      saveAfterQuietScroll();
    }, 100);
  });
  viewport.addEventListener("dragenter", (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
    event.preventDefault();
    $("#drop-overlay").classList.add("is-visible");
  });
  viewport.addEventListener("dragover", (event) => {
    if (Array.from(event.dataTransfer?.types || []).includes("application/x-pixelboard-item")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      return;
    }
    if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
    event.preventDefault();
    $("#drop-overlay").classList.add("is-visible");
  });
  viewport.addEventListener("dragleave", (event) => {
    if (!viewport.contains(event.relatedTarget)) $("#drop-overlay").classList.remove("is-visible");
  });
  viewport.addEventListener("drop", async (event) => {
    const itemData = event.dataTransfer?.getData("application/x-pixelboard-item");
    if (itemData) {
      event.preventDefault();
      try {
        const reference = JSON.parse(itemData);
        addItemReference(reference.projectId, reference.itemId, worldPoint(event));
      } catch (error) { showToast(`Placement impossible : ${error.message}`); }
      return;
    }
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    $("#drop-overlay").classList.remove("is-visible");
    try { await addMediaFiles(event.dataTransfer.files, event.clientX, event.clientY); }
    catch (error) { showToast(`Ajout impossible : ${error.message}`); }
  });
  imageInput.addEventListener("change", async () => {
    try { await addImageFiles(imageInput.files); }
    catch (error) { showToast(`Ajout impossible : ${error.message}`); }
    finally { imageInput.value = ""; }
  });
  audioInput.addEventListener("change", async () => {
    try { await addMediaFiles(audioInput.files); }
    catch (error) { showToast(`Ajout impossible : ${error.message}`); }
    finally { audioInput.value = ""; }
  });
  viewport.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    adjustZoom(event.deltaY < 0 ? .08 : -.08, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeCardMenu();
      clearCardSelection();
      if (selectedVectorId) {
        selectedVectorId = null;
        renderVectorItems();
      }
    }
    if (!remoteSession) return;
    const editing = isTextEditingTarget(event.target);
    if (event.code === "Space" && !editing) {
      spacePressed = true;
      viewport.classList.add("is-space-ready");
    }
    if ((event.key === "Delete" || event.key === "Backspace") && !editing) {
      if (selectedVectorId) {
        event.preventDefault();
        deleteSelectedVector();
        return;
      }
      if (selectedCardIds.size) {
        event.preventDefault();
        deleteSelection();
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && !editing) {
      const key = event.key.toLowerCase();
      if (key === "c" && copySelection()) event.preventDefault();
      else if (key === "x" && copySelection({ cut: true })) event.preventDefault();
      else if (key === "v" && pasteClipboard()) event.preventDefault();
      else if (key === "d" && duplicateSelection()) event.preventDefault();
      else if (key === "a") {
        event.preventDefault();
        selectedVectorId = null;
        selectedCardIds = new Set(board.items
          .filter((item) => !["connector", "drawing"].includes(item.type))
          .map((item) => item.id));
        applyCardSelection();
        renderVectorItems();
      } else if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) handleRedo(); else handleUndo();
      } else if (key === "y") {
        event.preventDefault();
        handleRedo();
      }
    }
  });
  window.addEventListener("keyup", (event) => {
    if (event.code !== "Space") return;
    spacePressed = false;
    viewport.classList.remove("is-space-ready");
  });
  window.addEventListener("blur", () => {
    spacePressed = false;
    viewport.classList.remove("is-space-ready");
  });
  window.addEventListener("resize", () => {
    closeCardMenu();
    updateZoom();
    updateRailToggle();
  });
}

async function start() {
  try {
    db = await openDatabase();
    const records = await readAllRecords();
    localWorkspaceRecords(records).forEach((record) => boardRecords.set(record.id, normalizeBoard(record)));
    const meta = records.find((record) => record.id === WORKSPACE_ID);
    members = Array.isArray(meta?.members) ? meta.members : defaultMembers();
    board = normalizeBoard(boardRecords.get(ROOT_ID) || makeDefaultBoard());
    boardRecords.set(board.id, structuredClone(board));
    lastZIndex = Math.max(5, ...allStoredBoards().flatMap((record) => record.items.map((item) => item.z ?? 1)));
    await writeRecords([board, { id: WORKSPACE_ID, members }]);
    try {
      const auth = await apiRequest("auth");
      setupAvailable = auth.setup_available === true;
      apiReady = true;
      apiState = "ready";
      if (auth.user) await loadRemoteWorkspace(auth, records);
      lastZIndex = Math.max(5, ...allStoredBoards().flatMap((record) => record.items.map((item) => item.z ?? 1)));
    } catch (error) {
      remoteSession = null;
      apiReady = false;
      if (error.apiMissing) {
        apiState = "missing";
      } else {
        apiState = "error";
        apiMessage = error.message;
        console.error("Serveur équipe indisponible.", error);
      }
      boardRecords = new Map(localWorkspaceRecords(records).map((record) => [record.id, normalizeBoard(record)]));
      const meta = records.find((record) => record.id === WORKSPACE_ID);
      members = Array.isArray(meta?.members) ? meta.members : defaultMembers();
      board = normalizeBoard(boardRecords.get(ROOT_ID) || makeDefaultBoard());
      boardRecords.set(board.id, structuredClone(board));
    }
    renderBoard();
    updateHistoryButtons();
    requestAnimationFrame(() => {
      viewport.scrollLeft = board.viewX;
      viewport.scrollTop = board.viewY;
    });
  } catch (error) {
    console.error("Impossible d’ouvrir l’espace de travail.", error);
    apiReady = false;
    apiState = "error";
    apiMessage = "Le stockage local de ce navigateur est indisponible.";
    board = makeDefaultBoard();
    members = defaultMembers();
    boardRecords.set(board.id, board);
    renderBoard();
    setSaveStatus("Stockage indisponible", "has-error");
    showToast("Le navigateur ne permet pas l’enregistrement local. Vos modifications ne seront pas conservées.");
  }
  initEvents();
  setTool(activeTool);
  itemsUI = initItemsUI({
    api: apiRequest, session: () => remoteSession, records: allStoredBoards,
    version: (id) => remoteVersions.get(id) || 0,
    flush: saveImmediately,
    addReference: (projectId, itemId) => {
      try { addItemReference(projectId, itemId); }
      catch (error) { showToast(error.message); }
    },
    confirm: (title, text, action) => {
      pendingConfirm = action;
      showDialog(title, text, "Aucun asset Unity n’est supprimé automatiquement.", "Confirmer");
    },
    save: async (record) => {
      if (!remoteSession) throw new Error("Connectez-vous avant de modifier le catalogue.");
      if (remoteWritesInFlight || remoteSyncInFlight || backupBusy) throw new Error("Synchronisation en cours. Réessayez dans un instant.");
      snapshotState();
      boardRecords.set(record.id, structuredClone(record));
      await persistRecords([record]);
      renderBoard();
    },
  });
  renderTeam();
}

start();
