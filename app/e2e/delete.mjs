// 「ファイルの削除」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/delete.mjs <テストデータ> <スクリーンショットの保存先>
// run.sh が環境変数 CYANOMELODY_TRASH_DIR に <保存先>/trash を渡すので、アプリはごみ箱の代わりにそこへ移す。
// 名前が「_notrash」で終わるファイルは、ごみ箱に移せないことになる（完全に消すかの確認を試す）。
import fs from "node:fs";
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("delete.mjs");
const trash = path.join(shotDir, "trash");
// 削除するファイルは、毎回テストデータの音声から作り直す
const folder = path.join(dataDir, "deletes");
fs.rmSync(folder, { recursive: true, force: true });
fs.mkdirSync(folder, { recursive: true });
for (const [from, to] of [
  ["chime.wav", "d1.wav"],
  ["chime.mp3", "d2.mp3"],
  ["chime.flac", "d3.flac"],
  ["chime.wav", "d4_notrash.wav"],
]) {
  fs.copyFileSync(path.join(dataDir, "formats", from), path.join(folder, to));
}

const ui = await connect(shotDir);
const { page, step, shot, status, row, waitIdle } = ui;

const dialog = () => page.getByTestId("delete-dialog");
const files = () => dialog().getByTestId("delete-files").locator("li").allInnerTexts();
const exists = (name) => fs.existsSync(path.join(folder, name));
const inTrash = (name) => fs.existsSync(path.join(trash, name));

await step("D01", "ファイルの詳細の「ファイルを削除する」：確認のダイアログ（最初は「やめる」）を出し、ごみ箱に移してライブラリから外す。やめると何もしない", async () => {
  await ui.addFolder(folder);
  await row("d1.wav").click();
  await page.getByTestId("detail-panel").getByRole("button", { name: "ファイルを削除する" }).click();
  await dialog().waitFor({ timeout: 3000 });
  expect((await files()).join(",") === "d1.wav", (await files()).join(","));
  expect((await dialog().innerText()).includes("1件のファイルをごみ箱に移し、ライブラリから外します"), await dialog().innerText());
  // 最初は「やめる」を選んでいる（Enter で消さない）
  expect((await page.evaluate(() => document.activeElement?.textContent)) === "やめる", "やめるが選ばれていない");
  await shot("D01_確認のダイアログ");
  await page.keyboard.press("Enter");
  await dialog().waitFor({ state: "detached", timeout: 3000 });
  expect(exists("d1.wav") && (await row("d1.wav").count()) === 1, "やめたのに消えた");
  await page.getByTestId("detail-panel").getByRole("button", { name: "ファイルを削除する" }).click();
  await dialog().getByRole("button", { name: "削除する", exact: true }).click();
  await waitIdle();
  expect((await status()) === "1件を削除しました（ごみ箱に移しました）", await status());
  expect(!exists("d1.wav") && inTrash("d1.wav"), "ごみ箱に移っていない");
  expect((await row("d1.wav").count()) === 0, "一覧に残っている");
});

await step("D02", "一括操作の欄の「ファイルを削除する」：まとめてごみ箱に移す。移せなかったファイルだけ、完全に削除するかを聞き、やめると残す", async () => {
  for (const rel of ["d2.mp3", "d3.flac", "d4_notrash.wav"]) await ui.check(rel);
  await page.getByRole("button", { name: "一括操作" }).click();
  await page.getByTestId("bulk-panel").getByRole("button", { name: "ファイルを削除する" }).click();
  await dialog().waitFor({ timeout: 3000 });
  expect((await files()).join(",") === "d2.mp3,d3.flac,d4_notrash.wav", (await files()).join(","));
  await dialog().getByRole("button", { name: "削除する", exact: true }).click();
  await waitIdle();
  expect((await status()) === "2件を削除しました（ごみ箱に移しました）。1件は削除できませんでした", await status());
  expect(inTrash("d2.mp3") && inTrash("d3.flac") && exists("d4_notrash.wav"), "移ったファイルが違う");
  // ごみ箱に移せなかったファイルだけ、完全に削除するかを聞く（理由も出す）
  await dialog().waitFor({ timeout: 3000 });
  expect((await dialog().innerText()).includes("ごみ箱に移せませんでした。完全に削除しますか？"), await dialog().innerText());
  expect((await files())[0].startsWith("d4_notrash.wav（画面テスト用"), (await files()).join(","));
  expect((await page.evaluate(() => document.activeElement?.textContent)) === "やめる", "やめるが選ばれていない");
  await shot("D02_完全に削除するかの確認");
  await dialog().getByRole("button", { name: "やめる" }).click();
  expect((await status()) === "1件は削除していません", await status());
  expect(exists("d4_notrash.wav") && (await row("d4_notrash.wav").count()) === 1, "やめたのに消えた");
});

await step("D03", "ごみ箱に移せなかったファイルは、確認してから完全に削除できる（ごみ箱にも残らない）", async () => {
  await row("d4_notrash.wav").click();
  await page.getByTestId("detail-panel").getByRole("button", { name: "ファイルを削除する" }).click();
  await dialog().getByRole("button", { name: "削除する", exact: true }).click();
  await dialog().getByRole("button", { name: "完全に削除する" }).waitFor({ timeout: 5000 });
  await dialog().getByRole("button", { name: "完全に削除する" }).click();
  await waitIdle();
  expect((await status()) === "1件を完全に削除しました", await status());
  expect(!exists("d4_notrash.wav") && !inTrash("d4_notrash.wav"), "完全に消えていない");
  expect((await row("d4_notrash.wav").count()) === 0, "一覧に残っている");
  fs.rmSync(folder, { recursive: true, force: true });
});

await ui.finish();
