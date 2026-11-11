// 「設定画面」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/settings.mjs <テストデータ> <スクリーンショットの保存先>
import fs from "node:fs";
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("settings.mjs");
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

await step("S01", "再生の欄の右端の歯車で設定画面が開き、「一般」「データ」「バージョンとライセンス」のタブが並ぶ（最初は一般）。Esc で閉じる", async () => {
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
  expect(tabs.join(",") === "一般,表示,データ,バージョンとライセンス", tabs.join(","));
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

await step("S04", "データ：選んだ項目を JSON に書き出し、取り込める。取り込む前に中身と見つかる曲の数を出す。「置き換える」は確かめてから今のデータを消し、「足す」は同じ名前のプレイリストを「(2)」で作る", async () => {
  const file = path.join(shotDir, "export.json");
  const playlistItem = (name) => page.locator(`[data-testid=playlist][data-playlist-name="${name}"]`);
  // 準備：フォルダ、タグ、プレイリスト
  await ui.addFolder(path.join(dataDir, "formats"));
  await ui.row("chime.wav").click();
  await ui.addTag("雨");
  await page.getByRole("button", { name: "プレイリストを作る" }).click();
  await page.getByLabel("新しいプレイリストの名前").fill("シーン");
  await page.getByLabel("新しいプレイリストの名前").press("Enter");
  await waitIdle();
  await ui.check("chime.wav");
  await ui.dragChecked(playlistItem("シーン"));
  await ui.clearChecks();
  // エクスポート（すべての項目）
  await openSettings();
  await tab("データ").click();
  await ui.setDialogReply(file);
  await page.getByRole("button", { name: "エクスポート…" }).click();
  await page.getByTestId("export-result").waitFor({ timeout: 5000 });
  const exported = await page.getByTestId("export-result").innerText();
  expect(exported.includes("曲 5件") && exported.includes("プレイリスト 1件"), exported);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(json.app === "cyanomelody" && json.formatVersion === 1 && json.files.length === 5, `ファイル ${json.app} ${json.files?.length}`);
  await closeSettings();
  // 書き出した後にタグを増やす
  await ui.createTags(["あとで作った"]);
  // 取り込む前に、中身と見つかる曲の数を出す。ファイルにある項目は最初からすべて選んでいる
  await openSettings();
  await tab("データ").click();
  await page.getByRole("button", { name: "ファイルを選ぶ…" }).click();
  await page.getByTestId("import-preview").waitFor({ timeout: 5000 });
  const match = await page.getByTestId("import-match").innerText();
  expect(match.includes("曲 5件のうち、このPCで見つかる曲 5件") && match.includes("パス 5"), match);
  expect(await page.getByLabel("インポート：タグ（階層・並び順・色と、曲へのタグ付け）").isChecked(), "タグが選ばれていない");
  await shot("S04_インポートの見込み");
  // 置き換える（タグだけ）：確かめてから、今のタグを消してファイルのとおりにする
  for (const label of ["ライブラリ（登録したフォルダ）", "プレイリストとエフェクト", "出典・ライセンスと設定（新しく作るタグの既定値、音量などの画面の設定）"]) {
    await page.getByLabel(`インポート：${label}`).uncheck();
  }
  await page.getByLabel("選んだ項目を置き換える").check();
  await ui.setConfirmReply(true);
  await ui.confirmed(() => page.getByRole("button", { name: "取り込む" }).click());
  expect((await ui.lastConfirm()).includes("タグ 4件"), (await ui.lastConfirm()).replace(/\n/g, " / "));
  await page.getByTestId("import-result").waitFor({ timeout: 5000 });
  const result = await page.getByTestId("import-result").innerText();
  expect(result.includes("見つかった 5件") && result.includes("タグ付け 1件"), result);
  await shot("S04_インポートの結果");
  await closeSettings();
  await waitIdle();
  // 書き出した後に作ったタグは消え、書き出したタグ（S02 で作ったものと「雨」）に戻る
  const tags = await ui.tagNames();
  expect(tags.join(",") === "前からある,後から作った,雨", `タグ ${tags.join(",")}`);
  expect((await ui.row("chime.wav").locator(".tag-chip").allInnerTexts()).join(",") === "雨", "タグ付けが戻らない");
  // 足す（プレイリスト）：同じ名前は「(2)」で作る
  await openSettings();
  await tab("データ").click();
  await page.getByRole("button", { name: "ファイルを選ぶ…" }).click();
  await page.getByTestId("import-preview").waitFor({ timeout: 5000 });
  for (const label of ["ライブラリ（登録したフォルダ）", "タグ（階層・並び順・色と、曲へのタグ付け）", "出典・ライセンスと設定（新しく作るタグの既定値、音量などの画面の設定）"]) {
    await page.getByLabel(`インポート：${label}`).uncheck();
  }
  await page.getByRole("button", { name: "取り込む" }).click();
  await page.getByTestId("import-result").waitFor({ timeout: 5000 });
  await closeSettings();
  await waitIdle();
  expect((await playlistItem("シーン(2)").count()) === 1, "シーン(2) ができない");
  await ui.setDialogReply(undefined);
});

await step("S05", "データ：cyanomelody のものでないファイルは取り込まず、エラーを出す", async () => {
  const file = path.join(shotDir, "other.json");
  fs.writeFileSync(file, JSON.stringify({ hello: "world" }));
  await openSettings();
  await tab("データ").click();
  await ui.setDialogReply(file);
  await page.getByRole("button", { name: "ファイルを選ぶ…" }).click();
  await ui.waitStatus("cyanomelody のデータ");
  expect((await page.getByTestId("import-preview").count()) === 0, "見込みが出た");
  await ui.setDialogReply(undefined);
  await tab("一般").click();
  await closeSettings();
});

await step("S06", "データ：「スマホへコピー…」で、USB でつないだスマホを探す。見つからなければ「ファイル転送」を選ぶよう案内し、見つかれば写すものの数を確かめる（ここではキャンセルする）", async () => {
  await openSettings();
  await tab("データ").click();
  await page.getByTestId("phone-copy").waitFor({ timeout: 3000 });
  await ui.setConfirmReply(false);
  const confirms = () => page.evaluate(() => window.__confirms.length);
  const before = await confirms();
  await page.getByTestId("phone-find").click();
  // テストの PC にスマホがつながっていれば確認が出る（キャンセル）。つながっていなければ案内が出る
  const none = page.getByTestId("phone-none");
  for (let i = 0; i < 300 && !(await none.count()) && (await confirms()) === before; i++) await page.waitForTimeout(100);
  if (await none.count()) {
    expect((await none.innerText()).includes("ファイル転送"), await none.innerText());
  } else {
    const asked = await ui.lastConfirm();
    expect(asked.includes("Music/cyanomelody") && asked.includes("写す曲"), asked.replace(/\n/g, " / "));
  }
  await shot("S06_スマホへコピー");
  await closeSettings();
});

await ui.finish();
