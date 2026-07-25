mod library;
mod menu;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, RunEvent};

static ALLOW_EXIT_AFTER_FLUSH: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn exit_after_flush(app: AppHandle) {
    ALLOW_EXIT_AFTER_FLUSH.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::handle(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            exit_after_flush,
            library::restore_library_root,
            library::migrate_library_root,
            library::choose_library_root,
            library::initialize_library,
            library::scan_library,
            library::search_library,
            library::read_csl_style,
            library::read_citation_preset,
            library::write_citation_preset,
            library::translate_summary,
            library::import_pdfs,
            library::save_paper,
            library::organize_paper,
            library::enrich_metadata,
            library::move_paper_to_rill_trash,
            library::list_trashed_papers,
            library::restore_trashed_paper,
            library::delete_trashed_paper_permanently,
            library::open_rill_trash_folder,
            library::list_collections,
            library::create_collection,
            library::delete_collection,
            library::move_paper_to_collection,
            library::export_library,
            library::read_pdf_bytes,
            library::pdf_file_exists,
            library::load_pdf_annotations,
            library::save_pdf_annotations,
            library::open_library_folder,
            library::open_pdf_in_preview,
            library::obsidian_vault_status,
            library::open_obsidian_app,
            library::open_note_in_obsidian,
        ])
        .build(tauri::generate_context!())
        .expect("Rillの起動に失敗しました");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if !ALLOW_EXIT_AFTER_FLUSH.load(Ordering::SeqCst) {
                api.prevent_exit();
                let _ = app_handle.emit("rill://menu-action", "quit");
            }
        }
    });
}
