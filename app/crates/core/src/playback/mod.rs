//! 再生エンジン。曲をデコードして出力先に流し、プレイリストの再生順を制御する。
//!
//! - `queue`：再生順（シャッフル、リピート）
//! - `decode`：デコード（Symphonia）
//! - `resample`：サンプルレートの変換（rubato）
//! - `output`：出力先（cpal。テストでは差し替える）
//! - `engine`：上をまとめて動かす `Player`

pub mod decode;
mod engine;
pub mod mp3;
pub mod output;
pub mod queue;
pub mod resample;

pub use engine::{EventHandler, PlayState, Player, PlayerEvent, Status, TrackOpener, TrackRef};

/// 再生まわりのエラー。
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum PlaybackError {
    /// 曲を開けない（ファイルがない、通信できないなど）
    #[error("曲を開けない: {0}")]
    Open(String),
    /// 読み込み中のエラー
    #[error("読み込みに失敗した: {0}")]
    Io(String),
    /// 形式が分からない、壊れている
    #[error("デコードに失敗した: {0}")]
    Decode(String),
    /// 出力先を開けない
    #[error("出力先を開けない: {0}")]
    Output(String),
}
