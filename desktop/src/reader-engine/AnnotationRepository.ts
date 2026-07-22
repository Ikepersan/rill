import type { PdfAnnotation } from "../PdfReader";

export type RepositoryStatus = "ready" | "dirty" | "saving" | "saved" | "error";
export type RepositoryState = {
  annotations: PdfAnnotation[];
  revision: number;
  status: RepositoryStatus;
  error?: string;
};

function cloneAnnotations(annotations: PdfAnnotation[]) {
  return annotations.map((annotation) => ({
    ...annotation,
    rects: annotation.rects.map((rect) => ({ ...rect })),
  }));
}

export class AnnotationRepository {
  private state: RepositoryState = { annotations: [], revision: 0, status: "ready" };
  private persisted: PdfAnnotation[] = [];
  private listeners = new Set<(state: RepositoryState) => void>();
  private saveQueue: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(
    private readonly saveSnapshot: (annotations: PdfAnnotation[]) => Promise<void>,
    private readonly onMessage: (message: string) => void,
  ) {}

  initialize(annotations: PdfAnnotation[]) {
    const snapshot = cloneAnnotations(annotations);
    this.persisted = snapshot;
    this.state = { annotations: snapshot, revision: 0, status: "saved" };
    this.emit();
  }

  get snapshot() {
    return cloneAnnotations(this.state.annotations);
  }

  get revision() {
    return this.state.revision;
  }

  subscribe(listener: (state: RepositoryState) => void) {
    this.listeners.add(listener);
    listener({ ...this.state, annotations: cloneAnnotations(this.state.annotations) });
    return () => this.listeners.delete(listener);
  }

  update(
    transform: (annotations: PdfAnnotation[]) => PdfAnnotation[],
    options: { persist?: boolean; message?: string } = {},
  ) {
    const next = cloneAnnotations(transform(this.snapshot));
    this.state = {
      annotations: next,
      revision: this.state.revision + 1,
      status: options.persist === false ? "dirty" : "saving",
    };
    this.emit();
    if (options.persist !== false) this.enqueueSave(next, options.message);
  }

  commit(message?: string) {
    const snapshot = this.snapshot;
    this.state = { ...this.state, status: "saving", error: undefined };
    this.emit();
    this.enqueueSave(snapshot, message);
  }

  private enqueueSave(snapshot: PdfAnnotation[], message?: string) {
    const operationGeneration = this.generation;
    this.saveQueue = this.saveQueue.then(async () => {
      if (operationGeneration !== this.generation) return;
      try {
        await this.saveSnapshot(cloneAnnotations(snapshot));
        if (operationGeneration !== this.generation) return;
        this.persisted = cloneAnnotations(snapshot);
        this.state = { ...this.state, status: "saved", error: undefined };
        this.emit();
        if (message) this.onMessage(message);
      } catch (error) {
        if (operationGeneration !== this.generation) return;
        this.generation += 1;
        this.state = {
          annotations: cloneAnnotations(this.persisted),
          revision: this.state.revision + 1,
          status: "error",
          error: String(error),
        };
        this.emit();
        this.onMessage(`保存できなかったため直前の状態へ戻しました: ${String(error)}`);
      }
    });
  }

  private emit() {
    const state = { ...this.state, annotations: cloneAnnotations(this.state.annotations) };
    for (const listener of this.listeners) listener(state);
  }
}
