// 「絞り込み条件のグレーアウト」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/facets.mjs <テストデータ> <スクリーンショットの保存先>
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("facets.mjs");
const formats = path.join(dataDir, "formats");
const durations = path.join(dataDir, "durations");

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

await step("F11", "「その他」の長さ：時・分・秒を入れて「以上」「以下」で条件を加える（押し直すと置き換わる）。チップで外せる。空のときは押せない", async () => {
  const part = (unit) => page.getByLabel(`長さの${unit}`, { exact: true });
  const button = (label) => page.getByTestId("duration-input").getByRole("button", { name: label, exact: true });
  const setParts = async (h, m, s) => {
    await part("時").fill(h);
    await part("分").fill(m);
    await part("秒").fill(s);
  };
  const durationChips = () => page.getByTestId("duration-filter").allInnerTexts().then((t) => t.map((s) => s.replace(/\s+/g, "")).join(","));
  const shown = () => page.getByTestId("file-row").locator(".file-name").allInnerTexts().then((t) => t.join(","));
  // 長さの違う3つの音声を加え、長さを調べ終わるのを待つ
  const before = await page.evaluate(() => document.querySelector("[data-testid=hash-status]")?.textContent ?? "");
  await addFolder(durations);
  await page.waitForFunction(
    (b) => {
      const t = document.querySelector("[data-testid=hash-status]")?.textContent ?? "";
      return t !== b && t.includes("計算しました");
    },
    before,
    { timeout: 30000 },
  );
  expect((await fileCount()) === 8, `件数 ${await fileCount()}`);
  // 空のときは押せない。数字のほかは入らない
  expect(await button("以上").isDisabled(), "空なのに押せる");
  await setParts("", "1", "x");
  expect((await part("秒").inputValue()) === "", `秒の欄 ${await part("秒").inputValue()}`);
  await ui.filtered(() => button("以上").click());
  expect((await shown()) === "d_3700s.mp3,d_70s.mp3", `1分以上 ${await shown()}`);
  // 押した後も入力欄の値は残る
  expect((await part("分").inputValue()) === "1", "入力欄が消えた");
  await setParts("1", "", "");
  await ui.filtered(() => button("以下").click());
  expect((await shown()) === "d_70s.mp3", `1分以上1時間以下 ${await shown()}`);
  expect((await durationChips()) === "⏱1:00以上✕,⏱1:00:00以下✕", await durationChips());
  // 「その他」の見出しに、選んでいる数（長さの条件2つ）を出す
  const otherCount = await page.getByTestId("selected-count").allInnerTexts();
  expect(otherCount.join(",") === "2", `選んでいる数 ${otherCount.join(",")}`);
  await shot("F11_長さの条件");
  // 押し直すと置き換わる
  await setParts("", "", "5");
  await ui.filtered(() => button("以下").click());
  expect((await fileCount()) === 0, `1分以上5秒以下 ${await fileCount()}`);
  expect((await durationChips()) === "⏱1:00以上✕,⏱0:05以下✕", await durationChips());
  // チップの「✕」でその条件だけ外れる（1秒のチャイム5つと3秒の音声）
  await ui.filtered(() => page.getByTestId("duration-filter").first().click());
  expect((await fileCount()) === 6, `5秒以下 ${await fileCount()}`);
  await clearFilter();
  expect((await durationChips()) === "", "すべて解除で消えない");
  expect((await fileCount()) === 8, `解除後 ${await fileCount()}`);
});

await ui.finish();
