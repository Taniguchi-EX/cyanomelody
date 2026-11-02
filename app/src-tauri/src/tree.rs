//! タグとプレイリストに共通の型（木の並べ替えの移す先、idと名前の組）

use serde::{Deserialize, Serialize};

/// 木（タグ・プレイリスト）の並べ替えで、移す先
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "id")]
pub enum MoveTarget {
    /// 指定した節の前（同じ親の兄弟）
    Before(i64),
    /// 指定した節の後ろ（同じ親の兄弟）
    After(i64),
    /// 指定した節の子の最後
    Child(i64),
    /// 最上位の最後
    Root,
}

/// idと名前の組（ファイルに付いたタグ、プレイリストの項目のタグ・プレイリストなど）
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NamedRef {
    pub id: i64,
    pub name: String,
}
