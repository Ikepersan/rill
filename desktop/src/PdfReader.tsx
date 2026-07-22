import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import type { Paper } from "./App";

GlobalWorkerOptions.workerSrc = workerUrl;

export type AnnotationColor = "yellow" | "red" | "green" | "blue" | "purple";
export type AnnotationKind = "highlight" | "underline" | "strikeout" | "area";

export type PdfAnnotation = {
  id: string;
  page: number;
  text: string;
  color: AnnotationColor;
  kind: AnnotationKind;
  imageDataUrl?: string;
  comment: string;
  rects: Array<{ page?: number | null; x: number; y: number; width: number; height: number }>;
  createdAt: string;
};

type PendingSelection = { text: string; page: number; rects: PdfAnnotation["rects"]; x: number; y: number };
type AreaDraft = { page: number; x: number; y: number; width: number; height: number };
type OutlineItem = { title: string; dest: unknown; items?: OutlineItem[] };
type SelectionFragment = {
  text: string;
  page: number;
  rects: PdfAnnotation["rects"];
  fullRects: PdfAnnotation["rects"];
  isStart: boolean;
  isEnd: boolean;
};

const annotationColors: Array<{ color: AnnotationColor; label: string }> = [
  { color: "yellow", label: "黄" }, { color: "red", label: "赤" }, { color: "green", label: "緑" },
  { color: "blue", label: "青" }, { color: "purple", label: "紫" },
];

const kindLabels: Record<AnnotationKind, string> = { highlight: "ハイライト", underline: "下線", strikeout: "取り消し線", area: "範囲画像" };

function annotationId() { return `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

function mergeAnnotationRects(rects: PdfAnnotation["rects"]) {
  const sorted = [...rects].sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.y - b.y || a.x - b.x);
  const merged: PdfAnnotation["rects"] = [];
  for (const rect of sorted) {
    const previous = merged.at(-1);
    if (previous && (previous.page ?? 0) === (rect.page ?? 0)) {
      const overlap = Math.min(previous.y + previous.height, rect.y + rect.height) - Math.max(previous.y, rect.y);
      if (overlap >= Math.min(previous.height, rect.height) * .55 && rect.x <= previous.x + previous.width + .004) {
        const right = Math.max(previous.x + previous.width, rect.x + rect.width);
        const bottom = Math.max(previous.y + previous.height, rect.y + rect.height);
        previous.x = Math.min(previous.x, rect.x); previous.y = Math.min(previous.y, rect.y);
        previous.width = Math.min(.98 - previous.x, right - previous.x); previous.height = bottom - previous.y;
        continue;
      }
    }
    merged.push({ ...rect, width: Math.min(rect.width, .98 - rect.x) });
  }
  return merged;
}

function annotationPageLabel(annotation: PdfAnnotation) {
  const pages = Array.from(new Set(annotation.rects.map((rect) => rect.page ?? annotation.page))).sort((a, b) => a - b);
  return pages.length < 2 ? `Page ${pages[0] ?? annotation.page}` : `Pages ${pages[0]}–${pages.at(-1)}`;
}

function detectColumnSplit(fragments: SelectionFragment[]) {
  const intervals = fragments.flatMap((fragment) => fragment.fullRects.map((rect) => ({ left: rect.x, right: rect.x + rect.width })));
  if (intervals.length < 4) return null;
  const merged: Array<{ left: number; right: number }> = [];
  for (const interval of intervals.sort((a, b) => a.left - b.left)) {
    const previous = merged.at(-1);
    if (previous && interval.left <= previous.right + .008) previous.right = Math.max(previous.right, interval.right);
    else merged.push({ ...interval });
  }
  let best: { split: number; width: number } | null = null;
  for (let index = 1; index < merged.length; index += 1) {
    const left = merged[index - 1].right; const right = merged[index].left; const split = (left + right) / 2;
    if (right - left < .025 || split < .25 || split > .75) continue;
    const leftCount = intervals.filter((interval) => (interval.left + interval.right) / 2 < split).length;
    const rightCount = intervals.length - leftCount;
    if (leftCount < 2 || rightCount < 2) continue;
    if (!best || right - left > best.width) best = { split, width: right - left };
  }
  return best?.split ?? null;
}

function filterSelectionGeometry(fragments: SelectionFragment[]) {
  if (fragments.length < 2) return fragments;
  const pageNumbers = Array.from(new Set(fragments.map((fragment) => fragment.page))).sort((a, b) => a - b);
  const firstPage = pageNumbers[0]; const lastPage = pageNumbers.at(-1) ?? firstPage;
  const first = fragments.find((fragment) => fragment.isStart) ?? fragments.find((fragment) => fragment.page === firstPage) ?? fragments[0];
  const last = fragments.find((fragment) => fragment.isEnd) ?? [...fragments].reverse().find((fragment) => fragment.page === lastPage) ?? fragments.at(-1)!;
  const firstRect = first.rects[0] ?? first.fullRects[0];
  const lastRect = last.rects.at(-1) ?? last.fullRects.at(-1);
  if (!firstRect || !lastRect) return fragments;

  return fragments.flatMap((fragment) => {
    if (fragment.page !== firstPage && fragment.page !== lastPage) return [fragment];
    const pageFragments = fragments.filter((candidate) => candidate.page === fragment.page);
    const split = detectColumnSplit(pageFragments);
    if (split === null) return [fragment];
    const firstSide = firstRect.x + firstRect.width / 2 < split ? "left" : "right";
    const lastSide = lastRect.x + lastRect.width / 2 < split ? "left" : "right";
    const keptRects = fragment.rects.filter((rect) => {
      const side = rect.x + rect.width / 2 < split ? "left" : "right";
      if (firstPage === lastPage) {
        if (firstSide === lastSide) return side === firstSide;
        if (side === firstSide) return rect.y + rect.height >= firstRect.y - .012;
        if (side === lastSide) return rect.y <= lastRect.y + lastRect.height + .012;
        return false;
      }
      if (fragment.page === firstPage) {
        if (side === firstSide) return rect.y + rect.height >= firstRect.y - .012;
        return firstSide === "left" && side === "right";
      }
      if (side === lastSide) return rect.y <= lastRect.y + lastRect.height + .012;
      return lastSide === "right" && side === "left";
    });
    return keptRects.length ? [{ ...fragment, rects: keptRects }] : [];
  });
}

function sortSelectionFragments(fragments: SelectionFragment[]) {
  const splits = new Map<number, number | null>();
  for (const page of new Set(fragments.map((fragment) => fragment.page))) {
    splits.set(page, detectColumnSplit(fragments.filter((fragment) => fragment.page === page)));
  }
  return [...fragments].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    const aRect = a.rects[0]; const bRect = b.rects[0];
    if (!aRect || !bRect) return 0;
    const split = splits.get(a.page);
    if (split !== null && split !== undefined) {
      const aSide = aRect.x + aRect.width / 2 < split ? 0 : 1;
      const bSide = bRect.x + bRect.width / 2 < split ? 0 : 1;
      if (aSide !== bSide) return aSide - bSide;
    }
    if (Math.abs(aRect.y - bRect.y) > .012) return aRect.y - bRect.y;
    return aRect.x - bRect.x;
  });
}

function flattenOutline(items: OutlineItem[], depth = 0): Array<OutlineItem & { depth: number }> {
  return items.flatMap((item) => [{ ...item, depth }, ...flattenOutline(item.items ?? [], depth + 1)]);
}

function PdfThumbnail({ document, page, active, onClick }: { document: PDFDocumentProxy; page: number; active: boolean; onClick: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    void document.getPage(page).then((pdfPage) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = pdfPage.getViewport({ scale: .22 });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) return;
      canvas.width = viewport.width; canvas.height = viewport.height;
      void pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
    });
    return () => { cancelled = true; };
  }, [document, page]);
  return <button type="button" className={active ? "pdf-thumbnail active" : "pdf-thumbnail"} onClick={onClick}><canvas ref={canvasRef} /><span>{page}</span></button>;
}

export function PdfReader({ root, paper, onClose, onOpenExternal, onToast }: {
  root: string; paper: Paper; onClose: () => void; onOpenExternal: () => void; onToast: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const pdfViewerRef = useRef<PDFViewer | null>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const annotationsRef = useRef<PdfAnnotation[]>([]);
  const activeAnnotationRef = useRef<string | null>(null);
  const pendingSelectionRef = useRef<PendingSelection | null>(null);
  const areaStartRef = useRef<{ page: HTMLElement; pageNumber: number; x: number; y: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1);
  const [pdfDocumentState, setPdfDocumentState] = useState<PDFDocumentProxy | null>(null);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [pendingKind, setPendingKind] = useState<Exclude<AnnotationKind, "area">>("highlight");
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState("保存済み");
  const [sidebarTab, setSidebarTab] = useState<"pages" | "outline">("pages");
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [spread, setSpread] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pageTexts, setPageTexts] = useState<string[]>([]);
  const [searchCursor, setSearchCursor] = useState(0);
  const [areaMode, setAreaMode] = useState(false);
  const [areaDraft, setAreaDraft] = useState<AreaDraft | null>(null);

  const searchResults = useMemo(() => {
    const needle = searchQuery.trim().toLocaleLowerCase();
    if (!needle) return [];
    return pageTexts.flatMap((text, index) => text.toLocaleLowerCase().includes(needle) ? [index + 1] : []);
  }, [pageTexts, searchQuery]);

  function renderAnnotations(next = annotationsRef.current) {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.querySelectorAll(".rill-pdf-annotation, .rill-pdf-selection-preview").forEach((element) => element.remove());
    for (const annotation of next) for (const rect of mergeAnnotationRects(annotation.rects)) {
      const page = viewer.querySelector<HTMLElement>(`.page[data-page-number="${rect.page ?? annotation.page}"]`);
      if (!page) continue;
      const mark = documentRef.current && window.document.createElement("span");
      if (!mark) continue;
      mark.className = `rill-pdf-annotation ${annotation.kind || "highlight"} ${annotation.color}${annotation.id === activeAnnotationRef.current ? " active" : ""}`;
      mark.style.left = `${rect.x * 100}%`; mark.style.top = `${rect.y * 100}%`;
      mark.style.width = `${rect.width * 100}%`; mark.style.height = `${rect.height * 100}%`;
      page.appendChild(mark);
    }
    for (const rect of mergeAnnotationRects(pendingSelectionRef.current?.rects ?? [])) {
      const page = viewer.querySelector<HTMLElement>(`.page[data-page-number="${rect.page ?? pendingSelectionRef.current?.page ?? 1}"]`);
      if (!page) continue;
      const preview = window.document.createElement("span");
      preview.className = "rill-pdf-selection-preview";
      preview.style.left = `${rect.x * 100}%`; preview.style.top = `${rect.y * 100}%`;
      preview.style.width = `${rect.width * 100}%`; preview.style.height = `${rect.height * 100}%`;
      page.appendChild(preview);
    }
  }

  useEffect(() => {
    let disposed = false;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    async function load() {
      const container = containerRef.current; const viewer = viewerRef.current;
      if (!container || !viewer) return;
      setLoading(true); setError("");
      try {
        const [raw, stored] = await Promise.all([
          invoke<ArrayBuffer>("read_pdf_bytes", { root, pdfPath: paper.pdfPath }),
          invoke<PdfAnnotation[]>("load_pdf_annotations", { root, paperId: paper.id }),
        ]);
        const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw as unknown as ArrayLike<number>);
        loadingTask = getDocument({ data: bytes });
        const pdfDocument = await loadingTask.promise;
        if (disposed) return;
        documentRef.current = pdfDocument; setPdfDocumentState(pdfDocument); setPageCount(pdfDocument.numPages);
        const eventBus = new EventBus(); const linkService = new PDFLinkService({ eventBus });
        const pdfViewer = new PDFViewer({ container, viewer, eventBus, linkService, textLayerMode: 1 });
        linkService.setViewer(pdfViewer); linkService.setDocument(pdfDocument); pdfViewer.setDocument(pdfDocument); pdfViewerRef.current = pdfViewer;
        eventBus.on("pagesinit", () => { pdfViewer.currentScaleValue = "page-width"; setScale(pdfViewer.currentScale); setLoading(false); window.setTimeout(renderAnnotations, 80); });
        eventBus.on("pagechanging", (event: { pageNumber: number }) => setPageNumber(event.pageNumber));
        eventBus.on("scalechanging", (event: { scale: number }) => { setScale(event.scale); window.setTimeout(renderAnnotations, 80); });
        eventBus.on("textlayerrendered", (event: { pageNumber: number }) => {
          renderAnnotations();
          const text = viewer.querySelector<HTMLElement>(`.page[data-page-number="${event.pageNumber}"] .textLayer`)?.textContent ?? "";
          setPageTexts((current) => { const next = [...current]; next[event.pageNumber - 1] = text; return next; });
        });
        annotationsRef.current = stored.map((annotation) => ({ ...annotation, kind: annotation.kind || "highlight" }));
        setAnnotations(annotationsRef.current);
        try { const rawOutline = await pdfDocument.getOutline(); if (!disposed) setOutline((rawOutline ?? []) as unknown as OutlineItem[]); }
        catch { if (!disposed) setOutline([]); }
        const texts: string[] = [];
        for (let number = 1; number <= pdfDocument.numPages; number += 1) {
          try {
            const content = await (await pdfDocument.getPage(number)).getTextContent();
            texts.push(Array.from(content.items).map((item) => item && typeof item === "object" && "str" in item ? item.str : "").join(" "));
          } catch { texts.push(""); }
        }
        if (!disposed) setPageTexts((current) => texts.map((text, index) => text || current[index] || ""));
      } catch (loadError) { if (!disposed) { setError(String(loadError)); setLoading(false); } }
    }
    void load();
    return () => { disposed = true; void loadingTask?.destroy(); pdfViewerRef.current = null; documentRef.current = null; };
  }, [paper.id, paper.pdfPath, root]);

  useEffect(() => { annotationsRef.current = annotations; activeAnnotationRef.current = activeAnnotationId; window.setTimeout(renderAnnotations, 0); }, [annotations, activeAnnotationId]);
  useEffect(() => { pendingSelectionRef.current = pending; window.setTimeout(renderAnnotations, 0); }, [pending]);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.key === "Escape") { if (areaMode) { event.preventDefault(); setAreaMode(false); setAreaDraft(null); areaStartRef.current = null; } else onClose(); } if ((event.metaKey || event.ctrlKey) && event.key === "f") { event.preventDefault(); window.document.getElementById("pdf-search")?.focus(); } }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, [areaMode, onClose]);

  async function persistAnnotations(next: PdfAnnotation[], message?: string) {
    annotationsRef.current = next; setAnnotations(next); setSaveState("保存中…");
    try { await invoke("save_pdf_annotations", { root, paper, annotations: next }); setSaveState("保存済み・Markdown同期済み"); if (message) onToast(message); }
    catch (saveError) { setSaveState("保存エラー"); onToast(String(saveError)); }
  }

  function captureSelection(event: ReactMouseEvent<HTMLDivElement>) {
    if (areaMode) return;
    window.setTimeout(() => {
      const selection = window.getSelection(); const viewer = viewerRef.current;
      if (!selection || selection.rangeCount === 0 || !viewer) { setPending(null); return; }
      const range = selection.getRangeAt(0); const walker = window.document.createTreeWalker(viewer, NodeFilter.SHOW_TEXT);
      const fragments: SelectionFragment[] = [];
      let current = walker.nextNode();
      while (current) {
        const node = current as Text; const textLayer = node.parentElement?.closest<HTMLElement>(".textLayer");
        const page = textLayer?.closest<HTMLElement>(".page[data-page-number]");
        if (textLayer && page && node.data && range.intersectsNode(node)) {
          const start = node === range.startContainer ? range.startOffset : 0; const end = node === range.endContainer ? range.endOffset : node.data.length;
          if (end > start) {
            const fragment = window.document.createRange(); fragment.setStart(node, Math.max(0, Math.min(start, node.length))); fragment.setEnd(node, Math.max(0, Math.min(end, node.length)));
            const full = window.document.createRange(); full.selectNodeContents(node);
            const pageRect = page.getBoundingClientRect(); const rects: PdfAnnotation["rects"] = []; const fullRects: PdfAnnotation["rects"] = [];
            const normalizeRects = (source: DOMRectList | DOMRect[]) => Array.from(source).flatMap((clientRect) => {
              const left = Math.max(pageRect.left, clientRect.left), top = Math.max(pageRect.top, clientRect.top);
              const right = Math.min(pageRect.right, clientRect.right), bottom = Math.min(pageRect.bottom, clientRect.bottom);
              return right - left > 1 && bottom - top > 1 ? [{ page: Number(page.dataset.pageNumber ?? 1), x: (left - pageRect.left) / pageRect.width, y: (top - pageRect.top) / pageRect.height, width: (right - left) / pageRect.width, height: (bottom - top) / pageRect.height }] : [];
            });
            rects.push(...normalizeRects(fragment.getClientRects())); fullRects.push(...normalizeRects(full.getClientRects()));
            if (rects.length) fragments.push({ text: node.data.slice(start, end), page: Number(page.dataset.pageNumber ?? 1), rects, fullRects: fullRects.length ? fullRects : rects, isStart: node === range.startContainer, isEnd: node === range.endContainer });
          }
        }
        current = walker.nextNode();
      }
      const filtered = sortSelectionFragments(filterSelectionGeometry(fragments));
      const text = filtered.map((fragment) => fragment.text).join(" ").replace(/\s+/g, " ").trim();
      const merged = mergeAnnotationRects(filtered.flatMap((fragment) => fragment.rects)); const pages = merged.map((rect) => rect.page ?? 1);
      selection.removeAllRanges();
      if (text.length < 2 || merged.length === 0) { setPending(null); return; }
      setPending({ text, page: Math.min(...pages), rects: merged, x: event.clientX, y: event.clientY });
    }, 0);
  }

  function addTextAnnotation(color: AnnotationColor) {
    if (!pending) return;
    const annotation: PdfAnnotation = { id: annotationId(), page: pending.page, text: pending.text, color, kind: pendingKind, comment: "", rects: pending.rects, createdAt: new Date().toISOString() };
    setActiveAnnotationId(annotation.id); setPending(null); void persistAnnotations([...annotationsRef.current, annotation], `${kindLabels[pendingKind]}をメモへ追加しました`);
  }

  function startArea(event: ReactPointerEvent<HTMLDivElement>) {
    if (!areaMode || event.button !== 0) return;
    const target = event.target as HTMLElement; const page = target.closest<HTMLElement>(".page[data-page-number]");
    if (!page) return;
    event.preventDefault(); const rect = page.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)); const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    areaStartRef.current = { page, pageNumber: Number(page.dataset.pageNumber ?? 1), x, y }; setAreaDraft({ page: Number(page.dataset.pageNumber ?? 1), x, y, width: 0, height: 0 });
  }

  function moveArea(event: ReactPointerEvent<HTMLDivElement>) {
    const start = areaStartRef.current; if (!start) return; const rect = start.page.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)); const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    setAreaDraft({ page: start.pageNumber, x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) });
  }

  function finishArea() {
    const start = areaStartRef.current; const area = areaDraft; areaStartRef.current = null; setAreaDraft(null);
    if (!start || !area || area.width < .01 || area.height < .01) return;
    const source = start.page.querySelector<HTMLCanvasElement>(".canvasWrapper canvas"); let imageDataUrl: string | undefined;
    if (source) { const crop = window.document.createElement("canvas"); crop.width = Math.max(1, Math.round(source.width * area.width)); crop.height = Math.max(1, Math.round(source.height * area.height)); crop.getContext("2d")?.drawImage(source, source.width * area.x, source.height * area.y, crop.width, crop.height, 0, 0, crop.width, crop.height); imageDataUrl = crop.toDataURL("image/jpeg", .82); }
    const annotation: PdfAnnotation = { id: annotationId(), page: area.page, text: "範囲画像", color: "yellow", kind: "area", imageDataUrl, comment: "", rects: [area], createdAt: new Date().toISOString() };
    setAreaMode(false); setActiveAnnotationId(annotation.id); void persistAnnotations([...annotationsRef.current, annotation], "選択範囲を撮影してメモへ追加しました");
  }

  function updateAnnotation(id: string, patch: Partial<PdfAnnotation>, save = false) {
    const next = annotationsRef.current.map((annotation) => annotation.id === id ? { ...annotation, ...patch } : annotation); annotationsRef.current = next; setAnnotations(next); setSaveState("入力中…"); if (save) void persistAnnotations(next);
  }
  function removeAnnotation(id: string) { void persistAnnotations(annotationsRef.current.filter((annotation) => annotation.id !== id), "注釈を削除しました"); }
  function focusAnnotation(annotation: PdfAnnotation) { setActiveAnnotationId(annotation.id); pdfViewerRef.current?.scrollPageIntoView({ pageNumber: annotation.page }); }
  function zoom(delta: number) { const viewer = pdfViewerRef.current; if (viewer) viewer.currentScale = Math.max(.55, Math.min(3, viewer.currentScale + delta)); }
  function goToSearch(direction: number) { if (!searchResults.length) return; const next = (searchCursor + direction + searchResults.length) % searchResults.length; setSearchCursor(next); if (pdfViewerRef.current) pdfViewerRef.current.currentPageNumber = searchResults[next]; }
  async function goToOutline(item: OutlineItem) { const pdf = documentRef.current; if (!pdf || !item.dest) return; const dest = typeof item.dest === "string" ? await pdf.getDestination(item.dest) : item.dest as unknown[]; if (!dest) return; const ref = dest[0] as Parameters<PDFDocumentProxy["getPageIndex"]>[0]; const index = typeof ref === "object" ? await pdf.getPageIndex(ref) : Number(ref); if (pdfViewerRef.current) pdfViewerRef.current.currentPageNumber = index + 1; }
  function toggleSpread() { const next = !spread; setSpread(next); const viewer = pdfViewerRef.current as unknown as { spreadMode: number } | null; if (viewer) viewer.spreadMode = next ? 1 : 0; }

  return (
    <section className="reader-view">
      <header className="reader-toolbar">
        <button type="button" className="reader-back" onClick={onClose} title="Libraryへ戻る（Esc）"><span>←</span><strong>Back</strong><small>Library</small></button>
        <div className="reader-title"><strong>{paper.title}</strong><small>{paper.authors[0] ?? "著者未登録"} · {paper.year ?? "年不明"}</small></div>
        <label className="reader-search"><span>⌕</span><input id="pdf-search" value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setSearchCursor(0); }} placeholder="PDF内を検索" />{searchQuery && <small>{searchResults.length ? `${searchCursor + 1}/${searchResults.length}` : "0"}</small>}<button type="button" onClick={() => goToSearch(-1)}>↑</button><button type="button" onClick={() => goToSearch(1)}>↓</button></label>
        <div className="reader-page-control"><button type="button" onClick={() => pdfViewerRef.current && (pdfViewerRef.current.currentPageNumber = Math.max(1, pageNumber - 1))}>‹</button><span>{pageNumber} / {pageCount || "—"}</span><button type="button" onClick={() => pdfViewerRef.current && (pdfViewerRef.current.currentPageNumber = Math.min(pageCount, pageNumber + 1))}>›</button></div>
        <div className="reader-zoom"><button type="button" onClick={() => zoom(-.15)}>−</button><span>{Math.round(scale * 100)}%</span><button type="button" onClick={() => zoom(.15)}>＋</button></div>
        <button type="button" className={spread ? "reader-tool active" : "reader-tool"} onClick={toggleSpread}>見開き</button>
        <button type="button" className={`${areaMode ? "reader-tool active" : "reader-tool"} capture-tool`} aria-pressed={areaMode} title="PDFの一部を画像としてメモに追加" onClick={() => { const next = !areaMode; setAreaMode(next); if (next) onToast("PDF上をドラッグして、撮影する範囲を囲んでください"); }}><svg aria-hidden="true" viewBox="0 0 18 18"><path d="M5 2v3H2M13 2v3h3M5 16v-3H2M13 16v-3h3M5 5h8v8H5z" /></svg><span>{areaMode ? "撮影をキャンセル" : "範囲を撮影"}</span></button>
        <button type="button" className="reader-external" onClick={onOpenExternal}>プレビュー ↗</button>
      </header>
      <div className="reader-workspace">
        <aside className="reader-navigation"><div className="reader-nav-tabs"><button className={sidebarTab === "pages" ? "active" : ""} onClick={() => setSidebarTab("pages")}>ページ</button><button className={sidebarTab === "outline" ? "active" : ""} onClick={() => setSidebarTab("outline")}>目次</button></div><div className="reader-nav-list">{sidebarTab === "pages" && pdfDocumentState && Array.from({ length: pageCount }, (_, index) => <PdfThumbnail key={index + 1} document={pdfDocumentState} page={index + 1} active={pageNumber === index + 1} onClick={() => pdfViewerRef.current && (pdfViewerRef.current.currentPageNumber = index + 1)} />)}{sidebarTab === "outline" && (flattenOutline(outline).length ? flattenOutline(outline).map((item, index) => <button type="button" key={`${item.title}-${index}`} className="outline-item" style={{ paddingLeft: `${10 + item.depth * 13}px` }} onClick={() => void goToOutline(item)}>{item.title}</button>) : <p className="outline-empty">このPDFには目次がありません</p>)}</div></aside>
        <div className={areaMode ? "pdf-stage area-mode" : "pdf-stage"} onPointerDown={startArea} onPointerMove={moveArea} onPointerUp={finishArea}>
          <div className="pdf-scroll-container" ref={containerRef} onMouseUp={captureSelection}><div className="pdfViewer" ref={viewerRef} /></div>
          {areaMode && !areaDraft && <div className="area-capture-guide" role="status"><strong>ドラッグして撮影範囲を囲む</strong><small>Escでキャンセル</small></div>}
          {areaDraft && <div className="area-selection-status">撮影範囲を選択中…</div>}
          {loading && <div className="pdf-loading"><span>PDF</span><p>論文を開いています…</p></div>}{error && <div className="pdf-loading error"><span>!</span><p>{error}</p><button type="button" onClick={onOpenExternal}>プレビューで開く</button></div>}
        </div>
        <aside className="reader-notes"><div className="reader-notes-heading"><div><span>Reading notes</span><small>{annotations.length} annotations</small></div><em>{saveState}</em></div><div className="reader-note-intro">本文は選択して注釈にできます。図表は「範囲を撮影」で囲むと画像メモになります。</div><div className="annotation-list">{annotations.map((annotation) => <article key={annotation.id} className={`${activeAnnotationId === annotation.id ? "active " : ""}annotation-card ${annotation.color}`} onClick={() => focusAnnotation(annotation)}><div className="annotation-meta"><span>{annotationPageLabel(annotation)} · {kindLabels[annotation.kind || "highlight"]}</span><div className="annotation-color-picker">{annotationColors.map(({ color, label }) => <button key={color} title={`${label}へ変更`} className={`${color}${annotation.color === color ? " active" : ""}`} onClick={(event) => { event.stopPropagation(); updateAnnotation(annotation.id, { color }, true); }} />)}</div><button type="button" onClick={(event) => { event.stopPropagation(); removeAnnotation(annotation.id); }}>削除</button></div>{annotation.imageDataUrl ? <img className="annotation-image" src={annotation.imageDataUrl} alt="PDFから撮影した範囲" /> : <blockquote>{annotation.text}</blockquote>}<textarea value={annotation.comment} rows={3} placeholder="この引用について考えたこと…" onClick={(event) => event.stopPropagation()} onChange={(event) => updateAnnotation(annotation.id, { comment: event.target.value })} onBlur={() => void persistAnnotations(annotationsRef.current)} /></article>)}{!annotations.length && <div className="annotation-empty"><span>✦</span><strong>まだ注釈はありません</strong><small>PDF本文を選択してください</small></div>}</div></aside>
      </div>
      {pending && <div className="selection-menu expanded" style={{ left: Math.min(pending.x, window.innerWidth - 330), top: Math.min(pending.y + 12, window.innerHeight - 105) }}><div className="annotation-kind-options">{(["highlight", "underline", "strikeout"] as const).map((kind) => <button key={kind} type="button" className={pendingKind === kind ? "active" : ""} onClick={() => setPendingKind(kind)}>{kindLabels[kind]}</button>)}</div><div className="annotation-color-options">{annotationColors.map(({ color, label }) => <button key={color} type="button" className={color} title={`${label}で追加`} onClick={() => addTextAnnotation(color)}><span /></button>)}</div></div>}
    </section>
  );
}
