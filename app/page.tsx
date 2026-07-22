"use client";

import { ChangeEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useState } from "react";
import { deletePaperRecord, loadPapers, loadPdf, savePaper, savePapers, savePdf } from "./local-library";
import { connectGoogleDrive, syncPaperToDrive, type DriveFolders } from "./google-drive";

type Paper = {
  id: number;
  title: string;
  shortTitle: string;
  authors: string;
  journal: string;
  year: number;
  type: string;
  tags: string[];
  status: "未読" | "読書中" | "読了";
  progress: number;
  added: string;
  abstract: string;
  keyResult: string;
  doi: string;
  drivePath: string;
  note: string;
  pdfName?: string;
  driveFileId?: string;
  noteDriveFileId?: string;
};

const seedPapers: Paper[] = [
  {
    id: 1,
    title:
      "Dapagliflozin in Patients with Chronic Kidney Disease",
    shortTitle: "Dapagliflozin in Chronic Kidney Disease",
    authors: "Heerspink HJL, Stefánsson BV, Correa-Rotter R, et al.",
    journal: "New England Journal of Medicine",
    year: 2020,
    type: "Randomized Controlled Trial",
    tags: ["腎臓", "SGLT2阻害薬", "RCT"],
    status: "読書中",
    progress: 68,
    added: "今日",
    abstract:
      "CKD患者4,304例を対象に、標準治療へダパグリフロジン10 mgを追加した際の腎・心血管イベントへの効果を検証した多施設二重盲検試験。糖尿病の有無にかかわらず主要複合エンドポイントを有意に減少させた。",
    keyResult:
      "主要評価項目はダパグリフロジン群で9.2%、プラセボ群で14.5%。HR 0.61（95% CI 0.51–0.72）、NNT 19。",
    doi: "10.1056/NEJMoa2024816",
    drivePath: "Google Drive / Papers / Nephrology / DAPA-CKD.pdf",
    note:
      "eGFR 25以上が対象。非糖尿病CKDにも効果が一貫している点が重要。外来導入時は脱水と初期dipを説明する。",
  },
  {
    id: 2,
    title: "Empagliflozin in Patients with Chronic Kidney Disease",
    shortTitle: "EMPA-KIDNEY Collaborative Group",
    authors: "Herrington WG, Staplin N, Wanner C, et al.",
    journal: "New England Journal of Medicine",
    year: 2023,
    type: "Randomized Controlled Trial",
    tags: ["腎臓", "SGLT2阻害薬", "CKD"],
    status: "未読",
    progress: 0,
    added: "昨日",
    abstract:
      "幅広いCKD患者を対象にエンパグリフロジンの腎疾患進行および心血管死への効果を検討した無作為化試験。",
    keyResult: "腎疾患進行または心血管死のリスクをプラセボと比較して低減した。",
    doi: "10.1056/NEJMoa2204233",
    drivePath: "Google Drive / Papers / Nephrology / EMPA-KIDNEY.pdf",
    note: "DAPA-CKDとの対象患者の違いを比較する。",
  },
  {
    id: 3,
    title: "Finerenone and Cardiovascular Outcomes in Patients With CKD and Type 2 Diabetes",
    shortTitle: "Finerenone and CV Outcomes",
    authors: "Pitt B, Filippatos G, Agarwal R, et al.",
    journal: "Circulation",
    year: 2021,
    type: "Prespecified Analysis",
    tags: ["糖尿病", "腎臓", "MRA"],
    status: "読了",
    progress: 100,
    added: "7月14日",
    abstract:
      "2型糖尿病を伴うCKD患者における非ステロイド型MRAフィネレノンの心血管アウトカムを評価した。",
    keyResult: "心血管複合アウトカムを有意に減少。高カリウム血症の監視が必要。",
    doi: "10.1161/CIRCULATIONAHA.120.051898",
    drivePath: "Google Drive / Papers / Diabetes / FIGARO-DKD.pdf",
    note: "SGLT2阻害薬との併用エビデンスを追加で確認。",
  },
  {
    id: 4,
    title: "KDIGO 2024 Clinical Practice Guideline for the Evaluation and Management of CKD",
    shortTitle: "KDIGO 2024 CKD Guideline",
    authors: "Kidney Disease: Improving Global Outcomes",
    journal: "Kidney International",
    year: 2024,
    type: "Clinical Practice Guideline",
    tags: ["ガイドライン", "腎臓", "CKD"],
    status: "読書中",
    progress: 34,
    added: "7月12日",
    abstract:
      "CKDの評価、リスク層別化、進行抑制、合併症管理についての国際診療ガイドライン。",
    keyResult: "GFRとアルブミン尿によるリスク評価に加え、腎不全リスク予測式の利用を推奨。",
    doi: "10.1016/j.kint.2023.10.018",
    drivePath: "Google Drive / Papers / Guidelines / KDIGO-2024.pdf",
    note: "リスク分類表と薬物療法の推奨を自分用に要約する。",
  },
];

const allTags = ["腎臓", "SGLT2阻害薬", "RCT", "CKD", "糖尿病", "ガイドライン"];

function markdownFor(paper: Paper, note: string) {
  return `---\ntitle: "${paper.title}"\nauthors: "${paper.authors}"\njournal: "${paper.journal}"\nyear: ${paper.year}\ndoi: "${paper.doi}"\ntags: [${paper.tags.map((tag) => `"${tag}"`).join(", ")}]\nstatus: "${paper.status}"\n---\n\n# ${paper.shortTitle}\n\n## 要約\n${paper.abstract}\n\n## 主要結果\n${paper.keyResult}\n\n## Clinical note\n${note}\n\n## PDF\n${paper.drivePath}\n`;
}

export default function Home() {
  const [papers, setPapers] = useState<Paper[]>(seedPapers);
  const [view, setView] = useState<"dashboard" | "library">("dashboard");
  const [selectedId, setSelectedId] = useState(1);
  const [detailOpen, setDetailOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState("すべて");
  const [statusFilter, setStatusFilter] = useState("すべて");
  const [note, setNote] = useState(seedPapers[0].note);
  const [newTag, setNewTag] = useState("");
  const [localPdf, setLocalPdf] = useState<{ name: string; url: string } | null>(null);
  const [toast, setToast] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [driveState, setDriveState] = useState<"未接続" | "接続中" | "接続済み">("未接続");
  const [driveToken, setDriveToken] = useState("");
  const [driveFolders, setDriveFolders] = useState<DriveFolders | null>(null);
  const [googleClientId, setGoogleClientId] = useState("");

  const selected = papers.find((paper) => paper.id === selectedId) ?? papers[0] ?? seedPapers[0];
  const markdown = markdownFor(selected, note);
  const availableTags = useMemo(() => Array.from(new Set(papers.flatMap((paper) => paper.tags))), [papers]);
  const unreadCount = papers.filter((paper) => paper.status === "未読").length;
  const readingCount = papers.filter((paper) => paper.status === "読書中").length;
  const readCount = papers.filter((paper) => paper.status === "読了").length;

  useEffect(() => {
    let active = true;
    void (async () => {
      const stored = await loadPapers<Paper>();
      if (!active) return;
      if (stored.length) {
        setPapers(stored.sort((a, b) => b.id - a.id));
        setSelectedId(stored[0].id);
        setNote(stored[0].note);
      } else {
        await savePapers(seedPapers);
      }
      setGoogleClientId(localStorage.getItem("rill-google-client-id") ?? "");
      setStorageReady(true);
    })().catch(() => {
      if (active) setStorageReady(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!detailOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDetailOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [detailOpen]);

  const filteredPapers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return papers.filter((paper) => {
      const matchQuery =
        !needle ||
        `${paper.title} ${paper.authors} ${paper.doi} ${paper.tags.join(" ")}`
          .toLowerCase()
          .includes(needle);
      const matchTag = activeTag === "すべて" || paper.tags.includes(activeTag);
      const matchStatus = statusFilter === "すべて" || paper.status === statusFilter;
      return matchQuery && matchTag && matchStatus;
    });
  }, [activeTag, papers, query, statusFilter]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  async function selectPaper(paper: Paper) {
    setSelectedId(paper.id);
    setNote(paper.note);
    if (localPdf) URL.revokeObjectURL(localPdf.url);
    setLocalPdf(null);
    const stored = await loadPdf(paper.id);
    if (stored) setLocalPdf({ name: stored.name, url: URL.createObjectURL(stored.blob) });
  }

  function updatePaper(nextPaper: Paper) {
    setPapers((current) => current.map((paper) => paper.id === nextPaper.id ? nextPaper : paper));
    void savePaper(nextPaper);
  }

  function updateSelected(changes: Partial<Paper>) {
    const next = { ...selected, ...changes };
    updatePaper(next);
    if (typeof changes.note === "string") setNote(changes.note);
  }

  async function copyMarkdown() {
    await navigator.clipboard.writeText(markdown);
    showToast("Markdownをクリップボードへコピーしました");
  }

  function downloadMarkdown() {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selected.year}-${selected.shortTitle.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`;
    link.click();
    URL.revokeObjectURL(url);
    showToast("Obsidian用Markdownをダウンロードしました");
  }

  async function choosePdf(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (localPdf) URL.revokeObjectURL(localPdf.url);
    setLocalPdf({ name: file.name, url: URL.createObjectURL(file) });
    await savePdf({ paperId: selected.id, name: file.name, type: file.type || "application/pdf", blob: file });
    updateSelected({ pdfName: file.name, drivePath: `この端末 / Rill / Papers / ${file.name}` });
    showToast(`${file.name} をこの論文に紐づけました`);
  }

  function handleNewTag(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || !newTag.trim()) return;
    const tag = newTag.trim().replace(/^#/, "");
    if (!selected.tags.includes(tag)) updateSelected({ tags: [...selected.tags, tag] });
    showToast(`#${tag} を追加しました`);
    setNewTag("");
  }

  async function addPaper(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    if (!title) return;
    const file = form.get("pdf");
    const tags = String(form.get("tags") ?? "").split(/[,、]/).map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean);
    const id = Date.now();
    const paper: Paper = {
      id,
      title,
      shortTitle: title,
      authors: String(form.get("authors") ?? "").trim() || "著者未登録",
      journal: String(form.get("journal") ?? "").trim() || "掲載誌未登録",
      year: Number(form.get("year")) || new Date().getFullYear(),
      type: "Imported paper",
      tags,
      status: "未読",
      progress: 0,
      added: "たった今",
      abstract: String(form.get("abstract") ?? "").trim() || "要約はまだ登録されていません。",
      keyResult: "主要結果はまだ登録されていません。",
      doi: String(form.get("doi") ?? "").trim(),
      drivePath: file instanceof File && file.size ? `この端末 / Rill / Papers / ${file.name}` : "PDF未登録",
      note: "",
      pdfName: file instanceof File && file.size ? file.name : undefined,
    };
    await savePaper(paper);
    if (file instanceof File && file.size) {
      await savePdf({ paperId: id, name: file.name, type: file.type || "application/pdf", blob: file });
      setLocalPdf({ name: file.name, url: URL.createObjectURL(file) });
    }
    setPapers((current) => [paper, ...current]);
    setSelectedId(id);
    setNote("");
    setAddOpen(false);
    setDetailOpen(true);
    setView("library");
    showToast("論文をこの端末に保存しました");
  }

  async function removeSelectedPaper() {
    if (!window.confirm(`「${selected.shortTitle}」をこの端末から削除しますか？`)) return;
    await deletePaperRecord(selected.id);
    const next = papers.filter((paper) => paper.id !== selected.id);
    setPapers(next);
    setDetailOpen(false);
    if (next[0]) {
      setSelectedId(next[0].id);
      setNote(next[0].note);
    }
    showToast("論文を削除しました");
  }

  async function connectDrive() {
    if (!googleClientId.trim()) {
      setDriveOpen(true);
      showToast("先にGoogle OAuthクライアントIDを入力してください");
      return;
    }
    localStorage.setItem("rill-google-client-id", googleClientId.trim());
    setDriveState("接続中");
    try {
      const result = await connectGoogleDrive(googleClientId.trim());
      setDriveToken(result.token);
      setDriveFolders(result.folders);
      setDriveState("接続済み");
      setDriveOpen(false);
      showToast("Google DriveにRillフォルダを準備しました");
    } catch (error) {
      setDriveState("未接続");
      showToast(error instanceof Error ? error.message : "Google Driveへ接続できませんでした");
    }
  }

  async function syncSelectedPaper() {
    if (!driveToken || !driveFolders) {
      setDriveOpen(true);
      return;
    }
    try {
      const storedPdf = await loadPdf(selected.id);
      const result = await syncPaperToDrive({ token: driveToken, folders: driveFolders, paper: selected, markdown, pdf: storedPdf });
      updateSelected({
        driveFileId: result.pdfFileId ?? selected.driveFileId,
        noteDriveFileId: result.noteFileId,
        drivePath: `Google Drive / Rill / Papers / ${storedPdf?.name ?? selected.pdfName ?? "PDF未登録"}`,
      });
      showToast("PDFとMarkdownをGoogle Driveへ同期しました");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "同期に失敗しました");
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setView("dashboard")}>
          <span className="brand-mark">R</span>
          <span><strong>Rill</strong><small>MEDICAL LIBRARY</small></span>
        </button>

        <nav className="view-tabs" aria-label="メイン画面">
          <button
            className={view === "dashboard" ? "view-tab active" : "view-tab"}
            onClick={() => setView("dashboard")}
            type="button"
          >
            Overview
          </button>
          <button
            className={view === "library" ? "view-tab active" : "view-tab"}
            onClick={() => {
              setView("library");
              setDetailOpen(false);
            }}
            type="button"
          >
            Library <span className="count">{papers.length}</span>
          </button>
        </nav>

        <div className="top-actions">
          <button className="icon-button" type="button" aria-label="通知" onClick={() => showToast("新しい通知はありません")}>
            ◌
          </button>
          <button className="avatar" type="button" aria-label="アカウント">KM</button>
        </div>
      </header>

      {view === "dashboard" ? (
        <Dashboard
          papers={papers}
          storageReady={storageReady}
          driveState={driveState}
          onOpenLibrary={() => {
            setView("library");
            setDetailOpen(false);
          }}
          onOpenPaper={(paper) => {
            selectPaper(paper);
            setView("library");
            setDetailOpen(true);
          }}
          onAdd={() => setAddOpen(true)}
          onDrive={() => driveState === "接続済み" ? showToast("Google Driveは接続済みです") : setDriveOpen(true)}
          onToast={showToast}
        />
      ) : (
        <section className="library-layout">
          <aside className="library-nav">
            <div>
              <p className="nav-kicker">COLLECTIONS</p>
              <button className="side-link active" type="button" onClick={() => setStatusFilter("すべて")}><span>▤</span>すべての論文 <b>{papers.length}</b></button>
              <button className="side-link" type="button" onClick={() => setStatusFilter("未読")}><span>◇</span>未読 <b>{unreadCount}</b></button>
              <button className="side-link" type="button" onClick={() => setStatusFilter("読書中")}><span>◐</span>読書中 <b>{readingCount}</b></button>
              <button className="side-link" type="button" onClick={() => setStatusFilter("読了")}><span>✓</span>読了 <b>{readCount}</b></button>
            </div>

            <div className="side-section">
              <p className="nav-kicker">TOPICS</p>
              {(availableTags.length ? availableTags : allTags).slice(0, 5).map((tag) => (
                <button className="topic-link" type="button" key={tag} onClick={() => setActiveTag(tag)}>
                  <span className={`topic-dot dot-${tag.length % 3}`} />{tag}
                </button>
              ))}
            </div>

            <button className="sync-card" type="button" onClick={() => setDriveOpen(true)}>
              <div className="sync-icon">G</div>
              <div><strong>Google Drive</strong><span>{driveState === "接続済み" ? "Rillフォルダ準備済み" : "クリックして接続"}</span></div>
              <i>{driveState}</i>
            </button>
          </aside>

          <section className="paper-list-pane">
            <div className="list-header">
              <div>
                <p className="eyebrow">LIBRARY</p>
                <h1>論文ライブラリ</h1>
              </div>
              <button className="add-button" type="button" onClick={() => setAddOpen(true)}>
                ＋ 論文を追加
              </button>
            </div>

            <label className="search-field">
              <span>⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="論文タイトル、著者、DOIを検索"
              />
              <kbd>⌘ K</kbd>
            </label>

            <div className="filter-row" aria-label="絞り込み">
              {["すべて", "未読", "読書中", "読了"].map((status) => (
                <button
                  type="button"
                  className={statusFilter === status ? "filter-chip active" : "filter-chip"}
                  onClick={() => setStatusFilter(status)}
                  key={status}
                >
                  {status}
                </button>
              ))}
              <span className="filter-divider" />
              <button className={activeTag !== "すべて" ? "filter-chip active" : "filter-chip"} type="button" onClick={() => setActiveTag("すべて")}>
                {activeTag === "すべて" ? "タグ" : `#${activeTag} ×`}
              </button>
            </div>

            <div className="result-meta"><span>{filteredPapers.length}件を表示</span><span>論文を選ぶと詳細が開きます</span><button type="button">追加日順 ↓</button></div>

            <div className="paper-table-head" aria-hidden="true">
              <span>論文</span><span>掲載誌</span><span>年</span><span>タグ</span><span>状態</span><span>追加日</span><span />
            </div>

            <div className="paper-list" role="list">
              {filteredPapers.map((paper) => (
                <button
                  type="button"
                  key={paper.id}
                  className="paper-row"
                  onClick={() => {
                    selectPaper(paper);
                    setDetailOpen(true);
                  }}
                  role="listitem"
                >
                  <span className="paper-title-cell">
                    <span className="paper-status-dot" data-status={paper.status} />
                    <strong>{paper.shortTitle}</strong>
                    <span className="authors">{paper.authors}</span>
                  </span>
                  <span className="paper-journal">{paper.journal}</span>
                  <span className="paper-year">{paper.year}</span>
                  <span className="paper-table-tags">{paper.tags.slice(0, 2).map((tag) => <i key={tag}>#{tag}</i>)}</span>
                  <span className="table-status"><i data-status={paper.status} />{paper.status}</span>
                  <time>{paper.added}</time>
                  <span className="row-arrow">›</span>
                </button>
              ))}
              {!filteredPapers.length && <div className="empty-state">条件に合う論文がありません。</div>}
            </div>
          </section>

          {detailOpen && (
            <>
              <button className="detail-backdrop" type="button" aria-label="詳細を閉じる" onClick={() => setDetailOpen(false)} />
              <article className="paper-detail" role="dialog" aria-modal="true" aria-label={`${selected.shortTitle} の詳細`}>
            <div className="detail-head">
              <div className="detail-actions">
                <select
                  className="status-select"
                  value={selected.status}
                  onChange={(event) => {
                    const status = event.target.value as Paper["status"];
                    updateSelected({ status, progress: status === "読了" ? 100 : status === "未読" ? 0 : Math.max(selected.progress, 10) });
                  }}
                  aria-label="読書状態"
                >
                  <option value="未読">未読</option>
                  <option value="読書中">読書中</option>
                  <option value="読了">読了</option>
                </select>
                <button type="button" aria-label="お気に入り" onClick={() => showToast("お気に入りに追加しました")}>☆</button>
                <button type="button" aria-label="論文を削除" onClick={removeSelectedPaper}>削</button>
                <button className="detail-close" type="button" aria-label="詳細を閉じる" onClick={() => setDetailOpen(false)}>×</button>
              </div>
              <p className="paper-type">{selected.type.toUpperCase()}</p>
              <h2>{selected.title}</h2>
              <p className="detail-authors">{selected.authors}</p>
              <p className="citation">{selected.journal} · {selected.year} · DOI: {selected.doi}</p>
              <div className="detail-tags">
                {selected.tags.map((tag) => <button type="button" key={tag} onClick={() => setActiveTag(tag)}>#{tag}</button>)}
                <input
                  aria-label="タグを追加"
                  placeholder="＋ タグ"
                  value={newTag}
                  onChange={(event) => setNewTag(event.target.value)}
                  onKeyDown={handleNewTag}
                />
              </div>
            </div>

            <div className="detail-body">
              <div className="reading-column">
                <section className="content-block">
                  <div className="section-title"><span>01</span><h3>要約</h3><button type="button" onClick={() => showToast("要約編集モードは次の実装候補です")}>編集</button></div>
                  <p>{selected.abstract}</p>
                </section>

                <section className="result-callout">
                  <span className="result-label">KEY RESULT</span>
                  <p>{selected.keyResult}</p>
                </section>

                <section className="content-block">
                  <div className="section-title"><span>02</span><h3>Clinical note</h3><i>自動保存</i></div>
                  <textarea value={note} onChange={(event) => updateSelected({ note: event.target.value })} aria-label="Clinical note" />
                </section>
              </div>

              <aside className="workflow-column">
                <section className="workflow-card pdf-card">
                  <div className="workflow-heading"><span className="file-icon">PDF</span><div><strong>{localPdf?.name ?? "PDFを参照"}</strong><small>{localPdf ? "このセッションで選択済み" : "Google Drive同期フォルダから"}</small></div><em>●</em></div>
                  <p>{localPdf ? localPdf.name : selected.drivePath}</p>
                  <div className="workflow-buttons">
                    <label className="small-button primary">PDFを選択<input type="file" accept="application/pdf" onChange={choosePdf} /></label>
                    <a className={localPdf ? "small-button" : "small-button disabled"} href={localPdf?.url} target="_blank" rel="noreferrer">開く ↗</a>
                  </div>
                </section>

                <section className="workflow-card markdown-card">
                  <div className="workflow-heading"><span className="obsidian-icon">◇</span><div><strong>Obsidian Markdown</strong><small>Vault / Medical / Papers</small></div></div>
                  <pre>{markdown.slice(0, 320)}…</pre>
                  <div className="workflow-buttons">
                    <button className="small-button primary" type="button" onClick={downloadMarkdown}>.md 保存</button>
                    <button className="small-button" type="button" onClick={copyMarkdown}>コピー</button>
                  </div>
                  <button className="drive-sync-button" type="button" onClick={syncSelectedPaper}>
                    <span>G</span>{driveState === "接続済み" ? "Google Driveへ同期" : "Google Driveを接続"}
                  </button>
                </section>

                <section className="meta-table">
                  <p>文献情報</p>
                  <dl>
                    <div><dt>Year</dt><dd>{selected.year}</dd></div>
                    <div><dt>DOI</dt><dd>{selected.doi}</dd></div>
                    <div><dt>Status</dt><dd>{selected.status}</dd></div>
                    <div><dt>Progress</dt><dd>{selected.progress}%</dd></div>
                  </dl>
                </section>
              </aside>
            </div>
              </article>
            </>
          )}
        </section>
      )}

      {addOpen && (
        <div className="modal-layer" role="presentation">
          <button className="modal-backdrop" type="button" aria-label="論文追加を閉じる" onClick={() => setAddOpen(false)} />
          <section className="app-modal add-paper-modal" role="dialog" aria-modal="true" aria-labelledby="add-paper-title">
            <div className="modal-heading">
              <div><p className="eyebrow">LOCAL TEST LIBRARY</p><h2 id="add-paper-title">論文を追加</h2></div>
              <button type="button" aria-label="閉じる" onClick={() => setAddOpen(false)}>×</button>
            </div>
            <p className="modal-lead">PDFと書誌情報はまずこの端末に保存されます。Google Drive接続後に同じ論文を同期できます。</p>
            <form className="paper-form" onSubmit={addPaper}>
              <label className="full-field"><span>論文タイトル *</span><input name="title" required placeholder="例：Dapagliflozin in Patients with CKD" /></label>
              <label><span>著者</span><input name="authors" placeholder="著者名をカンマ区切りで入力" /></label>
              <label><span>掲載誌</span><input name="journal" placeholder="New England Journal of Medicine" /></label>
              <label><span>発行年</span><input name="year" type="number" min="1900" max="2100" defaultValue={new Date().getFullYear()} /></label>
              <label><span>DOI</span><input name="doi" placeholder="10.xxxx/xxxxx" /></label>
              <label className="full-field"><span>タグ</span><input name="tags" placeholder="腎臓, SGLT2阻害薬, RCT" /></label>
              <label className="full-field"><span>要約</span><textarea name="abstract" placeholder="あとから編集できます" /></label>
              <label className="full-field file-drop"><span>PDF</span><input name="pdf" type="file" accept="application/pdf" /><small>PDFはこのブラウザの端末内領域へ保存されます</small></label>
              <div className="modal-actions"><button className="small-button" type="button" onClick={() => setAddOpen(false)}>キャンセル</button><button className="small-button primary" type="submit">この端末に保存</button></div>
            </form>
          </section>
        </div>
      )}

      {driveOpen && (
        <div className="modal-layer" role="presentation">
          <button className="modal-backdrop" type="button" aria-label="Google Drive設定を閉じる" onClick={() => setDriveOpen(false)} />
          <section className="app-modal drive-modal" role="dialog" aria-modal="true" aria-labelledby="drive-modal-title">
            <div className="modal-heading">
              <div><p className="eyebrow">GOOGLE DRIVE</p><h2 id="drive-modal-title">Rillフォルダへ接続</h2></div>
              <button type="button" aria-label="閉じる" onClick={() => setDriveOpen(false)}>×</button>
            </div>
            <div className="drive-explainer">
              <span className="drive-large-icon">G</span>
              <div><strong>接続すると自動作成されます</strong><code>Google Drive / Rill / Papers</code><code>Google Drive / Rill / Notes</code></div>
            </div>
            <label className="oauth-field"><span>Google OAuthクライアントID</span><input value={googleClientId} onChange={(event) => setGoogleClientId(event.target.value)} placeholder="xxxxxxxx.apps.googleusercontent.com" /><small>クライアントIDは公開識別子です。この端末にだけ保存されます。</small></label>
            <details className="setup-help"><summary>クライアントIDの準備方法</summary><ol><li>Google Cloud Consoleでプロジェクトを作成</li><li>Google Drive APIを有効化</li><li>OAuthクライアントを「ウェブアプリ」で作成</li><li>承認済みJavaScript生成元にこのサイトのURLを登録</li></ol></details>
            <div className="modal-actions"><button className="small-button" type="button" onClick={() => setDriveOpen(false)}>あとで</button><button className="small-button primary" type="button" onClick={connectDrive} disabled={driveState === "接続中"}>{driveState === "接続中" ? "接続中…" : "Google Driveへ接続"}</button></div>
          </section>
        </div>
      )}

      {!storageReady && <div className="storage-loading" role="status">ライブラリを読み込んでいます…</div>}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </main>
  );
}

function Dashboard({
  papers,
  storageReady,
  driveState,
  onOpenLibrary,
  onOpenPaper,
  onAdd,
  onDrive,
  onToast,
}: {
  papers: Paper[];
  storageReady: boolean;
  driveState: "未接続" | "接続中" | "接続済み";
  onOpenLibrary: () => void;
  onOpenPaper: (paper: Paper) => void;
  onAdd: () => void;
  onDrive: () => void;
  onToast: (message: string) => void;
}) {
  const featured = papers.find((paper) => paper.status === "読書中") ?? papers[0] ?? seedPapers[0];
  const queue = papers.filter((paper) => paper.id !== featured.id).slice(0, 2);
  const readThisWeek = papers.filter((paper) => paper.status === "読了").length;
  const tagCounts = Array.from(papers.flatMap((paper) => paper.tags).reduce((counts, tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1), new Map<string, number>())).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const notePapers = papers.filter((paper) => paper.note.trim()).slice(0, 2);
  return (
    <section className="dashboard">
      <aside className="dashboard-sidebar">
        <div>
          <p className="nav-kicker">WORKSPACE</p>
          <button className="dash-nav active" type="button"><span>⌂</span>Overview</button>
          <button className="dash-nav" type="button" onClick={onOpenLibrary}><span>▤</span>Library <b>{papers.length}</b></button>
          <button className="dash-nav" type="button" onClick={() => onToast("タグ一覧はLibraryで絞り込めます")}><span>⌗</span>Tags <b>{new Set(papers.flatMap((paper) => paper.tags)).size}</b></button>
          <button className="dash-nav" type="button" onClick={() => onToast("スター付き論文は3件です")}><span>☆</span>Starred <b>3</b></button>
        </div>
        <div className="sidebar-bottom">
          <button className="mini-integration" type="button" onClick={onDrive}><span className="g-icon">G</span><div><strong>Google Drive</strong><small>{driveState}</small></div><i>●</i></button>
          <div className="mini-integration"><span className="o-icon">◇</span><div><strong>Obsidian</strong><small>Vault設定済み</small></div><i>●</i></div>
        </div>
      </aside>

      <div className="dashboard-main">
        <div className="welcome-row">
          <div><p className="eyebrow">LOCAL TEST WORKSPACE</p><h1>おはようございます。</h1><p>{storageReady ? `${papers.length}本の論文がこの端末に保存されています。` : "ライブラリを読み込んでいます。"}</p></div>
          <button className="add-button large" type="button" onClick={onAdd}>＋ 論文を追加</button>
        </div>

        <div className="dashboard-grid">
          <section className="queue-card dashboard-card">
            <div className="card-heading"><div><p className="eyebrow">READING QUEUE</p><h2>今日読む論文</h2></div><button type="button" onClick={onOpenLibrary}>すべて見る →</button></div>
            <button className="featured-paper" type="button" onClick={() => onOpenPaper(featured)}>
              <span className="journal-cover"><i>NEJM</i><b>2020</b></span>
              <span className="featured-copy">
                <span className="paper-topline"><span>{featured.type.toUpperCase()}</span><time>{featured.status}</time></span>
                <strong>{featured.title}</strong>
                <span className="authors">{featured.authors}</span>
                <span className="tag-line">{featured.tags.map((tag) => <i key={tag}>#{tag}</i>)}</span>
                <span className="progress-line"><span><i style={{ width: `${featured.progress}%` }} /></span><b>{featured.progress}%</b></span>
              </span>
              <span className="continue-button">続きを読む</span>
            </button>
            {queue.map((paper, index) => (
              <button className="queue-row" type="button" key={paper.id} onClick={() => onOpenPaper(paper)}>
                <span className="queue-num">0{index + 2}</span><span><strong>{paper.shortTitle}</strong><small>{paper.journal} · {paper.year}</small></span><em>{paper.status}</em><b>›</b>
              </button>
            ))}
          </section>

          <section className="stats-card dashboard-card">
            <div className="card-heading"><div><p className="eyebrow">THIS WEEK</p><h2>読書ペース</h2></div><span className="trend">↗ 18%</span></div>
            <div className="big-stat"><strong>{readThisWeek}</strong><span>papers read<small>端末内ライブラリの読了数</small></span></div>
            <div className="week-bars" aria-label="週間読書数">
              {[35, 54, 40, 78, 62, 28, 12].map((height, index) => <span key={index}><i style={{ height: `${height}%` }} /><small>{["月", "火", "水", "木", "金", "土", "日"][index]}</small></span>)}
            </div>
          </section>

          <section className="topics-card dashboard-card">
            <div className="card-heading"><div><p className="eyebrow">TOPICS</p><h2>最近のトピック</h2></div><button type="button" onClick={onOpenLibrary}>管理</button></div>
            <div className="topic-cloud">
              {(tagCounts.length ? tagCounts : [["タグ未登録", 0] as [string, number]]).map(([tag, count], index) => <button type="button" onClick={onOpenLibrary} className={index === 0 ? "topic-large" : ""} key={tag}><span>{tag}</span><b>{count}</b></button>)}
            </div>
          </section>

          <section className="workflow-dashboard dashboard-card">
            <div className="card-heading"><div><p className="eyebrow">WORKFLOW</p><h2>連携ステータス</h2></div></div>
            <button className="flow-row flow-button" type="button" onClick={onDrive}><span className="g-icon">G</span><div><strong>Google Drive</strong><small>Rill / Papers / Notes</small></div><i>{driveState}</i></button>
            <div className="flow-divider"><span>↓</span><small>PDF参照</small></div>
            <div className="flow-row"><span className="r-icon">R</span><div><strong>Rill Library</strong><small>タグ・要約・Clinical note</small></div><i>作業中</i></div>
            <div className="flow-divider"><span>↓</span><small>Markdown</small></div>
            <div className="flow-row"><span className="o-icon">◇</span><div><strong>Obsidian Vault</strong><small>Medical / Papers</small></div><i>出力可能</i></div>
          </section>

          <section className="recent-notes dashboard-card">
            <div className="card-heading"><div><p className="eyebrow">NOTES</p><h2>最近のメモ</h2></div></div>
            {notePapers.map((paper) => <button type="button" onClick={() => onOpenPaper(paper)} key={paper.id}><span className="quote-mark">“</span><p>{paper.note}</p><small>{paper.shortTitle} · {paper.added}</small></button>)}
            {!notePapers.length && <p className="empty-note">Clinical noteを書くとここに表示されます。</p>}
          </section>
        </div>
      </div>
    </section>
  );
}
