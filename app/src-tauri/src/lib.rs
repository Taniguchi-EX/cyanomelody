mod audio_hash;
mod autotag;
mod autotag_job;
mod chains;
mod commands;
mod credits;
mod db;
mod deleting;
mod effect_cache;
mod effects;
mod error;
mod export;
mod export_job;
mod facets;
mod files;
mod fonts;
mod hash_job;
mod hashing;
mod library;
mod linking;
mod metadata;
mod names;
mod playlists;
mod recent;
mod romaji;
mod settings;
mod state;
mod tags;
mod transfer;
mod tree;
mod update;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};

use autotag_job::AutotagJob;
use export_job::ExportJob;
use hash_job::HashJob;
use state::{allow_asset_dir, AppState};

/// データの置き場所。テストなどで分けたいときは環境変数 CYANOMELODY_DATA_DIR で変えられる。
fn data_dir(app: &AppHandle) -> std::result::Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(dir) = std::env::var_os("CYANOMELODY_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    Ok(app.path().app_data_dir()?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let dir = data_dir(app.handle())?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join("cyanomelody.db"))?;
            for folder in library::list_folders(&conn)? {
                allow_asset_dir(app.handle(), Path::new(&folder.path));
            }
            let effect_cache = dir.join("effects-cache");
            std::fs::create_dir_all(&effect_cache)?;
            // エフェクトをかけた音を画面から鳴らせるようにする
            allow_asset_dir(app.handle(), &effect_cache);
            let cover_cache = dir.join("covers");
            std::fs::create_dir_all(&cover_cache)?;
            // ジャケットの画像を画面から出せるようにする
            allow_asset_dir(app.handle(), &cover_cache);
            app.manage(AppState {
                conn: Mutex::new(conn),
                hashing: Arc::new(HashJob::default()),
                effect_cache,
                cover_cache,
                export: Arc::new(ExportJob::default()),
                autotag: Arc::new(AutotagJob::default()),
                draw: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library::list_folders,
            commands::library::add_folder,
            commands::library::remove_folder,
            commands::library::scan_folder,
            commands::files::list_files,
            commands::playlists::select_playlist,
            commands::playlists::clear_playlist_selection,
            commands::playlists::redraw_playlist,
            commands::playlists::refresh_draw,
            commands::files::facet_counts,
            commands::tags::list_tags,
            commands::tags::create_tag,
            commands::tags::rename_tag,
            commands::tags::set_tag_settings,
            commands::tags::set_tag_synonyms,
            commands::tags::new_tag_settings,
            commands::data::export_data,
            commands::data::export_metadata,
            commands::data::inspect_import,
            commands::data::import_data,
            commands::tags::set_new_tag_settings,
            commands::tags::delete_tag,
            commands::tags::move_tag,
            commands::files::add_tag,
            commands::files::remove_tag,
            commands::files::remove_missing_files,
            commands::library::start_hashing,
            commands::library::cancel_hashing,
            commands::library::hashing_progress,
            commands::files::track_title,
            commands::files::track_cover,
            commands::app::list_fonts,
            commands::app::check_update,
            commands::autotag::meta_ignore_values,
            commands::library::delete_files,
            commands::autotag::set_meta_ignore_values,
            commands::autotag::meta_separators,
            commands::autotag::set_meta_separators,
            commands::autotag::autotag_file,
            commands::autotag::start_autotag,
            commands::autotag::cancel_autotag,
            commands::app::install_update,
            commands::library::relink_files,
            commands::credits::license_types,
            commands::credits::list_credits,
            commands::credits::move_credit,
            commands::credits::create_credit,
            commands::credits::update_credit,
            commands::credits::delete_credit,
            commands::credits::set_file_credit,
            commands::playlists::list_playlists,
            commands::playlists::get_playlist,
            commands::playlists::create_playlist,
            commands::playlists::rename_playlist,
            commands::playlists::delete_playlist,
            commands::playlists::move_playlist,
            commands::playlists::add_playlist_files,
            commands::playlists::add_playlist_tags,
            commands::playlists::add_playlist_ref,
            commands::playlists::remove_playlist_item,
            commands::playlists::move_playlist_item,
            commands::playlists::set_playlist_item_mode,
            commands::playlists::set_playlist_item_alias,
            commands::effects::list_effect_chains,
            commands::effects::create_effect_chain,
            commands::effects::rename_effect_chain,
            commands::effects::delete_effect_chain,
            commands::effects::set_effect_chain_effects,
            commands::effects::set_playlist_item_chain,
            commands::effects::render_effects,
            commands::effects::preview_effects,
            commands::playlists::start_export,
            commands::playlists::start_export_files,
            commands::playlists::draw_item_files,
            commands::playlists::cancel_export,
            commands::playlists::expand_playlist_item,
            commands::playlists::playlists_with_file,
            commands::files::existing_file_ids,
            commands::library::link_missing_file,
            commands::library::find_missing_in_folder,
            commands::library::find_missing_in_folder_many,
            commands::files::record_play,
            commands::playlists::remove_file_from_playlist,
            commands::playlists::remove_files_from_playlist,
            commands::files::bulk_summary,
            commands::playlists::playlist_item_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
