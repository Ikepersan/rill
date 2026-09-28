import { lazy, Suspense, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import CSL from "citeproc";
import cslStyles from "@citation-js/plugin-csl/lib/styles.json";
import cslLocales from "@citation-js/plugin-csl/lib/locales.json";

const RillPdfReader = lazy(() => import("./RillPdfReader").then((module) => ({ default: module.RillPdfReader })));

type View = "overview" | "library" | "references" | "reader";
type SortMode = "追加日（新しい順）" | "追加日（古い順）" | "年（新しい順）" | "年（古い順）" | "タイトル" | "著者" | "読書状態" | "重要度";
type QuickFilter = "すべて" | "お気に入り" | "参考文献" | "フラッグあり" | "要約あり" | "メモあり";
type CitationStyle = string;
type PdfDropTarget = "overview" | "header" | "library" | null;

export type Paper = {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  journal: string;
  journalAbbreviation: string;
  doi: string;
  pmid: string;
  citationKey: string;
  volume: string;
  issue: string;
  pages: string;
  isReference: boolean;
  flagColor: string;
  isFavorite: boolean;
  tags: string[];
  status: string;
  pdfPath: string;
  notePath: string;
  summary: string;
  translatedSummary: string;
  clinicalNote: string;
  addedAt: string;
  noteRevision: string;
};

type TrashEntry = {
  paper: Paper;
  deletedAt: string;
};

type ImportResult = {
  imported: number;
  skippedDuplicates: number;
};
type SearchHit = { paperId: string; source: "PDF" | "Markdown"; snippet: string };
type CslStyleFile = { name: string; xml: string };
type CitationOptions = {
  numbering: "none" | "period" | "brackets";
  includeAuthors: boolean;
  authorNames: "initials" | "full" | "surname";
  authorSeparator: ", " | "; " | " and ";
  finalAuthor: "separator" | "and" | "ampersand";
  etAlAfter: number;
  includeTitle: boolean;
  title: "show" | "hide";
  titleCase: "original" | "sentence";
  includeJournal: boolean;
  journalNames: "full" | "abbreviated";
  italicJournal: boolean;
  doiMode: "none" | "url" | "prefix";
  includeVolume: boolean;
  includeIssue: boolean;
  issueFormat: "parentheses" | "plain";
  includePages: boolean;
  locatorPattern: "year-volume-pages" | "year-volume-issue-pages" | "year-volume-article";
  includeYear: boolean;
  yearParentheses: boolean;
  yearPosition: "after-authors" | "end";
  hangingIndent: boolean;
};
type CitationPreset = { id: string; name: string; options: CitationOptions };

function RillMark({ size = "small" }: { size?: "small" | "regular" | "large" }) {
  return (
    <span className={`rill-mark ${size}`} aria-hidden="true">
      <svg viewBox="0 0 32 32">
        <path d="M6 8c10 0 10 8 2 8s0 8 18 8" />
      </svg>
    </span>
  );
}

const defaultCitationOptions: CitationOptions = {
  numbering: "none",
  includeAuthors: true,
  authorNames: "initials",
  authorSeparator: "; ",
  finalAuthor: "separator",
  etAlAfter: 10,
  includeTitle: true,
  title: "show",
  titleCase: "original",
  includeJournal: true,
  journalNames: "full",
  italicJournal: true,
  doiMode: "none",
  includeVolume: true,
  includeIssue: true,
  issueFormat: "parentheses",
  includePages: true,
  locatorPattern: "year-volume-issue-pages",
  includeYear: true,
  yearParentheses: false,
  yearPosition: "end",
  hangingIndent: false,
};
const initialCitationPresets: CitationPreset[] = [
  { id: "medical-standard", name: "医学雑誌・標準", options: { ...defaultCitationOptions, numbering: "period", authorSeparator: ", ", finalAuthor: "and", etAlAfter: 6, journalNames: "abbreviated", locatorPattern: "year-volume-issue-pages", doiMode: "none" } },
  { id: "medical-doi", name: "医学雑誌・DOI", options: { ...defaultCitationOptions, numbering: "period", authorSeparator: ", ", finalAuthor: "and", etAlAfter: 6, journalNames: "abbreviated", locatorPattern: "year-volume-issue-pages", doiMode: "prefix" } },
  { id: "japanese-review", name: "日本語総説・番号", options: { ...defaultCitationOptions, numbering: "period", authorSeparator: ", ", etAlAfter: 3, journalNames: "abbreviated", locatorPattern: "year-volume-pages" } },
  { id: "article-number", name: "Article number", options: { ...defaultCitationOptions, numbering: "brackets", authorSeparator: ", ", etAlAfter: 6, journalNames: "abbreviated", locatorPattern: "year-volume-article", doiMode: "url" } },
  { id: "author-year", name: "著者年", options: { ...defaultCitationOptions, numbering: "none", authorSeparator: ", ", finalAuthor: "and", yearPosition: "after-authors", yearParentheses: true, journalNames: "full", locatorPattern: "year-volume-issue-pages" } },
];

function normalizeCitationOptions(raw: Partial<CitationOptions> & { includeDoi?: boolean; doiFormat?: "url" | "prefix" }) {
  return { ...defaultCitationOptions, ...raw, includeTitle: raw.includeTitle ?? raw.title !== "hide", doiMode: raw.doiMode ?? (raw.includeDoi ? (raw.doiFormat ?? "url") : defaultCitationOptions.doiMode) };
}
const customCslStyleMap = new Map<string, string>();

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

const demoPapers: Paper[] = [
  {
    id: "demo-dapa",
    title: "Dapagliflozin in Patients with Chronic Kidney Disease",
    authors: ["Heerspink HJL", "Stefánsson BV"],
    year: 2020,
    journal: "New England Journal of Medicine", journalAbbreviation: "N Engl J Med",
    doi: "10.1056/NEJMoa2024816",
    pmid: "32970396",
    citationKey: "Heerspink2020Dapagliflozin",
    volume: "383", issue: "15", pages: "1436–1446", isReference: true, flagColor: "yellow", isFavorite: true,
    tags: ["CKD", "SGLT2", "腎臓"],
    status: "読了",
    pdfPath: "Papers/2020_Heerspink_DAPA-CKD.pdf",
    notePath: "Notes/2020_Heerspink_DAPA-CKD.md",
    summary: "Dapagliflozin reduced kidney and cardiovascular outcomes in patients with chronic kidney disease.", translatedSummary: "CKD患者において、ダパグリフロジンは腎・心血管複合アウトカムのリスクを低下させた。",
    clinicalNote: "糖尿病の有無にかかわらず腎保護効果が示された点を外来説明に使う。",
    addedAt: "2026-07-17T09:20:00Z", noteRevision: "",
  },
  {
    id: "demo-empa",
    title: "Empagliflozin in Patients with Chronic Kidney Disease",
    authors: ["Herrington WG", "Staplin N"],
    year: 2023,
    journal: "New England Journal of Medicine", journalAbbreviation: "N Engl J Med",
    doi: "10.1056/NEJMoa2204233",
    pmid: "36331190",
    citationKey: "Herrington2023Empagliflozin",
    volume: "388", issue: "2", pages: "117–127", isReference: false, flagColor: "blue", isFavorite: false,
    tags: ["CKD", "SGLT2"],
    status: "読書中",
    pdfPath: "Inbox/2023_Herrington_EMPA-KIDNEY.pdf",
    notePath: "Notes/2023_Herrington_EMPA-KIDNEY.md",
    summary: "Empagliflozin reduced progression of kidney disease or cardiovascular death across a broad CKD population.", translatedSummary: "幅広いCKD患者で腎疾患進行または心血管死を抑制した。",
    clinicalNote: "eGFRが低い患者での導入タイミングを確認する。",
    addedAt: "2026-07-16T05:10:00Z", noteRevision: "",
  },
  {
    id: "demo-kdigo",
    title: "KDIGO 2024 Clinical Practice Guideline for CKD",
    authors: ["KDIGO CKD Work Group"],
    year: 2024,
    journal: "Kidney International", journalAbbreviation: "Kidney Int",
    doi: "",
    pmid: "",
    citationKey: "KDIGO2024Clinical",
    volume: "105", issue: "4S", pages: "S117–S314", isReference: false, flagColor: "", isFavorite: false,
    tags: ["CKD", "ガイドライン"],
    status: "未読",
    pdfPath: "Inbox/KDIGO_2024_CKD_Guideline.pdf",
    notePath: "Notes/KDIGO_2024_CKD_Guideline.md",
    summary: "", translatedSummary: "",
    clinicalNote: "",
    addedAt: "2026-07-15T11:00:00Z", noteRevision: "",
  },
  {
    id: "demo-kurose-article-number",
    title: "Diverse tau pathologies in late-life mood disorders revealed by PET and autopsy assays",
    authors: ["Shin Kurose", "Sho Moriguchi", "Manabu Kubota", "Kenji Tagai", "Yuki Momota", "Masanori Ichihashi", "Yasunori Sano"],
    year: 2025,
    journal: "Journal of Affective Disorders", journalAbbreviation: "J Affect Disord",
    doi: "10.0000/rill.kurose.fixture", pmid: "",
    citationKey: "Kurose2025Diverse",
    volume: "", issue: "", pages: "21", isReference: true, flagColor: "", isFavorite: false,
    tags: ["fixture", "article-number"], status: "未読",
    pdfPath: "Fixtures/Kurose_article_number.pdf", notePath: "Notes/Kurose_article_number.md",
    summary: "A safe local fixture for article-number citation formatting.", translatedSummary: "article numberの引用整形を確認するための安全なfixture。",
    clinicalNote: "", addedAt: "2026-07-14T11:00:00Z", noteRevision: "",
  },
  {
    id: "demo-author-name-fixture",
    title: "Author name parsing fixture",
    authors: ["Kurose, Shin", "Shott, Megan E.", "O'Neil-Smith, Mary-Jane", "van der Meer, Anna Maria"],
    year: 2026, journal: "Rill Test Journal", journalAbbreviation: "Rill Test J",
    doi: "", pmid: "", citationKey: "AuthorFixture2026", volume: "1", issue: "2", pages: "10–12",
    isReference: false, flagColor: "", isFavorite: false, tags: ["fixture", "authors"], status: "未読",
    pdfPath: "Fixtures/author_name_parsing.pdf", notePath: "Notes/author_name_parsing.md",
    summary: "Safe fixture for comma-form, multiple-initial, hyphenated, and compound family names.", translatedSummary: "著者名の正規化を確認する安全なfixture。",
    clinicalNote: "", addedAt: "2026-07-13T11:00:00Z", noteRevision: "",
  },
];

function absolutePath(root: string, relative: string) {
  return `${root.replace(/\/$/, "")}/${relative}`;
}

function shortAuthors(authors: string[]) {
  if (authors.length === 0) return "著者未登録";
  return authors.length > 1 ? `${authors[0]} ほか` : authors[0];
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric" }).format(date);
}

function statusTone(status: string) {
  if (status === "読了") return "done";
  if (status === "読書中") return "reading";
  return "unread";
}

function parseTags(value: string) {
  const normalized = value.replaceAll("＃", "#");
  const pieces = normalized.includes("#")
    ? normalized.split(/(?=#)|,/)
    : normalized.split(",");
  return Array.from(new Set(pieces
    .map((piece) => piece.trim().replace(/^#+/, "").trim())
    .filter(Boolean)));
}

function formatTags(tags: string[]) {
  return tags.map((tag) => `#${tag.replace(/^#+/, "")}`).join(" ");
}

function citationNameParts(name: string) {
  if (name.includes(",")) {
    const [family, ...given] = name.split(",");
    return { surname: family.trim(), given: given.join(" ").trim().split(/\s+/).filter(Boolean) };
  }
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { surname: words[0] ?? "", given: [] };
  const last = words.at(-1) ?? "";
  const looksLikeInitials = last.length <= 5 && /^[A-Z]+$/.test(last);
  return { surname: looksLikeInitials ? words[0] : last, given: looksLikeInitials ? words.slice(1) : words.slice(0, -1) };
}

function citationAuthor(name: string) {
  const { surname, given } = citationNameParts(name);
  const initials = given.flatMap((word) => {
    const letters = Array.from(word).filter((character) => /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(character));
    return /^[A-Z]+$/.test(word) && letters.length <= 5 ? letters : letters.slice(0, 1);
  }).map((character) => `${character.toUpperCase()}.`).join("");
  return initials ? `${initials} ${surname}` : surname;
}

function citationFullName(name: string) {
  const { surname, given } = citationNameParts(name);
  return [...given, surname].filter(Boolean).join(" ") || name.trim();
}

function citationSurname(name: string) {
  return citationNameParts(name).surname || name.trim();
}

function sentenceCase(value: string) {
  if (!value) return value;
  let firstWord = true;
  return value.replace(/[\p{L}\p{N}][\p{L}\p{N}/-]*/gu, (word) => {
    const hasAcronymCase = /[A-Z].*[A-Z]/.test(word) || /[a-z][A-Z]/.test(word);
    const hasUppercaseIdentifier = /[A-Z]/.test(word) && /\d/.test(word);
    if (hasAcronymCase || hasUppercaseIdentifier) {
      firstWord = false;
      return word;
    }
    const lower = word.toLocaleLowerCase("en");
    if (!firstWord) return lower;
    firstWord = false;
    return lower.charAt(0).toLocaleUpperCase("en") + lower.slice(1);
  });
}

function cslAuthor(name: string) {
  if (name.includes(",")) { const [family, ...given] = name.split(","); return { family: family.trim(), given: given.join(",").trim() }; }
  const words = name.trim().split(/\s+/).filter(Boolean); if (words.length < 2) return { literal: name };
  const last = words.at(-1) ?? ""; const initialsLast = last.length <= 5 && /^[A-Z]+$/.test(last);
  return initialsLast ? { family: words[0], given: words.slice(1).join(" ") } : { family: last, given: words.slice(0, -1).join(" ") };
}

function cslPaper(paper: Paper) {
  return { id: paper.id, type: "article-journal", title: paper.title, author: paper.authors.map(cslAuthor), issued: paper.year ? { "date-parts": [[paper.year]] } : undefined, "container-title": paper.journal, "container-title-short": paper.journalAbbreviation || undefined, volume: paper.volume || undefined, issue: paper.issue || undefined, page: paper.pages || undefined, DOI: paper.doi || undefined, PMID: paper.pmid || undefined };
}

function formatCslCitation(paper: Paper, style: string) {
  const item = cslPaper(paper); const styleXml = style.startsWith("custom:") ? customCslStyleMap.get(style.slice(7)) : (cslStyles as Record<string, string>)[style];
  if (!styleXml) throw new Error("CSL style not found");
  const locales = cslLocales as Record<string, string>;
  const engine = new CSL.Engine({ retrieveLocale: (language: string) => locales[language] || locales["en-US"], retrieveItem: () => item }, styleXml, "en-US");
  engine.updateItems([paper.id]);
  const bibliography = engine.makeBibliography();
  return bibliography ? bibliography[1][0].replace(/<[^>]+>/g, "").replace(/^\s*1\.\s*/, "").trim() : "";
}

function isPresetStyle(style: CitationStyle) { return style.startsWith("preset:"); }

function referenceOrderStorageKey(libraryRoot: string) {
  return `rill-reference-order:${libraryRoot || "preview"}`;
}

function formatCitation(paper: Paper, style: CitationStyle = "journal", options: CitationOptions = defaultCitationOptions) {
  if (style === "short") {
    const lead = citationSurname(paper.authors[0] ?? "著者不明") || "著者不明";
    const authors = paper.authors.length > 1 ? `${lead} et al.` : `${lead}.`;
    return `${authors} ${paper.journalAbbreviation || paper.journal || "誌名未登録"}, ${paper.year ?? "年不明"}`;
  }
  if (["apa", "vancouver", "harvard1"].includes(style) || style.startsWith("custom:")) {
    try {
      return formatCslCitation(paper, style);
    } catch { /* fall through to the stable local formatter */ }
  }
  const authorLimit = Math.max(1, options.etAlAfter || 1);
  const sourceAuthors = paper.authors.slice(0, authorLimit);
  const shownAuthors = sourceAuthors.map((author) => options.authorNames === "full" ? citationFullName(author) : options.authorNames === "surname" ? citationSurname(author) : citationAuthor(author)).filter(Boolean);
  let authors = shownAuthors.join(options.authorSeparator);
  if (shownAuthors.length > 1 && paper.authors.length <= authorLimit && options.finalAuthor !== "separator") {
    const joiner = options.finalAuthor === "and" ? " and " : " & ";
    authors = `${shownAuthors.slice(0, -1).join(options.authorSeparator)}${joiner}${shownAuthors.at(-1)}`;
  }
  if (paper.authors.length > authorLimit) authors += `${options.authorSeparator}et al.`;
  const authorLead = options.includeAuthors ? (authors || "著者不明") : "";
  const punctuatedAuthors = authorLead ? (authorLead.endsWith(".") ? authorLead : `${authorLead}.`) : "";
  const yearValue = paper.year?.toString() ?? "年不明";
  const year = options.includeYear ? (options.yearParentheses ? `(${yearValue})` : yearValue) : "";
  const journal = options.includeJournal ? (options.journalNames === "abbreviated" ? (paper.journalAbbreviation || paper.journal || "誌名未登録") : (paper.journal || paper.journalAbbreviation || "誌名未登録")) : "";
  const journalText = journal && options.italicJournal ? `*${journal}*` : journal;
  const volume = options.includeVolume ? paper.volume : "";
  const issue = options.includeIssue ? paper.issue : "";
  const volumeIssue = issue
    ? (options.issueFormat === "parentheses" ? `${volume || ""}(${issue})` : [volume, issue].filter(Boolean).join(" "))
    : volume;
  const pages = options.includePages ? paper.pages : "";
  const rawLocator = options.locatorPattern === "year-volume-article"
    ? [volume, pages].filter(Boolean).join(":")
    : options.locatorPattern === "year-volume-pages"
      ? [volume, pages].filter(Boolean).join(":")
      : [volumeIssue, pages].filter(Boolean).join(":");
  // Volume, issue, and page/article number are journal locators. Keeping them with
  // a hidden journal produces an orphaned value such as a lone "21".
  const locator = options.includeJournal ? rawLocator : "";
  const journalDetails = [journalText, locator].filter(Boolean).join(" ");
  const doi = options.doiMode !== "none" && paper.doi ? (options.doiMode === "prefix" ? `doi:${paper.doi}` : `https://doi.org/${paper.doi}`) : "";
  const title = !options.includeTitle || options.title === "hide" ? "" : (options.titleCase === "sentence" ? sentenceCase(paper.title) : paper.title);
  const leading = [punctuatedAuthors, options.yearPosition === "after-authors" && year ? `${year}.` : "", title ? `${title}.` : ""].filter(Boolean);
  const journalWithYear = [journalDetails, options.yearPosition === "end" && year ? year : ""].filter(Boolean).join(", ");
  return [...leading, journalWithYear, doi].filter(Boolean).join(" ").replace(/\.+$/, ".");
}

function formatReferenceParts(paper: Paper, index: number, style: CitationStyle, options: CitationOptions) {
  const citation = formatCitation(paper, style, options);
  if (isPresetStyle(style) && options.numbering !== "none") return { number: options.numbering === "brackets" ? `[${index}]` : `${index}.`, citation };
  return { number: "", citation };
}

function formatReference(paper: Paper, index: number, style: CitationStyle, options: CitationOptions) {
  const { number, citation } = formatReferenceParts(paper, index, style, options);
  return [number, citation].filter(Boolean).join(" ");
}

export default function App() {
  const [root, setRoot] = useState("");
  const [papers, setPapers] = useState<Paper[]>(isTauri ? [] : demoPapers);
  const [view, setView] = useState<View>("overview");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [readerPaperId, setReaderPaperId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Paper | null>(null);
  const [search, setSearch] = useState("");
  const [fullTextHits, setFullTextHits] = useState<SearchHit[]>([]);
  const [searchingFullText, setSearchingFullText] = useState(false);
  const [statusFilter, setStatusFilter] = useState("すべて");
  const [tagFilter, setTagFilter] = useState("");
  const [folderFilter, setFolderFilter] = useState("");
  const [collections, setCollections] = useState<string[]>([]);
  const [trashEntries, setTrashEntries] = useState<TrashEntry[]>([]);
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("すべて");
  const [sortMode, setSortMode] = useState<SortMode>("追加日（新しい順）");
  const [bulkDestination, setBulkDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [pdfDropTarget, setPdfDropTarget] = useState<PdfDropTarget>(null);
  const [showAddDropZone, setShowAddDropZone] = useState(false);
  const [toast, setToast] = useState("");
  const [ready, setReady] = useState(!isTauri);
  const [saveState, setSaveState] = useState("保存済み");
  const [folderDialog, setFolderDialog] = useState<{ parent: string; name: string; movePaperIds?: string[] } | null>(null);
  const [renameFolderDialog, setRenameFolderDialog] = useState<{ collection: string; name: string } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; collection: string } | null>(null);
  const [paperMenu, setPaperMenu] = useState<{ x: number; y: number; paperIds: string[] } | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<string | null>(null);
  const [draggingPaperIds, setDraggingPaperIds] = useState<string[]>([]);
  const [folderDropTarget, setFolderDropTarget] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number; title: string; count: number } | null>(null);
  const [draggingCollection, setDraggingCollection] = useState<string | null>(null);
  const [folderHierarchyDropTarget, setFolderHierarchyDropTarget] = useState<string | null>(null);
  const [folderDragPreview, setFolderDragPreview] = useState<{ x: number; y: number; collection: string } | null>(null);
  const [citationStyle, setCitationStyle] = useState<CitationStyle>("journal");
  const [citationOptions, setCitationOptions] = useState<CitationOptions>(defaultCitationOptions);
  const [citationPresets, setCitationPresets] = useState<CitationPreset[]>([]);
  const [referenceOrder, setReferenceOrder] = useState<string[]>([]);
  const [customCitationStyles, setCustomCitationStyles] = useState<CslStyleFile[]>([]);
  const [obsidianConnected, setObsidianConnected] = useState(false);
  const [showObsidianSetup, setShowObsidianSetup] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [pdfAvailability, setPdfAvailability] = useState<Record<string, boolean>>({});
  const papersRef = useRef<Paper[]>(papers);
  const draftDirty = useRef(false);
  const draftRef = useRef<Paper | null>(null);
  const draftRevision = useRef(0);
  const latestRevisionByPaper = useRef(new Map<string, number>());
  const queuedSaveByPaper = useRef(new Map<string, { revision: number; operation: Promise<void> }>());
  const draftSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const failedDraftSaves = useRef(new Map<string, { snapshot: Paper; revision: number; error: unknown }>());
  const autoSaveTimer = useRef(0);
  const readerFlush = useRef<(() => Promise<void>) | null>(null);
  const closingAfterFlush = useRef(false);
  const lastSelectedId = useRef<string | null>(null);
  const pointerDrag = useRef<{ paperId: string; paperIds: string[]; startX: number; startY: number; active: boolean } | null>(null);
  const folderPointerDrag = useRef<{ collection: string; startX: number; startY: number; active: boolean } | null>(null);
  const collectionMutationInFlight = useRef(false);
  const suppressRowClick = useRef(false);
  const suppressFolderClickUntil = useRef(0);
  const libraryLoadInFlight = useRef<{ root: string; operation: Promise<boolean> } | null>(null);
  const libraryRefreshTimer = useRef(0);

  const selected = papers.find((paper) => paper.id === selectedId) ?? null;
  const readerPaper = papers.find((paper) => paper.id === readerPaperId) ?? null;
  papersRef.current = papers;
  draftRef.current = draft;

  useEffect(() => {
    if (!isTauri) {
      setRoot("/Users/you/Google Drive/Rill");
      return;
    }
    async function restoreRoot() {
      try {
        const readerLabDefaultRoot = (import.meta.env.VITE_RILL_READER_LAB_ROOT as string | undefined)?.trim() ?? "";
        const legacyRoot = localStorage.getItem("rill-library-root") || readerLabDefaultRoot;
        const restored = await invoke<string | null>("restore_library_root");
        const authorized = restored || (legacyRoot
          ? await invoke<string | null>("migrate_library_root", { root: legacyRoot })
          : null);
        if (!authorized) {
          setReady(true);
          return;
        }
        localStorage.setItem("rill-library-root", authorized);
        setRoot(authorized);
        await loadLibrary(authorized, false);
      } catch (error) {
        setToast(String(error));
        setReady(true);
      }
    }
    void restoreRoot();
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let stopListening: (() => void) | undefined;

    void listen<string>("rill://menu-action", ({ payload }) => {
      if (payload === "settings") setShowSettings(true);
      if (payload === "add-pdf") void importPdfs();
      if (payload === "open-library") void openLibraryFolder();
      if (payload === "overview") setView("overview");
      if (payload === "library") setView("library");
      if (payload === "references") setView("references");
      if (payload === "copy") {
        const request = new Event("rill://copy-request", { cancelable: true });
        if (window.dispatchEvent(request)) document.execCommand("copy");
      }
      if (payload === "quit") void requestAppQuit();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    }).catch((error) => setToast(String(error)));

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [root]);

  useEffect(() => {
    try {
      const key = referenceOrderStorageKey(root);
      const stored = JSON.parse(localStorage.getItem(key) ?? "[]");
      setReferenceOrder(Array.isArray(stored) && stored.every((id) => typeof id === "string") ? stored : []);
    } catch { localStorage.removeItem(referenceOrderStorageKey(root)); setReferenceOrder([]); }
  }, [root]);

  useEffect(() => {
    try {
      const storedOptions = JSON.parse(localStorage.getItem("rill-citation-options") ?? "null") as Partial<CitationOptions> | null;
      const migratedOptions = normalizeCitationOptions(storedOptions ?? {});
      setCitationOptions(migratedOptions);
      const storedPresets = JSON.parse(localStorage.getItem("rill-citation-presets") ?? "[]") as CitationPreset[];
      if (Array.isArray(storedPresets) && storedPresets.length > 0) {
        const normalized = storedPresets.map((preset) => ({ ...preset, options: normalizeCitationOptions(preset.options) }));
        const storedIds = new Set(normalized.map((preset) => preset.id));
        const migrated = [...initialCitationPresets.filter((preset) => !storedIds.has(preset.id)), ...normalized];
        setCitationPresets(migrated);
        if (migrated.length !== normalized.length) localStorage.setItem("rill-citation-presets", JSON.stringify(migrated));
      }
      else {
        const migrated = [...initialCitationPresets, { id: "rill-default", name: "カスタム形式", options: migratedOptions }];
        setCitationPresets(migrated); localStorage.setItem("rill-citation-presets", JSON.stringify(migrated));
      }
      const savedStyle = localStorage.getItem("rill-citation-style");
      if (savedStyle) setCitationStyle(savedStyle);
    } catch { localStorage.removeItem("rill-citation-options"); }
  }, []);

  function updateCitationOptions(next: CitationOptions) {
    if (!isPresetStyle(citationStyle)) {
      setCitationOptions(next);
      localStorage.setItem("rill-citation-options", JSON.stringify(next));
      return;
    }
    const presetId = citationStyle.slice("preset:".length);
    setCitationPresets((current) => {
      const updated = current.map((preset) => preset.id === presetId ? { ...preset, options: next } : preset);
      localStorage.setItem("rill-citation-presets", JSON.stringify(updated));
      return updated;
    });
  }

  function selectCitationStyle(style: CitationStyle) {
    setCitationStyle(style);
    localStorage.setItem("rill-citation-style", style);
    if (!isPresetStyle(style)) return;
    const preset = citationPresets.find((item) => item.id === style.slice("preset:".length));
    if (preset) setCitationOptions(preset.options);
  }

  const activeCitationOptions = isPresetStyle(citationStyle)
    ? citationPresets.find((preset) => preset.id === citationStyle.slice("preset:".length))?.options ?? citationOptions
    : citationOptions;

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("rill-csl-styles") ?? "[]") as CslStyleFile[];
      stored.forEach((style) => customCslStyleMap.set(style.name, style.xml));
      setCustomCitationStyles(stored);
    } catch { localStorage.removeItem("rill-csl-styles"); }
  }, []);

  useEffect(() => {
    const selectionChanged = lastSelectedId.current !== selectedId;
    if (selectionChanged) {
      const previousDraft = draftRef.current;
      if (previousDraft && draftDirty.current) {
        const revision = latestRevisionByPaper.current.get(previousDraft.id) ?? draftRevision.current;
        void enqueueDraftSave(previousDraft, revision).catch(() => undefined);
      }
      lastSelectedId.current = selectedId;
      const failed = selected ? failedDraftSaves.current.get(selected.id) : undefined;
      const source = failed?.snapshot ?? selected;
      const next = source ? { ...source, authors: [...source.authors], tags: [...source.tags] } : null;
      draftDirty.current = Boolean(failed);
      draftRef.current = next;
      setSaveState(failed ? "保存エラー" : "保存済み");
      setDraft(next);
      return;
    }
    if (draftDirty.current) return;
    const next = selected ? { ...selected, authors: [...selected.authors], tags: [...selected.tags] } : null;
    draftRef.current = next;
    setSaveState("保存済み");
    setDraft(next);
  }, [selectedId, papers]);

  useEffect(() => {
    if (!draft || !root) return;
    if (!isTauri) {
      setPdfAvailability((current) => ({ ...current, [draft.id]: true }));
      return;
    }
    let disposed = false;
    void invoke<boolean>("pdf_file_exists", { root, pdfPath: draft.pdfPath })
      .then((available) => {
        if (!disposed) setPdfAvailability((current) => ({ ...current, [draft.id]: available }));
      })
      .catch(() => {
        if (!disposed) setPdfAvailability((current) => ({ ...current, [draft.id]: false }));
      });
    return () => { disposed = true; };
  }, [draft?.id, draft?.pdfPath, root]);

  useEffect(() => {
    if (!draft || !draftDirty.current) return;
    setSaveState("入力中…");
    window.clearTimeout(autoSaveTimer.current);
    const revision = latestRevisionByPaper.current.get(draft.id) ?? draftRevision.current;
    autoSaveTimer.current = window.setTimeout(() => {
      void enqueueDraftSave(draft, revision).catch(() => undefined);
    }, 900);
    return () => window.clearTimeout(autoSaveTimer.current);
  }, [draft, root]);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      if (!disposed) void requestAppQuit();
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch((error) => setToast(String(error)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [root]);

  useEffect(() => {
    if (!isTauri || !root || view === "reader") return;
    const cancelRefresh = () => {
      window.clearTimeout(libraryRefreshTimer.current);
      libraryRefreshTimer.current = 0;
    };
    const scheduleRefresh = () => {
      cancelRefresh();
      libraryRefreshTimer.current = window.setTimeout(() => {
        libraryRefreshTimer.current = 0;
        if (!draftDirty.current && failedDraftSaves.current.size === 0 && document.visibilityState === "visible") {
          void loadLibrary(root, false, false);
        }
      }, 700);
    };
    window.addEventListener("focus", scheduleRefresh);
    window.addEventListener("blur", cancelRefresh);
    return () => {
      cancelRefresh();
      window.removeEventListener("focus", scheduleRefresh);
      window.removeEventListener("blur", cancelRefresh);
    };
  }, [root, view]);

  useEffect(() => {
    const query = search.trim();
    if (!isTauri || !root || query.length < 2) { setFullTextHits([]); setSearchingFullText(false); return; }
    let disposed = false;
    setSearchingFullText(true);
    const timeout = window.setTimeout(() => {
      void invoke<SearchHit[]>("search_library", { root, query }).then((hits) => { if (!disposed) setFullTextHits(hits); }).catch((error) => { if (!disposed) setToast(String(error)); }).finally(() => { if (!disposed) setSearchingFullText(false); });
    }, 360);
    return () => { disposed = true; window.clearTimeout(timeout); };
  }, [root, search]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const closeMenu = () => { setFolderMenu(null); setPaperMenu(null); setShowAddDropZone(false); };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFolderMenu(null);
        setPaperMenu(null);
        setFolderDialog(null);
        setRenameFolderDialog(null);
        setDeleteFolderTarget(null);
        setShowObsidianSetup(false);
        setShowSettings(false);
        setShowAddDropZone(false);
      }
    };
    // Control+click on macOS emits pointerdown before contextmenu. Closing on the
    // later click used to dismiss the menu immediately after it opened.
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, []);

  useEffect(() => {
    const acceptsPdfDrop = showAddDropZone || view === "overview" || (view === "library" && folderFilter !== "__trash");
    if (!isTauri || !root || !acceptsPdfDrop) {
      setPdfDropTarget(null);
      return;
    }

    let disposed = false;
    let stopListening: (() => void) | undefined;
    const targetAtPosition = (event: DragDropEvent): PdfDropTarget => {
      if (event.type === "leave") return null;
      // WKWebView reports drag positions in the same client-coordinate space as
      // getBoundingClientRect on Retina Macs. Scaling these values again makes
      // the hit target appear at half the cursor position.
      const x = event.position.x;
      const y = event.position.y;
      const candidates: Array<{ target: Exclude<PdfDropTarget, null>; selector: string }> = [
        ...(showAddDropZone ? [{ target: "header" as const, selector: ".header-pdf-drop-panel" }] : []),
        view === "overview"
          ? { target: "overview" as const, selector: ".overview-pdf-drop" }
          : { target: "library" as const, selector: ".paper-list-panel" },
      ];
      return candidates.find(({ selector }) => {
        const panel = document.querySelector<HTMLElement>(selector);
        if (!panel) return false;
        const rect = panel.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      })?.target ?? null;
    };

    void getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (disposed) return;
      if (payload.type === "leave") {
        setPdfDropTarget(null);
        return;
      }
      const target = targetAtPosition(payload);
      if (payload.type === "drop") {
        setPdfDropTarget(null);
        if (target) {
          setShowAddDropZone(false);
          void importPdfPaths(payload.paths);
        }
        return;
      }
      const containsPdf = payload.type === "enter"
        ? payload.paths.some((path) => path.toLocaleLowerCase().endsWith(".pdf"))
        : true;
      setPdfDropTarget(containsPdf ? target : null);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    }).catch((error) => setToast(String(error)));

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [folderFilter, root, showAddDropZone, view]);

  const filteredPapers = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("ja");
    const matched = papers.filter((paper) => {
      const matchesStatus = statusFilter === "すべて" || paper.status === statusFilter;
      const matchesTag = !tagFilter
        || (tagFilter === "__favorite" && paper.isFavorite)
        || (tagFilter.startsWith("__flag_") && paper.flagColor === tagFilter.slice(7))
        || paper.tags.includes(tagFilter);
      const matchesFolder = !folderFilter
        || (folderFilter === "__unfiled" && (paper.pdfPath.startsWith("Inbox/") || (paper.pdfPath.startsWith("Papers/") && paper.pdfPath.split("/").length === 2)))
        || (!folderFilter.startsWith("__") && paper.pdfPath.startsWith(`Papers/${folderFilter}/`));
      const matchesQuickFilter = quickFilter === "すべて"
        || (quickFilter === "お気に入り" && paper.isFavorite)
        || (quickFilter === "参考文献" && paper.isReference)
        || (quickFilter === "フラッグあり" && Boolean(paper.flagColor))
        || (quickFilter === "要約あり" && Boolean(paper.summary.trim()))
        || (quickFilter === "メモあり" && Boolean(paper.clinicalNote.trim()));
      const haystack = [paper.title, paper.authors.join(" "), paper.journal, paper.tags.join(" "), paper.doi]
        .join(" ")
        .toLocaleLowerCase("ja");
      const matchesFullText = fullTextHits.some((hit) => hit.paperId === paper.id);
      return matchesStatus && matchesTag && matchesFolder && matchesQuickFilter && (!needle || haystack.includes(needle) || matchesFullText);
    });
    return matched.sort((left, right) => {
      if (sortMode === "追加日（古い順）") return left.addedAt.localeCompare(right.addedAt);
      if (sortMode === "年（新しい順）") return (right.year ?? 0) - (left.year ?? 0);
      if (sortMode === "年（古い順）") return (left.year ?? 9999) - (right.year ?? 9999);
      if (sortMode === "タイトル") return left.title.localeCompare(right.title, "ja");
      if (sortMode === "著者") return (left.authors[0] ?? "").localeCompare(right.authors[0] ?? "", "ja");
      if (sortMode === "読書状態") {
        const rank: Record<string, number> = { "未読": 0, "読書中": 1, "読了": 2 };
        return (rank[left.status] ?? 3) - (rank[right.status] ?? 3);
      }
      if (sortMode === "重要度") {
        const flagRank: Record<string, number> = { red: 3, yellow: 2, blue: 1 };
        const leftRank = (left.isFavorite ? 10 : 0) + (flagRank[left.flagColor] ?? 0);
        const rightRank = (right.isFavorite ? 10 : 0) + (flagRank[right.flagColor] ?? 0);
        return rightRank - leftRank;
      }
      return right.addedAt.localeCompare(left.addedAt);
    });
  }, [papers, search, statusFilter, tagFilter, folderFilter, quickFilter, sortMode, fullTextHits]);

  const folderTitle = folderFilter === "__trash"
    ? "ゴミ箱"
    : folderFilter === "__unfiled"
      ? "未整理"
    : folderFilter
      ? folderFilter.split("/").at(-1) ?? folderFilter
      : "すべての文献";
  const folderScopedPapers = useMemo(() => papers.filter((paper) => (
    !folderFilter
    || (folderFilter === "__unfiled" && (paper.pdfPath.startsWith("Inbox/") || (paper.pdfPath.startsWith("Papers/") && paper.pdfPath.split("/").length === 2)))
    || (!folderFilter.startsWith("__") && paper.pdfPath.startsWith(`Papers/${folderFilter}/`))
  )), [papers, folderFilter]);
  const referencePapers = useMemo(() => {
    const orderIndex = new Map(referenceOrder.map((id, index) => [id, index]));
    return papers.filter((paper) => paper.isReference).sort((left, right) => {
      const leftIndex = orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      return left.addedAt.localeCompare(right.addedAt) || left.title.localeCompare(right.title);
    });
  }, [papers, referenceOrder]);

  const stats = useMemo(
    () => ({
      total: papers.length,
      unread: papers.filter((paper) => paper.status === "未読").length,
      reading: papers.filter((paper) => paper.status === "読書中").length,
      inbox: papers.filter((paper) => paper.pdfPath.startsWith("Inbox/") || (paper.pdfPath.startsWith("Papers/") && paper.pdfPath.split("/").length === 2)).length,
    }),
    [papers],
  );

  async function loadLibrary(libraryRoot = root, notify = true, foreground = true): Promise<boolean> {
    if (!isTauri || !libraryRoot) return false;
    if (foreground) {
      window.clearTimeout(libraryRefreshTimer.current);
      libraryRefreshTimer.current = 0;
    }
    const activeLoad = libraryLoadInFlight.current;
    if (activeLoad) {
      if (activeLoad.root !== libraryRoot) {
        if (foreground) setBusy(true);
        await activeLoad.operation;
        return loadLibrary(libraryRoot, notify, foreground);
      }
      if (!foreground) return activeLoad.operation;
      setBusy(true);
      try {
        return await activeLoad.operation;
      } finally {
        setBusy(false);
      }
    }
    if (foreground) setBusy(true);
    const operation = (async () => {
      try {
        await invoke("initialize_library", { root: libraryRoot });
        const [loaded, loadedCollections, vaultConnected, loadedTrash] = await Promise.all([
          invoke<Paper[]>("scan_library", { root: libraryRoot }),
          invoke<string[]>("list_collections", { root: libraryRoot }),
          invoke<boolean>("obsidian_vault_status", { root: libraryRoot }),
          invoke<TrashEntry[]>("list_trashed_papers", { root: libraryRoot }),
        ]);
        setPapers(loaded);
        setCollections(loadedCollections);
        setObsidianConnected(vaultConnected);
        setTrashEntries(loadedTrash);
        if (selectedId && !loaded.some((paper) => paper.id === selectedId)) setSelectedId(null);
        setSelectedIds((current) => new Set(Array.from(current).filter((id) => loaded.some((paper) => paper.id === id))));
        if (notify) setToast(`${loaded.length}件の文献を読み込みました`);
        return true;
      } catch (error) {
        setToast(String(error));
        return false;
      } finally {
        setReady(true);
        if (foreground) setBusy(false);
      }
    })();
    libraryLoadInFlight.current = { root: libraryRoot, operation };
    try {
      return await operation;
    } finally {
      if (libraryLoadInFlight.current?.operation === operation) libraryLoadInFlight.current = null;
    }
  }

  async function chooseLibrary() {
    if (!isTauri) {
      setToast("MacアプリではFinderからフォルダを選べます");
      return;
    }
    try {
      await flushPendingEdits();
      const selectedFolder = await invoke<string | null>("choose_library_root");
      if (!selectedFolder) return;
      localStorage.setItem("rill-library-root", selectedFolder);
      setRoot(selectedFolder);
      await loadLibrary(selectedFolder);
    } catch (error) {
      setToast(String(error));
    }
  }

  async function importPdfs() {
    if (!isTauri) {
      setToast("MacアプリではPDFをFinderから追加できます");
      return;
    }
    const selectedFiles = await open({
      multiple: true,
      directory: false,
      title: "Rillへ追加するPDFを選択",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selectedFiles) return;
    const sourcePaths = Array.isArray(selectedFiles) ? selectedFiles : [selectedFiles];
    await importPdfPaths(sourcePaths);
  }

  async function importCitationStyle() {
    if (!isTauri) { setToast("Macアプリでは.cslファイルを追加できます"); return; }
    try {
      const style = await invoke<CslStyleFile | null>("read_csl_style");
      if (!style) return;
      customCslStyleMap.set(style.name, style.xml);
      const next = [...customCitationStyles.filter((item) => item.name !== style.name), style];
      setCustomCitationStyles(next); localStorage.setItem("rill-csl-styles", JSON.stringify(next)); setCitationStyle(`custom:${style.name}`); setToast(`${style.name}を引用スタイルへ追加しました`);
    } catch (error) { setToast(String(error)); }
  }

  async function importPdfPaths(sourcePaths: string[]) {
    const pdfPaths = sourcePaths.filter((path) => path.toLocaleLowerCase().endsWith(".pdf"));
    if (pdfPaths.length === 0) {
      setToast("PDFファイルだけを追加できます");
      return;
    }
    setBusy(true);
    try {
      const result = await invoke<ImportResult>("import_pdfs", { root, sourcePaths: pdfPaths });
      await loadLibrary(root, false);
      if (result.imported === 0 && result.skippedDuplicates > 0) {
        setToast(result.skippedDuplicates === 1 ? "このPDFはすでにライブラリにあります" : `${result.skippedDuplicates}件はすでにライブラリにあります`);
      } else {
        const duplicate = result.skippedDuplicates ? `・追加済み${result.skippedDuplicates}件をスキップ` : "";
        setToast(`${result.imported}件を未整理へ追加しました${duplicate}`);
      }
      setView("library");
    } catch (error) {
      // The backend validates a batch before copying, but a filesystem error can
      // still occur after an earlier file was committed. Reconcile the UI with
      // the library on disk instead of leaving a successfully imported PDF hidden.
      await loadLibrary(root, false);
      setToast(String(error));
    } finally {
      setBusy(false);
    }
  }

  function enqueueDraftSave(snapshot: Paper, revision: number) {
    const queued = queuedSaveByPaper.current.get(snapshot.id);
    if (queued && queued.revision >= revision) return queued.operation;
    const operation = draftSaveQueue.current.then(async () => {
      try {
        const saved = isTauri
          ? await invoke<Paper>("save_paper", { root, paper: snapshot })
          : snapshot;
        const failed = failedDraftSaves.current.get(saved.id);
        if (!failed || failed.revision <= revision) failedDraftSaves.current.delete(saved.id);
        if ((latestRevisionByPaper.current.get(saved.id) ?? revision) !== revision) return;
        setPapers((current) => current.map((paper) => (paper.id === saved.id ? saved : paper)));
        if (draftRef.current?.id === saved.id) {
          draftDirty.current = false;
          draftRef.current = saved;
          setDraft(saved);
          setSaveState("保存済み");
        }
      } catch (error) {
        const isLatest = (latestRevisionByPaper.current.get(snapshot.id) ?? revision) === revision;
        if (isLatest) {
          failedDraftSaves.current.set(snapshot.id, { snapshot, revision, error });
          setPapers((current) => current.map((paper) => paper.id === snapshot.id ? snapshot : paper));
          setToast(`${snapshot.title || "文献"}の変更を保存できませんでした: ${String(error)}`);
        }
        if (draftRef.current?.id === snapshot.id && isLatest) {
          draftDirty.current = true;
          setSaveState("保存エラー");
        }
        throw error;
      } finally {
        if (queuedSaveByPaper.current.get(snapshot.id)?.revision === revision) {
          queuedSaveByPaper.current.delete(snapshot.id);
        }
      }
    });
    queuedSaveByPaper.current.set(snapshot.id, { revision, operation });
    draftSaveQueue.current = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function flushPendingEdits() {
    window.clearTimeout(autoSaveTimer.current);
    const currentDraft = draftRef.current;
    if (currentDraft && draftDirty.current) {
      const revision = latestRevisionByPaper.current.get(currentDraft.id) ?? draftRevision.current;
      await enqueueDraftSave(currentDraft, revision);
    }
    await draftSaveQueue.current;
    const retries = Array.from(failedDraftSaves.current.values());
    for (const failed of retries) {
      await enqueueDraftSave(failed.snapshot, failed.revision);
    }
    await draftSaveQueue.current;
    await readerFlush.current?.();
    const remaining = failedDraftSaves.current.values().next().value as { error: unknown } | undefined;
    if (remaining) throw remaining.error;
  }

  async function requestAppQuit() {
    if (!isTauri || closingAfterFlush.current) return;
    closingAfterFlush.current = true;
    window.clearTimeout(autoSaveTimer.current);
    setSaveState("終了前に保存中…");
    try {
      await flushPendingEdits();
      await invoke("exit_after_flush");
    } catch (error) {
      closingAfterFlush.current = false;
      setSaveState("保存エラー");
      setToast(`保存が完了していないため終了を中止しました: ${String(error)}`);
    }
  }

  async function saveDraft() {
    if (!draft) return;
    setBusy(true);
    try {
      const revision = latestRevisionByPaper.current.get(draft.id) ?? draftRevision.current;
      await enqueueDraftSave(draft, revision);
      setToast(isTauri ? "Markdownへ保存しました" : "Markdownへ保存しました（プレビュー）");
    } catch (error) {
      setToast(String(error));
    } finally {
      setBusy(false);
    }
  }

  function reservePaperRevision(paperId: string) {
    draftRevision.current += 1;
    latestRevisionByPaper.current.set(paperId, draftRevision.current);
    return draftRevision.current;
  }

  function currentPaperSnapshot(paper: Paper) {
    const current = draftRef.current?.id === paper.id
      ? draftRef.current
      : papersRef.current.find((item) => item.id === paper.id) ?? paper;
    return { ...current, authors: [...current.authors], tags: [...current.tags] };
  }

  async function persistPaperMutation(
    paper: Paper,
    mutate: (current: Paper) => Paper,
    successMessage?: string,
  ) {
    const updated = mutate(currentPaperSnapshot(paper));
    const revision = reservePaperRevision(updated.id);
    const optimisticPapers = papersRef.current.map((item) => item.id === updated.id ? updated : item);
    papersRef.current = optimisticPapers;
    setPapers(optimisticPapers);
    if (draftRef.current?.id === updated.id) {
      draftDirty.current = true;
      draftRef.current = updated;
      setDraft(updated);
      setSaveState("保存中…");
    }
    window.clearTimeout(autoSaveTimer.current);
    try {
      await enqueueDraftSave(updated, revision);
      if (successMessage) setToast(isTauri ? successMessage : `${successMessage}（プレビュー）`);
      return true;
    } catch {
      return false;
    }
  }

  function updateDraft(paper: Paper) {
    reservePaperRevision(paper.id);
    draftDirty.current = true;
    draftRef.current = paper;
    setDraft(paper);
  }

  function retirePaperSaveState(paperIds: Iterable<string>) {
    for (const paperId of paperIds) {
      queuedSaveByPaper.current.delete(paperId);
      failedDraftSaves.current.delete(paperId);
      latestRevisionByPaper.current.delete(paperId);
    }
  }

  function applyMovedPapers(moved: Paper[]) {
    const movedById = new Map(moved.map((paper) => [paper.id, paper]));
    const nextPapers = papersRef.current.map((paper) => movedById.get(paper.id) ?? paper);
    papersRef.current = nextPapers;
    setPapers(nextPapers);
    const currentDraft = draftRef.current;
    const movedDraft = currentDraft ? movedById.get(currentDraft.id) : undefined;
    if (movedDraft) {
      draftDirty.current = false;
      draftRef.current = movedDraft;
      setDraft(movedDraft);
      setSaveState("保存済み");
    }
    retirePaperSaveState(movedById.keys());
  }

  function retireRemovedPapers(paperIds: Iterable<string>) {
    const removedIds = new Set(paperIds);
    retirePaperSaveState(removedIds);
    if (draftRef.current && removedIds.has(draftRef.current.id)) {
      window.clearTimeout(autoSaveTimer.current);
      draftDirty.current = false;
      draftRef.current = null;
      setDraft(null);
      setSaveState("保存済み");
    }
  }

  async function enrichDraftMetadata() {
    if (!draft) return;
    if (!isTauri) {
      setToast("MacアプリではCrossref・PubMedから取得します");
      return;
    }
    const requestedPaper = { ...draft, authors: [...draft.authors], tags: [...draft.tags] };
    const requestedRevision = latestRevisionByPaper.current.get(requestedPaper.id) ?? draftRevision.current;
    setBusy(true);
    try {
      const enriched = await invoke<Paper>("enrich_metadata", { root, paper: requestedPaper });
      const currentRevision = latestRevisionByPaper.current.get(requestedPaper.id) ?? requestedRevision;
      if (currentRevision !== requestedRevision || draftRef.current?.id !== requestedPaper.id) {
        setToast("取得中に行った編集を優先し、書誌情報は反映しませんでした");
        return;
      }
      updateDraft(enriched);
      const enrichedRevision = latestRevisionByPaper.current.get(enriched.id) ?? draftRevision.current;
      await enqueueDraftSave(enriched, enrichedRevision);
      setToast("書誌情報を取得しました");
    } catch (error) {
      setToast(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function translateDraftSummary() {
    if (!draft?.summary.trim()) { setToast("先に要約を入力するか、書誌取得でAbstractを取り込んでください"); return; }
    if (!isTauri) { updateDraft({ ...draft, translatedSummary: "Appleの翻訳機能はMacアプリで実行されます。" }); return; }
    setBusy(true);
    try {
      const translatedSummary = await invoke<string>("translate_summary", { text: draft.summary });
      updateDraft({ ...draft, translatedSummary }); setToast("英語から日本語へ翻訳しました");
    } catch (error) { setToast(String(error)); }
    finally { setBusy(false); }
  }

  async function trashDraft() {
    if (!draft) return;
    const paperId = draft.id;
    if (!window.confirm(`「${draft.title}」をRillのゴミ箱へ移動しますか？\n後から元の場所へ復元できます。`)) return;
    setBusy(true);
    let trashStarted = false;
    try {
      await flushPendingEdits();
      const target = papersRef.current.find((paper) => paper.id === paperId);
      if (!target) return;
      const snapshot = currentPaperSnapshot(target);
      trashStarted = isTauri;
      const entry = isTauri
        ? await invoke<TrashEntry>("move_paper_to_rill_trash", { root, paper: snapshot })
        : { paper: snapshot, deletedAt: new Date().toISOString() };
      const nextPapers = papersRef.current.filter((paper) => paper.id !== paperId);
      papersRef.current = nextPapers;
      setPapers(nextPapers);
      setTrashEntries((current) => [entry, ...current.filter((item) => item.paper.id !== entry.paper.id)]);
      retireRemovedPapers([paperId]);
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(paperId);
        return next;
      });
      setSelectedId(null);
      setToast(isTauri ? "Rillのゴミ箱へ移動しました" : "Rillのゴミ箱へ移動しました（プレビュー）");
    } catch (error) {
      setToast(trashStarted ? String(error) : `変更を保存できないため、ゴミ箱への移動を中止しました: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function exportReferences(exportPapers = referencePapers) {
    if (!isTauri) {
      setToast(`${citationStyle}形式のMarkdownとBibTeXを書き出します`);
      return;
    }
    setBusy(true);
    try {
      const formattedReferences = exportPapers.map((paper, index) => formatReference(paper, index + 1, citationStyle, activeCitationOptions));
      await invoke("export_library", { root, papers: exportPapers, style: citationStyle, formattedReferences });
      setToast(`${exportPapers.length}件をExportsへ書き出しました`);
    } catch (error) {
      setToast(String(error));
    } finally {
      setBusy(false);
    }
  }

  function openCreateFolder(parent = "", movePaperIds: string[] = []) {
    setFolderMenu(null);
    setPaperMenu(null);
    setFolderDialog({ parent, name: "", movePaperIds });
  }

  function openRenameFolder(collection: string) {
    setFolderMenu(null);
    setRenameFolderDialog({
      collection,
      name: collection.split("/").at(-1) ?? collection,
    });
  }

  function remapCollectionPath(path: string, source: string, destination: string) {
    if (path === source) return destination;
    if (path.startsWith(`${source}/`)) return `${destination}${path.slice(source.length)}`;
    return path;
  }

  function applyCollectionPathRemap(source: string, destination: string) {
    setCollections((current) => current
      .map((item) => remapCollectionPath(item, source, destination))
      .sort((left, right) => left.localeCompare(right, "ja")));
    setPapers((current) => current.map((paper) => ({
      ...paper,
      pdfPath: paper.pdfPath.startsWith(`Papers/${source}/`)
        ? `Papers/${destination}/${paper.pdfPath.slice(`Papers/${source}/`.length)}`
        : paper.pdfPath,
    })));
    setFolderFilter((current) => remapCollectionPath(current, source, destination));
    setBulkDestination((current) => remapCollectionPath(current, source, destination));
  }

  async function applyCollectionMove(collection: string, destinationParent: string): Promise<boolean> {
    if (collectionMutationInFlight.current) {
      setToast("別のフォルダ操作が完了するまでお待ちください");
      return false;
    }
    if (
      destinationParent === collection
      || destinationParent.startsWith(`${collection}/`)
    ) {
      setToast("フォルダを自分自身の中へ移動することはできません");
      return false;
    }
    const name = collection.split("/").at(-1) ?? collection;
    const destination = destinationParent ? `${destinationParent}/${name}` : name;
    if (destination === collection) return false;

    if (!isTauri) {
      applyCollectionPathRemap(collection, destination);
      setToast(`「${collection}」を「${destinationParent || "Papers直下"}」へ移動しました（プレビュー）`);
      return true;
    }

    collectionMutationInFlight.current = true;
    setBusy(true);
    try {
      await flushPendingEdits();
      const moved = await invoke<string>("move_collection", {
        root,
        collection,
        parent: destinationParent,
      });
      applyCollectionPathRemap(collection, moved);
      if (!await loadLibrary(root, false)) {
        setToast("フォルダは移動しましたが、一覧を再読込できませんでした。↻で再読込してください");
        return true;
      }
      setToast(`「${collection}」を「${destinationParent || "Papers直下"}」へ移動しました`);
      return true;
    } catch (error) {
      setToast(String(error));
      return false;
    } finally {
      collectionMutationInFlight.current = false;
      setBusy(false);
    }
  }

  async function renameLibraryFolder(collection: string, name: string) {
    if (collectionMutationInFlight.current) {
      setToast("別のフォルダ操作が完了するまでお待ちください");
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) return;
    const parent = collection.includes("/") ? collection.slice(0, collection.lastIndexOf("/")) : "";
    const expected = parent ? `${parent}/${trimmed}` : trimmed;
    if (expected === collection) {
      setRenameFolderDialog(null);
      return;
    }

    if (!isTauri) {
      applyCollectionPathRemap(collection, expected);
      setRenameFolderDialog(null);
      setToast(`「${collection}」を「${expected}」へ変更しました（プレビュー）`);
      return;
    }

    collectionMutationInFlight.current = true;
    setBusy(true);
    try {
      await flushPendingEdits();
      const renamed = await invoke<string>("rename_collection", {
        root,
        collection,
        name: trimmed,
      });
      applyCollectionPathRemap(collection, renamed);
      setRenameFolderDialog(null);
      if (!await loadLibrary(root, false)) {
        setToast("フォルダ名は変更しましたが、一覧を再読込できませんでした。↻で再読込してください");
        return;
      }
      setToast(`フォルダ名を「${trimmed}」へ変更しました`);
    } catch (error) {
      setToast(String(error));
    } finally {
      collectionMutationInFlight.current = false;
      setBusy(false);
    }
  }

  async function createLibraryFolder(parent: string, name: string, movePaperIds: string[] = []) {
    if (!name.trim()) return;
    if (!isTauri) {
      const created = parent ? `${parent}/${name.trim()}` : name.trim();
      setCollections((current) => Array.from(new Set([...current, created])).sort());
      setFolderFilter(created);
      setFolderDialog(null);
      if (movePaperIds.length > 0) await movePapersToFolder(movePaperIds, created);
      return;
    }
    try {
      const created = await invoke<string>("create_collection", { root, parent, name: name.trim() });
      const loadedCollections = await invoke<string[]>("list_collections", { root });
      setCollections(loadedCollections);
      setFolderFilter(created);
      setFolderDialog(null);
      if (movePaperIds.length > 0) await movePapersToFolder(movePaperIds, created);
      else setToast(`「${created}」を作成しました`);
    } catch (error) {
      setToast(String(error));
    }
  }

  async function deleteLibraryFolder(collection: string) {
    if (!isTauri) {
      setCollections((current) => current.filter((item) => item !== collection));
      setDeleteFolderTarget(null);
      setFolderFilter("");
      return;
    }
    try {
      await invoke("delete_collection", { root, collection });
      const loadedCollections = await invoke<string[]>("list_collections", { root });
      setCollections(loadedCollections);
      setDeleteFolderTarget(null);
      if (folderFilter === collection) setFolderFilter("");
      setToast(`「${collection}」を削除しました`);
    } catch (error) {
      setDeleteFolderTarget(null);
      setToast(String(error));
    }
  }

  async function movePapersToFolder(paperIds: string[], collection: string): Promise<boolean> {
    const requestedIds = new Set(paperIds);
    if (!papersRef.current.some((paper) => requestedIds.has(paper.id))) return false;
    const backendCollection = collection === "__unfiled" ? "__inbox" : collection;
    setBusy(true);
    let moveStarted = false;
    try {
      await flushPendingEdits();
      const targets = papersRef.current
        .filter((paper) => requestedIds.has(paper.id))
        .map(currentPaperSnapshot);
      if (targets.length === 0) return false;
      let moved: Paper[];
      if (isTauri) {
        moveStarted = true;
        moved = [];
        for (const paper of targets) {
          moved.push(await invoke<Paper>("move_paper_to_collection", { root, paper, collection: backendCollection }));
        }
      } else {
        moved = targets.map((paper) => {
          const filename = paper.pdfPath.split("/").at(-1) ?? "paper.pdf";
          const destination = backendCollection === "__inbox" ? `Inbox/${filename}` : backendCollection ? `Papers/${backendCollection}/${filename}` : `Papers/${filename}`;
          return { ...paper, pdfPath: destination };
        });
      }
      applyMovedPapers(moved);
      const destination = collection === "__unfiled" ? "未整理" : collection || "Papers";
      const suffix = isTauri ? "" : "（プレビュー）";
      setToast(`${targets.length}件を「${destination}」へ移動しました${suffix}`);
      return true;
    } catch (error) {
      // Moving several papers is not transactional. If a later move fails, an
      // earlier one may already be on disk, so reload before reporting failure.
      if (moveStarted) await loadLibrary(root, false);
      setToast(moveStarted ? String(error) : `変更を保存できないため、文献の移動を中止しました: ${String(error)}`);
      return false;
    } finally {
      setBusy(false);
      setDraggingPaperIds([]);
      setFolderDropTarget(null);
      setDragPreview(null);
    }
  }

  function clearPaperSelection() {
    setSelectedIds(new Set());
    setSelectedId(null);
    setBulkDestination("");
    lastSelectedId.current = null;
  }

  async function moveSelectedPapers() {
    if (!bulkDestination || selectedIds.size === 0) return;
    const collection = bulkDestination === "__papers_root" ? "" : bulkDestination;
    if (await movePapersToFolder(Array.from(selectedIds), collection)) clearPaperSelection();
  }

  async function enrichSelectedPapers(paperIds = Array.from(selectedIds)) {
    const targets = papersRef.current
      .filter((paper) => paperIds.includes(paper.id))
      .map(currentPaperSnapshot);
    setPaperMenu(null);
    if (targets.length === 0) return;
    if (!isTauri) {
      setToast(`${targets.length}件の書誌情報をCrossref・PubMedから取得します（プレビュー）`);
      return;
    }
    setBusy(true);
    let failedCount = 0;
    let skippedEditedCount = 0;
    for (const [index, paper] of targets.entries()) {
      setToast(`書誌情報を取得中… ${index + 1}/${targets.length}`);
      try {
        const requestedPaper = currentPaperSnapshot(paper);
        const requestedRevision = latestRevisionByPaper.current.get(paper.id) ?? 0;
        const enriched = await invoke<Paper>("enrich_metadata", { root, paper: requestedPaper });
        const currentRevision = latestRevisionByPaper.current.get(paper.id) ?? 0;
        if (currentRevision !== requestedRevision) {
          skippedEditedCount += 1;
          continue;
        }
        if (!await persistPaperMutation(requestedPaper, () => enriched)) {
          failedCount += 1;
        }
      } catch {
        failedCount += 1;
      }
    }
    setBusy(false);
    const savedCount = targets.length - failedCount - skippedEditedCount;
    if (skippedEditedCount > 0) {
      setToast(`${savedCount}件を取得。編集中の${skippedEditedCount}件は変更を優先し、反映しませんでした`);
    } else if (failedCount === 0) {
      setToast(`${savedCount}件の書誌情報を取得しました`);
    } else {
      setToast(`${savedCount}件を取得、${failedCount}件は取得または保存できませんでした`);
    }
  }

  async function markSelectedPapersAsRead(paperIds = Array.from(selectedIds)) {
    const targets = papersRef.current
      .filter((paper) => paperIds.includes(paper.id) && paper.status !== "読了")
      .map(currentPaperSnapshot);
    if (targets.length === 0) {
      setToast("選択した文献はすべて読了です");
      return;
    }
    setBusy(true);
    let failedCount = 0;
    for (const paper of targets) {
      if (!await persistPaperMutation(paper, (current) => ({ ...current, status: "読了" }))) {
        failedCount += 1;
      }
    }
    setBusy(false);
    const suffix = isTauri ? "" : "（プレビュー）";
    if (failedCount === 0) setToast(`${targets.length}件を読了にしました${suffix}`);
    else setToast(`${targets.length}件を読了に変更、${failedCount}件は保存待ちです`);
  }

  async function addSelectedPapersToReferences(paperIds = Array.from(selectedIds)) {
    const paperById = new Map(papersRef.current.map((paper) => [paper.id, paper]));
    const targets = paperIds
      .map((paperId) => paperById.get(paperId))
      .filter((paper): paper is Paper => Boolean(paper && !paper.isReference))
      .map(currentPaperSnapshot);
    if (targets.length === 0) {
      setToast("選択した文献はすべて参考文献に追加済みです");
      return;
    }

    setReferenceOrder((current) => {
      const existingReferenceIds = papersRef.current.filter((paper) => paper.isReference).map((paper) => paper.id);
      const known = [...current.filter((id) => existingReferenceIds.includes(id)), ...existingReferenceIds.filter((id) => !current.includes(id))];
      const next = [...known, ...targets.map((paper) => paper.id).filter((id) => !known.includes(id))];
      localStorage.setItem(referenceOrderStorageKey(root), JSON.stringify(next));
      return next;
    });
    setBusy(true);
    let failedCount = 0;
    for (const paper of targets) {
      if (!await persistPaperMutation(paper, (current) => ({ ...current, isReference: true }))) {
        failedCount += 1;
      }
    }
    setBusy(false);
    const suffix = isTauri ? "" : "（プレビュー）";
    if (failedCount === 0) setToast(`${targets.length}件を参考文献に追加しました${suffix}`);
    else setToast(`${targets.length}件を参考文献に追加、${failedCount}件は保存待ちです`);
  }

  async function trashSelectedPapers(paperIds = Array.from(selectedIds)) {
    setPaperMenu(null);
    const requestedIds = new Set(paperIds);
    const initialTargets = papersRef.current.filter((paper) => requestedIds.has(paper.id));
    if (initialTargets.length === 0) return;
    const message = initialTargets.length === 1
      ? `「${initialTargets[0].title}」をRillのゴミ箱へ移動しますか？\n後から元の場所へ復元できます。`
      : `選択した${initialTargets.length}件をRillのゴミ箱へ移動しますか？\n後から元の場所へ復元できます。`;
    if (!window.confirm(message)) return;
    setBusy(true);
    const removedIds = new Set<string>();
    const movedEntries: TrashEntry[] = [];
    const failed: string[] = [];
    try {
      await flushPendingEdits();
      const targets = papersRef.current
        .filter((paper) => requestedIds.has(paper.id))
        .map(currentPaperSnapshot);
      if (!isTauri) {
        for (const paper of targets) {
          removedIds.add(paper.id);
          movedEntries.push({ paper, deletedAt: new Date().toISOString() });
        }
      } else {
        for (const paper of targets) {
          try {
            const entry = await invoke<TrashEntry>("move_paper_to_rill_trash", { root, paper });
            removedIds.add(paper.id);
            movedEntries.push(entry);
          } catch (error) {
            failed.push(`${paper.title}: ${String(error)}`);
          }
        }
      }
      const nextPapers = papersRef.current.filter((paper) => !removedIds.has(paper.id));
      papersRef.current = nextPapers;
      setPapers(nextPapers);
      setTrashEntries((current) => [
        ...movedEntries,
        ...current.filter((entry) => !removedIds.has(entry.paper.id)),
      ]);
      retireRemovedPapers(removedIds);
      if (failed.length === 0) {
        clearPaperSelection();
        const suffix = isTauri ? "" : "（プレビュー）";
        setToast(`${removedIds.size}件をRillのゴミ箱へ移動しました${suffix}`);
      } else {
        setSelectedIds(new Set(targets.filter((paper) => !removedIds.has(paper.id)).map((paper) => paper.id)));
        if (selectedId && removedIds.has(selectedId)) setSelectedId(null);
        setToast(`${removedIds.size}件をゴミ箱へ移動、${failed.length}件は移動できませんでした`);
      }
    } catch (error) {
      setToast(`変更を保存できないため、ゴミ箱への移動を中止しました: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function restoreTrashEntry(entry: TrashEntry) {
    if (!isTauri) {
      setTrashEntries((current) => current.filter((item) => item.paper.id !== entry.paper.id));
      setPapers((current) => [entry.paper, ...current]);
      setToast("文献を元の場所へ復元しました（プレビュー）");
      return;
    }
    setBusy(true);
    try {
      await invoke<Paper>("restore_trashed_paper", { root, paperId: entry.paper.id });
      await loadLibrary(root, false);
      setToast("文献を元の場所へ復元しました");
    } catch (error) {
      setToast(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function permanentlyDeleteTrashEntry(entry: TrashEntry) {
    if (!window.confirm(`「${entry.paper.title}」を完全に削除しますか？\nPDF・Markdown・注釈は復元できなくなります。`)) return;
    if (!isTauri) {
      setTrashEntries((current) => current.filter((item) => item.paper.id !== entry.paper.id));
      setToast("文献を完全に削除しました（プレビュー）");
      return;
    }
    setBusy(true);
    try {
      await invoke("delete_trashed_paper_permanently", { root, paperId: entry.paper.id });
      setTrashEntries((current) => current.filter((item) => item.paper.id !== entry.paper.id));
      setToast("文献を完全に削除しました");
    } catch (error) {
      setToast(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function openRillTrashFolder() {
    if (!isTauri) {
      setToast("MacアプリではFinderでTrashフォルダを開けます");
      return;
    }
    try {
      await invoke("open_rill_trash_folder", { root });
    } catch (error) {
      setToast(String(error));
    }
  }

  function moveDraftToFolder(collection: string) {
    if (draft) void movePapersToFolder([draft.id], collection);
  }

  function selectPaper(event: ReactMouseEvent<HTMLElement>, paper: Paper) {
    if (suppressRowClick.current) {
      suppressRowClick.current = false;
      return;
    }
    const additive = event.metaKey || event.ctrlKey;
    if (!additive && !event.shiftKey && selectedId === paper.id) {
      setSelectedId(null);
      return;
    }
    if (event.shiftKey && lastSelectedId.current) {
      const anchor = filteredPapers.findIndex((item) => item.id === lastSelectedId.current);
      const current = filteredPapers.findIndex((item) => item.id === paper.id);
      if (anchor >= 0 && current >= 0) {
        const range = filteredPapers.slice(Math.min(anchor, current), Math.max(anchor, current) + 1).map((item) => item.id);
        setSelectedIds(additive ? new Set([...selectedIds, ...range]) : new Set(range));
      }
    } else if (additive) {
      const next = new Set(selectedIds);
      if (next.has(paper.id)) next.delete(paper.id); else next.add(paper.id);
      setSelectedIds(next);
    } else {
      setSelectedIds(new Set([paper.id]));
    }
    setSelectedId(paper.id);
    lastSelectedId.current = paper.id;
  }

  function togglePaperSelection(paper: Paper) {
    const next = new Set(selectedIds);
    if (next.has(paper.id)) next.delete(paper.id); else next.add(paper.id);
    setSelectedIds(next);
    setSelectedId(paper.id);
    lastSelectedId.current = paper.id;
  }

  function beginPaperDrag(event: ReactPointerEvent<HTMLElement>, paper: Paper) {
    if (event.button !== 0 || (event.target as Element).closest("input, button, select, a")) return;
    window.getSelection()?.removeAllRanges();
    const preventTextSelection = (selectionEvent: Event) => selectionEvent.preventDefault();
    document.addEventListener("selectstart", preventTextSelection);
    document.body.classList.add("paper-drag-active");
    const paperIds = selectedIds.has(paper.id) ? Array.from(selectedIds) : [paper.id];
    pointerDrag.current = { paperId: paper.id, paperIds, startX: event.clientX, startY: event.clientY, active: false };

    const cleanup = () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      document.removeEventListener("selectstart", preventTextSelection);
      document.body.classList.remove("paper-drag-active");
      window.getSelection()?.removeAllRanges();
    };
    const track = (moveEvent: PointerEvent) => {
      const drag = pointerDrag.current;
      if (!drag) return;
      if (!drag.active && Math.hypot(moveEvent.clientX - drag.startX, moveEvent.clientY - drag.startY) > 7) {
        moveEvent.preventDefault();
        drag.active = true;
        setDraggingPaperIds(drag.paperIds);
      }
      if (!drag.active) return;
      moveEvent.preventDefault();
      setDragPreview({ x: moveEvent.clientX, y: moveEvent.clientY, title: paper.title, count: drag.paperIds.length });
      const folder = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>("[data-folder-target]");
      setFolderDropTarget(folder?.getAttribute("data-folder-target") ?? null);
    };
    const finish = (upEvent: PointerEvent) => {
      cleanup();
      const drag = pointerDrag.current;
      pointerDrag.current = null;
      if (!drag?.active) return;
      const folder = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest<HTMLElement>("[data-folder-target]");
      const destination = folder?.getAttribute("data-folder-target");
      suppressRowClick.current = true;
      if (destination !== null && destination !== undefined) void movePapersToFolder(drag.paperIds, destination);
      else {
        setDraggingPaperIds([]);
        setFolderDropTarget(null);
        setDragPreview(null);
      }
    };
    const cancel = () => {
      cleanup();
      pointerDrag.current = null;
      setDraggingPaperIds([]);
      setFolderDropTarget(null);
      setDragPreview(null);
    };
    window.addEventListener("pointermove", track);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }

  function beginFolderDrag(event: ReactPointerEvent<HTMLButtonElement>, collection: string) {
    if (
      event.button !== 0
      || event.ctrlKey
      || event.metaKey
      || busy
      || collectionMutationInFlight.current
      || folderPointerDrag.current
    ) return;
    const currentParent = collection.includes("/")
      ? collection.slice(0, collection.lastIndexOf("/"))
      : "";
    folderPointerDrag.current = {
      collection,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };

    const preventTextSelection = (selectionEvent: Event) => selectionEvent.preventDefault();
    const cleanup = () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      document.removeEventListener("selectstart", preventTextSelection);
      document.body.classList.remove("folder-drag-active");
      window.getSelection()?.removeAllRanges();
    };
    const validTargetAt = (x: number, y: number) => {
      const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-folder-reparent-target]");
      const parent = target?.getAttribute("data-folder-reparent-target");
      if (parent === null || parent === undefined) return null;
      if (parent === collection || parent.startsWith(`${collection}/`)) return null;
      if (parent === currentParent) return null;
      return parent;
    };
    const track = (moveEvent: PointerEvent) => {
      const drag = folderPointerDrag.current;
      if (!drag) return;
      if (!drag.active && Math.hypot(moveEvent.clientX - drag.startX, moveEvent.clientY - drag.startY) > 7) {
        drag.active = true;
        document.addEventListener("selectstart", preventTextSelection);
        document.body.classList.add("folder-drag-active");
        setDraggingCollection(collection);
      }
      if (!drag.active) return;
      moveEvent.preventDefault();
      setFolderDragPreview({ x: moveEvent.clientX, y: moveEvent.clientY, collection });
      setFolderHierarchyDropTarget(validTargetAt(moveEvent.clientX, moveEvent.clientY));
    };
    const finish = (upEvent: PointerEvent) => {
      const drag = folderPointerDrag.current;
      const destinationParent = drag?.active ? validTargetAt(upEvent.clientX, upEvent.clientY) : null;
      cleanup();
      folderPointerDrag.current = null;
      if (!drag?.active) return;
      suppressFolderClickUntil.current = window.performance.now() + 100;
      setDraggingCollection(null);
      setFolderHierarchyDropTarget(null);
      setFolderDragPreview(null);
      if (destinationParent !== null) void applyCollectionMove(collection, destinationParent);
    };
    const cancel = () => {
      cleanup();
      folderPointerDrag.current = null;
      setDraggingCollection(null);
      setFolderHierarchyDropTarget(null);
      setFolderDragPreview(null);
    };
    window.addEventListener("pointermove", track);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }

  async function openPaperViewer(paper: Paper) {
    if (!isTauri) {
      setToast("MacアプリでPDFビューワーを利用できます");
      return;
    }
    try {
      const available = await invoke<boolean>("pdf_file_exists", { root, pdfPath: paper.pdfPath });
      setPdfAvailability((current) => ({ ...current, [paper.id]: available }));
      if (!available) {
        setToast("PDFファイルが見つかりません。保存場所またはファイル名を確認してください");
        return;
      }
      setReaderPaperId(paper.id);
      setView("reader");
      if (currentPaperSnapshot(paper).status === "未読") {
        await persistPaperMutation(paper, (current) => ({ ...current, status: "読書中" }));
      }
    } catch (error) {
      setToast(String(error));
    }
  }

  async function openPaperExternal(paper: Paper) {
    if (!isTauri) return;
    try {
      await invoke("open_pdf_in_preview", { root, pdfPath: paper.pdfPath });
    } catch (error) {
      setToast(String(error));
    }
  }

  async function changeReadingStatus(status: string) {
    if (!draft || draft.status === status) return;
    await persistPaperMutation(draft, (current) => ({ ...current, status }), `${status}に変更しました`);
  }

  async function toggleReference(paper: Paper) {
    const currentPaper = currentPaperSnapshot(paper);
    const isReference = !currentPaper.isReference;
    setReferenceOrder((current) => {
      const existingReferenceIds = papersRef.current.filter((item) => item.isReference && item.id !== paper.id).map((item) => item.id);
      const knownIds = [...current.filter((id) => existingReferenceIds.includes(id)), ...existingReferenceIds.filter((id) => !current.includes(id))];
      const next = isReference ? [...knownIds, paper.id] : current.filter((id) => id !== paper.id);
      localStorage.setItem(referenceOrderStorageKey(root), JSON.stringify(next));
      return next;
    });
    await persistPaperMutation(currentPaper, (current) => ({ ...current, isReference }));
  }

  function moveReference(paper: Paper, direction: "up" | "down") {
    const currentIds = referencePapers.map((item) => item.id);
    const from = currentIds.indexOf(paper.id);
    const to = direction === "up" ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= currentIds.length) return;
    [currentIds[from], currentIds[to]] = [currentIds[to], currentIds[from]];
    setReferenceOrder(currentIds);
    localStorage.setItem(referenceOrderStorageKey(root), JSON.stringify(currentIds));
  }

  function reorderReferences(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const currentIds = referencePapers.map((paper) => paper.id);
    const from = currentIds.indexOf(sourceId);
    const to = currentIds.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const [movedId] = currentIds.splice(from, 1);
    currentIds.splice(to, 0, movedId);
    setReferenceOrder(currentIds);
    localStorage.setItem(referenceOrderStorageKey(root), JSON.stringify(currentIds));
  }

  async function addTagsToReferences(targets: Paper[], tagInput: string): Promise<boolean> {
    const addedTags = parseTags(tagInput);
    if (targets.length === 0 || addedTags.length === 0) return false;
    const currentTargets = targets.map(currentPaperSnapshot);
    setBusy(true);
    let failedCount = 0;
    for (const paper of currentTargets) {
      if (!await persistPaperMutation(paper, (current) => ({
        ...current,
        tags: Array.from(new Set([...current.tags, ...addedTags])),
      }))) {
        failedCount += 1;
      }
    }
    setBusy(false);
    const suffix = isTauri ? "" : "（プレビュー）";
    if (failedCount === 0) setToast(`${currentTargets.length}件に${addedTags.length}個のタグを追加しました${suffix}`);
    else setToast(`${currentTargets.length}件にタグを追加、${failedCount}件は保存待ちです`);
    return true;
  }

  async function removeAllReferences(targets: Paper[]) {
    if (targets.length === 0) return;
    if (!window.confirm(`${targets.length}件を参考文献から外しますか？\nPDFとMarkdownはLibraryに残ります。`)) return;
    const currentTargets = targets.map(currentPaperSnapshot);
    const removedIds = new Set(currentTargets.map((paper) => paper.id));
    setReferenceOrder((current) => {
      const next = current.filter((id) => !removedIds.has(id));
      localStorage.setItem(referenceOrderStorageKey(root), JSON.stringify(next));
      return next;
    });
    setBusy(true);
    let failedCount = 0;
    for (const paper of currentTargets) {
      if (!await persistPaperMutation(paper, (current) => ({ ...current, isReference: false }))) {
        failedCount += 1;
      }
    }
    setBusy(false);
    const suffix = isTauri ? "" : "（プレビュー）";
    if (failedCount === 0) setToast(`${currentTargets.length}件を参考文献から外しました${suffix}`);
    else setToast(`${currentTargets.length}件を参考文献から解除、${failedCount}件は保存待ちです`);
  }

  async function changeFlag(paper: Paper, flagColor: string) {
    if (currentPaperSnapshot(paper).flagColor === flagColor) return;
    await persistPaperMutation(paper, (current) => ({ ...current, flagColor }));
  }

  async function toggleFavorite(paper: Paper) {
    const isFavorite = !currentPaperSnapshot(paper).isFavorite;
    await persistPaperMutation(paper, (current) => ({ ...current, isFavorite }));
  }

  async function openPaperNote(paper: Paper) {
    if (!obsidianConnected) {
      setShowObsidianSetup(true);
      return;
    }
    if (!isTauri) {
      setToast("MacアプリではObsidianの該当ノートが開きます");
      return;
    }
    try {
      await invoke("open_note_in_obsidian", { root, notePath: paper.notePath });
    } catch (error) {
      setToast(String(error));
    }
  }

  async function refreshObsidianStatus() {
    if (!isTauri) {
      setToast("MacアプリでVault接続を確認できます");
      return;
    }
    try {
      const connected = await invoke<boolean>("obsidian_vault_status", { root });
      setObsidianConnected(connected);
      if (connected) {
        setShowObsidianSetup(false);
        setToast("Obsidian Vaultとの接続を確認しました");
      } else {
        setToast("まだVaultとして登録されていません");
      }
    } catch (error) {
      setToast(String(error));
    }
  }

  async function openObsidianApp() {
    if (!isTauri) {
      setToast("MacアプリではObsidianを起動します");
      return;
    }
    try {
      await invoke("open_obsidian_app");
    } catch (error) {
      setToast(String(error));
    }
  }

  async function openLibraryFolder() {
    if (!isTauri) {
      setToast("FinderでRillフォルダを開きます");
      return;
    }
    try {
      await invoke("open_library_folder", { root });
    } catch (error) {
      setToast(String(error));
    }
  }

  function startWindowDrag(event: ReactMouseEvent<HTMLElement>) {
    if (!isTauri || event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest("button, input, textarea, select, a")) return;
    void getCurrentWindow().startDragging().catch((error) => setToast(String(error)));
  }

  if (!ready) {
    return <main className="splash"><RillMark size="regular" /><p>ライブラリを読み込んでいます…</p></main>;
  }

  if (isTauri && !root) {
    return (
      <>
        <main className="onboarding">
          <div className="onboarding-drag" data-tauri-drag-region />
          <section className="onboarding-card">
            <RillMark size="large" />
            <h1>文献を、自分のフォルダへ。</h1>
            <p className="onboarding-copy">はじめに、文献を保存するフォルダを選びます。</p>
            <div className="folder-preview">
              <span>Rill</span><i>/</i><span>Inbox</span><span>Papers</span><span>Notes</span>
            </div>
            <button className="primary-action" type="button" onClick={chooseLibrary}>ライブラリフォルダを選ぶ</button>
          </section>
        </main>
        {showSettings && <SettingsDialog root={root} obsidianConnected={false} onClose={() => setShowSettings(false)} onChooseRoot={() => void chooseLibrary()} onOpenRoot={() => {}} onObsidianSetup={() => setShowObsidianSetup(true)} />}
      </>
    );
  }

  return (
    <main className="app-shell">
      <header className="titlebar" data-tauri-drag-region onMouseDown={startWindowDrag}>
        <div className="brand" data-tauri-drag-region><RillMark /><strong>Rill</strong></div>
        <nav className="view-tabs" aria-label="表示切り替え">
          <button className={view === "overview" ? "active" : ""} onClick={() => setView("overview")}>Overview</button>
          <button className={view === "library" || view === "reader" ? "active" : ""} onClick={() => setView("library")}>Library</button>
          <button className={view === "references" ? "active" : ""} onClick={() => setView("references")}>References{referencePapers.length > 0 && <i>{referencePapers.length}</i>}</button>
        </nav>
        <div className="title-actions">
          {!isTauri && <span className="preview-badge">画面プレビュー</span>}
          <button className="quiet-button" type="button" onClick={() => void loadLibrary()} disabled={busy}>↻</button>
          <button
            className="add-button"
            type="button"
            aria-expanded={showAddDropZone}
            onClick={(event) => { event.stopPropagation(); setShowAddDropZone((open) => !open); }}
            disabled={busy}
          >＋ PDFを追加</button>
        </div>
      </header>

      {showAddDropZone && view !== "reader" && (
        <section
          className={pdfDropTarget === "header" ? "header-pdf-drop-panel drop-active" : "header-pdf-drop-panel"}
          aria-label="PDFを追加"
          onClick={(event) => event.stopPropagation()}
        >
          <span className="drop-pdf-icon">PDF</span>
          <div><strong>ドロップして未整理に追加</strong><small>複数のPDFをまとめて追加できます</small></div>
          <button type="button" onClick={() => { setShowAddDropZone(false); void importPdfs(); }}>ファイルを選ぶ</button>
          {pdfDropTarget === "header" && <div className="drop-confirm-overlay compact" aria-hidden="true"><span>PDF</span><strong>ここにドロップして未整理へ追加</strong></div>}
        </section>
      )}

      {view === "reader" && readerPaper ? (
        <Suspense fallback={<section className="reader-view"><div className="pdf-loading"><span>PDF</span><p>リーダーを準備しています…</p></div></section>}>
          <RillPdfReader
            root={root}
            paper={readerPaper}
            onClose={() => setView("library")}
            onOpenExternal={() => void openPaperExternal(readerPaper)}
            onToast={setToast}
            onRegisterFlush={(flush) => { readerFlush.current = flush; }}
          />
        </Suspense>
      ) : view === "overview" ? (
        <Overview
          papers={papers}
          stats={stats}
          root={root}
          onOpenLibrary={() => setView("library")}
          onSelect={(paper) => { setSelectedId(paper.id); setSelectedIds(new Set([paper.id])); setView("library"); }}
          onChooseRoot={chooseLibrary}
          onOpenRoot={openLibraryFolder}
          onImport={importPdfs}
          dropActive={pdfDropTarget === "overview"}
          obsidianConnected={obsidianConnected}
          onObsidianSetup={() => setShowObsidianSetup(true)}
        />
      ) : view === "references" ? (
        <ReferencesView
          papers={referencePapers}
          style={citationStyle}
          options={activeCitationOptions}
          busy={busy}
          onStyleChange={selectCitationStyle}
          onOptionsChange={updateCitationOptions}
          onExport={() => void exportReferences(referencePapers)}
          onOpenPaper={(paper) => { setSelectedId(paper.id); setSelectedIds(new Set([paper.id])); setView("library"); }}
          onRemove={toggleReference}
          onMoveReference={moveReference}
          onReorderReferences={reorderReferences}
          onRemoveAll={() => void removeAllReferences(referencePapers)}
          onAddTags={(tagInput) => addTagsToReferences(referencePapers, tagInput)}
          onToast={setToast}
          customStyles={customCitationStyles}
          presets={citationPresets}
          onPresetsChange={setCitationPresets}
          onImportStyle={() => void importCitationStyle()}
        />
      ) : (
        <section className="library-view">
          <aside className="filter-sidebar">
            <div className="sidebar-heading-row first">
              <p className="sidebar-heading">フォルダ</p>
              <button type="button" onClick={() => openCreateFolder(folderFilter && !folderFilter.startsWith("__") ? folderFilter : "")} title={folderFilter && !folderFilter.startsWith("__") ? "選択中のフォルダ内に作成" : "新しいフォルダを作成"}>＋</button>
            </div>
            <button
              data-folder-target=""
              data-folder-reparent-target=""
              className={`${folderFilter === "" ? "active " : ""}${folderDropTarget === "" ? "drop-target " : ""}${folderHierarchyDropTarget === "" ? "hierarchy-drop-target " : ""}collection-button`}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setPaperMenu(null);
                setFolderMenu({
                  x: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)),
                  y: Math.max(8, Math.min(event.clientY, window.innerHeight - 110)),
                  collection: "",
                });
              }}
              onClick={(event) => { if (!event.ctrlKey) setFolderFilter(""); }}
            >
              <span>▾</span><b>すべての文献</b><i>{papers.length}</i>
            </button>
            <button data-folder-target="__unfiled" title="まだ専用フォルダへ分類していない文献" className={`${folderFilter === "__unfiled" ? "active " : ""}${folderDropTarget === "__unfiled" ? "drop-target " : ""}collection-button`} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setPaperMenu(null); setFolderMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 110)), collection: "" }); }} onClick={(event) => { if (!event.ctrlKey) setFolderFilter("__unfiled"); }}>
              <span>⌑</span><b>未整理</b><i>{papers.filter((paper) => paper.pdfPath.startsWith("Inbox/") || (paper.pdfPath.startsWith("Papers/") && paper.pdfPath.split("/").length === 2)).length}</i>
            </button>
            {collections.map((collection) => {
              const depth = collection.split("/").length - 1;
              const name = collection.split("/").at(-1) ?? collection;
              const count = papers.filter((paper) => paper.pdfPath.startsWith(`Papers/${collection}/`)).length;
              return (
                <button
                  key={collection}
                  data-folder-target={collection}
                  data-folder-reparent-target={collection}
                  title={`${collection}（右クリックで操作、ドラッグで階層を変更）`}
                  style={{ paddingLeft: `${10 + depth * 14}px` }}
                  className={`${folderFilter === collection ? "active " : ""}${folderDropTarget === collection ? "drop-target " : ""}${folderHierarchyDropTarget === collection ? "hierarchy-drop-target " : ""}${draggingCollection === collection ? "folder-dragging " : ""}collection-button`}
                  onPointerDown={(event) => beginFolderDrag(event, collection)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setPaperMenu(null);
                    setFolderMenu({
                      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)),
                      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 150)),
                      collection,
                    });
                  }}
                  onClick={(event) => {
                    if (event.ctrlKey) return;
                    if (window.performance.now() < suppressFolderClickUntil.current) {
                      suppressFolderClickUntil.current = 0;
                      return;
                    }
                    setFolderFilter(collection);
                  }}
                >
                  <span>⌑</span><b>{name}</b><i>{count}</i>
                </button>
              );
            })}
            <p className="sidebar-heading tags-heading">タグ</p>
            <div className="priority-filters" aria-label="お気に入りとフラッグで絞り込む">
              <button title="お気に入り" className={tagFilter === "__favorite" ? "active favorite" : "favorite"} onClick={() => setTagFilter(tagFilter === "__favorite" ? "" : "__favorite")}><span>★</span><b>({papers.filter((paper) => paper.isFavorite).length})</b></button>
              {(["blue", "yellow", "red"] as const).map((color) => <button key={color} title={`${color} flag`} className={tagFilter === `__flag_${color}` ? `active ${color}` : color} onClick={() => setTagFilter(tagFilter === `__flag_${color}` ? "" : `__flag_${color}`)}><span>⚑</span><b>({papers.filter((paper) => paper.flagColor === color).length})</b></button>)}
            </div>
            <div className="sidebar-tag-list" aria-label="タグ一覧">
              {Array.from(new Set(papers.flatMap((paper) => paper.tags))).map((tag) => (
                <button key={tag} className={tagFilter === tag ? "active" : ""} onClick={() => setTagFilter(tagFilter === tag ? "" : tag)}><span className="tag-dot" />#{tag.replace(/^#+/, "")}</button>
              ))}
            </div>
            <div className="folder-card">
              <span>保存場所</span>
              <strong>{root.split("/").filter(Boolean).at(-1) ?? "Rill"}</strong>
              <small>{root}</small>
              <div className="folder-card-actions"><button onClick={chooseLibrary}>変更</button></div>
            </div>
            <button
              className={folderFilter === "__trash" ? "active trash-sidebar-button" : "trash-sidebar-button"}
              onClick={() => { clearPaperSelection(); setFolderFilter("__trash"); }}
              title="Rillのゴミ箱を開く"
            >
              <span>⌫</span><b>ゴミ箱</b><i>{trashEntries.length}</i>
            </button>
          </aside>

          <section className={["paper-list-panel", pdfDropTarget === "library" ? "drop-active" : "", draft && folderFilter !== "__trash" ? "details-open" : ""].filter(Boolean).join(" ")}>
            {folderFilter === "__trash" ? (
              <TrashWorkspace
                entries={trashEntries}
                busy={busy}
                onRestore={(entry) => void restoreTrashEntry(entry)}
                onDelete={(entry) => void permanentlyDeleteTrashEntry(entry)}
                onOpenFolder={() => void openRillTrashFolder()}
              />
            ) : <>
            {pdfDropTarget === "library" && <div className="pdf-drop-overlay" aria-hidden="true"><span>PDF</span><strong>ここにドロップして未整理へ追加</strong><small>複数のPDFもまとめて読み込めます</small></div>}
            <div className="library-toolbar">
              <div className="library-heading-block">
                <div className="library-heading-line">
                  <div className="library-title"><h1>{folderTitle}</h1><span>{filteredPapers.length} papers</span></div>
                  <div className="status-inline" aria-label="読書状態で絞り込む">
                    {["すべて", "未読", "読書中", "読了"].map((status) => (
                      <button key={status} className={statusFilter === status ? "active" : ""} onClick={() => setStatusFilter(status)}>
                        {status}<i>{status === "すべて" ? folderScopedPapers.length : folderScopedPapers.filter((paper) => paper.status === status).length}</i>
                      </button>
                    ))}
                  </div>
                  {selectedIds.size > 0 && (
                    <div className="selection-heading-actions" aria-label="選択状態の操作">
                      <span>{selectedIds.size}件選択</span>
                      <button className="selection-trash" disabled={busy} title="Rillのゴミ箱へ移動" onClick={() => void trashSelectedPapers()}>ゴミ箱へ移動</button>
                      <button className="selection-clear" disabled={busy} onClick={clearPaperSelection}>選択解除</button>
                    </div>
                  )}
                </div>
              </div>
              {selectedIds.size > 0 && (
                <div className="bulk-actions" aria-label="選択した文献の操作">
                  <label>
                    <span>移動先</span>
                    <select aria-label="選択した文献の移動先" value={bulkDestination} onChange={(event) => setBulkDestination(event.target.value)}>
                      <option value="">フォルダを選択</option>
                      <option value="__unfiled">未整理</option>
                      <option value="__papers_root">Papers直下</option>
                      {collections.map((collection) => <option key={collection} value={collection}>{collection}</option>)}
                    </select>
                  </label>
                  <button className="bulk-move" disabled={!bulkDestination || busy} onClick={moveSelectedPapers}>移動</button>
                  <button className="bulk-enrich" disabled={busy} onClick={() => void enrichSelectedPapers()}>書誌取得（一括）</button>
                  <button className="bulk-read" disabled={busy} title="選択した未読・読書中の文献を読了にする" onClick={() => void markSelectedPapersAsRead()}>一括読了</button>
                  <button className="bulk-reference" disabled={busy || Array.from(selectedIds).every((paperId) => papers.find((paper) => paper.id === paperId)?.isReference)} title="選択した文献をReferencesへ追加" onClick={() => void addSelectedPapersToReferences()}>参考に追加</button>
                </div>
              )}
              <div className="toolbar-controls">
                <label className="toolbar-select"><span>絞り込み</span><select aria-label="文献を絞り込む" value={quickFilter} onChange={(event) => setQuickFilter(event.target.value as QuickFilter)}>
                  {(["すべて", "お気に入り", "参考文献", "フラッグあり", "要約あり", "メモあり"] as QuickFilter[]).map((filter) => <option key={filter}>{filter}</option>)}
                </select></label>
                <label className="toolbar-select"><span>並び替え</span><select aria-label="並べ替え" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                  {(["追加日（新しい順）", "追加日（古い順）", "年（新しい順）", "年（古い順）", "タイトル", "著者", "読書状態", "重要度"] as SortMode[]).map((mode) => <option key={mode}>{mode}</option>)}
                </select></label>
                <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="PDF本文・Markdown・書誌情報を検索" />{searchingFullText && <i>検索中</i>}</label>
              </div>
            </div>
            <div className="list-header"><span /><span>論文</span><span>年</span><span>状態</span><span>重要</span><span>参考</span></div>
            <div className="paper-list" onClick={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}>
              {filteredPapers.map((paper) => (
                <div
                  key={paper.id}
                  role="button"
                  tabIndex={0}
                  className={`${paper.id === selectedId ? "selected " : ""}${selectedIds.has(paper.id) ? "multi-selected " : ""}${draggingPaperIds.includes(paper.id) ? "dragging " : ""}paper-row`}
                  onPointerDown={(event) => beginPaperDrag(event, paper)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const paperIds = selectedIds.has(paper.id) ? Array.from(selectedIds) : [paper.id];
                    if (!selectedIds.has(paper.id)) {
                      setSelectedIds(new Set([paper.id]));
                      setSelectedId(paper.id);
                      lastSelectedId.current = paper.id;
                    }
                    setFolderMenu(null);
                    setPaperMenu({
                      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 430)),
                      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 330)),
                      paperIds,
                    });
                  }}
                  onClick={(event) => selectPaper(event, paper)}
                  onDoubleClick={() => openPaperViewer(paper)}
                  onKeyDown={(event) => { if (event.key === "Enter") { openPaperViewer(paper); } }}
                >
                  <label className="selection-check" title="複数選択" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                    <input type="checkbox" checked={selectedIds.has(paper.id)} onChange={() => togglePaperSelection(paper)} />
                    <span />
                  </label>
                  <div className="paper-main">
                    <strong>{paper.title}</strong>
                    <span>{shortAuthors(paper.authors)}{paper.journal ? ` · ${paper.journal}` : ""}</span>
                    <div className="row-tags">{paper.tags.slice(0, 3).map((tag) => <i key={tag}>#{tag.replace(/^#+/, "")}</i>)}</div>
                    {search && fullTextHits.find((hit) => hit.paperId === paper.id) && <div className="fulltext-hit"><b>{fullTextHits.find((hit) => hit.paperId === paper.id)?.source}</b><span>{fullTextHits.find((hit) => hit.paperId === paper.id)?.snippet}</span></div>}
                  </div>
                  <time>{paper.year ?? "—"}</time>
                  <span className={`status-pill ${statusTone(paper.status)}`}>{paper.status}</span>
                  <FlagPicker paper={paper} onChange={(color) => void changeFlag(paper, color)} onFavorite={() => void toggleFavorite(paper)} />
                  <label className="reference-check" title="参考文献に追加" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                    <input type="checkbox" checked={paper.isReference} onChange={() => void toggleReference(paper)} />
                    <span>参考</span>
                  </label>
                </div>
              ))}
              {filteredPapers.length === 0 && (
                <div className="empty-list"><span>⌁</span><h2>論文がまだありません</h2><p>PDFを追加すると未整理に入り、Markdownノートが自動作成されます。</p><button onClick={importPdfs}>PDFを追加</button></div>
              )}
            </div>
            </>}
          </section>

          {draft && folderFilter !== "__trash" && (
            <PaperInspector
              paper={draft}
              root={root}
              busy={busy}
              onChange={updateDraft}
              onClose={() => setSelectedId(null)}
              onSave={saveDraft}
              onOpenPdf={() => openPaperViewer(draft)}
              onOpenNote={() => openPaperNote(draft)}
              onStatusChange={changeReadingStatus}
              onFlagChange={(color) => void changeFlag(draft, color)}
              onFavoriteChange={() => void toggleFavorite(draft)}
              onEnrich={enrichDraftMetadata}
              onTranslate={translateDraftSummary}
              onTrash={trashDraft}
              collections={collections}
              onMoveToFolder={moveDraftToFolder}
              saveState={saveState}
              pdfAvailable={pdfAvailability[draft.id] ?? null}
              obsidianConnected={obsidianConnected}
              onObsidianSetup={() => setShowObsidianSetup(true)}
            />
          )}
        </section>
      )}
      {dragPreview && (
        <div className={folderDropTarget ? "paper-drag-preview accepted" : "paper-drag-preview"} style={{ left: dragPreview.x, top: dragPreview.y }} aria-hidden="true">
          <span className="drag-paper-icon">PDF</span>
          <div><strong>{dragPreview.title}</strong><small>{dragPreview.count > 1 ? `${dragPreview.count}件をまとめて移動` : "フォルダへ移動"}{folderDropTarget ? ` → ${folderDropTarget === "__unfiled" ? "未整理" : folderDropTarget}` : ""}</small></div>
          {dragPreview.count > 1 && <i>{dragPreview.count}</i>}
        </div>
      )}
      {folderDragPreview && (
        <div className={folderHierarchyDropTarget !== null ? "folder-drag-preview accepted" : "folder-drag-preview"} style={{ left: folderDragPreview.x, top: folderDragPreview.y }} aria-hidden="true">
          <span>⌑</span>
          <div>
            <strong>{folderDragPreview.collection.split("/").at(-1)}</strong>
            <small>{folderHierarchyDropTarget === null ? "移動先のフォルダへドロップ" : `→ ${folderHierarchyDropTarget || "Papers直下"}`}</small>
          </div>
        </div>
      )}
      {folderMenu && (
        <div className="folder-context-menu" role="menu" style={{ left: folderMenu.x, top: folderMenu.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => openCreateFolder(folderMenu.collection)}>{folderMenu.collection ? "この中に新規フォルダ" : "新規フォルダ"}</button>
          {folderMenu.collection && <button type="button" onClick={() => openRenameFolder(folderMenu.collection)}>名前を変更…</button>}
          {folderMenu.collection && <button className="danger" type="button" onClick={() => { setDeleteFolderTarget(folderMenu.collection); setFolderMenu(null); }}>フォルダを削除</button>}
        </div>
      )}
      {paperMenu && (
        <div className="paper-context-menu" role="menu" style={{ left: paperMenu.x, top: paperMenu.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          <div className="context-menu-heading">{paperMenu.paperIds.length}件の文献</div>
          <div className="context-submenu-wrap">
            <button type="button" aria-haspopup="menu"><span>移動する</span><b>›</b></button>
            <div className="context-submenu" role="menu">
              <button type="button" onClick={() => { void movePapersToFolder(paperMenu.paperIds, "__unfiled"); setPaperMenu(null); }}>未整理</button>
              <button type="button" onClick={() => { void movePapersToFolder(paperMenu.paperIds, ""); setPaperMenu(null); }}>Papers直下</button>
              {collections.length > 0 && <div className="context-separator" />}
              {collections.map((collection) => (
                <button key={collection} type="button" title={collection} onClick={() => { void movePapersToFolder(paperMenu.paperIds, collection); setPaperMenu(null); }}>{collection}</button>
              ))}
              <div className="context-separator" />
              <button className="new-folder" type="button" onClick={() => openCreateFolder("", paperMenu.paperIds)}>＋ 新規フォルダを作成…</button>
            </div>
          </div>
          <button type="button" disabled={busy} onClick={() => void enrichSelectedPapers(paperMenu.paperIds)}>書誌取得</button>
          <div className="context-separator" />
          <button className="danger" type="button" disabled={busy} onClick={() => void trashSelectedPapers(paperMenu.paperIds)}>ゴミ箱へ移動</button>
        </div>
      )}
      {folderDialog && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setFolderDialog(null)}>
          <form className="folder-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void createLibraryFolder(folderDialog.parent, folderDialog.name, folderDialog.movePaperIds); }}>
            <span className="dialog-icon">⌑</span>
            <h2>新しいフォルダ</h2>
            <p>{folderDialog.parent ? `「${folderDialog.parent}」の中に作成します` : "Papersの中に作成します"}{folderDialog.movePaperIds?.length ? `。作成後、選択した${folderDialog.movePaperIds.length}件を移動します。` : ""}</p>
            <input autoFocus value={folderDialog.name} onChange={(event) => setFolderDialog({ ...folderDialog, name: event.target.value })} placeholder="例：うつ病" />
            <div><button type="button" onClick={() => setFolderDialog(null)}>キャンセル</button><button className="confirm" type="button" disabled={!folderDialog.name.trim()} onClick={() => void createLibraryFolder(folderDialog.parent, folderDialog.name, folderDialog.movePaperIds)}>{folderDialog.movePaperIds?.length ? "作成して移動" : "作成"}</button></div>
          </form>
        </div>
      )}
      {renameFolderDialog && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setRenameFolderDialog(null)}>
          <form className="folder-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void renameLibraryFolder(renameFolderDialog.collection, renameFolderDialog.name); }}>
            <span className="dialog-icon">⌑</span>
            <h2>フォルダ名を変更</h2>
            <p>「{renameFolderDialog.collection}」の名前を変更します。中の論文と子フォルダはそのまま移動します。</p>
            <input autoFocus value={renameFolderDialog.name} onChange={(event) => setRenameFolderDialog({ ...renameFolderDialog, name: event.target.value })} placeholder="フォルダ名" />
            <div><button type="button" onClick={() => setRenameFolderDialog(null)}>キャンセル</button><button className="confirm" type="submit" disabled={!renameFolderDialog.name.trim() || busy}>変更</button></div>
          </form>
        </div>
      )}
      {deleteFolderTarget && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setDeleteFolderTarget(null)}>
          <section className="folder-dialog delete-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <span className="dialog-icon">⌑</span>
            <h2>フォルダを削除しますか？</h2>
            <p>「{deleteFolderTarget}」を削除します。中に論文や子フォルダがある場合は削除されません。</p>
            <div><button type="button" onClick={() => setDeleteFolderTarget(null)}>キャンセル</button><button className="confirm danger" type="button" onClick={() => void deleteLibraryFolder(deleteFolderTarget)}>削除</button></div>
          </section>
        </div>
      )}
      {showObsidianSetup && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setShowObsidianSetup(false)}>
          <section className="folder-dialog obsidian-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <span className="dialog-icon obsidian-dialog-icon">◇</span>
            <h2>Obsidian Vaultを設定</h2>
            <p><strong>Vault（保管庫）</strong>は、ObsidianがMarkdownをまとめて管理するフォルダです。Rillの保存場所をそのままVaultにすると、Notesの文献ノートをObsidianから編集できます。</p>
            <p><strong>この登録はMacごとに初回の1回だけ必要です。</strong>VaultをGoogle Driveなどで同期しても、Obsidianの登録情報は別のMacへ自動では移りません。</p>
            <ol><li>「Obsidianを起動」を押す</li><li>Obsidianで「保管庫を開く」→「フォルダを保管庫として開く」を選ぶ</li><li>下記のRill保存場所を選ぶ</li></ol>
            <code>{root}</code>
            <div className="obsidian-dialog-actions"><button type="button" onClick={() => void openLibraryFolder()}>Finderで場所を表示</button><button type="button" onClick={() => void openObsidianApp()}>Obsidianを起動</button><button className="confirm" type="button" onClick={() => void refreshObsidianStatus()}>接続を確認</button></div>
          </section>
        </div>
      )}
      {showSettings && (
        <SettingsDialog
          root={root}
          obsidianConnected={obsidianConnected}
          onClose={() => setShowSettings(false)}
          onChooseRoot={() => void chooseLibrary()}
          onOpenRoot={() => void openLibraryFolder()}
          onObsidianSetup={() => { setShowSettings(false); setShowObsidianSetup(true); }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

function SettingsDialog({ root, obsidianConnected, onClose, onChooseRoot, onOpenRoot, onObsidianSetup }: {
  root: string;
  obsidianConnected: boolean;
  onClose: () => void;
  onChooseRoot: () => void;
  onOpenRoot: () => void;
  onObsidianSetup: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="folder-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <RillMark />
          <div><h2 id="settings-title">設定</h2><p>Rillの保存場所と連携を管理します。</p></div>
          <button className="settings-close" type="button" aria-label="設定を閉じる" onClick={onClose}>×</button>
        </header>
        <div className="settings-section">
          <div><h3>ライブラリ</h3><p>PDF、書誌情報、Markdownを保存するフォルダ</p></div>
          <code>{root || "保存場所が未設定です"}</code>
          <div className="settings-actions">
            {root && <button type="button" onClick={onOpenRoot}>Finderで表示</button>}
            <button className="confirm" type="button" onClick={onChooseRoot}>{root ? "保存場所を変更" : "保存場所を選ぶ"}</button>
          </div>
        </div>
        <div className="settings-section settings-row">
          <div><h3>Obsidian</h3><p>{obsidianConnected ? "Vault接続済み" : "MarkdownノートをObsidianとつなぐ"}</p></div>
          <button type="button" disabled={!root} onClick={onObsidianSetup}>{root ? (obsidianConnected ? "接続を確認" : "設定する") : "保存場所を先に選択"}</button>
        </div>
        <div className="settings-section settings-row">
          <div><h3>翻訳</h3><p>英語から日本語への和訳には、macOSの翻訳機能を使います。言語は「システム設定 › 一般 › 言語と地域」で管理できます。</p></div>
        </div>
      </section>
    </div>
  );
}

function FlagPicker({ paper, onChange, onFavorite }: { paper: Paper; onChange: (color: string) => void; onFavorite: () => void }) {
  const label = paper.flagColor ? `${paper.flagColor} flag` : "フラッグなし";
  return (
    <div className="paper-markers" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <button type="button" className={paper.isFavorite ? "favorite-star active" : "favorite-star"} title={paper.isFavorite ? "お気に入りから外す" : "お気に入りに追加"} onClick={onFavorite}>★</button>
      <label className={`flag-picker ${paper.flagColor || "none"}`} title={label}>
        <span>⚑</span>
        <select aria-label={`${paper.title}のフラッグ色`} value={paper.flagColor} onChange={(event) => onChange(event.target.value)}>
          <option value="">なし</option><option value="blue">青</option><option value="yellow">黄</option><option value="red">赤</option>
        </select>
      </label>
    </div>
  );
}

function Overview({
  papers,
  stats,
  root,
  onOpenLibrary,
  onSelect,
  onChooseRoot,
  onOpenRoot,
  onImport,
  dropActive,
  obsidianConnected,
  onObsidianSetup,
}: {
  papers: Paper[];
  stats: { total: number; unread: number; reading: number; inbox: number };
  root: string;
  onOpenLibrary: () => void;
  onSelect: (paper: Paper) => void;
  onChooseRoot: () => void;
  onOpenRoot: () => void;
  onImport: () => void;
  dropActive: boolean;
  obsidianConnected: boolean;
  onObsidianSetup: () => void;
}) {
  return (
    <section className="overview">
      <div className="overview-heading">
        <div><h1>読むたび、少し深くなる。</h1><p className="overview-subcopy">Still waters run deep.</p></div>
      </div>

      <div className="stat-grid">
        <button className={stats.total === 0 ? "is-empty" : ""} onClick={onOpenLibrary}><span>ライブラリ</span><strong>{stats.total || "–"}</strong><small>papers</small><i>↗</i></button>
        <button className={stats.unread === 0 ? "is-empty" : ""} onClick={onOpenLibrary}><span>未読</span><strong>{stats.unread || "–"}</strong><small>to read</small><i>↗</i></button>
        <button className={stats.reading === 0 ? "is-empty" : ""} onClick={onOpenLibrary}><span>読書中</span><strong>{stats.reading || "–"}</strong><small>in progress</small><i>↗</i></button>
        <button className={stats.inbox === 0 ? "is-empty" : ""} onClick={onOpenLibrary}><span>未整理</span><strong>{stats.inbox || "–"}</strong><small>to organize</small><i>↗</i></button>
      </div>

      <button className={dropActive ? "overview-pdf-drop drop-active" : "overview-pdf-drop"} type="button" onClick={onImport}>
        <span className="drop-pdf-icon">PDF</span>
        <span><strong>ドロップして未整理に追加</strong><small>クリックして選ぶこともできます</small></span>
        <i>＋</i>
        {dropActive && <span className="drop-confirm-overlay" aria-hidden="true"><b>PDF</b><strong>ここにドロップして未整理へ追加</strong></span>}
      </button>

      <div className="overview-grid">
        <section className="recent-card">
          <div className="section-title"><div><span>最近の文献</span><small>Recently added</small></div><button onClick={onOpenLibrary}>すべて見る →</button></div>
          <div className="recent-list">
            {papers.slice(0, 5).map((paper) => (
              <button key={paper.id} onClick={() => onSelect(paper)}>
                <span className="paper-icon">PDF</span>
                <div><strong>{paper.title}</strong><small>{shortAuthors(paper.authors)} · {paper.year ?? "年不明"}</small></div>
                <time>{formatDate(paper.addedAt)}</time>
                <i>›</i>
              </button>
            ))}
            {papers.length === 0 && <div className="recent-empty">最初のPDFを追加して、ライブラリを始めましょう。</div>}
          </div>
        </section>

        <aside className="local-flow-card">
          <div className="section-title"><div><span>保存と連携</span><small>PDFとメモの保存先</small></div><em>●</em></div>
          <button className="flow-folder" onClick={onOpenRoot}><span className="folder-icon">⌑</span><div><strong>Rill ライブラリ</strong><small>{root}</small></div><i>↗</i></button>
          <div className="flow-line"><span>↓</span><small>PDFとメモ</small></div>
          <div className="flow-destinations">
            <button type="button" className={obsidianConnected ? "obsidian-destination connected" : "obsidian-destination"} onClick={onObsidianSetup}><span className="obsidian-glyph">◇</span><strong>Obsidian</strong><small>{obsidianConnected ? "接続済み" : "接続する"}</small></button>
          </div>
          <button className="change-root" onClick={onChooseRoot}>保存場所を変更</button>
        </aside>
      </div>
    </section>
  );
}

function CitationPreview({ citation }: { citation: string }) {
  const parts = citation.split(/(\*[^*]+\*)/g).filter(Boolean);
  return <>{parts.map((part, index) => part.startsWith("*") && part.endsWith("*") ? <em key={index}>{part.slice(1, -1)}</em> : <span key={index}>{part}</span>)}</>;
}

function citationHtml(citation: string) {
  return citation
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function citationHtmlBlock(parts: { number: string; citation: string }, hangingIndent: boolean) {
  if (!parts.number || !hangingIndent) return `<div>${citationHtml([parts.number, parts.citation].filter(Boolean).join(" "))}</div>`;
  return `<div style="display:grid;grid-template-columns:2.7em minmax(0, 1fr);gap:.55em;align-items:start;"><span>${citationHtml(parts.number)}</span><span>${citationHtml(parts.citation)}</span></div>`;
}

function citationPlainText(citation: string) {
  return citation.replace(/\*([^*]+)\*/g, "$1");
}

async function copyCitation(text: string, html: string) {
  try {
    if (typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      })]);
    } else {
      await navigator.clipboard.writeText(text);
    }
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

function CitationEditor({ options, disabled, previewPaper, presetName, onRenamePreset, onOptionsChange, onCreatePreset, onDuplicatePreset, onDeletePreset, onExportPreset, onImport }: {
  options: CitationOptions; disabled: boolean; previewPaper: Paper; presetName?: string; onRenamePreset: (name: string) => string; onOptionsChange: (options: CitationOptions) => void; onCreatePreset: () => void; onDuplicatePreset: () => void; onDeletePreset: () => void; onExportPreset: () => void; onImport: () => void;
}) {
  const set = (next: Partial<CitationOptions>) => onOptionsChange({ ...options, ...next });
  const previewParts = formatReferenceParts(previewPaper, 1, "preset:preview", options);
  const preview = [previewParts.number, previewParts.citation].filter(Boolean).join(" ");
  const [presetNameDraft, setPresetNameDraft] = useState(presetName ?? "");
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const copyTimeout = useRef<number | null>(null);
  useEffect(() => setPresetNameDraft(presetName ?? ""), [presetName]);
  const radio = <T extends string>(label: string, value: T, current: T, update: (value: T) => void) => <label className="editor-choice"><input type="radio" checked={current === value} onChange={() => update(value)} /><span>{label}</span></label>;
  function commitPresetName() {
    setPresetNameDraft(onRenamePreset(presetNameDraft));
  }
  async function copyPreview() {
    if (copyState === "copying") return;
    setCopyState("copying");
    const copied = await copyCitation(citationPlainText(preview), citationHtmlBlock(previewParts, options.hangingIndent));
    setCopyState(copied ? "copied" : "failed");
    if (copyTimeout.current) window.clearTimeout(copyTimeout.current);
    copyTimeout.current = window.setTimeout(() => setCopyState("idle"), copied ? 1800 : 2600);
  }
  return <section className="csl-editor" aria-label="CSL Editor">
    <div className="csl-editor-head"><div><small>CSL Editor</small>{presetName ? <input className="preset-name-input" aria-label="テンプレート名" value={presetNameDraft} onChange={(event) => setPresetNameDraft(event.target.value)} onBlur={commitPresetName} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /> : <h2>カスタム引用テンプレート</h2>}<p>Rillに保存済みの書誌情報だけを使い、出力の見た目を整えます。</p></div><div><button type="button" onClick={onCreatePreset}>新規テンプレート</button>{presetName && <><button type="button" onClick={onDuplicatePreset}>複製</button><button type="button" className="delete-preset" onClick={onDeletePreset}>削除</button></>}<button type="button" onClick={onImport}>JSONを読み込む</button><button type="button" onClick={onExportPreset}>JSONを書き出す</button></div></div>
    <div className="csl-editor-grid"><fieldset className="csl-settings" disabled={disabled}>
      {!disabled ? <><h3>フォーマット設定</h3>
        <div className="editor-group"><div className="editor-group-title"><strong>番号</strong></div><label>表記<select value={options.numbering} onChange={(event) => set({ numbering: event.target.value as CitationOptions["numbering"] })}><option value="none">なし</option><option value="period">1.</option><option value="brackets">[1]</option></select></label><small className="editor-help">Referencesの並び順をそのまま使います。</small></div>
        <div className="editor-group"><div className="editor-group-title"><strong>著者名</strong><label className="format-check"><input type="checkbox" checked={options.includeAuthors} onChange={(event) => set({ includeAuthors: event.target.checked })} />表示する</label></div><div>{radio("イニシャル＋姓", "initials", options.authorNames, (authorNames) => set({ authorNames }))}{radio("フルネーム", "full", options.authorNames, (authorNames) => set({ authorNames }))}{radio("姓のみ", "surname", options.authorNames, (authorNames) => set({ authorNames }))}</div><label>区切り<select value={options.authorSeparator} onChange={(event) => set({ authorSeparator: event.target.value as CitationOptions["authorSeparator"] })}><option value=", ">カンマ</option><option value="; ">セミコロン</option><option value=" and ">and</option></select></label><label>最終著者<select value={options.finalAuthor} onChange={(event) => set({ finalAuthor: event.target.value as CitationOptions["finalAuthor"] })}><option value="separator">同一区切り</option><option value="and">and</option><option value="ampersand">&amp;</option></select></label><label>et al. の開始<input type="number" min="1" max="30" value={options.etAlAfter} onChange={(event) => set({ etAlAfter: Math.max(1, Number(event.target.value) || 1) })} /> 人目以降</label></div>
        <div className="editor-group"><div className="editor-group-title"><strong>雑誌名</strong><label className="format-check"><input type="checkbox" checked={options.includeJournal} onChange={(event) => set({ includeJournal: event.target.checked })} />表示する</label></div><div>{radio("正式名", "full", options.journalNames, (journalNames) => set({ journalNames }))}{radio("略称", "abbreviated", options.journalNames, (journalNames) => set({ journalNames }))}</div><label className="format-check"><input type="checkbox" checked={options.italicJournal} onChange={(event) => set({ italicJournal: event.target.checked })} />イタリックにする</label></div>
        <div className="editor-group"><strong>巻・号・ページ</strong><label className="format-check"><input type="checkbox" checked={options.includeVolume} onChange={(event) => set({ includeVolume: event.target.checked })} />巻を含める</label><label className="format-check"><input type="checkbox" checked={options.includeIssue} onChange={(event) => set({ includeIssue: event.target.checked })} />号数を含める</label><label>号数の表記<select value={options.issueFormat} onChange={(event) => set({ issueFormat: event.target.value as CitationOptions["issueFormat"] })}><option value="parentheses">(15)</option><option value="plain">15</option></select></label><label className="format-check"><input type="checkbox" checked={options.includePages} onChange={(event) => set({ includePages: event.target.checked })} />頁／article numberを含める</label><label>並び<select value={options.locatorPattern} onChange={(event) => set({ locatorPattern: event.target.value as CitationOptions["locatorPattern"] })}><option value="year-volume-issue-pages">年;巻(号):頁</option><option value="year-volume-pages">年;巻:頁</option><option value="year-volume-article">年;巻:article number</option></select></label>{!options.includeJournal && <small className="editor-help">雑誌名を表示しない設定では、巻・号・頁/article numberは単独で出力しません。</small>}</div>
        <div className="editor-group"><div className="editor-group-title"><strong>出版年</strong><label className="format-check"><input type="checkbox" checked={options.includeYear} onChange={(event) => set({ includeYear: event.target.checked })} />表示する</label></div><label className="format-check"><input type="checkbox" checked={options.yearParentheses} onChange={(event) => set({ yearParentheses: event.target.checked })} />括弧で囲む</label><div>{radio("著者名の直後", "after-authors", options.yearPosition, (yearPosition) => set({ yearPosition }))}{radio("末尾", "end", options.yearPosition, (yearPosition) => set({ yearPosition }))}</div></div>
        <div className="editor-group"><div className="editor-group-title"><strong>タイトル・DOI</strong><label className="format-check"><input type="checkbox" checked={options.includeTitle} onChange={(event) => set({ includeTitle: event.target.checked })} />タイトルを表示</label></div><div>{radio("原文維持", "original", options.titleCase, (titleCase) => set({ titleCase }))}{radio("sentence case", "sentence", options.titleCase, (titleCase) => set({ titleCase }))}</div><label>DOI<select value={options.doiMode} onChange={(event) => set({ doiMode: event.target.value as CitationOptions["doiMode"] })}><option value="none">なし</option><option value="prefix">doi:xxx</option><option value="url">https://doi.org/xxx</option></select></label></div>
        <div className="editor-group"><strong>段落</strong><label className="format-check"><input type="checkbox" checked={options.hangingIndent} onChange={(event) => set({ hangingIndent: event.target.checked })} />ぶら下げインデント</label><small className="editor-help">オンの場合のみ、プレビューとリッチテキスト貼り付けで反映します。プレーンテキストは変わりません。</small></div>
      </> : <div className="editor-locked"><h3>CSL原典を使用中です</h3><p>取り込んだCSLや標準CSLの規則は、この画面から変更しません。カスタムテンプレートを選ぶか、新規作成してください。</p></div>}
    </fieldset><aside className="csl-preview"><div><small>PREVIEW</small><h3>プレビュー</h3></div><div className="csl-preview-paper">{options.hangingIndent && previewParts.number ? <div className="citation-preview-grid"><span className="citation-number-cell">{previewParts.number}</span><div><CitationPreview citation={previewParts.citation} /></div></div> : <div className="citation-preview-body"><CitationPreview citation={preview} /></div>}</div><button type="button" className={copyState === "copied" ? "copy-feedback copied" : copyState === "failed" ? "copy-feedback failed" : "copy-feedback"} disabled={copyState === "copying"} onClick={() => void copyPreview()}>{copyState === "copying" ? "コピー中…" : copyState === "copied" ? "コピーしました" : copyState === "failed" ? "コピーできませんでした" : "引用をコピー"}</button></aside></div>
  </section>;
}

function ReferencesView({ papers, style, options, busy, customStyles, presets, onStyleChange, onOptionsChange, onPresetsChange, onExport, onOpenPaper, onRemove, onMoveReference, onReorderReferences, onRemoveAll, onAddTags, onToast, onImportStyle }: {
  papers: Paper[];
  style: CitationStyle;
  options: CitationOptions;
  busy: boolean;
  onStyleChange: (style: CitationStyle) => void;
  onOptionsChange: (options: CitationOptions) => void;
  onExport: () => void;
  onOpenPaper: (paper: Paper) => void;
  onRemove: (paper: Paper) => void;
  onMoveReference: (paper: Paper, direction: "up" | "down") => void;
  onReorderReferences: (sourceId: string, targetId: string) => void;
  onRemoveAll: () => void;
  onAddTags: (tagInput: string) => Promise<boolean>;
  onToast: (message: string) => void;
  customStyles: CslStyleFile[];
  presets: CitationPreset[];
  onPresetsChange: (presets: CitationPreset[]) => void;
  onImportStyle: () => void;
}) {
  const [bulkTagText, setBulkTagText] = useState("");
  const [showEditor, setShowEditor] = useState(false);
  const [draggingReferenceId, setDraggingReferenceId] = useState<string | null>(null);
  const [referenceDropTargetId, setReferenceDropTargetId] = useState<string | null>(null);
  const [referenceDragPreview, setReferenceDragPreview] = useState<{ x: number; y: number; title: string; targetIndex: number } | null>(null);
  const [listCopyState, setListCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const listCopyTimeout = useRef<number | null>(null);
  const referenceDrag = useRef<{ sourceId: string; startX: number; startY: number; active: boolean } | null>(null);
  const importPresetRef = useRef<HTMLInputElement>(null);
  const supportsOptions = style === "journal" || style === "markdown" || isPresetStyle(style);
  const incompletePapers = papers.filter((paper) => !paper.title.trim() || paper.authors.length === 0 || !paper.year || !(paper.journal || paper.journalAbbreviation).trim());
  const doiMissingPapers = papers.filter((paper) => !paper.doi.trim());

  async function copyReferences() {
    if (listCopyState === "copying") return;
    const citationParts = papers.map((paper, index) => formatReferenceParts(paper, index + 1, style, options));
    const citations = citationParts.map(({ number, citation }) => [number, citation].filter(Boolean).join(" "));
    const text = citations.map(citationPlainText).join("\n");
    if (!text) return;
    setListCopyState("copying");
    const html = citationParts.map((parts) => citationHtmlBlock(parts, options.hangingIndent)).join("");
    const copied = await copyCitation(text, html);
    setListCopyState(copied ? "copied" : "failed");
    if (listCopyTimeout.current) window.clearTimeout(listCopyTimeout.current);
    listCopyTimeout.current = window.setTimeout(() => setListCopyState("idle"), copied ? 1800 : 2600);
    onToast(copied ? `${papers.length}件の参考文献をコピーしました` : "参考文献をコピーできませんでした");
  }

  async function addTags() {
    const normalized = formatTags(parseTags(bulkTagText));
    if (!normalized) return;
    if (await onAddTags(normalized)) setBulkTagText("");
  }

  function beginReferenceDrag(event: ReactPointerEvent<HTMLLIElement>, paper: Paper) {
    if (event.button !== 0 || (event.target as Element).closest("button, input, select, a")) return;
    const drag = { sourceId: paper.id, startX: event.clientX, startY: event.clientY, active: false };
    referenceDrag.current = drag;
    const cleanup = () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
    const track = (moveEvent: PointerEvent) => {
      if (!drag.active && Math.hypot(moveEvent.clientX - drag.startX, moveEvent.clientY - drag.startY) > 6) {
        drag.active = true;
        setDraggingReferenceId(paper.id);
        document.body.classList.add("reference-drag-active");
      }
      if (drag.active) {
        moveEvent.preventDefault();
        const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>("[data-reference-id]");
        const targetId = target?.dataset.referenceId ?? paper.id;
        const targetIndex = Math.max(0, papers.findIndex((item) => item.id === targetId));
        setReferenceDropTargetId(targetId);
        setReferenceDragPreview({ x: moveEvent.clientX + 14, y: moveEvent.clientY + 14, title: paper.title, targetIndex });
      }
    };
    const finish = (upEvent: PointerEvent) => {
      cleanup();
      referenceDrag.current = null;
      if (!drag.active) return;
      const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest<HTMLElement>("[data-reference-id]");
      const targetId = target?.dataset.referenceId;
      if (targetId) onReorderReferences(paper.id, targetId);
      setDraggingReferenceId(null);
      setReferenceDropTargetId(null);
      setReferenceDragPreview(null);
      document.body.classList.remove("reference-drag-active");
    };
    const cancel = () => { cleanup(); referenceDrag.current = null; setDraggingReferenceId(null); setReferenceDropTargetId(null); setReferenceDragPreview(null); document.body.classList.remove("reference-drag-active"); };
    window.addEventListener("pointermove", track);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }

  function savePresets(next: CitationPreset[]) {
    onPresetsChange(next);
    localStorage.setItem("rill-citation-presets", JSON.stringify(next));
  }

  function createPreset() {
    const preset = { id: crypto.randomUUID(), name: `新しいテンプレート ${presets.length + 1}`, options };
    savePresets([...presets, preset]); onStyleChange(`preset:${preset.id}`); setShowEditor(true);
  }

  function duplicatePreset() {
    const source = isPresetStyle(style) ? presets.find((preset) => preset.id === style.slice(7)) : undefined;
    if (!source) return;
    const preset = { ...source, id: crypto.randomUUID(), name: `${source.name} のコピー` };
    savePresets([...presets, preset]); onStyleChange(`preset:${preset.id}`); onToast(`「${preset.name}」を作成しました`);
  }

  function deletePreset() {
    if (!isPresetStyle(style)) return;
    const presetId = style.slice(7);
    const preset = presets.find((item) => item.id === presetId);
    if (!preset || !window.confirm(`「${preset.name}」を削除しますか？`)) return;
    savePresets(presets.filter((item) => item.id !== presetId)); onStyleChange("journal"); onToast(`「${preset.name}」を削除しました`);
  }

  function renamePreset(name: string) {
    if (!isPresetStyle(style)) return name.trim();
    const presetId = style.slice(7);
    const presetIndex = presets.findIndex((preset) => preset.id === presetId);
    if (presetIndex < 0) return name.trim();
    const usedNames = new Set(presets.filter((preset) => preset.id !== presetId).map((preset) => preset.name));
    let fallbackIndex = presetIndex + 1;
    while (usedNames.has(`新しいテンプレート ${fallbackIndex}`)) fallbackIndex += 1;
    const nextName = name.trim() || `新しいテンプレート ${fallbackIndex}`;
    savePresets(presets.map((preset) => preset.id === presetId ? { ...preset, name: nextName } : preset));
    return nextName;
  }

  async function exportPreset() {
    const preset = isPresetStyle(style) ? presets.find((item) => item.id === style.slice(7)) : { id: "rill-export", name: "カスタム形式", options };
    if (!preset) return;
    const content = JSON.stringify({ version: 1, preset }, null, 2);
    if (isTauri) {
      const written = await invoke<boolean>("write_citation_preset", { content, suggestedName: `${preset.name}.rill-citation.json` });
      if (!written) return;
      onToast(`「${preset.name}」をJSONで書き出しました`); return;
    }
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${preset.name}.rill-citation.json`; anchor.click(); URL.revokeObjectURL(url);
    onToast(`「${preset.name}」をJSONで書き出しました`);
  }

  async function addImportedPreset(content: string) {
    try {
      const data = JSON.parse(content) as { preset?: CitationPreset };
      if (!data.preset?.name || !data.preset.options) throw new Error("テンプレート形式が正しくありません");
      const preset = { id: crypto.randomUUID(), name: data.preset.name, options: normalizeCitationOptions(data.preset.options) };
      savePresets([...presets, preset]); onStyleChange(`preset:${preset.id}`); setShowEditor(true); onToast(`「${preset.name}」を追加しました`);
    } catch (error) { onToast(error instanceof Error ? error.message : "JSONを読み込めませんでした"); }
  }

  async function importPreset(file: File) { await addImportedPreset(await file.text()); }

  async function importPresetFromMac() {
    try {
      const content = await invoke<string | null>("read_citation_preset");
      if (content) await addImportedPreset(content);
    } catch (error) { onToast(String(error)); }
  }

  return (
    <section className="references-view">
      {referenceDragPreview && <div className="reference-drag-preview" style={{ left: referenceDragPreview.x, top: referenceDragPreview.y }} aria-hidden="true"><span>REF</span><div><strong>{referenceDragPreview.title}</strong><small>{referenceDragPreview.targetIndex + 1}番へ移動</small></div></div>}
      <div className="references-heading">
        <div><p className="eyebrow">CITATION WORKSPACE</p><h1>References</h1><p>一覧の「参考」にチェックした論文を、引用しやすい形に整えます。</p></div>
        <div className="reference-actions">
          <label><span>引用テンプレート</span>
            <select value={style} onChange={(event) => onStyleChange(event.target.value as CitationStyle)}>
              <option value="journal">雑誌形式</option>
              <option value="vancouver">Vancouver（CSL）</option>
              <option value="apa">APA 7th（CSL）</option>
              <option value="harvard1">Harvard（CSL）</option>
              <option value="markdown">Markdown形式</option>
              <option value="short">簡易形式（著者 et al.）</option>
              {customStyles.map((custom) => <option key={custom.name} value={`custom:${custom.name}`}>{custom.name}</option>)}
              {presets.length > 0 && <optgroup label="カスタムテンプレート">{presets.map((preset) => <option key={preset.id} value={`preset:${preset.id}`}>{preset.name}</option>)}</optgroup>}
            </select>
          </label>
          <button type="button" className="import-csl" onClick={onImportStyle}>＋ CSLを追加</button>
          <button type="button" className={showEditor ? "format-citation active" : "format-citation"} onClick={() => setShowEditor((current) => !current)}>CSL Editor</button>
          <button type="button" className={listCopyState === "copied" ? "copy-references copied" : listCopyState === "failed" ? "copy-references failed" : "copy-references"} disabled={papers.length === 0 || listCopyState === "copying"} onClick={() => void copyReferences()}>{listCopyState === "copying" ? "コピー中…" : listCopyState === "copied" ? "コピーしました" : listCopyState === "failed" ? "コピーできませんでした" : "一覧をコピー"}</button>
          <button type="button" className="export-references" disabled={busy || papers.length === 0} onClick={onExport}>参考文献ファイルを作成</button>
        </div>
      </div>
      {showEditor && <CitationEditor options={options} disabled={!supportsOptions} previewPaper={papers[0] ?? demoPapers[0]} presetName={isPresetStyle(style) ? presets.find((item) => item.id === style.slice(7))?.name : undefined} onRenamePreset={renamePreset} onOptionsChange={onOptionsChange} onCreatePreset={createPreset} onDuplicatePreset={duplicatePreset} onDeletePreset={deletePreset} onExportPreset={() => void exportPreset()} onImport={() => isTauri ? void importPresetFromMac() : importPresetRef.current?.click()} />}
      <input ref={importPresetRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importPreset(file); event.currentTarget.value = ""; }} />
      {(incompletePapers.length > 0 || (options.doiMode !== "none" && doiMissingPapers.length > 0)) && <div className="reference-quality-notice" role="status">
        <span aria-hidden="true">!</span><p>{incompletePapers.length > 0 && <><strong>{incompletePapers.length}件</strong>に著者・タイトル・年・雑誌名の不足があります。出力前に文献情報を確認してください。</>}{incompletePapers.length > 0 && options.doiMode !== "none" && doiMissingPapers.length > 0 && " "}{options.doiMode !== "none" && doiMissingPapers.length > 0 && <><strong>{doiMissingPapers.length}件</strong>はDOIが未登録のため、DOIなしで出力されます。</>}</p>
      </div>}
      <form className="reference-bulk-tools" onSubmit={(event) => { event.preventDefault(); void addTags(); }}>
        <label><span>この参考文献セットに共通タグを追加</span><input value={bulkTagText} onChange={(event) => setBulkTagText(event.target.value)} placeholder="#投稿論文名 #レビュー2026" /><small>既存タグを残したまま追加します。カンマ区切りも使えます。</small></label>
        <button type="submit" className="bulk-tag-references" disabled={busy || papers.length === 0 || parseTags(bulkTagText).length === 0}>一括タグ付け</button>
      </form>
      <div className="references-body">
        <div className="reference-summary"><strong>{papers.length}</strong><span>selected references</span><small>MarkdownとBibTeXの2種類をExportsフォルダに作成します</small></div>
        {papers.length === 0 ? (
          <div className="references-empty"><span>§</span><h2>参考文献はまだありません</h2><p>Libraryで論文行の「参考」にチェックすると、ここへ集まります。</p></div>
        ) : (
          <ol className={["reference-list", isPresetStyle(style) && options.numbering !== "none" ? "custom-numbering" : "", isPresetStyle(style) && options.numbering === "none" ? "without-number" : ""].filter(Boolean).join(" ")}>
            {papers.map((paper, index) => (
              <li key={paper.id} data-reference-id={paper.id} className={[draggingReferenceId === paper.id ? "reference-row-dragging" : "", referenceDropTargetId === paper.id && draggingReferenceId !== paper.id ? "reference-row-drop-target" : ""].filter(Boolean).join(" ")} onPointerDown={(event) => beginReferenceDrag(event, paper)}>
                {(() => { const parts = formatReferenceParts(paper, index + 1, style, options); const number = parts.number || (!isPresetStyle(style) ? `${index + 1}.` : ""); return <><span className="reference-number-cell">{number}</span><div><p><CitationPreview citation={parts.citation} /></p><small>{paper.citationKey || "引用キー未登録"}{paper.tags.length > 0 ? ` · ${formatTags(paper.tags)}` : ""}</small></div></>; })()}
                <div><div className="reference-order-controls"><button type="button" disabled={index === 0} aria-label="この文献を上へ移動" onClick={() => onMoveReference(paper, "up")}>↑</button><button type="button" disabled={index === papers.length - 1} aria-label="この文献を下へ移動" onClick={() => onMoveReference(paper, "down")}>↓</button></div><button type="button" onClick={() => onOpenPaper(paper)}>文献を見る</button><button type="button" className="remove-reference" onClick={() => onRemove(paper)}>参考から外す</button></div>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="reference-danger-zone">
        <div><strong>参考指定をまとめて整理</strong><small>PDFとMarkdownはLibraryに残したまま、参考指定だけをすべて外します。</small></div>
        <button type="button" disabled={busy || papers.length === 0} onClick={onRemoveAll}>すべて参考から外す</button>
      </div>
    </section>
  );
}

function TrashWorkspace({ entries, busy, onRestore, onDelete, onOpenFolder }: {
  entries: TrashEntry[];
  busy: boolean;
  onRestore: (entry: TrashEntry) => void;
  onDelete: (entry: TrashEntry) => void;
  onOpenFolder: () => void;
}) {
  const deletedAt = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "削除日時不明";
    return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(date);
  };
  return (
    <section className="trash-workspace">
      <header className="trash-heading">
        <div><h1>ゴミ箱</h1><p>ここにある文献はライブラリへ復元できます。完全に削除するまでMacからは消えません。</p></div>
        <button type="button" onClick={onOpenFolder}>Finderで開く</button>
      </header>
      <div className="trash-list">
        {entries.map((entry) => (
          <article className="trash-row" key={entry.paper.id}>
            <span className="trash-paper-icon">PDF</span>
            <div className="trash-paper-copy">
              <strong>{entry.paper.title}</strong>
              <span>{shortAuthors(entry.paper.authors)}{entry.paper.year ? ` · ${entry.paper.year}` : ""}</span>
              <small>元の場所：{entry.paper.pdfPath}</small>
            </div>
            <time>{deletedAt(entry.deletedAt)}</time>
            <div className="trash-row-actions">
              <button type="button" disabled={busy} onClick={() => onRestore(entry)}>復元</button>
              <button className="danger" type="button" disabled={busy} onClick={() => onDelete(entry)}>完全に削除</button>
            </div>
          </article>
        ))}
        {entries.length === 0 && (
          <div className="trash-empty"><span>⌫</span><h2>ゴミ箱は空です</h2><p>ライブラリで削除した文献は、いったんここへ移動します。</p></div>
        )}
      </div>
    </section>
  );
}

function PaperInspector({ paper, root, busy, saveState, pdfAvailable, collections, obsidianConnected, onChange, onClose, onSave, onOpenPdf, onOpenNote, onStatusChange, onFlagChange, onFavoriteChange, onEnrich, onTranslate, onTrash, onMoveToFolder, onObsidianSetup }: {
  paper: Paper;
  root: string;
  busy: boolean;
  saveState: string;
  pdfAvailable: boolean | null;
  collections: string[];
  obsidianConnected: boolean;
  onChange: (paper: Paper) => void;
  onClose: () => void;
  onSave: () => void;
  onOpenPdf: () => void;
  onOpenNote: () => void;
  onStatusChange: (status: string) => void;
  onFlagChange: (color: string) => void;
  onFavoriteChange: () => void;
  onEnrich: () => void;
  onTranslate: () => void;
  onTrash: () => void;
  onMoveToFolder: (collection: string) => void;
  onObsidianSetup: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ top: 0, clientHeight: 1, scrollHeight: 1 });
  const [tagText, setTagText] = useState(formatTags(paper.tags));
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const stored = Number(localStorage.getItem("rill-paper-details-width"));
    return Number.isFinite(stored) && stored > 0 ? Math.min(720, Math.max(340, stored)) : 420;
  });
  const paperCollection = paper.pdfPath.startsWith("Inbox/") || (paper.pdfPath.startsWith("Papers/") && paper.pdfPath.split("/").length === 2)
    ? "__unfiled"
    : paper.pdfPath.split("/").slice(1, -1).join("/");

  useEffect(() => {
    setTagText(formatTags(paper.tags));
  }, [paper.id]);

  useEffect(() => {
    document.documentElement.style.setProperty("--rill-inspector-width", `${inspectorWidth}px`);
    return () => document.documentElement.style.removeProperty("--rill-inspector-width");
  }, [inspectorWidth]);

  function measureScroll() {
    const element = scrollRef.current;
    if (!element) return;
    setScrollState({ top: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight });
  }

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    measureScroll();
    const observer = new ResizeObserver(measureScroll);
    observer.observe(element);
    Array.from(element.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [paper.id]);

  useEffect(() => {
    measureScroll();
  }, [paper]);

  const canScroll = scrollState.scrollHeight > scrollState.clientHeight;
  const thumbHeight = canScroll ? Math.max(34, (scrollState.clientHeight / scrollState.scrollHeight) * scrollState.clientHeight) : scrollState.clientHeight;
  const thumbTop = canScroll
    ? (scrollState.top / (scrollState.scrollHeight - scrollState.clientHeight)) * (scrollState.clientHeight - thumbHeight)
    : 0;

  function startScrollbarDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const element = scrollRef.current;
    if (!element || !canScroll) return;
    event.preventDefault();
    const startY = event.clientY;
    const startTop = element.scrollTop;
    const availableTrack = scrollState.clientHeight - thumbHeight;
    const availableScroll = scrollState.scrollHeight - scrollState.clientHeight;
    const move = (moveEvent: PointerEvent) => {
      element.scrollTop = startTop + ((moveEvent.clientY - startY) / availableTrack) * availableScroll;
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function jumpScrollbar(event: ReactPointerEvent<HTMLDivElement>) {
    const element = scrollRef.current;
    const track = trackRef.current;
    if (!element || !track || !canScroll || event.target !== event.currentTarget) return;
    const position = event.clientY - track.getBoundingClientRect().top - thumbHeight / 2;
    const ratio = Math.max(0, Math.min(1, position / (scrollState.clientHeight - thumbHeight)));
    element.scrollTop = ratio * (scrollState.scrollHeight - scrollState.clientHeight);
  }

  function startInspectorResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = inspectorWidth;
    const maximumWidth = Math.max(340, Math.min(720, window.innerWidth - 250));
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (moveEvent: PointerEvent) => {
      setInspectorWidth(Math.min(maximumWidth, Math.max(340, startWidth + startX - moveEvent.clientX)));
    };
    const stop = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setInspectorWidth((width) => {
        localStorage.setItem("rill-paper-details-width", String(Math.round(width)));
        return width;
      });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  return (
    <aside className="inspector" style={{ width: `${inspectorWidth}px` }}>
      <div className="inspector-resize-handle" role="separator" aria-label="Paper detailsの幅を変更" aria-orientation="vertical" onPointerDown={startInspectorResize}><span /></div>
      <div className="inspector-top"><span>Paper details</span><button onClick={onClose}>×</button></div>
      <div className="inspector-scroll-area">
      <div className="inspector-scroll" ref={scrollRef} onScroll={measureScroll}>
        <div className="paper-file-card">
          <span className="paper-icon large-icon">PDF</span>
          <div><strong>{paper.pdfPath.split("/").at(-1)}</strong><small>{paper.pdfPath}</small></div>
          <div className="file-actions"><button onClick={onOpenPdf} disabled={pdfAvailable === false} title={pdfAvailable === false ? "PDFファイルが見つかりません" : "RillのPDFリーダーで開く"}>{pdfAvailable === false ? "PDFなし" : "Rillで読む"}</button><button onClick={onEnrich} disabled={busy}>書誌取得</button></div>
        </div>

        <section className="reading-status-control">
          <div><span>読書ステータス</span><small>PDFを開くと自動で「読書中」になります。読了は自分で選びます。</small></div>
          <div className="status-segments">
            {["未読", "読書中", "読了"].map((status) => <button key={status} className={paper.status === status ? `active ${statusTone(status)}` : ""} type="button" onClick={() => onStatusChange(status)}>{status === "未読" ? "○" : status === "読書中" ? "◐" : "●"} {status}</button>)}
          </div>
          <div className="detail-markers"><button type="button" className={paper.isFavorite ? "active" : ""} onClick={onFavoriteChange}>★ お気に入り</button><label><span>⚑</span><select aria-label="フラッグ色" value={paper.flagColor} onChange={(event) => onFlagChange(event.target.value)}><option value="">なし</option><option value="blue">青</option><option value="yellow">黄</option><option value="red">赤</option></select></label></div>
        </section>

        <label className="field collection-field"><span>保存フォルダ</span>
          <select value={paperCollection} disabled={busy} onChange={(event) => onMoveToFolder(event.target.value)}>
            <option value="__unfiled">未整理</option>
            {collections.map((collection) => <option key={collection} value={collection}>{collection}</option>)}
          </select>
        </label>

        <label className="field title-field"><span>タイトル</span><textarea value={paper.title} rows={3} onChange={(event) => onChange({ ...paper, title: event.target.value })} /></label>
        <div className="field-row">
          <label className="field"><span>著者</span><input value={paper.authors.join("; ")} onChange={(event) => onChange({ ...paper, authors: event.target.value.split(";").map((author) => author.trim()).filter(Boolean) })} /></label>
          <label className="field year-field"><span>年</span><input inputMode="numeric" value={paper.year ?? ""} onChange={(event) => onChange({ ...paper, year: event.target.value ? Number(event.target.value) : null })} /></label>
        </div>
        <div className="field-row"><label className="field"><span>雑誌</span><input value={paper.journal} onChange={(event) => onChange({ ...paper, journal: event.target.value })} /></label><label className="field"><span>略称</span><input value={paper.journalAbbreviation} placeholder="J Neurochem" onChange={(event) => onChange({ ...paper, journalAbbreviation: event.target.value })} /></label></div>
        <div className="field-row publication-row">
          <label className="field"><span>巻</span><input value={paper.volume} onChange={(event) => onChange({ ...paper, volume: event.target.value })} /></label>
          <label className="field"><span>号</span><input value={paper.issue} onChange={(event) => onChange({ ...paper, issue: event.target.value })} /></label>
          <label className="field"><span>ページ</span><input value={paper.pages} onChange={(event) => onChange({ ...paper, pages: event.target.value })} /></label>
        </div>
        <div className="field-row">
          <label className="field"><span>DOI</span><input value={paper.doi} onChange={(event) => onChange({ ...paper, doi: event.target.value })} /></label>
          <label className="field pmid-field"><span>PMID</span><input value={paper.pmid} onChange={(event) => onChange({ ...paper, pmid: event.target.value })} /></label>
        </div>
        <label className="field tag-field"><span>タグ</span><input value={tagText} placeholder="#うつ病 #薬物療法" onChange={(event) => { const value = event.target.value; setTagText(value); onChange({ ...paper, tags: parseTags(value) }); }} onBlur={() => setTagText(formatTags(parseTags(tagText)))} /><small>「#タグ #タグ」で入力。カンマ区切りも使えます。</small></label>
        <label className="field"><span>引用キー</span><input value={paper.citationKey} placeholder="Ghasemi2026Disease" onChange={(event) => onChange({ ...paper, citationKey: event.target.value.replace(/\s+/g, "") })} /></label>
        <div className="field summary-field"><div className="field-heading"><span>要約</span><button type="button" disabled={busy || !paper.summary.trim()} onClick={onTranslate}>英語から日本語へ翻訳</button></div><textarea aria-label="要約" value={paper.summary} rows={5} placeholder="Abstractまたは要約…" onChange={(event) => onChange({ ...paper, summary: event.target.value })} /></div>
        {(paper.translatedSummary || paper.summary) && <div className="field translated-summary"><span>和訳</span><textarea aria-label="和訳" value={paper.translatedSummary} rows={5} placeholder="和訳ボタンを押すとここへ保存されます" onChange={(event) => onChange({ ...paper, translatedSummary: event.target.value })} /></div>}
        <label className="field"><span>Clinical note</span><textarea value={paper.clinicalNote} rows={5} placeholder="診療でどう使うか、疑問点など…" onChange={(event) => onChange({ ...paper, clinicalNote: event.target.value })} /></label>

        <div className="note-path"><span>Markdown</span><code>{absolutePath(root, paper.notePath)}</code><small className={obsidianConnected ? "vault-status connected" : "vault-status"}>{obsidianConnected ? "● Obsidian Vault接続済み" : "○ Obsidian Vault未設定"}</small><button onClick={obsidianConnected ? onOpenNote : onObsidianSetup}>{obsidianConnected ? "Obsidianでこのノートを開く ◇" : "Obsidian Vaultを設定"}</button></div>
      </div>
      <div className="details-scrollbar" ref={trackRef} onPointerDown={jumpScrollbar} aria-label="Paper detailsのスクロールバー">
        <div
          className={canScroll ? "details-scrollbar-thumb" : "details-scrollbar-thumb disabled"}
          style={{ height: `${thumbHeight}px`, transform: `translateY(${thumbTop}px)` }}
          onPointerDown={startScrollbarDrag}
        />
      </div>
      </div>
      <div className="inspector-actions">
        <button className="trash-button" title="PDF・Markdown・注釈をRillのゴミ箱へ移動" onClick={onTrash} disabled={busy}>ゴミ箱へ移動</button>
        <div className="save-action-group"><span className={saveState === "保存エラー" ? "autosave-state error" : "autosave-state"}>{saveState}</span><button className="save-button" title="書誌情報・要約・タグをMarkdownへ保存" onClick={onSave} disabled={busy}>{busy ? "処理中…" : "変更を保存"}</button></div>
      </div>
    </aside>
  );
}
