//! Google Drive へのログイン（Windows と Ubuntu）。リフレッシュトークンは OS の資格情報の保管庫に保存する。
//! Android のログインは `Androidの連携` のタスクで、Kotlin の Google Identity Services を使って作る。

use std::sync::Arc;

use cyanomelody_core::drive::DriveError;
use cyanomelody_core::drive::auth::{OAuthClient, RefreshingToken, TokenStore};

/// 資格情報の保管庫での名前。
#[cfg(desktop)]
const SERVICE: &str = "dev.cyanomelody.app";
#[cfg(desktop)]
const ACCOUNT: &str = "google-drive-refresh-token";

/// ビルド時に埋め込んだ OAuth クライアント。
pub fn oauth_client() -> Result<OAuthClient, DriveError> {
    let json = option_env!("CYANOMELODY_OAUTH_DESKTOP")
        .ok_or_else(|| DriveError::Auth("OAuth クライアントを埋め込まずにビルドされた".into()))?;
    OAuthClient::from_json(json)
}

/// OS の資格情報の保管庫（Windows の資格情報マネージャー、Ubuntu の Secret Service）。
#[cfg(desktop)]
pub struct KeyringStore {
    entry: keyring::Entry,
}

#[cfg(desktop)]
impl KeyringStore {
    pub fn new() -> Result<Self, DriveError> {
        Self::with_account(ACCOUNT)
    }

    fn with_account(account: &str) -> Result<Self, DriveError> {
        let entry =
            keyring::Entry::new(SERVICE, account).map_err(|e| DriveError::Auth(e.to_string()))?;
        Ok(Self { entry })
    }
}

#[cfg(desktop)]
impl TokenStore for KeyringStore {
    fn load(&self) -> Option<String> {
        match self.entry.get_password() {
            Ok(token) => Some(token),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => {
                log::warn!("資格情報の保管庫から読めない: {e}");
                None
            }
        }
    }

    fn save(&self, refresh_token: &str) -> Result<(), DriveError> {
        self.entry
            .set_password(refresh_token)
            .map_err(|e| DriveError::Auth(format!("資格情報の保管庫に保存できない: {e}")))
    }

    fn clear(&self) {
        match self.entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => log::warn!("資格情報の保管庫から消せない: {e}"),
        }
    }
}

/// Drive へのログインの状態を持つ。
pub struct DriveAuth {
    pub client: OAuthClient,
    pub store: Arc<dyn TokenStore>,
    pub tokens: Arc<RefreshingToken>,
}

impl DriveAuth {
    #[cfg(desktop)]
    pub fn new() -> Result<Self, DriveError> {
        let client = oauth_client()?;
        let store: Arc<dyn TokenStore> = Arc::new(KeyringStore::new()?);
        let tokens = Arc::new(RefreshingToken::new(client.clone(), store.clone()));
        Ok(Self {
            client,
            store,
            tokens,
        })
    }

    /// ブラウザでログインし、リフレッシュトークンを保存する。`open_url` でブラウザを開く。
    #[cfg(desktop)]
    pub fn login(
        &self,
        open_url: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<(), DriveError> {
        use cyanomelody_core::drive::auth::LoopbackLogin;
        let login = LoopbackLogin::start(&self.client)?;
        open_url(&login.url).map_err(DriveError::Auth)?;
        let refresh = login.finish(std::time::Duration::from_secs(300))?;
        self.store.save(&refresh)?;
        use cyanomelody_core::drive::TokenProvider;
        self.tokens.invalidate();
        Ok(())
    }

    pub fn logout(&self) {
        self.store.clear();
        use cyanomelody_core::drive::TokenProvider;
        self.tokens.invalidate();
    }

    pub fn is_logged_in(&self) -> bool {
        self.tokens.is_logged_in()
    }
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    /// 実際の資格情報の保管庫を使うため、手動で実行する: cargo test -p cyanomelody -- --ignored
    #[test]
    #[ignore]
    fn keyring_round_trip() {
        let store = KeyringStore::with_account("test-round-trip").unwrap();
        store.clear();
        assert_eq!(store.load(), None);
        store.save("テスト用のトークン").unwrap();
        assert_eq!(store.load().as_deref(), Some("テスト用のトークン"));
        store.clear();
        assert_eq!(store.load(), None);
    }

    #[test]
    fn embedded_client_is_readable_when_present() {
        if option_env!("CYANOMELODY_OAUTH_DESKTOP").is_some() {
            assert!(
                oauth_client()
                    .unwrap()
                    .client_id
                    .ends_with(".apps.googleusercontent.com")
            );
        } else {
            assert!(oauth_client().is_err());
        }
    }
}
