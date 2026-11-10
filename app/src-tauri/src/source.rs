//! 音声ファイルの読み元。Windows ではパスから開き、Android の SAF では開いたファイルを複製して読む
//! （SAF のファイルは、パス（`/proc/self/fd/番号` も）から開き直せないため）

use std::fs::File;
use std::io::{self, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 何度でも頭から読めるように開ける、音声ファイル
pub trait FileSource {
    /// 頭から読むファイルを開く
    fn open(&self) -> io::Result<File>;
    /// 拡張子（形式の手がかり。ないこともある）
    fn extension(&self) -> Option<String>;
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
}

impl FileSource for PathBuf {
    fn open(&self) -> io::Result<File> {
        File::open(self)
    }
    fn extension(&self) -> Option<String> {
        FileSource::extension(self.as_path())
    }
}

/// 開いたファイル（Android の SAF）。読むたびに複製し、頭に戻す（複製は読む位置を共有するので、同時には読まない）
pub struct OpenedFile {
    pub file: File,
    /// ファイル名（拡張子を形式の手がかりにする）
    pub name: String,
}

impl FileSource for OpenedFile {
    fn open(&self) -> io::Result<File> {
        let mut file = self.file.try_clone()?;
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    }
    fn extension(&self) -> Option<String> {
        Path::new(&self.name).extension().and_then(|e| e.to_str()).map(str::to_string)
    }
}
