import { openUrl } from "@tauri-apps/plugin-opener";
import type { Credit, CreditKind, LicenseType } from "../api";
import { CREDIT_LABEL, isWebUrl } from "../credits";
import { TermMarks } from "./TermMarks";

type Props = {
  kind: CreditKind;
  /** 右の欄のファイルに設定されているもののid。なければ null */
  currentId: number | null;
  credits: Credit[];
  licenseTypes: LicenseType[];
  busy: boolean;
  /** 右の欄のファイルに設定する */
  onSet: (name: string) => void;
  onClear: () => void;
  onError: (e: unknown) => void;
};

/**
 * 右の欄の「出典」「ライセンス」。1つのファイルに設定できるのは1つだけ。
 * 既にあるものをプルダウンで選ぶとすぐ設定し、「（なし）」で外す。設定されているもののURL・メモ・条項を出す
 */
export function CreditField({ kind, currentId, credits, licenseTypes, busy, onSet, onClear, onError }: Props) {
  const label = CREDIT_LABEL[kind];
  const current = credits.find((c) => c.id === currentId);
  const typeName = licenseTypes.find((t) => t.key === current?.licenseType)?.name;

  const pick = (value: string) => {
    if (value === "") onClear();
    else {
      const credit = credits.find((c) => c.id === Number(value));
      if (credit) onSet(credit.name);
    }
  };

  return (
    <div className="credit-field" data-testid={`credit-field-${kind}`}>
      <h2>{label}</h2>
      <select
        value={currentId ?? ""}
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

      {current && (
        <div className="credit-detail sub" data-testid={`detail-${kind}`}>
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
    </div>
  );
}
