import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CountItem, Credit, CreditKind, LicenseType } from "../api";
import { CREDIT_LABEL, TERM_DEFS, isWebUrl, termValueLabel } from "../credits";

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
  /** 一括操作の欄で使うとき true（入力欄の名前やテスト用の名前を分ける） */
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
  const prefix = bulk ? "bulk-" : "";
  const listId = `${prefix}${kind}-names`;

  const set = async () => {
    if (await onSet(name)) setName("");
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
              <div>種類：{licenseTypes.find((t) => t.key === current.licenseType)?.name ?? "独自"}</div>
              <ul className="terms-list">
                {TERM_DEFS.map((d) => (
                  <li key={d.key} className={current.terms[d.key] === null ? "unknown" : ""}>
                    {d.label}：{termValueLabel(d, current.terms[d.key])}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="row" style={{ marginTop: 4 }}>
        <input
          type="text"
          list={listId}
          placeholder="名前（新しい名前なら作成）"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && set()}
          aria-label={bulk ? `まとめて設定する${label}の名前` : `設定する${label}の名前`}
        />
        <datalist id={listId}>
          {credits.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
        <button onClick={set} disabled={busy || !name.trim()}>
          設定
        </button>
        <button onClick={onClear} disabled={busy || !anySet} aria-label={bulk ? `まとめて${label}を外す` : `${label}を外す`}>
          外す
        </button>
      </div>
    </div>
  );
}
