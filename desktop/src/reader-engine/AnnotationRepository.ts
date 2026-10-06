import type { PdfAnnotation } from "./types";

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
  private listeners = new Set<(state: RepositoryState) => void>();
  private saveQueue: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(
    private readonly saveSnapshot: (annotations: PdfAnnotation[]) => Promise<void>,
    private readonly onMessage: (message: string) => void,
  ) {}

  initialize(annotations: PdfAnnotation[]) {
    const snapshot = cloneAnnotations(annotations);
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
    return this.enqueueSave(snapshot, message);
  }

  async flush() {
    // A failed automatic save must not discard edits or let the reader close.
    // Retry the latest in-memory snapshot once, then propagate a persistent error.
    let retriedError = false;
    while (true) {
      await this.waitForSaves();
      if (this.state.status === "error") {
        if (retriedError) throw new Error(this.state.error || "注釈を保存できませんでした");
        retriedError = true;
      } else if (this.state.status !== "dirty") {
        return;
      }
      await this.commit();
    }
  }

  private async waitForSaves() {
    let pending: Promise<void>;
    do {
      pending = this.saveQueue;
      await pending;
    } while (pending !== this.saveQueue);
  }

  private enqueueSave(snapshot: PdfAnnotation[], message?: string) {
    const operationGeneration = this.generation;
    const operationRevision = this.state.revision;
    this.saveQueue = this.saveQueue.then(async () => {
      if (operationGeneration !== this.generation) return;
      try {
        await this.saveSnapshot(cloneAnnotations(snapshot));
        if (operationGeneration !== this.generation) return;
        if (operationRevision === this.state.revision) {
          this.state = { ...this.state, status: "saved", error: undefined };
          this.emit();
        }
        if (message) this.onMessage(message);
      } catch (error) {
        if (operationGeneration !== this.generation) return;
        this.generation += 1;
        this.state = {
          ...this.state,
          status: "error",
          error: String(error),
        };
        this.emit();
        this.onMessage(`注釈を保存できませんでした。編集内容は画面に残しています。「保存を再試行」で再保存してください: ${String(error)}`);
      }
    });
    return this.saveQueue;
  }

  private emit() {
    const state = { ...this.state, annotations: cloneAnnotations(this.state.annotations) };
    for (const listener of this.listeners) listener(state);
  }
}
