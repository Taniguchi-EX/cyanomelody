//! Google Drive へのログイン。OS ごとの違い（デスクトップはブラウザ、Android は Google Identity Services）をここに閉じ込める。

use std::sync::Arc;

use cyanomelody_core::drive::TokenProvider;

use crate::ui::{UiError, UiResult};

pub enum Login {
    /// Windows と Ubuntu：ブラウザで同意し、リフレッシュトークンを OS の資格情報の保管庫に保存する
    #[cfg(desktop)]
    Desktop(crate::drive::DriveAuth),
    /// Android：Google Identity Services でアクセストークンを得る
    #[cfg(target_os = "android")]
    Android(Arc<crate::android::AndroidToken>),
    /// ログインできない（OAuth クライアントを埋め込まずにビルドした、など）
    Unavailable(String),
}

impl Login {
    #[cfg(desktop)]
    pub fn new(_data_dir: &std::path::Path) -> Self {
        crate::drive::DriveAuth::new().map_or_else(|e| Self::Unavailable(e.to_string()), Self::Desktop)
    }

    #[cfg(target_os = "android")]
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self::Android(Arc::new(crate::android::AndroidToken::new(data_dir)))
    }

    #[cfg(all(mobile, not(target_os = "android")))]
    pub fn new(_data_dir: &std::path::Path) -> Self {
        Self::Unavailable("この端末ではログインできません".into())
    }

    /// Drive の呼び出しに使うアクセストークンの受け渡し口。ログインできないときは `None`。
    pub fn tokens(&self) -> Option<Arc<dyn TokenProvider>> {
        match self {
            #[cfg(desktop)]
            Self::Desktop(d) => Some(d.tokens.clone()),
            #[cfg(target_os = "android")]
            Self::Android(a) => Some(a.clone()),
            Self::Unavailable(_) => None,
        }
    }

    pub fn can_login(&self) -> bool {
        !matches!(self, Self::Unavailable(_))
    }

    pub fn logged_in(&self) -> bool {
        match self {
            #[cfg(desktop)]
            Self::Desktop(d) => d.is_logged_in(),
            #[cfg(target_os = "android")]
            Self::Android(a) => a.is_logged_in(),
            Self::Unavailable(_) => false,
        }
    }

    /// 同意の画面を出してログインする（終わるまで待つ）。
    pub fn login(&self, app: &tauri::AppHandle) -> UiResult<()> {
        match self {
            #[cfg(desktop)]
            Self::Desktop(d) => {
                use tauri_plugin_opener::OpenerExt;
                Ok(d.login(|url| app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string()))?)
            }
            #[cfg(target_os = "android")]
            Self::Android(a) => {
                let _ = app;
                Ok(a.login()?)
            }
            Self::Unavailable(reason) => {
                let _ = app;
                Err(UiError::new("login", reason.clone()))
            }
        }
    }

    pub fn logout(&self) {
        match self {
            #[cfg(desktop)]
            Self::Desktop(d) => d.logout(),
            #[cfg(target_os = "android")]
            Self::Android(a) => a.logout(),
            Self::Unavailable(_) => {}
        }
    }
}
