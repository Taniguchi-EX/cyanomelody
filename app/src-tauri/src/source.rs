//! 音声ファイルの読み元。Windows ではパスから、Android の SAF では URI から開く（`location::Location`）。
//! SAF のファイルはパス（`/proc/self/fd/番号` も）から開き直せないので、読む処理はパスではなくこの型を受け取る

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

/// 何度でも頭から読めるように開ける、音声ファイル
pub trait FileSource {
    /// 頭から読むファイルを開く
    fn open(&self) -> io::Result<File>;
    /// 拡張子（形式の手がかり。ないこともある）
    fn extension(&self) -> Option<String>;
    /// ファイルを見分ける名前（パスか URI）。エフェクトをかけた音の置き場所の名前に使う
    fn identity(&self) -> String;
    /// 拡張子が ext か（大文字・小文字は区別しない）
    fn has_extension(&self, ext: &str) -> bool {
        self.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext))
    }
}

impl FileSource for Path {
    fn open(&self) -> io::Result<File> {
        File::open(self)
    }
    fn extension(&self) -> Option<String> {
        Path::extension(self).and_then(|e| e.to_str()).map(str::to_string)
    }
    fn identity(&self) -> String {
        self.to_string_lossy().into_owned()
    }
}

impl FileSource for PathBuf {
    fn open(&self) -> io::Result<File> {
        File::open(self)
    }
    fn extension(&self) -> Option<String> {
        FileSource::extension(self.as_path())
    }
    fn identity(&self) -> String {
        self.as_path().identity()
    }
}
