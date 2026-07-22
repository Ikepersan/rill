import type { StoredPdf } from "./local-library";

type GoogleTokenClient = {
  requestAccessToken(options?: { prompt?: string }): void;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; error?: string }) => void;
            error_callback?: () => void;
          }): GoogleTokenClient;
        };
      };
    };
  }
}

export type DriveFolders = {
  rootId: string;
  papersId: string;
  notesId: string;
};

type SyncPaper = {
  id: number;
  title: string;
  shortTitle: string;
  year: number;
  pdfName?: string;
  driveFileId?: string;
  noteDriveFileId?: string;
};

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-rill-google-identity="true"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Google認証の読み込みに失敗しました")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.rillGoogleIdentity = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google認証の読み込みに失敗しました"));
    document.head.appendChild(script);
  });
}

function requestToken(clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const oauth = window.google?.accounts.oauth2;
    if (!oauth) {
      reject(new Error("Google認証を利用できません"));
      return;
    }
    const client = oauth.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.access_token) resolve(response.access_token);
        else reject(new Error("Google Driveへのアクセスが許可されませんでした"));
      },
      error_callback: () => reject(new Error("Google認証がキャンセルされました")),
    });
    client.requestAccessToken({ prompt: "consent" });
  });
}

async function driveRequest<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(response.status === 401 ? "Google Driveの接続期限が切れました。再接続してください" : `Google Driveエラー（${response.status}）${body ? "" : ""}`);
  }
  return await response.json() as T;
}

function escapeQuery(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  const parentClause = parentId ? ` and '${escapeQuery(parentId)}' in parents` : "";
  const query = `name = '${escapeQuery(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parentClause}`;
  const params = new URLSearchParams({ q: query, fields: "files(id,name)", pageSize: "10" });
  const result = await driveRequest<{ files: Array<{ id: string }> }>(token, `https://www.googleapis.com/drive/v3/files?${params}`);
  return result.files[0]?.id ?? null;
}

async function createFolder(token: string, name: string, parentId?: string): Promise<string> {
  const result = await driveRequest<{ id: string }>(token, "https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  return result.id;
}

async function getOrCreateFolder(token: string, name: string, parentId?: string): Promise<string> {
  return await findFolder(token, name, parentId) ?? await createFolder(token, name, parentId);
}

export async function connectGoogleDrive(clientId: string): Promise<{ token: string; folders: DriveFolders }> {
  await loadGoogleIdentity();
  const token = await requestToken(clientId);
  const rootId = await getOrCreateFolder(token, "Rill");
  const papersId = await getOrCreateFolder(token, "Papers", rootId);
  const notesId = await getOrCreateFolder(token, "Notes", rootId);
  return { token, folders: { rootId, papersId, notesId } };
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "paper";
}

async function uploadMultipart({
  token,
  fileId,
  name,
  parentId,
  mimeType,
  content,
}: {
  token: string;
  fileId?: string;
  name: string;
  parentId: string;
  mimeType: string;
  content: Blob;
}): Promise<string> {
  const boundary = `rill_${crypto.randomUUID().replace(/-/g, "")}`;
  const metadata = {
    name,
    mimeType,
    ...(!fileId ? { parents: [parentId] } : {}),
  };
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    content,
    `\r\n--${boundary}--`,
  ]);
  const endpoint = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id";
  const result = await driveRequest<{ id: string }>(token, endpoint, {
    method: fileId ? "PATCH" : "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return result.id;
}

export async function syncPaperToDrive({
  token,
  folders,
  paper,
  markdown,
  pdf,
}: {
  token: string;
  folders: DriveFolders;
  paper: SyncPaper;
  markdown: string;
  pdf?: StoredPdf;
}): Promise<{ pdfFileId?: string; noteFileId: string }> {
  let pdfFileId = paper.driveFileId;
  if (pdf) {
    pdfFileId = await uploadMultipart({
      token,
      fileId: paper.driveFileId,
      name: pdf.name,
      parentId: folders.papersId,
      mimeType: pdf.type || "application/pdf",
      content: pdf.blob,
    });
  }
  const noteName = `${paper.year}-${safeFileName(paper.shortTitle)}.md`;
  const noteFileId = await uploadMultipart({
    token,
    fileId: paper.noteDriveFileId,
    name: noteName,
    parentId: folders.notesId,
    mimeType: "text/markdown",
    content: new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
  });
  return { pdfFileId, noteFileId };
}
