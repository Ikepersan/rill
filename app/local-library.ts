export type StoredPdf = {
  paperId: number;
  name: string;
  type: string;
  blob: Blob;
};

const DB_NAME = "rill-local-library";
const DB_VERSION = 1;
const PAPERS_STORE = "papers";
const PDFS_STORE = "pdfs";

function openLibraryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PAPERS_STORE)) {
        db.createObjectStore(PAPERS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PDFS_STORE)) {
        db.createObjectStore(PDFS_STORE, { keyPath: "paperId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadPapers<T>(): Promise<T[]> {
  const db = await openLibraryDb();
  try {
    const transaction = db.transaction(PAPERS_STORE, "readonly");
    return await requestResult(transaction.objectStore(PAPERS_STORE).getAll()) as T[];
  } finally {
    db.close();
  }
}

export async function savePaper<T>(paper: T): Promise<void> {
  const db = await openLibraryDb();
  try {
    const transaction = db.transaction(PAPERS_STORE, "readwrite");
    await requestResult(transaction.objectStore(PAPERS_STORE).put(paper));
  } finally {
    db.close();
  }
}

export async function savePapers<T>(papers: T[]): Promise<void> {
  const db = await openLibraryDb();
  try {
    const transaction = db.transaction(PAPERS_STORE, "readwrite");
    const store = transaction.objectStore(PAPERS_STORE);
    for (const paper of papers) store.put(paper);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function deletePaperRecord(paperId: number): Promise<void> {
  const db = await openLibraryDb();
  try {
    const transaction = db.transaction([PAPERS_STORE, PDFS_STORE], "readwrite");
    transaction.objectStore(PAPERS_STORE).delete(paperId);
    transaction.objectStore(PDFS_STORE).delete(paperId);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function savePdf(pdf: StoredPdf): Promise<void> {
  const db = await openLibraryDb();
  try {
    const transaction = db.transaction(PDFS_STORE, "readwrite");
    await requestResult(transaction.objectStore(PDFS_STORE).put(pdf));
  } finally {
    db.close();
  }
}

export async function loadPdf(paperId: number): Promise<StoredPdf | undefined> {
  const db = await openLibraryDb();
  try {
    const transaction = db.transaction(PDFS_STORE, "readonly");
    return await requestResult(transaction.objectStore(PDFS_STORE).get(paperId)) as StoredPdf | undefined;
  } finally {
    db.close();
  }
}
