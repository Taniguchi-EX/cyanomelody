import { useEffect, useRef, useState } from "react";

/** 編集している行（index、null なら最後に加える行）と入力中の文字 */
type Editing = { index: number | null; text: string };

type ListProps = {
  load: () => Promise<string[]>;
  save: (values: string[]) => Promise<void>;
  /** チェックボックスが OFF（一覧を薄くする。編集はできる） */
  off: boolean;
  /** 一覧の名前（「無視する値」など）。ボタンの名前に使う */
  what: string;
  testId: string;
  /** 編集を始めた・終えたとき */
  onEditing: (editing: boolean) => void;
  /** 入れる前に確かめる（一覧の中の重なり・空のほかに）。入れられないなら理由を返す */
  validate?: (text: string) => string | null;
};

/** 編集できる一覧。各行の ✎（編集）・−（削除）と、最後の ＋（追加）。空・重なる値（大文字・小文字は区別しない）は入れない */
export function EditableList({ load, save, off, what, testId, onEditing, validate }: ListProps) {
  const [values, setValues] = useState<string[] | null>(null);
  const [editing, setEditingState] = useState<Editing | null>(null);
  const [error, setError] = useState("");
  // 入力欄の外を押して決めるとき（blur）と Enter が重ならないよう、決めたら印を付ける
  const committed = useRef(false);
  useEffect(() => {
    load()
      .then(setValues)
      .catch((e) => setError(String(e)));
  }, [load]);
  const setEditing = (e: Editing | null) => {
    setEditingState(e);
    onEditing(e !== null);
  };

  const store = (next: string[]) =>
    save(next)
      .then(() => {
        setValues(next);
        setError("");
        return true;
      })
      .catch((e) => {
        setError(String(e));
        return false;
      });

  /** 入力中の値を決める。空・重なる値は入れず、理由を出して入力を続ける */
  const commit = async () => {
    if (!editing || !values || committed.current) return;
    const text = editing.text.trim();
    if (text === "" && editing.index === null) {
      setEditing(null);
      return;
    }
    if (text === "") {
      setError("空の値は入れられません");
      return;
    }
    if (values.some((v, i) => i !== editing.index && v.toLowerCase() === text.toLowerCase())) {
      setError(`「${text}」はもう一覧にあります`);
      return;
    }
    const reason = validate?.(text);
    if (reason) {
      setError(reason);
      return;
    }
    const next = editing.index === null ? [...values, text] : values.map((v, i) => (i === editing.index ? text : v));
    committed.current = true;
    if (await store(next)) setEditing(null);
    committed.current = false;
  };

  const input = (label: string) =>
    editing && (
      <input
        type="text"
        autoFocus
        value={editing.text}
        onChange={(e) => setEditing({ ...editing, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            // ダイアログは閉じず、編集だけやめる
            e.stopPropagation();
            setEditing(null);
            setError("");
          }
        }}
        onBlur={() => commit()}
        aria-label={label}
      />
    );

  return (
    <div className="editable-list" data-testid={`${testId}-box`}>
      <ul className={`ignore-list${off ? " off" : ""}`} data-testid={testId}>
        {values?.map((v, i) => (
          <li key={`${i}:${v}`} data-value={v}>
            {editing?.index === i ? (
              input(`${v}の新しい値`)
            ) : (
              <>
                <span className="ignore-value">{v}</span>
                <button className="icon" onClick={() => setEditing({ index: i, text: v })} title="編集" aria-label={`${v}を編集`}>
                  ✎
                </button>
                <button className="icon" onClick={() => store(values.filter((_, j) => j !== i))} title="消す" aria-label={`${v}を消す`}>
                  −
                </button>
              </>
            )}
          </li>
        ))}
        {editing?.index === null && <li>{input(`加える${what}`)}</li>}
      </ul>
      <button
        className="icon add-button"
        onClick={() => setEditing({ index: null, text: "" })}
        disabled={values === null || editing !== null}
        title="加える"
        aria-label={`${what}を加える`}
      >
        ＋
      </button>
      {error && (
        <p className="error sub" data-testid={`${testId}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
