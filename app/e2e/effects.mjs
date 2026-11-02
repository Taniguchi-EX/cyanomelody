// 「エフェクト」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/effects.mjs <テストデータ> <スクリーンショットの保存先>
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("effects.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, status, row, waitIdle, addFolder } = ui;

const dialog = () => page.getByRole("dialog", { name: "エフェクトのまとまりの管理" });
const chainItem = (name) => page.locator(`[data-testid=effect-chain][data-chain-name="${name}"]`);
const steps = () => page.getByTestId("effect-step").evaluateAll((els) => els.map((e) => e.dataset.kind).join(","));
const audioSrc = () => page.evaluate(() => decodeURIComponent(document.querySelector("audio").src));
const openManager = () => page.getByRole("button", { name: "エフェクトのまとまりを管理" }).click();
async function addEffect(kind) {
  await page.getByLabel("加えるエフェクト").selectOption(kind);
  await page.getByRole("button", { name: "加える", exact: true }).click();
}
async function save() {
  await dialog().getByRole("button", { name: "保存" }).click();
  await waitIdle();
}

await step("E01", "準備：フォルダを登録し、プレイリストにファイルを2つ入れる", async () => {
  await addFolder(formats);
  await page.getByRole("button", { name: "プレイリストを作る" }).click();
  await page.getByLabel("新しいプレイリストの名前").fill("シナリオ");
  await page.getByRole("button", { name: "作る", exact: true }).click();
  await waitIdle();
  await ui.check("chime.wav");
  await ui.check("chime.mp3");
  await ui.bulkMode("プレイリストに追加");
  await page.getByLabel("チェックしたファイルを加えるプレイリスト").selectOption({ label: "シナリオ" });
  await page.getByTestId("bulk-bar").getByRole("button", { name: "追加", exact: true }).click();
  await waitIdle();
  await ui.clearChecks();
});

await step("E02", "まとまりを作ると選ばれ、エフェクトを加え・並べ替え・保存できる", async () => {
  await openManager();
  await page.getByLabel("新しいエフェクトのまとまりの名前").fill("強めの残響");
  await page.getByLabel("新しいエフェクトのまとまりの名前").press("Enter");
  await waitIdle();
  expect((await chainItem("強めの残響").getAttribute("class")).includes("active"), "作ったまとまりが選ばれない");
  await addEffect("gain");
  await addEffect("reverb");
  await page.getByRole("button", { name: "2番目を上へ" }).click();
  expect((await steps()) === "reverb,gain", await steps());
  await page.getByLabel("2番目の増減").fill("-6");
  await page.getByLabel("1番目の混ぜる割合").fill("50");
  await save();
  expect((await status()).includes("保存しました"), await status());
  const title = await chainItem("強めの残響").getAttribute("title");
  expect(title === "リバーブ 1.5秒 50% → 音量調整 -6dB", title);
  await shot("E02_管理画面");
});

await step("E03", "同じ名前のまとまりは作れない", async () => {
  await page.getByLabel("新しいエフェクトのまとまりの名前").fill("強めの残響");
  await page.getByRole("button", { name: "作成", exact: true }).click();
  await waitIdle();
  expect((await status()).includes("同じ名前のエフェクトのまとまりがあります"), await status());
  await page.getByLabel("新しいエフェクトのまとまりの名前").fill("");
});

await step("E04", "保存していない変更があるときは、閉じる前に確かめる（キャンセルで残る）", async () => {
  await addEffect("fadeIn");
  await ui.setConfirmReply(false);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  expect((await dialog().count()) === 1, "閉じた");
  expect((await ui.lastConfirm()).includes("保存していない変更"), await ui.lastConfirm());
  await ui.setConfirmReply(true);
  await dialog().getByRole("button", { name: "閉じる" }).click();
  await page.waitForTimeout(300);
  expect((await dialog().count()) === 0, "閉じない");
  await openManager();
  expect((await steps()) === "reverb,gain", `捨てた変更が残っている: ${await steps()}`);
});

await step("E05", "右の欄のファイルにかけて試聴できる（エフェクトをかけた音が鳴る）", async () => {
  await dialog().getByRole("button", { name: "閉じる" }).click();
  await row("chime.wav").click();
  await openManager();
  await page.getByRole("button", { name: "▶ 試聴" }).click();
  await page.waitForFunction(() => document.querySelector("audio").src.includes("effects-cache"), null, { timeout: 10000 });
  expect(!(await page.evaluate(() => document.querySelector("audio").paused)), "鳴っていない");
  await dialog().getByRole("button", { name: "閉じる" }).click();
});

await step("E06", "項目にまとまりを結び付けると、その項目だけエフェクトのかかった音で再生される", async () => {
  await page.locator(`[data-testid=playlist][data-playlist-name="シナリオ"] .tag-name`).click();
  await page.waitForTimeout(300);
  await page.getByLabel("chime.wavのエフェクト").selectOption({ label: "強めの残響" });
  await waitIdle();
  // 項目の並びはファイルの一覧の順（mp3、wav）
  await page.getByRole("button", { name: "▶ 再生" }).click();
  await page.getByTestId("player-bar").waitFor({ timeout: 5000 });
  expect(!(await audioSrc()).includes("effects-cache"), `エフェクトのない曲: ${await audioSrc()}`);
  await page.getByRole("button", { name: "次へ" }).click();
  await page.waitForFunction(() => document.querySelector("audio").src.includes("effects-cache"), null, { timeout: 10000 });
  expect((await page.getByTestId("player-preparing").count()) === 0, "準備中のまま");
  await shot("E06_エフェクトのかかった再生");
  await page.getByRole("button", { name: "停止", exact: true }).click();
});

await step("E07", "まとまりの設定を変えると、別の音を作る", async () => {
  await page.getByRole("button", { name: "▶ 再生" }).click();
  await page.getByRole("button", { name: "次へ" }).click();
  await page.waitForFunction(() => document.querySelector("audio").src.includes("effects-cache"), null, { timeout: 10000 });
  const before = await audioSrc();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await openManager();
  await page.getByLabel("2番目の増減").fill("-3");
  await save();
  await dialog().getByRole("button", { name: "閉じる" }).click();
  await page.getByRole("button", { name: "▶ 再生" }).click();
  await page.getByRole("button", { name: "次へ" }).click();
  await page.waitForFunction((b) => document.querySelector("audio").src.includes("effects-cache") && decodeURIComponent(document.querySelector("audio").src) !== b, before, {
    timeout: 10000,
  });
  await page.getByRole("button", { name: "停止", exact: true }).click();
});

await step("E08", "まとまりを削除すると、結び付けていた項目から外れる（確認に件数が出る）", async () => {
  await openManager();
  await dialog().getByRole("button", { name: "削除" }).click();
  await waitIdle();
  expect((await ui.lastConfirm()).includes("結び付けているプレイリストの項目1件から外れます"), await ui.lastConfirm());
  await dialog().getByRole("button", { name: "閉じる" }).click();
  const v = await page.getByLabel("chime.wavのエフェクト").inputValue();
  expect(v === "", `外れていない: ${v}`);
});

await ui.finish();
