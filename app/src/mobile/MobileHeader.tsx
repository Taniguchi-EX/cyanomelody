import type { ReactNode } from "react";

type Props = {
  /** 見出し（画面の名前） */
  title: ReactNode;
  /** 「←」を押したとき（なければ「←」を出さない） */
  onBack?: () => void;
  /** 「←」の代わりに出す記号と、その名前（チェックをやめる「✕」など） */
  back?: { icon: string; label: string };
  /** 右端に置くボタン */
  right?: ReactNode;
};

/** Android の画面の見出しの行（画面の一番上。スクロールしても残す） */
export function MobileHeader({ title, onBack, back = { icon: "←", label: "戻る" }, right }: Props) {
  return (
    <div className="m-header" data-testid="m-header">
      {onBack && (
        <button className="icon m-back" onClick={onBack} aria-label={back.label} title={back.label}>
          {back.icon}
        </button>
      )}
      <h2 className="m-title">{title}</h2>
      {right && <div className="m-header-right">{right}</div>}
    </div>
  );
}
