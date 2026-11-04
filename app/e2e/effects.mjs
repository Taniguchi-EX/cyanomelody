// 「エフェクト」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/effects.mjs <テストデータ> <スクリーンショットの保存先>
// エフェクトセットの管理画面は、プレイリストの詳細画面の項目の fx のプルダウン（「新しいfxを作る」「このfxを編集」）から開く。
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("effects.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, status, waitIdle, addFolder } = ui;

const dialog = () => page.getByRole("dialog", { name: "エフェクトセットの管理" });
const chainItem = (name) => page.locator(`[data-testid=effect-chain][data-chain-name="${name}"]`);
const steps = () => page.getByTestId("effect-step").evaluateAll((els) => els.map((e) => e.dataset.kind).join(","));
const audioSrc = () => page.evaluate(() => decodeURIComponent(document.querySelector("audio").src));
/** 項目の fx のプルダウン */
const fx = (rel) => page.getByLabel(`${rel}のエフェクト`);
/** 項目の fx のプルダウンから、管理画面を開く（「新しいfxを作る」か「このfxを編集」）。試聴する曲を調べてから開くので、開くのを待つ */
async function openFrom(rel, label) {
  await fx(rel).selectOption({ label });
  await dialog().waitFor({ timeout: 3000 });
}
const nameField = () => page.getByLabel("エフェクトセットの名前", { exact: true });
const chainNames = () => page.getByTestId("effect-chain").evaluateAll((els) => els.map((e) => e.dataset.chainName));
async function addEffect(kind) {
  await page.getByLabel("追加するエフェクト").selectOption(kind);
  await page.getByRole("button", { name: "追加", exact: true }).click();
}
async function save() {
  await dialog().getByRole("button", { name: "保存" }).click();
  await waitIdle();
}
async function close() {
  await dialog().getByRole("button", { name: "閉じる" }).click();
  await dialog().waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
}

await step("E01", "準備：フォルダを登録し、プレイリストにファイルを2つ入れて開く。fx のプルダウンは「fx なし」で、最後に「新しいfxを作る」がある", async () => {
  await addFolder(formats);
  await page.getByRole("button", { name: "プレイリストを作る" }).click();
  await page.getByLabel("新しいプレイリストの名前").fill("シナリオ");
  await page.getByLabel("新しいプレイリストの名前").press("Enter");
  await waitIdle();
  await ui.check("chime.wav");
  await ui.check("chime.mp3");
  await ui.dragChecked(page.locator('[data-testid=playlist][data-playlist-name="シナリオ"]'));
  await ui.clearChecks();
  await page.locator(`[data-testid=playlist][data-playlist-name="シナリオ"] .tag-name`).click();
  await fx("chime.wav").waitFor({ timeout: 3000 });
  const options = await fx("chime.wav").locator("option").allInnerTexts();
  expect(options.join(",") === "fx なし,新しいfxを作る", options.join(","));
  // 左の欄に「エフェクト」ボタンはない
  expect((await page.getByRole("button", { name: "エフェクトセットを管理" }).count()) === 0, "エフェクトのボタンが残っている");
});

await step("E02", "「新しいfxを作る」で、保存していない空のエフェクトセット（「新しいエフェクトセット」）が出る。保存すると一覧に加わって選ばれ、その項目に付く。エフェクトを追加・並べ替えできる", async () => {
  await openFrom("chime.wav", "新しいfxを作る");
  // 保存するまでは一覧に加えない。名前は「新しいエフェクトセット」、中は空
  expect((await nameField().inputValue()) === "新しいエフェクトセット", `名前: [${await nameField().inputValue()}]`);
  expect((await chainNames()).length === 0, `一覧: [${(await chainNames()).join(",")}]`);
  expect((await steps()) === "", `中: [${await steps()}]`);
  // 「元に戻す」はない
  expect((await dialog().getByRole("button", { name: "元に戻す" }).count()) === 0, "元に戻すが残っている");
  await nameField().fill("強めの残響");
  // 「音量調整（自動）」は「ノーマライズ」と書く
  const kinds = await page.getByLabel("追加するエフェクト").locator("option").allInnerTexts();
  expect(kinds.includes("ノーマライズ") && !kinds.some((k) => k.includes("自動")), kinds.join(","));
  await addEffect("gain");
  await addEffect("reverb");
  await page.getByRole("button", { name: "2番目を上へ" }).click();
  expect((await steps()) === "reverb,gain", await steps());
  await page.getByLabel("2番目の増減").fill("-6");
  await page.getByLabel("1番目の混ぜる割合").fill("50");
  // 「↑」「↓」「✕」は行の右端に寄せる
  const right = await page.getByTestId("effect-step").first().evaluate((li) => {
    const actions = li.querySelector(".effect-actions").getBoundingClientRect();
    return Math.round(li.getBoundingClientRect().right - actions.right);
  });
  expect(right <= 10, `右に寄っていない: ${right}px`);
  await save();
  expect((await status()).includes("保存しました"), await status());
  expect((await chainItem("強めの残響").getAttribute("class")).includes("active"), "作ったエフェクトセットが選ばれない");
  const title = await chainItem("強めの残響").getAttribute("title");
  expect(title === "リバーブ 1.5秒 50% → 音量調整 -6dB", title);
  await shot("E02_管理画面");
  await close();
  // 作ったエフェクトセットは、開いた元の項目に付く。プルダウンの色は、付いていない項目と変わらない
  const chosen = await fx("chime.wav").evaluate((s) => s.selectedOptions[0].text);
  expect(chosen === "強めの残響", chosen);
  const bg = (rel) => fx(rel).evaluate((s) => getComputedStyle(s).backgroundColor + getComputedStyle(s).color);
  expect((await bg("chime.wav")) === (await bg("chime.mp3")), `色が変わる: ${await bg("chime.wav")} / ${await bg("chime.mp3")}`);
});

await step("E04", "「このfxを編集」でそのエフェクトセットを選んで開く。保存していない変更があるときは、閉じる前に確かめる（キャンセルで残る）", async () => {
  await openFrom("chime.wav", "このfxを編集");
  await dialog().waitFor({ timeout: 3000 });
  expect((await chainItem("強めの残響").getAttribute("class")).includes("active"), "そのエフェクトセットが選ばれていない");
  await addEffect("fadeIn");
  await ui.setConfirmReply(false);
  await ui.confirmed(() => page.keyboard.press("Escape"));
  expect((await dialog().count()) === 1, "閉じた");
  expect((await ui.lastConfirm()).includes("保存していない変更"), await ui.lastConfirm());
  await ui.setConfirmReply(true);
  await close();
  expect((await dialog().count()) === 0, "閉じない");
  await openFrom("chime.wav", "このfxを編集");
  expect((await steps()) === "reverb,gain", `捨てた変更が残っている: ${await steps()}`);
});

await step("E05", "開いた元の項目の曲にかけて試聴できる（エフェクトをかけた音が鳴る）", async () => {
  const button = dialog().getByRole("button", { name: "試聴", exact: true });
  expect((await button.innerText()).includes("chime.wav"), await button.innerText());
  await button.click();
  await page.waitForFunction(() => document.querySelector("audio").src.includes("effects-cache"), null, { timeout: 10000 });
  expect(!(await page.evaluate(() => document.querySelector("audio").paused)), "鳴っていない");
  await dialog().getByRole("button", { name: "試聴を止める" }).click();
  await close();
});

await step("E06", "エフェクトセットを付けた項目だけ、エフェクトのかかった音で再生される", async () => {
  // 項目の並びはファイルの一覧の順（mp3、wav）
  await page.getByRole("button", { name: "順に再生" }).click();
  await ui.waitPlaying();
  expect(!(await audioSrc()).includes("effects-cache"), `エフェクトのない曲: ${await audioSrc()}`);
  await page.getByRole("button", { name: "次へ" }).click();
  await page.waitForFunction(() => document.querySelector("audio").src.includes("effects-cache"), null, { timeout: 10000 });
  expect((await page.getByTestId("player-preparing").count()) === 0, "準備中のまま");
  await shot("E06_エフェクトのかかった再生");
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
});

await step("E10", "チェックした項目の fx を変えると、チェックした項目すべての fx が同じになる", async () => {
  for (const rel of ["chime.mp3", "chime.wav"]) {
    await page.getByTestId("playlist-item").filter({ hasText: rel }).getByTestId("item-check").check();
  }
  await fx("chime.wav").selectOption({ label: "fx なし" });
  await waitIdle();
  expect((await fx("chime.mp3").inputValue()) === "" && (await fx("chime.wav").inputValue()) === "", "まとめて外れない");
  await fx("chime.mp3").selectOption({ label: "強めの残響" });
  await waitIdle();
  for (const rel of ["chime.mp3", "chime.wav"]) {
    const chosen = await fx(rel).evaluate((s) => s.selectedOptions[0].text);
    expect(chosen === "強めの残響", `${rel}: ${chosen}`);
  }
  await page.getByRole("button", { name: "チェックをすべて外す" }).click();
});

await step("E08", "エフェクトセットを削除すると、付けていた項目から外れる（確認に件数が出る）", async () => {
  await openFrom("chime.wav", "このfxを編集");
  await dialog().getByRole("button", { name: "削除" }).click();
  await waitIdle();
  expect((await ui.lastConfirm()).includes("結び付けているプレイリストの項目2件から外れます"), await ui.lastConfirm());
  await close();
  for (const rel of ["chime.mp3", "chime.wav"]) {
    expect((await fx(rel).inputValue()) === "", `${rel}から外れていない`);
  }
});

await step("E09", "試聴中に値を変えると、試聴を押し直さなくても鳴らし直す。保存していないときは保存が目立つ", async () => {
  await openFrom("chime.wav", "新しいfxを作る");
  await addEffect("gain");
  const saveButton = dialog().getByRole("button", { name: "保存" });
  expect((await saveButton.getAttribute("class")).includes("primary"), "保存が目立たない");
  const button = dialog().getByRole("button", { name: "試聴", exact: true });
  await button.click();
  await page.waitForFunction(() => document.querySelector("audio").src.includes("effects-cache"), null, { timeout: 10000 });
  const before = await audioSrc();
  await page.getByLabel("1番目の増減").fill("-9");
  await page.waitForFunction((b) => decodeURIComponent(document.querySelector("audio").src) !== b, before, { timeout: 10000 });
  expect((await audioSrc()).includes("effects-cache"), await audioSrc());
  await dialog().getByRole("button", { name: "試聴を止める" }).click();
  expect(await page.evaluate(() => document.querySelector("audio").paused), "止まらない");
  await save();
  expect(!((await saveButton.getAttribute("class")) ?? "").includes("primary"), "保存の後も目立つ");
  // 名前を変えずに保存したので「新しいエフェクトセット」で一覧に加わる
  expect((await chainNames()).join(",") === "新しいエフェクトセット", (await chainNames()).join(","));
  await close();
});

await step("E11", "「新しいエフェクトセット」がすでにあるときは「新しいエフェクトセット(2)」になる。保存せずに閉じると確かめ、一覧には加わらない", async () => {
  await openFrom("chime.mp3", "新しいfxを作る");
  expect((await nameField().inputValue()) === "新しいエフェクトセット(2)", await nameField().inputValue());
  await ui.setConfirmReply(true);
  await close();
  expect((await ui.lastConfirm()).includes("保存していない変更"), await ui.lastConfirm());
  expect((await dialog().count()) === 0, "閉じない");
  // 項目の fx は今のまま（付いていない）
  expect((await fx("chime.mp3").inputValue()) === "", "閉じたのに付いた");
  await openFrom("chime.wav", "このfxを編集");
  expect((await chainNames()).join(",") === "新しいエフェクトセット", (await chainNames()).join(","));
  await close();
});

await step("E12", "再生の欄のエフェクトセット：項目のエフェクトがない曲にかかり、選び直すと鳴らしている曲にすぐかかる。項目のエフェクトがかかる曲ではグレーアウト。選んだものは再読み込み後も残る", async () => {
  const playerFx = page.getByTestId("player-fx");
  expect((await playerFx.inputValue()) === "", `最初の選択 ${await playerFx.inputValue()}`);
  const options = await playerFx.locator("option").allInnerTexts();
  expect(options.join(",") === "fx なし,新しいエフェクトセット", options.join(","));
  // wav の項目にだけエフェクトセットを付ける（項目の並びは mp3、wav）
  await fx("chime.wav").selectOption({ label: "新しいエフェクトセット" });
  await waitIdle();
  await page.getByRole("button", { name: "順に再生" }).click();
  await ui.waitPlaying();
  expect(!(await audioSrc()).includes("effects-cache"), `選ぶ前: ${await audioSrc()}`);
  // 鳴らしている間に選ぶと、その曲にすぐかかる
  await playerFx.selectOption({ label: "新しいエフェクトセット" });
  await page.waitForFunction(() => document.querySelector("audio").src.includes("effects-cache"), null, { timeout: 10000 });
  expect((await page.getByTestId("player-position").innerText()) === "1/2", await page.getByTestId("player-position").innerText());
  expect((await playerFx.getAttribute("data-overridden")) === "false", "項目のエフェクトのない曲でグレーアウトしている");
  // 項目のエフェクトがかかる曲ではグレーアウトする
  await page.getByRole("button", { name: "次へ" }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=player-fx]").dataset.overridden === "true", null, { timeout: 5000 });
  expect((await playerFx.evaluate((e) => getComputedStyle(e).opacity)) !== "1", "薄くない");
  await shot("E12_再生の欄のエフェクト");
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
  // 再読み込み後も残る。「fx なし」に戻すと、項目のエフェクトのない曲にはかからない
  await ui.reload();
  expect((await playerFx.locator("option:checked").innerText()) === "新しいエフェクトセット", "再読み込みで消えた");
  await playerFx.selectOption({ label: "fx なし" });
  await page.locator(`[data-testid=playlist][data-playlist-name="シナリオ"] .tag-name`).click();
  await page.getByRole("button", { name: "順に再生" }).click();
  await ui.waitPlaying();
  expect(!(await audioSrc()).includes("effects-cache"), `fx なし: ${await audioSrc()}`);
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
});

await ui.finish();
