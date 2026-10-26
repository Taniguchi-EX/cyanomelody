fn main() {
    embed_oauth_client();
    tauri_build::build()
}

/// Google の OAuth クライアント（デスクトップアプリ）の JSON を、ビルド時に埋め込む。
/// JSON はリポジトリに入れず、`secrets/google_oauth_desktop.sec.json` に置く。なければ Drive にログインできない版になる。
fn embed_oauth_client() {
    // Android は Google Identity Services でログインするため、デスクトップ用のクライアントは要らない
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        return;
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../secrets/google_oauth_desktop.sec.json");
    println!("cargo:rerun-if-changed={}", path.display());
    match std::fs::read_to_string(&path) {
        Ok(json) => {
            // rustc-env の値には改行を入れられないため、1 行にする
            let one_line = json.replace(['\r', '\n'], " ");
            println!("cargo:rustc-env=CYANOMELODY_OAUTH_DESKTOP={one_line}");
        }
        Err(_) => println!(
            "cargo:warning=secrets/google_oauth_desktop.sec.json がないため、Google Drive にログインできない版になる"
        ),
    }
}
