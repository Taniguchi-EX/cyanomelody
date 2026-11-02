import type { Terms } from "../api";
import { TERM_DEFS, termValueLabel } from "../credits";

type Props = {
  terms: Terms;
  /** 種類を選んでいるときは変えられない */
  disabled: boolean;
  onChange: (terms: Terms) => void;
};

/** 条項ごとに「可・不可・不明」の3つのボタンを並べて選ぶ */
export function TermsEditor({ terms, disabled, onChange }: Props) {
  return (
    <div className="terms-editor" data-testid="terms-editor">
      {TERM_DEFS.map((def) => (
        <div className="term-row" key={def.key} data-testid="term" data-term={def.key}>
          <span className="term-label">{def.label}</span>
          <span className="segmented" role="group" aria-label={def.label}>
            {[true, false, null].map((value) => (
              <button
                key={String(value)}
                type="button"
                className={terms[def.key] === value ? "on" : ""}
                aria-pressed={terms[def.key] === value}
                disabled={disabled}
                onClick={() => onChange({ ...terms, [def.key]: value })}
              >
                {termValueLabel(def, value)}
              </button>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
