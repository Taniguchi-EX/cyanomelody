//! タグの読み込み（lofty）。ローカルと Drive で共通に使う。

use std::io::{Read, Seek};

use lofty::config::ParseOptions;
use lofty::prelude::*;
use lofty::probe::Probe;

use super::SourceError;

/// 曲のタグ。ないものは `None`。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

/// `reader` からタグを読む。音声の長さなどの情報は読まない（Drive での通信を減らすため）。
pub fn read_tags<R: Read + Seek>(reader: R) -> Result<Tags, SourceError> {
    let tagged = Probe::new(reader)
        .options(ParseOptions::new().read_properties(false))
        .guess_file_type()
        .map_err(|e| SourceError::Tags(e.to_string()))?
        .read()
        .map_err(|e| SourceError::Tags(e.to_string()))?;
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(Tags::default());
    };
    let text = |v: Option<std::borrow::Cow<'_, str>>| {
        v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    };
    Ok(Tags {
        title: text(tag.title()),
        artist: text(tag.artist()),
        album: text(tag.album()),
    })
}
