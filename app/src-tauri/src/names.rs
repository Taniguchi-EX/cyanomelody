//! 名前を持つもの（タグ・プレイリスト・エフェクトセット・出典・ライセンス）に共通の、名前の決まりと探し方。
//! 名前の列はどれも UNIQUE COLLATE NOCASE なので、大文字・小文字は区別しない

use rusqlite::{Connection, OptionalExtension};

use crate::error::{Error, Result};
use crate::tags::TAG_SEPARATOR;

/// 名前の決まり。前後の空白を除き、空や制御文字を含む名前はエラー。
/// what はエラーの文言に入れる、名前の持ち主（「タグ」など）
pub fn normalize_name(name: &str, what: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::invalid(format!("{what}の名前が空です")));
    }
    if name.contains(TAG_SEPARATOR) || name.chars().any(char::is_control) {
        return Err(Error::invalid(format!("{what}の名前に使えない文字が含まれています")));
    }
    Ok(name.to_owned())
}

/// table から、名前で id を探す
pub fn find_by_name(conn: &Connection, table: &str, name: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(&format!("SELECT id FROM {table} WHERE name = ?1"), [name], |r| r.get(0))
        .optional()?)
}

/// 同じ名前のものがあればエラーにする。except は名前を変えるときの自分自身（自分と同じ名前はよい）
pub fn ensure_unique_name(conn: &Connection, table: &str, what: &str, name: &str, except: Option<i64>) -> Result<()> {
    match find_by_name(conn, table, name)? {
        Some(other) if Some(other) != except => Err(Error::invalid(format!("同じ名前の{what}があります: {name}"))),
        _ => Ok(()),
    }
}

/// what が見つからないときのエラー
pub fn not_found(what: &str) -> Error {
    Error::invalid(format!("{what}が見つかりません"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_db;

    #[test]
    fn unique_name_ignores_case_and_self() {
        let conn = test_db(&[], &[]);
        conn.execute("INSERT INTO tags (name, created_at) VALUES ('Rain', 0)", []).unwrap();
        let id = conn.last_insert_rowid();
        assert_eq!(find_by_name(&conn, "tags", "rain").unwrap(), Some(id));
        assert!(ensure_unique_name(&conn, "tags", "タグ", "RAIN", None).is_err());
        assert!(ensure_unique_name(&conn, "tags", "タグ", "rain", Some(id)).is_ok());
        assert!(ensure_unique_name(&conn, "tags", "タグ", "風", None).is_ok());
    }

    #[test]
    fn normalize_trims_and_rejects_empty_and_control() {
        assert_eq!(normalize_name("  雨 ", "タグ").unwrap(), "雨");
        assert!(normalize_name("   ", "タグ").is_err());
        assert!(normalize_name("a\tb", "タグ").is_err());
    }
}
