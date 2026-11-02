// 「タグの階層構造」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/tag-tree.mjs <テストデータ> <スクリーンショットの保存先>
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("tag-tree.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, status, fileCount, row, tagItem, waitIdle, addFolder, clearFilter, addTag } = ui;


/** 左の欄のタグを「名前:深さ」で表示順に */
const tree = () =>
  page.getByTestId("tag").evaluateAll((rows) => rows.map((r) => `${r.dataset.tagName}:${r.dataset.depth}`).join(" "));
const handle = (name) => tagItem(name).getByTestId("drag-handle");

/** 取っ手をつかんで、落とす先の行の高さの ratio の位置まで動かす。release が false なら離さない */
async function dragTo(name, target, ratio, release = true) {
  const h = await handle(name).boundingBox();
  const r = await target.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height * ratio, { steps: 6 });
  if (!release) return;
  await page.mouse.up();
  await waitIdle();
}

await step("G01", "準備：フォルダを登録し、タグを作ってファイルに付ける", async () => {
  await addFolder(formats);
  await page.getByRole("button", { name: "タグを管理" }).click();
  for (const n of ["環境音", "雨", "風", "強風", "爆発"]) {
    await page.getByLabel("新しいタグの名前").fill(n);
    await page.getByRole("button", { name: "作成" }).click();
    await waitIdle();
  }
  await page.getByRole("button", { name: "閉じる" }).click();
  for (const [file, tag] of [["chime.ogg", "環境音"], ["chime.wav", "雨"], ["chime.mp3", "強風"], ["chime.flac", "爆発"]]) {
    await row(file).click();
    await addTag(tag);
  }
  const t = await tree();
  expect(t === "環境音:0 雨:0 風:0 強風:0 爆発:0", `作った順に並ばない: ${t}`);
});

await step("G02", "取っ手で行の真ん中に落とすと、その子の最後に入る", async () => {
  await dragTo("雨", tagItem("環境音"), 0.5);
  await dragTo("風", tagItem("環境音"), 0.5);
  await dragTo("強風", tagItem("風"), 0.5);
  const t = await tree();
  expect(t === "環境音:0 雨:1 風:1 強風:2 爆発:0", t);
  expect((await status()).includes("移しました"), await status());
  await shot("G02_階層");
});

await step("G03", "ドラッグ中は落とす位置が表示される（前は上の線、後ろは下の線、子は枠）", async () => {
  await dragTo("爆発", tagItem("雨"), 0.1, false);
  expect((await tagItem("雨").getAttribute("class")).includes("drop-before"), "前の表示がない");
  await shot("G03_前に落とす表示");
  await page.mouse.move(0, 0, { steps: 2 });
  const r = await tagItem("雨").boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height * 0.9, { steps: 2 });
  expect((await tagItem("雨").getAttribute("class")).includes("drop-after"), "後ろの表示がない");
  await page.mouse.move(r.x + r.width / 2, r.y + r.height * 0.5, { steps: 2 });
  expect((await tagItem("雨").getAttribute("class")).includes("drop-child"), "子の表示がない");
  // 一覧の外で離すと何も起きない
  await page.mouse.move(640, 400, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect((await tree()) === "環境音:0 雨:1 風:1 強風:2 爆発:0", await tree());
});

await step("G04", "上の端に落とすと前、下の端に落とすと後ろ（同じ親の兄弟）に入る", async () => {
  await dragTo("爆発", tagItem("雨"), 0.1);
  let t = await tree();
  expect(t === "環境音:0 爆発:1 雨:1 風:1 強風:2", `前: ${t}`);
  await dragTo("爆発", tagItem("環境音"), 0.9);
  t = await tree();
  expect(t === "環境音:0 雨:1 風:1 強風:2 爆発:0", `後ろ: ${t}`);
});

await step("G05", "自分自身や子孫の中には落とせない（表示が出ず、離しても変わらない）", async () => {
  await dragTo("環境音", tagItem("強風"), 0.5, false);
  const cls = await tagItem("強風").getAttribute("class");
  expect(!/drop-/.test(cls), `表示が出た: ${cls}`);
  expect((await tagItem("風").getAttribute("class")).includes("drag-source"), "子孫が薄くならない");
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect((await tree()) === "環境音:0 雨:1 風:1 強風:2 爆発:0", await tree());
  // 「（タグなし）」の行にも落とせない
  await dragTo("爆発", page.getByTestId("untagged"), 0.5);
  expect((await tree()) === "環境音:0 雨:1 風:1 強風:2 爆発:0", await tree());
});

await step("G06", "件数は子孫を含み、親のタグで絞り込むと子孫のタグのファイルも出る", async () => {
  const count = async (n) => parseInt(await tagItem(n).locator(".sub").innerText(), 10);
  expect((await count("環境音")) === 3 && (await count("風")) === 1 && (await count("雨")) === 1, "件数");
  await tagItem("環境音").click();
  await page.waitForTimeout(400);
  expect((await fileCount()) === 3, `親で絞り込み ${await fileCount()}`);
  await tagItem("雨").click();
  await page.waitForTimeout(400);
  expect((await fileCount()) === 1, `親と子（AND） ${await fileCount()}`);
  await clearFilter();
});

await step("G07", "取っ手を押しただけでは絞り込まない。名前を押すと絞り込む", async () => {
  await handle("爆発").click();
  await page.waitForTimeout(300);
  expect(!(await tagItem("爆発").getAttribute("class")).includes("active"), "取っ手で絞り込んだ");
  expect((await fileCount()) === 5, `件数 ${await fileCount()}`);
});

await step("G08", "一覧の下の空いた所に落とすと、最上位の最後に入る（子孫も一緒に移る）", async () => {
  await dragTo("風", page.getByTestId("tag-drop-root"), 0.5);
  const t = await tree();
  expect(t === "環境音:0 雨:1 爆発:0 風:0 強風:1", t);
});

await step("G09", "たたむと子が隠れ、再読み込み後もたたんだまま。たたんだタグに落とすとたたんだまま子に入る", async () => {
  await page.getByRole("button", { name: "環境音をたたむ" }).click();
  expect((await tree()) === "環境音:0 爆発:0 風:0 強風:1", await tree());
  await ui.reload();
  expect((await tree()) === "環境音:0 爆発:0 風:0 強風:1", `再読み込み後 ${await tree()}`);
  await dragTo("爆発", tagItem("環境音"), 0.5);
  expect((await tree()) === "環境音:0 風:0 強風:1", `落とした後 ${await tree()}`);
  await page.getByRole("button", { name: "環境音を開く" }).click();
  expect((await tree()) === "環境音:0 雨:1 爆発:1 風:0 強風:1", `開いた後 ${await tree()}`);
  await shot("G09_開いた後");
});

await step("G10", "ファイルに付いたタグは、タグの一覧の順に並ぶ", async () => {
  await row("chime.wav").click();
  await addTag("強風");
  let chips = (await row("chime.wav").locator(".chip").allInnerTexts()).join(",");
  expect(chips === "雨,強風", chips);
  await dragTo("風", tagItem("環境音"), 0.1);
  chips = (await row("chime.wav").locator(".chip").allInnerTexts()).join(",");
  expect(chips === "強風,雨", `並べ替え後 ${chips}`);
});

await step("G11", "管理画面も同じ順番と階層で表示する", async () => {
  await page.getByRole("button", { name: "タグを管理" }).click();
  const rows = await page
    .getByTestId("manage-tag")
    .evaluateAll((rs) => rs.map((r) => `${r.dataset.tagName}:${r.dataset.depth}`).join(" "));
  expect(rows === "風:0 強風:1 環境音:0 雨:1 爆発:1", rows);
  await shot("G11_管理画面");
});

await step("G12", "子孫のタグへの統合はできない", async () => {
  const manageRow = page.locator(`[data-testid=manage-tag][data-tag-name="環境音"]`);
  await manageRow.getByRole("button", { name: "名前変更" }).click();
  await page.getByLabel("タグの新しい名前").fill("雨");
  await page.getByRole("button", { name: "決定" }).click();
  await waitIdle();
  expect((await status()).includes("子孫のタグに統合することはできません"), await status());
  await page.getByRole("button", { name: "やめる" }).click();
});

await step("G13", "子のあるタグを削除すると、子はその位置に繰り上がる（確認に書いてある）", async () => {
  const manageRow = page.locator(`[data-testid=manage-tag][data-tag-name="環境音"]`);
  await manageRow.getByRole("button", { name: "削除" }).click();
  await waitIdle();
  const message = await ui.lastConfirm();
  expect(message.includes("子のタグ2件は、削除したタグの位置に繰り上がります"), message);
  await page.getByRole("button", { name: "閉じる" }).click();
  const t = await tree();
  expect(t === "風:0 強風:1 雨:0 爆発:0", t);
});

await step("G14", "確認ダイアログで「キャンセル」を選ぶと削除しない", async () => {
  await ui.setConfirmReply(false);
  await page.getByRole("button", { name: "タグを管理" }).click();
  await page.locator(`[data-testid=manage-tag][data-tag-name="雨"]`).getByRole("button", { name: "削除" }).click();
  await page.waitForTimeout(500);
  expect((await ui.lastConfirm()).includes("タグ「雨」を削除しますか"), await ui.lastConfirm());
  await page.getByRole("button", { name: "閉じる" }).click();
  expect((await tree()) === "風:0 強風:1 雨:0 爆発:0", await tree());
  await ui.setConfirmReply(true);
});

await ui.finish();
