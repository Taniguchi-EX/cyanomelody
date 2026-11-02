// 「絞り込み条件のグレーアウト」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/facets.mjs <テストデータ> <スクリーンショットの保存先>
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("facets.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, fileCount, row, tagItem, waitIdle, addFolder, clearFilter, addTag } = ui;

const sourceItem = (name) => page.locator(`[data-testid=source][data-credit-name="${name}"]`);
const countOf = async (item) => parseInt(await item.locator(".sub").innerText(), 10);
const disabled = async (item) => (await item.getAttribute("aria-disabled")) === "true";
/** 名前ごとの「件数（グレーアウトなら g）」を並べた文字列 */
async function tagState() {
  const parts = [];
  for (const name of ["環境音", "雨", "風", "鳥", "爆発"]) {
    const item = tagItem(name);
    parts.push(`${name}${await countOf(item)}${(await disabled(item)) ? "g" : ""}`);
  }
  const u = page.getByTestId("untagged");
  parts.push(`なし${await countOf(u)}${(await disabled(u)) ? "g" : ""}`);
  return parts.join(" ");
}
async function setCredit(rel, name) {
  await row(rel).click();
  await page.getByLabel("設定する出典の名前").fill(name);
  await page.getByTestId("credit-field-source").getByRole("button", { name: "設定" }).click();
  await waitIdle();
}

await step("F01", "準備。条件がないときは総数を出し、どのファイルにも付いていないタグはグレーアウトする", async () => {
  await addFolder(formats);
  // 環境音 > 雨・風、鳥、爆発（どのファイルにも付けない）
  await ui.createTags(["環境音", "雨", "風", "鳥", "爆発"]);
  for (const [file, tags] of [["chime.wav", ["雨"]], ["chime.mp3", ["雨", "風"]], ["chime.flac", ["風", "鳥"]]]) {
    await row(file).click();
    for (const t of tags) await addTag(t);
  }
  for (const n of ["雨", "風"]) await ui.dragTo(tagItem(n).getByTestId("drag-handle"), tagItem("環境音"), 0.5);
  await setCredit("chime.wav", "s1");
  await setCredit("chime.mp3", "s2");
  const s = await tagState();
  expect(s === "環境音3 雨2 風2 鳥1 爆発0g なし2", s);
  await shot("F01_条件なし");
});

await step("F02", "タグで絞り込むと、各タグの件数は「その結果のうち、そのタグが付いた数」になり、0件はグレーアウト", async () => {
  await tagItem("雨").click();
  await page.waitForTimeout(500);
  const s = await tagState();
  // 「なし」はタグの条件を外して数える（選ぶとタグの選択が外れるため）
  expect(s === "環境音2 雨2 風1 鳥0g 爆発0g なし2", s);
  await shot("F02_雨で絞り込み");
});

await step("F03", "グレーアウトした項目は押しても選べない", async () => {
  await tagItem("鳥").click();
  await page.waitForTimeout(400);
  expect(!(await tagItem("鳥").getAttribute("class")).includes("active"), "選ばれた");
  expect((await fileCount()) === 2, `件数 ${await fileCount()}`);
});

await step("F04", "条件を足していくと件数が変わる（タグはAND）", async () => {
  await tagItem("風").click();
  await page.waitForTimeout(500);
  expect((await fileCount()) === 1, `件数 ${await fileCount()}`);
  const s = await tagState();
  expect(s === "環境音1 雨1 風1 鳥0g 爆発0g なし2", s);
  await clearFilter();
});

await step("F05", "選んでいる項目は、0件になってもグレーアウトせず、押して選択を外せる", async () => {
  await tagItem("雨").click();
  await page.getByLabel("ファイル名で絞り込む").fill("flac");
  await page.waitForTimeout(600);
  expect((await fileCount()) === 0, `件数 ${await fileCount()}`);
  expect((await countOf(tagItem("雨"))) === 0, "雨の件数");
  expect(!(await disabled(tagItem("雨"))), "選んでいる項目がグレーアウトした");
  await tagItem("雨").click();
  await page.waitForTimeout(500);
  expect((await fileCount()) === 1, `選択を外した後 ${await fileCount()}`);
  await clearFilter();
});

await step("F06", "出典どうしはORなので、出典を選んでも別の出典は数え、タグの条件では0件の出典がグレーアウトする", async () => {
  await sourceItem("s1").click();
  await page.waitForTimeout(500);
  expect((await countOf(sourceItem("s2"))) === 1 && !(await disabled(sourceItem("s2"))), "s2");
  await clearFilter();
  await tagItem("風").click();
  await page.waitForTimeout(500);
  expect((await countOf(sourceItem("s1"))) === 0 && (await disabled(sourceItem("s1"))), "s1がグレーアウトしない");
  expect((await countOf(sourceItem("s2"))) === 1, "s2の件数");
  const none = page.getByTestId("source-none");
  expect((await countOf(none)) === 1 && !(await disabled(none)), "（出典なし）");
  await shot("F06_出典");
  await clearFilter();
});

await step("F07", "「チェックしたファイルだけ」やファイル名の条件も件数に入る", async () => {
  await ui.check("chime.ogg");
  await page.getByLabel("チェックしたファイルだけ").check();
  await page.waitForTimeout(500);
  let s = await tagState();
  expect(s === "環境音0g 雨0g 風0g 鳥0g 爆発0g なし1", `チェックしたファイルだけ ${s}`);
  await clearFilter();
  await ui.clearChecks();
  await page.getByLabel("ファイル名で絞り込む").fill("chime.w");
  await page.waitForTimeout(600);
  s = await tagState();
  expect(s === "環境音1 雨1 風0g 鳥0g 爆発0g なし0g", `ファイル名 ${s}`);
  await clearFilter();
});

await step("F08", "タグを付けるなどデータが変わると、件数を求め直す", async () => {
  await row("chime.ogg").click();
  await addTag("爆発");
  const s = await tagState();
  expect(s === "環境音3 雨2 風2 鳥1 爆発1 なし1", s);
});

await step("F09", "グレーアウトしていても、取っ手で並べ替えはできる", async () => {
  await tagItem("雨").click();
  await page.waitForTimeout(500);
  expect(await disabled(tagItem("爆発")), "爆発がグレーアウトしていない");
  await ui.dragTo(tagItem("爆発").getByTestId("drag-handle"), tagItem("環境音"), 0.1);
  const names = await ui.tagNames();
  expect(names[0] === "爆発", names.join(","));
  await clearFilter();
});

await ui.finish();
