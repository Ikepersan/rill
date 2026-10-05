import type {
  AnnotationColor,
  AnnotationKind,
  AnnotationTarget,
  DocumentInfo,
  PageTarget,
  PdfAnnotation,
  ReaderEvent,
  RillPdfEngine,
  SearchState,
} from "./types";
import { rillReadingOrderV2 } from "./rillReadingOrderV2";
import { annotationPages } from "./PageGeometryCache";
import {
  sanitizePersistedAnnotationColor,
  sanitizePersistedAnnotationGeometry,
  sanitizePersistedAnnotationKind,
} from "./sanitizeAnnotationGeometry";

type PageBox = { x0: number; y0: number; x1: number; y1: number };
type EngineRect = [number, number, number, number];
type EngineAnnotation = {
  id?: string;
  type: string;
  color?: string;
  sortIndex?: string;
  pageLabel?: string;
  position: { pageIndex: number; rects: EngineRect[]; nextPageRects?: EngineRect[] };
  text?: string;
  comment?: string;
  image?: string;
  tags?: Array<{ name: string }>;
  dateCreated?: string;
  dateModified?: string;
  authorName?: string;
  readOnly?: boolean;
};

type BridgeEvent = { type: string; [key: string]: unknown };
type EngineBridge = {
  navigate(target: PageTarget | AnnotationTarget): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomPageWidth(): void;
  setSpread(enabled: boolean): void;
  setTool(tool: "pointer" | "area-capture"): void;
  setAnnotations(snapshot: EngineAnnotation[], revision: number): boolean;
  search(query: string): void;
  findNext(): void;
  findPrevious(): void;
  clearSelection(): void;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
  destroy(): void;
};

type EngineWindow = Window & typeof globalThis & {
  Uint8Array: typeof Uint8Array;
  createRillPdfEngine?: (options: Record<string, unknown>) => EngineBridge;
};

const colorToHex: Record<AnnotationColor, string> = {
  yellow: "#ffd400",
  red: "#ff6666",
  green: "#5fb236",
  blue: "#2ea8e5",
  purple: "#a28ae5",
};

function colorFromHex(color?: string): AnnotationColor {
  const normalized = color?.toLowerCase();
  return (Object.entries(colorToHex).find(([, value]) => value === normalized)?.[0] as AnnotationColor | undefined) ?? "yellow";
}

function annotationId() {
  return `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toEngineRect(rect: PdfAnnotation["rects"][number], box: PageBox): EngineRect {
  const width = box.x1 - box.x0;
  const height = box.y1 - box.y0;
  const left = box.x0 + rect.x * width;
  const right = left + rect.width * width;
  const top = box.y1 - rect.y * height;
  const bottom = top - rect.height * height;
  return [left, bottom, right, top];
}

function isUsablePageBox(box: PageBox | undefined): box is PageBox {
  return !!box
    && Number.isFinite(box.x0)
    && Number.isFinite(box.y0)
    && Number.isFinite(box.x1)
    && Number.isFinite(box.y1)
    && box.x1 > box.x0
    && box.y1 > box.y0;
}

function isEngineAnnotation(annotation: EngineAnnotation | null): annotation is EngineAnnotation {
  return annotation !== null;
}

function isEngineRect(rect: unknown): rect is EngineRect {
  return Array.isArray(rect)
    && rect.length === 4
    && rect.every((value) => typeof value === "number" && Number.isFinite(value));
}

function fromEngineRect(rect: EngineRect, page: number, box: PageBox): PdfAnnotation["rects"][number] {
  const width = box.x1 - box.x0;
  const height = box.y1 - box.y0;
  return {
    page,
    x: (rect[0] - box.x0) / width,
    y: (box.y1 - rect[3]) / height,
    width: (rect[2] - rect[0]) / width,
    height: (rect[3] - rect[1]) / height,
  };
}

function kindFromEngine(type: string): AnnotationKind {
  if (type === "underline") return "underline";
  if (type === "strikeout") return "strikeout";
  if (type === "image") return "area";
  return "highlight";
}

export class IframeRillPdfEngine implements RillPdfEngine {
  private bridge: EngineBridge | null = null;
  private listeners = new Set<(event: ReaderEvent) => void>();
  private unsubscribeBridge: (() => void) | null = null;
  private pageCount = 0;
  private pendingSearch: ((state: SearchState) => void) | null = null;
  private annotationRevision = -1;
  private selectionGeneration = 0;
  private destroyed = false;

  constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly boxes: PageBox[],
    private readonly ensurePageBoxes?: (pages: number[]) => Promise<void>,
  ) {}

  async open(pdf: ArrayBuffer, annotations: PdfAnnotation[]): Promise<DocumentInfo> {
    await this.ensurePageBoxes?.(annotationPages(annotations));
    if (this.destroyed) throw new Error("PDF Readerはすでに閉じられています");
    const frameWindow = this.frame.contentWindow as EngineWindow | null;
    if (!frameWindow?.createRillPdfEngine) throw new Error("Rill PDF selection engineを読み込めませんでした");
    // A number[] expands every PDF byte into a boxed JS number and can multiply
    // memory use for large papers. Copy directly into the iframe's typed array.
    const bytes = new frameWindow.Uint8Array(pdf);
    this.bridge = frameWindow.createRillPdfEngine({
      type: "pdf",
      data: { buf: bytes, url: new URL("/rill-pdf-engine/", window.location.href).toString() },
      annotations: annotations.map((annotation) => this.toEngineAnnotation(annotation)).filter(isEngineAnnotation),
      readOnly: false,
      authorName: "Rill",
      showAnnotations: true,
      viewState: { pageIndex: 0, scale: "page-width", scrollMode: 0, spreadMode: 0 },
      selectedAnnotationIDs: [],
      colorScheme: "light",
    });
    this.unsubscribeBridge = this.bridge.subscribe((event) => this.handleBridgeEvent(event));
    this.annotationRevision = 0;
    return new Promise<DocumentInfo>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("PDFエンジンの初期化がタイムアウトしました")), 20000);
      const unsubscribe = this.subscribe((event) => {
        if (event.type !== "initialized") return;
        window.clearTimeout(timer);
        unsubscribe();
        resolve({ pagesCount: this.pageCount || this.boxes.length });
      });
    });
  }

  navigate(target: PageTarget | AnnotationTarget) { this.bridge?.navigate(target); }

  setZoom(command: "in" | "out" | "page-width") {
    if (command === "in") this.bridge?.zoomIn();
    else if (command === "out") this.bridge?.zoomOut();
    else this.bridge?.zoomPageWidth();
  }

  setSpread(enabled: boolean) { this.bridge?.setSpread(enabled); }
  setTool(tool: "pointer" | "area-capture") { this.bridge?.setTool(tool); }

  setAnnotations(snapshot: PdfAnnotation[], revision: number) {
    if (!this.bridge || revision <= this.annotationRevision) return;
    this.bridge.setAnnotations(snapshot.map((annotation) => this.toEngineAnnotation(annotation)).filter(isEngineAnnotation), revision);
    this.annotationRevision = revision;
  }

  search(query: string) {
    return new Promise<SearchState>((resolve) => {
      this.pendingSearch?.({ total: 0, index: -1, snippets: [] });
      this.pendingSearch = resolve;
      this.bridge?.search(query);
      if (!query) {
        const empty = { total: 0, index: -1, snippets: [] };
        this.pendingSearch = null;
        resolve(empty);
      }
    });
  }

  findNext() { this.bridge?.findNext(); }
  findPrevious() { this.bridge?.findPrevious(); }
  clearSelection() { this.selectionGeneration += 1; this.bridge?.clearSelection(); }

  subscribe(listener: (event: ReaderEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy() {
    this.destroyed = true;
    this.selectionGeneration += 1;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
    this.bridge?.destroy();
    this.bridge = null;
    this.pendingSearch?.({ total: 0, index: -1, snippets: [] });
    this.pendingSearch = null;
    this.listeners.clear();
  }

  private emit(event: ReaderEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private handleBridgeEvent(event: BridgeEvent) {
    if (event.type === "initialized") {
      this.emit({ type: "initialized" });
      return;
    }
    if (event.type === "selection-finalized") {
      const generation = ++this.selectionGeneration;
      this.withAnnotationGeometry(event.annotation as EngineAnnotation, () => {
        if (generation !== this.selectionGeneration) return;
        const annotation = this.fromEngineAnnotation(event.annotation as EngineAnnotation);
        const rect = event.rect as [number, number, number, number];
        if (!annotation || !rect) return;
        const frameRect = this.frame.getBoundingClientRect();
        this.emit({
          type: "selection-finalized",
          annotation,
          anchor: { x: frameRect.left + (rect[0] + rect[2]) / 2, y: frameRect.top + rect[3] },
        });
      });
      return;
    }
    if (event.type === "selection-cleared") {
      this.selectionGeneration += 1;
      this.emit({ type: "selection-cleared" });
      return;
    }
    if (event.type === "context-menu-requested") {
      const x = event.x;
      const y = event.y;
      if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return;
      const generation = ++this.selectionGeneration;
      const source = event.annotation as EngineAnnotation | null;
      const publish = () => {
        if (generation !== this.selectionGeneration) return;
        const frameRect = this.frame.getBoundingClientRect();
        this.emit({
          type: "context-menu-requested",
          annotation: source ? this.fromEngineAnnotation(source) : null,
          anchor: { x: frameRect.left + x, y: frameRect.top + y },
        });
      };
      if (source) this.withAnnotationGeometry(source, publish);
      else publish();
      return;
    }
    if (event.type === "backdrop-tapped") {
      this.selectionGeneration += 1;
      this.emit({ type: "backdrop-tapped" });
      return;
    }
    if (event.type === "annotation-draft") {
      this.withAnnotationGeometry(event.annotation as EngineAnnotation, () => {
        const annotation = this.fromEngineAnnotation(event.annotation as EngineAnnotation);
        if (annotation) this.emit({ type: "annotation-draft", annotation });
      });
      return;
    }
    if (event.type === "annotation-activated") {
      const annotation = event.annotation as EngineAnnotation | undefined;
      this.emit({ type: "annotation-activated", annotationId: annotation?.id ?? null });
      return;
    }
    if (event.type === "view-state-changed") {
      const state = event.state as { pageIndex?: number; scale?: number | string };
      if (typeof state.pageIndex === "number") this.preloadVisibleGeometry(state.pageIndex);
      this.emit({ type: "view-state-changed", ...state });
      return;
    }
    if (event.type === "view-stats-changed") {
      const stats = event.stats as { pagesCount?: number; pageIndex?: number };
      this.pageCount = stats.pagesCount ?? this.pageCount;
      if (typeof stats.pageIndex === "number") this.preloadVisibleGeometry(stats.pageIndex);
      this.emit({ type: "view-stats-changed", pagesCount: this.pageCount, pageIndex: stats.pageIndex ?? 0 });
      return;
    }
    if (event.type === "search-changed") {
      const result = (event.result ?? null) as SearchState | null;
      if (result && this.pendingSearch) {
        this.pendingSearch(result);
        this.pendingSearch = null;
      }
      this.emit({ type: "search-changed", state: result });
      return;
    }
    if (event.type === "shortcut") {
      const command = event.command;
      if (command === "copy-selection" || command === "focus-search") {
        this.emit({ type: "shortcut", command });
      }
      return;
    }
    if (event.type === "link-opened") {
      this.emit({ type: "link-opened", url: String(event.url ?? "") });
    }
  }

  private preloadVisibleGeometry(pageIndex: number) {
    // Selection can cross onto the next page; warm only this small window.
    void this.ensurePageBoxes?.([pageIndex + 1, pageIndex + 2]).catch(() => undefined);
  }

  private withAnnotationGeometry(annotation: EngineAnnotation, publish: () => void) {
    const index = annotation?.position?.pageIndex;
    if (typeof index !== "number" || !Number.isInteger(index)) return;
    const pages = [index + 1];
    if (annotation.position.nextPageRects?.length) pages.push(index + 2);
    const missing = pages.filter((page) => !isUsablePageBox(this.boxes[page - 1]));
    if (!this.ensurePageBoxes || missing.length === 0) {
      if (!this.destroyed) publish();
      return;
    }
    void this.ensurePageBoxes(missing).then(() => {
      if (!this.destroyed) publish();
    }).catch((error) => {
      if (!this.destroyed) this.emit({ type: "error", message: `PDFのページ情報を読み込めませんでした: ${String(error)}` });
    });
  }

  private toEngineAnnotation(annotation: PdfAnnotation): EngineAnnotation | null {
    const geometry = sanitizePersistedAnnotationGeometry(annotation, this.boxes.length);
    if (!geometry) return null;
    const kind = sanitizePersistedAnnotationKind(annotation.kind);
    const color = sanitizePersistedAnnotationColor(annotation.color);
    const page = geometry.page;
    const box = this.boxes[page - 1];
    if (!isUsablePageBox(box)) return null;
    const position: EngineAnnotation["position"] = {
      pageIndex: page - 1,
      rects: geometry.rects.map((rect) => toEngineRect(rect, box)),
    };
    if (geometry.nextPageRects) {
      const nextPageBox = this.boxes[page];
      if (!isUsablePageBox(nextPageBox)) return null;
      position.nextPageRects = geometry.nextPageRects.map((rect) => toEngineRect(rect, nextPageBox));
    }
    return {
      id: annotation.id,
      type: kind === "area" ? "image" : kind,
      color: colorToHex[color],
      sortIndex: `${String(page - 1).padStart(5, "0")}|000000|00000`,
      pageLabel: String(page),
      position,
      text: annotation.text,
      comment: annotation.comment,
      image: annotation.imageDataUrl,
      tags: [],
      dateCreated: annotation.createdAt,
      dateModified: annotation.createdAt,
      authorName: "Rill",
      readOnly: true,
    };
  }

  private fromEngineAnnotation(annotation: EngineAnnotation): PdfAnnotation | null {
    if (!annotation?.position) return null;
    const { position } = annotation;
    if (typeof position.pageIndex !== "number" || !Number.isInteger(position.pageIndex)) return null;
    const page = position.pageIndex + 1;
    const box = this.boxes[page - 1];
    if (!isUsablePageBox(box) || !Array.isArray(position.rects)) return null;
    if (!position.rects.every(isEngineRect)) return null;
    const rects = position.rects.map((rect) => fromEngineRect(rect, page, box));
    if (position.nextPageRects !== undefined) {
      const nextPageBox = this.boxes[page];
      if (
        !Array.isArray(position.nextPageRects)
        || !position.nextPageRects.every(isEngineRect)
        || (position.nextPageRects.length > 0 && !isUsablePageBox(nextPageBox))
      ) return null;
      if (position.nextPageRects.length > 0 && nextPageBox) {
        rects.push(...position.nextPageRects.map((rect) => fromEngineRect(rect, page + 1, nextPageBox)));
      }
    }
    const converted: PdfAnnotation = {
      id: annotation.id ?? annotationId(),
      page,
      text: annotation.text ?? (annotation.type === "image" ? "範囲画像" : ""),
      color: colorFromHex(annotation.color),
      kind: kindFromEngine(annotation.type),
      imageDataUrl: annotation.image,
      comment: annotation.comment ?? "",
      rects,
      createdAt: annotation.dateCreated ?? new Date().toISOString(),
    };
    const sanitizedGeometry = sanitizePersistedAnnotationGeometry(converted, this.boxes.length);
    if (!sanitizedGeometry) return null;
    const sanitized = {
      ...converted,
      page: sanitizedGeometry.page,
      rects: [...sanitizedGeometry.rects, ...(sanitizedGeometry.nextPageRects ?? [])],
    };
    return rillReadingOrderV2(sanitized).annotation;
  }
}
