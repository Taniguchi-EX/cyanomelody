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
const disabled = async (item) => (await item.getAttribute("class")).split(" ").includes("disabled");
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
  // 出典を作るのは左の欄の「＋」で行う
  if (!(await sourceItem(name).count())) {
    await page.getByRole("button", { name: "出典を作る" }).click();
    await page.getByLabel("名前", { exact: true }).fill(name);
    await page.getByTestId("credit-form").getByRole("button", { name: "作成", exact: true }).click();
    await waitIdle();
  }
  await row(rel).click();
  await page.getByLabel("出典を選ぶ").selectOption({ label: name });
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

await step("F03", "絞り込むと0件になる項目はグレーアウトし、押しても選べない", async () => {
  await ui.filtered(() => tagItem("雨").click());
  expect(await disabled(tagItem("鳥")), "鳥がグレーアウトしない");
  await tagItem("鳥").click();
  await page.waitForTimeout(400);
  expect(!(await tagItem("鳥").getAttribute("class")).includes("active"), "選ばれた");
  expect((await fileCount()) === 2, `件数 ${await fileCount()}`);
  await clearFilter();
});

await step("F05", "選んでいる項目は、0件になってもグレーアウトせず、押して選択を外せる", async () => {
  await ui.filtered(() => tagItem("雨").click());
  await ui.filtered(() => page.getByLabel("ファイル名で検索", { exact: true }).fill("flac"));
  expect((await fileCount()) === 0, `件数 ${await fileCount()}`);
  expect((await countOf(tagItem("雨"))) === 0, "雨の件数");
  expect(!(await disabled(tagItem("雨"))), "選んでいる項目がグレーアウトした");
  await ui.filtered(() => tagItem("雨").click());
  expect((await fileCount()) === 1, `選択を外した後 ${await fileCount()}`);
  await clearFilter();
});

await step("F08", "タグを付けるなどデータが変わると、件数を求め直す", async () => {
  await row("chime.ogg").click();
  await addTag("爆発");
  const s = await tagState();
  expect(s === "環境音3 雨2 風2 鳥1 爆発1 なし1", s);
});

await step("F09", "グレーアウトしていても、取っ手で並べ替えはできる", async () => {
  await ui.filtered(() => tagItem("雨").click());
  expect(await disabled(tagItem("爆発")), "爆発がグレーアウトしていない");
  await ui.dragTo(tagItem("爆発").getByTestId("drag-handle"), tagItem("環境音"), 0.1);
  const names = await ui.tagNames();
  expect(names[0] === "爆発", names.join(","));
  await clearFilter();
});

await step("F10", "選んでいる条件が左の欄の一番上にチップで並び、押すとその条件だけ外れる", async () => {
  const chips = async () => (await page.getByTestId("filter-chips").count()) ? (await page.getByTestId("filter-chips").locator("button:not(.clear-chip)").allInnerTexts()).map((s) => s.replace(/\s+/g, "")) : [];
  expect((await chips()).length === 0, "条件がないのにチップがある");
  await tagItem("環境音").click();
  await ui.filtered(() => tagItem("雨").click());
  await ui.filtered(() => page.getByTestId("folder").locator(".folder-name").click());
  let c = await chips();
  expect(c.join(",") === "📁formats✕,🏷環境音✕,🏷雨✕", c.join(","));
  await shot("F10_条件のチップ");
  await ui.filtered(() => page.getByRole("button", { name: "雨の条件を外す" }).click());
  c = await chips();
  expect(c.join(",") === "📁formats✕,🏷環境音✕", c.join(","));
  expect(!(await tagItem("雨").getAttribute("class")).includes("active"), "雨が選ばれたまま");
  await clearFilter();
  expect((await chips()).length === 0, "すべて解除で消えない");
});

await ui.finish();
