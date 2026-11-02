import { useState } from "react";
import { EFFECT_DEFS, describeEffect, effectDef, paramValue, type Effect, type EffectChain, type EffectKind } from "../effects";
import { useEscape } from "../hooks/useEscape";
import { confirmDialog } from "../confirm";

type Props = {
  chains: EffectChain[];
  busy: boolean;
  /** 試聴に使うファイル（右の欄に出しているファイル）の名前。なければ null */
  previewFileName: string | null;
  /** 作ったまとまりのidを返す。作れなかったら null */
  onCreate: (name: string) => Promise<number | null>;
  onRename: (chain: EffectChain, name: string) => Promise<boolean>;
  onDelete: (chain: EffectChain) => void;
  onSave: (chain: EffectChain, effects: Effect[]) => Promise<boolean>;
  onPreview: (effects: Effect[]) => void;
  onClose: () => void;
};

/** エフェクトのまとまりの管理画面。左にまとまりの一覧、右に選んだまとまりの中身 */
export function EffectManager({
  chains,
  busy,
  previewFileName,
  onCreate,
  onRename,
  onDelete,
  onSave,
  onPreview,
  onClose,
}: Props) {
  const [newName, setNewName] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(chains[0]?.id ?? null);
  const selected = chains.find((c) => c.id === selectedId) ?? null;
  // 編集中のエフェクトの並び（「保存」で保存する）。選んだまとまりが変わったら読み直す
  const [draft, setDraft] = useState<{ chainId: number; effects: Effect[] } | null>(null);
  const effects = draft && draft.chainId === selectedId ? draft.effects : (selected?.effects ?? []);
  const dirty = draft !== null && draft.chainId === selectedId;
  const [name, setName] = useState(chains[0]?.name ?? "");
  const [addKind, setAddKind] = useState<EffectKind>("gain");

  /** 保存していない変更があれば、捨ててよいか確かめてから action を行う */
  const leave = async (action: () => void) => {
    if (dirty && !(await confirmDialog("保存していない変更があります。捨ててよいですか？"))) return;
    setDraft(null);
    action();
  };

  useEscape(() => leave(onClose));

  const select = (c: EffectChain) => {
    if (c.id === selectedId) return;
    leave(() => {
      setSelectedId(c.id);
      setName(c.name);
    });
  };

  const edit = (next: Effect[]) => selected && setDraft({ chainId: selected.id, effects: next });

  const setParam = (index: number, key: string, value: number | string) =>
    edit(effects.map((e, i) => (i === index ? ({ ...e, [key]: value } as Effect) : e)));

  const move = (index: number, delta: number) => {
    const next = [...effects];
    const [e] = next.splice(index, 1);
    next.splice(index + delta, 0, e);
    edit(next);
  };

  const create = () =>
    leave(async () => {
      const id = await onCreate(newName);
      if (id === null) return;
      // 作ったまとまりを選んで、すぐにエフェクトを加えられるようにする
      setNewName("");
      setSelectedId(id);
      setName(newName.trim());
    });

  return (
    <div className="overlay">
      <div className="dialog effect-dialog" role="dialog" aria-label="エフェクトのまとまりの管理">
        <div className="dialog-head">
          <h2>エフェクトのまとまりの管理（{chains.length}件）</h2>
          <button onClick={() => leave(onClose)}>閉じる</button>
        </div>
        <div className="effect-layout">
          <div className="effect-chains">
            <div className="row">
              <input
                type="text"
                placeholder="新しいまとまりの名前"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !busy && newName.trim() && create()}
                aria-label="新しいエフェクトのまとまりの名前"
              />
              <button onClick={create} disabled={busy || !newName.trim()}>
                作成
              </button>
            </div>
            <ul className="tag-list">
              {chains.map((c) => (
                <li
                  key={c.id}
                  className={c.id === selectedId ? "active" : ""}
                  onClick={() => select(c)}
                  data-testid="effect-chain"
                  data-chain-name={c.name}
                  title={c.effects.map(describeEffect).join(" → ") || "エフェクトなし"}
                >
                  <span className="tag-name">{c.name}</span>
                  <span className="sub" title="結び付けている項目の数">
                    {c.itemCount}
                  </span>
                </li>
              ))}
            </ul>
            {chains.length === 0 && <div className="sub">まとまりはまだありません</div>}
          </div>

          <div className="effect-steps" data-testid="effect-steps">
            {!selected && <div className="sub">左の一覧からまとまりを選んでください</div>}
            {selected && (
              <>
                <div className="row">
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-label="エフェクトのまとまりの名前"
                  />
                  <button
                    onClick={() => onRename(selected, name)}
                    disabled={busy || !name.trim() || name.trim() === selected.name}
                  >
                    名前を変える
                  </button>
                  <button onClick={() => onDelete(selected)} disabled={busy}>
                    削除
                  </button>
                </div>
                <h2>中のエフェクト（上から順にかける）</h2>
                {effects.length === 0 && <div className="sub">エフェクトはまだありません</div>}
                <ol className="effect-list">
                  {effects.map((e, i) => {
                    const def = effectDef(e.kind);
                    return (
                      <li key={i} data-testid="effect-step" data-kind={e.kind}>
                        <span className="effect-label">{def.label}</span>
                        {e.kind === "normalize" && (
                          <select
                            value={e.method}
                            onChange={(ev) => setParam(i, "method", ev.target.value)}
                            aria-label={`${i + 1}番目のそろえ方`}
                          >
                            <option value="peak">ピーク</option>
                            <option value="rms">平均</option>
                          </select>
                        )}
                        {def.params.map((p) => {
                          const v = paramValue(e, p.key);
                          return (
                            <label key={p.key} className="effect-param">
                              {p.label}
                              <input
                                type="number"
                                min={p.percent ? p.min * 100 : p.min}
                                max={p.percent ? p.max * 100 : p.max}
                                step={p.percent ? p.step * 100 : p.step}
                                value={p.percent ? Math.round(v * 100) : v}
                                onChange={(ev) => {
                                  const n = Number(ev.target.value);
                                  if (!Number.isNaN(n)) setParam(i, p.key, p.percent ? n / 100 : n);
                                }}
                                aria-label={`${i + 1}番目の${p.label}`}
                              />
                              {p.unit}
                            </label>
                          );
                        })}
                        <span className="effect-actions">
                          <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={`${i + 1}番目を上へ`}>
                            ↑
                          </button>
                          <button
                            onClick={() => move(i, 1)}
                            disabled={i === effects.length - 1}
                            aria-label={`${i + 1}番目を下へ`}
                          >
                            ↓
                          </button>
                          <button
                            onClick={() => edit(effects.filter((_, j) => j !== i))}
                            aria-label={`${i + 1}番目を外す`}
                          >
                            外す
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ol>
                <div className="row">
                  <select
                    value={addKind}
                    onChange={(e) => setAddKind(e.target.value as EffectKind)}
                    aria-label="加えるエフェクト"
                  >
                    {EFFECT_DEFS.map((d) => (
                      <option key={d.kind} value={d.kind}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                  <button onClick={() => edit([...effects, { ...effectDef(addKind).defaults }])}>加える</button>
                </div>
                <div className="row effect-save">
                  <button onClick={() => onPreview(effects)} disabled={busy || !previewFileName}>
                    ▶ 試聴
                  </button>
                  <span className="sub">
                    {previewFileName
                      ? `右の欄のファイル（${previewFileName}）にかけて鳴らします`
                      : "試聴するには、ファイルの一覧でファイルをクリックしてください"}
                  </span>
                  <span style={{ flex: 1 }} />
                  {dirty && <span className="warn">保存していない変更があります</span>}
                  <button onClick={() => setDraft(null)} disabled={!dirty}>
                    元に戻す
                  </button>
                  <button
                    onClick={async () => {
                      if (await onSave(selected, effects)) setDraft(null);
                    }}
                    disabled={busy || !dirty}
                  >
                    保存
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
