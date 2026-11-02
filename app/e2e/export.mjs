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

const openPlaylist = (name) => page.locator(`[data-testid=playlist][data-playlist-name="${name}"] .tag-name`).click();
async function addToPlaylist(rel, name) {
  await page.getByRole("button", { name: "ファイルの一覧に戻る" }).click().catch(() => {});
  await row(rel).click();
  await page.getByLabel("このファイルを加えるプレイリスト").selectOption({ label: name });
  await page.getByTestId("detail-panel").getByRole("button", { name: "追加", exact: true }).click();
  await waitIdle();
}
/** 書き出し先の欄を開いて書き出し始める。始めると欄は閉じる */
async function exportTo(dest) {
  // 前に始めた書き出しで欄が閉じるのを待ってから開く
  await page.getByLabel("書き出し先のフォルダ").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: "書き出す" }).click();
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
  await page.getByRole("button", { name: "作る", exact: true }).click();
  await waitIdle();
  await addToPlaylist("chime.wav", "TRPG: 第1話");
  await openPlaylist("TRPG: 第1話");
  await page.getByLabel("子のプレイリストの名前").fill("シーン1");
  await page.getByLabel("子のプレイリストの名前").press("Enter");
  await waitIdle();
  await addToPlaylist("chime.mp3", "シーン1");
  // エフェクトのまとまりを作って、子のプレイリストの項目に結び付ける
  await page.getByRole("button", { name: "エフェクトのまとまりを管理" }).click();
  await page.getByLabel("新しいエフェクトのまとまりの名前").fill("小さく");
  await page.getByLabel("新しいエフェクトのまとまりの名前").press("Enter");
  await waitIdle();
  await page.getByLabel("加えるエフェクト").selectOption("gain");
  await page.getByRole("button", { name: "加える", exact: true }).click();
  await page.getByLabel("1番目の増減").fill("-6");
  await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  await waitIdle();
  await page.getByRole("dialog").getByRole("button", { name: "閉じる" }).click();
  await openPlaylist("TRPG: 第1話");
  await page.getByRole("button", { name: "chime.wavの別名を付ける" }).click();
  await page.getByLabel("chime.wavの別名", { exact: true }).fill("激しめの雨");
  await page.getByLabel("chime.wavの別名", { exact: true }).press("Enter");
  await waitIdle();
  await page.getByLabel("シーン1のエフェクト").selectOption({ label: "小さく" });
  await waitIdle();
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

await step("X03", "同じ場所にもう一度書き出すと、上書きせずに別のフォルダを作る", async () => {
  await exportTo(out);
  await waitExported();
  expect(fs.existsSync(path.join(out, "TRPG_ 第1話 (2)", "001_激しめの雨.wav")), "別のフォルダにない");
});

await step("X04", "書き出し先のフォルダがないときは、エラーを出して始めない", async () => {
  await exportTo(path.join(out, "ない"));
  await page.waitForTimeout(500);
  expect((await status()).includes("書き出し先のフォルダがありません"), await status());
  expect(!fs.existsSync(path.join(out, "ない")), "フォルダを作った");
});

await step("X05", "書き出し先の欄には、前に書き出したフォルダが入っている（書き出せなかったフォルダは覚えない）", async () => {
  // 編集画面を開き直す（開いている間は、入力した値がそのまま残る）
  const field = page.getByLabel("書き出し先のフォルダ");
  await page.getByRole("button", { name: "ファイルの一覧に戻る" }).click();
  await page.locator("[data-testid=playlist][data-playlist-name^=TRPG] .tag-name").first().click();
  await page.getByRole("button", { name: "書き出す" }).click();
  const v = await field.inputValue();
  expect(v === out, v);
});

await step("X06", "書き出し終わると、書き出したフォルダがリンクで出る（押すとエクスプローラーで見せる）", async () => {
  const link = page.getByTestId("export-folder");
  const text = await link.innerText();
  expect(text === path.join(out, "TRPG_ 第1話 (2)"), text);
});

await ui.finish();
