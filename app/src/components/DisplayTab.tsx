import { useEffect, useState } from "react";
import { api } from "../api";
import { fontValue, GRID_COLUMNS, setDisplay, TEXT_SCALES, useDisplay } from "../displaySettings";
import { isAndroid } from "../platform";

/** 設定画面の「表示」：文字の大きさ・フォント、グリッドのカードの数、拡張子を省くか。変えるとすぐ画面に効き、保存する */
export function DisplayTab({ onError }: { onError: (e: unknown) => void }) {
  const display = useDisplay();
  // OS にインストールされているフォント（タブを開いたときに読む）
  const [fonts, setFonts] = useState<{ value: string; label: string }[] | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .listFonts()
      .then((list) => alive && setFonts(list.map((f) => ({ value: fontValue(f.name), label: f.label }))))
      .catch((e) => alive && onError(e));
    return () => {
      alive = false;
    };
  }, [onError]);
  // 標準と、インストールされているフォント。選んでいたフォントが見つからない（アンインストールした）ときも、選び肢に残す
  const options = [{ value: "", label: "標準" }, ...(fonts ?? [])];
  if (display.font && !options.some((o) => o.value === display.font)) options.push({ value: display.font, label: display.font });
  return (
    <div className="display-tab" data-testid="display-tab">
      <div className="setting-row">
        <span className="setting-label">文字の大きさ</span>
        <span className="segmented" role="group" aria-label="文字の大きさ">
          {TEXT_SCALES.map((s) => (
            <button
              key={s.value}
              className={display.textScale === s.value ? "on" : undefined}
              aria-pressed={display.textScale === s.value}
              onClick={() => setDisplay({ textScale: s.value })}
            >
              {s.label}
            </button>
          ))}
        </span>
      </div>
      {/* Android では、端末のフォントの一覧を読めないので出さない */}
      {!isAndroid && (
        <div className="setting-row">
          <label className="setting-label" htmlFor="display-font">
            文字のフォント
          </label>
          <select id="display-font" value={display.font} onChange={(e) => setDisplay({ font: e.target.value })}>
            {options.map((f) => (
              <option key={f.value} value={f.value} style={f.value ? { fontFamily: f.value } : undefined}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="setting-row">
        <label className="setting-label" htmlFor="display-grid-columns">
          グリッドのカードの大きさ
        </label>
        <select
          id="display-grid-columns"
          value={display.gridColumns}
          onChange={(e) => setDisplay({ gridColumns: Number(e.target.value) })}
        >
          {GRID_COLUMNS.map((n) => (
            <option key={n} value={n}>
              横に{n}枚
            </option>
          ))}
        </select>
      </div>
      <div className="setting-row">
        <label>
          <input
            type="checkbox"
            checked={display.hideExtension}
            onChange={(e) => setDisplay({ hideExtension: e.target.checked })}
          />
          ファイルの拡張子を省略する
        </label>
      </div>
    </div>
  );
}
