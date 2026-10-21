import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, getNativeClipboard, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ImageContent } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EnhancedPaste, Osc5522Input, PASTE_START, PASTE_END, type ImageBytes } from "../lib/core.ts";
import { t } from "../lib/messages.ts";
import {
  AttachmentBand,
  PreviewAsset,
  decorateImageTokens,
  imageLabel,
  imageTokens,
  type Attachment,
} from "../lib/ui.ts";

const MAX_BYTES = 50 * 1024 * 1024;
const TEMP_PREFIX = "pi-image-paste-";
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"];
const EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
};

async function run(command: string, args: string[], input?: Buffer, timeout = 5000): Promise<Buffer | undefined> {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: [input ? "pipe" : "ignore", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const finish = (result?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };
    const abort = () => {
      child.kill("SIGKILL");
      child.stdout?.destroy();
      child.stdin?.destroy();
      finish();
    };
    const timer = setTimeout(abort, timeout);
    child.on("error", () => finish());
    child.on("close", (code) => { if (!settled) finish(code === 0 ? Buffer.concat(chunks, length) : undefined); });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      length += chunk.length;
      if (length > MAX_BYTES) abort();
      else chunks.push(chunk);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

function detectMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  return undefined;
}

async function normalize(bytes: Buffer): Promise<ImageBytes> {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error(t.imageTooLarge);
  let mimeType = detectMime(bytes);
  if (mimeType === "image/bmp") {
    const png = await run("convert", ["bmp:-", "png:-"], bytes);
    if (!png || detectMime(png) !== "image/png") throw new Error(t.bmpFailed);
    bytes = png;
    mimeType = "image/png";
  }
  if (!mimeType) throw new Error(t.unsupportedImage);
  return { bytes, mimeType };
}

// undefined = unavailable backend; null = current clipboard has no image.
// A successfully queried empty Wayland clipboard must not use stale X11 data.
async function readBackend(wayland: boolean): Promise<ImageBytes | null | undefined> {
  if (!(wayland ? process.env.WAYLAND_DISPLAY : process.env.DISPLAY)) return undefined;
  const listed = await run(wayland ? "wl-paste" : "xclip", wayland
    ? ["--list-types"] : ["-selection", "clipboard", "-t", "TARGETS", "-o"], undefined, 2000);
  if (listed === undefined) return undefined;
  const offered = listed.toString("utf8").split(/\r?\n/).map((type) => type.trim());
  const mime = IMAGE_MIMES.find((value) => offered.some((type) => type.split(";")[0]?.toLowerCase() === value));
  if (!mime) return null;
  const selected = offered.find((type) => type.split(";")[0]?.toLowerCase() === mime)!;
  const bytes = await run(wayland ? "wl-paste" : "xclip", wayland
    ? ["--type", selected, "--no-newline"] : ["-selection", "clipboard", "-t", selected, "-o"]);
  return bytes === undefined ? undefined : bytes.length ? normalize(bytes) : null;
}

async function clipboardImage(): Promise<ImageBytes | null> {
  let image = await readBackend(true);
  if (image === undefined) image = await readBackend(false);
  if (image === undefined) {
    const bytes = await getNativeClipboard()?.getImage();
    if (bytes?.length) return normalize(Buffer.from(bytes));
  }
  return image ?? null;
}

async function clipboardText(): Promise<string | null> {
  if (process.env.WAYLAND_DISPLAY) {
    const bytes = await run("wl-paste", ["--type", "text", "--no-newline"]);
    if (bytes !== undefined) return bytes.toString("utf8") || null;
  }
  if (process.env.DISPLAY) {
    const bytes = await run("xclip", ["-selection", "clipboard", "-o"]);
    if (bytes !== undefined) return bytes.toString("utf8") || null;
  }
  return (await getNativeClipboard()?.getText()) || null;
}

async function loadImagePath(text: string, cwd: string): Promise<ImageBytes> {
  let path = text.trim().replace(/^(?:"(.*)"|'(.*)')$/, "$1$2");
  if (path.startsWith("file://")) path = fileURLToPath(path);
  if (/^[A-Za-z]:[\\/]/.test(path) && process.platform === "linux") {
    const converted = await run("wslpath", ["-u", path]);
    if (!converted) throw new Error(t.windowsPath);
    path = converted.toString("utf8").trim();
  }
  if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  path = resolve(cwd, path);
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error(t.fileUnreadable);
  return normalize(await readFile(path));
}

// ProcessTerminal has no public pre-parser input hook. Wrap only its instance
// handler, restoring it on shutdown/reload; never patch installed Pi files.
type ParserTerminal = TUI["terminal"] & {
  setupStdinBuffer?: () => void;
  stdinDataHandler?: (data: Buffer | string) => void;
};

function installEnhancedPaste(tui: TUI, callbacks: ConstructorParameters<typeof EnhancedPaste>[0]): () => void {
  const terminal = tui.terminal as ParserTerminal;
  if (!terminal.setupStdinBuffer || !terminal.stdinDataHandler) return () => {};
  const enhanced = new EnhancedPaste(callbacks);
  const originalSetup = terminal.setupStdinBuffer;
  const originalStop = terminal.stop;
  let originalHandler = terminal.stdinDataHandler;
  let filter: Osc5522Input;
  let handler!: typeof originalHandler;

  const wrap = () => {
    filter?.dispose();
    originalHandler = terminal.stdinDataHandler!;
    filter = new Osc5522Input({ forward: (data) => originalHandler(data), packet: (data) => enhanced.handle(data), error: callbacks.error });
    handler = (data) => filter.push(data);
    terminal.stdinDataHandler = handler;
    terminal.write("\x1b[?5522h");
  };
  process.stdin.removeListener("data", originalHandler);
  wrap();
  process.stdin.on("data", handler);
  const setup = () => { originalSetup.call(terminal); wrap(); };
  const stop = () => { terminal.write("\x1b[?5522l"); enhanced.reset(); originalStop.call(terminal); };
  terminal.setupStdinBuffer = setup;
  terminal.stop = stop;

  return () => {
    terminal.write("\x1b[?5522l");
    enhanced.reset();
    filter.dispose();
    if (terminal.setupStdinBuffer === setup) terminal.setupStdinBuffer = originalSetup;
    if (terminal.stop === stop) terminal.stop = originalStop;
    if (terminal.stdinDataHandler === handler) {
      const attached = process.stdin.listeners("data").includes(handler);
      process.stdin.removeListener("data", handler);
      terminal.stdinDataHandler = originalHandler;
      if (attached) process.stdin.on("data", originalHandler);
    }
  };
}

export default function imagePaste(pi: ExtensionAPI) {
  type DraftImage = { attachment: Attachment; asset: PreviewAsset };
  type DraftManifest = { version: 1; nextId: number; images: Array<{ id: number; key: string; path: string; mimeType: string }> };
  type CapturedTUI = TUI & { getFocusedComponent(): Component | null };

  let context: ExtensionContext | undefined;
  let tui: CapturedTUI | undefined;
  let band: AttachmentBand | undefined;
  let decoratedEditor: object | undefined;
  let cleanupDecoration: (() => void) | undefined;
  let epoch = 0;
  let pending: Promise<void> | undefined;
  let cleanupInput: (() => void) | undefined;
  let cleanupTransport: (() => void) | undefined;
  let nextAttachmentId = 1;
  let manifestSignature = "";
  let manifestWrites = Promise.resolve();
  const submittedDrafts: Array<{ text: string; ids: number[] }> = [];
  const sentImages = new Map<string, ImageContent[]>();
  const sentAssets = new Map<string, PreviewAsset>();
  const queuedInput: string[] = [];
  const drafts = new Map<number, DraftImage>();
  const createdFiles = new Set<string>();
  const diagnostics = { trigger: t.notTriggered, result: t.notRead, events: 0, trace: false, lastEvent: "" };

  const activeDrafts = (text = context?.ui.getEditorText() ?? ""): DraftImage[] => {
    const seen = new Set<number>();
    const result: DraftImage[] = [];
    for (const token of imageTokens(text)) {
      const draft = drafts.get(token.id);
      if (draft && !seen.has(token.id)) { seen.add(token.id); result.push(draft); }
    }
    return result;
  };
  const lookup = (id: number) => drafts.get(id)?.attachment;
  // Membership/width/protocol changes are detected by the band itself. Avoid
  // invalidating image encodings on every ordinary keystroke.
  const redraw = () => { tui?.requestRender(); };
  const manifestPath = () => context
    ? join(tmpdir(), `${TEMP_PREFIX}draft-${context.sessionManager.getSessionId()}.json`) : undefined;
  const validTempPath = (path: string) => new RegExp(`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${TEMP_PREFIX}[0-9a-f-]{36}\\.(?:png|jpg|webp|gif)$`).test(path);

  const dropFiles = async (paths: Iterable<string>) => {
    for (const path of paths) {
      createdFiles.delete(path);
      await unlink(path).catch(() => {});
    }
  };
  /** Delete leftovers from crashed or killed runs. Only our own file names are touched. */
  const sweepStale = async () => {
    let names: string[];
    try { names = await readdir(tmpdir()); } catch { return; }
    const cutoff = Date.now() - STALE_MS;
    for (const name of names) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const path = join(tmpdir(), name);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.mtimeMs >= cutoff) continue;
        await unlink(path);
      } catch { /* already gone */ }
    }
  };

  const saveManifest = async () => {
    const path = manifestPath();
    if (!path) return;
    const images = activeDrafts().flatMap(({ attachment }) =>
      attachment.path && validTempPath(attachment.path)
        ? [{ id: attachment.id, key: attachment.key, path: attachment.path, mimeType: attachment.mimeType }]
        : []);
    const manifest: DraftManifest = { version: 1, nextId: nextAttachmentId, images };
    const signature = JSON.stringify(manifest);
    if (signature === manifestSignature) return manifestWrites;
    manifestSignature = signature;
    manifestWrites = manifestWrites.then(async () => {
      if (!images.length) await unlink(path).catch(() => {});
      else await writeFile(path, signature, { mode: 0o600 });
    }).catch(() => { manifestSignature = ""; });
    return manifestWrites;
  };

  const addDraft = (image: ImageBytes, path: string, id = nextAttachmentId++, key: string = randomUUID()): DraftImage => {
    const content: ImageContent = { type: "image", data: image.bytes.toString("base64"), mimeType: image.mimeType };
    const asset = new PreviewAsset(content);
    const draft = { attachment: { id, key, path, mimeType: image.mimeType, dimensions: asset.dimensions }, asset };
    drafts.set(id, draft);
    createdFiles.add(path);
    nextAttachmentId = Math.max(nextAttachmentId, id + 1);
    return draft;
  };

  const insert = (text: string) => {
    if (!context) return;
    context.ui.pasteToEditor(text);
    redraw();
  };

  const stage = async (image: ImageBytes, token: number) => {
    image = await normalize(image.bytes);
    if (token !== epoch || !context) return;
    const path = join(tmpdir(), `${TEMP_PREFIX}${randomUUID()}.${EXTENSIONS[image.mimeType]}`);
    await writeFile(path, image.bytes, { mode: 0o600, flag: "wx" });
    if (token !== epoch || !context) { await unlink(path).catch(() => {}); return; }
    const draft = addDraft(image, path);
    insert(` ${imageLabel(draft.attachment.id)} `);
    await saveManifest();
    diagnostics.result = `${image.mimeType}, ${image.bytes.length} bytes`;
  };

  const paste = (trigger: string, path?: string, supplied?: ImageBytes): Promise<void> => {
    if (pending) return pending;
    if (!context) return Promise.resolve();
    const ctx = context;
    const token = epoch;
    diagnostics.trigger = trigger;
    diagnostics.events++;
    ctx.ui.setStatus("image-paste", t.reading);
    pending = (async () => {
      try {
        const image = supplied ?? (path ? await loadImagePath(path, ctx.cwd) : await clipboardImage());
        if (token !== epoch) return;
        if (image) await stage(image, token);
        else {
          const text = path ? null : await clipboardText();
          if (token !== epoch) return;
          if (text) { insert(text); diagnostics.result = t.pastedText; }
          else {
            diagnostics.result = t.nothingToPaste;
            ctx.ui.notify(`${diagnostics.result}; ${t.runStatus}`, "warning");
          }
        }
      } catch (error) {
        if (token === epoch) {
          diagnostics.result = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`${t.pasteFailed}: ${diagnostics.result}`, "error");
        }
      } finally {
        if (token === epoch) {
          pending = undefined;
          ctx.ui.setStatus("image-paste", undefined);
          for (const data of queuedInput.splice(0)) tui?.getFocusedComponent()?.handleInput?.(data);
          tui?.requestRender();
        }
      }
    })();
    return pending;
  };

  const assetForSentImage = (key: string) => {
    const cached = sentAssets.get(key);
    if (cached) return cached;
    const separator = key.lastIndexOf(":");
    const content = sentImages.get(key.slice(0, separator))?.[Number(key.slice(separator + 1))];
    if (!content) return undefined;
    const asset = new PreviewAsset(content);
    sentAssets.set(key, asset);
    if (sentAssets.size > 32) sentAssets.delete(sentAssets.keys().next().value!);
    return asset;
  };
  pi.registerEntryRenderer<{ timestamp: string; count: number }>("image-paste-preview", (entry, _options, theme) => {
    if (!entry.data) return undefined;
    const attachments: Attachment[] = [];
    for (let index = 0; index < Math.min(entry.data.count, 16); index++) {
      const key = `${entry.data.timestamp}:${index}`;
      const asset = assetForSentImage(key);
      if (asset) attachments.push({ id: index + 1, key, mimeType: asset.content.mimeType, dimensions: asset.dimensions });
    }
    return attachments.length ? new AttachmentBand(() => attachments, assetForSentImage, theme) : undefined;
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "user" || !Array.isArray(event.message.content)) return;
    const images = event.message.content.filter((part): part is ImageContent => part.type === "image");
    if (!images.length) return;
    const timestamp = String(event.message.timestamp);
    sentImages.set(timestamp, images);
    // Persist references only: the user's message already owns the image bytes.
    pi.appendEntry("image-paste-preview", { timestamp, count: images.length });
    const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const submittedIndex = submittedDrafts.findIndex((draft) => draft.text === text);
    if (submittedIndex >= 0) {
      const [submitted] = submittedDrafts.splice(submittedIndex, 1);
      const active = new Set(activeDrafts().map((draft) => draft.attachment.id));
      const released: string[] = [];
      for (const id of submitted!.ids) {
        if (active.has(id)) continue;
        const draft = drafts.get(id);
        if (draft?.attachment.path) released.push(draft.attachment.path);
        drafts.delete(id);
      }
      if (!drafts.size) nextAttachmentId = 1;
      // The sent message now owns the image bytes, so the draft copy is no longer needed.
      void dropFiles(released);
    }
    redraw();
    void saveManifest();
  });

  pi.registerMarkdownTransformer((markdown, render) => render.messageType === "user"
    ? markdown.replace(/\[Image #(\d+)(?:,[^\]]*)?\]/g, "📷 #$1") : markdown);

  pi.registerCommand("paste-image", {
    description: t.commandPaste,
    handler: async (path, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify(t.tuiOnly, "warning"); return; }
      await paste("/paste-image", path.trim() || undefined);
    },
  });
  pi.registerCommand("paste-image-status", {
    description: t.commandStatus,
    handler: async (arg, ctx) => {
      if (arg.trim() === "trace") diagnostics.trace = true;
      if (arg.trim() === "off") diagnostics.trace = false;
      ctx.ui.notify([
        t.statusLoaded,
        `${t.statusEvents}: ${diagnostics.events}`,
        `${t.statusTrigger}: ${diagnostics.trigger}`,
        `${t.statusResult}: ${diagnostics.result}`,
        `${t.statusKey}: ${diagnostics.lastEvent || t.unrecorded}`,
        `${t.statusTrace}: ${diagnostics.trace ? t.on : t.off}`,
      ].join("\n"), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    context = ctx;
    epoch++;
    void sweepStale();
    sentImages.clear();
    sentAssets.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "user" || !Array.isArray(entry.message.content)) continue;
      const images = entry.message.content.filter((part): part is ImageContent => part.type === "image");
      if (images.length) sentImages.set(String(entry.message.timestamp), images);
    }
    // One widget captures Pi's TUI and renders the OMP-style attachment band.
    ctx.ui.setWidget("image-paste-cards", (ui, theme) => {
      tui = ui as CapturedTUI;
      band = new AttachmentBand(
        () => activeDrafts().map((draft) => draft.attachment),
        (key) => [...drafts.values()].find((draft) => draft.attachment.key === key)?.asset,
        theme,
        (id) => {
          const token = imageTokens(ctx.ui.getEditorText()).find((item) => item.id === id);
          if (token) ctx.ui.setEditorText(ctx.ui.getEditorText().slice(0, token.start) + ctx.ui.getEditorText().slice(token.end));
          redraw();
          void saveManifest();
        },
      );
      return band;
    });
    const isEditorFocused = () => {
      const focused = tui?.getFocusedComponent();
      return !tui?.hasOverlay() && focused && "getExpandedText" in focused;
    };
    const ensureDecorated = () => {
      const focused = tui?.getFocusedComponent();
      if (!focused || focused === decoratedEditor || !("getExpandedText" in focused)) return;
      cleanupDecoration?.();
      cleanupDecoration = decorateImageTokens(focused, lookup);
      decoratedEditor = focused;
      redraw();
    };
    ensureDecorated();

    // Reload keeps the text draft but replaces extension state. Rehydrate only
    // paths written by this extension and bound to this exact session id.
    const restorePath = manifestPath();
    if (restorePath) {
      const path = restorePath;
      try {
        const info = await stat(path);
        if ((info.mode & 0o077) !== 0 || info.size > 64 * 1024) throw new Error("unsafe manifest");
        const parsed = JSON.parse(await readFile(path, "utf8")) as DraftManifest;
        if (parsed.version !== 1 || !Array.isArray(parsed.images) || parsed.images.length > 16) throw new Error("invalid manifest");
        for (const item of parsed.images) {
          if (!Number.isSafeInteger(item.id) || item.id < 1 || !validTempPath(item.path) || typeof item.key !== "string") continue;
          const image = await loadImagePath(item.path, ctx.cwd);
          addDraft(image, item.path, item.id, item.key);
        }
        nextAttachmentId = Math.max(nextAttachmentId, Number.isSafeInteger(parsed.nextId) ? parsed.nextId : 1);
        ensureDecorated();
        redraw();
      } catch { await unlink(path).catch(() => {}); }
    }

    cleanupInput = ctx.ui.onTerminalInput((data) => {
      ensureDecorated();
      if (diagnostics.trace && !data.startsWith(PASTE_START)) {
        // Do not log typed prompts or clipboard payloads. Only describe controls.
        if (data.startsWith("\x1b") || /[\x00-\x1f]/.test(data)) {
          diagnostics.lastEvent = JSON.stringify(data.slice(0, 40));
          ctx.ui.setStatus("image-paste-event", `${t.traceLabel}: ${diagnostics.lastEvent}`);
        }
      }
      if (!isEditorFocused()) return;
      const key = matchesKey(data, "ctrl+v") || matchesKey(data, "alt+v") ||
        getKeybindings().matches(data, "app.clipboard.pasteImage");
      if (key) { void paste(matchesKey(data, "alt+v") ? "Alt+V" : "Ctrl+V"); return { consume: true }; }
      if (pending) {
        // OMP also defers keys, particularly Enter, until attachment loading completes.
        if (queuedInput.length < 4096) queuedInput.push(data);
        return { consume: true };
      }
      const before = ctx.ui.getEditorText();
      queueMicrotask(() => {
        const after = context?.ui.getEditorText();
        if (after !== undefined && after !== before) { redraw(); void saveManifest(); }
      });
      if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
        const text = data.slice(PASTE_START.length, -PASTE_END.length);
        if (!text) { void paste(t.emptyPaste); return { consume: true }; }
        if (!/[\r\n]/.test(text.trim()) && /\.(?:png|jpe?g|webp|gif|bmp)["']?\s*$/i.test(text)) {
          void paste(t.pathPaste, text);
          return { consume: true };
        }
      }
      return;
    });

    cleanupTransport = installEnhancedPaste(tui!, {
      write: (data) => tui?.terminal.write(data),
      image: (image) => {
        if (isEditorFocused()) void paste("OSC 5522", undefined, image);
        else ctx.ui.notify(t.dialogNoImages, "warning");
      },
      text: (text) => {
        tui?.getFocusedComponent()?.handleInput?.(`${PASTE_START}${text}${PASTE_END}`);
        tui?.requestRender();
      },
      error: (message) => { ctx.ui.notify(message, "warning"); },
    });
  });

  // Compact chips identify attachments, not a path the model should open.
  // Continue supporting old native Pi clipboard paths for existing drafts.
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" };
    const escapedTmp = tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const paths = [...new Set(event.text.match(new RegExp(`${escapedTmp}/pi-(?:image-paste|clipboard)-[0-9a-f-]{36}\\.(?:png|jpg|webp|gif)`, "g")) ?? [])];
    const selected = activeDrafts(event.text);
    if (!selected.length && !paths.length) return { action: "continue" };
    if (ctx.model && !ctx.model.input.includes("image")) {
      ctx.ui.setEditorText(event.text);
      redraw();
      ctx.ui.notify(t.modelNoVision, "warning");
      return { action: "handled" };
    }
    const images: ImageContent[] = [...(event.images ?? [])];
    let text = event.text;
    try {
      const positions = new Map<number, number>();
      for (const draft of selected) {
        images.push(draft.asset.content);
        positions.set(draft.attachment.id, images.length);
      }
      text = text.replace(/📷 #(\d+)(?!\d)/g, (label, id) => {
        const position = positions.get(Number(id));
        return position ? `[Image #${position}]` : label;
      });
      for (const path of paths) {
        const image = await loadImagePath(path, ctx.cwd);
        images.push({ type: "image", data: image.bytes.toString("base64"), mimeType: image.mimeType });
        text = text.split(path).join(`[Image #${images.length}]`);
      }
      submittedDrafts.push({ text: text.trim(), ids: selected.map((draft) => draft.attachment.id) });
      return { action: "transform", text: text.trim(), images };
    } catch (error) {
      ctx.ui.setEditorText(event.text);
      redraw();
      ctx.ui.notify(`${t.attachmentFailed}: ${error instanceof Error ? error.message : String(error)}`, "error");
      return { action: "handled" };
    }
  });

  pi.on("session_shutdown", async (event) => {
    epoch++;
    cleanupInput?.();
    cleanupTransport?.();
    cleanupDecoration?.();
    cleanupInput = cleanupTransport = cleanupDecoration = undefined;
    pending = undefined;
    queuedInput.length = 0;
    await saveManifest();
    const manifest = manifestPath();
    context = undefined;
    tui = undefined;
    band = undefined;
    decoratedEditor = undefined;
    // Keep hidden backing files and their mapping across /reload.
    if (event.reason !== "reload") {
      await dropFiles([...createdFiles]);
      if (manifest) await unlink(manifest).catch(() => {});
      createdFiles.clear();
    }
    drafts.clear();
    submittedDrafts.length = 0;
    sentImages.clear();
    sentAssets.clear();
    nextAttachmentId = 1;
    manifestSignature = "";
  });
}
