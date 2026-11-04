// アプリに組み込むライブラリのライセンスの一覧を作る（設定画面の「バージョンとライセンス」で出す）。
//   node scripts/licenses.mjs
// npm run build / npm run dev の前に自動で実行する。出力：src/generated/licenses.json（Git の管理外）
// - Rust：cargo metadata で、Windows 向けのビルドで使うライブラリ（ビルドの道具・開発用を除く）をたどる
// - JavaScript：npm ls --omit=dev で、配布に入るライブラリをたどる
// 各ライブラリのフォルダにある LICENSE・COPYING・NOTICE などのファイルを読み、同じ文章は1つにまとめる。
// ライセンスのファイルを入れずに配布されているライブラリ（symphonia など）は、ライセンスの種類の標準の文章
// （scripts/license-templates/。MIT・BSD は著作権の行に、そのライブラリの作者を入れる）を使う。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(appDir, "src", "generated", "licenses.json");
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense|authors)([-._].*)?$/i;
// 大きすぎるファイル（ライセンスでないものの取り違え）は読まない
const MAX_TEXT = 200_000;

const texts = new Map();
/** 文章を一覧に加え、その id を返す（同じ文章は1つにまとめる） */
function addText(text) {
  const id = createHash("sha256").update(text).digest("hex").slice(0, 16);
  texts.set(id, text);
  return id;
}

const templateDir = path.join(appDir, "scripts", "license-templates");
/**
 * ライセンスのファイルがないライブラリの、標準の文章。ライセンスの表記（「MIT OR Apache-2.0」など）の中で、
 * ひな形のあるものを使う。authors は著作権の行に入れる作者
 */
function templateTexts(license, name, authors) {
  const ids = license.split(/\s+(?:OR|AND)\s+|[()/]/).map((s) => s.trim()).filter(Boolean);
  const found = ids.find((id) => fs.existsSync(path.join(templateDir, `${id}.txt`)));
  if (!found) return [];
  const holder = authors.length ? authors.map((a) => a.replace(/\s*<[^>]*>/, "")).join(", ") : `The ${name} authors`;
  const text = fs
    .readFileSync(path.join(templateDir, `${found}.txt`), "utf8")
    .replace(/\r\n/g, "\n")
    .replace("{copyright}", `Copyright (c) ${holder}`)
    .trim();
  return [{ file: `${found}（標準の文章）`, id: addText(text) }];
}

/** フォルダにあるライセンスのファイルを読み、同じ文章は1つにまとめて、その id を返す */
function licenseTexts(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => LICENSE_FILE.test(n) && fs.statSync(path.join(dir, n)).isFile());
  } catch {
    return [];
  }
  return names.sort().flatMap((file) => {
    const text = fs.readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n").trim();
    if (!text || text.length > MAX_TEXT) return [];
    return [{ file, id: addText(text) }];
  });
}

const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: appDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: process.platform === "win32" });

/** Rust：Windows 向けのビルドで、通常の依存（ビルドの道具・開発用でないもの）としてたどれるライブラリ */
function rustPackages() {
  const meta = JSON.parse(
    run("cargo", [
      "metadata",
      "--format-version",
      "1",
      "--filter-platform",
      "x86_64-pc-windows-msvc",
      "--manifest-path",
      path.join("src-tauri", "Cargo.toml"),
    ]),
  );
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const packages = new Map(meta.packages.map((p) => [p.id, p]));
  const seen = new Set();
  const stack = [meta.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) {
      if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg);
    }
  }
  seen.delete(meta.resolve.root);
  return [...seen].map((id) => {
    const p = packages.get(id);
    const license = p.license ?? (p.license_file ? "ライセンスのファイルを参照" : "不明");
    const found = licenseTexts(path.dirname(p.manifest_path));
    return {
      name: p.name,
      version: p.version,
      license,
      repository: p.repository ?? p.homepage ?? `https://crates.io/crates/${p.name}`,
      kind: "rust",
      texts: found.length ? found : templateTexts(license, p.name, p.authors ?? []),
    };
  });
}

/** JavaScript：配布に入るライブラリ（開発用を除く） */
function npmPackages() {
  const dirs = run("npm", ["ls", "--omit=dev", "--all", "--parseable"])
    .split(/\r?\n/)
    .filter((d) => d && path.resolve(d) !== appDir);
  return [...new Set(dirs)].map((dir) => {
    const p = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const repo = typeof p.repository === "string" ? p.repository : p.repository?.url;
    const license = typeof p.license === "string" ? p.license : (p.license?.type ?? "不明");
    const found = licenseTexts(dir);
    const author = typeof p.author === "string" ? p.author : p.author?.name;
    return {
      name: p.name,
      version: p.version,
      license,
      repository: (repo ?? `https://www.npmjs.com/package/${p.name}`).replace(/^git\+/, "").replace(/\.git$/, ""),
      kind: "npm",
      texts: found.length ? found : templateTexts(license, p.name, author ? [author] : []),
    };
  });
}

const packages = [...rustPackages(), ...npmPackages()].sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }),
);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ packages, texts: Object.fromEntries(texts) }));
const missing = packages.filter((p) => p.texts.length === 0).map((p) => p.name);
console.log(
  `ライセンスの一覧：${packages.length}件（文章 ${texts.size}種類、${Math.round(fs.statSync(out).size / 1024)}KB）` +
    (missing.length ? `。ライセンスのファイルがないもの：${missing.join(", ")}` : ""),
);
