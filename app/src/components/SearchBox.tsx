type Props = {
  value: string;
  onChange: (value: string) => void;
  /** 入力欄の見出し（aria-label）と、空のときに出す文字 */
  label: string;
  placeholder?: string;
  testId?: string;
};

/** 検索欄。文字があるときは、中の右端に「×」（押すと文字を消す）を出す */
export function SearchBox({ value, onChange, label, placeholder = label, testId }: Props) {
  return (
    <span className="search-box" data-testid={testId}>
      <input type="text" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} />
      {value && (
        <button className="search-clear" onClick={() => onChange("")} title="検索の文字を消す" aria-label={`${label}の文字を消す`}>
          ×
        </button>
      )}
    </span>
  );
}
