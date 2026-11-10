import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { audioMime, audioHeaderValid, prepareAudio, restoreAudio, MAX_AUDIO_BYTES } from "../src/audio.js";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const code = (name, next) => source.slice(source.indexOf(name), source.indexOf(next, source.indexOf(name)));
const wav = new Uint8Array(48);
wav.set(Buffer.from("RIFF"), 0); wav.set(Buffer.from("WAVE"), 8);
const file = (bytes = wav, name = "Ambiance.wav", type = "audio/wav") => new File([bytes], name, { type });
const dataUrl = async (blob) => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`;

test("audio validates bounded original bytes and canonicalizes supported MIME aliases", async () => {
  for (const [bytes, name, declared, expected] of [
    [wav, "s.wav", "audio/x-wav", "audio/wav"],
    [wav, "s.WAV", "", "audio/wav"],
    [Buffer.from("ID3abc"), "s.mp3", "audio/mp3", "audio/mpeg"],
    [new Uint8Array([255, 251, 144, 0]), "s.mp3", "audio/mpeg", "audio/mpeg"],
    [Buffer.from("OggSabc"), "s.ogg", "application/ogg", "audio/ogg"],
  ]) {
    const blob = await prepareAudio(file(bytes, name, declared));
    assert.equal(blob.type, expected);
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array(bytes));
    assert.deepEqual(new Uint8Array(await (await restoreAudio(await dataUrl(blob))).arrayBuffer()), new Uint8Array(bytes));
  }
  assert.equal(audioMime(file(wav, "s.wav", "text/html")), "text/html", "declared unsupported type is never trusted by extension");
  assert.equal(audioHeaderValid(new Uint8Array([255, 249, 0]), "audio/mpeg"), false);
  for (const invalid of [file([], "empty.wav"), file("not audio"), file(wav, "x.mp4", "audio/mp4"), file(new Uint8Array(MAX_AUDIO_BYTES + 1))]) {
    await assert.rejects(prepareAudio(invalid), /15 Mio|MP3, WAV ou OGG/);
  }
  await assert.rejects(restoreAudio("https://example.test/music.mp3"), /invalide/);
  await assert.rejects(restoreAudio("data:audio/wav;base64,AAAA"), /invalide/);
  await assert.rejects(restoreAudio("data:text/html;base64,AAAA"), /invalide/);
  const maximum = new Uint8Array(MAX_AUDIO_BYTES);
  maximum.set(wav.subarray(0, 12));
  assert.equal((await prepareAudio(file(maximum))).size, MAX_AUDIO_BYTES, "exact 15 Mio boundary is allowed");
});

test("audio serialization, remote reload and cache/export roundtrip retain bytes without external URLs", async () => {
  const record = { id: "board", items: [{ id: "sound", type: "audio", audio: await prepareAudio(file()), title: "Ambiance" }] };
  const context = vm.createContext({ structuredClone, Blob, restoreAudio, imageDataUrl: dataUrl, normalizeBoard: (value) => value });
  vm.runInContext(code("async function serializeBoard(", "\nfunction remoteMemberRecord("), context);
  const serialized = await context.serializeBoard(record);
  assert.match(serialized.items[0].audio, /^data:audio\/wav;base64,/);
  const reloaded = await context.deserializeBoard(JSON.parse(JSON.stringify(serialized)));
  assert.deepEqual(new Uint8Array(await reloaded.items[0].audio.arrayBuffer()), wav);
  assert.equal(reloaded.items[0].title, "Ambiance");
  assert.deepEqual(new Uint8Array(await structuredClone(reloaded).items[0].audio.arrayBuffer()), wav);
  assert.match(source, /memoryExport\(allStoredBoards\(\), members, WORKSPACE_ID, imageDataUrl\)/);
});

test("audio picker/drop batch validates before mutation, preserves mixed image uploads and rejects stale account/board", async () => {
  let snapshots = 0, renders = 0, saves = 0;
  const context = vm.createContext({
    Array, Number, Math, Error, audioMime, prepareAudio,
    board: { items: [] }, remoteSession: { id: 1 }, lastZIndex: 0,
    MIME_TYPES: new Set(["image/png"]), newId: () => crypto.randomUUID(),
    viewportCenter: () => ({ x: 100, y: 200 }), worldPoint: (value) => ({ x: value.clientX, y: value.clientY }),
    snapshotState: () => snapshots++, renderBoard: () => renders++, scheduleSave: () => saves++, showToast() {},
  });
  vm.runInContext(code("async function addMediaFiles(", "\nfunction startCardDrag("), context);
  await assert.rejects(context.addMediaFiles([file(), file("bad")]), /invalide/);
  assert.equal(context.board.items.length, 0);
  assert.equal(snapshots, 0);
  await context.addMediaFiles([file(), file("png", "Image.png", "image/png")], 50, 80);
  assert.equal(context.board.items[0].type, "audio");
  assert.equal(context.board.items[0].audio.type, "audio/wav");
  assert.equal(context.board.items[0].x, 50);
  assert.equal(context.board.items[1].type, "image");
  assert.equal(context.board.items[1].x, 86);
  assert.equal(snapshots, 1); assert.equal(renders, 1); assert.equal(saves, 1);
  const pending = context.addMediaFiles([file()]);
  context.remoteSession = { id: 2 };
  await assert.rejects(pending, /compte a changé/);
  assert.equal(context.board.items.length, 2);
});

test("audio card uses native accessible controls, explicit decode errors/retry, and isolates drag/keyboard", () => {
  const nodes = [];
  const create = (tag) => {
    const element = { tag, children: [], listeners: {}, attrs: {}, hidden: false,
      append(...children) { this.children.push(...children); },
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      load() { this.loaded = true; },
    };
    nodes.push(element); return element;
  };
  const context = vm.createContext({
    document: { createElement: create }, Blob, URL: { createObjectURL: () => "blob:local-sound" },
    createGripContent(item, type, content) { const title = create("input"); content.append(title); return title; },
  });
  vm.runInContext(code("function renderAudioCard(", "\nfunction safeColor("), context);
  const card = create("article");
  context.renderAudioCard(card, { title: "Ambiance", fileName: "ambiance.wav", audio: file() });
  const player = nodes.find((node) => node.tag === "audio");
  assert.equal(player.controls, true);
  assert.equal(player.preload, "metadata");
  assert.equal(player.autoplay, undefined);
  assert.equal(player.attrs["aria-label"], "Écouter Ambiance");
  let isolated = 0;
  player.listeners.pointerdown({ stopPropagation() { isolated++; } });
  player.listeners.keydown({ stopPropagation() { isolated++; } });
  assert.equal(isolated, 2);
  player.listeners.error();
  const status = nodes.find((node) => node.attrs.role === "status");
  const retry = nodes.find((node) => node.tag === "button");
  assert.match(status.textContent, /Lecture impossible/); assert.equal(retry.hidden, false);
  retry.listeners.click(); assert.equal(player.loaded, true);
  player.listeners.loadedmetadata(); assert.equal(retry.hidden, true);
  assert.match(source, /player\.pause\(\); URL\.revokeObjectURL\(player\.src\)/);
});
