// 「タグ自体の管理」の画面テスト（左の欄のタグでの作成・名前変更・削除）。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/tag-admin.mjs <テストデータ> <スクリーンショットの保存先>
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("tag-admin.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, status, fileCount, row, tagItem, tagNames, waitIdle, addFolder, clearFilter, addTag, rowAction, createTags, renameTag } =
  ui;

const countOf = (name) => tagItem(name).locator(".sub").innerText();
const newName = () => page.getByLabel("新しいタグの名前");
const editName = () => page.getByLabel("タグの新しい名前");

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

await step("A03", "見出しの「＋」で、ファイルに付けずにタグを作れる（最上位の最後に入る）", async () => {
  await createTags([" 未使用 "]);
  expect((await newName().count()) === 0, "作ったあとも入力欄が残っている");
  const names = await tagNames();
  expect(names.join(",") === "explosion,爆発,未使用", names.join(","));
  expect((await countOf("未使用")) === "0", "件数が0でない");
});

await step("A04", "同じ名前（大文字・小文字の違いだけを含む）のタグは作れない。Escで入力をやめる", async () => {
  await page.getByRole("button", { name: "タグを作る" }).click();
  await newName().fill("EXPLOSION");
  await newName().press("Enter");
  await waitIdle();
  const s = await status();
  expect(s.includes("同じ名前のタグがあります"), `status: ${s}`);
  expect((await tagNames()).length === 3, "増えた");
  // 作れなかったときは入力欄が残る。空の名前ではEnterを押しても何もしない
  await newName().fill("  ");
  await newName().press("Enter");
  await waitIdle();
  expect((await tagNames()).length === 3, "空の名前で作られた");
  await newName().press("Escape");
  expect((await newName().count()) === 0, "Escで入力欄が閉じない");
});

await step("A05", "「✎」でタグの名前を変えられる（0件でグレーアウトした行でも、記号は薄くならず押せる）。名前の欄を押しても絞り込まない", async () => {
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
});

await step("A06", "大文字・小文字だけを変える名前変更ができる", async () => {
  await renameTag("explosion", "Explosion");
  const names = await tagNames();
  expect(names.includes("Explosion") && !names.includes("explosion"), names.join(","));
  expect((await row("chime.wav").locator(".chip").allInnerTexts()).includes("Explosion"), "一覧に反映されない");
});

await step("A07", "既存のタグと同じ名前にすると統合でき、絞り込みも統合先に置き換わる", async () => {
  await tagItem("Explosion").locator(".tag-name").click();
  await page.waitForTimeout(300);
  expect((await fileCount()) === 2, `Explosionで絞り込み ${await fileCount()}`);
  await renameTag("Explosion", "爆発");
  const names = await tagNames();
  // タグは作った順に並ぶ（名前の順ではない）
  expect(names.join(",") === "爆発,未使用タグ", names.join(","));
  await shot("A07_統合後");
  expect((await fileCount()) === 3, `統合後の絞り込み ${await fileCount()}`);
  expect((await tagItem("爆発").getAttribute("class"))?.includes("active"), "絞り込みが統合先になっていない");
  const chips = await row("chime.mp3").locator(".chip").allInnerTexts();
  expect(chips.join(",") === "爆発", `mp3のタグ ${chips.join(",")}`);
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

await step("A09", "使われていないタグがあるときだけ「🧹」が出て、まとめて削除できる", async () => {
  await row("chime.ogg").click();
  await addTag("使用中");
  const sweep = page.getByRole("button", { name: "使われていないタグを削除" });
  expect((await sweep.count()) === 1, "🧹が出ない");
  await sweep.click();
  await waitIdle();
  const names = await tagNames();
  expect(names.join(",") === "使用中", names.join(","));
  expect((await sweep.count()) === 0, "使われていないタグがないのに🧹が出る");
  await shot("A09_一括削除後");
});

await step("A10", "空の名前には変えられない。Escで名前の変更をやめる", async () => {
  await rowAction(tagItem("使用中"), "使用中の名前を変える");
  await editName().fill("  ");
  await editName().press("Enter");
  await waitIdle();
  expect((await tagNames()).join(",") === "使用中", "空の名前に変わった");
  await editName().fill("別名");
  await editName().press("Escape");
  expect((await editName().count()) === 0, "Escで入力欄が閉じない");
  expect((await tagNames()).join(",") === "使用中", "Escで名前が変わった");
  await clearFilter();
});

await step("A11", "名前の入力欄の外を押すと、入力をやめる", async () => {
  await page.getByRole("button", { name: "タグを作る" }).click();
  await newName().fill("押したらやめる");
  await row("chime.wav").click();
  expect((await newName().count()) === 0, "外を押しても入力欄が閉じない");
  expect(!(await tagNames()).includes("押したらやめる"), "作られた");
});

await ui.finish();
