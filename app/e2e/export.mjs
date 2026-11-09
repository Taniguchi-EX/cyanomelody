// 「プレイリストの出力」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/export.mjs <テストデータ> <スクリーンショットの保存先>
import fs from "node:fs";
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("export.mjs");
const formats = path.join(dataDir, "formats");
const out = path.join(shotDir, "out");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const ui = await connect(shotDir);
const { page, step, shot, status, row, waitIdle, addFolder } = ui;

const editor = () => page.getByTestId("playlist-editor");
/** 編集画面を開いていれば閉じる */
async function closeEditor() {
  if ((await editor().count()) === 0) return;
  await editor().getByRole("button", { name: "閉じる", exact: true }).click();
  await editor().waitFor({ state: "detached", timeout: 3000 });
}
/** 左の欄の行のダブルクリックで、選んで編集画面を開く */
async function openPlaylist(name) {
  await closeEditor();
  await page.locator(`[data-testid=playlist][data-playlist-name="${name}"] .tag-name`).dblclick();
  await editor().waitFor({ timeout: 3000 });
}
async function addToPlaylist(rel, name) {
  await closeEditor();
  // プレイリストを選んでいれば外す（ライブラリの一覧から加える）
  const chip = page.getByTestId("playlist-filter");
  if ((await chip.count()) > 0) await ui.filtered(() => chip.click());
  await row(rel).click();
  await ui.addToPlaylistHere(name);
}
/** 書き出し先の欄を開いて書き出し始める。始めると欄は閉じる */
async function exportTo(dest) {
  // 前に始めた書き出しで欄が閉じるのを待ってから開く
  await page.getByLabel("書き出し先のフォルダ").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: "書出" }).click();
  await page.getByLabel("書き出し先のフォルダ").fill(dest);
  await page.getByRole("button", { name: "書き出しを始める" }).click();
}
const exportStatus = () => page.getByTestId("export-status").innerText();
async function waitExported() {
  await page.waitForFunction(() => document.querySelector("[data-testid=export-status]")?.textContent?.includes("書き出しました"), null, {
    timeout: 30000,
  });
}

await step("X01", "準備：別名とエフェクトを付けたプレイリスト（子のプレイリストを含む）を作る", async () => {
  await addFolder(formats);
  await page.getByRole("button", { name: "プレイリストを作る" }).click();
  await page.getByLabel("新しいプレイリストの名前").fill("TRPG: 第1話");
  await page.getByLabel("新しいプレイリストの名前").press("Enter");
  await waitIdle();
  await addToPlaylist("chime.wav", "TRPG: 第1話");
  // 子のプレイリストは、左の欄で作ってから行のドラッグで親の中に落とす
  await page.getByRole("button", { name: "プレイリストを作る" }).click();
  await page.getByLabel("新しいプレイリストの名前").fill("シーン1");
  await page.getByLabel("新しいプレイリストの名前").press("Enter");
  await waitIdle();
  const node = (name) => page.locator(`[data-testid=playlist][data-playlist-name="${name}"]`);
  await ui.dragTo(node("シーン1").locator(".tag-name, .credit-name").first(), node("TRPG: 第1話"), 0.5);
  await addToPlaylist("chime.mp3", "シーン1");
  // 子のプレイリストの項目の fx のプルダウンで「新しいfxを作る」を選び、エフェクトセットを作る（作るとその項目に付く）
  await openPlaylist("TRPG: 第1話");
  await page.getByLabel("シーン1のエフェクト").selectOption({ label: "新しいfxを作る" });
  // 保存していない新しいエフェクトセットが出るので、名前を変えて保存する
  await page.getByRole("dialog", { name: "エフェクトセットの管理" }).waitFor({ timeout: 3000 });
  await page.getByLabel("エフェクトセットの名前", { exact: true }).fill("小さく");
  await page.getByLabel("追加するエフェクト").selectOption("gain");
  await page.getByRole("button", { name: "追加", exact: true }).click();
  await page.getByLabel("1番目の増減").fill("-6");
  const effects = page.getByRole("dialog", { name: "エフェクトセットの管理" });
  await effects.getByRole("button", { name: "保存" }).click();
  await waitIdle();
  await effects.getByRole("button", { name: "閉じる" }).click();
  // 項目の行の「✎」で、プレイリスト上での名前を付ける
  await page.getByRole("button", { name: "chime.wavのプレイリスト上での名前を付ける" }).click();
  await page.getByLabel("chime.wavのプレイリスト上での名前", { exact: true }).fill("激しめの雨");
  await page.getByLabel("chime.wavのプレイリスト上での名前", { exact: true }).press("Enter");
  await waitIdle();
  expect((await page.getByLabel("シーン1のエフェクト").inputValue()) !== "", "作ったエフェクトセットが付いていない");
});

await step("X02", "書き出すと、階層がフォルダになり、別名と順番の数字が名前に付く。エフェクトのない曲はそのままコピー、ある曲はWAV", async () => {
  await exportTo(out);
  await waitExported();
  const root = path.join(out, "TRPG_ 第1話");
  const copied = path.join(root, "001_激しめの雨.wav");
  const rendered = path.join(root, "002_シーン1", "001_chime.wav");
  expect(fs.existsSync(copied), `ない: ${copied}`);
  expect(fs.readFileSync(copied).equals(fs.readFileSync(path.join(formats, "chime.wav"))), "コピーした内容が違う");
  expect(fs.existsSync(rendered), `ない: ${rendered}`);
  expect(fs.readFileSync(rendered).subarray(0, 4).toString() === "RIFF", "WAVでない");
  const s = await exportStatus();
  expect(s.includes("書き出しました（2件）") && s.includes(root), s);
  await shot("X02_書き出した後");
});

await step("X05", "書き出し先のフォルダがないときはエラーを出して始めない。書き出し先の欄には、前に書き出せたフォルダが入っている（書き出せなかったフォルダは覚えない）", async () => {
  await exportTo(path.join(out, "ない"));
  await ui.waitStatus("書き出し先のフォルダがありません").catch(() => {});
  expect((await status()).includes("書き出し先のフォルダがありません"), await status());
  expect(!fs.existsSync(path.join(out, "ない")), "フォルダを作った");
  // 編集画面を開き直す（開いている間は、入力した値がそのまま残る）。選んでいる行のダブルクリックでも選択は外れない
  const field = page.getByLabel("書き出し先のフォルダ");
  await openPlaylist("TRPG: 第1話");
  expect((await page.getByTestId("playlist-filter").count()) === 1, "ダブルクリックで選択が外れた");
  await page.getByRole("button", { name: "書出" }).click();
  const v = await field.inputValue();
  expect(v === out, v);
});

await step("X06", "書き出し終わると、書き出したフォルダがリンクで出る（押すとエクスプローラーで見せる）", async () => {
  const link = page.getByTestId("export-folder");
  const text = await link.innerText();
  expect(text === path.join(out, "TRPG_ 第1話"), text);
});

await step("X07", "中央の一覧に出ている曲だけを、見えている順に書き出す（タグで絞り込むと、その曲だけ）", async () => {
  await closeEditor();
  await row("chime.mp3").waitFor({ timeout: 3000 });
  // シーン1の chime.mp3 だけになるよう、ファイル名で絞り込む
  await ui.filtered(() => page.getByLabel("ファイル名で検索").fill("mp3"));
  expect((await ui.fileCount()) === 1, `${await ui.fileCount()}`);
  await openPlaylist("TRPG: 第1話");
  await exportTo(out);
  await page.waitForFunction(() => document.querySelector("[data-testid=export-status]")?.textContent?.includes("（1件）"), null, {
    timeout: 30000,
  });
  const root = path.join(out, "TRPG_ 第1話 (2)");
  expect(fs.existsSync(path.join(root, "001_シーン1", "001_chime.wav")), fs.readdirSync(root).join(","));
  expect(!fs.existsSync(path.join(root, "001_激しめの雨.wav")), "絞り込みで隠れた曲まで書き出した");
  await closeEditor();
});

await ui.finish();
