// 「ファイルの一括操作」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/bulk.mjs <テストデータ> <スクリーンショットの保存先>
import fs from "node:fs";
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("bulk.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, status, fileCount, row, tagItem, tagNames, waitIdle, addFolder, clearFilter, addTag } = ui;

const detailPath = () => page.getByTestId("detail-path").innerText();
const isChecked = (rel) => row(rel).getByTestId("file-check").isChecked();
const filterText = async (text) => {
  await page.getByLabel("ファイル名で絞り込む").fill(text);
  await page.waitForTimeout(500);
};
const checkedOnly = () => page.getByLabel("チェックしたファイルだけ");
async function scan() {
  await page.getByRole("button", { name: "スキャン", exact: true }).click();
  await waitIdle();
}

await step("B01", "準備：チェックの件数は0件でも常に出て、一括操作の欄は出ない", async () => {
  await addFolder(formats);
  const c = await ui.checkedCount();
  expect(c === "チェック 0件（表示中 0件）", c);
  expect((await page.getByTestId("bulk-bar").count()) === 0, "一括操作の欄が出ている");
  await row("chime.wav").click();
  await addTag("雨");
  await row("chime.flac").click();
  await addTag("風");
});

await step("B02", "行のクリックは1件の詳細の表示だけ（Ctrl・Shiftを押しても複数選択にならない）", async () => {
  await row("chime.wav").click();
  expect((await detailPath()) === "chime.wav", await detailPath());
  await row("chime.mp3").click({ modifiers: ["Control"] });
  expect((await detailPath()) === "chime.mp3", await detailPath());
  await row("chime.ogg").click({ modifiers: ["Shift"] });
  expect((await detailPath()) === "chime.ogg", await detailPath());
  expect((await page.locator(".file-row.selected").count()) === 1, "複数の行が選ばれている");
  expect((await ui.checkedCount()).startsWith("チェック 0件"), "チェックが付いた");
});

await step("B03", "チェックボックスを押しても右の欄は変わらない。チェックすると一括操作の欄が出る", async () => {
  await row("chime.wav").click();
  await ui.check("chime.mp3");
  expect((await detailPath()) === "chime.wav", await detailPath());
  expect(await isChecked("chime.mp3"), "チェックされていない");
  expect((await page.getByTestId("bulk-bar").innerText()).includes("チェックした1件をまとめて"), "一括操作の欄");
  await shot("B03_チェックと一括操作の欄");
});

await step("B04", "チェックは絞り込みの条件を変えても外れない（別のタグで絞り込んでも持ち越す）", async () => {
  await tagItem("雨").click();
  await page.waitForTimeout(400);
  await ui.check("chime.wav");
  await tagItem("雨").click();
  await tagItem("風").click();
  await page.waitForTimeout(400);
  await ui.check("chime.flac");
  let c = await ui.checkedCount();
  expect(c === "チェック 3件（表示中 1件）", `風で絞り込み中 ${c}`);
  await tagItem("風").click();
  await page.waitForTimeout(400);
  c = await ui.checkedCount();
  expect(c === "チェック 3件（表示中 3件）", `解除後 ${c}`);
  expect((await isChecked("chime.wav")) && (await isChecked("chime.flac")) && (await isChecked("chime.mp3")), "外れた");
});

await step("B05", "「チェックしたファイルだけ」はほかの条件とANDで、「✕」（すべて解除）で絞り込みもチェックも右の欄の表示も外れる", async () => {
  await checkedOnly().check();
  await page.waitForTimeout(400);
  expect((await fileCount()) === 3, `チェックしたファイルだけ ${await fileCount()}`);
  await filterText("wav");
  expect((await fileCount()) === 1, `ファイル名とAND ${await fileCount()}`);
  await row("chime.wav").click();
  await clearFilter();
  expect(!(await checkedOnly().isChecked()), "チェックしたファイルだけが外れない");
  expect((await fileCount()) === 5, `解除後 ${await fileCount()}`);
  expect((await ui.checkedCount()).startsWith("チェック 0件"), "チェックが外れない");
  expect((await page.getByTestId("detail-panel").count()) === 0, "右の欄の表示が残る");
  expect((await page.getByRole("button", { name: "すべて解除" }).count()) === 0, "解除するものがないのにボタンが出ている");
});

await step("B06", "見出しのチェックボックスで、表示中のファイルをすべてチェック・すべて外す", async () => {
  await ui.check("chime.wav");
  await ui.check("chime.mp3");
  await ui.check("chime.flac");
  await filterText("chime.");
  const head = page.getByLabel("表示中のファイルをすべてチェック");
  expect(await head.evaluate((el) => el.indeterminate), "一部チェックの表示になっていない");
  await head.click();
  let c = await ui.checkedCount();
  expect(c === "チェック 4件（表示中 4件）", `すべてチェック ${c}`);
  await head.click();
  c = await ui.checkedCount();
  expect(c === "チェック 0件（表示中 0件）", `すべて外す ${c}`);
  await clearFilter();
});

await step("B07", "Ctrl+Aで表示中をすべてチェックし、「チェックをすべて外す」で外れる", async () => {
  await page.getByTestId("file-list").click();
  await page.keyboard.press("Control+a");
  expect((await ui.checkedCount()) === "チェック 5件（表示中 5件）", await ui.checkedCount());
  await ui.clearChecks();
  expect((await ui.checkedCount()) === "チェック 0件（表示中 0件）", await ui.checkedCount());
  expect((await page.getByTestId("bulk-bar").count()) === 0, "一括操作の欄が残る");
});

await step("B08", "表示していないファイルも含めて、チェックしたファイルすべてに一括で設定する（件数を確認する）", async () => {
  await ui.check("chime.wav");
  await ui.check("chime.flac");
  await tagItem("雨").click();
  await page.waitForTimeout(400);
  expect((await fileCount()) === 1, "絞り込めていない");
  await ui.bulkMode("ライセンス");
  await page.getByLabel("まとめて設定するライセンスの名前").fill("規約A");
  await page.getByTestId("bulk-credit-field-license").getByRole("button", { name: "設定" }).click();
  await waitIdle();
  const confirm = await ui.lastConfirm();
  expect(confirm === "チェックした2件にライセンス「規約A」を設定しますか？", confirm);
  // 絞り込みだけを外す（「すべて解除」だとチェックも外れる）
  await tagItem("雨").click();
  await page.waitForTimeout(400);
  const n = await page.getByTestId("license").filter({ hasText: "規約A" }).locator(".sub").innerText();
  expect(n === "2", `規約Aの件数 ${n}`);
  await shot("B08_一括でライセンスを設定");
});

await step("B09", "操作の後もチェックは残り、一括操作の欄に内訳が出る", async () => {
  expect((await ui.checkedCount()).startsWith("チェック 2件"), await ui.checkedCount());
  await ui.bulkMode("タグを外す");
  const tags = await page.getByTestId("bulk-tag").evaluateAll((els) => els.map((e) => e.textContent));
  expect(tags.join(",") === "雨 1/2外す,風 1/2外す", tags.join(","));
});

await step("B10", "確認で「キャンセル」を選ぶと、一括操作は行われない", async () => {
  await ui.setConfirmReply(false);
  await ui.bulkAddTag("キャンセルしたタグ");
  await ui.setConfirmReply(true);
  expect(!(await tagNames()).includes("キャンセルしたタグ"), "タグが作られた");
});

await step("B11", "見つからないファイルをチェックすると、一括でライブラリから外せる。外したファイルはチェックからも外れる", async () => {
  fs.renameSync(path.join(formats, "chime.ogg"), path.join(dataDir, "chime.ogg.moved"));
  try {
    await scan();
    await ui.check("chime.ogg");
    // 内訳は非同期で求めるので、表示されるのを待つ
    await page.getByTestId("bulk-bar").getByText("見つからない 1件").waitFor({ timeout: 5000 });
    const bar = await page.getByTestId("bulk-bar").innerText();
    expect(bar.includes("見つからない 1件"), bar);
    await page.getByTestId("bulk-bar").getByRole("button", { name: "ライブラリから外す" }).click();
    await waitIdle();
    const confirm = await ui.lastConfirm();
    expect(confirm.includes("見つからないファイル1件をライブラリから外しますか"), confirm);
    expect((await row("chime.ogg").count()) === 0, "外れていない");
    const c = await ui.checkedCount();
    expect(c === "チェック 2件（表示中 2件）", c);
  } finally {
    fs.renameSync(path.join(dataDir, "chime.ogg.moved"), path.join(formats, "chime.ogg"));
  }
});

await step("B12", "移動したファイルを、一括操作の欄からひも付け直せる", async () => {
  await scan();
  await ui.waitHashing();
  fs.renameSync(path.join(formats, "chime.mp3"), path.join(formats, "chime_moved.mp3"));
  try {
    await scan();
    await ui.waitHashing();
    await ui.clearChecks();
    await ui.check("chime.mp3");
    await page.getByTestId("bulk-bar").getByRole("button", { name: "ひも付け直す" }).click();
    await waitIdle();
    const s = await status();
    expect(s.includes("ひも付け直した 1件"), s);
    expect((await row("chime.mp3").count()) === 0, "元の記録が残っている");
    expect((await ui.checkedCount()).startsWith("チェック 0件"), "チェックが残っている");
  } finally {
    fs.renameSync(path.join(formats, "chime_moved.mp3"), path.join(formats, "chime.mp3"));
  }
});

await ui.finish();
