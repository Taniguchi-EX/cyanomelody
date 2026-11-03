// 「ファイルの一括操作」（チェックと、ドラッグでのまとめての操作）の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/bulk.mjs <テストデータ> <スクリーンショットの保存先>
import fs from "node:fs";
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("bulk.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, status, fileCount, row, tagItem, waitIdle, addFolder, clearFilter, addTag } = ui;

// 右の欄のパス（絶対パス）のファイル名
const detailPath = async () => path.win32.basename(await page.getByTestId("detail-path").innerText());
const isChecked = (rel) => row(rel).getByTestId("file-check").isChecked();
const filterText = async (text) => {
  await ui.filtered(() => page.getByLabel("検索", { exact: true }).fill(text));
};
const checkedOnly = () => page.getByLabel("チェックしたファイルだけ表示");
const checkToolbar = () => page.locator("main .toolbar");
async function scan() {
  await page.getByRole("button", { name: "スキャン", exact: true }).click();
  await waitIdle();
}

await step("B01", "準備：チェックの件数は0件でも下の行に常に出て、チェックの操作の行と一括操作の欄は出ない", async () => {
  await addFolder(formats);
  const c = await ui.checkedCount();
  expect(c === "チェック 0件（表示中 0件）", c);
  expect((await checkToolbar().count()) === 0, "チェックの操作の行が出ている");
  expect((await page.getByTestId("bulk-bar").count()) === 0, "一括操作の欄がある");
  expect((await page.getByLabel("表示中のファイルをすべてチェック").count()) === 0, "見出しのチェックボックスが残っている");
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

await step("B03", "チェックボックスを押しても右の欄は変わらない。チェックすると、全てチェック・チェックをすべて外す・チェックしたファイルだけ表示が出る", async () => {
  await row("chime.wav").click();
  await ui.check("chime.mp3");
  expect((await detailPath()) === "chime.wav", await detailPath());
  expect(await isChecked("chime.mp3"), "チェックされていない");
  const labels = (await checkToolbar().innerText()).replace(/\s+/g, " ").trim();
  expect(labels === "全てチェック チェックをすべて外す チェックしたファイルだけ表示", labels);
  expect((await page.getByTestId("bulk-bar").count()) === 0, "一括操作の欄が出ている");
  await shot("B03_チェックの操作");
});

await step("B04", "チェックは絞り込みの条件を変えても外れない（別のタグで絞り込んでも持ち越す）", async () => {
  await ui.filtered(() => tagItem("雨").click());
  await ui.check("chime.wav");
  await ui.filtered(() => tagItem("雨").click());
  await ui.filtered(() => tagItem("風").click());
  await ui.check("chime.flac");
  let c = await ui.checkedCount();
  expect(c === "チェック 3件（表示中 1件）", `風で絞り込み中 ${c}`);
  await ui.filtered(() => tagItem("風").click());
  c = await ui.checkedCount();
  expect(c === "チェック 3件（表示中 3件）", `解除後 ${c}`);
  expect((await isChecked("chime.wav")) && (await isChecked("chime.flac")) && (await isChecked("chime.mp3")), "外れた");
});

await step("B05", "「チェックしたファイルだけ表示」はほかの条件とAND。チェックをすべて外すと「チェックしたファイルだけ表示」も消える", async () => {
  await ui.filtered(() => checkedOnly().check());
  expect((await fileCount()) === 3, `チェックしたファイルだけ ${await fileCount()}`);
  await filterText("wav");
  expect((await fileCount()) === 1, `ファイル名とAND ${await fileCount()}`);
  await clearFilter();
  // チェックがなくなると「チェックしたファイルだけ表示」自体が消える
  expect((await checkedOnly().count()) === 0, "チェックしたファイルだけが残っている");
  expect((await fileCount()) === 5, `解除後 ${await fileCount()}`);
  expect((await ui.checkedCount()).startsWith("チェック 0件"), "チェックが外れない");
  // 検索の欄の右に「✕」（すべて解除）はない
  expect((await page.getByRole("button", { name: "すべて解除" }).count()) === 0, "すべて解除が残っている");
});

await step("B06", "「全てチェック」で表示中のファイルをすべてチェックする（すべてチェック済みなら押せない）。Ctrl+A でも同じ。「チェックをすべて外す」で外れる", async () => {
  await ui.check("chime.wav");
  await ui.check("chime.mp3");
  await ui.check("chime.flac");
  await filterText("chime.");
  const all = page.getByRole("button", { name: "全てチェック" });
  await all.click();
  const c = await ui.checkedCount();
  expect(c === "チェック 4件（表示中 4件）", `全てチェック ${c}`);
  expect(await all.isDisabled(), "すべてチェック済みなのに押せる");
  await ui.clearChecks();
  expect((await ui.checkedCount()) === "チェック 0件（表示中 0件）", await ui.checkedCount());
  await clearFilter();
  await page.getByTestId("file-list").click();
  await page.keyboard.press("Control+a");
  expect((await ui.checkedCount()) === "チェック 5件（表示中 5件）", await ui.checkedCount());
  await ui.clearChecks();
  expect((await ui.checkedCount()) === "チェック 0件（表示中 0件）", await ui.checkedCount());
  expect((await checkToolbar().count()) === 0, "チェックの操作の行が残る");
});

await step("B08", "表示していないファイルも含めて、チェックしたファイルすべてにドラッグで設定する（確認は出さない）。操作の後もチェックは残る", async () => {
  await page.getByRole("button", { name: "ライセンスを作る" }).click();
  await page.getByLabel("名前", { exact: true }).fill("規約A");
  await page.getByTestId("credit-form").getByRole("button", { name: "作成", exact: true }).click();
  await waitIdle();
  await ui.check("chime.wav");
  await ui.check("chime.flac");
  await ui.filtered(() => tagItem("雨").click());
  expect((await fileCount()) === 1, "絞り込めていない");
  await ui.dragChecked(page.locator("[data-testid=license][data-credit-name=規約A]"));
  expect((await status()).includes("2件にライセンス「規約A」を設定しました"), await status());
  // 絞り込みだけを外す（チェックは残す）
  await ui.filtered(() => tagItem("雨").click());
  const n = await page.getByTestId("license").filter({ hasText: "規約A" }).locator(".sub").innerText();
  expect(n === "2", `規約Aの件数 ${n}`);
  await shot("B08_ドラッグでライセンスを設定");
  expect((await ui.checkedCount()).startsWith("チェック 2件"), await ui.checkedCount());
});

await step("B10", "チェックしていない行をつかんだときは、その1件だけが対象になる（チェックはそのまま）", async () => {
  await ui.dragTo(row("chime.mp3").locator(".file-name"), tagItem("雨"), 0.5);
  expect((await status()).includes("1件にタグ「雨」を付けました"), await status());
  expect((await row("chime.mp3").locator(".chip").allInnerTexts()).includes("雨"), "付いていない");
  expect(!(await row("chime.flac").locator(".chip").allInnerTexts()).includes("雨"), "チェックした行にも付いた");
  expect((await ui.checkedCount()).startsWith("チェック 2件"), await ui.checkedCount());
});

await step("B11", "チェックしたファイルをライブラリから外すと、チェックからも外れる", async () => {
  fs.renameSync(path.join(formats, "chime.ogg"), path.join(dataDir, "chime.ogg.moved"));
  try {
    await scan();
    await ui.check("chime.ogg");
    expect((await ui.checkedCount()).startsWith("チェック 3件"), await ui.checkedCount());
    await row("chime.ogg").click();
    await page.getByTestId("detail-panel").getByRole("button", { name: "ライブラリから外す" }).click();
    await waitIdle();
    expect((await row("chime.ogg").count()) === 0, "外れていない");
    await page.waitForTimeout(500);
    const c = await ui.checkedCount();
    expect(c === "チェック 2件（表示中 2件）", c);
  } finally {
    fs.renameSync(path.join(dataDir, "chime.ogg.moved"), path.join(formats, "chime.ogg"));
  }
});


await ui.finish();
