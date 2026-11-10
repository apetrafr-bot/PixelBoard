import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
function load(name, context) {
  const start = source.indexOf(`function ${name}(`);
  vm.runInContext(source.slice(start, source.indexOf("\nfunction ", start + 1)), context);
}
function fixture(width = 300, height = 200, rotation = 0, naturalWidth = 100, naturalHeight = 100) {
  const image = { naturalWidth, naturalHeight, style: { setProperty() {} } };
  const plate = { clientWidth: width, clientHeight: height, dataset: { rotation: String(rotation) }, classList: { toggle() {} } };
  const context = vm.createContext({ $: () => image });
  for (const name of ["normalizedImageRotation", "imageElementMetrics", "imagePanLimits", "clampImagePan", "applyImageTransform"]) load(name, context);
  return { context, plate, image };
}

test("zoomed image reaches every crop edge instead of the old zoom-only cap", () => {
  for (const rotation of [0, 90, 180, 270]) {
    const { context, plate } = fixture(300, 200, rotation);
    const item = { imageZoom: 4, imageRotation: rotation, imagePanX: 100, imagePanY: -100 };
    context.applyImageTransform(plate, item);
    const limits = context.imagePanLimits(plate, item);
    assert.ok(limits.x > .45 && limits.y > .45, "old cap blocked access to outer pixels");
    const metrics = context.imageElementMetrics(plate);
    assert.equal(item.imagePanX * metrics.elementWidth, 250);
    assert.equal(item.imagePanY * metrics.elementHeight, -300);
  }
});

test("crop limits follow aspect ratio, quarter turns, frame resize and unloaded images", () => {
  const { context, plate, image } = fixture(400, 200, 0, 800, 200);
  const item = { imageZoom: 3, imagePanX: 5, imagePanY: 5 };
  context.applyImageTransform(plate, item);
  assert.equal(item.imagePanX, 1);
  assert.equal(item.imagePanY, .25);
  plate.clientWidth = 200;
  plate.clientHeight = 400;
  context.applyImageTransform(plate, item);
  assert.equal(item.imagePanX, 1);
  assert.equal(item.imagePanY, 0, "letterboxed axis is centered, not allowed to lose the image");
  item.imageRotation = 90;
  context.applyImageTransform(plate, item);
  assert.equal(context.imagePanLimits(plate, item).x, .125);
  image.naturalWidth = 0;
  item.imagePanX = .1;
  assert.equal(context.clampImagePan(item, plate), null);
  assert.equal(item.imagePanX, .1, "pending image decode never destroys saved crop");
});

test("card movement after resize stays unbounded in world coordinates at every canvas zoom", () => {
  for (const zoom of [.3, 1, 2.4]) {
    for (const position of [-800, 0, 2400]) {
      const listeners = {};
      const item = { id: "image", x: position, y: position, width: 900, height: 700 };
      const card = { dataset: { id: item.id }, style: {}, closest() { return this; },
        setPointerCapture() {}, addEventListener(name, fn) { listeners[name] = fn; }, removeEventListener() {} };
      const context = vm.createContext({
        board: { items: [item], zoom }, selectedCardIds: new Set([item.id]),
        selectedCards: () => [item], canvas: { querySelector: () => card }, CSS: { escape: (value) => value },
        applyCardSelection() {}, snapshotState() {}, ensureItemBounds() {}, updateCardConnectors() {}, scheduleSave() {},
      });
      load("startCardDrag", context);
      context.startCardDrag({ button: 0, target: { closest() { return null; } }, clientX: 100, clientY: 200, pointerId: 1, preventDefault() {} }, card);
      listeners.pointermove({ clientX: 100 - 200 * zoom, clientY: 200 + 120 * zoom });
      assert.equal(item.x, position - 200);
      assert.equal(item.y, position + 120);
      assert.equal(item.width, 900);
      listeners.pointerup();
    }
  }
});
