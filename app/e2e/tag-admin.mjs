// 「タグ自体の管理」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/tag-admin.mjs <テストデータ> <スクリーンショットの保存先>
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("tag-admin.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, status, fileCount, row, tagItem, tagNames, waitIdle, addFolder, clearFilter, addTag } = ui;

const manageRow = (name) => page.locator(`[data-testid=manage-tag][data-tag-name="${name}"]`);
const manageNames = () => page.getByTestId("manage-tag").evaluateAll((rows) => rows.map((r) => r.dataset.tagName));
async function rename(from, to) {
  await manageRow(from).getByRole("button", { name: "名前変更" }).click();
  await page.getByLabel("タグの新しい名前").fill(to);
  await page.getByRole("button", { name: "決定" }).click();
  await waitIdle();
}

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

await step("A02", "「タグを管理」で管理画面が開き、タグとファイル数が出る", async () => {
  await page.getByRole("button", { name: "タグを管理" }).click();
  const names = await manageNames();
  expect(names.join(",") === "explosion,爆発", names.join(","));
  const count = await manageRow("爆発").locator("td.num").innerText();
  expect(count === "2", `爆発の件数 ${count}`);
});

await step("A03", "ファイルに付けずにタグを作れる", async () => {
  await page.getByLabel("新しいタグの名前").fill(" 未使用 ");
  await page.getByRole("button", { name: "作成" }).click();
  await waitIdle();
  expect((await manageRow("未使用").count()) === 1, "作られていない");
  expect((await manageRow("未使用").locator("td.num").innerText()) === "0", "件数が0でない");
  expect((await tagNames()).includes("未使用"), "左の一覧に出ない");
});

await step("A04", "同じ名前（大文字・小文字の違いだけを含む）のタグは作れない", async () => {
  await page.getByLabel("新しいタグの名前").fill("EXPLOSION");
  await page.getByRole("button", { name: "作成" }).click();
  await waitIdle();
  const s = await status();
  expect(s.includes("同じ名前のタグがあります"), `status: ${s}`);
  expect((await manageNames()).length === 3, "増えた");
  await page.getByLabel("新しいタグの名前").fill("");
});

await step("A05", "タグの名前を変えられる", async () => {
  await rename("未使用", "未使用タグ");
  const names = await manageNames();
  expect(names.includes("未使用タグ") && !names.includes("未使用"), names.join(","));
});

await step("A06", "大文字・小文字だけを変える名前変更ができる", async () => {
  await rename("explosion", "Explosion");
  const names = await manageNames();
  expect(names.includes("Explosion") && !names.includes("explosion"), names.join(","));
  expect((await row("chime.wav").locator(".chip").allInnerTexts()).includes("Explosion"), "一覧に反映されない");
});

await step("A07", "既存のタグと同じ名前にすると統合でき、絞り込みも統合先に置き換わる", async () => {
  await page.getByRole("button", { name: "閉じる" }).click();
  await tagItem("Explosion").click();
  await page.waitForTimeout(300);
  expect((await fileCount()) === 2, `Explosionで絞り込み ${await fileCount()}`);
  await page.getByRole("button", { name: "タグを管理" }).click();
  await rename("Explosion", "爆発");
  const names = await manageNames();
  expect(names.join(",") === "未使用タグ,爆発", names.join(","));
  expect((await manageRow("爆発").locator("td.num").innerText()) === "3", "統合後の件数が3でない");
  await shot("A07_統合後の管理画面");
  await page.getByRole("button", { name: "閉じる" }).click();
  expect((await fileCount()) === 3, `統合後の絞り込み ${await fileCount()}`);
  expect((await tagItem("爆発").getAttribute("class"))?.includes("active"), "絞り込みが統合先になっていない");
  const chips = await row("chime.mp3").locator(".chip").allInnerTexts();
  expect(chips.join(",") === "爆発", `mp3のタグ ${chips.join(",")}`);
});

await step("A08", "タグを削除すると、ファイルから外れ、絞り込みの条件からも外れる", async () => {
  await page.getByRole("button", { name: "タグを管理" }).click();
  await manageRow("爆発").getByRole("button", { name: "削除" }).click();
  await waitIdle();
  expect((await manageNames()).join(",") === "未使用タグ", (await manageNames()).join(","));
  await page.getByRole("button", { name: "閉じる" }).click();
  expect((await fileCount()) === 5, `件数 ${await fileCount()}`);
  expect((await page.locator(".chip").count()) === 0, "タグが残っている");
});

await step("A09", "使われていないタグをまとめて削除できる", async () => {
  await row("chime.ogg").click();
  await addTag("使用中");
  await page.getByRole("button", { name: "タグを管理" }).click();
  await page.getByRole("button", { name: "使われていないタグを削除" }).click();
  await waitIdle();
  const names = await manageNames();
  expect(names.join(",") === "使用中", names.join(","));
  expect(await page.getByRole("button", { name: "使われていないタグを削除" }).isDisabled(), "ボタンが押せる");
  await shot("A09_一括削除後");
});

await step("A10", "空の名前には変えられない", async () => {
  await manageRow("使用中").getByRole("button", { name: "名前変更" }).click();
  await page.getByLabel("タグの新しい名前").fill("  ");
  expect(await page.getByRole("button", { name: "決定" }).isDisabled(), "決定が押せる");
  await page.getByRole("button", { name: "やめる" }).click();
  await page.getByRole("button", { name: "閉じる" }).click();
  await clearFilter();
});

await ui.finish();
