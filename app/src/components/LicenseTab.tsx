import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SearchBox } from "./SearchBox";

const REPOSITORY = "https://github.com/Taniguchi-EX/cyanomelody";

/** ライセンスの一覧（scripts/licenses.mjs がビルドの前に作る） */
type LicenseData = {
  packages: {
    name: string;
    version: string;
    /** ライセンスの種類（SPDX の表記） */
    license: string;
    /** 配布元 */
    repository: string;
    kind: "rust" | "npm";
    /** ライセンスの文章（ファイル名と、texts の id） */
    texts: { file: string; id: string }[];
  }[];
  texts: Record<string, string>;
};

type Props = {
  onError: (e: unknown) => void;
};

/** 押すとブラウザで開くリンク */
function Link({ url, onError }: { url: string; onError: (e: unknown) => void }) {
  return (
    <a
      href={url}
      onClick={(e) => {
        e.preventDefault();
        openUrl(url).catch(onError);
      }}
    >
      {url}
    </a>
  );
}

/** バージョンとライセンス：アプリの版とライセンス、使っているライブラリのライセンス */
export function LicenseTab({ onError }: Props) {
  const [version, setVersion] = useState("");
  const [data, setData] = useState<LicenseData | null>(null);
  const [query, setQuery] = useState("");
  /** ライセンスの文章を開いているライブラリ（名前@版） */
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    getVersion().then(setVersion).catch(onError);
    // 一覧は大きいので、このタブを開いたときに読む
    import("../generated/licenses.json")
      .then((m) => setData(m.default as LicenseData))
      .catch(onError);
  }, [onError]);
  const q = query.trim().toLowerCase();
  const shown = data?.packages.filter((p) => !q || p.name.toLowerCase().includes(q)) ?? [];
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <section>
      <h3>
        cyanomelody <span data-testid="app-version">v{version}</span>
      </h3>
      <p>
        ライセンス：MIT License
        <br />
        <Link url={REPOSITORY} onError={onError} />
      </p>
      <h3>使っているライブラリ{data && `（${data.packages.length}件）`}</h3>
      <p className="sub">
        このアプリに組み込んでいるライブラリと、そのライセンスです。名前を押すと、ライセンスの文章を出します。
      </p>
      <SearchBox value={query} onChange={setQuery} label="ライブラリ名で検索" testId="license-search" />
      <ul className="license-list" data-testid="license-list">
        {shown.map((p) => {
          const key = `${p.name}@${p.version}`;
          const isOpen = open.has(key);
          return (
            <li key={key} data-testid="license-item" data-name={p.name}>
              <button className="license-head" onClick={() => toggle(key)} aria-expanded={isOpen}>
                <span className="license-name">
                  {isOpen ? "▾" : "▸"} {p.name} <span className="sub">{p.version}</span>
                </span>
                <span className="sub license-kind">{p.license}</span>
              </button>
              {isOpen && data && (
                <div className="license-body">
                  <p>
                    配布元：
                    <Link url={p.repository} onError={onError} />
                    {/* MPL-2.0 は、ソースコードの入手先を示す（改変はしていない） */}
                    {p.license.includes("MPL") && (
                      <>
                        <br />
                        <span data-testid="mpl-note">このライブラリのソースコードは、上の配布元から入手できます（改変していません）。</span>
                      </>
                    )}
                  </p>
                  {p.texts.length === 0 && <p className="sub">ライセンスの文章が見つかりませんでした。</p>}
                  {p.texts.map((t) => (
                    <div key={t.file}>
                      <div className="sub">{t.file}</div>
                      <pre className="license-text">{data.texts[t.id]}</pre>
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
