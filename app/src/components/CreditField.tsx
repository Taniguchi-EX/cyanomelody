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
   *  一括操作の欄では、名前を入れて設定し、新しい名前なら作る。右の欄では、既にあるものをプルダウンで選ぶとすぐ設定する */
  bulk?: boolean;
};

/** 「出典」「ライセンス」の設定の表示と、設定・解除（右の欄と一括操作の欄で使う）。1つのファイルに設定できるのは1つだけ */
export function CreditField({
  kind,
  groups,
  credits,
  licenseTypes,
  busy,
  onSet,
  onClear,
  onError,
  bulk = false,
}: Props) {
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
  const canSet = name.trim() !== "";
  const set = async () => {
    if (!canSet) return;
    if (await onSet(match?.name ?? name)) setName("");
  };

  /** 右の欄のプルダウンで選んだとき。「（なし）」なら外す */
  const pick = (value: string) => {
    if (value === "") onClear();
    else {
      const credit = byId(Number(value));
      if (credit) onSet(credit.name);
    }
  };

  return (
    <div className="credit-field" data-testid={`${prefix}credit-field-${kind}`}>
      <h2>{label}</h2>
      {!bulk && (
        <select
          value={uniform ?? ""}
          onChange={(e) => pick(e.target.value)}
          disabled={busy}
          aria-label={`${label}を選ぶ`}
          data-testid={`current-${kind}`}
        >
          <option value="">（なし）</option>
          {credits.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      {bulk && (
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
      )}

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

      {bulk && (
        <div className="row" style={{ marginTop: 4 }}>
          <input
            type="text"
            list={listId}
            placeholder="名前（新しい名前なら作成）"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && set()}
            aria-label={`まとめて設定する${label}の名前`}
          />
          <datalist id={listId}>
            {credits.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
          <button onClick={set} disabled={busy || !canSet}>
            設定
          </button>
          <button
            onClick={onClear}
            disabled={busy || !anySet}
            className="icon"
            title="外す"
            aria-label={`まとめて${label}を外す`}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
