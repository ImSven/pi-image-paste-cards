import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  Image,
  getCapabilities,
  getCellDimensions,
  getImageDimensions,
  hyperlink,
  truncateToWidth,
  visibleWidth,
  type Component,
  type ImageDimensions,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { pathToFileURL } from "node:url";
import { t } from "./messages.ts";

const PALETTE = [[255, 179, 102], [125, 207, 255], [189, 147, 249], [105, 220, 158], [255, 141, 188], [240, 223, 120]];
const INNER_COLS = 12;
const INNER_ROWS = 4;
const CARD_COLS = INNER_COLS + 2;
const GAP = 2;

export interface Attachment {
  id: number;
  key: string;
  path?: string;
  mimeType: string;
  dimensions: ImageDimensions | null;
}

export function imageLabel(id: number): string {
  return `📷 #${id}`;
}

export function imageTokens(text: string): { id: number; start: number; end: number }[] {
  return [...text.matchAll(/📷 #(\d+)(?!\d)/g)].map((m) => ({ id: Number(m[1]), start: m.index!, end: m.index! + m[0].length }));
}

function color(id: number): string {
  const rgb = PALETTE[(id - 1) % PALETTE.length] ?? PALETTE[0]!;
  if (getCapabilities().trueColor) return `\x1b[38;2;${rgb.join(";")}m`;
  return `\x1b[38;5;${[215, 117, 183, 115, 211, 221][(id - 1) % PALETTE.length]}m`;
}

function styled(id: number, text: string): string {
  return `${color(id)}${text}\x1b[39m`;
}

export function styleImageLabel(attachment: Attachment): string {
  const label = `\x1b[1m${imageLabel(attachment.id)}\x1b[22m`;
  const linked = attachment.path && getCapabilities().hyperlinks
    ? hyperlink(label, pathToFileURL(attachment.path).href) : label;
  return styled(attachment.id, linked);
}

/** Cache image probing/encoding on the asset, never in the per-keypress render path. */
export class PreviewAsset {
  readonly dimensions: ImageDimensions | null;
  private image?: Image;
  private protocol?: string | null;
  private cellSize = "";

  constructor(readonly content: ImageContent) {
    this.dimensions = getImageDimensions(content.data, content.mimeType);
  }

  render(width: number): string[] {
    const protocol = getCapabilities().images;
    const cell = getCellDimensions();
    const cellSize = `${cell.widthPx}:${cell.heightPx}`;
    if (!this.image || this.protocol !== protocol || this.cellSize !== cellSize) {
      this.image = new Image(this.content.data, this.content.mimeType, { fallbackColor: (s) => s },
        { maxWidthCells: INNER_COLS, maxHeightCells: INNER_ROWS }, this.dimensions ?? undefined);
      this.protocol = protocol;
      this.cellSize = cellSize;
    }
    return this.image.render(width);
  }

  invalidate(): void { this.image?.invalidate(); }
}

function centered(text: string, width: number): string {
  const cut = truncateToWidth(text, width, "");
  const pad = Math.max(0, width - visibleWidth(cut));
  return " ".repeat(Math.floor(pad / 2)) + cut + " ".repeat(Math.ceil(pad / 2));
}

function border(attachment: Attachment, caption: string, innerWidth: number, bottom = false): string {
  const cut = truncateToWidth(caption, Math.max(0, innerWidth - 2), "");
  const fill = Math.max(0, innerWidth - visibleWidth(cut) - 2);
  return styled(attachment.id,
    `${bottom ? "╰" : "╭"}${"─".repeat(Math.floor(fill / 2))} \x1b[1m${cut}\x1b[22m ${"─".repeat(Math.ceil(fill / 2))}${bottom ? "╯" : "╮"}`);
}

function card(attachment: Attachment, asset: PreviewAsset | undefined, theme: Theme, columns = CARD_COLS, preview = false): string[] {
  const innerWidth = columns - 2;
  const caption = attachment.dimensions
    ? `${attachment.dimensions.widthPx}x${attachment.dimensions.heightPx}` : attachment.mimeType.replace("image/", "").toUpperCase();
  const body = Array<string>(INNER_ROWS).fill(" ".repeat(innerWidth));
  const icon = theme.fg("muted", "📷");
  body[1] = centered(icon, innerWidth);
  if (preview && asset && getCapabilities().images && columns === CARD_COLS) {
    const lines = asset.render(INNER_COLS + 2);
    // Only compose real graphics. An unsupported conversion remains the icon card.
    if (lines.some((line) => line.includes("\x1b_G") || line.includes("\x1b]1337;"))) {
      const top = Math.max(0, Math.floor((INNER_ROWS - lines.length) / 2));
      body.fill(" ".repeat(innerWidth));
      for (let n = 0; n < Math.min(INNER_ROWS, lines.length); n++) {
        // Direct placement protocols alter cursor state; restore it before drawing
        // the right border. Pi's graphics renderer still sees the image sequence.
        body[top + n] = `\x1b7${lines[n]}\x1b8${" ".repeat(innerWidth)}`;
      }
    }
  }
  const vertical = styled(attachment.id, "│");
  return [
    border(attachment, imageLabel(attachment.id), innerWidth),
    ...body.map((line) => vertical + line + vertical),
    border(attachment, caption, innerWidth, true),
  ];
}

/** Same 12x4 rounded attachment cards as OMP; no temporary paths in the UI. */
export class AttachmentBand implements Component {
  private signature = "";
  private lines: string[] = [];
  private displayed: Attachment[] = [];

  constructor(
    private items: () => readonly Attachment[],
    private asset: (key: string) => PreviewAsset | undefined,
    private theme: Theme,
    private remove?: (id: number) => void,
  ) {}

  invalidate(): void {
    this.signature = "";
    for (const item of this.displayed) this.asset(item.key)?.invalidate();
  }

  render(width: number): string[] {
    const attachments = this.items();
    if (!attachments.length || width <= 0) { this.displayed = []; this.lines = []; this.signature = ""; return []; }
    const caps = getCapabilities();
    const cell = getCellDimensions();
    const signature = `${width}:${caps.images}:${caps.trueColor}:${cell.widthPx}:${cell.heightPx}:${attachments.map((a) => `${a.id}:${a.key}`).join("|")}`;
    if (signature === this.signature) return this.lines;
    this.signature = signature;
    if (width < 8) {
      this.displayed = [];
      this.lines = [truncateToWidth(styleImageLabel(attachments[0]!), width, "")];
      return this.lines;
    }
    const columns = Math.min(CARD_COLS, width);
    // Pi tracks one graphics anchor per line. Stack real thumbnails; fallback
    // cards are composable text and remain a compact horizontal OMP-style band.
    const count = caps.images ? Math.min(attachments.length, 4) : Math.min(attachments.length, Math.max(1, Math.floor((width + GAP) / (columns + GAP))));
    this.displayed = attachments.slice(0, count);
    if (caps.images) {
      this.lines = this.displayed.flatMap((item, i) => [...(i ? [""] : []), ...card(item, this.asset(item.key), this.theme, columns, true)]);
    } else {
      const cards = this.displayed.map((item) => card(item, undefined, this.theme, columns));
      this.lines = Array.from({ length: INNER_ROWS + 2 }, (_, row) => cards.map((c) => c[row]).join(" ".repeat(GAP)));
    }
    if (count < attachments.length) this.lines.push(truncateToWidth(this.theme.fg("dim", t.moreImages(attachments.length - count)), width, ""));
    return this.lines;
  }

  handleMouse(event: TuiMouseEvent) {
    if (!this.remove || event.type !== "click" || event.button !== "right") return undefined;
    // Only hit-test rows this component actually drew.
    if (event.y < 0 || event.y >= this.lines.length) return undefined;
    const index = getCapabilities().images ? Math.floor(event.y / 7) : Math.floor(event.x / (CARD_COLS + GAP));
    const attachment = this.displayed[index];
    if (!attachment) return undefined;
    this.remove(attachment.id);
    return { handled: true, render: true };
  }
}

// Pi has no atom/chip API. Decorate only this editor instance's segment/render
// methods; restoring the methods preserves its history, undo stack and callbacks.
type DecoratableEditor = Component & {
  segment?: (text: string, mode?: string) => Iterable<Intl.SegmentData>;
};

export function decorateImageTokens(editor: DecoratableEditor, lookup: (id: number) => Attachment | undefined): () => void {
  const originalRender = editor.render;
  const originalSegment = editor.segment;
  const render = (width: number) => originalRender.call(editor, width).map((line) =>
    line.replace(/📷 #(\d+)(?!\d)/g, (label, id) => {
      const attachment = lookup(Number(id));
      return attachment ? styleImageLabel(attachment) : label;
    }));
  const segment = (text: string, mode?: string) => {
    const spans = imageTokens(text).filter((token) => lookup(token.id));
    const source = originalSegment!.call(editor, text, mode);
    if (!spans.length) return source;
    const result: Intl.SegmentData[] = [];
    let current = 0;
    let emitted = false;
    for (const part of source) {
      while (current < spans.length && part.index >= spans[current]!.end) { current++; emitted = false; }
      const token = spans[current];
      if (token && part.index >= token.start && part.index < token.end) {
        if (!emitted) {
          result.push({ segment: text.slice(token.start, token.end), index: token.start, input: text });
          emitted = true;
        }
      } else result.push(part);
    }
    return result;
  };
  editor.render = render;
  if (originalSegment) editor.segment = segment;
  return () => {
    if (editor.render === render) editor.render = originalRender;
    if (editor.segment === segment) editor.segment = originalSegment;
  };
}
