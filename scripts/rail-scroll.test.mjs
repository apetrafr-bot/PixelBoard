import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createServer } from "vite";

const edge = path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe");
const hasEdge = process.platform === "win32" && await access(edge).then(() => true, () => false);

test("rail wheel scroll stays local while canvas pan and zoom remain usable", { skip: !hasEdge, timeout: 45000 }, async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "pixelboard-rail-"));
  const original = {
    id: "atelier-personnel", title: "Wheel fixture", zoom: 1, viewX: 1500, viewY: 1000,
    items: [{ id: "note", type: "note", x: 70, y: 70, width: 300, height: 220, title: "Unchanged", body: "Wheel fixture" }],
  };
  const user = { id: 1, workspace_id: 1, display_name: "Fixture", role: "member", email: "fixture@example.test" };
  let puts = 0, browser, socket, sessionId, nextId = 0;
  const pending = new Map(), exceptions = [];
  const server = await createServer({
    root: path.resolve("."), logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "rail-fixture",
      configureServer(vite) {
        vite.middlewares.use("/api/index.php", (req, res) => {
          const action = new URL(req.url, "http://fixture").searchParams.get("action");
          let data;
          if (action === "auth") data = { user, csrf: "fixture", workspace: { name: "Fixture" } };
          else if (action === "members") data = { members: [user] };
          else if (action === "boards") data = { boards: [{ id: original.id, version: 1, data: original }] };
          else { if (req.method === "PUT") puts++; res.statusCode = 400; data = { error: "Unexpected fixture request" }; }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        });
      },
    }],
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  try {
    await server.listen();
    browser = spawn(edge, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
      catch (error) { if (error.code !== "ENOENT") throw error; await sleep(50); }
    }
    assert.ok(port, "Edge must expose the isolated debugging port");
    const metadata = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    socket = new WebSocket(metadata.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(Error(message.error.message));
      else call.resolve(message.result);
    };
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
    await send("Runtime.enable");
    await send("Page.navigate", { url: `http://127.0.0.1:${server.httpServer.address().port}` });
    for (let i = 0; i < 150; i++) {
      if (await evaluate("!!document.querySelector('.note-title') && !document.body.classList.contains('auth-locked')")) break;
      await sleep(50);
    }
    assert.equal(await evaluate("document.body.classList.contains('auth-locked')"), false);
    for (const [width, height] of [[1440, 500], [390, 600]]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await evaluate("document.querySelector('#fit-board').click()");
      await sleep(300);
      const state = () => evaluate(`(()=>{
        const view=document.querySelector('#canvas-viewport'), card=document.querySelector('.board-card').getBoundingClientRect();
        return {pageX:scrollX,pageY:scrollY,x:view.scrollLeft,y:view.scrollTop,zoom:document.querySelector('#zoom-level').textContent,
          cardX:card.x,cardY:card.y,title:document.querySelector('.note-title').value};
      })()`);
      const before = await state();
      const railPoint = await evaluate(`(()=>{const r=document.querySelector('.index-rail').getBoundingClientRect();return {x:r.left+r.width/2,y:150}})()`);
      const wheel = async (point, deltaY, modifiers = 0) => {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
        await send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY, modifiers });
        await sleep(180);
      };
      await wheel(railPoint, 500);
      assert.deepEqual(await state(), before, `rail scroll must not move page or board at ${width}px`);
      assert.ok(await evaluate("document.querySelector('.index-rail').scrollTop") > 0, "overflowing rail must scroll");
      await wheel(railPoint, 5000);
      await wheel(railPoint, 500);
      assert.deepEqual(await state(), before, "rail bottom must not chain to document or board");
      await wheel(railPoint, -5000);
      await wheel(railPoint, -500);
      assert.deepEqual(await state(), before, "rail top must not chain to document or board");
      if (process.env.PIXELBOARD_TEST_ARTIFACTS) {
        await writeFile(path.join(process.env.PIXELBOARD_TEST_ARTIFACTS, `rail-wheel-${width}.png`),
          Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
      }
      const canvasPoint = await evaluate(`(()=>{const r=document.querySelector('#canvas-viewport').getBoundingClientRect();return {x:r.right-40,y:r.top+100}})()`);
      await wheel(canvasPoint, 120);
      assert.notEqual((await state()).y, before.y, "normal canvas wheel still pans");
      const beforeZoom = (await state()).zoom;
      await wheel(canvasPoint, -120, 2);
      assert.notEqual((await state()).zoom, beforeZoom, "Ctrl+wheel on canvas still zooms");
      await sleep(650);
      assert.equal(puts, 0, "wheel navigation must not PUT board data");
      assert.equal(await evaluate("document.querySelector('.note-title').value"), "Unchanged");
      assert.deepEqual(await evaluate("(()=>{const c=document.querySelector('.board-card');return [c.offsetLeft,c.offsetTop]})()"), [70, 70]);
    }
    assert.deepEqual(exceptions, []);
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      await send("Browser.close");
      socket.close();
    }
    if (browser && browser.exitCode === null) await new Promise((resolve) => { browser.once("exit", resolve); setTimeout(resolve, 2000).unref(); });
    if (browser && browser.exitCode === null) browser.kill();
    await server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
