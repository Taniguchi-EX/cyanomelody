import { useState } from "react";
import type { Credit, CreditInput, CreditKind, LicenseType } from "../api";
import { CREDIT_LABEL, TERM_DEFS, UNKNOWN_TERMS, shortTerm } from "../credits";
import { TermsEditor } from "./TermsEditor";

type Props = {
  kind: CreditKind;
  credits: Credit[];
  licenseTypes: LicenseType[];
  busy: boolean;
  onCreate: (input: CreditInput) => Promise<boolean>;
  onUpdate: (credit: Credit, input: CreditInput) => Promise<boolean>;
  onDelete: (credit: Credit) => void;
  onClose: () => void;
};

const EMPTY_INPUT: CreditInput = { name: "", url: "", note: "", licenseType: null, terms: UNKNOWN_TERMS };

/** 出典・ライセンスの管理画面。作成と編集は上のフォームで行う */
export function CreditManager({ kind, credits, licenseTypes, busy, onCreate, onUpdate, onDelete, onClose }: Props) {
  const label = CREDIT_LABEL[kind];
  const isLicense = kind === "license";
  const [input, setInput] = useState<CreditInput>(EMPTY_INPUT);
  const [editing, setEditing] = useState<Credit | null>(null);

  const typeName = (key: string | null) => licenseTypes.find((t) => t.key === key)?.name ?? "独自";

  const startEdit = (c: Credit) => {
    setEditing(c);
    setInput({ name: c.name, url: c.url, note: c.note, licenseType: c.licenseType, terms: c.terms });
  };

  const reset = () => {
    setEditing(null);
    setInput(EMPTY_INPUT);
  };

  const submit = async () => {
    const ok = editing ? await onUpdate(editing, input) : await onCreate(input);
    if (ok) reset();
  };

  /** 種類を選んだら条項をその種類の内容にし、名前が空なら種類の名前を入れる */
  const selectType = (key: string) => {
    const type = licenseTypes.find((t) => t.key === key);
    setInput((i) =>
      type
        ? { ...i, licenseType: type.key, terms: type.terms, name: i.name.trim() ? i.name : type.name }
        : { ...i, licenseType: null },
    );
  };

  return (
    <div className="overlay" onKeyDown={(e) => e.key === "Escape" && editing === null && onClose()}>
      <div className="dialog" role="dialog" aria-label={`${label}の管理`}>
        <div className="dialog-head">
          <h2>
            {label}の管理（{credits.length}件）
          </h2>
          <button onClick={onClose}>閉じる</button>
        </div>

        <div className="credit-form" data-testid="credit-form">
          <h2>{editing ? `「${editing.name}」を編集` : `新しい${label}`}</h2>
          <div className="form-grid">
            <label htmlFor="credit-name">名前</label>
            <input
              id="credit-name"
              type="text"
              value={input.name}
              onChange={(e) => setInput((i) => ({ ...i, name: e.target.value }))}
            />
            <label htmlFor="credit-url">URL</label>
            <input
              id="credit-url"
              type="text"
              placeholder="https://"
              value={input.url}
              onChange={(e) => setInput((i) => ({ ...i, url: e.target.value }))}
            />
            <label htmlFor="credit-note">メモ</label>
            <textarea
              id="credit-note"
              rows={2}
              value={input.note}
              onChange={(e) => setInput((i) => ({ ...i, note: e.target.value }))}
            />
            {isLicense && (
              <>
                <label htmlFor="credit-type">種類</label>
                <select id="credit-type" value={input.licenseType ?? ""} onChange={(e) => selectType(e.target.value)}>
                  <option value="">独自</option>
                  {licenseTypes.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <span>条項</span>
                <TermsEditor
                  terms={input.terms}
                  disabled={input.licenseType !== null}
                  onChange={(terms) => setInput((i) => ({ ...i, terms }))}
                />
              </>
            )}
          </div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
            {editing && <button onClick={reset}>やめる</button>}
            <button onClick={submit} disabled={busy || !input.name.trim()}>
              {editing ? "保存" : "作成"}
            </button>
          </div>
        </div>

        <table className="tag-table">
          <thead>
            <tr>
              <th>名前</th>
              {isLicense && <th>種類・条項</th>}
              <th className="num">ファイル数</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {credits.map((c) => (
              <tr key={c.id} data-testid="manage-credit" data-credit-name={c.name}>
                <td>
                  {c.name}
                  {c.url && <div className="sub folder-path">{c.url}</div>}
                </td>
                {isLicense && (
                  <td className="terms-short" data-testid="terms-short">
                    <div>{typeName(c.licenseType)}</div>
                    <div className="sub">{TERM_DEFS.map((d) => shortTerm(d, c.terms[d.key])).join(" ")}</div>
                  </td>
                )}
                <td className="num">{c.fileCount}</td>
                <td className="actions">
                  <button onClick={() => startEdit(c)} disabled={busy}>
                    編集
                  </button>
                  <button onClick={() => onDelete(c)} disabled={busy}>
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {credits.length === 0 && <div className="sub">{label}はまだありません</div>}
      </div>
    </div>
  );
}
