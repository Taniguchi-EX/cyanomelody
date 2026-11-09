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
  await page.getByRole("button", { name: "再生を始める" }).click();
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
  expect(options.join(",") === "fx なし,新しいエフェクトセット,新しいfxを作る", options.join(","));
  // wav の項目にだけエフェクトセットを付ける（項目の並びは mp3、wav）
  await fx("chime.wav").selectOption({ label: "新しいエフェクトセット" });
  await waitIdle();
  await page.getByRole("button", { name: "再生を始める" }).click();
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
  // グレーアウトしている間は、かけている項目のエフェクトセットの名前を出し、説明に理由と名前を出す
  expect((await playerFx.locator("option:checked").innerText()) === "新しいエフェクトセット", `表示: ${await playerFx.locator("option:checked").innerText()}`);
  const overriddenTitle = await playerFx.getAttribute("title");
  expect(overriddenTitle.includes("プレイリストの項目のエフェクト（新しいエフェクトセット）"), overriddenTitle);
  await shot("E12_再生の欄のエフェクト");
  // グレーアウトしていても選び直せる。表示は項目のエフェクトセットのまま、項目のエフェクトのない曲に戻ると選んだものが出る
  await playerFx.selectOption({ label: "fx なし" });
  expect((await playerFx.locator("option:checked").innerText()) === "新しいエフェクトセット", "選び直すと表示が変わった");
  await page.getByRole("button", { name: "前へ" }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=player-fx]").dataset.overridden === "false", null, { timeout: 5000 });
  expect((await playerFx.locator("option:checked").innerText()) === "fx なし", `戻った後: ${await playerFx.locator("option:checked").innerText()}`);
  await playerFx.selectOption({ label: "新しいエフェクトセット" });
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
  // 再読み込み後も残る。「fx なし」に戻すと、項目のエフェクトのない曲にはかからない
  await ui.reload();
  expect((await playerFx.locator("option:checked").innerText()) === "新しいエフェクトセット", "再読み込みで消えた");
  await playerFx.selectOption({ label: "fx なし" });
  await page.locator(`[data-testid=playlist][data-playlist-name="シナリオ"] .tag-name`).click();
  await page.getByRole("button", { name: "再生を始める" }).click();
  await ui.waitPlaying();
  expect(!(await audioSrc()).includes("effects-cache"), `fx なし: ${await audioSrc()}`);
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
});

await step("E13", "再生の欄のエフェクトセットからも管理画面を開ける：「新しいfxを作る」で作ると再生の欄で選ばれ、「このfxを編集」（選んでいるときだけ）でそれを選んで開く。試聴は鳴らしている曲で", async () => {
  const playerFx = page.getByTestId("player-fx");
  const options = () => playerFx.locator("option").allInnerTexts().then((t) => t.join(","));
  // 「fx なし」のときは「このfxを編集」がない
  expect((await options()) === "fx なし,新しいエフェクトセット,新しいfxを作る", await options());
  // 何も鳴らしていないときは試聴できない
  await playerFx.selectOption({ label: "新しいfxを作る" });
  await dialog().waitFor({ timeout: 3000 });
  expect((await nameField().inputValue()).startsWith("新しいエフェクトセット"), `名前: [${await nameField().inputValue()}]`);
  expect(await page.getByRole("button", { name: "試聴", exact: true }).isDisabled(), "鳴らしていないのに試聴できる");
  await nameField().fill("再生の欄の fx");
  await addEffect("gain");
  await save();
  await close();
  expect((await playerFx.locator("option:checked").innerText()) === "再生の欄の fx", `選ばれない: ${await playerFx.locator("option:checked").innerText()}`);
  expect((await options()).endsWith("新しいfxを作る,このfxを編集"), await options());
  // 鳴らしている間に「このfxを編集」：そのエフェクトセットを選んで開き、鳴らしている曲で試聴できる
  await page.getByRole("button", { name: "再生を始める" }).click();
  await ui.waitPlaying();
  await playerFx.selectOption({ label: "このfxを編集" });
  await dialog().waitFor({ timeout: 3000 });
  expect((await chainItem("再生の欄の fx").getAttribute("class")).includes("active"), "そのエフェクトセットが選ばれていない");
  const previewButton = dialog().locator(".preview-button");
  expect(!(await previewButton.isDisabled()) && (await previewButton.innerText()).includes("chime.mp3"), await previewButton.innerText());
  await shot("E13_再生の欄から開いた管理画面");
  await close();
  // 開いても、再生の欄の選択は変わらない
  expect((await playerFx.locator("option:checked").innerText()) === "再生の欄の fx", "選択が変わった");
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
});

await step("E14", "簡易オフボーカル：追加するエフェクトにあり、消す強さ・下の周波数・上の周波数（最初は 100%・120Hz・9000Hz）を決められる。名前にマウスを乗せるとモノラルにかからないことが出る。試聴で鳴る", async () => {
  await openFrom("chime.wav", "新しいfxを作る");
  await nameField().fill("カラオケ");
  await addEffect("offVocal");
  expect((await steps()) === "offVocal", await steps());
  const step = page.getByTestId("effect-step").first();
  expect((await step.locator(".effect-label").innerText()) === "簡易オフボーカル", await step.locator(".effect-label").innerText());
  expect((await step.locator(".effect-label").getAttribute("title")).includes("モノラルの音にはかかりません"), "説明がない");
  expect((await page.getByLabel("1番目の消す強さ").inputValue()) === "100", await page.getByLabel("1番目の消す強さ").inputValue());
  expect((await page.getByLabel("1番目の下の周波数").inputValue()) === "120", await page.getByLabel("1番目の下の周波数").inputValue());
  expect((await page.getByLabel("1番目の上の周波数").inputValue()) === "9000", await page.getByLabel("1番目の上の周波数").inputValue());
  await page.getByLabel("1番目の消す強さ").fill("80");
  await save();
  const title = await chainItem("カラオケ").getAttribute("title");
  expect(title === "簡易オフボーカル 80% 120Hz〜9000Hz", title);
  await shot("E14_簡易オフボーカル");
  // 試聴：エフェクトをかけた音が鳴る（テストの音はモノラルでないもの・あるもののどちらでも鳴る）
  await page.locator(".preview-button").click();
  await page.waitForFunction(() => document.querySelector("audio").src.includes("effects-cache"), null, { timeout: 10000 });
  await page.locator(".preview-button").click();
  await close();
});

await step("E15", "入れ子で項目のエフェクトが2つかかる曲では、再生の欄に「内側 → 外側」の順で名前を出す", async () => {
  // 親のプレイリストに「シナリオ」を参照で入れ、その項目に「再生の欄の fx」を付ける（シナリオの chime.wav には「カラオケ」が付いている）
  await page.getByRole("button", { name: "プレイリストを作る" }).click();
  await page.getByLabel("新しいプレイリストの名前").fill("親");
  await page.getByLabel("新しいプレイリストの名前").press("Enter");
  await waitIdle();
  await page.locator(`[data-testid=playlist][data-playlist-name="親"] .tag-name`).click();
  await page.getByTestId("playlist-title").filter({ hasText: "親" }).waitFor({ timeout: 3000 });
  await page.getByLabel("加えるプレイリスト").selectOption({ label: "シナリオ" });
  await waitIdle();
  await fx("シナリオ").selectOption({ label: "再生の欄の fx" });
  await waitIdle();
  await page.getByRole("button", { name: "シナリオを再生" }).click();
  await ui.waitPlaying();
  // 項目の並びは mp3、wav。2曲目（chime.wav）へ
  await page.getByRole("button", { name: "次へ" }).click();
  const playerFx = page.getByTestId("player-fx");
  await page
    .waitForFunction(() => document.querySelector("[data-testid=player-fx] option:checked")?.textContent === "カラオケ → 再生の欄の fx", null, { timeout: 5000 })
    .catch(() => {});
  const shown = await playerFx.locator("option:checked").innerText();
  expect(shown === "カラオケ → 再生の欄の fx", `表示: ${shown}`);
  expect((await playerFx.getAttribute("title")).includes("カラオケ → 再生の欄の fx"), await playerFx.getAttribute("title"));
  await shot("E15_入れ子のエフェクト");
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
});

await ui.finish();
