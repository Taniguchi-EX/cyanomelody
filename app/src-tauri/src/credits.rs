//! 出典とライセンス（まとめて「クレジット」と呼ぶ）の管理と、ファイルへの設定

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::now;
use crate::error::{Error, Result};
use crate::tags::normalize_name;

/// 出典かライセンスか
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CreditKind {
    Source,
    License,
}

impl CreditKind {
    fn table(self) -> &'static str {
        match self {
            CreditKind::Source => "sources",
            CreditKind::License => "licenses",
        }
    }

    /// audio_files でこのクレジットを指す列
    fn column(self) -> &'static str {
        match self {
            CreditKind::Source => "source_id",
            CreditKind::License => "license_id",
        }
    }

    fn label(self) -> &'static str {
        match self {
            CreditKind::Source => "出典",
            CreditKind::License => "ライセンス",
        }
    }
}

/// ライセンスの条項。None は「不明」
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Terms {
    /// 商用利用：可／不可
    pub commercial: Option<bool>,
    /// クレジット表記：必要／不要
    pub credit: Option<bool>,
    /// 改変：可／不可
    pub modify: Option<bool>,
    /// 再配布（素材そのもの）：可／不可
    pub redistribute: Option<bool>,
    /// 継承（改変したものを同じライセンスで公開する）：必要／不要
    pub share_alike: Option<bool>,
}

/// 一般的なライセンスの種類
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseType {
    pub key: &'static str,
    pub name: &'static str,
    pub terms: Terms,
}

const fn terms(commercial: bool, credit: bool, modify: bool, redistribute: bool, share_alike: bool) -> Terms {
    Terms {
        commercial: Some(commercial),
        credit: Some(credit),
        modify: Some(modify),
        redistribute: Some(redistribute),
        share_alike: Some(share_alike),
    }
}

/// 選べるライセンスの種類と、それぞれの条項
pub const LICENSE_TYPES: &[LicenseType] = &[
    LicenseType { key: "cc0", name: "CC0 1.0", terms: terms(true, false, true, true, false) },
    LicenseType { key: "public-domain", name: "パブリックドメイン", terms: terms(true, false, true, true, false) },
    LicenseType { key: "cc-by-4.0", name: "CC BY 4.0", terms: terms(true, true, true, true, false) },
    LicenseType { key: "cc-by-sa-4.0", name: "CC BY-SA 4.0", terms: terms(true, true, true, true, true) },
    LicenseType { key: "cc-by-nc-4.0", name: "CC BY-NC 4.0", terms: terms(false, true, true, true, false) },
    LicenseType { key: "cc-by-nc-sa-4.0", name: "CC BY-NC-SA 4.0", terms: terms(false, true, true, true, true) },
    LicenseType { key: "cc-by-nd-4.0", name: "CC BY-ND 4.0", terms: terms(true, true, false, true, false) },
    LicenseType { key: "cc-by-nc-nd-4.0", name: "CC BY-NC-ND 4.0", terms: terms(false, true, false, true, false) },
    // 著作権表示と許諾表示を含める必要があるため、クレジット表記は「必要」
    LicenseType { key: "mit", name: "MIT", terms: terms(true, true, true, true, false) },
];

fn license_type(key: &str) -> Option<&'static LicenseType> {
    LICENSE_TYPES.iter().find(|t| t.key == key)
}

/// 出典またはライセンス。出典では license_type は None、terms はすべて不明
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Credit {
    pub id: i64,
    pub name: String,
    pub url: String,
    pub note: String,
    /// 一般的なライセンスの種類のkey。「独自」のときは None
    pub license_type: Option<String>,
    pub terms: Terms,
    /// 設定されたファイルの数
    pub file_count: i64,
}

/// 作成・編集で入力する項目
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CreditInput {
    pub name: String,
    pub url: String,
    pub note: String,
    pub license_type: Option<String>,
    pub terms: Terms,
}

pub fn list_credits(conn: &Connection, kind: CreditKind) -> Result<Vec<Credit>> {
    let extra = match kind {
        CreditKind::Source => "NULL, NULL, NULL, NULL, NULL, NULL",
        CreditKind::License => "c.license_type, c.commercial, c.credit, c.modify, c.redistribute, c.share_alike",
    };
    let sql = format!(
        "SELECT c.id, c.name, c.url, c.note, {extra},
                (SELECT count(*) FROM audio_files a WHERE a.{col} = c.id)
         FROM {table} c ORDER BY c.name COLLATE NOCASE",
        col = kind.column(),
        table = kind.table(),
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        let license_type: Option<String> = r.get(4)?;
        let stored = Terms {
            commercial: r.get(5)?,
            credit: r.get(6)?,
            modify: r.get(7)?,
            redistribute: r.get(8)?,
            share_alike: r.get(9)?,
        };
        // 一般的なライセンスの条項は、保存した値ではなく定義から決める
        let terms = license_type.as_deref().and_then(license_type_terms).unwrap_or(stored);
        Ok(Credit {
            id: r.get(0)?,
            name: r.get(1)?,
            url: r.get(2)?,
            note: r.get(3)?,
            license_type,
            terms,
            file_count: r.get(10)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn license_type_terms(key: &str) -> Option<Terms> {
    license_type(key).map(|t| t.terms)
}

fn find(conn: &Connection, kind: CreditKind, name: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(&format!("SELECT id FROM {} WHERE name = ?1", kind.table()), [name], |r| r.get(0))
        .optional()?)
}

/// 入力を確かめて、保存する形にそろえる
fn normalize(kind: CreditKind, input: &CreditInput) -> Result<CreditInput> {
    let name = normalize_name(&input.name, kind.label())?;
    let (license_type, terms) = match kind {
        CreditKind::Source => (None, Terms::default()),
        CreditKind::License => match input.license_type.as_deref() {
            None | Some("") => (None, input.terms),
            Some(key) => {
                let t = license_type(key).ok_or_else(|| Error::invalid(format!("ライセンスの種類が不明です: {key}")))?;
                (Some(t.key.to_owned()), t.terms)
            }
        },
    };
    Ok(CreditInput {
        name,
        url: input.url.trim().to_owned(),
        note: input.note.trim_end().to_owned(),
        license_type,
        terms,
    })
}

fn duplicate(kind: CreditKind, name: &str) -> Error {
    Error::invalid(format!("同じ名前の{}があります: {name}", kind.label()))
}

fn insert(conn: &Connection, kind: CreditKind, c: &CreditInput) -> Result<i64> {
    match kind {
        CreditKind::Source => conn.execute(
            "INSERT INTO sources (name, url, note, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![c.name, c.url, c.note, now()],
        )?,
        CreditKind::License => conn.execute(
            "INSERT INTO licenses (name, url, note, license_type, commercial, credit, modify,
                                   redistribute, share_alike, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                c.name,
                c.url,
                c.note,
                c.license_type,
                c.terms.commercial,
                c.terms.credit,
                c.terms.modify,
                c.terms.redistribute,
                c.terms.share_alike,
                now()
            ],
        )?,
    };
    Ok(conn.last_insert_rowid())
}

/// 出典・ライセンスを作る。同じ名前があればエラー。
pub fn create_credit(conn: &Connection, kind: CreditKind, input: &CreditInput) -> Result<i64> {
    let c = normalize(kind, input)?;
    if find(conn, kind, &c.name)?.is_some() {
        return Err(duplicate(kind, &c.name));
    }
    insert(conn, kind, &c)
}

/// 出典・ライセンスの項目を変える。別の既存のものと同じ名前にするときはエラー（統合はしない）。
pub fn update_credit(conn: &Connection, kind: CreditKind, id: i64, input: &CreditInput) -> Result<()> {
    let c = normalize(kind, input)?;
    if find(conn, kind, &c.name)?.is_some_and(|other| other != id) {
        return Err(duplicate(kind, &c.name));
    }
    let n = match kind {
        CreditKind::Source => conn.execute(
            "UPDATE sources SET name = ?2, url = ?3, note = ?4 WHERE id = ?1",
            params![id, c.name, c.url, c.note],
        )?,
        CreditKind::License => conn.execute(
            "UPDATE licenses SET name = ?2, url = ?3, note = ?4, license_type = ?5, commercial = ?6,
                    credit = ?7, modify = ?8, redistribute = ?9, share_alike = ?10
             WHERE id = ?1",
            params![
                id,
                c.name,
                c.url,
                c.note,
                c.license_type,
                c.terms.commercial,
                c.terms.credit,
                c.terms.modify,
                c.terms.redistribute,
                c.terms.share_alike
            ],
        )?,
    };
    if n == 0 {
        return Err(not_found(kind));
    }
    Ok(())
}

fn not_found(kind: CreditKind) -> Error {
    Error::invalid(format!("{}が見つかりません", kind.label()))
}

/// 出典・ライセンスを削除する。設定されていたファイルは「なし」になる。
pub fn delete_credit(conn: &Connection, kind: CreditKind, id: i64) -> Result<()> {
    let n = conn.execute(&format!("DELETE FROM {} WHERE id = ?1", kind.table()), [id])?;
    if n == 0 {
        return Err(not_found(kind));
    }
    Ok(())
}

/// 選んだファイルに出典・ライセンスを設定する。name が None なら外す。
/// まだない名前なら、その名前で作る（ライセンスは「独自」、条項はすべて不明）。設定したもののidを返す。
pub fn set_file_credit(
    conn: &mut Connection,
    kind: CreditKind,
    file_ids: &[i64],
    name: Option<&str>,
) -> Result<Option<i64>> {
    let tx = conn.transaction()?;
    let id = match name {
        None => None,
        Some(name) => {
            let name = normalize_name(name, kind.label())?;
            Some(match find(&tx, kind, &name)? {
                Some(id) => id,
                None => insert(&tx, kind, &CreditInput { name, ..Default::default() })?,
            })
        }
    };
    {
        let mut stmt = tx.prepare(&format!("UPDATE audio_files SET {} = ?2 WHERE id = ?1", kind.column()))?;
        for file_id in file_ids {
            stmt.execute(params![file_id, id])?;
        }
    }
    tx.commit()?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    /// ファイル3件（id 1〜3）を入れたDB
    fn setup() -> Connection {
        let conn = open_in_memory().unwrap();
        conn.execute_batch(
            "INSERT INTO library_folders (id, path, added_at) VALUES (1, 'C:\\lib', 0);
             INSERT INTO audio_files (id, folder_id, rel_path, size, modified_at, added_at)
               VALUES (1, 1, 'a.wav', 0, 0, 0), (2, 1, 'b.wav', 0, 0, 0), (3, 1, 'c.wav', 0, 0, 0);",
        )
        .unwrap();
        conn
    }

    fn input(name: &str) -> CreditInput {
        CreditInput { name: name.into(), ..Default::default() }
    }

    fn file_credit(conn: &Connection, kind: CreditKind, file_id: i64) -> Option<i64> {
        conn.query_row(
            &format!("SELECT {} FROM audio_files WHERE id = ?1", kind.column()),
            [file_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn license_types_have_no_unknown_terms() {
        for t in LICENSE_TYPES {
            let s = t.terms;
            assert!(
                [s.commercial, s.credit, s.modify, s.redistribute, s.share_alike].iter().all(Option::is_some),
                "{}",
                t.key
            );
        }
    }

    #[test]
    fn create_and_list_sources() {
        let conn = setup();
        let id = create_credit(
            &conn,
            CreditKind::Source,
            &CreditInput {
                name: " 効果音サイトA ".into(),
                url: " https://example.com/ ".into(),
                note: "メモ\n".into(),
                // 出典では無視する
                license_type: Some("cc0".into()),
                terms: terms(true, true, true, true, true),
            },
        )
        .unwrap();
        create_credit(&conn, CreditKind::Source, &input("自分で録音")).unwrap();
        assert!(create_credit(&conn, CreditKind::Source, &input("効果音サイトa")).is_err());
        assert!(create_credit(&conn, CreditKind::Source, &input(" ")).is_err());
        // 出典とライセンスは別の名前空間
        create_credit(&conn, CreditKind::License, &input("効果音サイトA")).unwrap();

        let list = list_credits(&conn, CreditKind::Source).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(
            list.iter().find(|c| c.id == id).unwrap(),
            &Credit {
                id,
                name: "効果音サイトA".into(),
                url: "https://example.com/".into(),
                note: "メモ".into(),
                license_type: None,
                terms: Terms::default(),
                file_count: 0,
            }
        );
    }

    #[test]
    fn license_terms_come_from_type_or_input() {
        let conn = setup();
        let own = Terms { commercial: Some(false), credit: Some(true), ..Default::default() };
        let custom = create_credit(
            &conn,
            CreditKind::License,
            &CreditInput { name: "サイトB規約".into(), terms: own, ..Default::default() },
        )
        .unwrap();
        // 種類を選んだときは、入力した条項ではなく種類の条項になる
        let cc = create_credit(
            &conn,
            CreditKind::License,
            &CreditInput {
                name: "CC BY 4.0".into(),
                license_type: Some("cc-by-4.0".into()),
                terms: Terms::default(),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(create_credit(
            &conn,
            CreditKind::License,
            &CreditInput { name: "x".into(), license_type: Some("gpl".into()), ..Default::default() },
        )
        .is_err());

        let list = list_credits(&conn, CreditKind::License).unwrap();
        let get = |id| list.iter().find(|c| c.id == id).unwrap();
        assert_eq!(get(custom).terms, own);
        assert_eq!(get(custom).license_type, None);
        assert_eq!(get(cc).terms, terms(true, true, true, true, false));
        assert_eq!(get(cc).license_type.as_deref(), Some("cc-by-4.0"));

        // 「独自」に戻すと、入力した条項になる
        update_credit(
            &conn,
            CreditKind::License,
            cc,
            &CreditInput { name: "CC BY 4.0".into(), terms: own, ..Default::default() },
        )
        .unwrap();
        let list = list_credits(&conn, CreditKind::License).unwrap();
        assert_eq!(list.iter().find(|c| c.id == cc).unwrap().terms, own);
    }

    #[test]
    fn stored_terms_are_ignored_for_known_types() {
        let conn = setup();
        let id = create_credit(
            &conn,
            CreditKind::License,
            &CreditInput { name: "CC0".into(), license_type: Some("cc0".into()), ..Default::default() },
        )
        .unwrap();
        conn.execute("UPDATE licenses SET commercial = 0 WHERE id = ?1", [id]).unwrap();
        let list = list_credits(&conn, CreditKind::License).unwrap();
        assert_eq!(list[0].terms.commercial, Some(true));
    }

    #[test]
    fn update_rejects_other_existing_name() {
        let conn = setup();
        let a = create_credit(&conn, CreditKind::Source, &input("a")).unwrap();
        create_credit(&conn, CreditKind::Source, &input("b")).unwrap();
        assert!(update_credit(&conn, CreditKind::Source, a, &input("B")).is_err());
        // 自分自身の大文字・小文字だけの変更はできる
        update_credit(&conn, CreditKind::Source, a, &input("A")).unwrap();
        assert_eq!(list_credits(&conn, CreditKind::Source).unwrap()[0].name, "A");
        assert!(update_credit(&conn, CreditKind::Source, 99, &input("c")).is_err());
    }

    #[test]
    fn set_creates_replaces_and_clears() {
        let mut conn = setup();
        let k = CreditKind::License;
        let id = set_file_credit(&mut conn, k, &[1, 2], Some(" 新しい規約 ")).unwrap().unwrap();
        let list = list_credits(&conn, k).unwrap();
        assert_eq!(list[0].name, "新しい規約");
        assert_eq!(list[0].terms, Terms::default());
        assert_eq!(list[0].license_type, None);
        assert_eq!(list[0].file_count, 2);
        // 既存の名前なら作らずに設定する（大文字・小文字は区別しない）
        let other = create_credit(&conn, k, &input("Other")).unwrap();
        assert_eq!(set_file_credit(&mut conn, k, &[2, 3], Some("other")).unwrap(), Some(other));
        assert_eq!(file_credit(&conn, k, 1), Some(id));
        assert_eq!(file_credit(&conn, k, 2), Some(other));
        assert_eq!(set_file_credit(&mut conn, k, &[2], None).unwrap(), None);
        assert_eq!(file_credit(&conn, k, 2), None);
        assert!(set_file_credit(&mut conn, k, &[1], Some("")).is_err());
        // 出典は別の列
        assert_eq!(file_credit(&conn, CreditKind::Source, 1), None);
    }

    #[test]
    fn delete_clears_files() {
        let mut conn = setup();
        let k = CreditKind::Source;
        let id = set_file_credit(&mut conn, k, &[1, 2], Some("a")).unwrap().unwrap();
        delete_credit(&conn, k, id).unwrap();
        assert_eq!(file_credit(&conn, k, 1), None);
        let files: i64 = conn.query_row("SELECT count(*) FROM audio_files", [], |r| r.get(0)).unwrap();
        assert_eq!(files, 3);
        assert!(delete_credit(&conn, k, id).is_err());
    }
}
