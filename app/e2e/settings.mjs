// 「設定画面」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/settings.mjs <テストデータ> <スクリーンショットの保存先>
import { connect, expect, parseArgs } from "./helpers.mjs";

const { shotDir } = parseArgs("settings.mjs");
const ui = await connect(shotDir);
const { page, step, shot, waitIdle } = ui;

const dialog = () => page.getByRole("dialog", { name: "設定" });
const gear = () => page.getByTestId("player-bar").getByRole("button", { name: "設定", exact: true });
const tab = (name) => dialog().getByRole("tab", { name, exact: true });
async function openSettings() {
  await gear().click();
  await dialog().waitFor({ timeout: 3000 });
}
async function closeSettings() {
  await dialog().getByRole("button", { name: "閉じる" }).click();
  await dialog().waitFor({ state: "detached", timeout: 3000 });
}

await step("S01", "再生の欄の右端の歯車で設定画面が開き、「一般」「バージョンとライセンス」のタブが並ぶ（最初は一般）。Esc で閉じる", async () => {
  // 歯車は再生の欄の一番右（音量のバーの右）
  const right = await page.getByTestId("player-bar").evaluate((bar) => {
    const buttons = [...bar.querySelectorAll("button, input")].map((e) => e.getBoundingClientRect().right);
    return Math.max(...buttons);
  });
  const gearBox = await gear().boundingBox();
  const volumeBox = await page.getByTestId("player-volume").boundingBox();
  expect(Math.abs(gearBox.x + gearBox.width - right) < 1 && gearBox.x > volumeBox.x, "歯車が右端にない");
  await openSettings();
  const tabs = await dialog().getByRole("tab").allInnerTexts();
  expect(tabs.join(",") === "一般,バージョンとライセンス", tabs.join(","));
  expect((await tab("一般").getAttribute("aria-selected")) === "true", "最初が一般でない");
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 3000 });
});

await step("S02", "一般：新しく作るタグの既定値（並び順・色）を決めるとすぐに保存され、その後に作ったタグに付く。今あるタグは変わらない", async () => {
  await ui.createTags(["前からある"]);
  await openSettings();
  expect((await page.getByLabel("子のタグの並び順").locator("option:checked").innerText()) === "親の設定を引き継ぐ", "最初の並び順");
  expect(await page.getByLabel("昇順・降順").isDisabled(), "引き継ぐのに昇順・降順を選べる");
  await page.getByLabel("子のタグの並び順").selectOption({ label: "ローマ字順" });
  await page.getByLabel("昇順・降順").selectOption({ label: "降順" });
  await page.getByLabel("背景色を付ける").check();
  await page.getByLabel("背景色", { exact: true }).fill("#ffcc00");
  const sample = await page.getByTestId("new-tag-sample").evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(sample === "rgb(255, 204, 0)", `見本 ${sample}`);
  await shot("S02_一般");
  await closeSettings();
  // 閉じて開き直しても残っている（保存のボタンは押していない）
  await openSettings();
  expect((await page.getByLabel("子のタグの並び順").locator("option:checked").innerText()) === "ローマ字順", "保存されていない");
  await closeSettings();
  // その後に作ったタグに付く
  await ui.createTags(["後から作った"]);
  await ui.openTagDetail("後から作った");
  const detail = page.getByTestId("tag-detail");
  expect((await page.getByLabel("子のタグの並び順").locator("option:checked").innerText()) === "ローマ字順", "並び順が付かない");
  expect((await page.getByLabel("昇順・降順").inputValue()) === "desc", "降順が付かない");
  expect(await page.getByLabel("背景色を付ける").isChecked(), "背景色が付かない");
  expect((await page.getByLabel("背景色", { exact: true }).inputValue()) === "#ffcc00", await page.getByLabel("背景色", { exact: true }).inputValue());
  expect(!(await page.getByLabel("文字色を付ける").isChecked()), "文字色が付いた");
  await detail.getByRole("button", { name: "やめる" }).click();
  // 今あるタグは変わらない
  await ui.openTagDetail("前からある");
  expect((await page.getByLabel("子のタグの並び順").locator("option:checked").innerText()) === "親の設定を引き継ぐ", "今あるタグが変わった");
  expect(!(await page.getByLabel("背景色を付ける").isChecked()), "今あるタグに色が付いた");
  await detail.getByRole("button", { name: "やめる" }).click();
  // 元に戻しておく
  await openSettings();
  await page.getByLabel("子のタグの並び順").selectOption({ label: "親の設定を引き継ぐ" });
  await page.getByLabel("背景色を付ける").uncheck();
  await waitIdle();
  await closeSettings();
});

await step("S03", "バージョンとライセンス：アプリの版と、使っているライブラリの一覧。名前で絞り込め、押すとライセンスの文章を出す。MPL-2.0 にはソースコードの入手先を出す。開いていたタブを覚えている", async () => {
  await openSettings();
  await tab("バージョンとライセンス").click();
  await page.getByTestId("license-item").first().waitFor({ timeout: 5000 });
  await page.waitForFunction(() => /^v\d+\.\d+\.\d+$/.test(document.querySelector("[data-testid=app-version]")?.textContent ?? ""), null, { timeout: 3000 });
  const version = await page.getByTestId("app-version").innerText();
  const count = await page.getByTestId("license-item").count();
  expect(count > 100, `ライブラリの数 ${count}`);
  // 画面の JavaScript のライブラリも入っている
  expect((await page.locator("[data-testid=license-item][data-name=react]").count()) === 1, "react がない");
  await shot("S03_バージョンとライセンス");
  // 名前で絞り込み、押すとライセンスの文章（ファイルを入れずに配布されている symphonia は標準の文章）
  await page.getByLabel("ライブラリ名で検索", { exact: true }).fill("symphonia-core");
  expect((await page.getByTestId("license-item").count()) === 1, `絞り込み ${await page.getByTestId("license-item").count()}`);
  await page.getByTestId("license-item").getByRole("button").first().click();
  const text = await page.getByTestId("license-item").locator(".license-text").innerText();
  expect(text.startsWith("Mozilla Public License Version 2.0"), text.slice(0, 60));
  expect((await page.getByTestId("mpl-note").count()) === 1, "ソースコードの入手先が出ない");
  await shot("S03_ライセンスの文章");
  // MIT のライブラリには、入手先の注意は出ない
  await page.getByLabel("ライブラリ名で検索", { exact: true }).fill("react-dom");
  await page.getByTestId("license-item").getByRole("button").first().click();
  expect((await page.getByTestId("license-item").locator(".license-text").innerText()).includes("MIT License"), "react-dom の文章");
  expect((await page.getByTestId("mpl-note").count()) === 0, "MIT に入手先の注意が出る");
  await closeSettings();
  // 開いていたタブを覚えている
  await openSettings();
  expect((await tab("バージョンとライセンス").getAttribute("aria-selected")) === "true", "タブを覚えていない");
  expect(version.length > 1, version);
  await tab("一般").click();
  await closeSettings();
});

await ui.finish();
