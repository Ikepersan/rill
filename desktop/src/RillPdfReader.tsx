import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Paper } from "./App";
import { AnnotationRepository, type RepositoryState } from "./reader-engine/AnnotationRepository";
import { IframeRillPdfEngine } from "./reader-engine/IframeRillPdfEngine";
import type { AnnotationColor, AnnotationKind, PdfAnnotation, ReaderEvent, SearchState } from "./reader-engine/types";
import { copyPlainText } from "./reader-engine/copyText";

GlobalWorkerOptions.workerSrc = workerUrl;

type PageBox = { x0: number; y0: number; x1: number; y1: number };
type OutlineItem = { title: string; dest: unknown; items?: OutlineItem[] };
type PendingSelection = { annotation: PdfAnnotation; anchor: { x: number; y: number } };

const MAX_READER_PAGES = 2_000;
const MAX_CAPTURE_PIXELS = 16_000_000;
const MAX_CAPTURE_DIMENSION = 8_192;

const annotationColors: Array<{ color: AnnotationColor; label: string }> = [
  { color: "yellow", label: "黄" },
  { color: "red", label: "赤" },
  { color: "green", label: "緑" },
  { color: "blue", label: "青" },
  { color: "purple", label: "紫" },
];

const kindLabels: Record<AnnotationKind, string> = {
  highlight: "ハイライト",
  underline: "下線",
  strikeout: "取り消し線",
  area: "範囲画像",
};

function annotationPageLabel(annotation: PdfAnnotation) {
  const pages = Array.from(new Set(annotation.rects.map((rect) => rect.page ?? annotation.page))).sort((a, b) => a - b);
  return pages.length < 2 ? `Page ${pages[0] ?? annotation.page}` : `Pages ${pages[0]}–${pages.at(-1)}`;
}

function flattenOutline(items: OutlineItem[], depth = 0): Array<OutlineItem & { depth: number }> {
  return items.flatMap((item) => [{ ...item, depth }, ...flattenOutline(item.items ?? [], depth + 1)]);
}

function PdfThumbnail({ document, page, active, onClick }: {
  document: PDFDocumentProxy;
  page: number;
  active: boolean;
  onClick: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(page <= 3);

  useEffect(() => {
    const button = buttonRef.current;
    if (!button || visible || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "320px 0px" });
    observer.observe(button);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | null = null;
    void document.getPage(page).then((pdfPage) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = pdfPage.getViewport({ scale: 0.22 });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      renderTask = pdfPage.render({ canvas, canvasContext: context, viewport });
      void renderTask.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, page, visible]);
  return (
    <button ref={buttonRef} type="button" className={active ? "pdf-thumbnail active" : "pdf-thumbnail"} onClick={onClick}>
      <span className="pdf-thumbnail-preview"><canvas ref={canvasRef} /></span>
      <span className="pdf-thumbnail-number">{page}</span>
    </button>
  );
}

async function captureAreaImage(document: PDFDocumentProxy, annotation: PdfAnnotation) {
  const rect = annotation.rects[0];
  if (!rect) return undefined;
  const page = await document.getPage(rect.page ?? annotation.page);
  const naturalViewport = page.getViewport({ scale: 1 });
  if (
    !Number.isFinite(naturalViewport.width)
    || !Number.isFinite(naturalViewport.height)
    || naturalViewport.width <= 0
    || naturalViewport.height <= 0
  ) return undefined;
  const pixelScale = Math.sqrt(MAX_CAPTURE_PIXELS / Math.max(1, naturalViewport.width * naturalViewport.height));
  const dimensionScale = MAX_CAPTURE_DIMENSION / Math.max(1, naturalViewport.width, naturalViewport.height);
  const scale = Math.min(2, pixelScale, dimensionScale);
  if (!Number.isFinite(scale) || scale <= 0) return undefined;
  const viewport = page.getViewport({ scale });
  const sourceWidth = Math.max(1, Math.floor(viewport.width));
  const sourceHeight = Math.max(1, Math.floor(viewport.height));
  if (
    sourceWidth > MAX_CAPTURE_DIMENSION
    || sourceHeight > MAX_CAPTURE_DIMENSION
    || sourceWidth * sourceHeight > MAX_CAPTURE_PIXELS
  ) return undefined;
  const source = window.document.createElement("canvas");
  const sourceContext = source.getContext("2d");
  if (!sourceContext) return undefined;
  source.width = sourceWidth;
  source.height = sourceHeight;
  await page.render({ canvas: source, canvasContext: sourceContext, viewport }).promise;
  const crop = window.document.createElement("canvas");
  crop.width = Math.max(1, Math.round(source.width * rect.width));
  crop.height = Math.max(1, Math.round(source.height * rect.height));
  const cropContext = crop.getContext("2d");
  if (!cropContext) return undefined;
  cropContext.drawImage(
    source,
    source.width * rect.x,
    source.height * rect.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  return crop.toDataURL("image/jpeg", 0.84);
}

export function RillPdfReader({ root, paper, onClose, onOpenExternal, onToast, onRegisterFlush }: {
  root: string;
  paper: Paper;
  onClose: () => void;
  onOpenExternal: () => void;
  onToast: (message: string) => void;
  onRegisterFlush?: (flush: (() => Promise<void>) | null) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const engineRef = useRef<IframeRillPdfEngine | null>(null);
  const repositoryRef = useRef<AnnotationRepository | null>(null);
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const paperRef = useRef(paper);
  const onCloseRef = useRef(onClose);
  const onToastRef = useRef(onToast);
  const onRegisterFlushRef = useRef(onRegisterFlush);
  const closeInFlightRef = useRef(false);
  const pendingDismissTimerRef = useRef(0);
  const menuPointerDownAtRef = useRef(0);
  const pendingRef = useRef<PendingSelection | null>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [repositoryState, setRepositoryState] = useState<RepositoryState>({ annotations: [], revision: 0, status: "ready" });
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1);
  const [sidebarTab, setSidebarTab] = useState<"pages" | "outline">("pages");
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({ total: 0, index: -1, snippets: [] });
  const [spread, setSpread] = useState(false);
  const [areaMode, setAreaMode] = useState(false);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [pendingKind, setPendingKind] = useState<Exclude<AnnotationKind, "area">>("highlight");
  const paperId = paper.id;
  const paperPath = paper.pdfPath;

  const annotations = repositoryState.annotations;
  const saveStatus = repositoryState.error
    ? "保存エラー・復元済み"
    : repositoryState.status === "saving"
      ? "保存中…"
      : repositoryState.status === "dirty"
        ? "入力中…"
        : "保存済み・Markdown同期済み";

  function updatePendingSelection(next: PendingSelection | null) {
    pendingRef.current = next;
    setPending(next);
  }

  useEffect(() => {
    paperRef.current = paper;
  }, [paper]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    onToastRef.current = onToast;
  }, [onToast]);

  useEffect(() => {
    onRegisterFlushRef.current = onRegisterFlush;
  }, [onRegisterFlush]);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const closeReader = useCallback(async () => {
    if (closeInFlightRef.current) return;
    closeInFlightRef.current = true;
    window.clearTimeout(pendingDismissTimerRef.current);
    try {
      await repositoryRef.current?.flush();
      onCloseRef.current();
    } catch (closeError) {
      closeInFlightRef.current = false;
      onToastRef.current(`注釈の保存が完了していないため、Libraryに戻れませんでした: ${String(closeError)}`);
    }
  }, []);

  useEffect(() => {
    const handleCopyRequest = (event: Event) => {
      if (!pendingRef.current) return;
      event.preventDefault();
      void copyPendingSelection();
    };
    window.addEventListener("rill://copy-request", handleCopyRequest);
    return () => window.removeEventListener("rill://copy-request", handleCopyRequest);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditing = target instanceof HTMLElement
        && (target.isContentEditable || target.matches("input, textarea, select"));
      if (!isEditing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && pendingRef.current) {
        event.preventDefault();
        void copyPendingSelection();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        window.document.getElementById("pdf-search")?.focus();
      }
      if (event.key !== "Escape") return;
      if (pending) {
        event.preventDefault();
        window.clearTimeout(pendingDismissTimerRef.current);
        updatePendingSelection(null);
        engineRef.current?.clearSelection();
      } else if (areaMode) {
        event.preventDefault();
        setAreaMode(false);
        engineRef.current?.setTool("pointer");
      } else {
        event.preventDefault();
        void closeReader();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [areaMode, closeReader, pending]);

  useEffect(() => {
    if (!pending) return;
    const dismissOutsideMenu = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".selection-menu")) return;
      window.clearTimeout(pendingDismissTimerRef.current);
      updatePendingSelection(null);
      engineRef.current?.clearSelection();
    };
    window.document.addEventListener("pointerdown", dismissOutsideMenu, true);
    return () => window.document.removeEventListener("pointerdown", dismissOutsideMenu, true);
  }, [pending]);

  useEffect(() => {
    if (!iframeReady || !iframeRef.current) return;
    let disposed = false;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    let unsubscribeRepository: (() => void) | null = null;
    let unsubscribeEngine: (() => void) | null = null;

    const handleEngineEvent = async (event: ReaderEvent) => {
      if (disposed) return;
      if (event.type === "selection-finalized") {
        window.clearTimeout(pendingDismissTimerRef.current);
        setPendingKind("highlight");
        updatePendingSelection({ annotation: event.annotation, anchor: event.anchor });
      } else if (event.type === "selection-cleared") {
        window.clearTimeout(pendingDismissTimerRef.current);
        if (window.performance.now() - menuPointerDownAtRef.current < 500) return;
        pendingDismissTimerRef.current = window.setTimeout(() => {
          updatePendingSelection(null);
        }, 350);
      } else if (event.type === "backdrop-tapped") {
        window.clearTimeout(pendingDismissTimerRef.current);
        updatePendingSelection(null);
        engineRef.current?.clearSelection();
      } else if (event.type === "annotation-draft") {
        const document = pdfDocumentRef.current;
        const imageDataUrl = document ? await captureAreaImage(document, event.annotation) : undefined;
        if (disposed) return;
        const annotation = { ...event.annotation, kind: "area" as const, color: "yellow" as const, imageDataUrl };
        repositoryRef.current?.update((current) => [...current, annotation], { message: "選択範囲を撮影してメモへ追加しました" });
        setActiveAnnotationId(annotation.id);
        setAreaMode(false);
        engineRef.current?.setTool("pointer");
      } else if (event.type === "annotation-activated") {
        setActiveAnnotationId(event.annotationId);
      } else if (event.type === "view-state-changed") {
        if (typeof event.pageIndex === "number") setPageNumber(event.pageIndex + 1);
        if (typeof event.scale === "number") setScale(event.scale);
      } else if (event.type === "view-stats-changed") {
        setPageCount(event.pagesCount);
        setPageNumber(event.pageIndex + 1);
      } else if (event.type === "search-changed") {
        setSearchState(event.state ?? { total: 0, index: -1, snippets: [] });
      } else if (event.type === "shortcut") {
        if (event.command === "copy-selection") void copyPendingSelection();
        else window.document.getElementById("pdf-search")?.focus();
      } else if (event.type === "link-opened" && event.url) {
        try {
          const target = new URL(event.url);
          if (!["http:", "https:", "mailto:"].includes(target.protocol)) {
            onToastRef.current("安全のため、この種類のリンクは開けません");
            return;
          }
          window.open(target.href, "_blank", "noopener,noreferrer");
        } catch {
          onToastRef.current("PDF内のリンクを確認できませんでした");
        }
      }
    };

    async function initialize() {
      try {
        setLoading(true);
        setError("");
        const [raw, stored] = await Promise.all([
          invoke<ArrayBuffer>("read_pdf_bytes", { root, pdfPath: paperPath }),
          invoke<PdfAnnotation[]>("load_pdf_annotations", { root, paperId }),
        ]);
        if (disposed) return;
        const sourceBytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw as unknown as ArrayLike<number>);
        const engineBuffer = sourceBytes.slice().buffer as ArrayBuffer;
        loadingTask = getDocument({
          data: sourceBytes,
          enableScripting: false,
          isEvalSupported: false,
        });
        const document = await loadingTask.promise;
        if (disposed) return;
        if (document.numPages > MAX_READER_PAGES) {
          throw new Error(`このPDFは${document.numPages}ページあります。Rillで開ける上限は${MAX_READER_PAGES}ページです。`);
        }
        pdfDocumentRef.current = document;
        setPdfDocument(document);
        setPageCount(document.numPages);
        const boxes: PageBox[] = [];
        for (let number = 1; number <= document.numPages; number += 1) {
          const page = await document.getPage(number);
          const [x0, y0, x1, y1] = page.view;
          boxes.push({ x0, y0, x1, y1 });
        }
        const rawOutline = await document.getOutline();
        if (!disposed) setOutline((rawOutline ?? []) as unknown as OutlineItem[]);

        const repository = new AnnotationRepository(
          async (snapshot) => invoke("save_pdf_annotations", { root, paper: paperRef.current, annotations: snapshot }),
          (message) => onToastRef.current(message),
        );
        repositoryRef.current = repository;
        onRegisterFlushRef.current?.(() => repository.flush());
        unsubscribeRepository = repository.subscribe((state) => {
          setRepositoryState(state);
          engineRef.current?.setAnnotations(state.annotations, state.revision);
        });
        repository.initialize(stored.map((annotation) => ({ ...annotation, kind: annotation.kind || "highlight" })));

        if (!iframeRef.current) throw new Error("PDF表示領域を初期化できませんでした");
        const engine = new IframeRillPdfEngine(iframeRef.current, boxes);
        engineRef.current = engine;
        unsubscribeEngine = engine.subscribe((event) => { void handleEngineEvent(event); });
        await engine.open(engineBuffer, repository.snapshot);
        if (!disposed) setLoading(false);
      } catch (loadError) {
        if (!disposed) {
          setError(String(loadError));
          setLoading(false);
        }
      }
    }

    void initialize();
    return () => {
      disposed = true;
      window.clearTimeout(pendingDismissTimerRef.current);
      unsubscribeRepository?.();
      unsubscribeEngine?.();
      engineRef.current?.destroy();
      engineRef.current = null;
      const repository = repositoryRef.current;
      const finalFlush = repository?.flush() ?? Promise.resolve();
      onRegisterFlushRef.current?.(() => finalFlush);
      repositoryRef.current = null;
      pdfDocumentRef.current = null;
      void loadingTask?.destroy();
    };
  }, [iframeReady, paperId, paperPath, root]);

  function addTextAnnotation(color: AnnotationColor) {
    if (!pending) return;
    const annotation = { ...pending.annotation, kind: pendingKind, color };
    window.clearTimeout(pendingDismissTimerRef.current);
    updatePendingSelection(null);
    engineRef.current?.clearSelection();
    setActiveAnnotationId(annotation.id);
    repositoryRef.current?.update((current) => [...current, annotation], { message: `${kindLabels[pendingKind]}をメモへ追加しました` });
  }

  async function copyPendingSelection() {
    const selection = pendingRef.current;
    if (!selection) return;
    let copied = false;
    try {
      copied = await copyPlainText(selection.annotation.text);
    } catch {
      copied = false;
    }
    if (!copied) {
      onToastRef.current("選択した文章をコピーできませんでした");
      return;
    }
    window.clearTimeout(pendingDismissTimerRef.current);
    updatePendingSelection(null);
    engineRef.current?.clearSelection();
    onToastRef.current("選択した文章をコピーしました");
  }

  function updateAnnotation(id: string, patch: Partial<PdfAnnotation>, persist = false) {
    repositoryRef.current?.update(
      (current) => current.map((annotation) => annotation.id === id ? { ...annotation, ...patch } : annotation),
      { persist },
    );
  }

  function removeAnnotation(id: string) {
    repositoryRef.current?.update((current) => current.filter((annotation) => annotation.id !== id), { message: "注釈を削除しました" });
    if (activeAnnotationId === id) setActiveAnnotationId(null);
  }

  function focusAnnotation(annotation: PdfAnnotation) {
    setActiveAnnotationId(annotation.id);
    engineRef.current?.navigate({ annotationID: annotation.id });
  }

  function goToPage(page: number) {
    const target = Math.max(1, Math.min(pageCount || 1, page));
    engineRef.current?.navigate({ pageIndex: target - 1 });
  }

  async function goToOutline(item: OutlineItem) {
    if (!pdfDocument || !item.dest) return;
    const destination = typeof item.dest === "string" ? await pdfDocument.getDestination(item.dest) : item.dest as unknown[];
    if (!destination) return;
    const ref = destination[0] as Parameters<PDFDocumentProxy["getPageIndex"]>[0];
    const index = typeof ref === "object" ? await pdfDocument.getPageIndex(ref) : Number(ref);
    goToPage(index + 1);
  }

  function changeSearch(query: string) {
    setSearchQuery(query);
    if (!query) setSearchState({ total: 0, index: -1, snippets: [] });
    void engineRef.current?.search(query).then(setSearchState);
  }

  function toggleCapture() {
    const next = !areaMode;
    setAreaMode(next);
    updatePendingSelection(null);
    engineRef.current?.clearSelection();
    engineRef.current?.setTool(next ? "area-capture" : "pointer");
    if (next) onToast("PDF上をドラッグして、撮影する範囲を囲んでください");
  }

  return (
    <section className="reader-view rill-engine-reader">
      <header className="reader-toolbar">
        <button type="button" className="reader-back" onClick={() => { void closeReader(); }} title="Libraryへ戻る（Esc）"><span>←</span><strong>Back</strong><small>Library</small></button>
        <div className="reader-title"><strong>{paper.title}</strong><small>{paper.authors[0] ?? "著者未登録"} · {paper.year ?? "年不明"}</small></div>
        <label className="reader-search">
          <span>⌕</span>
          <input id="pdf-search" value={searchQuery} onChange={(event) => changeSearch(event.target.value)} placeholder="PDF内を検索" />
          {searchQuery && <small>{searchState.total ? `${searchState.index + 1}/${searchState.total}` : "0"}</small>}
          <button type="button" onClick={() => engineRef.current?.findPrevious()}>↑</button>
          <button type="button" onClick={() => engineRef.current?.findNext()}>↓</button>
        </label>
        <div className="reader-page-control"><button type="button" onClick={() => goToPage(pageNumber - 1)}>‹</button><span>{pageNumber} / {pageCount || "—"}</span><button type="button" onClick={() => goToPage(pageNumber + 1)}>›</button></div>
        <div className="reader-zoom"><button type="button" onClick={() => engineRef.current?.setZoom("out")}>−</button><span>{Math.round(scale * 100)}%</span><button type="button" onClick={() => engineRef.current?.setZoom("in")}>＋</button></div>
        <button type="button" className={spread ? "reader-tool active" : "reader-tool"} onClick={() => { const next = !spread; setSpread(next); engineRef.current?.setSpread(next); }}>見開き</button>
        <button type="button" className={`${areaMode ? "reader-tool active" : "reader-tool"} capture-tool`} aria-pressed={areaMode} title="PDFの一部を画像としてメモに追加" onClick={toggleCapture}><svg aria-hidden="true" viewBox="0 0 18 18"><path d="M5 2v3H2M13 2v3h3M5 16v-3H2M13 16v-3h3M5 5h8v8H5z" /></svg><span>{areaMode ? "撮影をキャンセル" : "範囲を撮影"}</span></button>
        <button type="button" className="reader-external" onClick={onOpenExternal}>プレビュー ↗</button>
      </header>
      <div className="reader-workspace">
        <aside className="reader-navigation">
          <div className="reader-nav-tabs"><button className={sidebarTab === "pages" ? "active" : ""} onClick={() => setSidebarTab("pages")}>ページ</button><button className={sidebarTab === "outline" ? "active" : ""} onClick={() => setSidebarTab("outline")}>目次</button></div>
          <div className="reader-nav-list">
            {sidebarTab === "pages" && pdfDocument && Array.from({ length: pageCount }, (_, index) => <PdfThumbnail key={index + 1} document={pdfDocument} page={index + 1} active={pageNumber === index + 1} onClick={() => goToPage(index + 1)} />)}
            {sidebarTab === "outline" && (flattenOutline(outline).length ? flattenOutline(outline).map((item, index) => <button type="button" key={`${item.title}-${index}`} className="outline-item" style={{ paddingLeft: `${10 + item.depth * 13}px` }} onClick={() => void goToOutline(item)}>{item.title}</button>) : <p className="outline-empty">このPDFには目次がありません</p>)}
          </div>
        </aside>
        <div className="rill-reader-frame-wrap">
          <iframe ref={iframeRef} title="Rill PDF selection engine" src="/rill-pdf-engine/view.html" onLoad={() => setIframeReady(true)} />
          {areaMode && <div className="area-capture-guide" role="status"><strong>ドラッグして撮影範囲を囲む</strong><small>Escでキャンセル</small></div>}
          {loading && !error && <div className="pdf-loading"><span>PDF</span><p>論文を開いています…</p></div>}
          {error && <div className="pdf-loading error"><span>!</span><p>{error}</p><button type="button" onClick={onOpenExternal}>プレビューで開く</button></div>}
        </div>
        <aside className="reader-notes">
          <div className="reader-notes-heading"><div><span>Reading notes</span><small>{annotations.length} annotations</small></div><em>{saveStatus}</em></div>
          <div className="reader-note-intro">本文は選択して注釈にできます。図表は「範囲を撮影」で囲むと画像メモになります。注釈はRillのMarkdownへ同期されます。</div>
          <div className="annotation-list">
            {annotations.map((annotation) => (
              <article key={annotation.id} className={`${activeAnnotationId === annotation.id ? "active " : ""}annotation-card ${annotation.color}`} onClick={() => focusAnnotation(annotation)}>
                <div className="annotation-meta">
                  <span>{annotationPageLabel(annotation)} · {kindLabels[annotation.kind || "highlight"]}</span>
                  <div className="annotation-color-picker">{annotationColors.map(({ color, label }) => <button key={color} title={`${label}へ変更`} className={`${color}${annotation.color === color ? " active" : ""}`} onClick={(event) => { event.stopPropagation(); updateAnnotation(annotation.id, { color }, true); }} />)}</div>
                  <button type="button" onClick={(event) => { event.stopPropagation(); removeAnnotation(annotation.id); }}>削除</button>
                </div>
                {annotation.imageDataUrl ? <img className="annotation-image" src={annotation.imageDataUrl} alt="PDFから撮影した範囲" /> : <blockquote>{annotation.text}</blockquote>}
                <textarea value={annotation.comment} rows={3} placeholder="この引用について考えたこと…" onClick={(event) => event.stopPropagation()} onChange={(event) => updateAnnotation(annotation.id, { comment: event.target.value })} onBlur={() => repositoryRef.current?.commit()} />
              </article>
            ))}
            {!annotations.length && <div className="annotation-empty"><span>✦</span><strong>まだ注釈はありません</strong><small>PDF本文を選択してください</small></div>}
          </div>
        </aside>
      </div>
      {pending && (
        <div className="selection-menu expanded" role="dialog" aria-label="選択した文章の操作" onPointerDown={() => { menuPointerDownAtRef.current = window.performance.now(); window.clearTimeout(pendingDismissTimerRef.current); }} style={{ left: Math.max(8, Math.min(pending.anchor.x - 145, window.innerWidth - 310)), top: Math.max(76, Math.min(pending.anchor.y + 10, window.innerHeight - 112)) }}>
          <div className="annotation-kind-options">
            <button type="button" className="copy-selection" title="選択した文章をコピー" onClick={() => void copyPendingSelection()}><span>⧉</span>コピー</button>
            <i aria-hidden="true" />
            {(["highlight", "underline", "strikeout"] as const).map((kind) => <button key={kind} type="button" className={pendingKind === kind ? "active" : ""} onClick={() => setPendingKind(kind)}>{kindLabels[kind]}</button>)}
          </div>
          <div className="annotation-color-options">{annotationColors.map(({ color, label }) => <button key={color} type="button" className={color} title={`${label}で追加`} onClick={() => addTextAnnotation(color)}><span /></button>)}</div>
        </div>
      )}
    </section>
  );
}
