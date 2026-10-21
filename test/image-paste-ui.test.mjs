import assert from "node:assert/strict";
import { after, test } from "node:test";
import { jiti, piModule, tuiModule } from "./pi-host.mjs";

const { Editor } = await tuiModule("dist/components/editor.js");
const { KeybindingsManager } = await piModule("dist/core/keybindings.js");
const { setKeybindings } = await tuiModule("dist/keybindings.js");
const { setCapabilities } = await tuiModule("dist/terminal-image.js");
const { stripTerminalSequences, visibleWidth } = await tuiModule("dist/utils.js");
const { AttachmentBand, PreviewAsset, decorateImageTokens, imageTokens } = await jiti.import("../lib/ui.ts");
const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYvQAAAAASUVORK5CYII=";
const theme = { fg: (_name, text) => text };
const noGraphics = { images: null, trueColor: true, hyperlinks: true };
after(() => { setCapabilities(noGraphics); process.stdin.pause(); });

function attachment(id, dimensions = { widthPx: 901, heightPx: 200 }) {
  return { id, key: `image-${id}`, mimeType: "image/png", dimensions, path: "/tmp/hidden-backing-file.png" };
}

test("OMP card geometry is 14 columns x 6 rows with camera, number and dimensions", () => {
  setCapabilities(noGraphics);
  const band = new AttachmentBand(() => [attachment(1)], () => undefined, theme);
  const rows = band.render(100).map(stripTerminalSequences);
  assert.deepEqual(rows, [
    "╭── 📷 #1 ───╮",
    "│            │",
    "│     📷     │",
    "│            │",
    "│            │",
    "╰─ 901x200 ──╯",
  ]);
  assert.ok(rows.every((row) => visibleWidth(row) === 14));
  assert.ok(!rows.join("\n").includes("/tmp/"));
});

test("multiple cards align horizontally and narrower viewports never overflow", () => {
  setCapabilities(noGraphics);
  const images = [attachment(1), attachment(2), attachment(3)];
  const band = new AttachmentBand(() => images, () => undefined, theme);
  assert.equal(band.render(100).length, 6);
  assert.equal(visibleWidth(band.render(100)[0]), 46);
  for (const width of [1, 4, 7, 8, 10, 14, 28, 30, 46]) {
    const rows = band.render(width);
    assert.ok(rows.every((row) => visibleWidth(row) <= width), `overflow at ${width}`);
  }
  assert.ok(stripTerminalSequences(band.render(14).at(-1)).includes("+2"));
});

test("removed attachment disappears, dimensions are cached and invalidation rebuilds cards", () => {
  setCapabilities(noGraphics);
  let images = [attachment(1)];
  const band = new AttachmentBand(() => images, () => undefined, theme);
  assert.equal(band.render(100), band.render(100));
  band.invalidate();
  assert.equal(band.render(100).length, 6);
  images = [];
  assert.deepEqual(band.render(100), []);
  const asset = new PreviewAsset({ type: "image", mimeType: "image/png", data });
  assert.deepEqual(asset.dimensions, { widthPx: 1, heightPx: 1 });
});

test("graphics-capable terminal uses real preview; ordinary terminal keeps icon fallback", () => {
  const asset = new PreviewAsset({ type: "image", mimeType: "image/png", data });
  const item = attachment(1, asset.dimensions);
  const band = new AttachmentBand(() => [item], () => asset, theme);
  setCapabilities({ ...noGraphics, images: "kitty" });
  assert.ok(band.render(100).some((row) => row.includes("\x1b_G")));
  setCapabilities(noGraphics);
  band.invalidate();
  assert.ok(!band.render(100).some((row) => row.includes("\x1b_G")));
  assert.ok(stripTerminalSequences(band.render(100)[2]).includes("📷"));
});

test("real Pi editor treats the camera label as one grapheme, deletes and undoes atomically", () => {
  setCapabilities(noGraphics);
  setKeybindings(KeybindingsManager.create());
  const tui = { terminal: { rows: 40 }, requestRender() {} };
  const editor = new Editor(tui, { borderColor: (text) => text, selectList: {} });
  const originalSegment = editor.segment;
  const originalRender = editor.render;
  const restore = decorateImageTokens(editor, (id) => id === 1 ? attachment(1) : undefined);
  editor.setText("prefix 📷 #1");
  assert.equal([...editor.segment(editor.getText(), "grapheme")].at(-1).segment, "📷 #1");
  assert.ok(editor.render(80).some((line) => line.includes("\x1b[38;2;255;179;102m")));
  editor.handleInput("\x7f");
  assert.equal(editor.getText(), "prefix ");
  editor.handleInput("\x1bz");
  assert.equal(editor.getText(), "prefix 📷 #1");
  editor.handleInput("\x1b[D");
  assert.equal(editor.getCursor().col, "prefix ".length);
  editor.handleInput("\x1b[3~");
  assert.equal(editor.getText(), "prefix ");
  restore();
  assert.equal(editor.segment, originalSegment);
  assert.equal(editor.render, originalRender);
});

test("token parser does not confuse #1 and #10 and handles duplicate references", () => {
  assert.deepEqual(imageTokens("📷 #1 text 📷 #10 📷 #1").map((token) => token.id), [1, 10, 1]);
});
