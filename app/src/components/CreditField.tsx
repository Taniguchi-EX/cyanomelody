import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CountItem, Credit, CreditKind, LicenseType } from "../api";
import { CREDIT_LABEL, isWebUrl } from "../credits";
import { TermMarks } from "./TermMarks";

type Props = {
  kind: CreditKind;
  /** 対象のファイルの、設定ごとのファイル数 */
  groups: CountItem[];
  credits: Credit[];
  licenseTypes: LicenseType[];
  busy: boolean;
  /** 対象のファイルに設定する。終わったら true */
  onSet: (name: string) => Promise<boolean>;
  onClear: () => void;
  onError: (e: unknown) => void;
  /** 一括操作の欄で使うとき true（入力欄の名前やテスト用の名前を分ける）。
   *  一括操作の欄では新しい名前で作れる。右の欄では既にあるものから選ぶだけ */
  bulk?: boolean;
};

/** 「出典」「ライセンス」の設定の表示と、設定・解除（右の欄と一括操作の欄で使う） */
export function CreditField({ kind, groups, credits, licenseTypes, busy, onSet, onClear, onError, bulk = false }: Props) {
  const label = CREDIT_LABEL[kind];
  const [name, setName] = useState("");

  const byId = (id: number | null) => credits.find((c) => c.id === id);
  const uniform = groups.length === 1 ? groups[0].id : undefined;
  const current = uniform != null ? byId(uniform) : undefined;
  const anySet = groups.some((g) => g.id !== null);
  const typeName = licenseTypes.find((t) => t.key === current?.licenseType)?.name;
  const prefix = bulk ? "bulk-" : "";
  const listId = `${prefix}${kind}-names`;

  const match = credits.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
  const canSet = bulk ? name.trim() !== "" : match !== undefined;
  const set = async () => {
    if (!canSet) return;
    if (await onSet(match?.name ?? name)) setName("");
  };

  return (
    <div className="credit-field" data-testid={`${prefix}credit-field-${kind}`}>
      <h2>{label}</h2>
      <div data-testid={`${prefix}current-${kind}`}>
        {uniform === null && <span className="sub">なし</span>}
        {current && <span>{current.name}</span>}
        {uniform === undefined && (
          <>
            <span>（ばらばら）</span>
            <ul className="credit-groups sub">
              {groups.map((g) => (
                <li key={String(g.id)}>
                  {g.id === null ? "なし" : (byId(g.id)?.name ?? "?")}：{g.count}件
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {current && (
        <div className="credit-detail sub" data-testid={`${prefix}detail-${kind}`}>
          {current.url &&
            (isWebUrl(current.url) ? (
              <a
                href={current.url}
                className="folder-path"
                onClick={(e) => {
                  e.preventDefault();
                  openUrl(current.url).catch(onError);
                }}
              >
                {current.url}
              </a>
            ) : (
              <div className="folder-path">{current.url}</div>
            ))}
          {current.note && <div className="note">{current.note}</div>}
          {kind === "license" && (
            <>
              {typeName && typeName !== current.name && <div>{typeName}</div>}
              <TermMarks terms={current.terms} words />
            </>
          )}
        </div>
      )}

      <div className="row" style={{ marginTop: 4 }}>
        <input
          type="text"
          list={listId}
          placeholder={bulk ? "名前（新しい名前なら作成）" : "名前"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && set()}
          aria-label={bulk ? `まとめて設定する${label}の名前` : `設定する${label}の名前`}
        />
        <datalist id={listId}>
          {credits.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
        <button onClick={set} disabled={busy || !canSet}>
          設定
        </button>
        <button onClick={onClear} disabled={busy || !anySet} className="icon"
          title="外す"
          aria-label={bulk ? `まとめて${label}を外す` : `${label}を外す`}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
