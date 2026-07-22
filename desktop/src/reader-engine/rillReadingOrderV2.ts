import type { PdfAnnotation } from "../PdfReader";

export type ReadingOrderResult = {
  annotation: PdfAnnotation;
  strategy: "upstream" | "rillReadingOrderV2";
  confidence: number;
};

type Line = {
  text: string;
  rect: PdfAnnotation["rects"][number];
  sourceIndex: number;
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function reorderTwoColumns(lines: Line[]) {
  if (lines.length < 4) return null;
  const byX = [...lines].sort((a, b) => a.rect.x - b.rect.x);
  let split = -1;
  let largestGap = 0;
  for (let index = 0; index < byX.length - 1; index += 1) {
    const gap = byX[index + 1].rect.x - byX[index].rect.x;
    if (gap > largestGap) {
      largestGap = gap;
      split = index + 1;
    }
  }
  if (split < 2 || byX.length - split < 2) return null;
  const left = byX.slice(0, split);
  const right = byX.slice(split);
  const typicalWidth = median(lines.map((line) => line.rect.width));
  const leftEdge = Math.max(...left.map((line) => line.rect.x + line.rect.width));
  const rightEdge = Math.min(...right.map((line) => line.rect.x));
  const visibleColumnGap = rightEdge - leftEdge;
  if (largestGap < 0.12 || visibleColumnGap < 0.025 || largestGap < typicalWidth * 0.28) return null;

  const confidence = Math.min(1, 0.72 + visibleColumnGap * 1.4 + largestGap * 0.35);
  if (confidence < 0.82) return null;
  const topToBottom = (a: Line, b: Line) => a.rect.y - b.rect.y || a.rect.x - b.rect.x;
  return { lines: [...left.sort(topToBottom), ...right.sort(topToBottom)], confidence };
}

/**
 * Conservative post-processor for selections whose extracted lines map exactly
 * to their geometry. Ambiguous layouts deliberately keep the upstream order.
 */
export function rillReadingOrderV2(annotation: PdfAnnotation): ReadingOrderResult {
  if (annotation.kind === "area") return { annotation, strategy: "upstream", confidence: 0 };
  const textLines = annotation.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (textLines.length !== annotation.rects.length) {
    return { annotation, strategy: "upstream", confidence: 0 };
  }

  const sourceLines = textLines.map((text, sourceIndex) => ({ text, rect: annotation.rects[sourceIndex], sourceIndex }));
  const pages = [...new Set(sourceLines.map((line) => line.rect.page ?? annotation.page))].sort((a, b) => a - b);
  const output: Line[] = [];
  const confidences: number[] = [];
  let usedV2 = false;
  for (const page of pages) {
    const pageLines = sourceLines.filter((line) => (line.rect.page ?? annotation.page) === page);
    const reordered = reorderTwoColumns(pageLines);
    if (reordered) {
      output.push(...reordered.lines);
      confidences.push(reordered.confidence);
      usedV2 = true;
    } else {
      output.push(...pageLines.sort((a, b) => a.sourceIndex - b.sourceIndex));
    }
  }
  if (!usedV2) return { annotation, strategy: "upstream", confidence: 0 };
  return {
    annotation: { ...annotation, text: output.map((line) => line.text).join("\n"), rects: output.map((line) => line.rect) },
    strategy: "rillReadingOrderV2",
    confidence: Math.min(...confidences),
  };
}
