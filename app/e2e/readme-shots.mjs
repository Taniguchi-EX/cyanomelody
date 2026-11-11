// README に載せるスクリーンショットを撮る（テストではない）。readme-shots.sh から呼ぶ。
//   node e2e/readme-shots.mjs <見本のデータ> <スクリーンショットの保存先>
import path from "node:path";
import { connect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("readme-shots.mjs");
const ui = await connect(shotDir);
const { page, step, shot, row, tagItem, waitIdle, addTag } = ui;

const handle = (name) => tagItem(name).locator(".tag-name, .credit-name").first();
const playlistItem = (name) => page.locator(`[data-testid=playlist][data-playlist-name="${name}"]`);
const editor = () => page.getByTestId("playlist-editor");

/** ファイルを選んで、右の欄からタグを付ける */
async function tag(rel, names) {
  await row(rel).click();
  for (const n of names) await addTag(n);
}

await step("S01", "見本のライブラリを作る", async () => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await ui.addFolder(path.join(dataDir, "効果音"));
  await tag("環境音/雨_小降り.mp3", ["雨", "屋外"]);
  await tag("環境音/雨_土砂降り.mp3", ["雨", "屋外"]);
  await tag("環境音/風_そよ風.ogg", ["風", "屋外"]);
  await tag("環境音/森の朝.flac", ["屋外", "BGM向き"]);
  await tag("足音/足音_砂利.wav", ["足音", "屋外"]);
  await tag("足音/足音_木の床.wav", ["足音", "屋内"]);
  await tag("戦闘/爆発_小.wav", ["爆発"]);
  await tag("戦闘/爆発_大.wav", ["爆発"]);
  await tag("戦闘/剣_振る.mp3", ["剣"]);
  // タグを階層にする
  await ui.createTags(["環境音", "戦闘"]);
  for (const n of ["雨", "風", "足音"]) await ui.dragTo(handle(n), tagItem("環境音"), 0.5);
  for (const n of ["爆発", "剣"]) await ui.dragTo(handle(n), tagItem("戦闘"), 0.5);
  // タグの色
  for (const [name, bg, fg] of [
    ["環境音", "#d8f0e0", "#1d5c33"],
    ["戦闘", "#fbe0dc", "#8a2a1c"],
  ]) {
    await ui.openTagDetail(name);
    await page.getByLabel("背景色を付ける").check();
    await page.getByLabel("背景色", { exact: true }).fill(bg);
    await page.getByLabel("文字色を付ける").check();
    await page.getByLabel("文字色", { exact: true }).fill(fg);
    await page.getByTestId("tag-detail").getByRole("button", { name: "保存" }).click();
    await waitIdle();
  }
});

await step("S02", "ライブラリの画面（タグで絞り込み、1曲を選んで再生）", async () => {
  await ui.filtered(() => tagItem("屋外").locator(".tag-name").click());
  await row("環境音/雨_土砂降り.mp3").click();
  await row("環境音/雨_土砂降り.mp3").getByRole("button", { name: "再生", exact: true }).click();
  await ui.waitPlaying();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "一時停止" }).click();
  await shot("library");
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
  await ui.clearFilter();
});

await step("S03", "プレイリストを作る（ファイル2つと、雨のタグの組み合わせ（🎲 1曲））", async () => {
  await page.getByRole("button", { name: "プレイリストを作る" }).click();
  await page.getByLabel("新しいプレイリストの名前").fill("森の探索シーン");
  await page.getByLabel("新しいプレイリストの名前").press("Enter");
  await waitIdle();
  await ui.check("環境音/森の朝.flac");
  await ui.check("足音/足音_砂利.wav");
  await ui.dragChecked(playlistItem("森の探索シーン"));
  await ui.clearChecks();
  // ダブルクリックで編集画面を開き、雨のタグの組み合わせ（🎲 1曲）を加える
  await playlistItem("森の探索シーン").locator(".tag-name").dblclick();
  await editor().waitFor({ timeout: 3000 });
  await page.getByLabel("組み合わせに加えるタグ").fill("雨");
  await page.getByLabel("組み合わせに加えるタグ").press("Enter");
  await page.getByRole("button", { name: "タグの組み合わせを追加" }).click();
  await waitIdle();
  await page.getByLabel("雨の再生方法").selectOption("random");
  await waitIdle();
});

await step("S04", "エフェクトの画面（足音の項目に、新しいエフェクトセットを作って付ける）", async () => {
  await page.getByLabel("足音_砂利.wavのエフェクト").selectOption({ label: "新しいfxを作る" });
  const dialog = page.getByRole("dialog", { name: "エフェクトセットの管理" });
  await dialog.waitFor({ timeout: 3000 });
  await page.getByLabel("エフェクトセットの名前", { exact: true }).fill("洞窟の響き");
  for (const kind of ["reverb", "gain"]) {
    await page.getByLabel("追加するエフェクト").selectOption(kind);
    await page.getByRole("button", { name: "追加", exact: true }).click();
  }
  await dialog.getByRole("button", { name: "保存" }).click();
  await waitIdle();
  await shot("effects");
  await dialog.getByRole("button", { name: "閉じる" }).click();
});

await step("S05", "プレイリストの画面（編集画面の「▶ 再生」で、選んで抽選した並びを再生し、編集画面を閉じて撮る）", async () => {
  await editor().getByRole("button", { name: "プレイリストを再生" }).click();
  await ui.waitPlaying();
  // 中央の一覧（抽選した並び。来た項目と fx のアイコン）を見せるため、編集画面は閉じる
  await editor().getByRole("button", { name: "閉じる", exact: true }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "一時停止" }).click();
  await shot("playlist");
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
});

await ui.finish();
