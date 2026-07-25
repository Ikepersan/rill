use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{OnceLock, RwLock},
    time::SystemTime,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
use walkdir::WalkDir;

const LIBRARY_DIRS: [&str; 6] = ["Inbox", "Papers", "Notes", "Exports", "Trash", ".rill"];
static AUTHORIZED_LIBRARY_ROOT: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paper {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub authors: Vec<String>,
    pub year: Option<u16>,
    #[serde(default)]
    pub journal: String,
    #[serde(default)]
    pub journal_abbreviation: String,
    #[serde(default)]
    pub doi: String,
    #[serde(default)]
    pub pmid: String,
    #[serde(default)]
    pub citation_key: String,
    #[serde(default)]
    pub volume: String,
    #[serde(default)]
    pub issue: String,
    #[serde(default)]
    pub pages: String,
    #[serde(default)]
    pub is_reference: bool,
    #[serde(default)]
    pub flag_color: String,
    #[serde(default)]
    pub is_favorite: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_status")]
    pub status: String,
    pub pdf_path: String,
    pub note_path: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub translated_summary: String,
    #[serde(default)]
    pub clinical_note: String,
    pub added_at: String,
    #[serde(default)]
    pub note_revision: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub paper: Paper,
    pub deleted_at: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryIndexEntry {
    pdf_sha256: String,
    pdf_path: String,
    note_path: String,
    updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct LibraryIndex {
    version: u32,
    #[serde(default)]
    papers: HashMap<String, LibraryIndexEntry>,
}

impl Default for LibraryIndex {
    fn default() -> Self {
        Self {
            version: 1,
            papers: HashMap::new(),
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct PaperFrontmatter {
    #[serde(default)]
    rill_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    authors: Vec<String>,
    year: Option<u16>,
    #[serde(default)]
    journal: String,
    #[serde(default)]
    journal_abbreviation: String,
    #[serde(default)]
    doi: String,
    #[serde(default)]
    pmid: String,
    #[serde(default)]
    citation_key: String,
    #[serde(default)]
    volume: String,
    #[serde(default)]
    issue: String,
    #[serde(default)]
    pages: String,
    #[serde(default)]
    is_reference: bool,
    #[serde(default)]
    flag_color: String,
    #[serde(default)]
    is_favorite: bool,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default = "default_status")]
    status: String,
    #[serde(default)]
    pdf: String,
    #[serde(default)]
    added_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    imported: usize,
    skipped_duplicates: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    bibtex_path: String,
    markdown_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    paper_id: String,
    source: String,
    snippet: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CslStyleFile {
    name: String,
    xml: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationRect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    page: Option<u32>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfAnnotation {
    id: String,
    page: u32,
    text: String,
    color: String,
    #[serde(default = "default_annotation_kind")]
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image_data_url: Option<String>,
    #[serde(default)]
    comment: String,
    #[serde(default)]
    rects: Vec<AnnotationRect>,
    created_at: String,
}

fn default_annotation_kind() -> String {
    "highlight".to_string()
}

fn default_status() -> String {
    "未読".to_string()
}

fn authorized_library_root() -> &'static RwLock<Option<PathBuf>> {
    AUTHORIZED_LIBRARY_ROOT.get_or_init(|| RwLock::new(None))
}

fn authorize_library_root(path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("ライブラリの場所を確認できませんでした: {error}"))?;
    if !canonical.is_dir() {
        return Err("ライブラリにはフォルダを指定してください".into());
    }
    *authorized_library_root()
        .write()
        .map_err(|_| "ライブラリのアクセス状態を更新できませんでした".to_string())? =
        Some(canonical.clone());
    Ok(canonical)
}

fn root_path(root: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(root);
    if !path.is_absolute() {
        return Err("ライブラリには絶対パスを指定してください".into());
    }
    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("ライブラリの場所を確認できませんでした: {error}"))?;
    let authorized = authorized_library_root()
        .read()
        .map_err(|_| "ライブラリのアクセス状態を確認できませんでした".to_string())?
        .clone()
        .ok_or_else(|| {
            "ライブラリへのアクセスが許可されていません。保存場所を選び直してください"
                .to_string()
        })?;
    if canonical != authorized {
        return Err("選択中のRillライブラリ以外にはアクセスできません".into());
    }
    Ok(canonical)
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("ライブラリ外のファイルにはアクセスできません".into());
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("ライブラリの場所を確認できませんでした: {error}"))?;
    let candidate = root.join(relative_path);
    let mut existing = candidate.as_path();
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| "ライブラリ内のパスを確認できませんでした".to_string())?;
    }
    let canonical_existing = fs::canonicalize(existing)
        .map_err(|error| format!("ライブラリ内のパスを確認できませんでした: {error}"))?;
    if !canonical_existing.starts_with(&canonical_root) {
        return Err("シンボリックリンクの参照先がライブラリ外です".into());
    }
    Ok(candidate)
}

fn library_root_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("library-root.json"))
        .map_err(|error| format!("Rillの設定保存場所を確認できませんでした: {error}"))
}

fn persist_library_root(app: &AppHandle, root: &Path) -> Result<(), String> {
    let config = library_root_config_path(app)?;
    if let Some(parent) = config.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Rillの設定フォルダを作成できませんでした: {error}"))?;
    }
    let content = serde_json::to_vec_pretty(&root.to_string_lossy().to_string())
        .map_err(|error| format!("ライブラリ設定を作成できませんでした: {error}"))?;
    let temporary = config.with_extension("json.tmp");
    write_synced_then_rename(
        &temporary,
        &config,
        &content,
        "ライブラリ設定を保存できませんでした",
        "ライブラリ設定を確定できませんでした",
    )
}

fn write_synced_then_rename(
    temporary: &Path,
    destination: &Path,
    content: &[u8],
    write_message: &str,
    commit_message: &str,
) -> Result<(), String> {
    let mut file =
        File::create(temporary).map_err(|error| format!("{write_message}: {error}"))?;
    file.write_all(content)
        .map_err(|error| format!("{write_message}: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("{write_message}: {error}"))?;
    drop(file);
    fs::rename(temporary, destination).map_err(|error| format!("{commit_message}: {error}"))
}

fn library_index_path(root: &Path) -> PathBuf {
    root.join(".rill/index.json")
}

fn load_library_index(root: &Path) -> (LibraryIndex, bool) {
    let path = library_index_path(root);
    let Ok(json) = fs::read(&path) else {
        return (LibraryIndex::default(), true);
    };
    match serde_json::from_slice::<LibraryIndex>(&json) {
        Ok(index) if index.version <= 1 => (index, true),
        Ok(index) => {
            eprintln!(
                "Rill index version {} is newer than this app; leaving it unchanged",
                index.version
            );
            (index, false)
        }
        Err(error) => {
            eprintln!("Rill index is unreadable and will be rebuilt: {error}");
            (LibraryIndex::default(), true)
        }
    }
}

fn store_library_index(root: &Path, index: &LibraryIndex) -> Result<(), String> {
    let path = library_index_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("文献インデックスのフォルダを作成できませんでした: {error}"))?;
    }
    let content = serde_json::to_vec_pretty(index)
        .map_err(|error| format!("文献インデックスを作成できませんでした: {error}"))?;
    let temporary = path.with_extension("json.rilltmp");
    write_synced_then_rename(
        &temporary,
        &path,
        &content,
        "文献インデックスを保存できませんでした",
        "文献インデックスを確定できませんでした",
    )
}

fn hash_hex(path: &Path) -> Result<String, String> {
    Ok(hash_file(path)?
        .into_iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn index_entry_for_paper(
    root: &Path,
    paper: &Paper,
    existing: Option<&LibraryIndexEntry>,
    known_hash: Option<&str>,
) -> Result<LibraryIndexEntry, String> {
    let pdf = safe_join(root, &paper.pdf_path)?;
    let pdf_sha256 = match (known_hash, existing) {
        (Some(hash), _) if !hash.is_empty() => hash.to_string(),
        (_, Some(entry)) if !entry.pdf_sha256.is_empty() => entry.pdf_sha256.clone(),
        _ => hash_hex(&pdf)?,
    };
    if let Some(entry) = existing {
        if entry.pdf_sha256 == pdf_sha256
            && entry.pdf_path == paper.pdf_path
            && entry.note_path == paper.note_path
        {
            return Ok(entry.clone());
        }
    }
    Ok(LibraryIndexEntry {
        pdf_sha256,
        pdf_path: paper.pdf_path.clone(),
        note_path: paper.note_path.clone(),
        updated_at: Utc::now().to_rfc3339(),
    })
}

fn best_effort_upsert_index(root: &Path, paper: &Paper) {
    let (mut index, writable) = load_library_index(root);
    if !writable {
        return;
    }
    let entry = match index_entry_for_paper(root, paper, index.papers.get(&paper.id), None) {
        Ok(entry) => entry,
        Err(error) => {
            eprintln!("Rill index entry could not be updated: {error}");
            return;
        }
    };
    if index.papers.get(&paper.id) == Some(&entry) {
        return;
    }
    index.papers.insert(paper.id.clone(), entry);
    if let Err(error) = store_library_index(root, &index) {
        eprintln!("Rill index could not be saved: {error}");
    }
}

fn best_effort_remove_index(root: &Path, paper_id: &str) {
    let (mut index, writable) = load_library_index(root);
    if !writable || index.papers.remove(paper_id).is_none() {
        return;
    }
    if let Err(error) = store_library_index(root, &index) {
        eprintln!("Rill index could not be saved after removal: {error}");
    }
}

fn relative_string(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "ライブラリ内のパスを取得できませんでした".to_string())?;
    Ok(relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn is_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

fn pdf_paths(root: &Path) -> Vec<PathBuf> {
    ["Inbox", "Papers"]
        .iter()
        .flat_map(|folder| {
            WalkDir::new(root.join(folder))
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file() && is_pdf(entry.path()))
                .map(|entry| entry.into_path())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn file_time(path: &Path) -> String {
    let time = fs::metadata(path)
        .and_then(|metadata| metadata.created().or_else(|_| metadata.modified()))
        .unwrap_or(SystemTime::now());
    let date: DateTime<Utc> = time.into();
    date.to_rfc3339()
}

fn title_from_filename(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Untitled paper")
        .replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn year_from_filename(path: &Path) -> Option<u16> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .into_iter()
        .flat_map(|stem| stem.split(|character: char| !character.is_ascii_digit()))
        .find_map(|part| {
            if part.len() != 4 {
                return None;
            }
            part.parse::<u16>()
                .ok()
                .filter(|year| (1900..=2100).contains(year))
        })
}

fn ascii_words(value: &str) -> Vec<String> {
    value
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| word.to_string())
        .collect()
}

fn citation_key_for(paper: &Paper) -> String {
    let author = paper
        .authors
        .first()
        .and_then(|name| ascii_words(name).last().cloned())
        .or_else(|| ascii_words(&paper.title).first().cloned())
        .unwrap_or_else(|| "Paper".into());
    let title_word = ascii_words(&paper.title)
        .into_iter()
        .find(|word| {
            word.len() > 3
                && !matches!(
                    word.to_ascii_lowercase().as_str(),
                    "with" | "from" | "that" | "this" | "patients"
                )
        })
        .unwrap_or_else(|| "Study".into());
    format!(
        "{}{}{}",
        author,
        paper.year.map(|year| year.to_string()).unwrap_or_default(),
        title_word
    )
}

fn ensure_citation_key(mut paper: Paper) -> Paper {
    if paper.citation_key.trim().is_empty() {
        paper.citation_key = citation_key_for(&paper);
    }
    paper
}

fn split_frontmatter(markdown: &str) -> (Option<&str>, &str) {
    let Some(rest) = markdown.strip_prefix("---\n") else {
        return (None, markdown);
    };
    let Some(end) = rest.find("\n---\n") else {
        return (None, markdown);
    };
    (Some(&rest[..end]), &rest[end + 5..])
}

fn markdown_revision(markdown: &str) -> String {
    format!("{:x}", Sha256::digest(markdown.as_bytes()))
}

fn note_revision(path: &Path) -> String {
    fs::read_to_string(path)
        .map(|markdown| markdown_revision(&markdown))
        .unwrap_or_default()
}

fn is_valid_paper_id(paper_id: &str) -> bool {
    !paper_id.is_empty()
        && paper_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn revision_snapshot_path(root: &Path, paper_id: &str) -> Result<PathBuf, String> {
    if !is_valid_paper_id(paper_id) {
        return Err("文献IDが不正です".into());
    }
    Ok(root
        .join(".rill/revisions")
        .join(format!("{paper_id}.json")))
}

fn store_revision_snapshot(root: &Path, paper: &Paper) -> Result<(), String> {
    let path = revision_snapshot_path(root, &paper.id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("マージ履歴を作成できませんでした: {error}"))?;
    }
    fs::write(
        path,
        serde_json::to_vec(paper)
            .map_err(|error| format!("マージ履歴を変換できませんでした: {error}"))?,
    )
    .map_err(|error| format!("マージ履歴を保存できませんでした: {error}"))
}

fn load_revision_snapshot(root: &Path, paper: &Paper) -> Option<Paper> {
    let path = revision_snapshot_path(root, &paper.id).ok()?;
    let snapshot = serde_json::from_slice::<Paper>(&fs::read(path).ok()?).ok()?;
    (snapshot.note_revision == paper.note_revision).then_some(snapshot)
}

fn merge_paper_changes(base: &Paper, incoming: &Paper, current: &Paper) -> Result<Paper, String> {
    let mut merged = incoming.clone();
    let mut conflicts = Vec::new();
    macro_rules! merge_field {
        ($field:ident, $label:literal) => {
            if incoming.$field == base.$field {
                merged.$field = current.$field.clone();
            } else if current.$field != base.$field && current.$field != incoming.$field {
                conflicts.push($label);
            }
        };
    }
    merge_field!(title, "タイトル");
    merge_field!(authors, "著者");
    merge_field!(year, "年");
    merge_field!(journal, "雑誌");
    merge_field!(journal_abbreviation, "雑誌略称");
    merge_field!(doi, "DOI");
    merge_field!(pmid, "PMID");
    merge_field!(citation_key, "引用キー");
    merge_field!(volume, "巻");
    merge_field!(issue, "号");
    merge_field!(pages, "ページ");
    merge_field!(is_reference, "参考");
    merge_field!(flag_color, "フラッグ");
    merge_field!(is_favorite, "お気に入り");
    merge_field!(tags, "タグ");
    merge_field!(status, "読書状態");
    merge_field!(summary, "要約");
    merge_field!(translated_summary, "和訳");
    merge_field!(clinical_note, "Clinical note");
    if !conflicts.is_empty() {
        return Err(format!("ObsidianとRillの両方で同じ項目（{}）が変更されています。内容を失わないため保存を止めました。↻で再読込して調整してください。", conflicts.join("、")));
    }
    merged.note_revision = current.note_revision.clone();
    Ok(merged)
}

fn section(body: &str, heading: &str) -> String {
    let marker = format!("## {heading}");
    let mut reading = false;
    let mut lines = Vec::new();
    for line in body.lines() {
        if line.trim() == marker {
            reading = true;
            continue;
        }
        if reading && line.starts_with("## ") {
            break;
        }
        if reading {
            lines.push(line);
        }
    }
    lines.join("\n").trim().to_string()
}

fn paper_from_files_with_identity(
    root: &Path,
    pdf_path: &Path,
    note_path_override: Option<&Path>,
    preferred_id: Option<&str>,
) -> Result<Paper, String> {
    let pdf_relative = relative_string(root, pdf_path)?;
    let stem = pdf_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("paper");
    let note_path = note_path_override
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.join("Notes").join(format!("{stem}.md")));
    let note_relative = relative_string(root, &note_path)?;
    let default_title = title_from_filename(pdf_path);
    let default_added_at = file_time(pdf_path);

    if note_path.exists() {
        let markdown = fs::read_to_string(&note_path)
            .map_err(|error| format!("ノートを読み込めませんでした: {error}"))?;
        let (yaml, body) = split_frontmatter(&markdown);
        let frontmatter = yaml
            .and_then(|yaml| serde_yaml::from_str::<PaperFrontmatter>(yaml).ok())
            .unwrap_or_default();
        let id = is_valid_paper_id(&frontmatter.rill_id)
            .then(|| frontmatter.rill_id.clone())
            .or_else(|| {
                preferred_id
                    .filter(|id| is_valid_paper_id(id))
                    .map(str::to_string)
            })
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let paper = ensure_citation_key(Paper {
            id,
            title: if frontmatter.title.is_empty() {
                default_title
            } else {
                frontmatter.title
            },
            authors: frontmatter.authors,
            year: frontmatter.year.or_else(|| year_from_filename(pdf_path)),
            journal: frontmatter.journal,
            journal_abbreviation: frontmatter.journal_abbreviation,
            doi: frontmatter.doi,
            pmid: frontmatter.pmid,
            citation_key: frontmatter.citation_key,
            volume: frontmatter.volume,
            issue: frontmatter.issue,
            pages: frontmatter.pages,
            is_reference: frontmatter.is_reference,
            flag_color: frontmatter.flag_color,
            is_favorite: frontmatter.is_favorite,
            tags: frontmatter.tags,
            status: frontmatter.status,
            pdf_path: pdf_relative,
            note_path: note_relative,
            summary: section(body, "要約"),
            translated_summary: section(body, "和訳"),
            clinical_note: section(body, "Clinical note"),
            added_at: if frontmatter.added_at.is_empty() {
                default_added_at
            } else {
                frontmatter.added_at
            },
            note_revision: markdown_revision(&markdown),
        });
        store_revision_snapshot(root, &paper)?;
        return Ok(paper);
    }

    let paper = Paper {
        id: preferred_id
            .filter(|id| is_valid_paper_id(id))
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        title: default_title,
        authors: Vec::new(),
        year: year_from_filename(pdf_path),
        journal: String::new(),
        journal_abbreviation: String::new(),
        doi: String::new(),
        pmid: String::new(),
        citation_key: String::new(),
        volume: String::new(),
        issue: String::new(),
        pages: String::new(),
        is_reference: false,
        flag_color: String::new(),
        is_favorite: false,
        tags: Vec::new(),
        status: default_status(),
        pdf_path: pdf_relative,
        note_path: note_relative,
        summary: String::new(),
        translated_summary: String::new(),
        clinical_note: String::new(),
        added_at: default_added_at,
        note_revision: String::new(),
    };
    let mut paper = ensure_citation_key(paper);
    write_paper(root, &paper)?;
    paper.note_revision = note_revision(&note_path);
    store_revision_snapshot(root, &paper)?;
    Ok(paper)
}

fn write_paper(root: &Path, paper: &Paper) -> Result<(), String> {
    let note_path = safe_join(root, &paper.note_path)?;
    if let Some(parent) = note_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("ノートフォルダを作成できませんでした: {error}"))?;
    }
    let frontmatter = PaperFrontmatter {
        rill_id: paper.id.clone(),
        title: paper.title.clone(),
        authors: paper.authors.clone(),
        year: paper.year,
        journal: paper.journal.clone(),
        journal_abbreviation: paper.journal_abbreviation.clone(),
        doi: paper.doi.clone(),
        pmid: paper.pmid.clone(),
        citation_key: paper.citation_key.clone(),
        volume: paper.volume.clone(),
        issue: paper.issue.clone(),
        pages: paper.pages.clone(),
        is_reference: paper.is_reference,
        flag_color: paper.flag_color.clone(),
        is_favorite: paper.is_favorite,
        tags: paper.tags.clone(),
        status: paper.status.clone(),
        pdf: format!("[[{}]]", paper.pdf_path),
        added_at: paper.added_at.clone(),
    };
    let existing = fs::read_to_string(&note_path).unwrap_or_default();
    let (existing_yaml, existing_body) = split_frontmatter(&existing);
    let mut merged_yaml = existing_yaml
        .and_then(|yaml| serde_yaml::from_str::<serde_yaml::Mapping>(yaml).ok())
        .unwrap_or_default();
    let managed_yaml = serde_yaml::to_value(&frontmatter)
        .map_err(|error| format!("書誌情報をMarkdownへ変換できませんでした: {error}"))?;
    if let serde_yaml::Value::Mapping(managed) = managed_yaml {
        for (key, value) in managed {
            merged_yaml.insert(key, value);
        }
    }
    let yaml = serde_yaml::to_string(&merged_yaml)
        .map_err(|error| format!("書誌情報をMarkdownへ変換できませんでした: {error}"))?;
    let body = if existing_body.trim().is_empty() {
        format!(
            "# {}\n\n## 要約\n\n\n\n## Clinical note\n\n\n\n## Highlights\n\n\n\n## PDF\n\n[[{}]]\n",
            paper.title, paper.pdf_path
        )
    } else {
        existing_body.to_string()
    };
    let body = replace_markdown_section(&body, "要約", &paper.summary);
    let body = replace_markdown_section(&body, "和訳", &paper.translated_summary);
    let body = replace_markdown_section(&body, "Clinical note", &paper.clinical_note);
    let body = replace_markdown_section(&body, "PDF", &format!("[[{}]]", paper.pdf_path));
    let markdown = format!("---\n{yaml}---\n\n{}", body.trim_start());
    let temporary = note_path.with_extension("md.rilltmp");
    write_synced_then_rename(
        &temporary,
        &note_path,
        markdown.as_bytes(),
        "ノートを保存できませんでした",
        "ノートを確定できませんでした",
    )?;
    Ok(())
}

fn hash_file(path: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|error| format!("PDFを開けませんでした: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let bytes = reader
            .read(&mut buffer)
            .map_err(|error| format!("PDFを読み込めませんでした: {error}"))?;
        if bytes == 0 {
            break;
        }
        hasher.update(&buffer[..bytes]);
    }
    Ok(hasher.finalize().to_vec())
}

fn metadata_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Rill/0.2 (local medical literature manager)")
        .build()
        .map_err(|error| format!("書誌情報サービスへ接続できません: {error}"))
}

fn response_json(response: reqwest::blocking::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!("書誌情報を取得できませんでした（HTTP {status}）"));
    }
    response
        .json::<serde_json::Value>()
        .map_err(|error| format!("書誌情報を読み取れませんでした: {error}"))
}

fn json_string(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn year_from_text(value: &str) -> Option<u16> {
    value
        .split(|character: char| !character.is_ascii_digit())
        .find_map(|part| {
            (part.len() == 4)
                .then(|| part.parse::<u16>().ok())
                .flatten()
        })
}

fn crossref_year(message: &serde_json::Value) -> Option<u16> {
    ["published-print", "published-online", "published", "issued"]
        .iter()
        .find_map(|key| {
            message
                .get(*key)?
                .get("date-parts")?
                .get(0)?
                .get(0)?
                .as_u64()
                .and_then(|year| u16::try_from(year).ok())
        })
}

fn strip_markup(value: &str) -> String {
    let mut output = String::new();
    let mut inside_tag = false;
    for character in value.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => output.push(character),
            _ => {}
        }
    }
    output
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn apply_crossref(mut paper: Paper, message: &serde_json::Value) -> Paper {
    let title = json_string(message.get("title").and_then(|value| value.get(0)));
    if !title.is_empty() {
        paper.title = strip_markup(&title);
    }
    let authors = message
        .get("author")
        .and_then(serde_json::Value::as_array)
        .map(|authors| {
            authors
                .iter()
                .map(|author| {
                    let given = json_string(author.get("given"));
                    let family = json_string(author.get("family"));
                    format!("{given} {family}").trim().to_string()
                })
                .filter(|author| !author.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !authors.is_empty() {
        paper.authors = authors;
    }
    let journal = json_string(
        message
            .get("container-title")
            .and_then(|value| value.get(0)),
    );
    if !journal.is_empty() {
        paper.journal = journal;
    }
    let journal_abbreviation = json_string(
        message
            .get("short-container-title")
            .and_then(|value| value.get(0)),
    );
    if !journal_abbreviation.is_empty() {
        paper.journal_abbreviation = journal_abbreviation;
    }
    let doi = json_string(message.get("DOI"));
    if !doi.is_empty() {
        paper.doi = doi;
    }
    if let Some(year) = crossref_year(message) {
        paper.year = Some(year);
    }
    let volume = json_string(message.get("volume"));
    if !volume.is_empty() {
        paper.volume = volume;
    }
    let issue = json_string(message.get("issue"));
    if !issue.is_empty() {
        paper.issue = issue;
    }
    let pages = json_string(message.get("page"));
    if !pages.is_empty() {
        paper.pages = pages;
    }
    let abstract_text = json_string(message.get("abstract"));
    if paper.summary.trim().is_empty() && !abstract_text.is_empty() {
        paper.summary = strip_markup(&abstract_text);
    }
    paper.citation_key.clear();
    ensure_citation_key(paper)
}

fn enrich_from_crossref(paper: Paper) -> Result<Paper, String> {
    let client = metadata_client()?;
    let value = if !paper.doi.trim().is_empty() {
        let mut url = reqwest::Url::parse("https://api.crossref.org/works/")
            .map_err(|error| format!("Crossref URLを作成できません: {error}"))?;
        url.path_segments_mut()
            .map_err(|_| "Crossref URLを作成できません".to_string())?
            .push(paper.doi.trim());
        response_json(
            client
                .get(url)
                .send()
                .map_err(|error| format!("Crossrefへ接続できません: {error}"))?,
        )?
        .get("message")
        .cloned()
        .ok_or_else(|| "Crossrefに書誌情報がありません".to_string())?
    } else {
        let response = client
            .get("https://api.crossref.org/works")
            .query(&[("query.bibliographic", paper.title.as_str()), ("rows", "1")])
            .send()
            .map_err(|error| format!("Crossrefへ接続できません: {error}"))?;
        response_json(response)?
            .pointer("/message/items/0")
            .cloned()
            .ok_or_else(|| "タイトルに一致する書誌情報が見つかりません".to_string())?
    };
    Ok(apply_crossref(paper, &value))
}

fn enrich_from_pubmed(mut paper: Paper) -> Result<Paper, String> {
    let client = metadata_client()?;
    let response = client
        .get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi")
        .query(&[
            ("db", "pubmed"),
            ("id", paper.pmid.trim()),
            ("retmode", "json"),
            ("tool", "rill"),
        ])
        .send()
        .map_err(|error| format!("PubMedへ接続できません: {error}"))?;
    let value = response_json(response)?;
    let record = value
        .get("result")
        .and_then(|result| result.get(paper.pmid.trim()))
        .ok_or_else(|| "PMIDに一致するPubMed文献が見つかりません".to_string())?;
    let title = json_string(record.get("title"));
    if !title.is_empty() {
        paper.title = strip_markup(&title);
    }
    let authors = record
        .get("authors")
        .and_then(serde_json::Value::as_array)
        .map(|authors| {
            authors
                .iter()
                .map(|author| json_string(author.get("name")))
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !authors.is_empty() {
        paper.authors = authors;
    }
    let journal = json_string(record.get("fulljournalname"));
    if !journal.is_empty() {
        paper.journal = journal;
    }
    let journal_abbreviation = json_string(record.get("source"));
    if !journal_abbreviation.is_empty() {
        paper.journal_abbreviation = journal_abbreviation;
    }
    paper.year = year_from_text(&json_string(record.get("pubdate"))).or(paper.year);
    let volume = json_string(record.get("volume"));
    if !volume.is_empty() {
        paper.volume = volume;
    }
    let issue = json_string(record.get("issue"));
    if !issue.is_empty() {
        paper.issue = issue;
    }
    let pages = json_string(record.get("pages"));
    if !pages.is_empty() {
        paper.pages = pages;
    }
    if let Some(ids) = record
        .get("articleids")
        .and_then(serde_json::Value::as_array)
    {
        if let Some(doi) = ids.iter().find(|id| json_string(id.get("idtype")) == "doi") {
            paper.doi = json_string(doi.get("value"));
        }
    }
    paper.citation_key.clear();
    let paper = ensure_citation_key(paper);
    if paper.doi.is_empty() {
        Ok(paper)
    } else {
        enrich_from_crossref(paper.clone()).or(Ok(paper))
    }
}

fn bibtex_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('{', "\\{")
        .replace('}', "\\}")
}

fn bibtex_entry(paper: &Paper) -> String {
    let mut fields = vec![format!("  title = {{{}}}", bibtex_escape(&paper.title))];
    if !paper.authors.is_empty() {
        fields.push(format!(
            "  author = {{{}}}",
            bibtex_escape(&paper.authors.join(" and "))
        ));
    }
    if let Some(year) = paper.year {
        fields.push(format!("  year = {{{year}}}"));
    }
    if !paper.journal.is_empty() {
        fields.push(format!("  journal = {{{}}}", bibtex_escape(&paper.journal)));
    }
    if !paper.doi.is_empty() {
        fields.push(format!("  doi = {{{}}}", bibtex_escape(&paper.doi)));
    }
    if !paper.pmid.is_empty() {
        fields.push(format!("  pmid = {{{}}}", bibtex_escape(&paper.pmid)));
    }
    if !paper.volume.is_empty() {
        fields.push(format!("  volume = {{{}}}", bibtex_escape(&paper.volume)));
    }
    if !paper.issue.is_empty() {
        fields.push(format!("  number = {{{}}}", bibtex_escape(&paper.issue)));
    }
    if !paper.pages.is_empty() {
        fields.push(format!("  pages = {{{}}}", bibtex_escape(&paper.pages)));
    }
    format!(
        "@article{{{},\n{}\n}}",
        paper.citation_key,
        fields.join(",\n")
    )
}

fn citation_author(name: &str) -> String {
    if name.contains(',') {
        return name.trim().to_string();
    }
    let words = name.split_whitespace().collect::<Vec<_>>();
    if words.is_empty() {
        return String::new();
    }
    if words.len() == 1 {
        return words[0].to_string();
    }
    let last = words.last().copied().unwrap_or_default();
    let looks_like_initials = last.len() <= 5
        && last
            .chars()
            .all(|character| character.is_alphabetic() && character.is_uppercase());
    let (surname, given) = if looks_like_initials {
        (words[0], &words[1..])
    } else {
        (last, &words[..words.len() - 1])
    };
    let initials = given
        .iter()
        .flat_map(|word| {
            let letters = word
                .chars()
                .filter(|character| character.is_alphabetic())
                .collect::<Vec<_>>();
            if word.len() <= 5 && word.chars().all(|character| character.is_uppercase()) {
                letters
            } else {
                letters.into_iter().take(1).collect()
            }
        })
        .map(|character| format!("{}.", character.to_uppercase()))
        .collect::<String>();
    if initials.is_empty() {
        surname.to_string()
    } else {
        format!("{surname}, {initials}")
    }
}

fn formatted_reference(paper: &Paper) -> String {
    let mut authors = paper
        .authors
        .iter()
        .take(10)
        .map(|author| citation_author(author))
        .filter(|author| !author.is_empty())
        .collect::<Vec<_>>()
        .join("; ");
    if paper.authors.len() > 10 {
        authors.push_str("; et al.");
    }
    if !authors.is_empty() && !authors.ends_with('.') {
        authors.push('.');
    }
    let journal = if paper.journal.is_empty() {
        String::new()
    } else {
        format!(" *{}*", paper.journal)
    };
    let year = paper
        .year
        .map(|year| format!(" {year}"))
        .unwrap_or_default();
    let volume = if paper.volume.is_empty() {
        String::new()
    } else {
        format!(", **{}**", paper.volume)
    };
    let issue = if paper.issue.is_empty() {
        String::new()
    } else {
        format!("({})", paper.issue)
    };
    let pages = if paper.pages.is_empty() {
        String::new()
    } else {
        format!(", {}", paper.pages)
    };
    format!(
        "{} {}.{}{}{}{}{}.",
        authors, paper.title, journal, year, volume, issue, pages
    )
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
}

fn short_reference(paper: &Paper) -> String {
    let lead = paper
        .authors
        .first()
        .map(|author| citation_author(author))
        .and_then(|author| author.split(',').next().map(str::trim).map(str::to_string))
        .filter(|author| !author.is_empty())
        .unwrap_or_else(|| "著者不明".into());
    let authors = if paper.authors.len() > 1 {
        format!("{lead} et al.")
    } else {
        format!("{lead}.")
    };
    let journal = if !paper.journal_abbreviation.is_empty() {
        &paper.journal_abbreviation
    } else if paper.journal.is_empty() {
        "誌名未登録"
    } else {
        &paper.journal
    };
    let year = paper
        .year
        .map(|year| year.to_string())
        .unwrap_or_else(|| "年不明".into());
    format!("{authors} {journal}, {year}")
}

fn unique_destination(folder: &Path, source: &Path) -> PathBuf {
    let filename = source.file_name().unwrap_or_default();
    let direct = folder.join(filename);
    if !direct.exists() {
        return direct;
    }
    let stem = source
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("paper");
    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("pdf");
    for suffix in 2..10_000 {
        let candidate = folder.join(format!("{stem}-{suffix}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    folder.join(format!("{}.{extension}", Uuid::new_v4()))
}

fn initialize_library_path(root: &Path) -> Result<(), String> {
    for folder in LIBRARY_DIRS {
        fs::create_dir_all(root.join(folder))
            .map_err(|error| format!("{folder}フォルダを作成できませんでした: {error}"))?;
    }
    let settings = root.join(".rill/settings.json");
    if !settings.exists() {
        fs::write(settings, "{\n  \"formatVersion\": 1\n}\n")
            .map_err(|error| format!("Rill設定を作成できませんでした: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn restore_library_root(app: AppHandle) -> Result<Option<String>, String> {
    let config = library_root_config_path(&app)?;
    if !config.is_file() {
        return Ok(None);
    }
    let stored = fs::read_to_string(&config)
        .map_err(|error| format!("ライブラリ設定を読み込めませんでした: {error}"))?;
    let path = serde_json::from_str::<String>(&stored)
        .map(PathBuf::from)
        .map_err(|error| format!("ライブラリ設定が壊れています: {error}"))?;
    if !path.is_dir() {
        return Ok(None);
    }
    let canonical = authorize_library_root(&path)?;
    initialize_library_path(&canonical)?;
    Ok(Some(canonical.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn migrate_library_root(app: AppHandle, root: String) -> Result<Option<String>, String> {
    if library_root_config_path(&app)?.is_file() {
        return restore_library_root(app);
    }
    let path = PathBuf::from(root);
    if !path.is_absolute()
        || !path.join(".rill/settings.json").is_file()
        || !path.join("Notes").is_dir()
    {
        return Ok(None);
    }
    let canonical = authorize_library_root(&path)?;
    persist_library_root(&app, &canonical)?;
    initialize_library_path(&canonical)?;
    Ok(Some(canonical.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn choose_library_root(app: AppHandle) -> Result<Option<String>, String> {
    let Some(selection) = app
        .dialog()
        .file()
        .set_title("Rillライブラリを選択")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let path = selection
        .into_path()
        .map_err(|error| format!("選択したフォルダを読み取れませんでした: {error}"))?;
    let canonical = authorize_library_root(&path)?;
    initialize_library_path(&canonical)?;
    persist_library_root(&app, &canonical)?;
    Ok(Some(canonical.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn initialize_library(root: String) -> Result<(), String> {
    let root = root_path(&root)?;
    initialize_library_path(&root)
}

#[tauri::command]
pub fn scan_library(root: String) -> Result<Vec<Paper>, String> {
    let root = root_path(&root)?;
    initialize_library(root.to_string_lossy().to_string())?;
    let (mut index, index_writable) = load_library_index(&root);
    let original_index = index.clone();
    let mut claimed_ids = HashSet::new();
    let mut papers = Vec::new();
    for path in pdf_paths(&root) {
        let pdf_relative = relative_string(&root, &path)?;
        let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("paper");
        let stem_note = root.join("Notes").join(format!("{stem}.md"));
        let mut preferred_id = None;
        let mut note_override = None;
        let mut known_hash = None;
        let mut relinked = false;

        let mut exact_ids = index
            .papers
            .iter()
            .filter(|(id, entry)| entry.pdf_path == pdf_relative && !claimed_ids.contains(*id))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        exact_ids.sort();
        if let Some(id) = exact_ids.first() {
            if let Some(entry) = index.papers.get(id) {
                if let Ok(note) = safe_join(&root, &entry.note_path) {
                    preferred_id = Some(id.clone());
                    note_override = Some(note);
                    known_hash = (!entry.pdf_sha256.is_empty()).then(|| entry.pdf_sha256.clone());
                }
            }
        }

        if preferred_id.is_none() && stem_note.is_file() {
            note_override = Some(stem_note);
        }

        if preferred_id.is_none() && note_override.is_none() {
            let pdf_hash = hash_hex(&path)?;
            let mut candidates = index
                .papers
                .iter()
                .filter(|(id, entry)| {
                    !claimed_ids.contains(*id)
                        && entry.pdf_sha256 == pdf_hash
                        && safe_join(&root, &entry.pdf_path)
                            .map(|recorded| !recorded.is_file())
                            .unwrap_or(false)
                })
                .map(|(id, entry)| (id.clone(), entry.clone()))
                .collect::<Vec<_>>();
            candidates.sort_by(|left, right| left.0.cmp(&right.0));
            if candidates.len() > 1 {
                let stem_matches = candidates
                    .iter()
                    .filter(|(_, entry)| {
                        Path::new(&entry.note_path)
                            .file_stem()
                            .and_then(|value| value.to_str())
                            == Some(stem)
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                if stem_matches.len() == 1 {
                    candidates = stem_matches;
                }
            }
            if candidates.len() == 1 {
                let (id, entry) = candidates.remove(0);
                if let Ok(note) = safe_join(&root, &entry.note_path) {
                    preferred_id = Some(id);
                    note_override = Some(note);
                    known_hash = Some(pdf_hash);
                    relinked = true;
                }
            }
        }

        let paper = paper_from_files_with_identity(
            &root,
            &path,
            note_override.as_deref(),
            preferred_id.as_deref(),
        )?;
        if index_writable {
            if let Some(index_id) = preferred_id.as_deref() {
                if index_id != paper.id {
                    index.papers.remove(index_id);
                }
            }
        }
        if relinked {
            write_paper(&root, &paper)?;
        }
        if claimed_ids.insert(paper.id.clone()) {
            if index_writable {
                match index_entry_for_paper(
                    &root,
                    &paper,
                    index.papers.get(&paper.id),
                    known_hash.as_deref(),
                ) {
                    Ok(entry) => {
                        index.papers.insert(paper.id.clone(), entry);
                    }
                    Err(error) => {
                        eprintln!("Rill index entry could not be rebuilt: {error}");
                    }
                }
            }
        } else {
            eprintln!(
                "Duplicate rill_id {} detected; leaving files unchanged",
                paper.id
            );
        }
        papers.push(paper);
    }
    if index_writable && index != original_index {
        if let Err(error) = store_library_index(&root, &index) {
            eprintln!("Rill index could not be saved after scan: {error}");
        }
    }
    papers.sort_by(|left, right| right.added_at.cmp(&left.added_at));
    Ok(papers)
}

fn text_snippet(text: &str, query: &str) -> String {
    text.lines()
        .find(|line| line.to_lowercase().contains(&query.to_lowercase()))
        .unwrap_or(text)
        .chars()
        .take(180)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[tauri::command]
pub fn search_library(root: String, query: String) -> Result<Vec<SearchHit>, String> {
    let root = root_path(&root)?;
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let papers = scan_library(root.to_string_lossy().to_string())?;
    let mut hits = Vec::new();
    let mut pdf_by_path = HashMap::new();
    for paper in &papers {
        if let Ok(note_path) = safe_join(&root, &paper.note_path) {
            if let Ok(markdown) = fs::read_to_string(note_path) {
                if markdown.to_lowercase().contains(&query.to_lowercase()) {
                    hits.push(SearchHit {
                        paper_id: paper.id.clone(),
                        source: "Markdown".into(),
                        snippet: text_snippet(&markdown, query),
                    });
                }
            }
        }
        if let Ok(pdf_path) = safe_join(&root, &paper.pdf_path) {
            pdf_by_path.insert(pdf_path.to_string_lossy().to_string(), paper.id.clone());
        }
    }
    let output = Command::new("mdfind")
        .args(["-onlyin", root.to_string_lossy().as_ref(), query])
        .output()
        .map_err(|error| format!("macOS全文検索を開始できませんでした: {error}"))?;
    if output.status.success() {
        let mut seen = HashSet::new();
        for path in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some(paper_id) = pdf_by_path.get(path) {
                if seen.insert(paper_id.clone()) {
                    hits.push(SearchHit {
                        paper_id: paper_id.clone(),
                        source: "PDF".into(),
                        snippet: "PDF本文に一致（macOS Spotlight）".into(),
                    });
                }
            }
        }
    }
    Ok(hits)
}

#[tauri::command]
pub async fn read_csl_style(app: AppHandle) -> Result<Option<CslStyleFile>, String> {
    let Some(selection) = app
        .dialog()
        .file()
        .set_title("CSL引用スタイルを追加")
        .add_filter("Citation Style Language", &["csl"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = selection
        .into_path()
        .map_err(|error| format!("選択したCSLファイルを読み取れませんでした: {error}"))?;
    if !path.is_file()
        || !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("csl"))
    {
        return Err(".csl形式の引用スタイルを選択してください".into());
    }
    if fs::metadata(&path)
        .map_err(|error| format!("CSLスタイルを確認できませんでした: {error}"))?
        .len()
        > 2 * 1024 * 1024
    {
        return Err("CSLスタイルは2MB以下のファイルを選択してください".into());
    }
    let xml = fs::read_to_string(&path)
        .map_err(|error| format!("CSLスタイルを読み込めませんでした: {error}"))?;
    if !xml.contains("<style")
        || !xml.contains("citationstyles.org") && !xml.contains("xbiblio/csl")
    {
        return Err("有効なCSLスタイルではありません".into());
    }
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("custom-style")
        .to_string();
    Ok(Some(CslStyleFile { name, xml }))
}

#[tauri::command]
pub async fn read_citation_preset(app: AppHandle) -> Result<Option<String>, String> {
    let Some(selection) = app
        .dialog()
        .file()
        .set_title("引用テンプレートJSONを読み込む")
        .add_filter("Rill Citation Template", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = selection
        .into_path()
        .map_err(|error| format!("選択したJSONファイルを読み取れませんでした: {error}"))?;
    if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
        return Err("JSONファイルを選択してください".into());
    }
    if fs::metadata(&path)
        .map_err(|error| format!("テンプレートJSONを確認できませんでした: {error}"))?
        .len()
        > 1024 * 1024
    {
        return Err("テンプレートJSONは1MB以下のファイルを選択してください".into());
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|error| format!("テンプレートJSONを読み込めませんでした: {error}"))
}

#[tauri::command]
pub async fn write_citation_preset(
    app: AppHandle,
    content: String,
    suggested_name: String,
) -> Result<bool, String> {
    if content.len() > 1024 * 1024 {
        return Err("テンプレートJSONが大きすぎます".into());
    }
    let file_name = Path::new(&suggested_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Rill Citation.rill-citation.json");
    let Some(selection) = app
        .dialog()
        .file()
        .set_title("引用テンプレートを書き出す")
        .set_file_name(file_name)
        .add_filter("Rill Citation Template", &["json"])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = selection
        .into_path()
        .map_err(|error| format!("選択した保存先を読み取れませんでした: {error}"))?;
    if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
        return Err("保存先は.jsonファイルにしてください".into());
    }
    fs::write(&path, content)
        .map(|_| true)
        .map_err(|error| format!("テンプレートJSONを書き出せませんでした: {error}"))
}

#[tauri::command]
pub fn translate_summary(text: String) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("翻訳する要約がありません".into());
    }
    let executable = std::env::current_exe()
        .map_err(|error| format!("Rillの実行場所を確認できません: {error}"))?;
    let bundled = executable
        .parent()
        .unwrap_or(Path::new("."))
        .join("rill-translate");
    let development =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/rill-translate-aarch64-apple-darwin");
    let helper = if bundled.is_file() {
        bundled
    } else {
        development
    };
    if !helper.is_file() {
        return Err("Apple翻訳コンポーネントが見つかりません".into());
    }
    let mut child = Command::new(helper)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("Apple翻訳を開始できません: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "翻訳入力を開けません".to_string())?;
    stdin
        .write_all(text.as_bytes())
        .map_err(|error| format!("要約を翻訳へ渡せません: {error}"))?;
    drop(stdin);
    let output = child
        .wait_with_output()
        .map_err(|error| format!("翻訳結果を受け取れません: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let translated = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if translated.is_empty() {
        Err("Apple翻訳から結果が返りませんでした".into())
    } else {
        Ok(translated)
    }
}

#[tauri::command]
pub fn import_pdfs(root: String, source_paths: Vec<String>) -> Result<ImportResult, String> {
    let root = root_path(&root)?;
    initialize_library(root.to_string_lossy().to_string())?;
    let mut known_hashes = HashSet::new();
    for existing in pdf_paths(&root) {
        if let Ok(hash) = hash_file(&existing) {
            known_hashes.insert(hash);
        }
    }

    let mut imported = 0;
    let mut skipped_duplicates = 0;
    for source in source_paths {
        let source = PathBuf::from(source);
        if !source.is_file() || !is_pdf(&source) {
            continue;
        }
        let hash = hash_file(&source)?;
        if known_hashes.contains(&hash) {
            skipped_duplicates += 1;
            continue;
        }
        let destination = unique_destination(&root.join("Inbox"), &source);
        fs::copy(&source, &destination)
            .map_err(|error| format!("PDFをInboxへ追加できませんでした: {error}"))?;
        known_hashes.insert(hash);
        imported += 1;
    }
    Ok(ImportResult {
        imported,
        skipped_duplicates,
    })
}

#[tauri::command]
pub fn save_paper(root: String, paper: Paper) -> Result<Paper, String> {
    let root = root_path(&root)?;
    let mut paper = ensure_citation_key(paper);
    let note_path = safe_join(&root, &paper.note_path)?;
    if note_path.exists()
        && !paper.note_revision.is_empty()
        && note_revision(&note_path) != paper.note_revision
    {
        let base = load_revision_snapshot(&root, &paper).ok_or_else(|| "Obsidian側の更新を検出しました。安全なマージ履歴がないため、↻で再読込してください。".to_string())?;
        let current = paper_from_files_with_identity(
            &root,
            &safe_join(&root, &paper.pdf_path)?,
            Some(&note_path),
            Some(&paper.id),
        )?;
        paper = merge_paper_changes(&base, &paper, &current)?;
    }
    write_paper(&root, &paper)?;
    paper.note_revision = note_revision(&note_path);
    store_revision_snapshot(&root, &paper)?;
    best_effort_upsert_index(&root, &paper);
    Ok(paper)
}

#[tauri::command]
pub fn enrich_metadata(root: String, paper: Paper) -> Result<Paper, String> {
    root_path(&root)?;
    if paper.pmid.trim().is_empty() {
        enrich_from_crossref(paper)
    } else {
        enrich_from_pubmed(paper)
    }
}

#[tauri::command]
pub fn organize_paper(root: String, mut paper: Paper) -> Result<Paper, String> {
    let root = root_path(&root)?;
    let note_path = safe_join(&root, &paper.note_path)?;
    if note_path.exists()
        && !paper.note_revision.is_empty()
        && note_revision(&note_path) != paper.note_revision
    {
        return Err("Obsidian側の更新を検出しました。↻で再読込してから移動してください。".into());
    }
    if !paper.pdf_path.starts_with("Inbox/") {
        return Ok(paper);
    }
    let source = safe_join(&root, &paper.pdf_path)?;
    let destination = unique_destination(&root.join("Papers"), &source);
    fs::rename(&source, &destination)
        .map_err(|error| format!("PDFをPapersへ移動できませんでした: {error}"))?;
    paper.pdf_path = relative_string(&root, &destination)?;
    write_paper(&root, &paper)?;
    paper.note_revision = note_revision(&safe_join(&root, &paper.note_path)?);
    store_revision_snapshot(&root, &paper)?;
    best_effort_upsert_index(&root, &paper);
    Ok(paper)
}

fn collection_root(root: &Path, collection: &str) -> Result<PathBuf, String> {
    if collection.trim().is_empty() {
        return Ok(root.join("Papers"));
    }
    safe_join(&root.join("Papers"), collection.trim())
}

#[tauri::command]
pub fn list_collections(root: String) -> Result<Vec<String>, String> {
    let root = root_path(&root)?;
    initialize_library(root.to_string_lossy().to_string())?;
    let papers_root = root.join("Papers");
    let mut collections = WalkDir::new(&papers_root)
        .min_depth(1)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_dir())
        .filter_map(|entry| relative_string(&papers_root, entry.path()).ok())
        .collect::<Vec<_>>();
    collections.sort_by_key(|path| path.to_lowercase());
    Ok(collections)
}

#[tauri::command]
pub fn create_collection(root: String, parent: String, name: String) -> Result<String, String> {
    let root = root_path(&root)?;
    initialize_library(root.to_string_lossy().to_string())?;
    let name = name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
    {
        return Err("フォルダ名には /、\\、: を使用できません".into());
    }
    let relative = if parent.trim().is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", parent.trim().trim_end_matches('/'), name)
    };
    let destination = collection_root(&root, &relative)?;
    fs::create_dir_all(&destination)
        .map_err(|error| format!("フォルダを作成できませんでした: {error}"))?;
    Ok(relative)
}

#[tauri::command]
pub fn delete_collection(root: String, collection: String) -> Result<(), String> {
    let root = root_path(&root)?;
    if collection.trim().is_empty() || collection.starts_with("__") {
        return Err("このフォルダは削除できません".into());
    }
    let target = collection_root(&root, &collection)?;
    if !target.is_dir() {
        return Err("フォルダが見つかりません".into());
    }
    if target
        .read_dir()
        .map_err(|error| format!("フォルダを確認できませんでした: {error}"))?
        .next()
        .is_some()
    {
        return Err("中に論文または子フォルダがあります。先に移動してください".into());
    }
    fs::remove_dir(&target).map_err(|error| format!("フォルダを削除できませんでした: {error}"))
}

#[tauri::command]
pub fn move_paper_to_collection(
    root: String,
    mut paper: Paper,
    collection: String,
) -> Result<Paper, String> {
    let root = root_path(&root)?;
    let note_path = safe_join(&root, &paper.note_path)?;
    if note_path.exists()
        && !paper.note_revision.is_empty()
        && note_revision(&note_path) != paper.note_revision
    {
        return Err("Obsidian側の更新を検出しました。↻で再読込してから移動してください。".into());
    }
    let source = safe_join(&root, &paper.pdf_path)?;
    if !source.is_file() || !is_pdf(&source) {
        return Err("移動するPDFが見つかりません".into());
    }
    let target_folder = if collection == "__inbox" {
        root.join("Inbox")
    } else {
        collection_root(&root, &collection)?
    };
    fs::create_dir_all(&target_folder)
        .map_err(|error| format!("移動先フォルダを作成できませんでした: {error}"))?;
    if source.parent() == Some(target_folder.as_path()) {
        return Ok(paper);
    }
    let destination = unique_destination(&target_folder, &source);
    fs::rename(&source, &destination)
        .map_err(|error| format!("PDFをフォルダへ移動できませんでした: {error}"))?;
    paper.pdf_path = relative_string(&root, &destination)?;
    write_paper(&root, &paper)?;
    paper.note_revision = note_revision(&safe_join(&root, &paper.note_path)?);
    store_revision_snapshot(&root, &paper)?;
    best_effort_upsert_index(&root, &paper);
    Ok(paper)
}

fn trash_entry_dir(root: &Path, paper_id: &str) -> Result<PathBuf, String> {
    if paper_id.is_empty()
        || !paper_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("文献IDが不正です".into());
    }
    Ok(root.join("Trash").join(paper_id))
}

fn trash_manifest_path(root: &Path, paper_id: &str) -> Result<PathBuf, String> {
    Ok(trash_entry_dir(root, paper_id)?.join("paper.json"))
}

fn paper_managed_relatives(paper: &Paper) -> Vec<String> {
    vec![
        paper.pdf_path.clone(),
        paper.note_path.clone(),
        format!(".rill/annotations/{}.json", paper.id),
        format!(".rill/revisions/{}.json", paper.id),
    ]
}

fn move_files_with_rollback(pairs: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    for (_, destination) in pairs {
        if destination.exists() {
            return Err(format!(
                "移動先に同名のファイルがあります: {}",
                destination.to_string_lossy()
            ));
        }
    }
    let mut moved = Vec::new();
    for (source, destination) in pairs {
        if let Some(parent) = destination.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                let rollback_errors = rollback_moved_files(&moved);
                return Err(move_failure_message(
                    format!("移動先フォルダを作成できませんでした: {error}"),
                    rollback_errors,
                ));
            }
        }
        if let Err(error) = fs::rename(source, destination) {
            let rollback_errors = rollback_moved_files(&moved);
            return Err(move_failure_message(
                format!("文献ファイルを移動できませんでした: {error}"),
                rollback_errors,
            ));
        }
        moved.push((source.clone(), destination.clone()));
    }
    Ok(())
}

fn rollback_moved_files(moved: &[(PathBuf, PathBuf)]) -> Vec<String> {
    moved
        .iter()
        .rev()
        .filter_map(|(original, relocated)| {
            fs::rename(relocated, original).err().map(|error| {
                format!(
                    "{} → {}: {error}",
                    relocated.to_string_lossy(),
                    original.to_string_lossy()
                )
            })
        })
        .collect()
}

fn move_failure_message(message: String, rollback_errors: Vec<String>) -> String {
    if rollback_errors.is_empty() {
        message
    } else {
        format!(
            "{message}。一部ファイルを元へ戻せませんでした。Rillのゴミ箱を残しています: {}",
            rollback_errors.join(" / ")
        )
    }
}

fn move_was_fully_rolled_back(pairs: &[(PathBuf, PathBuf)]) -> bool {
    pairs
        .iter()
        .all(|(source, destination)| source.exists() && !destination.exists())
}

fn load_trash_entry(root: &Path, paper_id: &str) -> Result<TrashEntry, String> {
    let manifest = trash_manifest_path(root, paper_id)?;
    let json = fs::read_to_string(manifest)
        .map_err(|error| format!("ゴミ箱の復元情報を読み込めませんでした: {error}"))?;
    serde_json::from_str(&json).map_err(|error| format!("ゴミ箱の復元情報が壊れています: {error}"))
}

#[tauri::command]
pub fn move_paper_to_rill_trash(root: String, paper: Paper) -> Result<TrashEntry, String> {
    let root = root_path(&root)?;
    initialize_library(root.to_string_lossy().to_string())?;
    let pdf = safe_join(&root, &paper.pdf_path)?;
    let note = safe_join(&root, &paper.note_path)?;
    if !pdf.is_file() || !is_pdf(&pdf) {
        return Err("ゴミ箱へ移動するPDFが見つかりません".into());
    }
    if !note.is_file() {
        return Err("Markdownノートが見つかりません。ライブラリを再読込してください".into());
    }
    let entry_dir = trash_entry_dir(&root, &paper.id)?;
    if entry_dir.exists() {
        return Err("この文献はすでにRillのゴミ箱にあります".into());
    }
    fs::create_dir_all(&entry_dir)
        .map_err(|error| format!("Rillのゴミ箱を作成できませんでした: {error}"))?;
    let entry = TrashEntry {
        paper: paper.clone(),
        deleted_at: Utc::now().to_rfc3339(),
    };
    let manifest = trash_manifest_path(&root, &paper.id)?;
    let json = serde_json::to_vec_pretty(&entry)
        .map_err(|error| format!("復元情報を作成できませんでした: {error}"))?;
    let manifest_temporary = manifest.with_extension("json.rilltmp");
    if let Err(error) = write_synced_then_rename(
        &manifest_temporary,
        &manifest,
        &json,
        "復元情報を保存できませんでした",
        "復元情報を確定できませんでした",
    ) {
        let _ = fs::remove_dir_all(&entry_dir);
        return Err(error);
    }
    let pairs = paper_managed_relatives(&paper)
        .into_iter()
        .map(|relative| {
            let source = safe_join(&root, &relative)?;
            let destination = safe_join(&entry_dir, &relative)?;
            Ok((source, destination))
        })
        .collect::<Result<Vec<_>, String>>()?
        .into_iter()
        .filter(|(source, _)| source.exists())
        .collect::<Vec<_>>();
    if let Err(error) = move_files_with_rollback(&pairs) {
        if move_was_fully_rolled_back(&pairs) {
            let _ = fs::remove_dir_all(&entry_dir);
            return Err(error);
        }
        return Err(format!(
            "{error}。復旧確認のため退避先を削除していません: {}",
            entry_dir.to_string_lossy()
        ));
    }
    best_effort_remove_index(&root, &paper.id);
    Ok(entry)
}

#[tauri::command]
pub fn list_trashed_papers(root: String) -> Result<Vec<TrashEntry>, String> {
    let root = root_path(&root)?;
    initialize_library(root.to_string_lossy().to_string())?;
    let trash_root = root.join("Trash");
    let mut entries = fs::read_dir(&trash_root)
        .map_err(|error| format!("Rillのゴミ箱を読み込めませんでした: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            fs::read_to_string(entry.path().join("paper.json"))
                .ok()
                .and_then(|json| serde_json::from_str::<TrashEntry>(&json).ok())
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| right.deleted_at.cmp(&left.deleted_at));
    Ok(entries)
}

#[tauri::command]
pub fn restore_trashed_paper(root: String, paper_id: String) -> Result<Paper, String> {
    let root = root_path(&root)?;
    let entry = load_trash_entry(&root, &paper_id)?;
    let entry_dir = trash_entry_dir(&root, &paper_id)?;
    let stored_pdf = safe_join(&entry_dir, &entry.paper.pdf_path)?;
    if !stored_pdf.is_file() || !is_pdf(&stored_pdf) {
        return Err("ゴミ箱内のPDFが見つかりません".into());
    }
    let pairs = paper_managed_relatives(&entry.paper)
        .into_iter()
        .map(|relative| {
            let source = safe_join(&entry_dir, &relative)?;
            let destination = safe_join(&root, &relative)?;
            Ok((source, destination))
        })
        .collect::<Result<Vec<_>, String>>()?
        .into_iter()
        .filter(|(source, _)| source.exists())
        .collect::<Vec<_>>();
    move_files_with_rollback(&pairs)?;
    fs::remove_dir_all(&entry_dir)
        .map_err(|error| format!("復元後のゴミ箱情報を整理できませんでした: {error}"))?;
    best_effort_upsert_index(&root, &entry.paper);
    Ok(entry.paper)
}

#[tauri::command]
pub fn delete_trashed_paper_permanently(root: String, paper_id: String) -> Result<(), String> {
    let root = root_path(&root)?;
    let _ = load_trash_entry(&root, &paper_id)?;
    let entry_dir = trash_entry_dir(&root, &paper_id)?;
    fs::remove_dir_all(entry_dir)
        .map_err(|error| format!("文献を完全に削除できませんでした: {error}"))?;
    best_effort_remove_index(&root, &paper_id);
    Ok(())
}

#[tauri::command]
pub fn open_rill_trash_folder(root: String) -> Result<(), String> {
    let root = root_path(&root)?;
    initialize_library(root.to_string_lossy().to_string())?;
    run_macos_open(&[root.join("Trash").to_string_lossy().as_ref()])
}

fn markdown_references(papers: &[Paper], style: &str, formatted_references: &[String]) -> String {
    papers
        .iter()
        .enumerate()
        .map(|(index, paper)| {
            // The frontend has already formatted custom templates, including its
            // numbering. Do not add Markdown list numbering or a citation key here,
            // otherwise this output diverges from the preview and copied list.
            if let Some(formatted) = formatted_references.get(index) {
                formatted.clone()
            } else if style == "short" {
                short_reference(paper)
            } else {
                formatted_reference(paper)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[tauri::command]
pub fn export_library(
    root: String,
    papers: Vec<Paper>,
    style: String,
    formatted_references: Vec<String>,
) -> Result<ExportResult, String> {
    let root = root_path(&root)?;
    let export_dir = root.join("Exports");
    fs::create_dir_all(&export_dir)
        .map_err(|error| format!("出力フォルダを作成できませんでした: {error}"))?;
    let papers = papers
        .into_iter()
        .map(ensure_citation_key)
        .collect::<Vec<_>>();
    let bibtex = papers
        .iter()
        .map(bibtex_entry)
        .collect::<Vec<_>>()
        .join("\n\n")
        + "\n";
    let markdown = markdown_references(&papers, &style, &formatted_references);
    let bibtex_path = export_dir.join("rill-library.bib");
    let markdown_path = export_dir.join("references.md");
    fs::write(&bibtex_path, bibtex)
        .map_err(|error| format!("BibTeXを書き出せませんでした: {error}"))?;
    fs::write(&markdown_path, format!("# References\n\n{markdown}\n"))
        .map_err(|error| format!("参考文献Markdownを書き出せませんでした: {error}"))?;
    run_macos_open(&[export_dir.to_string_lossy().as_ref()])?;
    Ok(ExportResult {
        bibtex_path: relative_string(&root, &bibtex_path)?,
        markdown_path: relative_string(&root, &markdown_path)?,
    })
}

fn annotation_path(root: &Path, paper_id: &str) -> Result<PathBuf, String> {
    if paper_id.is_empty()
        || !paper_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("注釈IDが不正です".into());
    }
    Ok(root
        .join(".rill")
        .join("annotations")
        .join(format!("{paper_id}.json")))
}

fn replace_markdown_section(markdown: &str, heading: &str, content: &str) -> String {
    let marker = format!("## {heading}");
    let lines = markdown.lines().collect::<Vec<_>>();
    let mut output = Vec::new();
    let mut replaced = false;
    let mut index = 0;
    while index < lines.len() {
        if lines[index].trim() == marker {
            output.push(marker.clone());
            output.push(String::new());
            if !content.trim().is_empty() {
                output.extend(content.trim().lines().map(ToString::to_string));
            }
            output.push(String::new());
            replaced = true;
            index += 1;
            while index < lines.len() && !lines[index].starts_with("## ") {
                index += 1;
            }
        } else {
            output.push(lines[index].to_string());
            index += 1;
        }
    }
    if !replaced {
        output.push(String::new());
        output.push(marker);
        output.push(String::new());
        output.extend(content.trim().lines().map(ToString::to_string));
    }
    output.join("\n").trim_end().to_string() + "\n"
}

fn annotations_markdown(annotations: &[PdfAnnotation]) -> String {
    annotations
        .iter()
        .map(|annotation| {
            let color = match annotation.color.as_str() {
                "red" => "🔴",
                "green" => "🟢",
                "blue" => "🔵",
                "purple" => "🟣",
                _ => "🟡",
            };
            let kind = match annotation.kind.as_str() {
                "underline" => "下線",
                "strikeout" => "取り消し線",
                "area" => "範囲画像",
                _ => "ハイライト",
            };
            let quote = if annotation.kind == "area" {
                "> [PDFの範囲画像はRill内の注釈データに保存されています]".to_string()
            } else {
                annotation.text.lines().map(|line| format!("> {line}")).collect::<Vec<_>>().join("\n")
            };
            let comment = if annotation.comment.trim().is_empty() {
                String::new()
            } else {
                format!("\n\n{}", annotation.comment.trim())
            };
            let mut pages = annotation
                .rects
                .iter()
                .map(|rect| rect.page.unwrap_or(annotation.page))
                .collect::<Vec<_>>();
            pages.sort_unstable();
            pages.dedup();
            let page_label = match (pages.first(), pages.last()) {
                (Some(first), Some(last)) if first != last => format!("Pages {first}–{last}"),
                (Some(page), _) => format!("Page {page}"),
                _ => format!("Page {}", annotation.page),
            };
            format!(
                "### {color} {kind} · {page_label}\n\n{quote}{comment}\n\n<!-- rill-annotation:{} -->",
                annotation.id
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[tauri::command]
pub fn read_pdf_bytes(root: String, pdf_path: String) -> Result<tauri::ipc::Response, String> {
    let root = root_path(&root)?;
    let pdf = safe_join(&root, &pdf_path)?;
    if !pdf.is_file() || !is_pdf(&pdf) {
        return Err("PDFファイルが見つかりません".into());
    }
    fs::read(&pdf)
        .map(tauri::ipc::Response::new)
        .map_err(|error| format!("PDFを読み込めませんでした: {error}"))
}

#[tauri::command]
pub fn pdf_file_exists(root: String, pdf_path: String) -> Result<bool, String> {
    let root = root_path(&root)?;
    let pdf = safe_join(&root, &pdf_path)?;
    Ok(pdf.is_file() && is_pdf(&pdf))
}

#[tauri::command]
pub fn load_pdf_annotations(root: String, paper_id: String) -> Result<Vec<PdfAnnotation>, String> {
    let root = root_path(&root)?;
    let path = annotation_path(&root, &paper_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let json = fs::read_to_string(&path)
        .map_err(|error| format!("注釈を読み込めませんでした: {error}"))?;
    serde_json::from_str(&json).map_err(|error| format!("注釈データが壊れています: {error}"))
}

#[tauri::command]
pub fn save_pdf_annotations(
    root: String,
    paper: Paper,
    annotations: Vec<PdfAnnotation>,
) -> Result<(), String> {
    let root = root_path(&root)?;
    let path = annotation_path(&root, &paper.id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("注釈フォルダを作成できませんでした: {error}"))?;
    }
    let temporary = path.with_extension("json.rilltmp");
    let json = serde_json::to_string_pretty(&annotations)
        .map_err(|error| format!("注釈を保存形式へ変換できませんでした: {error}"))?;
    write_synced_then_rename(
        &temporary,
        &path,
        json.as_bytes(),
        "注釈を保存できませんでした",
        "注釈を確定できませんでした",
    )?;

    let note_path = safe_join(&root, &paper.note_path)?;
    let markdown = fs::read_to_string(&note_path)
        .map_err(|error| format!("Markdownノートを読み込めませんでした: {error}"))?;
    let updated =
        replace_markdown_section(&markdown, "Highlights", &annotations_markdown(&annotations));
    let note_temporary = note_path.with_extension("md.rilltmp");
    write_synced_then_rename(
        &note_temporary,
        &note_path,
        updated.as_bytes(),
        "HighlightsをMarkdownへ保存できませんでした",
        "Highlightsを確定できませんでした",
    )
}

fn run_macos_open(arguments: &[&str]) -> Result<(), String> {
    let status = Command::new("open")
        .args(arguments)
        .status()
        .map_err(|error| format!("macOSでファイルを開けませんでした: {error}"))?;
    if !status.success() {
        return Err("ファイルを開くアプリを起動できませんでした".into());
    }
    Ok(())
}

fn percent_encode_uri_value(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (*byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[tauri::command]
pub fn open_library_folder(root: String) -> Result<(), String> {
    let root = root_path(&root)?;
    if !root.is_dir() {
        return Err("Rillライブラリフォルダが見つかりません".into());
    }
    run_macos_open(&[root.to_string_lossy().as_ref()])
}

#[tauri::command]
pub fn open_pdf_in_preview(root: String, pdf_path: String) -> Result<(), String> {
    let root = root_path(&root)?;
    let pdf = safe_join(&root, &pdf_path)?;
    if !pdf.is_file() || !is_pdf(&pdf) {
        return Err("PDFファイルが見つかりません".into());
    }
    run_macos_open(&["-a", "Preview", pdf.to_string_lossy().as_ref()])
}

#[tauri::command]
pub fn obsidian_vault_status(root: String) -> Result<bool, String> {
    let root = root_path(&root)?;
    Ok(root.join(".obsidian").is_dir() || root.join("Notes/.obsidian").is_dir())
}

#[tauri::command]
pub fn open_obsidian_app() -> Result<(), String> {
    run_macos_open(&["-a", "Obsidian"])
}

#[tauri::command]
pub fn open_note_in_obsidian(root: String, note_path: String) -> Result<(), String> {
    let root = root_path(&root)?;
    let note = safe_join(&root, &note_path)?;
    if !note.is_file()
        || !note
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err("Markdownノートが見つかりません".into());
    }
    if !root.join(".obsidian").is_dir() && !root.join("Notes/.obsidian").is_dir() {
        return Err("Rillの保存場所を先にObsidian Vaultとして開いてください".into());
    }
    let uri = format!(
        "obsidian://open?path={}",
        percent_encode_uri_value(note.to_string_lossy().as_ref())
    );
    run_macos_open(&[&uri])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    static LIBRARY_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn library_test_guard() -> MutexGuard<'static, ()> {
        LIBRARY_TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("ライブラリテストを直列化")
    }

    fn test_library(label: &str) -> (PathBuf, PathBuf) {
        let test_dir =
            std::env::temp_dir().join(format!("{label}-{}", Uuid::new_v4()));
        let library = test_dir.join("Rill");
        fs::create_dir_all(&library).expect("テスト用ライブラリを作成");
        authorize_library_root(&library).expect("テスト用ライブラリを許可");
        initialize_library(library.to_string_lossy().to_string())
            .expect("テスト用ライブラリを初期化");
        (test_dir, library)
    }

    #[test]
    fn failed_multi_file_move_restores_every_moved_file() {
        let test_dir = std::env::temp_dir().join(format!("rill-trash-rollback-{}", Uuid::new_v4()));
        let source_dir = test_dir.join("source");
        let destination_dir = test_dir.join("destination");
        fs::create_dir_all(&source_dir).expect("移動元を作成");
        fs::create_dir_all(&destination_dir).expect("移動先を作成");
        let first = source_dir.join("first.pdf");
        let second = source_dir.join("second.md");
        fs::write(&first, b"first").expect("最初のファイルを作成");
        fs::write(&second, b"second").expect("次のファイルを作成");
        let blocked_parent = destination_dir.join("blocked");
        fs::write(&blocked_parent, b"directory blocker").expect("作成失敗条件を用意");
        let pairs = vec![
            (first.clone(), destination_dir.join("first.pdf")),
            (second.clone(), blocked_parent.join("second.md")),
        ];

        let result = move_files_with_rollback(&pairs);

        assert!(result.is_err(), "2件目の移動は失敗する");
        assert!(move_was_fully_rolled_back(&pairs));
        assert_eq!(fs::read(&first).expect("最初のファイルを復元"), b"first");
        assert_eq!(fs::read(&second).expect("次のファイルを保持"), b"second");
        assert!(!destination_dir.join("first.pdf").exists());
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[cfg(unix)]
    #[test]
    fn safe_join_rejects_symlinks_that_escape_the_library() {
        use std::os::unix::fs::symlink;

        let test_dir = std::env::temp_dir().join(format!("rill-symlink-{}", Uuid::new_v4()));
        let library = test_dir.join("Rill");
        let outside = test_dir.join("outside");
        fs::create_dir_all(library.join("Papers")).expect("ライブラリを作成");
        fs::create_dir_all(&outside).expect("ライブラリ外フォルダを作成");
        fs::write(outside.join("secret.pdf"), b"outside").expect("ライブラリ外ファイルを作成");
        symlink(&outside, library.join("Papers/escape")).expect("脱出シンボリックリンクを作成");

        let result = safe_join(&library, "Papers/escape/secret.pdf");

        assert!(result.is_err());
        assert!(result
            .expect_err("ライブラリ外を拒否")
            .contains("シンボリックリンク"));
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn external_pdf_rename_keeps_identity_note_and_annotations() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-index-rename");
        let original_pdf = library.join("Inbox/original.pdf");
        fs::write(&original_pdf, b"%PDF-1.4\nsame paper\n").expect("PDFを作成");
        let mut paper = scan_library(library.to_string_lossy().to_string())
            .expect("初回走査")
            .remove(0);
        paper.summary = "保持する要約".into();
        paper.tags = vec!["追跡".into()];
        paper = save_paper(library.to_string_lossy().to_string(), paper)
            .expect("書誌を保存");
        let annotation = PdfAnnotation {
            id: "rename-highlight".into(),
            page: 1,
            text: "identity remains stable".into(),
            color: "yellow".into(),
            kind: "highlight".into(),
            image_data_url: None,
            comment: "rename test".into(),
            rects: Vec::new(),
            created_at: Utc::now().to_rfc3339(),
        };
        save_pdf_annotations(
            library.to_string_lossy().to_string(),
            paper.clone(),
            vec![annotation],
        )
        .expect("注釈を保存");
        let renamed_pdf = library.join("Inbox/renamed.pdf");
        fs::rename(&original_pdf, &renamed_pdf).expect("Finder renameを模擬");

        let rescanned = scan_library(library.to_string_lossy().to_string())
            .expect("rename後に再走査")
            .remove(0);

        assert_eq!(rescanned.id, paper.id);
        assert_eq!(rescanned.note_path, paper.note_path);
        assert_eq!(rescanned.pdf_path, "Inbox/renamed.pdf");
        assert_eq!(rescanned.summary, "保持する要約");
        assert_eq!(rescanned.tags, vec!["追跡"]);
        assert_eq!(
            load_pdf_annotations(
                library.to_string_lossy().to_string(),
                rescanned.id.clone()
            )
            .expect("注釈を再読込")
            .len(),
            1
        );
        let note = fs::read_to_string(library.join(&rescanned.note_path))
            .expect("再リンク後のノートを読込");
        assert!(note.contains("[[Inbox/renamed.pdf]]"));
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn duplicate_pdf_hashes_relink_only_the_missing_path() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-index-duplicate-hash");
        fs::write(library.join("Inbox/alpha.pdf"), b"%PDF-1.4\nidentical\n")
            .expect("alpha PDFを作成");
        fs::write(library.join("Inbox/beta.pdf"), b"%PDF-1.4\nidentical\n")
            .expect("beta PDFを作成");
        let initial = scan_library(library.to_string_lossy().to_string())
            .expect("重複hashを初回走査");
        let alpha = initial
            .iter()
            .find(|paper| paper.pdf_path.ends_with("alpha.pdf"))
            .expect("alphaを取得")
            .clone();
        let beta = initial
            .iter()
            .find(|paper| paper.pdf_path.ends_with("beta.pdf"))
            .expect("betaを取得")
            .clone();
        fs::rename(
            library.join("Inbox/alpha.pdf"),
            library.join("Inbox/alpha-renamed.pdf"),
        )
        .expect("alphaだけrename");

        let rescanned = scan_library(library.to_string_lossy().to_string())
            .expect("rename後の重複hashを走査");
        let renamed = rescanned
            .iter()
            .find(|paper| paper.pdf_path.ends_with("alpha-renamed.pdf"))
            .expect("rename済みalpha");
        let untouched = rescanned
            .iter()
            .find(|paper| paper.pdf_path.ends_with("beta.pdf"))
            .expect("未変更beta");
        assert_eq!(renamed.id, alpha.id);
        assert_eq!(untouched.id, beta.id);
        assert!(library.join(&alpha.note_path).exists());
        assert!(library.join(&beta.note_path).exists());
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn missing_or_corrupt_index_is_rebuilt_from_frontmatter() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-index-rebuild");
        fs::write(library.join("Inbox/rebuild.pdf"), b"%PDF-1.4\nrebuild\n")
            .expect("PDFを作成");
        let original_id = scan_library(library.to_string_lossy().to_string())
            .expect("初回走査")[0]
            .id
            .clone();
        fs::write(library_index_path(&library), b"{broken json")
            .expect("index破損を模擬");
        let after_corruption = scan_library(library.to_string_lossy().to_string())
            .expect("破損indexから再構築");
        assert_eq!(after_corruption[0].id, original_id);
        let rebuilt = serde_json::from_slice::<LibraryIndex>(
            &fs::read(library_index_path(&library)).expect("再構築indexを読込"),
        )
        .expect("再構築indexを解析");
        assert_eq!(rebuilt.version, 1);
        fs::remove_file(library_index_path(&library)).expect("index欠損を模擬");
        let after_missing = scan_library(library.to_string_lossy().to_string())
            .expect("欠損indexから再構築");
        assert_eq!(after_missing[0].id, original_id);
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn newer_index_version_is_not_overwritten() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-index-forward");
        fs::write(library.join("Inbox/future.pdf"), b"%PDF-1.4\nfuture\n")
            .expect("PDFを作成");
        let future_index = br#"{"version":2,"papers":{}}"#;
        fs::write(library_index_path(&library), future_index)
            .expect("将来版indexを作成");
        scan_library(library.to_string_lossy().to_string())
            .expect("将来版indexでも走査");
        assert_eq!(
            fs::read(library_index_path(&library)).expect("将来版indexを再読込"),
            future_index
        );
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn frontmatter_identity_overrides_a_stale_index_without_rewriting_the_note() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-index-frontmatter");
        fs::write(library.join("Inbox/frontmatter.pdf"), b"%PDF-1.4\nfrontmatter\n")
            .expect("PDFを作成");
        let initial = scan_library(library.to_string_lossy().to_string())
            .expect("初回走査")
            .remove(0);
        let new_id = Uuid::new_v4().to_string();
        let note_path = library.join(&initial.note_path);
        let note = fs::read_to_string(&note_path).expect("noteを読込");
        let externally_changed = note.replace(&initial.id, &new_id);
        fs::write(&note_path, &externally_changed).expect("frontmatter ID変更を模擬");

        let rescanned = scan_library(library.to_string_lossy().to_string())
            .expect("ID矛盾を再走査")
            .remove(0);

        assert_eq!(rescanned.id, new_id);
        assert_eq!(
            fs::read_to_string(&note_path).expect("noteを再読込"),
            externally_changed
        );
        let index = load_library_index(&library).0;
        assert!(index.papers.contains_key(&new_id));
        assert!(!index.papers.contains_key(&initial.id));
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn duplicate_frontmatter_ids_do_not_rewrite_notes() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-index-duplicate-id");
        fs::write(library.join("Inbox/first.pdf"), b"%PDF-1.4\nfirst\n")
            .expect("first PDFを作成");
        fs::write(library.join("Inbox/second.pdf"), b"%PDF-1.4\nsecond\n")
            .expect("second PDFを作成");
        let initial = scan_library(library.to_string_lossy().to_string())
            .expect("初回走査");
        let first = initial
            .iter()
            .find(|paper| paper.pdf_path.ends_with("first.pdf"))
            .expect("first文献");
        let second = initial
            .iter()
            .find(|paper| paper.pdf_path.ends_with("second.pdf"))
            .expect("second文献");
        let second_note_path = library.join(&second.note_path);
        let second_note = fs::read_to_string(&second_note_path).expect("second noteを読込");
        let duplicate_note = second_note.replace(&second.id, &first.id);
        fs::write(&second_note_path, &duplicate_note).expect("重複IDを模擬");
        fs::remove_file(library_index_path(&library)).expect("migration状態を模擬");

        let rescanned = scan_library(library.to_string_lossy().to_string())
            .expect("重複IDを走査");

        assert_eq!(rescanned.iter().filter(|paper| paper.id == first.id).count(), 2);
        assert_eq!(
            fs::read_to_string(&second_note_path).expect("second noteを再読込"),
            duplicate_note
        );
        let index = serde_json::from_slice::<LibraryIndex>(
            &fs::read(library_index_path(&library)).expect("indexを読込"),
        )
        .expect("indexを解析");
        assert_eq!(index.papers.len(), 1);
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn local_library_round_trip() {
        let _guard = library_test_guard();
        let test_dir = std::env::temp_dir().join(format!("rill-test-{}", Uuid::new_v4()));
        let library = test_dir.join("Rill");
        let source = test_dir.join("2024_Test_Clinical_Trial.pdf");
        fs::create_dir_all(&test_dir).expect("テストフォルダを作成");
        fs::create_dir_all(&library).expect("ライブラリの場所を作成");
        authorize_library_root(&library).expect("テスト用ライブラリを許可");
        fs::write(&source, b"%PDF-1.4\nRill test PDF\n").expect("テストPDFを作成");

        initialize_library(library.to_string_lossy().to_string()).expect("ライブラリを初期化");
        assert!(
            !obsidian_vault_status(library.to_string_lossy().to_string()).expect("Vault状態を確認")
        );
        fs::create_dir_all(library.join(".obsidian")).expect("Vault設定を作成");
        assert!(
            obsidian_vault_status(library.to_string_lossy().to_string()).expect("Vault接続を確認")
        );
        assert_eq!(
            percent_encode_uri_value("/Rill Library/Notes/日本語.md"),
            "%2FRill%20Library%2FNotes%2F%E6%97%A5%E6%9C%AC%E8%AA%9E.md"
        );
        let first_import = import_pdfs(
            library.to_string_lossy().to_string(),
            vec![source.to_string_lossy().to_string()],
        )
        .expect("PDFを追加");
        assert_eq!(first_import.imported, 1);
        assert_eq!(first_import.skipped_duplicates, 0);

        let duplicate_import = import_pdfs(
            library.to_string_lossy().to_string(),
            vec![source.to_string_lossy().to_string()],
        )
        .expect("重複を確認");
        assert_eq!(duplicate_import.imported, 0);
        assert_eq!(duplicate_import.skipped_duplicates, 1);

        let mut papers = scan_library(library.to_string_lossy().to_string()).expect("文献を走査");
        assert_eq!(papers.len(), 1);
        assert!(papers[0].pdf_path.starts_with("Inbox/"));
        assert!(library.join(&papers[0].note_path).exists());
        assert!(pdf_file_exists(
            library.to_string_lossy().to_string(),
            papers[0].pdf_path.clone()
        )
        .expect("PDFの存在を確認"));
        assert!(!pdf_file_exists(
            library.to_string_lossy().to_string(),
            "Inbox/missing.pdf".into()
        )
        .expect("欠落PDFを確認"));

        papers[0].tags = vec!["CKD".into(), "RCT".into()];
        papers[0].summary = "ローカル保存のテスト".into();
        papers[0].authors = vec!["Jane Doe".into(), "John Smith".into()];
        papers[0].journal = "Medical Journal".into();
        papers[0].year = Some(2024);
        papers[0].volume = "12".into();
        papers[0].issue = "3".into();
        papers[0].pages = "119–120".into();
        papers[0].is_reference = true;
        papers[0].flag_color = "red".into();
        save_paper(library.to_string_lossy().to_string(), papers[0].clone())
            .expect("Markdownを保存");

        let rescanned = scan_library(library.to_string_lossy().to_string()).expect("再走査");
        assert_eq!(rescanned[0].tags, vec!["CKD", "RCT"]);
        assert_eq!(rescanned[0].summary, "ローカル保存のテスト");
        assert!(rescanned[0].is_reference);
        assert_eq!(rescanned[0].flag_color, "red");
        assert!(!rescanned[0].citation_key.is_empty());
        assert!(bibtex_entry(&rescanned[0]).contains("@article{"));
        assert!(bibtex_entry(&rescanned[0]).contains("volume = {12}"));
        assert!(formatted_reference(&rescanned[0]).contains("Doe, J.; Smith, J."));
        assert!(formatted_reference(&rescanned[0]).contains("119–120"));
        assert_eq!(
            short_reference(&rescanned[0]),
            "Doe et al. Medical Journal, 2024"
        );
        assert_eq!(
            markdown_references(
                &rescanned,
                "preset:article-number",
                &["[1] Doe, J. Example article. Med J 12:21".into()],
            ),
            "[1] Doe, J. Example article. Med J 12:21"
        );

        let annotations = vec![PdfAnnotation {
            id: "annotation-test".into(),
            page: 2,
            text: "clinically meaningful improvement".into(),
            color: "yellow".into(),
            kind: "highlight".into(),
            image_data_url: None,
            comment: "主要評価項目として引用する".into(),
            rects: vec![
                AnnotationRect {
                    page: Some(2),
                    x: 0.1,
                    y: 0.2,
                    width: 0.4,
                    height: 0.03,
                },
                AnnotationRect {
                    page: Some(3),
                    x: 0.1,
                    y: 0.1,
                    width: 0.25,
                    height: 0.03,
                },
            ],
            created_at: Utc::now().to_rfc3339(),
        }];
        save_pdf_annotations(
            library.to_string_lossy().to_string(),
            rescanned[0].clone(),
            annotations,
        )
        .expect("PDF注釈を保存");
        let loaded_annotations = load_pdf_annotations(
            library.to_string_lossy().to_string(),
            rescanned[0].id.clone(),
        )
        .expect("PDF注釈を再読込");
        assert_eq!(loaded_annotations.len(), 1);
        assert_eq!(loaded_annotations[0].page, 2);
        let note_path = library.join(&rescanned[0].note_path);
        let note = fs::read_to_string(&note_path).expect("Markdown注釈を読込");
        assert!(note.contains("## Highlights"));
        assert!(note.contains("Pages 2–3"));
        assert!(note.contains("> clinically meaningful improvement"));
        assert!(note.contains("主要評価項目として引用する"));

        let after_annotations =
            scan_library(library.to_string_lossy().to_string()).expect("注釈保存後に再走査");
        let mut annotation_preserving_edit = after_annotations[0].clone();
        annotation_preserving_edit.summary = "注釈保存後の要約更新".into();
        let after_edit = save_paper(
            library.to_string_lossy().to_string(),
            annotation_preserving_edit,
        )
        .expect("注釈を保持して文献情報を更新");
        let note = fs::read_to_string(&note_path).expect("更新後のMarkdownを読込");
        assert!(note.contains("> clinically meaningful improvement"));

        let with_obsidian_text =
            format!("{note}\n## Obsidianで追記\n\nこの段落はRillの管理外です。\n");
        fs::write(&note_path, with_obsidian_text).expect("Obsidian追記を模擬");
        let merged = save_paper(library.to_string_lossy().to_string(), after_edit)
            .expect("別項目の外部更新は自動マージ");
        let merged_note = fs::read_to_string(&note_path).expect("自動マージ後のノート");
        assert!(merged_note.contains("この段落はRillの管理外です。"));

        let obsidian_summary = replace_markdown_section(&merged_note, "要約", "Obsidian側の要約");
        fs::write(&note_path, obsidian_summary).expect("同じ項目のObsidian変更を模擬");
        let mut rill_same_field = merged.clone();
        rill_same_field.summary = "Rill側の要約".into();
        let conflict = save_paper(library.to_string_lossy().to_string(), rill_same_field);
        assert!(
            conflict.is_err(),
            "同じ項目を両方で変更した場合だけ停止する"
        );
        let mut refreshed = scan_library(library.to_string_lossy().to_string())
            .expect("外部更新後に再走査")[0]
            .clone();
        refreshed.summary = "競合解消後の要約".into();
        save_paper(library.to_string_lossy().to_string(), refreshed)
            .expect("再読込後は安全にマージ");
        let note = fs::read_to_string(&note_path).expect("マージ後のMarkdownを読込");
        assert!(note.contains("## Obsidianで追記"));
        assert!(note.contains("この段落はRillの管理外です。"));

        let latest = scan_library(library.to_string_lossy().to_string()).expect("移動前に再走査");
        let organized = organize_paper(library.to_string_lossy().to_string(), latest[0].clone())
            .expect("Papersへ整理");
        assert!(organized.pdf_path.starts_with("Papers/"));
        assert!(library.join(&organized.pdf_path).exists());

        let parent = create_collection(
            library.to_string_lossy().to_string(),
            String::new(),
            "精神医学".into(),
        )
        .expect("親フォルダを作成");
        let collection = create_collection(
            library.to_string_lossy().to_string(),
            parent,
            "うつ病".into(),
        )
        .expect("階層フォルダを作成");
        assert_eq!(collection, "精神医学/うつ病");
        let moved = move_paper_to_collection(
            library.to_string_lossy().to_string(),
            organized,
            collection.clone(),
        )
        .expect("階層フォルダへ移動");
        assert!(moved.pdf_path.starts_with("Papers/精神医学/うつ病/"));
        assert!(list_collections(library.to_string_lossy().to_string())
            .expect("フォルダ一覧")
            .contains(&collection));
        let empty = create_collection(
            library.to_string_lossy().to_string(),
            String::new(),
            "空フォルダ".into(),
        )
        .expect("空フォルダを作成");
        delete_collection(library.to_string_lossy().to_string(), empty.clone())
            .expect("空フォルダを削除");
        assert!(!list_collections(library.to_string_lossy().to_string())
            .expect("削除後のフォルダ一覧")
            .contains(&empty));

        let trashed =
            move_paper_to_rill_trash(library.to_string_lossy().to_string(), moved.clone())
                .expect("Rillのゴミ箱へ移動");
        assert_eq!(trashed.paper.id, moved.id);
        assert!(library
            .join("Trash")
            .join(&moved.id)
            .join(&moved.pdf_path)
            .exists());
        assert!(library
            .join("Trash")
            .join(&moved.id)
            .join(&moved.note_path)
            .exists());
        assert!(scan_library(library.to_string_lossy().to_string())
            .expect("ゴミ箱移動後に走査")
            .is_empty());
        assert_eq!(
            list_trashed_papers(library.to_string_lossy().to_string())
                .expect("ゴミ箱一覧")
                .len(),
            1
        );
        assert!(!load_library_index(&library).0.papers.contains_key(&moved.id));

        let restored =
            restore_trashed_paper(library.to_string_lossy().to_string(), moved.id.clone())
                .expect("ゴミ箱から復元");
        assert_eq!(restored.pdf_path, moved.pdf_path);
        assert_eq!(restored.note_path, moved.note_path);
        assert!(library.join(&restored.pdf_path).exists());
        assert!(library.join(&restored.note_path).exists());
        assert!(load_library_index(&library)
            .0
            .papers
            .contains_key(&restored.id));
        let restored_annotations =
            load_pdf_annotations(library.to_string_lossy().to_string(), restored.id.clone())
                .expect("復元後の注釈");
        assert_eq!(restored_annotations.len(), loaded_annotations.len());
        assert_eq!(restored_annotations[0].text, loaded_annotations[0].text);

        move_paper_to_rill_trash(library.to_string_lossy().to_string(), restored.clone())
            .expect("完全削除前にゴミ箱へ移動");
        delete_trashed_paper_permanently(
            library.to_string_lossy().to_string(),
            restored.id.clone(),
        )
        .expect("ゴミ箱から完全削除");
        assert!(list_trashed_papers(library.to_string_lossy().to_string())
            .expect("完全削除後のゴミ箱")
            .is_empty());
        assert!(!library.join("Trash").join(&restored.id).exists());
        assert!(!load_library_index(&library)
            .0
            .papers
            .contains_key(&restored.id));

        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn crossref_metadata_is_applied() {
        let paper = Paper {
            id: "test".into(),
            title: "filename title".into(),
            authors: vec![],
            year: None,
            journal: String::new(),
            journal_abbreviation: String::new(),
            doi: String::new(),
            pmid: String::new(),
            citation_key: String::new(),
            volume: String::new(),
            issue: String::new(),
            pages: String::new(),
            is_reference: false,
            flag_color: String::new(),
            is_favorite: false,
            tags: vec![],
            status: default_status(),
            pdf_path: "Inbox/test.pdf".into(),
            note_path: "Notes/test.md".into(),
            summary: String::new(),
            translated_summary: String::new(),
            clinical_note: String::new(),
            added_at: Utc::now().to_rfc3339(),
            note_revision: String::new(),
        };
        let metadata = serde_json::json!({
            "title": ["Clinical Trial"],
            "author": [{"given": "Jane", "family": "Doe"}],
            "container-title": ["Medical Journal"],
            "DOI": "10.1000/test",
            "published-print": {"date-parts": [[2025, 1, 1]]}
        });
        let enriched = apply_crossref(paper, &metadata);
        assert_eq!(enriched.title, "Clinical Trial");
        assert_eq!(enriched.authors, vec!["Jane Doe"]);
        assert_eq!(enriched.year, Some(2025));
        assert_eq!(enriched.doi, "10.1000/test");
        assert!(enriched.citation_key.contains("Doe2025"));
    }

    #[test]
    #[ignore = "外部APIの疎通確認用"]
    fn live_medical_metadata_lookup() {
        let paper = Paper {
            id: "live-test".into(),
            title: "Dapagliflozin in Patients with Chronic Kidney Disease".into(),
            authors: vec![],
            year: None,
            journal: String::new(),
            journal_abbreviation: String::new(),
            doi: String::new(),
            pmid: "32970396".into(),
            citation_key: String::new(),
            volume: String::new(),
            issue: String::new(),
            pages: String::new(),
            is_reference: false,
            flag_color: String::new(),
            is_favorite: false,
            tags: vec![],
            status: default_status(),
            pdf_path: "Inbox/test.pdf".into(),
            note_path: "Notes/test.md".into(),
            summary: String::new(),
            translated_summary: String::new(),
            clinical_note: String::new(),
            added_at: Utc::now().to_rfc3339(),
            note_revision: String::new(),
        };
        let enriched = enrich_from_pubmed(paper).expect("PubMed/Crossrefから取得");
        assert_eq!(enriched.pmid, "32970396");
        assert!(!enriched.authors.is_empty());
        assert_eq!(enriched.year, Some(2020));
        assert!(!enriched.doi.is_empty());
    }
}
