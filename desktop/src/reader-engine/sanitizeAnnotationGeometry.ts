import type { AnnotationColor, AnnotationKind, PdfAnnotation } from "./types";

type AnnotationRect = PdfAnnotation["rects"][number];
type NormalizedRectFields = Pick<AnnotationRect, "x" | "y" | "width" | "height">;

const NORMALIZED_RECT_EPSILON = 1e-6;
const NORMALIZED_RECT_COMPARISON_EPSILON = NORMALIZED_RECT_EPSILON + Number.EPSILON * 8;
const annotationColors = new Set<AnnotationColor>(["yellow", "red", "green", "blue", "purple"]);
const annotationKinds = new Set<AnnotationKind>(["highlight", "underline", "strikeout", "area"]);

export type SanitizedAnnotationGeometry = {
  page: number;
  rects: AnnotationRect[];
  nextPageRects?: AnnotationRect[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidPage(value: unknown, pageCount: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= pageCount;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeRect(rect: Record<string, unknown>): NormalizedRectFields | null {
  const { x, y, width, height } = rect;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  const right = x + width;
  const bottom = y + height;
  if (
    width <= 0
    || height <= 0
    || !Number.isFinite(right)
    || !Number.isFinite(bottom)
    || x < -NORMALIZED_RECT_EPSILON
    || y < -NORMALIZED_RECT_EPSILON
    || right > 1 + NORMALIZED_RECT_COMPARISON_EPSILON
    || bottom > 1 + NORMALIZED_RECT_COMPARISON_EPSILON
  ) return null;

  if (x >= 0 && y >= 0 && right <= 1 && bottom <= 1) return { x, y, width, height };

  const normalizedX = Math.max(0, Math.min(1, x));
  const normalizedY = Math.max(0, Math.min(1, y));
  const normalizedRight = Math.max(0, Math.min(1, right));
  const normalizedBottom = Math.max(0, Math.min(1, bottom));
  const normalizedWidth = normalizedRight - normalizedX;
  const normalizedHeight = normalizedBottom - normalizedY;
  if (normalizedWidth <= 0 || normalizedHeight <= 0) return null;
  return { x: normalizedX, y: normalizedY, width: normalizedWidth, height: normalizedHeight };
}

export function sanitizePersistedAnnotationColor(value: unknown): AnnotationColor {
  return annotationColors.has(value as AnnotationColor) ? value as AnnotationColor : "yellow";
}

export function sanitizePersistedAnnotationKind(value: unknown): AnnotationKind {
  return annotationKinds.has(value as AnnotationKind) ? value as AnnotationKind : "highlight";
}

/**
 * Validates persisted annotation geometry before it crosses into the PDF engine.
 * A malformed rectangle rejects the whole annotation so its text and geometry
 * cannot become partially out of sync.
 */
export function sanitizePersistedAnnotationGeometry(
  annotation: unknown,
  pageCount: number,
): SanitizedAnnotationGeometry | null {
  if (!Number.isInteger(pageCount) || pageCount < 1 || !isRecord(annotation)) return null;
  if (!isValidPage(annotation.page, pageCount) || !Array.isArray(annotation.rects) || annotation.rects.length === 0) {
    return null;
  }

  const grouped = new Map<number, AnnotationRect[]>();
  for (const candidate of annotation.rects) {
    if (!isRecord(candidate)) return null;
    const normalized = normalizeRect(candidate);
    if (!normalized) return null;
    const effectivePage = candidate.page == null ? annotation.page : candidate.page;
    if (!isValidPage(effectivePage, pageCount)) return null;
    const rect: AnnotationRect = {
      page: effectivePage,
      ...normalized,
    };
    grouped.set(effectivePage, [...(grouped.get(effectivePage) ?? []), rect]);
  }

  const pages = [...grouped.keys()].sort((a, b) => a - b);
  if (pages.length < 1 || pages.length > 2 || (pages.length === 2 && pages[1] !== pages[0] + 1)) return null;

  const page = pages[0];
  const rects = grouped.get(page);
  if (!rects?.length) return null;
  const nextPageRects = pages.length === 2 ? grouped.get(pages[1]) : undefined;
  return nextPageRects?.length ? { page, rects, nextPageRects } : { page, rects };
}
