import { useState } from "react";
import type { Credit, CreditInput, CreditKind, LicenseType } from "../api";
import { CREDIT_LABEL, UNKNOWN_TERMS } from "../credits";
import { TermsEditor } from "./TermsEditor";
import { useEscape } from "../hooks/useEscape";

type Props = {
  kind: CreditKind;
  /** 編集するもの。作るときは null */
  credit: Credit | null;
  licenseTypes: LicenseType[];
  busy: boolean;
  /** 作る・保存する。終わったら true（画面を閉じる） */
  onSubmit: (input: CreditInput) => Promise<boolean>;
  onClose: () => void;
};

const EMPTY_INPUT: CreditInput = { name: "", url: "", note: "", licenseType: null, terms: UNKNOWN_TERMS };

/** 出典・ライセンスを作る・編集する小さい画面 */
export function CreditForm({ kind, credit, licenseTypes, busy, onSubmit, onClose }: Props) {
  const label = CREDIT_LABEL[kind];
  const isLicense = kind === "license";
  const [input, setInput] = useState<CreditInput>(() =>
    credit
      ? { name: credit.name, url: credit.url, note: credit.note, licenseType: credit.licenseType, terms: credit.terms }
      : EMPTY_INPUT,
  );

  const submit = async () => {
    if (await onSubmit(input)) onClose();
  };

  useEscape(onClose);

  /** 種類を選んだら条項をその種類の内容にし、名前が空なら種類の名前を入れる */
  const selectType = (key: string) => {
    const type = licenseTypes.find((t) => t.key === key);
    setInput((i) =>
      type
        ? { ...i, licenseType: type.key, terms: type.terms, name: i.name.trim() ? i.name : type.name }
        : { ...i, licenseType: null },
    );
  };

  const title = credit ? `「${credit.name}」を編集` : `新しい${label}`;
  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-label={title} data-testid="credit-form">
        <div className="dialog-head">
          <h2>{title}</h2>
        </div>
        <div className="form-grid">
          <label htmlFor="credit-name">名前</label>
          <input
            id="credit-name"
            type="text"
            autoFocus
            value={input.name}
            onChange={(e) => setInput((i) => ({ ...i, name: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && !busy && input.name.trim() && submit()}
          />
          <label htmlFor="credit-url">URL</label>
          <input
            id="credit-url"
            type="text"
            placeholder="https://"
            value={input.url}
            onChange={(e) => setInput((i) => ({ ...i, url: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && !busy && input.name.trim() && submit()}
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
          <button onClick={onClose}>やめる</button>
          <button onClick={submit} disabled={busy || !input.name.trim()}>
            {credit ? "保存" : "作成"}
          </button>
        </div>
      </div>
    </div>
  );
}
