use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{Mutex, MutexGuard, OnceLock, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
use walkdir::WalkDir;

const LIBRARY_DIRS: [&str; 8] = [
    "Inbox",
    "Papers",
    "Notes",
    "Exports",
    "Trash",
    ".rill",
    ".rill/revisions",
    ".rill/annotations",
];
const MAX_PDF_BYTES: u64 = 256 * 1024 * 1024;
const PDF_HEADER_SCAN_BYTES: usize = 1024;
static AUTHORIZED_LIBRARY_ROOT: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
static LIBRARY_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(target_os = "macos")]
extern "C" {
    fn renamex_np(
        from: *const std::os::raw::c_char,
        to: *const std::os::raw::c_char,
        flags: u32,
    ) -> std::os::raw::c_int;
}

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pdf_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pdf_modified_nanos: Option<u64>,
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

#[derive(Debug, Serialize)]
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

fn library_write_guard() -> MutexGuard<'static, ()> {
    LIBRARY_WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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
            "ライブラリへのアクセスが許可されていません。保存場所を選び直してください".to_string()
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

fn reject_symlink(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(format!("{label}にシンボリックリンクは使用できません"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("{label}を確認できませんでした: {error}")),
    }
}

fn managed_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = safe_join(root, relative)?;
    let relative_path = path
        .strip_prefix(root)
        .map_err(|_| "Rillの管理パスを確認できませんでした".to_string())?;
    let mut current = root.to_path_buf();
    for component in relative_path.components() {
        current.push(component.as_os_str());
        reject_symlink(&current, "Rillの管理パス")?;
    }
    Ok(path)
}

fn managed_typed_path(
    root: &Path,
    relative: &str,
    allowed_roots: &[&str],
    extension: &str,
    label: &str,
) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    let components = relative_path.components().collect::<Vec<_>>();
    let Some(Component::Normal(first)) = components.first() else {
        return Err(format!("{label}の保存場所が不正です"));
    };
    let normalized = components
        .iter()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    if components.len() < 2
        || components
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
        || normalized != relative
        || !allowed_roots
            .iter()
            .any(|root_name| first == &std::ffi::OsStr::new(root_name))
        || relative_path
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case(extension))
    {
        return Err(format!("{label}の保存場所が不正です"));
    }
    managed_path(root, relative)
}

fn paper_pdf_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    managed_typed_path(root, relative, &["Inbox", "Papers"], "pdf", "PDF")
}

fn paper_note_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    managed_typed_path(root, relative, &["Notes"], "md", "Markdownノート")
}

fn validate_paper_storage_paths(root: &Path, paper: &Paper) -> Result<(PathBuf, PathBuf), String> {
    if !is_valid_paper_id(&paper.id) {
        return Err("文献IDが不正です".into());
    }
    Ok((
        paper_pdf_path(root, &paper.pdf_path)?,
        paper_note_path(root, &paper.note_path)?,
    ))
}

fn managed_directory(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = managed_path(root, relative)?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("{relative}フォルダを確認できませんでした: {error}"))?;
    if !metadata.is_dir() {
        return Err(format!("{relative}はフォルダではありません"));
    }
    Ok(path)
}

fn ensure_managed_directory(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = managed_path(root, relative)?;
    if path.exists() {
        return managed_directory(root, relative);
    }
    fs::create_dir_all(&path)
        .map_err(|error| format!("{relative}フォルダを作成できませんでした: {error}"))?;
    managed_directory(root, relative)
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
    write_synced_then_rename(
        &config,
        &content,
        "ライブラリ設定を保存できませんでした",
        "ライブラリ設定を確定できませんでした",
    )
}

fn unique_sibling_temporary_path(destination: &Path) -> Result<PathBuf, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "一時保存先フォルダを確認できません".to_string())?;
    Ok(parent.join(format!(".rilltmp-{}", Uuid::new_v4().simple())))
}

#[cfg(target_os = "macos")]
fn rename_without_overwrite(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    const RENAME_EXCL: u32 = 0x0000_0004;
    let source = CString::new(source.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid source path")
    })?;
    let destination = CString::new(destination.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid destination path")
    })?;
    // SAFETY: Both pointers refer to live, NUL-terminated C strings for the duration of the call.
    if unsafe { renamex_np(source.as_ptr(), destination.as_ptr(), RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn rename_without_overwrite(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::hard_link(source, destination)?;
    if let Err(error) = fs::remove_file(source) {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok(())
}

fn write_synced_then_rename(
    destination: &Path,
    content: &[u8],
    write_message: &str,
    commit_message: &str,
) -> Result<(), String> {
    reject_symlink(destination, "保存先ファイル")?;
    let temporary = unique_sibling_temporary_path(destination)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("{write_message}: {error}"))?;
        file.write_all(content)
            .map_err(|error| format!("{write_message}: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("{write_message}: {error}"))?;
        drop(file);
        reject_symlink(destination, "保存先ファイル")?;
        fs::rename(&temporary, destination)
            .map_err(|error| format!("{commit_message}: {error}"))?;
        sync_parent_directory(destination, commit_message)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn sync_parent_directory(destination: &Path, commit_message: &str) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| format!("{commit_message}: 保存先フォルダを確認できませんでした"))?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("{commit_message}（保存先フォルダの同期）: {error}"))
}

#[cfg(not(unix))]
fn sync_parent_directory(_destination: &Path, _commit_message: &str) -> Result<(), String> {
    Ok(())
}

fn library_index_path(root: &Path) -> Result<PathBuf, String> {
    managed_path(root, ".rill/index.json")
}

fn metadata_modified_nanos(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_nanos()).ok())
}

fn file_fingerprint(path: &Path) -> Result<(u64, Option<u64>), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("PDFの更新状態を確認できませんでした: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("PDFに通常のファイルを指定してください".into());
    }
    let size = metadata.len();
    if size > MAX_PDF_BYTES {
        return Err(format!(
            "PDFが大きすぎます。Rillで読み込める上限は{} MBです",
            MAX_PDF_BYTES / 1024 / 1024
        ));
    }
    let modified_nanos = metadata_modified_nanos(&metadata);
    Ok((size, modified_nanos))
}

fn index_fingerprint_matches(entry: &LibraryIndexEntry, size: u64, modified: Option<u64>) -> bool {
    entry.pdf_size == Some(size)
        && entry.pdf_modified_nanos.is_some()
        && entry.pdf_modified_nanos == modified
}

fn load_library_index_with_recovery(
    root: &Path,
    rebuild_corrupt: bool,
) -> Result<(LibraryIndex, bool), String> {
    let path = library_index_path(root)?;
    let json = match fs::read(&path) {
        Ok(json) => json,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((LibraryIndex::default(), true));
        }
        Err(error) => {
            return Err(format!("文献インデックスを読み込めませんでした: {error}"));
        }
    };
    match serde_json::from_slice::<LibraryIndex>(&json) {
        Ok(index) if index.version <= 1 => Ok((index, true)),
        Ok(index) => {
            eprintln!(
                "Rill index version {} is newer than this app; leaving it unchanged",
                index.version
            );
            Ok((index, false))
        }
        Err(error) if rebuild_corrupt => {
            eprintln!("Rill index is unreadable and will be rebuilt: {error}");
            Ok((LibraryIndex::default(), true))
        }
        Err(error) => Err(format!(
            "文献インデックスが壊れています。↻で再読込してください: {error}"
        )),
    }
}

fn load_library_index(root: &Path) -> Result<(LibraryIndex, bool), String> {
    load_library_index_with_recovery(root, false)
}

fn store_library_index(root: &Path, index: &LibraryIndex) -> Result<(), String> {
    let path = library_index_path(root)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("文献インデックスのフォルダを作成できませんでした: {error}")
        })?;
    }
    let content = serde_json::to_vec_pretty(index)
        .map_err(|error| format!("文献インデックスを作成できませんでした: {error}"))?;
    write_synced_then_rename(
        &path,
        &content,
        "文献インデックスを保存できませんでした",
        "文献インデックスを確定できませんでした",
    )
}

#[derive(Clone, Debug)]
struct PdfHashObservation {
    sha256: String,
    size: u64,
    modified_nanos: Option<u64>,
}

fn hash_and_fingerprint(path: &Path) -> Result<PdfHashObservation, String> {
    hash_and_fingerprint_with_hook(path, || {})
}

fn hash_and_fingerprint_with_hook<F>(
    path: &Path,
    after_read: F,
) -> Result<PdfHashObservation, String>
where
    F: FnOnce(),
{
    let (file, size) = open_validated_pdf(path)?;
    let before = file
        .metadata()
        .map_err(|error| format!("PDFの更新状態を確認できませんでした: {error}"))?;
    let before_modified = metadata_modified_nanos(&before);
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let bytes = reader
            .read(&mut buffer)
            .map_err(|error| format!("PDFを読み込めませんでした: {error}"))?;
        if bytes == 0 {
            break;
        }
        total = total.saturating_add(bytes as u64);
        if total > MAX_PDF_BYTES {
            return Err(format!(
                "PDFが大きすぎます。Rillで読み込める上限は{} MBです",
                MAX_PDF_BYTES / 1024 / 1024
            ));
        }
        hasher.update(&buffer[..bytes]);
    }
    after_read();
    let after = reader
        .get_ref()
        .metadata()
        .map_err(|error| format!("PDFの更新状態を確認できませんでした: {error}"))?;
    let path_metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("PDFの更新状態を確認できませんでした: {error}"))?;
    if path_metadata.file_type().is_symlink()
        || !path_metadata.is_file()
        || total != size
        || after.len() != size
        || path_metadata.len() != size
        || metadata_modified_nanos(&after) != before_modified
        || metadata_modified_nanos(&path_metadata) != before_modified
    {
        return Err("PDFが読み込み中に変更されました。↻で再読込してください".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if after.dev() != path_metadata.dev() || after.ino() != path_metadata.ino() {
            return Err("PDFが読み込み中に差し替えられました。↻で再読込してください".into());
        }
    }
    Ok(PdfHashObservation {
        sha256: format!("{:x}", hasher.finalize()),
        size,
        modified_nanos: before_modified,
    })
}

fn hash_hex(path: &Path) -> Result<String, String> {
    Ok(hash_and_fingerprint(path)?.sha256)
}

fn index_entry_for_paper(
    root: &Path,
    paper: &Paper,
    existing: Option<&LibraryIndexEntry>,
    known_observation: Option<&PdfHashObservation>,
) -> Result<LibraryIndexEntry, String> {
    let pdf = paper_pdf_path(root, &paper.pdf_path)?;
    let (pdf_sha256, pdf_size, pdf_modified_nanos) = if let Some(observation) = known_observation {
        (
            observation.sha256.clone(),
            observation.size,
            observation.modified_nanos,
        )
    } else {
        let (size, modified_nanos) = file_fingerprint(&pdf)?;
        match existing {
            Some(entry)
                if !entry.pdf_sha256.is_empty()
                    && index_fingerprint_matches(entry, size, modified_nanos) =>
            {
                (entry.pdf_sha256.clone(), size, modified_nanos)
            }
            _ => {
                let observation = hash_and_fingerprint(&pdf)?;
                (
                    observation.sha256,
                    observation.size,
                    observation.modified_nanos,
                )
            }
        }
    };
    if let Some(entry) = existing {
        if entry.pdf_sha256 == pdf_sha256
            && entry.pdf_path == paper.pdf_path
            && entry.note_path == paper.note_path
            && entry.pdf_size == Some(pdf_size)
            && entry.pdf_modified_nanos == pdf_modified_nanos
        {
            return Ok(entry.clone());
        }
    }
    Ok(LibraryIndexEntry {
        pdf_sha256,
        pdf_path: paper.pdf_path.clone(),
        note_path: paper.note_path.clone(),
        updated_at: Utc::now().to_rfc3339(),
        pdf_size: Some(pdf_size),
        pdf_modified_nanos,
    })
}

fn upsert_library_index(root: &Path, paper: &Paper) -> Result<(), String> {
    let (mut index, writable) = load_library_index(root)?;
    if !writable {
        return Err(
            "このRillより新しい形式の文献インデックスです。書き込まず、新しいRillで開いてください"
                .into(),
        );
    }
    let entry = index_entry_for_paper(root, paper, index.papers.get(&paper.id), None)?;
    index.papers.insert(paper.id.clone(), entry);
    store_library_index(root, &index)
}

fn remove_library_index_entry(root: &Path, paper_id: &str) -> Result<(), String> {
    let (mut index, writable) = load_library_index(root)?;
    if !writable {
        return Err(
            "このRillより新しい形式の文献インデックスです。書き込まず、新しいRillで開いてください"
                .into(),
        );
    }
    if index.papers.remove(paper_id).is_some() {
        store_library_index(root, &index)?;
    }
    Ok(())
}

fn validate_indexed_pdf_ownership(root: &Path, paper: &Paper, pdf: &Path) -> Result<(), String> {
    let (index, writable) = load_library_index(root)?;
    if !writable {
        return Err(
            "このRillより新しい形式の文献インデックスです。書き込まず、新しいRillで開いてください"
                .into(),
        );
    }
    let Some(entry) = index.papers.get(&paper.id) else {
        return Ok(());
    };
    if entry.pdf_path != paper.pdf_path || entry.note_path != paper.note_path {
        return Err("文献の保存場所がインデックスと一致しません。↻で再読込してください".into());
    }
    if entry.pdf_sha256.is_empty() {
        return Ok(());
    }
    let (size, modified_nanos) = file_fingerprint(pdf)?;
    if index_fingerprint_matches(entry, size, modified_nanos) {
        return Ok(());
    }
    if hash_hex(pdf)? != entry.pdf_sha256 {
        return Err("PDFの内容が外部で差し替えられました。↻で再読込してください".into());
    }
    Ok(())
}

fn optional_file_contents(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "更新前のファイルを退避できませんでした（{}）: {error}",
            path.to_string_lossy()
        )),
    }
}

fn restore_optional_file(path: &Path, content: &Option<Vec<u8>>) -> Result<(), String> {
    match content {
        Some(content) => write_synced_then_rename(
            path,
            content,
            "退避したファイルを復元できませんでした",
            "退避したファイルの復元を確定できませんでした",
        ),
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("作成途中のファイルを削除できませんでした: {error}")),
        },
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

fn validate_pdf_handle(file: &mut File, path: &Path) -> Result<u64, String> {
    if !is_pdf(path) {
        return Err("PDFファイルが見つかりません".into());
    }
    let metadata = file
        .metadata()
        .map_err(|error| format!("PDFのサイズを確認できませんでした: {error}"))?;
    if !metadata.is_file() {
        return Err("PDFに通常のファイルを指定してください".into());
    }
    let size = metadata.len();
    if size > MAX_PDF_BYTES {
        return Err(format!(
            "PDFが大きすぎます。Rillで読み込める上限は{} MBです",
            MAX_PDF_BYTES / 1024 / 1024
        ));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("PDFの形式を確認できませんでした: {error}"))?;
    let mut header = Vec::with_capacity(PDF_HEADER_SCAN_BYTES.min(size as usize));
    file.take(PDF_HEADER_SCAN_BYTES as u64)
        .read_to_end(&mut header)
        .map_err(|error| format!("PDFの形式を確認できませんでした: {error}"))?;
    if !header
        .windows(b"%PDF-".len())
        .any(|window| window == b"%PDF-")
    {
        return Err("選択したファイルは有効なPDFとして認識できません".into());
    }
    Ok(size)
}

fn open_validated_pdf(path: &Path) -> Result<(File, u64), String> {
    if !path.is_file() || !is_pdf(path) {
        return Err("PDFファイルが見つかりません".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        const O_NOFOLLOW: i32 = 0x0000_0100;
        options.custom_flags(O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("PDFを開けませんでした: {error}"))?;
    let size = validate_pdf_handle(&mut file, path)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("PDFを読み込む準備ができませんでした: {error}"))?;
    Ok((file, size))
}

#[cfg(test)]
fn validate_pdf_file(path: &Path) -> Result<u64, String> {
    open_validated_pdf(path).map(|(_, size)| size)
}

fn pdf_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = ["Inbox", "Papers"]
        .iter()
        .map(|folder| managed_directory(root, folder))
        .collect::<Result<Vec<_>, String>>()?
        .into_iter()
        .flat_map(|folder| {
            WalkDir::new(folder)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file() && is_pdf(entry.path()))
                .map(|entry| entry.into_path())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
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

fn note_frontmatter_pdf_path(note_path: &Path) -> Option<String> {
    let markdown = fs::read_to_string(note_path).ok()?;
    let (yaml, _) = split_frontmatter(&markdown);
    let frontmatter = serde_yaml::from_str::<PaperFrontmatter>(yaml?).ok()?;
    let value = frontmatter.pdf.trim();
    let value = value
        .strip_prefix("[[")
        .and_then(|value| value.strip_suffix("]]"))
        .unwrap_or(value)
        .trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn note_belongs_to_pdf(note_path: &Path, pdf_relative: &str) -> bool {
    note_frontmatter_pdf_path(note_path)
        .map(|path| path.trim_start_matches("./").replace('\\', "/"))
        .is_some_and(|path| path == pdf_relative)
}

fn note_storage_identity_from_markdown(markdown: &str) -> Option<(String, String)> {
    let (yaml, _) = split_frontmatter(markdown);
    let frontmatter = serde_yaml::from_str::<PaperFrontmatter>(yaml?).ok()?;
    let pdf_path = frontmatter
        .pdf
        .trim()
        .strip_prefix("[[")
        .and_then(|value| value.strip_suffix("]]"))
        .unwrap_or(frontmatter.pdf.trim())
        .trim_start_matches("./")
        .replace('\\', "/");
    Some((frontmatter.rill_id, pdf_path))
}

fn note_storage_identity(note_path: &Path) -> Option<(String, String)> {
    let markdown = fs::read_to_string(note_path).ok()?;
    note_storage_identity_from_markdown(&markdown)
}

fn validate_note_identity(
    identity: Option<(String, String)>,
    paper: &Paper,
    allowed_previous_pdf: Option<&str>,
    allowed_previous_id: Option<&str>,
    allow_missing_id: bool,
) -> Result<(), String> {
    let (stored_id, stored_pdf) = identity.ok_or_else(|| {
        "既存のMarkdownノートの所有情報を確認できません。別のノートを選んでください".to_string()
    })?;
    let id_matches = stored_id == paper.id
        || allowed_previous_id.is_some_and(|previous| stored_id == previous)
        || (allow_missing_id && stored_id.is_empty());
    let pdf_matches = stored_pdf == paper.pdf_path
        || allowed_previous_pdf.is_some_and(|previous| stored_pdf == previous);
    if !id_matches || !pdf_matches {
        return Err(
            "このMarkdownノートは別の文献に属しています。ライブラリを再読込してください".into(),
        );
    }
    Ok(())
}

fn validate_existing_note_ownership(
    note_path: &Path,
    paper: &Paper,
    allowed_previous_pdf: Option<&str>,
    allowed_previous_id: Option<&str>,
    allow_missing_id: bool,
) -> Result<(), String> {
    if !note_path.exists() {
        return Ok(());
    }
    validate_note_identity(
        note_storage_identity(note_path),
        paper,
        allowed_previous_pdf,
        allowed_previous_id,
        allow_missing_id,
    )
}

fn indexed_note_is_owned(note_path: &Path, paper_id: &str, pdf_relative: &str) -> bool {
    if !note_path.exists() {
        return true;
    }
    note_storage_identity(note_path).is_some_and(|(stored_id, stored_pdf)| {
        (stored_id.is_empty() || stored_id == paper_id) && stored_pdf == pdf_relative
    })
}

fn digest_prefix(value: &[u8], length: usize) -> String {
    format!("{:x}", Sha256::digest(value))
        .chars()
        .take(length)
        .collect()
}

fn unique_note_path_for_pdf(
    root: &Path,
    pdf_path: &Path,
    pdf_relative: &str,
    known_hash: Option<&str>,
    reuse_direct_owned_note: bool,
) -> Result<PathBuf, String> {
    let stem = pdf_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("paper");
    let direct_relative = format!("Notes/{stem}.md");
    let direct = managed_path(root, &direct_relative)?;
    if !direct.exists() || (reuse_direct_owned_note && note_belongs_to_pdf(&direct, pdf_relative)) {
        return Ok(direct);
    }

    let owned_hash;
    let pdf_hash = match known_hash.filter(|hash| !hash.is_empty()) {
        Some(hash) => hash,
        None => {
            owned_hash = hash_hex(pdf_path)?;
            &owned_hash
        }
    };
    let content_suffix = pdf_hash.chars().take(12).collect::<String>();
    let content_relative = format!("Notes/{stem}-{content_suffix}.md");
    let content_candidate = managed_path(root, &content_relative)?;
    if !content_candidate.exists() || note_belongs_to_pdf(&content_candidate, pdf_relative) {
        return Ok(content_candidate);
    }

    let location_suffix = digest_prefix(pdf_relative.as_bytes(), 8);
    let location_relative = format!("Notes/{stem}-{content_suffix}-{location_suffix}.md");
    let location_candidate = managed_path(root, &location_relative)?;
    if !location_candidate.exists() || note_belongs_to_pdf(&location_candidate, pdf_relative) {
        return Ok(location_candidate);
    }

    for suffix in 2..10_000 {
        let relative = format!("Notes/{stem}-{content_suffix}-{location_suffix}-{suffix}.md");
        let candidate = managed_path(root, &relative)?;
        if !candidate.exists() || note_belongs_to_pdf(&candidate, pdf_relative) {
            return Ok(candidate);
        }
    }
    managed_path(
        root,
        &format!("Notes/{stem}-{}.md", Uuid::new_v4().simple()),
    )
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
    managed_path(root, &format!(".rill/revisions/{paper_id}.json"))
}

fn store_revision_snapshot(root: &Path, paper: &Paper) -> Result<(), String> {
    validate_paper_storage_paths(root, paper)?;
    let path = revision_snapshot_path(root, &paper.id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("マージ履歴を作成できませんでした: {error}"))?;
    }
    let json = serde_json::to_vec(paper)
        .map_err(|error| format!("マージ履歴を変換できませんでした: {error}"))?;
    write_synced_then_rename(
        &path,
        &json,
        "マージ履歴を保存できませんでした",
        "マージ履歴を確定できませんでした",
    )
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
    let note_path = match note_path_override {
        Some(path) => {
            let relative = relative_string(root, path)?;
            managed_path(root, &relative)?
        }
        None => unique_note_path_for_pdf(root, pdf_path, &pdf_relative, None, true)?,
    };
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
    Ok(paper)
}

fn write_paper_with_previous_identity(
    root: &Path,
    paper: &Paper,
    allowed_previous_pdf: Option<&str>,
    allowed_previous_id: Option<&str>,
    allow_missing_id: bool,
) -> Result<(), String> {
    let (_, note_path) = validate_paper_storage_paths(root, paper)?;
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
    let existing = match fs::read_to_string(&note_path) {
        Ok(markdown) => {
            validate_note_identity(
                note_storage_identity_from_markdown(&markdown),
                paper,
                allowed_previous_pdf,
                allowed_previous_id,
                allow_missing_id,
            )?;
            markdown
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(format!(
                "既存のMarkdownノートを読み込めませんでした: {error}"
            ))
        }
    };
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
    write_synced_then_rename(
        &note_path,
        markdown.as_bytes(),
        "ノートを保存できませんでした",
        "ノートを確定できませんでした",
    )?;
    Ok(())
}

fn write_paper(root: &Path, paper: &Paper) -> Result<(), String> {
    write_paper_with_previous_identity(root, paper, None, None, false)
}

fn metadata_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!(
            "Rill/",
            env!("CARGO_PKG_VERSION"),
            " (local medical literature manager)"
        ))
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

fn match_words(value: &str) -> Vec<String> {
    let mut normalized = String::new();
    for character in strip_markup(value).chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            normalized.push(character);
        } else {
            normalized.push(' ');
        }
    }
    normalized.split_whitespace().map(str::to_string).collect()
}

fn token_similarity(left: &str, right: &str) -> f64 {
    let left = match_words(left).into_iter().collect::<HashSet<_>>();
    let right = match_words(right).into_iter().collect::<HashSet<_>>();
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(&right).count() as f64;
    let dice = (2.0 * intersection) / (left.len() + right.len()) as f64;
    let containment = intersection / left.len().min(right.len()) as f64;
    (0.65 * dice) + (0.35 * containment)
}

fn title_is_safe_to_match(title: &str) -> bool {
    let words = match_words(title);
    let characters = words.iter().map(String::len).sum::<usize>();
    words.len() >= 3 && characters >= 12
}

fn input_family_name(author: &str) -> String {
    let author = author.trim();
    if let Some((family, _)) = author.split_once(',') {
        return match_words(family).last().cloned().unwrap_or_default();
    }
    let words = author.split_whitespace().collect::<Vec<_>>();
    if words.len() > 1 {
        let last = words.last().copied().unwrap_or_default();
        let letters = last
            .chars()
            .filter(|character| character.is_alphabetic())
            .collect::<String>();
        let looks_like_initials =
            !letters.is_empty() && letters.len() <= 4 && letters.chars().all(char::is_uppercase);
        let family = if looks_like_initials { words[0] } else { last };
        return match_words(family).last().cloned().unwrap_or_default();
    }
    match_words(author).last().cloned().unwrap_or_default()
}

fn crossref_first_family(message: &serde_json::Value) -> String {
    message
        .get("author")
        .and_then(serde_json::Value::as_array)
        .and_then(|authors| authors.first())
        .map(|author| json_string(author.get("family")))
        .and_then(|family| match_words(&family).last().cloned())
        .unwrap_or_default()
}

fn crossref_journal(message: &serde_json::Value) -> String {
    json_string(
        message
            .get("container-title")
            .and_then(|value| value.get(0)),
    )
}

fn select_crossref_candidate(
    paper: &Paper,
    items: &[serde_json::Value],
) -> Result<serde_json::Value, String> {
    if !title_is_safe_to_match(&paper.title) {
        return Err("タイトルが短いかファイル名のままなので、DOIを安全に特定できません。タイトル・著者・年を確認してから再取得してください".into());
    }

    let input_family = paper
        .authors
        .first()
        .map(|author| input_family_name(author))
        .unwrap_or_default();
    let mut candidates = items
        .iter()
        .filter_map(|candidate| {
            let candidate_title =
                json_string(candidate.get("title").and_then(|value| value.get(0)));
            let title_similarity = token_similarity(&paper.title, &candidate_title);
            if title_similarity < 0.80 {
                return None;
            }

            let candidate_family = crossref_first_family(candidate);
            let author_available = !input_family.is_empty() && !candidate_family.is_empty();
            let author_matches = author_available && input_family == candidate_family;
            if author_available && !author_matches {
                return None;
            }

            let candidate_year = crossref_year(candidate);
            let year_available = paper.year.is_some() && candidate_year.is_some();
            let year_matches = year_available
                && paper
                    .year
                    .zip(candidate_year)
                    .is_some_and(|(left, right)| left.abs_diff(right) <= 1);
            if year_available && !year_matches {
                return None;
            }

            let candidate_journal = crossref_journal(candidate);
            let journal_similarity =
                if paper.journal.trim().is_empty() || candidate_journal.is_empty() {
                    0.0
                } else {
                    token_similarity(&paper.journal, &candidate_journal)
                };
            let supporting_matches = usize::from(author_matches)
                + usize::from(year_matches)
                + usize::from(journal_similarity >= 0.65);
            if title_similarity < 0.86 && supporting_matches < 2 {
                return None;
            }

            let score = title_similarity
                + if author_matches { 0.05 } else { 0.0 }
                + if year_matches { 0.03 } else { 0.0 }
                + if journal_similarity >= 0.65 {
                    0.02
                } else {
                    0.0
                };
            Some((
                score,
                title_similarity,
                supporting_matches,
                candidate.clone(),
            ))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.0.total_cmp(&left.0));
    let Some(best) = candidates.first() else {
        return Err("タイトル・著者・年に十分一致するDOI候補が見つかりませんでした。誤登録を避けるため書誌情報は変更していません".into());
    };
    if let Some(second) = candidates.get(1) {
        let decisive = best.1 >= 0.98 && best.2 >= 1;
        if best.0 - second.0 < 0.03 && !decisive {
            return Err(
                "同程度のDOI候補が複数あります。誤登録を避けるため自動選択しませんでした".into(),
            );
        }
    }
    Ok(best.3.clone())
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
        if !title_is_safe_to_match(&paper.title) {
            return Err("タイトルが短いかファイル名のままなので、DOIを安全に特定できません。タイトル・著者・年を確認してから再取得してください".into());
        }
        let mut request = client
            .get("https://api.crossref.org/works")
            .query(&[("query.title", paper.title.as_str()), ("rows", "5")]);
        let lead_family = paper
            .authors
            .first()
            .map(|author| input_family_name(author))
            .filter(|family| !family.is_empty());
        if let Some(family) = lead_family.as_deref() {
            request = request.query(&[("query.author", family)]);
        }
        let response = request
            .send()
            .map_err(|error| format!("Crossrefへ接続できません: {error}"))?;
        let response = response_json(response)?;
        let items = response
            .pointer("/message/items")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| "タイトルに一致する書誌情報が見つかりません".to_string())?;
        select_crossref_candidate(&paper, items)?
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
    if !filesystem_entry_exists(&direct) {
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
        if !filesystem_entry_exists(&candidate) {
            return candidate;
        }
    }
    folder.join(format!("{}.{extension}", Uuid::new_v4()))
}

fn filesystem_entry_exists(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

fn stage_pdf_copy(source: &Path, destination: &Path) -> Result<(PathBuf, String), String> {
    let (mut source_file, _) = open_validated_pdf(source)?;
    let temporary = unique_sibling_temporary_path(destination)?;
    let result = (|| {
        let mut destination_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("PDFの一時ファイルを作成できませんでした: {error}"))?;
        let mut hasher = Sha256::new();
        let mut total = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let bytes = source_file
                .read(&mut buffer)
                .map_err(|error| format!("PDFを読み込めませんでした: {error}"))?;
            if bytes == 0 {
                break;
            }
            total = total.saturating_add(bytes as u64);
            if total > MAX_PDF_BYTES {
                return Err(format!(
                    "PDFが大きすぎます。Rillで読み込める上限は{} MBです",
                    MAX_PDF_BYTES / 1024 / 1024
                ));
            }
            destination_file
                .write_all(&buffer[..bytes])
                .map_err(|error| format!("PDFをInboxへ追加できませんでした: {error}"))?;
            hasher.update(&buffer[..bytes]);
        }
        destination_file
            .sync_all()
            .map_err(|error| format!("追加したPDFを同期できませんでした: {error}"))?;
        validate_pdf_handle(&mut destination_file, destination)?;
        Ok(format!("{:x}", hasher.finalize()))
    })();
    match result {
        Ok(hash) => Ok((temporary, hash)),
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(error)
        }
    }
}

fn rollback_created_files(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .rev()
        .filter_map(|path| {
            fs::remove_file(path)
                .err()
                .filter(|error| error.kind() != std::io::ErrorKind::NotFound)
                .map(|error| format!("{}: {error}", path.to_string_lossy()))
        })
        .collect()
}

fn import_failure_message(message: String, rollback_errors: Vec<String>) -> String {
    if rollback_errors.is_empty() {
        message
    } else {
        format!(
            "{message}。追加済みファイルの復元にも失敗しました: {}",
            rollback_errors.join(" / ")
        )
    }
}

fn initialize_library_path(root: &Path) -> Result<(), String> {
    for folder in LIBRARY_DIRS {
        ensure_managed_directory(root, folder)?;
    }
    let settings = managed_path(root, ".rill/settings.json")?;
    if !settings.exists() {
        write_synced_then_rename(
            &settings,
            b"{\n  \"formatVersion\": 1\n}\n",
            "Rill設定を作成できませんでした",
            "Rill設定を確定できませんでした",
        )?;
    }
    Ok(())
}

#[tauri::command]
pub fn restore_library_root(app: AppHandle) -> Result<Option<String>, String> {
    let _write_guard = library_write_guard();
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
    let _write_guard = library_write_guard();
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
    let _write_guard = library_write_guard();
    let canonical = authorize_library_root(&path)?;
    initialize_library_path(&canonical)?;
    persist_library_root(&app, &canonical)?;
    Ok(Some(canonical.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn initialize_library(root: String) -> Result<(), String> {
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    initialize_library_path(&root)
}

fn scan_library_blocking(root: String) -> Result<Vec<Paper>, String> {
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    initialize_library_path(&root)?;
    let (mut index, index_writable) = load_library_index_with_recovery(&root, true)?;
    let original_index = index.clone();
    let mut claimed_ids = HashSet::new();
    let mut papers = Vec::new();
    for path in pdf_paths(&root)? {
        let pdf_relative = relative_string(&root, &path)?;
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("paper");
        let stem_note = managed_path(&root, &format!("Notes/{stem}.md"))?;
        let mut preferred_id = None;
        let mut note_override = None;
        let mut known_observation = None;
        let mut relinked = false;
        let mut exact_content_replaced = false;

        let mut exact_ids = index
            .papers
            .iter()
            .filter(|(id, entry)| entry.pdf_path == pdf_relative && !claimed_ids.contains(*id))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        exact_ids.sort();
        if let Some(id) = exact_ids.first() {
            if let Some(entry) = index.papers.get(id).cloned() {
                let (size, modified) = file_fingerprint(&path)?;
                let current_hash = if !entry.pdf_sha256.is_empty()
                    && index_fingerprint_matches(&entry, size, modified)
                {
                    entry.pdf_sha256.clone()
                } else {
                    let observation = hash_and_fingerprint(&path)?;
                    let hash = observation.sha256.clone();
                    known_observation = Some(observation);
                    hash
                };
                let indexed_note = paper_note_path(&root, &entry.note_path).ok();
                if !entry.pdf_sha256.is_empty()
                    && entry.pdf_sha256 == current_hash
                    && is_valid_paper_id(id)
                    && indexed_note
                        .as_deref()
                        .is_some_and(|note| indexed_note_is_owned(note, id, &pdf_relative))
                {
                    preferred_id = Some(id.clone());
                    note_override = indexed_note;
                } else {
                    exact_content_replaced =
                        !entry.pdf_sha256.is_empty() && entry.pdf_sha256 != current_hash;
                    if index_writable {
                        index.papers.remove(id);
                    }
                }
            }
        }

        if preferred_id.is_none()
            && !exact_content_replaced
            && stem_note.is_file()
            && note_belongs_to_pdf(&stem_note, &pdf_relative)
        {
            note_override = Some(stem_note);
        }

        if preferred_id.is_none() && note_override.is_none() {
            if known_observation.is_none() {
                known_observation = Some(hash_and_fingerprint(&path)?);
            }
            let pdf_hash = known_observation
                .as_ref()
                .map(|observation| observation.sha256.clone())
                .unwrap_or_default();
            let mut candidates = index
                .papers
                .iter()
                .filter(|(id, entry)| {
                    !claimed_ids.contains(*id)
                        && entry.pdf_sha256 == pdf_hash
                        && paper_pdf_path(&root, &entry.pdf_path)
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
                if let Ok(note) = paper_note_path(&root, &entry.note_path) {
                    if indexed_note_is_owned(&note, &id, &entry.pdf_path) {
                        preferred_id = Some(id);
                        note_override = Some(note);
                        relinked = true;
                    }
                }
            }
        }

        if note_override.is_none() {
            note_override = Some(unique_note_path_for_pdf(
                &root,
                &path,
                &pdf_relative,
                known_observation
                    .as_ref()
                    .map(|observation| observation.sha256.as_str()),
                !exact_content_replaced,
            )?);
        }

        let previous_note_identity = note_override.as_deref().and_then(note_storage_identity);

        let mut paper = paper_from_files_with_identity(
            &root,
            &path,
            note_override.as_deref(),
            preferred_id.as_deref(),
        )?;
        let duplicate_identity_repaired = claimed_ids.contains(&paper.id);
        if duplicate_identity_repaired {
            paper.id = Uuid::new_v4().to_string();
        }
        let frontmatter_pdf_is_stale = note_override
            .as_deref()
            .and_then(note_frontmatter_pdf_path)
            .is_some_and(|linked_path| linked_path != paper.pdf_path);
        let frontmatter_id_is_stale = previous_note_identity
            .as_ref()
            .is_some_and(|(stored_id, _)| stored_id != &paper.id);
        if index_writable {
            if let Some(index_id) = preferred_id.as_deref() {
                if index_id != paper.id {
                    index.papers.remove(index_id);
                }
            }
        }
        if relinked
            || frontmatter_pdf_is_stale
            || frontmatter_id_is_stale
            || duplicate_identity_repaired
        {
            write_paper_with_previous_identity(
                &root,
                &paper,
                previous_note_identity.as_ref().map(|(_, pdf)| pdf.as_str()),
                previous_note_identity.as_ref().map(|(id, _)| id.as_str()),
                true,
            )?;
            paper.note_revision = note_revision(&managed_path(&root, &paper.note_path)?);
            store_revision_snapshot(&root, &paper)?;
        } else if !revision_snapshot_path(&root, &paper.id)?.exists() {
            // Parsing an existing note must stay read-only. In particular, rewriting every
            // snapshot during startup can force cloud-backed placeholder files to materialize
            // and block the WebView main thread. Only create the baseline when it is missing;
            // explicit saves and merge operations update it afterwards.
            store_revision_snapshot(&root, &paper)?;
        }
        if claimed_ids.insert(paper.id.clone()) && index_writable {
            match index_entry_for_paper(
                &root,
                &paper,
                index.papers.get(&paper.id),
                known_observation.as_ref(),
            ) {
                Ok(entry) => {
                    index.papers.insert(paper.id.clone(), entry);
                }
                Err(error) => {
                    eprintln!("Rill index entry could not be rebuilt: {error}");
                }
            }
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

#[tauri::command]
pub async fn scan_library(root: String) -> Result<Vec<Paper>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_library_blocking(root))
        .await
        .map_err(|error| format!("ライブラリの読込み処理を完了できませんでした: {error}"))?
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
    let papers = scan_library_blocking(root.to_string_lossy().to_string())?;
    let mut hits = Vec::new();
    let mut pdf_by_path = HashMap::new();
    for paper in &papers {
        if let Ok(note_path) = managed_path(&root, &paper.note_path) {
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

fn import_pdfs_blocking(root: String, source_paths: Vec<String>) -> Result<ImportResult, String> {
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    initialize_library_path(&root)?;
    let sources = source_paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|source| source.is_file() && is_pdf(source))
        .collect::<Vec<_>>();

    // The library index already contains content hashes for scanned PDFs. Re-reading every
    // existing PDF here is especially expensive for cloud-backed libraries because macOS may
    // have to download each placeholder before hashing it. Only fall back to reading files that
    // are not represented by a usable index entry.
    let (index, writable) = load_library_index(&root)?;
    if !writable {
        return Err("このRillより新しい形式の文献インデックスです。PDFを追加せず、新しいRillで開いてください".into());
    }
    let mut known_hashes = HashSet::new();
    let mut indexed_paths = HashSet::new();
    for entry in index.papers.values() {
        let Ok(pdf) = paper_pdf_path(&root, &entry.pdf_path) else {
            continue;
        };
        let Ok((size, modified)) = file_fingerprint(&pdf) else {
            continue;
        };
        if !entry.pdf_sha256.is_empty() && index_fingerprint_matches(entry, size, modified) {
            known_hashes.insert(entry.pdf_sha256.clone());
            indexed_paths.insert(entry.pdf_path.clone());
        }
    }
    for existing in pdf_paths(&root)? {
        let Ok(relative) = relative_string(&root, &existing) else {
            continue;
        };
        if indexed_paths.contains(&relative) {
            continue;
        }
        if let Ok(hash) = hash_hex(&existing) {
            known_hashes.insert(hash);
        }
    }

    let mut imported = 0;
    let mut skipped_duplicates = 0;
    let mut created = Vec::new();
    for source in sources {
        let destination = unique_destination(&ensure_managed_directory(&root, "Inbox")?, &source);
        let (temporary, hash) = match stage_pdf_copy(&source, &destination) {
            Ok(staged) => staged,
            Err(error) => {
                let rollback_errors = rollback_created_files(&created);
                return Err(import_failure_message(error, rollback_errors));
            }
        };
        if known_hashes.contains(&hash) {
            let _ = fs::remove_file(&temporary);
            skipped_duplicates += 1;
            continue;
        }
        if let Err(error) = reject_symlink(&destination, "PDFの追加先").and_then(|_| {
            rename_without_overwrite(&temporary, &destination)
                .map_err(|error| format!("PDFをInboxへ追加できませんでした: {error}"))
        }) {
            let _ = fs::remove_file(&temporary);
            let rollback_errors = rollback_created_files(&created);
            return Err(import_failure_message(error, rollback_errors));
        }
        known_hashes.insert(hash);
        created.push(destination);
        imported += 1;
    }
    Ok(ImportResult {
        imported,
        skipped_duplicates,
    })
}

#[tauri::command]
pub async fn import_pdfs(root: String, source_paths: Vec<String>) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || import_pdfs_blocking(root, source_paths))
        .await
        .map_err(|error| format!("PDFの追加処理を完了できませんでした: {error}"))?
}

fn commit_paper_save<F>(root: &Path, mut paper: Paper, before_index: F) -> Result<Paper, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let (_, note_path) = validate_paper_storage_paths(root, &paper)?;
    let revision_path = revision_snapshot_path(root, &paper.id)?;
    let index_path = library_index_path(root)?;
    let note_backup = optional_file_contents(&note_path)?;
    let revision_backup = optional_file_contents(&revision_path)?;
    let index_backup = optional_file_contents(&index_path)?;
    let update = (|| {
        write_paper(root, &paper)?;
        let markdown = fs::read_to_string(&note_path)
            .map_err(|error| format!("保存したMarkdownノートを確認できませんでした: {error}"))?;
        paper.note_revision = markdown_revision(&markdown);
        store_revision_snapshot(root, &paper)?;
        before_index()?;
        upsert_library_index(root, &paper)?;
        Ok::<(), String>(())
    })();
    if let Err(error) = update {
        let mut rollback_errors = Vec::new();
        for (label, path, backup) in [
            ("ノート", &note_path, &note_backup),
            ("マージ履歴", &revision_path, &revision_backup),
            ("文献インデックス", &index_path, &index_backup),
        ] {
            if let Err(rollback_error) = restore_optional_file(path, backup) {
                rollback_errors.push(format!("{label}を元へ戻せませんでした: {rollback_error}"));
            }
        }
        if rollback_errors.is_empty() {
            return Err(error);
        }
        return Err(format!(
            "{error}。一部を元へ戻せませんでした。↻で再読込し、ファイルを確認してください: {}",
            rollback_errors.join(" / ")
        ));
    }
    Ok(paper)
}

#[tauri::command]
pub fn save_paper(root: String, paper: Paper) -> Result<Paper, String> {
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    let mut paper = ensure_citation_key(paper);
    let (pdf_path, note_path) = validate_paper_storage_paths(&root, &paper)?;
    if !pdf_path.is_file() {
        return Err("保存するPDFが見つかりません。ライブラリを再読込してください".into());
    }
    if !note_path.is_file() {
        return Err(
            "保存するMarkdownノートが見つかりません。ライブラリを再読込してください".into(),
        );
    }
    validate_indexed_pdf_ownership(&root, &paper, &pdf_path)?;
    validate_existing_note_ownership(&note_path, &paper, None, None, false)?;
    if note_path.exists()
        && !paper.note_revision.is_empty()
        && note_revision(&note_path) != paper.note_revision
    {
        let base = load_revision_snapshot(&root, &paper).ok_or_else(|| "Obsidian側の更新を検出しました。安全なマージ履歴がないため、↻で再読込してください。".to_string())?;
        let current =
            paper_from_files_with_identity(&root, &pdf_path, Some(&note_path), Some(&paper.id))?;
        paper = merge_paper_changes(&base, &paper, &current)?;
    }
    commit_paper_save(&root, paper, || Ok(()))
}

fn enrich_metadata_blocking(root: String, paper: Paper) -> Result<Paper, String> {
    root_path(&root)?;
    if paper.pmid.trim().is_empty() {
        enrich_from_crossref(paper)
    } else {
        enrich_from_pubmed(paper)
    }
}

#[tauri::command]
pub async fn enrich_metadata(root: String, paper: Paper) -> Result<Paper, String> {
    tauri::async_runtime::spawn_blocking(move || enrich_metadata_blocking(root, paper))
        .await
        .map_err(|error| format!("書誌情報の取得処理を完了できませんでした: {error}"))?
}

fn move_paper_pdf_transaction(
    root: &Path,
    paper: Paper,
    target_folder: &Path,
    move_error: &str,
) -> Result<Paper, String> {
    move_paper_pdf_transaction_with_hooks(
        root,
        paper,
        target_folder,
        move_error,
        || Ok(()),
        || Ok(()),
    )
}

fn move_paper_pdf_transaction_with_hooks<F, G>(
    root: &Path,
    mut paper: Paper,
    target_folder: &Path,
    move_error: &str,
    after_note: F,
    after_revision: G,
) -> Result<Paper, String>
where
    F: FnOnce() -> Result<(), String>,
    G: FnOnce() -> Result<(), String>,
{
    let (source, note_path) = validate_paper_storage_paths(root, &paper)?;
    if !source.is_file() {
        return Err("移動するPDFが見つかりません".into());
    }
    if !note_path.is_file() {
        return Err("移動するMarkdownノートが見つかりません".into());
    }
    validate_indexed_pdf_ownership(root, &paper, &source)?;
    validate_existing_note_ownership(&note_path, &paper, None, None, false)?;
    let annotation = annotation_path(root, &paper.id)?;
    reject_symlink(&annotation, "注釈ファイル")?;
    let revision = revision_snapshot_path(root, &paper.id)?;
    let index_path = library_index_path(root)?;
    let note_backup = optional_file_contents(&note_path)?;
    let revision_backup = optional_file_contents(&revision)?;
    let index_backup = optional_file_contents(&index_path)?;
    let previous_pdf_path = paper.pdf_path.clone();
    let destination = unique_destination(target_folder, &source);
    let destination_relative = relative_string(root, &destination)?;
    paper_pdf_path(root, &destination_relative)?;

    rename_without_overwrite(&source, &destination)
        .map_err(|error| format!("{move_error}: {error}"))?;
    paper.pdf_path = destination_relative;
    let update = (|| {
        write_paper_with_previous_identity(root, &paper, Some(&previous_pdf_path), None, false)?;
        after_note()?;
        paper.note_revision = note_revision(&note_path);
        store_revision_snapshot(root, &paper)?;
        after_revision()?;
        upsert_library_index(root, &paper)?;
        Ok::<(), String>(())
    })();
    if let Err(error) = update {
        let mut rollback_errors = Vec::new();
        if let Err(rollback_error) = rename_without_overwrite(&destination, &source) {
            rollback_errors.push(format!("PDFを元へ戻せませんでした: {rollback_error}"));
        }
        for (label, path, backup) in [
            ("ノート", &note_path, &note_backup),
            ("マージ履歴", &revision, &revision_backup),
            ("文献インデックス", &index_path, &index_backup),
        ] {
            if let Err(rollback_error) = restore_optional_file(path, backup) {
                rollback_errors.push(format!("{label}を元へ戻せませんでした: {rollback_error}"));
            }
        }
        if rollback_errors.is_empty() {
            return Err(error);
        }
        return Err(format!(
            "{error}。一部を元へ戻せませんでした。↻で再読込し、ファイルを確認してください: {}",
            rollback_errors.join(" / ")
        ));
    }
    Ok(paper)
}

#[tauri::command]
pub fn organize_paper(root: String, paper: Paper) -> Result<Paper, String> {
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    let (_, note_path) = validate_paper_storage_paths(&root, &paper)?;
    if note_path.exists()
        && !paper.note_revision.is_empty()
        && note_revision(&note_path) != paper.note_revision
    {
        return Err("Obsidian側の更新を検出しました。↻で再読込してから移動してください。".into());
    }
    if !paper.pdf_path.starts_with("Inbox/") {
        return Ok(paper);
    }
    let target = ensure_managed_directory(&root, "Papers")?;
    move_paper_pdf_transaction(&root, paper, &target, "PDFをPapersへ移動できませんでした")
}

fn collection_root(root: &Path, collection: &str) -> Result<PathBuf, String> {
    let papers_root = managed_directory(root, "Papers")?;
    if collection.trim().is_empty() {
        return Ok(papers_root);
    }
    managed_path(root, &format!("Papers/{}", collection.trim()))
}

fn validate_collection_name(name: &str) -> Result<&str, String> {
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
    Ok(name)
}

fn move_collection_directory(
    root: &Path,
    collection: &str,
    destination_parent: &str,
    destination_name: &str,
) -> Result<String, String> {
    let (_, index_writable) = load_library_index(root)?;
    if !index_writable {
        return Err("このRillより新しい形式の文献インデックスです。フォルダを移動せず、新しいRillで開いてください".into());
    }
    let collection = collection.trim().trim_matches('/');
    let destination_parent = destination_parent.trim().trim_matches('/');
    let destination_name = validate_collection_name(destination_name)?;
    if collection.is_empty() || collection.starts_with("__") {
        return Err("このフォルダは移動できません".into());
    }
    if destination_parent == collection || destination_parent.starts_with(&format!("{collection}/"))
    {
        return Err("フォルダを自分自身の中へ移動することはできません".into());
    }

    let source = collection_root(root, collection)?;
    if !source.is_dir() {
        return Err("移動するフォルダが見つかりません".into());
    }
    if source
        .symlink_metadata()
        .map_err(|error| format!("フォルダを確認できませんでした: {error}"))?
        .file_type()
        .is_symlink()
    {
        return Err("シンボリックリンクのフォルダは移動できません".into());
    }

    let parent = collection_root(root, destination_parent)?;
    if !parent.is_dir() {
        return Err("移動先フォルダが見つかりません".into());
    }
    let destination_relative = if destination_parent.is_empty() {
        destination_name.to_string()
    } else {
        format!("{destination_parent}/{destination_name}")
    };
    let destination = collection_root(root, &destination_relative)?;
    if destination == source {
        return Ok(collection.to_string());
    }
    if destination.exists() {
        return Err(format!(
            "「{destination_relative}」はすでに存在します。別の名前を選んでください"
        ));
    }
    fs::rename(&source, &destination)
        .map_err(|error| format!("フォルダを移動できませんでした: {error}"))?;
    Ok(destination_relative)
}

#[tauri::command]
pub fn list_collections(root: String) -> Result<Vec<String>, String> {
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    initialize_library_path(&root)?;
    let papers_root = managed_directory(&root, "Papers")?;
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
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    initialize_library_path(&root)?;
    let name = validate_collection_name(&name)?;
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
pub fn rename_collection(root: String, collection: String, name: String) -> Result<String, String> {
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    initialize_library_path(&root)?;
    let collection = collection.trim().trim_matches('/');
    let parent = Path::new(collection)
        .parent()
        .and_then(Path::to_str)
        .unwrap_or_default()
        .replace('\\', "/");
    move_collection_directory(&root, collection, &parent, &name)
}

#[tauri::command]
pub fn move_collection(root: String, collection: String, parent: String) -> Result<String, String> {
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    initialize_library_path(&root)?;
    let collection = collection.trim().trim_matches('/');
    let name = Path::new(collection)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "移動するフォルダ名を確認できませんでした".to_string())?;
    move_collection_directory(&root, collection, &parent, name)
}

#[tauri::command]
pub fn delete_collection(root: String, collection: String) -> Result<(), String> {
    let _write_guard = library_write_guard();
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
    paper: Paper,
    collection: String,
) -> Result<Paper, String> {
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    let (source, note_path) = validate_paper_storage_paths(&root, &paper)?;
    if note_path.exists()
        && !paper.note_revision.is_empty()
        && note_revision(&note_path) != paper.note_revision
    {
        return Err("Obsidian側の更新を検出しました。↻で再読込してから移動してください。".into());
    }
    if !source.is_file() || !is_pdf(&source) {
        return Err("移動するPDFが見つかりません".into());
    }
    let target_folder = if collection == "__inbox" {
        ensure_managed_directory(&root, "Inbox")?
    } else {
        collection_root(&root, &collection)?
    };
    fs::create_dir_all(&target_folder)
        .map_err(|error| format!("移動先フォルダを作成できませんでした: {error}"))?;
    if source.parent() == Some(target_folder.as_path()) {
        return Ok(paper);
    }
    move_paper_pdf_transaction(
        &root,
        paper,
        &target_folder,
        "PDFをフォルダへ移動できませんでした",
    )
}

fn trash_entry_dir(root: &Path, paper_id: &str) -> Result<PathBuf, String> {
    if paper_id.is_empty()
        || !paper_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("文献IDが不正です".into());
    }
    managed_path(root, &format!("Trash/{paper_id}"))
}

fn trash_manifest_path(root: &Path, paper_id: &str) -> Result<PathBuf, String> {
    managed_path(root, &format!("Trash/{paper_id}/paper.json"))
}

fn paper_managed_paths(root: &Path, paper: &Paper) -> Result<Vec<(String, PathBuf)>, String> {
    let (pdf, note) = validate_paper_storage_paths(root, paper)?;
    let annotation_relative = format!(".rill/annotations/{}.json", paper.id);
    let revision_relative = format!(".rill/revisions/{}.json", paper.id);
    Ok(vec![
        (paper.pdf_path.clone(), pdf),
        (paper.note_path.clone(), note),
        (annotation_relative, annotation_path(root, &paper.id)?),
        (revision_relative, revision_snapshot_path(root, &paper.id)?),
    ])
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
        if let Err(error) = rename_without_overwrite(source, destination) {
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
            rename_without_overwrite(relocated, original)
                .err()
                .map(|error| {
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
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    initialize_library_path(&root)?;
    let (pdf, note) = validate_paper_storage_paths(&root, &paper)?;
    if !pdf.is_file() || !is_pdf(&pdf) {
        return Err("ゴミ箱へ移動するPDFが見つかりません".into());
    }
    validate_indexed_pdf_ownership(&root, &paper, &pdf)?;
    if !note.is_file() {
        return Err("Markdownノートが見つかりません。ライブラリを再読込してください".into());
    }
    validate_existing_note_ownership(&note, &paper, None, None, false)?;
    let (_, index_writable) = load_library_index(&root)?;
    if !index_writable {
        return Err("このRillより新しい形式の文献インデックスです。ゴミ箱へ移動せず、新しいRillで開いてください".into());
    }
    let index_path = library_index_path(&root)?;
    let index_backup = optional_file_contents(&index_path)?;
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
    if let Err(error) = write_synced_then_rename(
        &manifest,
        &json,
        "復元情報を保存できませんでした",
        "復元情報を確定できませんでした",
    ) {
        let _ = fs::remove_dir_all(&entry_dir);
        return Err(error);
    }
    let pairs = paper_managed_paths(&root, &paper)?
        .into_iter()
        .map(|(relative, source)| {
            let destination = managed_path(&root, &format!("Trash/{}/{relative}", paper.id))?;
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
    if let Err(error) = remove_library_index_entry(&root, &paper.id) {
        let mut rollback_errors = rollback_moved_files(&pairs);
        if let Err(rollback_error) = restore_optional_file(&index_path, &index_backup) {
            rollback_errors.push(format!(
                "文献インデックスを元へ戻せませんでした: {rollback_error}"
            ));
        }
        if rollback_errors.is_empty() {
            let _ = fs::remove_dir_all(&entry_dir);
        }
        return Err(move_failure_message(error, rollback_errors));
    }
    Ok(entry)
}

#[tauri::command]
pub fn list_trashed_papers(root: String) -> Result<Vec<TrashEntry>, String> {
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    initialize_library_path(&root)?;
    let trash_root = managed_directory(&root, "Trash")?;
    let mut entries = fs::read_dir(&trash_root)
        .map_err(|error| format!("Rillのゴミ箱を読み込めませんでした: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|file_type| file_type.is_dir()))
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|paper_id| trash_manifest_path(&root, paper_id).ok())
                .and_then(|manifest| fs::read_to_string(manifest).ok())
                .and_then(|json| serde_json::from_str::<TrashEntry>(&json).ok())
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| right.deleted_at.cmp(&left.deleted_at));
    Ok(entries)
}

#[tauri::command]
pub fn restore_trashed_paper(root: String, paper_id: String) -> Result<Paper, String> {
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    initialize_library_path(&root)?;
    let entry = load_trash_entry(&root, &paper_id)?;
    if entry.paper.id != paper_id {
        return Err("ゴミ箱の復元情報と文献IDが一致しません".into());
    }
    let (_, index_writable) = load_library_index(&root)?;
    if !index_writable {
        return Err(
            "このRillより新しい形式の文献インデックスです。復元せず、新しいRillで開いてください"
                .into(),
        );
    }
    let entry_dir = trash_entry_dir(&root, &paper_id)?;
    let managed_paths = paper_managed_paths(&root, &entry.paper)?;
    let stored_pdf = managed_path(&root, &format!("Trash/{paper_id}/{}", entry.paper.pdf_path))?;
    if !stored_pdf.is_file() || !is_pdf(&stored_pdf) {
        return Err("ゴミ箱内のPDFが見つかりません".into());
    }
    let stored_note = managed_path(
        &root,
        &format!("Trash/{paper_id}/{}", entry.paper.note_path),
    )?;
    if !stored_note.is_file() {
        return Err("ゴミ箱内のMarkdownノートが見つかりません".into());
    }
    let (stored_id, stored_pdf_path) = note_storage_identity(&stored_note)
        .ok_or_else(|| "ゴミ箱内のMarkdownノートの所有情報を確認できません".to_string())?;
    if stored_id != entry.paper.id || stored_pdf_path != entry.paper.pdf_path {
        return Err("ゴミ箱内のMarkdownノートが別の文献に属しています".into());
    }
    let pairs = managed_paths
        .into_iter()
        .map(|(relative, destination)| {
            let source = managed_path(&root, &format!("Trash/{paper_id}/{relative}"))?;
            Ok((source, destination))
        })
        .collect::<Result<Vec<_>, String>>()?
        .into_iter()
        .filter(|(source, _)| source.exists())
        .collect::<Vec<_>>();
    let index_path = library_index_path(&root)?;
    let index_backup = optional_file_contents(&index_path)?;
    move_files_with_rollback(&pairs)?;
    if let Err(error) = upsert_library_index(&root, &entry.paper) {
        let mut rollback_errors = rollback_moved_files(&pairs);
        if let Err(rollback_error) = restore_optional_file(&index_path, &index_backup) {
            rollback_errors.push(format!(
                "文献インデックスを元へ戻せませんでした: {rollback_error}"
            ));
        }
        return Err(move_failure_message(error, rollback_errors));
    }
    fs::remove_dir_all(&entry_dir)
        .map_err(|error| format!("復元後のゴミ箱情報を整理できませんでした: {error}"))?;
    Ok(entry.paper)
}

#[tauri::command]
pub fn delete_trashed_paper_permanently(root: String, paper_id: String) -> Result<(), String> {
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    initialize_library_path(&root)?;
    let _ = load_trash_entry(&root, &paper_id)?;
    let entry_dir = trash_entry_dir(&root, &paper_id)?;
    let index_path = library_index_path(&root)?;
    let index_backup = optional_file_contents(&index_path)?;
    remove_library_index_entry(&root, &paper_id)?;
    if let Err(error) = fs::remove_dir_all(entry_dir) {
        return match restore_optional_file(&index_path, &index_backup) {
            Ok(()) => Err(format!("文献を完全に削除できませんでした: {error}")),
            Err(rollback_error) => Err(format!(
                "文献を完全に削除できませんでした: {error}。文献インデックスの復元にも失敗しました: {rollback_error}"
            )),
        };
    }
    Ok(())
}

#[tauri::command]
pub fn open_rill_trash_folder(root: String) -> Result<(), String> {
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    initialize_library_path(&root)?;
    let trash = managed_directory(&root, "Trash")?;
    run_macos_open(&[trash.to_string_lossy().as_ref()])
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
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    let export_dir = ensure_managed_directory(&root, "Exports")?;
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
    let bibtex_path = managed_path(&root, "Exports/rill-library.bib")?;
    let markdown_path = managed_path(&root, "Exports/references.md")?;
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
    managed_path(root, &format!(".rill/annotations/{paper_id}.json"))
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
    let pdf = paper_pdf_path(&root, &pdf_path)?;
    let (file, size) = open_validated_pdf(&pdf)?;
    let mut bytes = Vec::with_capacity(size.min(8 * 1024 * 1024) as usize);
    file.take(MAX_PDF_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("PDFを読み込めませんでした: {error}"))?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err(format!(
            "PDFが大きすぎます。Rillで読み込める上限は{} MBです",
            MAX_PDF_BYTES / 1024 / 1024
        ));
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn pdf_file_exists(root: String, pdf_path: String) -> Result<bool, String> {
    let root = root_path(&root)?;
    let pdf = paper_pdf_path(&root, &pdf_path)?;
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
    let _write_guard = library_write_guard();
    let root = root_path(&root)?;
    save_pdf_annotations_inner(&root, &paper, &annotations, || Ok(()))
}

fn save_pdf_annotations_inner<F>(
    root: &Path,
    paper: &Paper,
    annotations: &[PdfAnnotation],
    before_markdown_commit: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    let (pdf_path, note_path) = validate_paper_storage_paths(root, paper)?;
    if !pdf_path.is_file() {
        return Err("注釈を保存するPDFが見つかりません".into());
    }
    validate_indexed_pdf_ownership(root, paper, &pdf_path)?;
    let path = annotation_path(root, &paper.id)?;
    let previous_json = match fs::read(&path) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("既存の注釈を確認できませんでした: {error}")),
    };
    let markdown = fs::read_to_string(&note_path)
        .map_err(|error| format!("Markdownノートを読み込めませんでした: {error}"))?;
    validate_note_identity(
        note_storage_identity_from_markdown(&markdown),
        paper,
        None,
        None,
        false,
    )?;
    let updated =
        replace_markdown_section(&markdown, "Highlights", &annotations_markdown(annotations));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("注釈フォルダを作成できませんでした: {error}"))?;
    }
    let json = serde_json::to_string_pretty(&annotations)
        .map_err(|error| format!("注釈を保存形式へ変換できませんでした: {error}"))?;
    write_synced_then_rename(
        &path,
        json.as_bytes(),
        "注釈を保存できませんでした",
        "注釈を確定できませんでした",
    )?;

    let markdown_commit = before_markdown_commit().and_then(|_| {
        write_synced_then_rename(
            &note_path,
            updated.as_bytes(),
            "HighlightsをMarkdownへ保存できませんでした",
            "Highlightsを確定できませんでした",
        )
    });
    if let Err(error) = markdown_commit {
        let rollback = match previous_json {
            Some(content) => write_synced_then_rename(
                &path,
                &content,
                "注釈JSONを元へ戻せませんでした",
                "注釈JSONの復元を確定できませんでした",
            ),
            None => match fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(remove_error) if remove_error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(remove_error) => Err(format!(
                    "新規注釈JSONを取り消せませんでした: {remove_error}"
                )),
            },
        };
        return match rollback {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(format!(
                "{error}。注釈JSONの復元にも失敗したため、Markdownと一致しない可能性があります: {rollback_error}"
            )),
        };
    }
    Ok(())
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

fn obsidian_vault_candidates(root: &Path) -> Vec<PathBuf> {
    [root.to_path_buf(), root.join("Notes")]
        .into_iter()
        .filter(|candidate| candidate.join(".obsidian").is_dir())
        .collect()
}

fn registered_obsidian_vault_from_json(root: &Path, registry: &[u8]) -> Option<PathBuf> {
    let registry = serde_json::from_slice::<serde_json::Value>(registry).ok()?;
    let vaults = registry.get("vaults")?.as_object()?;
    let registered_paths = vaults
        .values()
        .filter_map(|vault| vault.get("path")?.as_str())
        .filter_map(|path| fs::canonicalize(path).ok())
        .collect::<HashSet<_>>();

    obsidian_vault_candidates(root)
        .into_iter()
        .find_map(|candidate| {
            let canonical = fs::canonicalize(&candidate).ok()?;
            registered_paths.contains(&canonical).then_some(candidate)
        })
}

fn registered_obsidian_vault(root: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        let registry = fs::read(
            home.join("Library")
                .join("Application Support")
                .join("obsidian")
                .join("obsidian.json"),
        )
        .ok()?;
        registered_obsidian_vault_from_json(root, &registry)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = root;
        None
    }
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
    let pdf = paper_pdf_path(&root, &pdf_path)?;
    if !pdf.is_file() || !is_pdf(&pdf) {
        return Err("PDFファイルが見つかりません".into());
    }
    run_macos_open(&["-a", "Preview", pdf.to_string_lossy().as_ref()])
}

#[tauri::command]
pub fn obsidian_vault_status(root: String) -> Result<bool, String> {
    let root = root_path(&root)?;
    Ok(registered_obsidian_vault(&root).is_some())
}

#[tauri::command]
pub fn open_obsidian_app() -> Result<(), String> {
    run_macos_open(&["-a", "Obsidian"])
}

#[tauri::command]
pub fn open_note_in_obsidian(root: String, note_path: String) -> Result<(), String> {
    let root = root_path(&root)?;
    let note = paper_note_path(&root, &note_path)?;
    if !note.is_file()
        || !note
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err("Markdownノートが見つかりません".into());
    }
    if registered_obsidian_vault(&root).is_none() {
        return Err(
            "Obsidianの「保管庫を管理」からRillの保存場所をVaultとして開いてください".into(),
        );
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
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Mutex, MutexGuard};

    static LIBRARY_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn library_test_guard() -> MutexGuard<'static, ()> {
        LIBRARY_TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn test_library(label: &str) -> (PathBuf, PathBuf) {
        let test_dir = std::env::temp_dir().join(format!("{label}-{}", Uuid::new_v4()));
        let library = test_dir.join("Rill");
        fs::create_dir_all(&library).expect("テスト用ライブラリを作成");
        authorize_library_root(&library).expect("テスト用ライブラリを許可");
        initialize_library(library.to_string_lossy().to_string())
            .expect("テスト用ライブラリを初期化");
        (test_dir, library)
    }

    fn metadata_test_paper(title: &str) -> Paper {
        Paper {
            id: "metadata-test".into(),
            title: title.into(),
            authors: Vec::new(),
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
            tags: Vec::new(),
            status: default_status(),
            pdf_path: "Inbox/metadata-test.pdf".into(),
            note_path: "Notes/metadata-test.md".into(),
            summary: String::new(),
            translated_summary: String::new(),
            clinical_note: String::new(),
            added_at: Utc::now().to_rfc3339(),
            note_revision: String::new(),
        }
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

    #[cfg(unix)]
    #[test]
    fn initialization_rejects_symlinked_managed_directories() {
        use std::os::unix::fs::symlink;

        let _guard = library_test_guard();
        for relative in [
            "Inbox",
            "Papers",
            "Notes",
            "Exports",
            "Trash",
            ".rill",
            ".rill/revisions",
            ".rill/annotations",
        ] {
            let test_dir =
                std::env::temp_dir().join(format!("rill-managed-symlink-{}", Uuid::new_v4()));
            let library = test_dir.join("Rill");
            let outside = test_dir.join("outside");
            fs::create_dir_all(&library).expect("ライブラリを作成");
            fs::create_dir_all(&outside).expect("ライブラリ外フォルダを作成");
            authorize_library_root(&library).expect("ライブラリを許可");
            initialize_library_path(&library).expect("初回初期化");
            let target = library.join(relative);
            fs::remove_dir_all(&target).expect("管理フォルダを差し替え");
            symlink(&outside, &target).expect("脱出リンクを作成");

            let error = initialize_library_path(&library).expect_err("リンクを拒否");

            assert!(error.contains("シンボリックリンク"), "{relative}: {error}");
            fs::remove_file(&target).expect("リンクを削除");
            fs::remove_dir_all(&test_dir).expect("テストデータを削除");
        }
    }

    #[cfg(unix)]
    #[test]
    fn managed_leaf_symlinks_are_not_followed() {
        use std::os::unix::fs::symlink;

        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-managed-leaf-symlink");
        let outside = test_dir.join("outside.json");
        fs::write(&outside, b"outside must stay intact").expect("外部ファイルを作成");
        let index = library.join(".rill/index.json");
        symlink(&outside, &index).expect("indexリンクを作成");

        let scan_error = scan_library_blocking(library.to_string_lossy().to_string())
            .expect_err("indexリンクを拒否");
        assert!(scan_error.contains("シンボリックリンク"));
        assert_eq!(
            fs::read(&outside).expect("外部ファイルを確認"),
            b"outside must stay intact"
        );
        fs::remove_file(&index).expect("indexリンクを削除");

        let revision = library.join(".rill/revisions/metadata-test.json");
        symlink(&outside, &revision).expect("履歴リンクを作成");
        let revision_error = store_revision_snapshot(&library, &metadata_test_paper("test"))
            .expect_err("履歴リンクを拒否");
        assert!(revision_error.contains("シンボリックリンク"));
        assert_eq!(
            fs::read(&outside).expect("外部ファイルを再確認"),
            b"outside must stay intact"
        );
        fs::remove_file(&revision).expect("履歴リンクを削除");

        let import_source = test_dir.join("import.pdf");
        fs::write(&import_source, b"%PDF-1.7\nvalid import\n").expect("追加元PDFを作成");
        let escaped_pdf = test_dir.join("escaped.pdf");
        let import_link = library.join("Inbox/import.pdf");
        symlink(&escaped_pdf, &import_link).expect("追加先にダングリングリンクを作成");
        let imported = import_pdfs_blocking(
            library.to_string_lossy().to_string(),
            vec![import_source.to_string_lossy().to_string()],
        )
        .expect("リンクを避けてPDFを追加");
        assert_eq!(imported.imported, 1);
        assert!(!escaped_pdf.exists());
        assert!(import_link.symlink_metadata().is_ok());
        assert!(library.join("Inbox/import-2.pdf").is_file());
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn same_basename_pdfs_keep_separate_notes_and_identities() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-same-basename");
        fs::create_dir_all(library.join("Papers/topic-a")).expect("topic-aを作成");
        fs::create_dir_all(library.join("Papers/topic-b")).expect("topic-bを作成");
        fs::write(
            library.join("Papers/topic-a/foo.pdf"),
            b"%PDF-1.4\nfirst distinct paper\n",
        )
        .expect("最初のPDFを作成");
        fs::write(
            library.join("Papers/topic-b/foo.pdf"),
            b"%PDF-1.4\nsecond distinct paper\n",
        )
        .expect("2つ目のPDFを作成");

        let mut papers =
            scan_library_blocking(library.to_string_lossy().to_string()).expect("同名PDFを走査");
        papers.sort_by(|left, right| left.pdf_path.cmp(&right.pdf_path));
        assert_eq!(papers.len(), 2);
        assert_ne!(papers[0].id, papers[1].id);
        assert_ne!(papers[0].note_path, papers[1].note_path);
        assert!(papers[0].note_path.starts_with("Notes/foo"));
        assert!(papers[1].note_path.starts_with("Notes/foo"));

        papers[0].summary = "topic-a summary".into();
        papers[1].summary = "topic-b summary".into();
        let saved_a = save_paper(library.to_string_lossy().to_string(), papers[0].clone())
            .expect("topic-aを保存");
        let saved_b = save_paper(library.to_string_lossy().to_string(), papers[1].clone())
            .expect("topic-bを保存");

        let rescanned =
            scan_library_blocking(library.to_string_lossy().to_string()).expect("保存後に再走査");
        let rescanned_a = rescanned
            .iter()
            .find(|paper| paper.pdf_path == saved_a.pdf_path)
            .expect("topic-aを再読込");
        let rescanned_b = rescanned
            .iter()
            .find(|paper| paper.pdf_path == saved_b.pdf_path)
            .expect("topic-bを再読込");
        assert_eq!(rescanned_a.id, saved_a.id);
        assert_eq!(rescanned_b.id, saved_b.id);
        assert_eq!(rescanned_a.summary, "topic-a summary");
        assert_eq!(rescanned_b.summary, "topic-b summary");
        assert_ne!(rescanned_a.note_path, rescanned_b.note_path);
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn replacing_pdf_at_same_path_allocates_a_new_identity_and_note() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-same-path-replacement");
        let pdf = library.join("Inbox/replaced.pdf");
        fs::write(&pdf, b"%PDF-1.4\noriginal medical paper\n").expect("最初のPDFを作成");
        let mut original = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("初回走査")
            .remove(0);
        original.summary = "元の論文の要約".into();
        original =
            save_paper(library.to_string_lossy().to_string(), original).expect("元論文を保存");
        let original_note = library.join(&original.note_path);

        fs::write(
            &pdf,
            b"%PDF-1.7\na different replacement medical paper with new content\n",
        )
        .expect("同じ場所のPDFを差し替え");
        let mut stale = original.clone();
        stale.summary = "誤って上書きしてはいけない".into();
        let save_error = save_paper(library.to_string_lossy().to_string(), stale)
            .expect_err("差し替え後の古い文献状態を拒否");
        assert!(save_error.contains("差し替え"));

        let replacement = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("差し替え後を走査")
            .remove(0);
        assert_ne!(replacement.id, original.id);
        assert_ne!(replacement.note_path, original.note_path);
        assert!(fs::read_to_string(&original_note)
            .expect("元ノートを保持")
            .contains("元の論文の要約"));

        let rescanned = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("再走査")
            .remove(0);
        assert_eq!(rescanned.id, replacement.id);
        assert_eq!(rescanned.note_path, replacement.note_path);
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn legacy_index_without_fingerprint_is_upgraded_without_changing_identity() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-legacy-index-fingerprint");
        fs::write(
            library.join("Inbox/legacy.pdf"),
            b"%PDF-1.4\nlegacy index paper\n",
        )
        .expect("PDFを作成");
        let initial = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("初回走査")
            .remove(0);
        let index_path = library_index_path(&library).expect("indexパス");
        let mut json: serde_json::Value =
            serde_json::from_slice(&fs::read(&index_path).expect("indexを読込")).expect("JSON");
        let entry = json["papers"][&initial.id]
            .as_object_mut()
            .expect("文献entry");
        entry.remove("pdfSize");
        entry.remove("pdfModifiedNanos");
        fs::write(
            &index_path,
            serde_json::to_vec_pretty(&json).expect("旧indexを作成"),
        )
        .expect("旧indexを保存");

        let rescanned = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("旧indexを走査")
            .remove(0);
        assert_eq!(rescanned.id, initial.id);
        assert_eq!(rescanned.note_path, initial.note_path);
        let upgraded = load_library_index(&library).expect("更新indexを読込").0;
        let upgraded_entry = upgraded.papers.get(&initial.id).expect("更新entry");
        assert!(upgraded_entry.pdf_size.is_some());
        assert!(upgraded_entry.pdf_modified_nanos.is_some());
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn paper_storage_paths_are_restricted_to_their_managed_subtrees() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-paper-path-types");
        let mut paper = metadata_test_paper("typed paths");
        assert!(validate_paper_storage_paths(&library, &paper).is_ok());
        paper.pdf_path = "Notes/not-a-paper.pdf".into();
        assert!(validate_paper_storage_paths(&library, &paper).is_err());
        paper.pdf_path = "Inbox/metadata-test.pdf".into();
        paper.note_path = "Papers/not-a-note.md".into();
        assert!(validate_paper_storage_paths(&library, &paper).is_err());
        paper.note_path = "Notes/not-a-note.txt".into();
        assert!(validate_paper_storage_paths(&library, &paper).is_err());
        paper.note_path = "Notes/./not-a-note.md".into();
        assert!(validate_paper_storage_paths(&library, &paper).is_err());
        paper.note_path = "Notes//not-a-note.md".into();
        assert!(validate_paper_storage_paths(&library, &paper).is_err());
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn save_paper_restores_note_revision_and_index_when_commit_fails() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-save-rollback");
        fs::write(
            library.join("Inbox/save-rollback.pdf"),
            b"%PDF-1.4\nsave rollback\n",
        )
        .expect("PDFを作成");
        let mut paper = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("PDFを走査")
            .remove(0);
        paper = save_paper(library.to_string_lossy().to_string(), paper).expect("基準状態を保存");
        let note = library.join(&paper.note_path);
        let revision = revision_snapshot_path(&library, &paper.id).expect("履歴パス");
        let index = library_index_path(&library).expect("indexパス");
        let baseline_note = fs::read(&note).expect("基準ノート");
        let baseline_revision = fs::read(&revision).expect("基準履歴");
        let baseline_index = fs::read(&index).expect("基準index");

        paper.summary = "ロールバックする更新".into();
        let error = commit_paper_save(&library, paper, || Err("index commit failure".into()))
            .expect_err("index確定失敗を返す");

        assert!(error.contains("index commit failure"));
        assert_eq!(fs::read(&note).expect("ノートを再確認"), baseline_note);
        assert_eq!(
            fs::read(&revision).expect("履歴を再確認"),
            baseline_revision
        );
        assert_eq!(fs::read(&index).expect("indexを再確認"), baseline_index);
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn move_paper_restores_all_files_after_each_post_move_failure() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-paper-move-rollback");
        let source = library.join("Inbox/move-rollback.pdf");
        fs::write(&source, b"%PDF-1.4\nmove rollback\n").expect("PDFを作成");
        let paper = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("PDFを走査")
            .remove(0);
        let note = library.join(&paper.note_path);
        let revision = revision_snapshot_path(&library, &paper.id).expect("履歴パス");
        let index = library_index_path(&library).expect("indexパス");
        let baseline_note = fs::read(&note).expect("基準ノート");
        let baseline_revision = fs::read(&revision).expect("基準履歴");
        let baseline_index = fs::read(&index).expect("基準index");
        let target = managed_directory(&library, "Papers").expect("移動先");

        for fail_after_note in [true, false] {
            let result = if fail_after_note {
                move_paper_pdf_transaction_with_hooks(
                    &library,
                    paper.clone(),
                    &target,
                    "move failed",
                    || Err("after note failure".into()),
                    || Ok(()),
                )
            } else {
                move_paper_pdf_transaction_with_hooks(
                    &library,
                    paper.clone(),
                    &target,
                    "move failed",
                    || Ok(()),
                    || Err("after revision failure".into()),
                )
            };
            assert!(result.is_err());
            assert!(source.is_file(), "元のPDFを復元する");
            assert!(!library.join("Papers/move-rollback.pdf").exists());
            assert_eq!(fs::read(&note).expect("ノートを再確認"), baseline_note);
            assert_eq!(
                fs::read(&revision).expect("履歴を再確認"),
                baseline_revision
            );
            assert_eq!(fs::read(&index).expect("indexを再確認"), baseline_index);
        }
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn exclusive_rename_never_overwrites_an_existing_file() {
        let test_dir =
            std::env::temp_dir().join(format!("rill-exclusive-rename-{}", Uuid::new_v4()));
        fs::create_dir_all(&test_dir).expect("テストフォルダを作成");
        let source = test_dir.join("source.pdf");
        let destination = test_dir.join("destination.pdf");
        fs::write(&source, b"source").expect("移動元を作成");
        fs::write(&destination, b"destination").expect("移動先を作成");

        assert!(rename_without_overwrite(&source, &destination).is_err());
        assert_eq!(fs::read(&source).expect("移動元を保持"), b"source");
        assert_eq!(
            fs::read(&destination).expect("移動先を保持"),
            b"destination"
        );
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn pdf_validation_rejects_invalid_and_oversized_files() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-pdf-validation");
        let invalid = test_dir.join("invalid.pdf");
        fs::write(&invalid, b"this is not a PDF").expect("不正PDFを作成");
        let invalid_error = validate_pdf_file(&invalid).expect_err("不正PDFを拒否");
        assert!(invalid_error.contains("有効なPDF"));
        let import_error = import_pdfs_blocking(
            library.to_string_lossy().to_string(),
            vec![invalid.to_string_lossy().to_string()],
        )
        .expect_err("追加時に不正PDFを拒否");
        assert!(import_error.contains("有効なPDF"));
        assert!(!library.join("Inbox/invalid.pdf").exists());

        let valid = test_dir.join("valid.pdf");
        fs::write(&valid, b"%PDF-1.7\nvalid before invalid\n").expect("有効PDFを作成");
        let batch_error = import_pdfs_blocking(
            library.to_string_lossy().to_string(),
            vec![
                valid.to_string_lossy().to_string(),
                invalid.to_string_lossy().to_string(),
            ],
        )
        .expect_err("一括追加をコピー前に検証");
        assert!(batch_error.contains("有効なPDF"));
        assert!(!library.join("Inbox/valid.pdf").exists());
        assert!(
            fs::read_dir(library.join("Inbox"))
                .expect("Inboxを確認")
                .filter_map(Result::ok)
                .all(|entry| !entry.file_name().to_string_lossy().starts_with(".rilltmp-")),
            "一括追加失敗後に一時ファイルを残さない"
        );

        fs::copy(&invalid, library.join("Inbox/invalid.pdf")).expect("手動配置された不正PDFを模擬");
        let read_error = match read_pdf_bytes(
            library.to_string_lossy().to_string(),
            "Inbox/invalid.pdf".into(),
        ) {
            Err(error) => error,
            Ok(_) => panic!("リーダーで不正PDFを拒否"),
        };
        assert!(read_error.contains("有効なPDF"));

        let valid_with_preamble = test_dir.join("preamble.pdf");
        let mut content = vec![b' '; 900];
        content.extend_from_slice(b"%PDF-1.7\n");
        fs::write(&valid_with_preamble, content).expect("プリアンブル付きPDFを作成");
        validate_pdf_file(&valid_with_preamble).expect("1024バイト内のヘッダを許可");

        let oversized = test_dir.join("oversized.pdf");
        let mut file = File::create(&oversized).expect("大容量PDFを作成");
        file.write_all(b"%PDF-1.7\n").expect("PDFヘッダを書込");
        file.set_len(MAX_PDF_BYTES).expect("上限ちょうどを模擬");
        validate_pdf_file(&oversized).expect("上限ちょうどのPDFを許可");
        file.set_len(MAX_PDF_BYTES + 1).expect("上限超過を模擬");
        let oversized_error = validate_pdf_file(&oversized).expect_err("大容量PDFを拒否");
        assert!(oversized_error.contains("256 MB"));
        let oversized_import_error = import_pdfs_blocking(
            library.to_string_lossy().to_string(),
            vec![oversized.to_string_lossy().to_string()],
        )
        .expect_err("追加時に大容量PDFを拒否");
        assert!(oversized_import_error.contains("256 MB"));
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn pdf_open_rejects_leaf_symlinks_and_reads_from_the_opened_handle() {
        use std::os::unix::fs::symlink;

        let test_dir = std::env::temp_dir().join(format!("rill-pdf-handle-{}", Uuid::new_v4()));
        fs::create_dir_all(&test_dir).expect("テストフォルダを作成");
        let original = test_dir.join("original.pdf");
        let link = test_dir.join("link.pdf");
        fs::write(&original, b"%PDF-1.4\noriginal handle\n").expect("元PDFを作成");
        symlink(&original, &link).expect("PDFリンクを作成");
        assert!(open_validated_pdf(&link).is_err());

        let (mut opened, _) = open_validated_pdf(&original).expect("PDFを開く");
        let replacement = test_dir.join("replacement.pdf");
        fs::write(&replacement, b"%PDF-1.7\nreplacement path\n").expect("差替PDFを作成");
        fs::rename(&replacement, &original).expect("パスを差し替え");
        opened.seek(SeekFrom::Start(0)).expect("ハンドルを巻き戻す");
        let mut bytes = Vec::new();
        opened.read_to_end(&mut bytes).expect("ハンドルを読込");
        assert_eq!(bytes, b"%PDF-1.4\noriginal handle\n");
        assert_eq!(
            fs::read(&original).expect("現在パスを読込"),
            b"%PDF-1.7\nreplacement path\n"
        );
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn hash_observation_rejects_a_path_replaced_during_the_read() {
        let test_dir =
            std::env::temp_dir().join(format!("rill-hash-observation-{}", Uuid::new_v4()));
        fs::create_dir_all(&test_dir).expect("テストフォルダを作成");
        let pdf = test_dir.join("observed.pdf");
        let replacement = test_dir.join("replacement.pdf");
        fs::write(&pdf, b"%PDF-1.4\noriginal observed bytes\n").expect("元PDFを作成");
        fs::write(&replacement, b"%PDF-1.7\nreplacement observed bytes\n").expect("差替PDFを作成");

        let error = hash_and_fingerprint_with_hook(&pdf, || {
            fs::rename(&replacement, &pdf).expect("読込中の差し替えを模擬");
        })
        .expect_err("異なる時点のhashとfingerprintを組み合わせない");

        assert!(error.contains("変更") || error.contains("差し替え"));
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn index_read_io_errors_are_not_treated_as_an_empty_index() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-index-read-error");
        let index = library_index_path(&library).expect("indexパス");
        if index.exists() {
            fs::remove_file(&index).expect("元indexを削除");
        }
        fs::create_dir(&index).expect("indexパスをフォルダで塞ぐ");

        let error = scan_library_blocking(library.to_string_lossy().to_string())
            .expect_err("index読込のI/Oエラーを伝播");

        assert!(error.contains("インデックスを読み込めません"));
        assert!(index.is_dir(), "indexパスを上書きしない");
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn annotation_save_restores_json_when_markdown_commit_fails() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-annotation-rollback");
        fs::write(
            library.join("Inbox/rollback.pdf"),
            b"%PDF-1.4\nannotation rollback\n",
        )
        .expect("PDFを作成");
        let paper = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("PDFを走査")
            .remove(0);
        let paper =
            save_paper(library.to_string_lossy().to_string(), paper).expect("Markdownノートを作成");
        let baseline = PdfAnnotation {
            id: "baseline".into(),
            page: 1,
            text: "baseline quote".into(),
            color: "yellow".into(),
            kind: "highlight".into(),
            image_data_url: None,
            comment: String::new(),
            rects: Vec::new(),
            created_at: Utc::now().to_rfc3339(),
        };
        save_pdf_annotations(
            library.to_string_lossy().to_string(),
            paper.clone(),
            vec![baseline.clone()],
        )
        .expect("基準注釈を保存");
        let annotation_json = annotation_path(&library, &paper.id).expect("注釈パス");
        let baseline_json = fs::read(&annotation_json).expect("基準JSONを読込");
        let note_path = library.join(&paper.note_path);
        let baseline_note = fs::read(&note_path).expect("基準Markdownを読込");

        let mut replacement = baseline;
        replacement.id = "replacement".into();
        let error = save_pdf_annotations_inner(&library, &paper, &[replacement], || {
            Err("Markdown commit test failure".into())
        })
        .expect_err("Markdownの確定失敗を返す");

        assert!(error.contains("Markdown commit test failure"));
        assert_eq!(
            fs::read(&annotation_json).expect("JSONを再読込"),
            baseline_json
        );
        assert_eq!(
            fs::read(&note_path).expect("Markdownを再確認"),
            baseline_note
        );
        for directory in [library.join(".rill/annotations"), library.join("Notes")] {
            assert!(
                fs::read_dir(directory)
                    .expect("一時ファイルを確認")
                    .filter_map(Result::ok)
                    .all(|entry| !entry.file_name().to_string_lossy().starts_with(".rilltmp-")),
                "失敗後に一時ファイルを残さない"
            );
        }
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn external_pdf_rename_keeps_identity_note_and_annotations() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-index-rename");
        let original_pdf = library.join("Inbox/original.pdf");
        fs::write(&original_pdf, b"%PDF-1.4\nsame paper\n").expect("PDFを作成");
        let mut paper = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("初回走査")
            .remove(0);
        paper.summary = "保持する要約".into();
        paper.tags = vec!["追跡".into()];
        paper = save_paper(library.to_string_lossy().to_string(), paper).expect("書誌を保存");
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

        let rescanned = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("rename後に再走査")
            .remove(0);

        assert_eq!(rescanned.id, paper.id);
        assert_eq!(rescanned.note_path, paper.note_path);
        assert_eq!(rescanned.pdf_path, "Inbox/renamed.pdf");
        assert_eq!(rescanned.summary, "保持する要約");
        assert_eq!(rescanned.tags, vec!["追跡"]);
        assert_eq!(
            load_pdf_annotations(library.to_string_lossy().to_string(), rescanned.id.clone())
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
        let initial = scan_library_blocking(library.to_string_lossy().to_string())
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

        let rescanned = scan_library_blocking(library.to_string_lossy().to_string())
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
        fs::write(library.join("Inbox/rebuild.pdf"), b"%PDF-1.4\nrebuild\n").expect("PDFを作成");
        let original_id = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("初回走査")[0]
            .id
            .clone();
        fs::write(
            library_index_path(&library).expect("indexパス"),
            b"{broken json",
        )
        .expect("index破損を模擬");
        let after_corruption = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("破損indexから再構築");
        assert_eq!(after_corruption[0].id, original_id);
        let rebuilt = serde_json::from_slice::<LibraryIndex>(
            &fs::read(library_index_path(&library).expect("indexパス")).expect("再構築indexを読込"),
        )
        .expect("再構築indexを解析");
        assert_eq!(rebuilt.version, 1);
        fs::remove_file(library_index_path(&library).expect("indexパス")).expect("index欠損を模擬");
        let after_missing = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("欠損indexから再構築");
        assert_eq!(after_missing[0].id, original_id);
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn repeated_scan_does_not_rewrite_existing_revision_snapshot() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-scan-read-only-snapshot");
        fs::write(
            library.join("Inbox/read-only.pdf"),
            b"%PDF-1.4\nread only\n",
        )
        .expect("PDFを作成");
        let paper = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("初回走査")
            .remove(0);
        let snapshot_path = revision_snapshot_path(&library, &paper.id).expect("履歴パスを取得");
        let mut baseline = paper.clone();
        baseline.title = "保持すべきマージ基準".into();
        let baseline_json = serde_json::to_vec(&baseline).expect("履歴を変換");
        fs::write(&snapshot_path, &baseline_json).expect("履歴を差し替え");

        scan_library_blocking(library.to_string_lossy().to_string()).expect("再走査");

        assert_eq!(
            fs::read(&snapshot_path).expect("履歴を再読込"),
            baseline_json,
            "起動時の走査は既存のマージ履歴を書き換えない"
        );
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn newer_index_version_is_not_overwritten() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-index-forward");
        fs::write(library.join("Inbox/future.pdf"), b"%PDF-1.4\nfuture\n").expect("PDFを作成");
        let future_index = br#"{"version":2,"papers":{}}"#;
        fs::write(
            library_index_path(&library).expect("indexパス"),
            future_index,
        )
        .expect("将来版indexを作成");
        let paper = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("将来版indexでも走査")
            .remove(0);
        assert_eq!(
            fs::read(library_index_path(&library).expect("indexパス"))
                .expect("将来版indexを再読込"),
            future_index
        );
        let move_error = organize_paper(library.to_string_lossy().to_string(), paper)
            .expect_err("将来版indexでは移動前に拒否");
        assert!(move_error.contains("新しい形式"));
        assert!(library.join("Inbox/future.pdf").is_file());
        assert!(!library.join("Papers/future.pdf").exists());
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn frontmatter_identity_overrides_a_stale_index_without_rewriting_the_note() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-index-frontmatter");
        fs::write(
            library.join("Inbox/frontmatter.pdf"),
            b"%PDF-1.4\nfrontmatter\n",
        )
        .expect("PDFを作成");
        let initial = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("初回走査")
            .remove(0);
        let new_id = Uuid::new_v4().to_string();
        let note_path = library.join(&initial.note_path);
        let note = fs::read_to_string(&note_path).expect("noteを読込");
        let externally_changed = note.replace(&initial.id, &new_id);
        fs::write(&note_path, &externally_changed).expect("frontmatter ID変更を模擬");

        let rescanned = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("ID矛盾を再走査")
            .remove(0);

        assert_eq!(rescanned.id, new_id);
        assert_eq!(
            fs::read_to_string(&note_path).expect("noteを再読込"),
            externally_changed
        );
        let index = load_library_index(&library).expect("indexを読込").0;
        assert!(index.papers.contains_key(&new_id));
        assert!(!index.papers.contains_key(&initial.id));
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn duplicate_frontmatter_ids_are_repaired_without_losing_note_content() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-index-duplicate-id");
        fs::write(library.join("Inbox/first.pdf"), b"%PDF-1.4\nfirst\n").expect("first PDFを作成");
        fs::write(library.join("Inbox/second.pdf"), b"%PDF-1.4\nsecond\n")
            .expect("second PDFを作成");
        let initial =
            scan_library_blocking(library.to_string_lossy().to_string()).expect("初回走査");
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
        fs::remove_file(library_index_path(&library).expect("indexパス"))
            .expect("migration状態を模擬");

        let rescanned =
            scan_library_blocking(library.to_string_lossy().to_string()).expect("重複IDを走査");

        let repaired_second = rescanned
            .iter()
            .find(|paper| paper.pdf_path.ends_with("second.pdf"))
            .expect("second文献を再読込");
        assert_eq!(
            rescanned
                .iter()
                .filter(|paper| paper.id == first.id)
                .count(),
            1
        );
        assert_ne!(repaired_second.id, first.id);
        let repaired_note = fs::read_to_string(&second_note_path).expect("second noteを再読込");
        assert!(repaired_note.contains(&repaired_second.id));
        assert!(repaired_note.contains("[[Inbox/second.pdf]]"));
        let index = serde_json::from_slice::<LibraryIndex>(
            &fs::read(library_index_path(&library).expect("indexパス")).expect("indexを読込"),
        )
        .expect("indexを解析");
        assert_eq!(index.papers.len(), 2);
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
        fs::create_dir_all(test_dir.join("Other Vault")).expect("別のVaultを作成");
        let registry = serde_json::to_vec(&serde_json::json!({
            "vaults": {
                "unrelated": { "path": test_dir.join("Other Vault") }
            }
        }))
        .expect("Obsidian登録情報を作成");
        assert!(registered_obsidian_vault_from_json(&library, &registry).is_none());
        fs::create_dir_all(library.join(".obsidian")).expect("Vault設定を作成");
        assert!(registered_obsidian_vault_from_json(&library, &registry).is_none());
        let registry = serde_json::to_vec(&serde_json::json!({
            "vaults": {
                "rill": { "path": library }
            }
        }))
        .expect("Rill Vault登録情報を作成");
        assert_eq!(
            registered_obsidian_vault_from_json(&library, &registry),
            Some(library.clone())
        );
        assert_eq!(
            percent_encode_uri_value("/Rill Library/Notes/日本語.md"),
            "%2FRill%20Library%2FNotes%2F%E6%97%A5%E6%9C%AC%E8%AA%9E.md"
        );
        let first_import = import_pdfs_blocking(
            library.to_string_lossy().to_string(),
            vec![source.to_string_lossy().to_string()],
        )
        .expect("PDFを追加");
        assert_eq!(first_import.imported, 1);
        assert_eq!(first_import.skipped_duplicates, 0);

        let duplicate_import = import_pdfs_blocking(
            library.to_string_lossy().to_string(),
            vec![source.to_string_lossy().to_string()],
        )
        .expect("重複を確認");
        assert_eq!(duplicate_import.imported, 0);
        assert_eq!(duplicate_import.skipped_duplicates, 1);

        let mut papers =
            scan_library_blocking(library.to_string_lossy().to_string()).expect("文献を走査");
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

        let rescanned =
            scan_library_blocking(library.to_string_lossy().to_string()).expect("再走査");
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

        let after_annotations = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("注釈保存後に再走査");
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
        let mut refreshed = scan_library_blocking(library.to_string_lossy().to_string())
            .expect("外部更新後に再走査")[0]
            .clone();
        refreshed.summary = "競合解消後の要約".into();
        save_paper(library.to_string_lossy().to_string(), refreshed)
            .expect("再読込後は安全にマージ");
        let note = fs::read_to_string(&note_path).expect("マージ後のMarkdownを読込");
        assert!(note.contains("## Obsidianで追記"));
        assert!(note.contains("この段落はRillの管理外です。"));

        let latest =
            scan_library_blocking(library.to_string_lossy().to_string()).expect("移動前に再走査");
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
        assert!(scan_library_blocking(library.to_string_lossy().to_string())
            .expect("ゴミ箱移動後に走査")
            .is_empty());
        assert_eq!(
            list_trashed_papers(library.to_string_lossy().to_string())
                .expect("ゴミ箱一覧")
                .len(),
            1
        );
        assert!(!load_library_index(&library)
            .expect("indexを読込")
            .0
            .papers
            .contains_key(&moved.id));

        let restored =
            restore_trashed_paper(library.to_string_lossy().to_string(), moved.id.clone())
                .expect("ゴミ箱から復元");
        assert_eq!(restored.pdf_path, moved.pdf_path);
        assert_eq!(restored.note_path, moved.note_path);
        assert!(library.join(&restored.pdf_path).exists());
        assert!(library.join(&restored.note_path).exists());
        assert!(load_library_index(&library)
            .expect("indexを読込")
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
            .expect("indexを読込")
            .0
            .papers
            .contains_key(&restored.id));

        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[cfg(unix)]
    #[test]
    fn import_uses_index_hash_without_reopening_an_existing_pdf() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-indexed-import");
        let existing = library.join("Inbox/existing.pdf");
        let duplicate = test_dir.join("duplicate.pdf");
        let content = b"%PDF-1.4\nindexed duplicate\n";
        fs::write(&existing, content).expect("既存PDFを作成");
        fs::write(&duplicate, content).expect("重複PDFを作成");
        scan_library_blocking(library.to_string_lossy().to_string()).expect("既存PDFを索引へ登録");

        let original_permissions = fs::metadata(&existing)
            .expect("既存PDFの権限を取得")
            .permissions();
        let mut unreadable_permissions = original_permissions.clone();
        unreadable_permissions.set_mode(0o000);
        fs::set_permissions(&existing, unreadable_permissions)
            .expect("クラウド上で本文を取得できない状態を模擬");

        let result = import_pdfs_blocking(
            library.to_string_lossy().to_string(),
            vec![duplicate.to_string_lossy().to_string()],
        )
        .expect("索引だけで重複を判定");

        fs::set_permissions(&existing, original_permissions).expect("既存PDFの権限を復元");
        assert_eq!(result.imported, 0);
        assert_eq!(result.skipped_duplicates, 1);
        assert!(!library.join("Inbox/duplicate.pdf").exists());
        fs::remove_dir_all(&test_dir).expect("テストデータを削除");
    }

    #[test]
    fn collections_can_be_renamed_and_reparented_safely() {
        let _guard = library_test_guard();
        let (test_dir, library) = test_library("rill-folder-move");
        let root = library.to_string_lossy().to_string();

        let parent = create_collection(root.clone(), String::new(), "精神医学".into())
            .expect("親フォルダを作成");
        let child =
            create_collection(root.clone(), parent, "うつ病".into()).expect("子フォルダを作成");
        fs::write(
            collection_root(&library, &child)
                .expect("子フォルダ")
                .join("確認.txt"),
            "preserved",
        )
        .expect("移動確認用ファイルを作成");
        fs::write(
            collection_root(&library, &child)
                .expect("子フォルダ")
                .join("paper.pdf"),
            b"%PDF-1.4\nfolder move\n",
        )
        .expect("移動確認用PDFを作成");
        let initial = scan_library_blocking(root.clone()).expect("移動前に文献を走査");
        let initial_paper = initial
            .into_iter()
            .find(|paper| paper.pdf_path == "Papers/精神医学/うつ病/paper.pdf")
            .expect("移動対象文献");
        let note_path = safe_join(&library, &initial_paper.note_path).expect("文献ノートのパス");

        let renamed =
            rename_collection(root.clone(), child, "気分障害".into()).expect("フォルダ名を変更");
        assert_eq!(renamed, "精神医学/気分障害");
        assert!(collection_root(&library, &renamed)
            .expect("変更後フォルダ")
            .join("確認.txt")
            .is_file());
        let after_rename = scan_library_blocking(root.clone()).expect("名称変更後に再走査");
        let renamed_paper = after_rename
            .into_iter()
            .find(|paper| paper.id == initial_paper.id)
            .expect("名称変更後も同じ文献ID");
        assert_eq!(renamed_paper.pdf_path, "Papers/精神医学/気分障害/paper.pdf");
        let renamed_note = fs::read_to_string(&note_path).expect("名称変更後のノート");
        assert!(renamed_note.contains("[[Papers/精神医学/気分障害/paper.pdf]]"));
        assert!(!renamed_note.contains("[[Papers/精神医学/うつ病/paper.pdf]]"));

        let destination = create_collection(root.clone(), String::new(), "研究テーマ".into())
            .expect("移動先を作成");
        let moved = move_collection(root.clone(), renamed, destination.clone())
            .expect("フォルダ階層を変更");
        assert_eq!(moved, "研究テーマ/気分障害");
        assert!(collection_root(&library, &moved)
            .expect("移動後フォルダ")
            .join("確認.txt")
            .is_file());
        let after_move = scan_library_blocking(root.clone()).expect("階層変更後に再走査");
        let moved_paper = after_move
            .into_iter()
            .find(|paper| paper.id == initial_paper.id)
            .expect("階層変更後も同じ文献ID");
        assert_eq!(moved_paper.pdf_path, "Papers/研究テーマ/気分障害/paper.pdf");
        let moved_note = fs::read_to_string(&note_path).expect("階層変更後のノート");
        assert!(moved_note.contains("[[Papers/研究テーマ/気分障害/paper.pdf]]"));
        assert!(!moved_note.contains("[[Papers/精神医学/気分障害/paper.pdf]]"));
        assert_eq!(
            load_library_index(&library)
                .expect("indexを読込")
                .0
                .papers
                .get(&initial_paper.id)
                .expect("階層変更後のindex")
                .pdf_path,
            moved_paper.pdf_path
        );

        assert!(
            move_collection(root.clone(), destination, moved.clone()).is_err(),
            "親フォルダを子孫へ移動できない"
        );
        create_collection(root.clone(), "研究テーマ".into(), "既存".into())
            .expect("競合フォルダを作成");
        assert!(
            rename_collection(root, moved, "既存".into()).is_err(),
            "既存フォルダへ上書きしない"
        );

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
    fn crossref_candidate_validation_prefers_matching_title_author_and_year() {
        let mut paper =
            metadata_test_paper("Dapagliflozin in Patients with Chronic Kidney Disease");
        paper.authors = vec!["Hiddo J. L. Heerspink".into()];
        paper.year = Some(2020);
        paper.journal = "The New England Journal of Medicine".into();
        let candidates = vec![
            serde_json::json!({
                "title": ["Dapagliflozin in Patients with Heart Failure"],
                "author": [{"family": "Solomon"}],
                "published": {"date-parts": [[2022]]},
                "container-title": ["New England Journal of Medicine"],
                "DOI": "10.1000/wrong"
            }),
            serde_json::json!({
                "title": ["Dapagliflozin in Patients with Chronic Kidney Disease"],
                "author": [{"family": "Heerspink"}],
                "published": {"date-parts": [[2020]]},
                "container-title": ["New England Journal of Medicine"],
                "DOI": "10.1056/NEJMoa2024816"
            }),
        ];

        let selected = select_crossref_candidate(&paper, &candidates).expect("正しい候補を選択");
        assert_eq!(json_string(selected.get("DOI")), "10.1056/NEJMoa2024816");
    }

    #[test]
    fn crossref_candidate_validation_rejects_filename_like_titles() {
        let paper = metadata_test_paper("41398");
        let candidates = vec![serde_json::json!({
            "title": ["An unrelated article"],
            "DOI": "10.1000/wrong"
        })];

        assert!(select_crossref_candidate(&paper, &candidates).is_err());
    }

    #[test]
    fn crossref_candidate_validation_does_not_guess_between_equal_matches() {
        let paper =
            metadata_test_paper("A systematic review of biomarkers in major depressive disorder");
        let candidates = vec![
            serde_json::json!({
                "title": ["A systematic review of biomarkers in major depressive disorder"],
                "DOI": "10.1000/first"
            }),
            serde_json::json!({
                "title": ["A systematic review of biomarkers in major depressive disorder"],
                "DOI": "10.1000/second"
            }),
        ];

        assert!(select_crossref_candidate(&paper, &candidates).is_err());
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

    #[test]
    #[ignore = "外部APIのタイトル照合確認用"]
    fn live_crossref_title_match_is_validated() {
        let mut paper =
            metadata_test_paper("Dapagliflozin in Patients with Chronic Kidney Disease");
        paper.authors = vec!["Hiddo J. L. Heerspink".into()];
        paper.year = Some(2020);
        paper.journal = "The New England Journal of Medicine".into();

        let enriched = enrich_from_crossref(paper).expect("Crossrefから照合");
        assert_eq!(enriched.doi.to_ascii_lowercase(), "10.1056/nejmoa2024816");
    }
}
