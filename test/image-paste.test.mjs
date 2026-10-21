import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { jiti, piModule, tuiModule } from "./pi-host.mjs";

after(() => process.stdin.pause());
const { stripTerminalSequences } = await tuiModule("dist/utils.js");
const { loadExtensions } = await piModule("dist/core/extensions/loader.js");
const { StdinBuffer } = await tuiModule("dist/stdin-buffer.js");
const EXTENSION = fileURLToPath(new URL("../extensions/image-paste.ts", import.meta.url));

const { EnhancedPaste, Osc5522Input, PASTE_START, PASTE_END } = await jiti.import("../lib/core.ts");
const fixture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYvQAAAAASUVORK5CYII=", "base64");
const packet = (header, data = "", st = "\x07") => `\x1b]5522;type=read:${header};${data}${st}`;
const encoded = (text) => Buffer.from(text).toString("base64");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function transport() {
  const forwarded = [];
  const packets = [];
  const errors = [];
  const filter = new Osc5522Input({ forward: (text) => forwarded.push(text), packet: (text) => packets.push(text), error: (text) => errors.push(text) });
  return { filter, forwarded, packets, errors };
}

function controller() {
  const requests = [];
  const images = [];
  const texts = [];
  const errors = [];
  const enhanced = new EnhancedPaste({ write: (s) => requests.push(s), image: (i) => images.push(i), text: (s) => texts.push(s), error: (s) => errors.push(s) });
  return { enhanced, requests, images, texts, errors };
}

test("OSC 5522 lists MIME then assembles independent base64 chunks", () => {
  const t = controller();
  t.enhanced.handle(packet("status=OK:pw=abc123:loc=primary"));
  t.enhanced.handle(packet(`status=DATA:mime=${encoded("text/plain")}`));
  t.enhanced.handle(packet(`status=DATA:mime=${encoded("image/png")}`));
  t.enhanced.handle(packet("status=DONE"));
  assert.equal(t.requests.length, 1);
  assert.ok(t.requests[0].includes(`mime=${encoded("image/png")}`));
  assert.ok(t.requests[0].includes("pw=abc123"));
  assert.ok(t.requests[0].includes("loc=primary"));
  t.enhanced.handle(packet("status=OK")); // Read acknowledgement must not reset the read.
  const split = 19;
  t.enhanced.handle(packet(`status=DATA:mime=${encoded("image/png")}`, fixture.subarray(0, split).toString("base64")));
  t.enhanced.handle(packet(`status=DATA:mime=${encoded("image/png")}`, fixture.subarray(split).toString("base64")));
  t.enhanced.handle(packet("status=DONE"));
  assert.deepEqual(t.images[0].bytes, fixture);
  assert.equal(t.images[0].mimeType, "image/png");
  assert.equal(t.errors.length, 0);
});

test("Kitty dot-MIME form and text clipboard", () => {
  const t = controller();
  t.enhanced.handle(packet("status=OK"));
  t.enhanced.handle(packet(`status=DATA:mime=${encoded(".")}`, encoded("text/plain text/html .")));
  t.enhanced.handle(packet("status=DONE"));
  assert.equal(t.requests[0], `\x1b]5522;type=read;${encoded("text/plain")}\x07`);
  t.enhanced.handle(packet(`status=DATA:mime=${encoded("text/plain")}`, encoded("café ✓\nhello"), "\x1b\\"));
  t.enhanced.handle(packet("status=DONE"));
  assert.deepEqual(t.texts, ["café ✓\nhello"]);
});

test("malformed payload and unsupported MIME are reported without attaching", () => {
  for (const value of ["%invalid", "a"]) {
    const t = controller();
    t.enhanced.handle(packet("status=OK"));
    t.enhanced.handle(packet(`status=DATA:mime=${encoded("image/png")}`));
    t.enhanced.handle(packet("status=DONE"));
    t.enhanced.handle(packet(`status=DATA:mime=${encoded("image/png")}`, value));
    assert.equal(t.errors.length, 1);
    assert.equal(t.images.length, 0);
    t.enhanced.reset();
  }
  const t = controller();
  t.enhanced.handle(packet("status=OK"));
  t.enhanced.handle(packet(`status=DATA:mime=${encoded("application/pdf")}`));
  t.enhanced.handle(packet("status=DONE"));
  assert.equal(t.errors.length, 1);
  assert.equal(t.requests.length, 0);
});

test("fragmented OSC packets are intercepted before stock stdin parser; ordinary keys survive", async () => {
  const t = transport();
  const p = packet(`status=DATA:mime=${encoded("image/png")}`, fixture.toString("base64"), "\x1b\\");
  t.filter.push("a\x1b]");
  await sleep(2);
  t.filter.push("5522;");
  await sleep(65); // Longer than Pi's stock incomplete escape timeout.
  for (let n = 7; n < p.length; n++) t.filter.push(p[n]);
  t.filter.push("\x1bv\rcafé ✓");
  assert.deepEqual(t.packets, [p]);
  assert.equal(t.forwarded.join(""), "a\x1bv\rcafé ✓");
  assert.equal(t.errors.length, 0);
  t.filter.dispose();
});

test("OSC-looking text within a fragmented bracketed paste stays literal", () => {
  const t = transport();
  const p = `${PASTE_START}${packet("status=OK")}${PASTE_END}\r`;
  for (const char of p) t.filter.push(char);
  assert.equal(t.forwarded.join(""), p);
  assert.equal(t.packets.length, 0);
  t.filter.dispose();
});

test("empty bracketed paste still reaches Pi's paste event", () => {
  const buffer = new StdinBuffer();
  const pastes = [];
  const filter = new Osc5522Input({ forward: (s) => buffer.process(s), packet: () => {}, error: () => {} });
  buffer.on("paste", (s) => pastes.push(s));
  for (const char of `${PASTE_START}${PASTE_END}`) filter.push(char);
  assert.deepEqual(pastes, [""]);
  filter.dispose();
  buffer.destroy();
});

test("split UTF-8 and bare escape do not corrupt ordinary input", async () => {
  const t = transport();
  const bytes = Buffer.from("café ✓");
  t.filter.push(bytes.subarray(0, 2));
  t.filter.push(bytes.subarray(2));
  t.filter.push("\x1b");
  await sleep(40);
  assert.equal(t.forwarded.join(""), "café ✓\x1b");
  t.filter.dispose();
});

async function harness({ initialText = "", sessionId = randomUUID(), branch = [] } = {}) {
  const loaded = await loadExtensions([EXTENSION], "/tmp");
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const appendedEntries = [];
  loaded.runtime.appendEntry = (customType, data) => appendedEntries.push({ customType, data });
  let text = initialText;
  let listener;
  let widget;
  const notifications = [];
  const received = [];
  const writes = [];
  const focus = { getExpandedText: () => text, render: () => [text], invalidate() {}, handleInput: (data) => {
    received.push(data);
    if (data.startsWith(PASTE_START)) text += data.slice(PASTE_START.length, -PASTE_END.length);
  } };
  let nativeHandler = (s) => received.push(s);
  const terminal = {
    stdinDataHandler: nativeHandler,
    setupStdinBuffer() { nativeHandler = (s) => received.push(s); this.stdinDataHandler = nativeHandler; },
    stop() { process.stdin.removeListener("data", this.stdinDataHandler); this.stdinDataHandler = undefined; },
    write(s) { writes.push(s); },
  };
  const originalSetup = terminal.setupStdinBuffer;
  const originalStop = terminal.stop;
  const tui = { terminal, requestRender() {}, getFocusedComponent: () => focus, hasOverlay: () => false };
  const theme = { fg: (_color, s) => s };
  const ctx = {
    mode: "tui", cwd: "/tmp", model: { input: ["text", "image"] },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
    ui: {
      notify(message, type) { notifications.push({ message, type }); },
      setStatus() {},
      setWidget(_key, factory) { widget = factory(tui, theme); },
      pasteToEditor(s) { text += s; },
      getEditorText() { return text; },
      setEditorText(s) { text = s; },
      onTerminalInput(handler) { listener = handler; return () => { listener = undefined; }; },
    },
  };
  const emit = async (name, event) => {
    let result;
    for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  const listenersBefore = process.stdin.listenerCount("data");
  process.stdin.on("data", terminal.stdinDataHandler);
  await emit("session_start", { reason: "startup" });
  return {
    ctx, extension, notifications, received, writes, terminal, emit, sessionId, theme, appendedEntries,
    get text() { return text; },
    render(width = 100) { return widget.render(width); },
    renderEditor() { return focus.render(100); },
    async draftFile() {
      const manifest = JSON.parse(await readFile(join(tmpdir(), `pi-image-paste-draft-${sessionId}.json`), "utf8"));
      return manifest.images[0].path;
    },
    input(data) { return listener(data); },
    async close(reason = "quit") {
      await emit("session_shutdown", { reason });
      assert.equal(terminal.setupStdinBuffer, originalSetup);
      assert.equal(terminal.stop, originalStop);
      assert.equal(terminal.stdinDataHandler, nativeHandler);
      assert.equal(process.stdin.listenerCount("data"), listenersBefore + 1);
      process.stdin.removeListener("data", nativeHandler);
      assert.equal(process.stdin.listenerCount("data"), listenersBefore);
    },
    manifestPath: join(tmpdir(), `pi-image-paste-draft-${sessionId}.json`),
  };
}

test("command stages readable image and input hook sends real image content", async () => {
  const h = await harness();
  const dir = await mkdtemp(join(tmpdir(), "pi-paste-test-"));
  try {
    const image = join(dir, "my image.png");
    await writeFile(image, fixture);
    await h.extension.commands.get("paste-image").handler(`"${image}"`, h.ctx);
    assert.equal(h.text.trim(), "📷 #1");
    assert.ok(!h.text.includes("/tmp/"));
    const path = await h.draftFile();
    assert.deepEqual(await readFile(path), fixture);
    assert.equal(h.render().length, 6);
    assert.ok(stripTerminalSequences(h.render()[0]).includes("📷 #1"));
    assert.ok(stripTerminalSequences(h.render()[5]).includes("1x1"));
    assert.ok(h.renderEditor()[0].includes("\x1b[38;"));
    const event = { source: "interactive", text: `look at ${h.text.trim()}`, images: [{ type: "image", data: fixture.toString("base64"), mimeType: "image/png" }] };
    const result = await h.emit("input", event);
    assert.equal(result.action, "transform");
    assert.equal(result.images.length, 2);
    assert.equal(result.images[1].data, fixture.toString("base64"));
    assert.equal(result.text, "look at [Image #2]");
    assert.deepEqual(await h.emit("input", { source: "extension", text: path }), { action: "continue" });
    assert.deepEqual(await h.emit("input", { source: "interactive", text: "ordinary prompt" }), { action: "continue" });
    h.ctx.model.input = ["text"];
    assert.equal((await h.emit("input", { source: "interactive", text: h.text })).action, "handled");
    assert.ok(h.notifications.some((n) => /does not accept images/.test(n.message)));
    await h.close();
    await assert.rejects(access(path));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("bracketed image path paste defers Enter until attachment is ready", async () => {
  const h = await harness();
  const dir = await mkdtemp(join(tmpdir(), "pi-paste-test-"));
  try {
    const path = join(dir, "test.png");
    await writeFile(path, fixture);
    assert.equal(h.input(`${PASTE_START}${path}${PASTE_END}`).consume, true);
    assert.equal(h.input("\r").consume, true);
    assert.equal(h.received.includes("\r"), false);
    for (let n = 0; n < 100 && !h.received.includes("\r"); n++) await sleep(5);
    assert.ok(h.text.includes("📷 #1"));
    assert.equal(h.received.includes("\r"), true);
    assert.equal(h.input(`${PASTE_START}ordinary\ntext${PASTE_END}`), undefined);
    await h.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reload preserves draft attachment and new runtime reattaches it", async () => {
  const first = await harness();
  const dir = await mkdtemp(join(tmpdir(), "pi-paste-test-"));
  try {
    const path = join(dir, "test.png");
    await writeFile(path, fixture);
    await first.extension.commands.get("paste-image").handler(path, first.ctx);
    const draft = first.text.trim();
    const backingFile = await first.draftFile();
    await first.close("reload");
    await access(backingFile);
    const second = await harness({ initialText: draft, sessionId: first.sessionId });
    assert.ok(stripTerminalSequences(second.render()[5]).includes("1x1"));
    const result = await second.emit("input", { source: "interactive", text: draft });
    assert.equal(result.action, "transform");
    assert.equal(result.images[0].mimeType, "image/png");
    await second.close();
    await assert.rejects(access(backingFile));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("terminal restart keeps OSC enabled and restores original handlers", async () => {
  const h = await harness();
  assert.ok(h.writes.includes("\x1b[?5522h"));
  h.terminal.stop();
  h.terminal.setupStdinBuffer();
  process.stdin.on("data", h.terminal.stdinDataHandler);
  h.terminal.stdinDataHandler(packet("status=OK"));
  h.terminal.stdinDataHandler(packet(`status=DATA:mime=${encoded("text/plain")}`));
  h.terminal.stdinDataHandler(packet("status=DONE"));
  h.terminal.stdinDataHandler(packet(`status=DATA:mime=${encoded("text/plain")}`, encoded("hello ✓")));
  h.terminal.stdinDataHandler(packet("status=DONE"));
  assert.ok(h.received.includes(`${PASTE_START}hello ✓${PASTE_END}`));
  await h.close();
});

test("sent images render as cards and preview entries recover on reload", async () => {
  const h = await harness();
  const dir = await mkdtemp(join(tmpdir(), "pi-paste-test-"));
  try {
    const path = join(dir, "test.png");
    await writeFile(path, fixture);
    await h.extension.commands.get("paste-image").handler(path, h.ctx);
    const result = await h.emit("input", { source: "interactive", text: h.text });
    h.ctx.ui.setEditorText("");
    assert.deepEqual(h.render(), []);
    const message = { role: "user", timestamp: 123456, content: [{ type: "text", text: result.text }, ...result.images] };
    await h.emit("message_end", { message });
    assert.deepEqual(h.appendedEntries, [{ customType: "image-paste-preview", data: { timestamp: "123456", count: 1 } }]);
    const renderer = h.extension.entryRenderers.get("image-paste-preview");
    const card = renderer({ data: h.appendedEntries[0].data }, {}, h.theme);
    assert.ok(stripTerminalSequences(card.render(100)[0]).includes("📷 #1"));
    const visualText = h.extension.markdownTransformer("[Image #1] look", { messageType: "user" });
    assert.equal(visualText, "📷 #1 look");
    await h.close("reload");
    const restored = await harness({ sessionId: h.sessionId, branch: [{ type: "message", message }] });
    const recovered = restored.extension.entryRenderers.get("image-paste-preview")({ data: h.appendedEntries[0].data }, {}, restored.theme);
    assert.equal(recovered.render(100).length, 6);
    await restored.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("BMP file path is converted to PNG without changing system clipboard", async () => {
  const h = await harness();
  const dir = await mkdtemp(join(tmpdir(), "pi-paste-test-"));
  try {
    const path = join(dir, "test.bmp");
    await writeFile(path, execFileSync("convert", ["-size", "2x2", "xc:red", "bmp:-"]));
    await h.extension.commands.get("paste-image").handler(path, h.ctx);
    const result = await h.emit("input", { source: "interactive", text: h.text });
    assert.equal(result.images[0].mimeType, "image/png");
    await h.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
