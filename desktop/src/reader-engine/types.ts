import type { PdfAnnotation } from "../PdfReader";

export type PageTarget = { pageIndex: number };
export type AnnotationTarget = { annotationID: string };
export type DocumentInfo = { pagesCount: number };
export type SearchState = { total: number; index: number; snippets: string[] };

export type ReaderEvent =
  | { type: "initialized" }
  | { type: "selection-finalized"; annotation: PdfAnnotation; anchor: { x: number; y: number } }
  | { type: "selection-cleared" }
  | { type: "backdrop-tapped" }
  | { type: "annotation-draft"; annotation: PdfAnnotation }
  | { type: "annotation-activated"; annotationId: string | null }
  | { type: "view-state-changed"; pageIndex?: number; scale?: number | string }
  | { type: "view-stats-changed"; pagesCount: number; pageIndex: number }
  | { type: "search-changed"; state: SearchState | null }
  | { type: "link-opened"; url: string }
  | { type: "error"; message: string };

export interface RillPdfEngine {
  open(pdf: ArrayBuffer, annotations: PdfAnnotation[]): Promise<DocumentInfo>;
  navigate(target: PageTarget | AnnotationTarget): void;
  setZoom(command: "in" | "out" | "page-width"): void;
  setSpread(enabled: boolean): void;
  setTool(tool: "pointer" | "area-capture"): void;
  setAnnotations(snapshot: PdfAnnotation[], revision: number): void;
  search(query: string): Promise<SearchState>;
  findNext(): void;
  findPrevious(): void;
  clearSelection(): void;
  subscribe(listener: (event: ReaderEvent) => void): () => void;
  destroy(): void;
}
