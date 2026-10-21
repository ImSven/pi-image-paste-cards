import { StringDecoder } from "node:string_decoder";
import { t } from "./messages.ts";

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";
const OSC_PREFIX = "\x1b]5522;";
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PACKET_CHARS = 16 * 1024 * 1024;

export type ImageBytes = { bytes: Buffer; mimeType: string };

/** OMP's two-phase enhanced paste: list MIME types, then read the preferred one. */
export class EnhancedPaste {
  private state?: {
    phase: "listing" | "reading";
    mimes: string[];
    mime?: string;
    chunks: Buffer[];
    bytes: number;
    dot?: boolean;
    password?: string;
    location?: string;
  };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private callbacks: {
    write: (data: string) => void;
    image: (image: ImageBytes) => void;
    text: (text: string) => void;
    error: (message: string) => void;
  }) {}

  handle(packet: string): void {
    if (!packet.startsWith(OSC_PREFIX)) return;
    const end = packet.endsWith("\x07") ? 1 : packet.endsWith("\x1b\\") ? 2 : 0;
    if (!end) return;
    const body = packet.slice(OSC_PREFIX.length, -end);
    const separator = body.indexOf(";");
    const header = separator < 0 ? body : body.slice(0, separator);
    const payload = separator < 0 ? "" : body.slice(separator + 1);
    if (header.length > 1024) return this.fail(t.oscMetadata);
    const metadata = new Map(header.split(":").map((field) => {
      const i = field.indexOf("=");
      return [field.slice(0, i), field.slice(i + 1)] as const;
    }));
    if (metadata.get("type") !== "read") return;

    try {
      const status = metadata.get("status");
      if (status === "OK") {
        if (this.state?.phase === "reading") return;
        const password = metadata.get("pw");
        if (password && !/^[A-Za-z0-9+/=_-]{1,512}$/.test(password)) {
          return this.fail(t.oscAuth);
        }
        this.state = {
          phase: "listing", mimes: [], chunks: [], bytes: 0,
          password, location: metadata.get("loc") === "primary" ? "primary" : undefined,
        };
      } else if (status === "DATA" && this.state) {
        const mime = decodeBase64(metadata.get("mime") ?? "").toString("utf8");
        if (this.state.phase === "listing") {
          if (mime === ".") {
            this.state.dot = true;
            const list = decodeBase64(payload).toString("utf8").split(/\s+/);
            this.state.mimes.push(...list.filter((value) => value && value !== "."));
          } else if (mime) {
            this.state.mimes.push(mime);
          }
          if (this.state.mimes.length > 64) return this.fail(t.oscMimes);
        } else if (mime === this.state.mime && payload) {
          const bytes = decodeBase64(payload);
          this.state.bytes += bytes.length;
          if (this.state.bytes > MAX_BYTES) return this.fail(t.oscTooLarge);
          this.state.chunks.push(bytes);
        }
      } else if (status === "DONE" && this.state) {
        const state = this.state;
        if (state.phase === "listing") {
          const mime = IMAGE_MIMES.find((value) => state.mimes.includes(value)) ??
            (state.mimes.includes("text/plain") ? "text/plain" : undefined);
          if (!mime) return this.fail(t.oscUnsupported);
          state.phase = "reading";
          state.mime = mime;
          const fields = ["type=read"];
          if (state.location) fields.push(`loc=${state.location}`);
          if (state.password) {
            fields.push(`pw=${state.password}`, `name=${Buffer.from("Paste event").toString("base64")}`);
          }
          const encoded = Buffer.from(mime).toString("base64");
          this.callbacks.write(state.dot
            ? `${OSC_PREFIX}${fields.join(":")};${encoded}\x07`
            : `${OSC_PREFIX}${fields.join(":")}:mime=${encoded}\x07`);
        } else {
          this.reset();
          const bytes = Buffer.concat(state.chunks, state.bytes);
          if (!bytes.length) return this.callbacks.error(t.oscEmpty);
          if (state.mime === "text/plain") this.callbacks.text(bytes.toString("utf8"));
          else this.callbacks.image({ bytes, mimeType: state.mime! });
          return;
        }
      } else if (status && !["DATA", "DONE"].includes(status)) {
        return this.fail(`${t.oscFailed}: ${status.slice(0, 80)}`);
      }
      if (this.state) this.armTimeout();
    } catch {
      this.fail(t.oscEncoding);
    }
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.state = undefined;
  }

  private armTimeout(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(t.oscTimeout), 10_000);
  }

  private fail(message: string): void {
    this.reset();
    this.callbacks.error(message);
  }
}

function decodeBase64(value: string): Buffer {
  if (value.length > MAX_PACKET_CHARS || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64");
  }
  return Buffer.from(value, "base64");
}

/**
 * Intercept only OSC 5522 before Pi's stock StdinBuffer. It otherwise treats a
 * fragmented 5522 reply as Alt+] and leaks its base64 tail into the editor.
 * Plain keys and bracketed-paste contents still use Pi's original parser.
 */
export class Osc5522Input {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private packet = false;
  private discarding = false;
  private bracketed = false;
  private searchFrom = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private callbacks: {
    forward: (data: string) => void;
    packet: (data: string) => void;
    error: (message: string) => void;
  }) {}

  push(data: string | Buffer): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Preserve Pi's legacy high-bit Alt encoding for single-byte input.
    const text = Buffer.isBuffer(data)
      ? data.length === 1 && data[0]! > 127 && !this.packet && !this.bracketed
        ? `\x1b${String.fromCharCode(data[0]! - 128)}`
        : this.decoder.write(data)
      : data;
    this.buffer += text;
    this.drain();
    if (this.buffer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.packet || this.discarding) {
          this.buffer = "";
          this.packet = false;
          this.discarding = true;
          this.callbacks.error(t.oscIncomplete);
        } else {
          const remaining = this.buffer;
          this.buffer = "";
          this.callbacks.forward(remaining);
        }
      }, this.packet || this.discarding ? 5_000 : 20);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.buffer && !this.packet && !this.discarding) this.callbacks.forward(this.buffer);
    this.buffer = "";
    this.decoder.end();
  }

  private drain(): void {
    while (this.buffer) {
      if (this.packet || this.discarding) {
        const bel = this.buffer.indexOf("\x07", this.searchFrom);
        const st = this.buffer.indexOf("\x1b\\", this.searchFrom);
        const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
        if (end < 0) {
          if (this.buffer.length > MAX_PACKET_CHARS || this.discarding) {
            if (!this.discarding) this.callbacks.error(t.oscPacketTooLarge);
            this.discarding = true;
            this.buffer = this.buffer.endsWith("\x1b") ? "\x1b" : "";
          }
          this.searchFrom = Math.max(0, this.buffer.length - 1);
          return;
        }
        const length = end + (end === bel ? 1 : 2);
        const packet = this.buffer.slice(0, length);
        this.buffer = this.buffer.slice(length);
        if (!this.discarding && length <= MAX_PACKET_CHARS) this.callbacks.packet(packet);
        this.packet = this.discarding = false;
        this.searchFrom = 0;
        continue;
      }

      if (this.bracketed) {
        const end = this.buffer.indexOf(PASTE_END);
        if (end >= 0) {
          this.callbacks.forward(this.buffer.slice(0, end + PASTE_END.length));
          this.buffer = this.buffer.slice(end + PASTE_END.length);
          this.bracketed = false;
          continue;
        }
        this.forwardExceptPartial(PASTE_END);
        return;
      }

      const escape = this.buffer.indexOf("\x1b");
      if (escape < 0) {
        this.callbacks.forward(this.buffer);
        this.buffer = "";
        return;
      }
      if (escape > 0) {
        this.callbacks.forward(this.buffer.slice(0, escape));
        this.buffer = this.buffer.slice(escape);
      }
      if (this.buffer.startsWith(OSC_PREFIX)) {
        this.packet = true;
        this.searchFrom = OSC_PREFIX.length;
      } else if (this.buffer.startsWith(PASTE_START)) {
        this.callbacks.forward(PASTE_START);
        this.buffer = this.buffer.slice(PASTE_START.length);
        this.bracketed = true;
      } else if (OSC_PREFIX.startsWith(this.buffer) || PASTE_START.startsWith(this.buffer)) {
        return;
      } else {
        // Let the original parser assemble CSI/Alt keys without our interpreting them.
        this.callbacks.forward("\x1b");
        this.buffer = this.buffer.slice(1);
      }
    }
  }

  private forwardExceptPartial(marker: string): void {
    let keep = Math.min(marker.length - 1, this.buffer.length);
    while (keep && !marker.startsWith(this.buffer.slice(-keep))) keep--;
    const end = this.buffer.length - keep;
    if (end) this.callbacks.forward(this.buffer.slice(0, end));
    this.buffer = this.buffer.slice(end);
  }
}
