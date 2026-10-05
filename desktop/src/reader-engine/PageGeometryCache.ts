import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PdfAnnotation } from "./types";

export type PageBox = { x0: number; y0: number; x1: number; y1: number };

// Keep exact CropBoxes, including mixed page sizes, without opening every page
// before the first page can be displayed. In-flight requests are shared.
export class PageGeometryCache {
  readonly boxes: PageBox[];
  private pending = new Map<number, Promise<void>>();

  constructor(private readonly document: Pick<PDFDocumentProxy, "numPages" | "getPage">) {
    this.boxes = new Array<PageBox>(document.numPages);
  }

  async ensure(pages: number[]) {
    await Promise.all([...new Set(pages)].map((number) => this.load(number)));
  }

  private load(number: number): Promise<void> {
    if (!Number.isInteger(number) || number < 1 || number > this.boxes.length) return Promise.resolve();
    if (this.boxes[number - 1]) return Promise.resolve();
    const active = this.pending.get(number);
    if (active) return active;
    const operation = this.document.getPage(number).then((page) => {
      const [x0, y0, x1, y1] = page.view;
      this.boxes[number - 1] = { x0, y0, x1, y1 };
    }).finally(() => this.pending.delete(number));
    this.pending.set(number, operation);
    return operation;
  }
}

export function annotationPages(annotations: PdfAnnotation[]): number[] {
  return annotations.flatMap((annotation) => [
    annotation.page,
    ...(Array.isArray(annotation.rects) ? annotation.rects.map((rect) => rect?.page ?? annotation.page) : []),
  ]);
}
