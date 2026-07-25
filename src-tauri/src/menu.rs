use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Runtime,
};

const MENU_EVENT: &str = "rill://menu-action";
const SOURCE_AND_LICENSE_URL: &str = "https://github.com/Ikepersan/rill/tree/v1.0.0";

#[cfg(target_os = "macos")]
fn open_source_and_license() {
    let _ = std::process::Command::new("open")
        .arg(SOURCE_AND_LICENSE_URL)
        .spawn();
}

#[cfg(target_os = "windows")]
fn open_source_and_license() {
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", SOURCE_AND_LICENSE_URL])
        .spawn();
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_source_and_license() {
    let _ = std::process::Command::new("xdg-open")
        .arg(SOURCE_AND_LICENSE_URL)
        .spawn();
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = AboutMetadata {
        name: Some("Rill".into()),
        version: Some(app.package_info().version.to_string()),
        comments: Some("静かな、ローカルファーストの文献管理アプリ".into()),
        license: Some("GNU AGPLv3".into()),
        ..Default::default()
    };

    let settings = MenuItem::with_id(app, "settings", "設定…", true, Some("CmdOrCtrl+,"))?;
    let add_pdf = MenuItem::with_id(app, "add-pdf", "PDFを追加…", true, Some("CmdOrCtrl+O"))?;
    let open_library = MenuItem::with_id(
        app,
        "open-library",
        "保存場所をFinderで開く",
        true,
        None::<&str>,
    )?;
    let overview = MenuItem::with_id(app, "show-overview", "Overview", true, Some("CmdOrCtrl+1"))?;
    let library = MenuItem::with_id(app, "show-library", "Library", true, Some("CmdOrCtrl+2"))?;
    let references = MenuItem::with_id(
        app,
        "show-references",
        "References",
        true,
        Some("CmdOrCtrl+3"),
    )?;
    let source_and_license = MenuItem::with_id(
        app,
        "open-source-and-license",
        "ライセンスとソースコード…",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Rillを終了", true, Some("CmdOrCtrl+Q"))?;

    let app_menu = Submenu::with_items(
        app,
        "Rill",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("Rillについて"), Some(about.clone()))?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some("サービス"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("Rillを隠す"))?,
            &PredefinedMenuItem::hide_others(app, Some("ほかを隠す"))?,
            &PredefinedMenuItem::show_all(app, Some("すべてを表示"))?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "ファイル",
        true,
        &[
            &add_pdf,
            &open_library,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("ウインドウを閉じる"))?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "編集",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("取り消す"))?,
            &PredefinedMenuItem::redo(app, Some("やり直す"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("切り取り"))?,
            &PredefinedMenuItem::copy(app, Some("コピー"))?,
            &PredefinedMenuItem::paste(app, Some("ペースト"))?,
            &PredefinedMenuItem::select_all(app, Some("すべてを選択"))?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "表示",
        true,
        &[
            &overview,
            &library,
            &references,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, Some("フルスクリーンにする"))?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "ウインドウ",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("しまう"))?,
            &PredefinedMenuItem::maximize(app, Some("拡大／縮小"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::bring_all_to_front(app, Some("すべてを手前に移動"))?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "ヘルプ",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("Rillのバージョン"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &source_and_license,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id == "open-source-and-license" {
        open_source_and_license();
        return;
    }

    let action = match id {
        "settings" => "settings",
        "add-pdf" => "add-pdf",
        "open-library" => "open-library",
        "show-overview" => "overview",
        "show-library" => "library",
        "show-references" => "references",
        "quit" => "quit",
        _ => return,
    };

    let _ = app.emit(MENU_EVENT, action);
}
