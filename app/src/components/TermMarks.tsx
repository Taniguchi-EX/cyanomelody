import type { Terms } from "../api";
import { TERM_DEFS, shortTerm, termState } from "../credits";

type Props = {
  terms: Terms;
  /** true なら「商用可」のような短い言葉で、false なら記号で出す */
  words?: boolean;
};

/** ライセンスの条項を色分けして並べる（緑は使いやすい側、橙は制約、灰は不明） */
export function TermMarks({ terms, words = false }: Props) {
  const all = TERM_DEFS.map((d) => shortTerm(d, terms[d.key])).join(" ");
  return (
    <span className={words ? "term-marks words" : "term-marks"} title={words ? undefined : all} data-testid="term-marks">
      {TERM_DEFS.map((d, i) => (
        <span key={d.key}>
          {i > 0 && " "}
          <span className={`term-mark ${termState(d, terms[d.key])}`}>{words ? shortTerm(d, terms[d.key]) : d.icon}</span>
        </span>
      ))}
    </span>
  );
}
