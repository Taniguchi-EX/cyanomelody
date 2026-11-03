// 「タグ自体の管理」と「タグの階層構造」の画面テスト（左の欄のタグ）。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/tags.mjs <テストデータ> <スクリーンショットの保存先>
// 名前の決まり（重複・空の名前・大文字と小文字）や、件数・絞り込み・統合の中身は、単体テスト（tags.rs・files.rs）で確かめる。
// ここでは、左の欄での操作（記号のボタン、入力欄、ドラッグ、確認）を確かめる。
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("tags.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, status, fileCount, row, tagItem, tagNames, waitIdle, addFolder, addTag, rowAction, createTags, renameTag } = ui;

const countOf = (name) => tagItem(name).locator(".sub").innerText();
const newName = () => page.getByLabel("新しいタグの名前");
const editName = () => page.getByLabel("タグの新しい名前");
/** 左の欄のタグを「名前:深さ」で表示順に */
const tree = () =>
  page.getByTestId("tag").evaluateAll((rows) => rows.map((r) => `${r.dataset.tagName}:${r.dataset.depth}`).join(" "));
const handle = (name) => tagItem(name).getByTestId("drag-handle");
/** タグ name の取っ手をつかんで、target の行の高さの ratio の位置まで動かす。release が false なら離さない */
const dragTo = (name, target, ratio, release = true) => ui.dragTo(handle(name), target, ratio, release);

// ===== タグ自体の管理（作成・名前の変更・統合・削除） =====

await step("A01", "準備：フォルダを登録し、タグを付ける", async () => {
  await addFolder(formats);
  await row("chime.wav").click();
  await addTag("explosion");
  await row("chime.mp3").click();
  await addTag("explosion");
  await addTag("爆発");
  await row("chime.flac").click();
  await addTag("爆発");
  const names = await tagNames();
  expect(names.join(",") === "explosion,爆発", names.join(","));
});

await step("A02", "タグの行にマウスを乗せたときだけ「✎」「🗑」が出る。（タグなし）の行には出ない", async () => {
  const actions = tagItem("爆発").getByTestId("row-actions");
  expect(!(await actions.isVisible()), "マウスを乗せる前から出ている");
  await tagItem("爆発").hover();
  expect(await actions.isVisible(), "マウスを乗せても出ない");
  await shot("A02_行の記号");
  expect((await page.getByTestId("untagged").getByTestId("row-actions").count()) === 0, "（タグなし）に出ている");
  // 出たり消えたりで行の幅（名前の位置）が変わらない
  expect((await countOf("爆発")) === "2", `爆発の件数 ${await countOf("爆発")}`);
});

await step("A03", "見出しの「＋」で、ファイルに付けずにタグを作れる（最上位の最後に入る）。Esc で入力をやめる", async () => {
  await createTags([" 未使用 "]);
  expect((await newName().count()) === 0, "作ったあとも入力欄が残っている");
  const names = await tagNames();
  expect(names.join(",") === "explosion,爆発,未使用", names.join(","));
  expect((await countOf("未使用")) === "0", "件数が0でない");
  await page.getByRole("button", { name: "タグを作る" }).click();
  await newName().fill("やめる");
  await newName().press("Escape");
  expect((await newName().count()) === 0, "Escで入力欄が閉じない");
  expect(!(await tagNames()).includes("やめる"), "作られた");
});

await step("A05", "「✎」でタグの名前を変えられる（0件でグレーアウトした行でも押せる）。空の名前では変わらず、Esc・入力欄の外を押すとやめる", async () => {
  expect((await tagItem("未使用").getAttribute("class")).includes("disabled"), "0件のタグがグレーアウトしていない");
  const opacity = await tagItem("未使用").evaluate((li) => [li, li.querySelector(".row-actions")].map((e) => getComputedStyle(e).opacity).join(","));
  expect(opacity === "1,1", `記号が薄い: ${opacity}`);
  await rowAction(tagItem("未使用"), "未使用の名前を変える");
  await editName().click();
  expect((await page.getByTestId("selected-count").count()) === 0, "名前の欄を押して絞り込んだ");
  await editName().fill("未使用タグ");
  await editName().press("Enter");
  await waitIdle();
  const names = await tagNames();
  expect(names.includes("未使用タグ") && !names.includes("未使用"), names.join(","));
  expect((await editName().count()) === 0, "入力欄が残っている");
  // 空の名前では変わらない。Esc でやめる
  await rowAction(tagItem("未使用タグ"), "未使用タグの名前を変える");
  await editName().fill("  ");
  await editName().press("Enter");
  await waitIdle();
  await editName().fill("別名");
  await editName().press("Escape");
  expect((await editName().count()) === 0, "Escで入力欄が閉じない");
  expect((await tagNames()).includes("未使用タグ"), "名前が変わった");
  // 入力欄の外を押すとやめる
  await page.getByRole("button", { name: "タグを作る" }).click();
  await newName().fill("押したらやめる");
  await row("chime.wav").click();
  expect((await newName().count()) === 0, "外を押しても入力欄が閉じない");
  expect(!(await tagNames()).includes("押したらやめる"), "作られた");
});

await step("A07", "既存のタグと同じ名前にすると統合でき、絞り込みも統合先に置き換わる", async () => {
  await ui.filtered(() => tagItem("explosion").locator(".tag-name").click());
  expect((await fileCount()) === 2, `explosionで絞り込み ${await fileCount()}`);
  await renameTag("explosion", "爆発");
  expect((await ui.lastConfirm()).includes("統合しますか"), await ui.lastConfirm());
  const names = await tagNames();
  expect(names.join(",") === "爆発,未使用タグ", names.join(","));
  await shot("A07_統合後");
  expect((await fileCount()) === 3, `統合後の絞り込み ${await fileCount()}`);
  expect((await tagItem("爆発").getAttribute("class"))?.includes("active"), "絞り込みが統合先になっていない");
});

await step("A08", "「🗑」でタグを削除すると、ファイルから外れ、絞り込みの条件からも外れる。押しても絞り込みは変わらない", async () => {
  await rowAction(tagItem("爆発"), "爆発を削除");
  await waitIdle();
  expect((await tagNames()).join(",") === "未使用タグ", (await tagNames()).join(","));
  expect((await fileCount()) === 5, `件数 ${await fileCount()}`);
  expect((await page.locator(".chip").count()) === 0, "タグが残っている");
  // 選んでいないタグの「🗑」を押してキャンセルしても、そのタグで絞り込まない
  await ui.setConfirmReply(false);
  await rowAction(tagItem("未使用タグ"), "未使用タグを削除");
  await ui.setConfirmReply(true);
  await page.waitForTimeout(300);
  expect((await page.getByTestId("selected-count").count()) === 0, "🗑を押して絞り込んだ");
  expect((await tagNames()).join(",") === "未使用タグ", "キャンセルしたのに削除した");
});

// ===== タグの階層構造（取っ手での並べ替え、たたむ、子のあるタグの削除） =====

await step("G02", "取っ手で落とす位置：行の真ん中は子の最後、上の端は前、下の端は後ろ、一覧の下の空いた所は最上位の最後（子孫も一緒に移る）", async () => {
  // 準備：前のテストのタグを消し、階層用のタグを作ってファイルに付ける
  await rowAction(tagItem("未使用タグ"), "未使用タグを削除");
  await waitIdle();
  await createTags(["環境音", "雨", "風", "強風", "爆発"]);
  for (const [file, tag] of [["chime.ogg", "環境音"], ["chime.wav", "雨"], ["chime.mp3", "強風"], ["chime.flac", "爆発"]]) {
    await row(file).click();
    await addTag(tag);
  }
  expect((await tree()) === "環境音:0 雨:0 風:0 強風:0 爆発:0", `作った順に並ばない: ${await tree()}`);
  // 真ん中：子の最後
  await dragTo("雨", tagItem("環境音"), 0.5);
  await dragTo("風", tagItem("環境音"), 0.5);
  await dragTo("強風", tagItem("風"), 0.5);
  expect((await tree()) === "環境音:0 雨:1 風:1 強風:2 爆発:0", `子: ${await tree()}`);
  expect((await status()).includes("移しました"), await status());
  await shot("G02_階層");
  // 上の端：前、下の端：後ろ（同じ親の兄弟）
  await dragTo("爆発", tagItem("雨"), 0.1);
  expect((await tree()) === "環境音:0 爆発:1 雨:1 風:1 強風:2", `前: ${await tree()}`);
  await dragTo("爆発", tagItem("環境音"), 0.9);
  expect((await tree()) === "環境音:0 雨:1 風:1 強風:2 爆発:0", `後ろ: ${await tree()}`);
  // 一覧の下の空いた所：最上位の最後（子孫も一緒に）
  await dragTo("風", page.getByTestId("tag-drop-root"), 0.5);
  expect((await tree()) === "環境音:0 雨:1 爆発:0 風:0 強風:1", `最上位の最後: ${await tree()}`);
});

const AFTER_G02 = "環境音:0 雨:1 爆発:0 風:0 強風:1";

await step("G03", "ドラッグ中は落とす位置が表示される（前は上の線、後ろは下の線、子は枠）。一覧の外で離すと何も起きない", async () => {
  await dragTo("爆発", tagItem("雨"), 0.1, false);
  expect((await tagItem("雨").getAttribute("class")).includes("drop-before"), "前の表示がない");
  await shot("G03_前に落とす表示");
  await page.mouse.move(0, 0, { steps: 2 });
  const r = await tagItem("雨").boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height * 0.9, { steps: 2 });
  expect((await tagItem("雨").getAttribute("class")).includes("drop-after"), "後ろの表示がない");
  await page.mouse.move(r.x + r.width / 2, r.y + r.height * 0.5, { steps: 2 });
  expect((await tagItem("雨").getAttribute("class")).includes("drop-child"), "子の表示がない");
  await page.mouse.move(640, 400, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect((await tree()) === AFTER_G02, await tree());
});

await step("G05", "自分自身や子孫の中には落とせない（表示が出ず、離しても変わらない）。（タグなし）にも落とせない", async () => {
  await dragTo("風", tagItem("強風"), 0.5, false);
  const cls = await tagItem("強風").getAttribute("class");
  expect(!/drop-/.test(cls), `表示が出た: ${cls}`);
  expect(cls.includes("drag-source"), "子孫が薄くならない");
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect((await tree()) === AFTER_G02, await tree());
  await dragTo("爆発", page.getByTestId("untagged"), 0.5);
  expect((await tree()) === AFTER_G02, await tree());
});

await step("G07", "取っ手を押しただけでは絞り込まない。名前を押すと絞り込む", async () => {
  await handle("爆発").click();
  await page.waitForTimeout(300);
  expect(!(await tagItem("爆発").getAttribute("class")).includes("active"), "取っ手で絞り込んだ");
  expect((await fileCount()) === 5, `件数 ${await fileCount()}`);
  await ui.filtered(() => tagItem("爆発").locator(".tag-name").click());
  expect((await fileCount()) === 1, `名前で絞り込めない ${await fileCount()}`);
  await ui.clearFilter();
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

await step("G13", "子のあるタグを削除すると、子はその位置に繰り上がる（確認に書いてある）。確認でキャンセルすると削除しない", async () => {
  await ui.setConfirmReply(false);
  await ui.rowAction(tagItem("雨"), "雨を削除");
  await page.waitForTimeout(500);
  expect((await ui.lastConfirm()).includes("タグ「雨」を削除しますか"), await ui.lastConfirm());
  expect((await tree()) === "環境音:0 雨:1 爆発:1 風:0 強風:1", `キャンセルで変わった: ${await tree()}`);
  await ui.setConfirmReply(true);
  await ui.rowAction(tagItem("環境音"), "環境音を削除");
  await waitIdle();
  const message = await ui.lastConfirm();
  expect(message.includes("子のタグ2件は、削除したタグの位置に繰り上がります"), message);
  expect((await tree()) === "雨:0 爆発:0 風:0 強風:1", await tree());
});

await ui.finish();
