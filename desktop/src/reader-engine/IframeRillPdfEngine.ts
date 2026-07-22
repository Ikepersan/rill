import type { AnnotationColor, AnnotationKind, PdfAnnotation } from "../PdfReader";
import type {
  AnnotationTarget,
  DocumentInfo,
  PageTarget,
  ReaderEvent,
  RillPdfEngine,
  SearchState,
} from "./types";
import { rillReadingOrderV2 } from "./rillReadingOrderV2";

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

  constructor(private readonly frame: HTMLIFrameElement, private readonly boxes: PageBox[]) {}

  async open(pdf: ArrayBuffer, annotations: PdfAnnotation[]): Promise<DocumentInfo> {
    const frameWindow = this.frame.contentWindow as EngineWindow | null;
    if (!frameWindow?.createRillPdfEngine) throw new Error("Rill PDF selection engineを読み込めませんでした");
    const bytes = new frameWindow.Uint8Array(Array.from(new Uint8Array(pdf)));
    this.bridge = frameWindow.createRillPdfEngine({
      type: "pdf",
      data: { buf: bytes, url: new URL("/rill-pdf-engine/", window.location.href).toString() },
      annotations: annotations.map((annotation) => this.toEngineAnnotation(annotation)).filter(Boolean),
      readOnly: false,
      authorName: "Rill",
      showAnnotations: true,
      viewState: { pageIndex: 0, scale: "page-width", scrollMode: 0, spreadMode: 0 },
      selectedAnnotationIDs: [],
      colorScheme: "light",
    });
    this.unsubscribeBridge = this.bridge.subscribe((event) => this.handleBridgeEvent(event));
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
    this.bridge?.setAnnotations(snapshot.map((annotation) => this.toEngineAnnotation(annotation)).filter(Boolean), revision);
  }

  search(query: string) {
    return new Promise<SearchState>((resolve) => {
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
  clearSelection() { this.bridge?.clearSelection(); }

  subscribe(listener: (event: ReaderEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy() {
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
    this.bridge?.destroy();
    this.bridge = null;
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
      const annotation = this.fromEngineAnnotation(event.annotation as EngineAnnotation);
      const rect = event.rect as [number, number, number, number];
      if (!annotation || !rect) return;
      const frameRect = this.frame.getBoundingClientRect();
      this.emit({
        type: "selection-finalized",
        annotation,
        anchor: { x: frameRect.left + (rect[0] + rect[2]) / 2, y: frameRect.top + rect[3] },
      });
      return;
    }
    if (event.type === "selection-cleared") {
      this.emit({ type: "selection-cleared" });
      return;
    }
    if (event.type === "backdrop-tapped") {
      this.emit({ type: "backdrop-tapped" });
      return;
    }
    if (event.type === "annotation-draft") {
      const annotation = this.fromEngineAnnotation(event.annotation as EngineAnnotation);
      if (annotation) this.emit({ type: "annotation-draft", annotation });
      return;
    }
    if (event.type === "annotation-activated") {
      const annotation = event.annotation as EngineAnnotation | undefined;
      this.emit({ type: "annotation-activated", annotationId: annotation?.id ?? null });
      return;
    }
    if (event.type === "view-state-changed") {
      const state = event.state as { pageIndex?: number; scale?: number | string };
      this.emit({ type: "view-state-changed", ...state });
      return;
    }
    if (event.type === "view-stats-changed") {
      const stats = event.stats as { pagesCount?: number; pageIndex?: number };
      this.pageCount = stats.pagesCount ?? this.pageCount;
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
    if (event.type === "link-opened") {
      this.emit({ type: "link-opened", url: String(event.url ?? "") });
    }
  }

  private toEngineAnnotation(annotation: PdfAnnotation): EngineAnnotation {
    const grouped = new Map<number, PdfAnnotation["rects"]>();
    for (const rect of annotation.rects) {
      const page = rect.page ?? annotation.page;
      grouped.set(page, [...(grouped.get(page) ?? []), rect]);
    }
    const pages = [...grouped.keys()].sort((a, b) => a - b);
    const page = pages[0] ?? annotation.page;
    const box = this.boxes[page - 1];
    const position: EngineAnnotation["position"] = {
      pageIndex: page - 1,
      rects: (grouped.get(page) ?? []).map((rect) => toEngineRect(rect, box)),
    };
    const nextPage = pages.find((value) => value === page + 1);
    if (nextPage && this.boxes[nextPage - 1]) {
      position.nextPageRects = (grouped.get(nextPage) ?? []).map((rect) => toEngineRect(rect, this.boxes[nextPage - 1]));
    }
    return {
      id: annotation.id,
      type: annotation.kind === "area" ? "image" : annotation.kind,
      color: colorToHex[annotation.color],
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
    const page = annotation.position?.pageIndex + 1;
    const box = this.boxes[page - 1];
    if (!page || !box || !annotation.position?.rects) return null;
    const rects = annotation.position.rects.map((rect) => fromEngineRect(rect, page, box));
    if (annotation.position.nextPageRects?.length && this.boxes[page]) {
      rects.push(...annotation.position.nextPageRects.map((rect) => fromEngineRect(rect, page + 1, this.boxes[page])));
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
    return rillReadingOrderV2(converted).annotation;
  }
}
