//! エフェクトのまとまり（名前を付けた、エフェクトの並び）の管理と、プレイリストの項目への結び付け

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::db::{exists, now};
use crate::effects::Effect;
use crate::error::{Error, Result};
use crate::names::{ensure_unique_name, normalize_name, not_found};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EffectChain {
    pub id: i64,
    pub name: String,
    /// 中のエフェクト（かける順）
    pub effects: Vec<Effect>,
    /// 結び付けているプレイリストの項目の数
    pub item_count: i64,
}

/// エラーの文言に入れる名前
const WHAT: &str = "エフェクトセット";

/// まとまりの中のエフェクト（かける順）。保存した設定を読めないものは飛ばす
pub fn chain_effects(conn: &Connection, chain_id: i64) -> Result<Vec<Effect>> {
    let rows: Vec<String> = conn
        .prepare("SELECT effect FROM effect_steps WHERE chain_id = ?1 ORDER BY position")?
        .query_map([chain_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows.iter().filter_map(|s| serde_json::from_str(s).ok()).collect())
}

pub fn list_chains(conn: &Connection) -> Result<Vec<EffectChain>> {
    let rows: Vec<(i64, String, i64)> = conn
        .prepare(
            "SELECT c.id, c.name, (SELECT count(*) FROM playlist_items i WHERE i.effect_chain_id = c.id)
             FROM effect_chains c ORDER BY c.name COLLATE NOCASE",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    rows.into_iter()
        .map(|(id, name, item_count)| Ok(EffectChain { id, name, effects: chain_effects(conn, id)?, item_count }))
        .collect()
}

pub fn create_chain(conn: &Connection, name: &str) -> Result<i64> {
    let name = normalize_name(name, WHAT)?;
    ensure_unique_name(conn, "effect_chains", WHAT, &name, None)?;
    conn.execute("INSERT INTO effect_chains (name, created_at) VALUES (?1, ?2)", params![name, now()])?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_chain(conn: &Connection, id: i64, name: &str) -> Result<()> {
    let name = normalize_name(name, WHAT)?;
    ensure_unique_name(conn, "effect_chains", WHAT, &name, Some(id))?;
    if conn.execute("UPDATE effect_chains SET name = ?2 WHERE id = ?1", params![id, name])? == 0 {
        return Err(not_found(WHAT));
    }
    Ok(())
}

/// まとまりを削除する。結び付けていた項目からは外れる（外部キーで空になる）
pub fn delete_chain(conn: &Connection, id: i64) -> Result<()> {
    if conn.execute("DELETE FROM effect_chains WHERE id = ?1", [id])? == 0 {
        return Err(not_found(WHAT));
    }
    Ok(())
}

/// まとまりの中のエフェクトを、まとめて置き換える（追加・並べ替え・設定・削除は、画面で並びを作ってから保存する）
pub fn set_chain_effects(conn: &mut Connection, id: i64, effects: &[Effect]) -> Result<()> {
    let tx = conn.transaction()?;
    if !exists(&tx, "effect_chains", id)? {
        return Err(not_found(WHAT));
    }
    tx.execute("DELETE FROM effect_steps WHERE chain_id = ?1", [id])?;
    for (pos, e) in effects.iter().enumerate() {
        let json = serde_json::to_string(&e.clamped()).map_err(|e| Error::invalid(e.to_string()))?;
        tx.execute(
            "INSERT INTO effect_steps (chain_id, position, effect) VALUES (?1, ?2, ?3)",
            params![id, pos as i64, json],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// プレイリストの項目に、まとまりを結び付ける。None なら外す
pub fn set_item_chain(conn: &Connection, item_id: i64, chain_id: Option<i64>) -> Result<()> {
    if let Some(c) = chain_id {
        if !exists(conn, "effect_chains", c)? {
            return Err(not_found(WHAT));
        }
    }
    if conn.execute("UPDATE playlist_items SET effect_chain_id = ?2 WHERE id = ?1", params![item_id, chain_id])? == 0 {
        return Err(Error::invalid("項目が見つかりません"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_db;
    use crate::effects::NormalizeMethod;
    use crate::playlists::{add_files, create_playlist, get_playlist};

    #[test]
    fn create_edit_delete_chains() {
        let mut conn = test_db(&["a.wav"], &[]);
        let id = create_chain(&conn, " 強めの残響 ").unwrap();
        assert!(create_chain(&conn, "強めの残響").is_err());
        let other = create_chain(&conn, "小さく").unwrap();
        assert!(rename_chain(&conn, other, "強めの残響").is_err());
        rename_chain(&conn, other, "小さめ").unwrap();
        let effects = vec![
            Effect::Gain { db: 99.0 },
            Effect::Reverb { seconds: 1.5, mix: 0.3 },
            Effect::Normalize { method: NormalizeMethod::Rms, target_db: -16.0 },
        ];
        set_chain_effects(&mut conn, id, &effects).unwrap();
        let list = list_chains(&conn).unwrap();
        let chain = list.iter().find(|c| c.id == id).unwrap();
        // 範囲の外の設定は収めて保存する
        assert_eq!(chain.effects[0], Effect::Gain { db: 12.0 });
        assert_eq!(chain.effects.len(), 3);
        // 並べ替え（まとめて置き換える）
        set_chain_effects(&mut conn, id, &[effects[1].clone(), Effect::Gain { db: -3.0 }]).unwrap();
        assert_eq!(chain_effects(&conn, id).unwrap(), vec![effects[1].clone(), Effect::Gain { db: -3.0 }]);
        assert!(set_chain_effects(&mut conn, 99, &[]).is_err());

        // 項目に結び付けて、まとまりを消すと外れる
        let p = create_playlist(&mut conn, "P", None).unwrap();
        add_files(&mut conn, p, &[1]).unwrap();
        let item = get_playlist(&conn, p).unwrap().items[0].id;
        set_item_chain(&conn, item, Some(id)).unwrap();
        assert!(set_item_chain(&conn, item, Some(99)).is_err());
        assert_eq!(list_chains(&conn).unwrap().iter().find(|c| c.id == id).unwrap().item_count, 1);
        assert_eq!(get_playlist(&conn, p).unwrap().items[0].effect_chain.as_ref().unwrap().name, "強めの残響");
        delete_chain(&conn, id).unwrap();
        assert!(get_playlist(&conn, p).unwrap().items[0].effect_chain.is_none());
        assert!(delete_chain(&conn, id).is_err());
    }
}
