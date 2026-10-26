//! Google Drive との通信。
//!
//! - `auth`：ログイン（デスクトップのループバック ＋ PKCE）とアクセストークンの更新
//! - `client`：Drive API の呼び出し（フォルダの一覧、ファイルの部分取得）
//! - `reader`：ファイルを Range 指定で部分取得しながら読む読み込み口（先読み付き）

pub mod auth;
pub mod client;
pub mod reader;

#[cfg(test)]
pub(crate) mod mock;

pub use client::{DriveClient, DriveFile};
pub use reader::RangeReader;

/// フォルダの MIME タイプ。
pub const FOLDER_MIME: &str = "application/vnd.google-apps.folder";

/// アプリが求める権限。
pub const SCOPES: [&str; 2] =
    ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file"];

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum DriveError {
    /// ログインしていない、ログインが切れた
    #[error("ログインが必要: {0}")]
    Auth(String),
    /// Drive がエラーを返した
    #[error("Google Drive のエラー（{status}）: {message}")]
    Http { status: u16, message: String },
    /// 通信できない
    #[error("通信できない: {0}")]
    Network(String),
    /// 応答の形が想定と違う
    #[error("応答を読めない: {0}")]
    Parse(String),
    /// 見つからない
    #[error("見つからない: {0}")]
    NotFound(String),
}

impl DriveError {
    pub fn is_offline(&self) -> bool {
        matches!(self, Self::Network(_))
    }
}

/// アクセストークンを渡す。期限が切れていれば更新してから返す。
pub trait TokenProvider: Send + Sync {
    fn access_token(&self) -> Result<String, DriveError>;
    /// Drive に拒否された（401）とき、持っているアクセストークンを捨てる。
    fn invalidate(&self);
}

/// 決まったアクセストークンを返す（テスト用）。
pub struct StaticToken(pub String);

impl TokenProvider for StaticToken {
    fn access_token(&self) -> Result<String, DriveError> {
        Ok(self.0.clone())
    }

    fn invalidate(&self) {}
}

/// Drive の更新日時（RFC 3339、例: `2026-10-26T15:04:05.123Z`）を UNIX 時間の秒にする。
pub fn parse_time(s: &str) -> Option<i64> {
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|v| v.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let time = time.trim_end_matches('Z');
    let time = time.split(['+', '-']).next()?;
    let mut t = time.split(':');
    let (h, min) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
    let sec = t.next()?.split('.').next()?.parse::<i64>().ok()?;
    // 1970-01-01 からの日数（Howard Hinnant の days_from_civil）
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + h * 3600 + min * 60 + sec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_drive_time() {
        assert_eq!(parse_time("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_time("2026-10-26T15:04:05.123Z"), Some(1_793_027_045));
        assert_eq!(parse_time("2000-02-29T12:00:00Z"), Some(951_825_600));
        assert_eq!(parse_time("壊れた"), None);
    }
}
