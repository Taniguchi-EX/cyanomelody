// 「ファイル内の情報による自動タグ付け」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/autotag.mjs <テストデータ> <スクリーンショットの保存先>
// テストデータの meta/：m1.mp3（アーティスト・アルバム・ジャンル Rock・作曲者）、m2.mp3（アーティスト Unknown・アルバム）、
// m3.flac（ジャンル Other・作曲者）、m4.wav（情報なし）、m5.mp3（アーティスト「歌手A feat. 歌手B」・作曲者「作曲家A / 作曲家B」）
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("autotag.mjs");
const ui = await connect(shotDir);
const { page, step, shot, status, row, tagItem, waitIdle } = ui;

const dialog = () => page.getByTestId("autotag-dialog");
const ignoreValues = () => dialog().getByTestId("ignore-values").locator("li").evaluateAll((ls) => ls.map((l) => l.dataset.value));
const tree = () => page.getByTestId("tag").evaluateAll((rows) => rows.map((r) => `${r.dataset.tagName}:${r.dataset.depth}`).join(" "));
const tagsOf = (rel) => row(rel).locator(".tag-chip").allInnerTexts();
async function openFromDetail(rel) {
  await row(rel).click();
  await page.getByTestId("detail-panel").getByRole("button", { name: "ファイルの情報からタグを付ける" }).click();
  await dialog().waitFor({ timeout: 3000 });
}

await step("A01", "ファイルの詳細の「ファイルの情報からタグを付ける」：確認のダイアログ（以下の値は無視する：ON、初期値の一覧）を出し、アーティスト・アルバム・ジャンル・作曲者の親のタグの下にタグを付ける", async () => {
  await ui.addFolder(path.join(dataDir, "meta"));
  await openFromDetail("m1.mp3");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=ignore-values] li").length === 3, null, { timeout: 3000 });
  expect((await dialog().innerText()).includes("このファイルの情報を読み"), await dialog().innerText());
  expect(await dialog().getByLabel("以下の値は無視する").isChecked(), "最初が ON でない");
  expect((await ignoreValues()).join(",") === "Unknown,アーティスト情報なし,Other", (await ignoreValues()).join(","));
  await shot("A01_確認のダイアログ");
  // やめると何もしない
  await dialog().getByRole("button", { name: "やめる" }).click();
  expect((await ui.tagNames()).length === 0, "やめたのにタグができた");
  await openFromDetail("m1.mp3");
  await dialog().getByRole("button", { name: "タグを付ける" }).click();
  await waitIdle();
  expect(
    (await status()) === "アーティスト：テストアーティスト、アルバム：テストアルバム、ジャンル：Rock、作曲者：作曲家A を付けました",
    await status(),
  );
  expect(
    (await tree()) === "アーティスト:0 テストアーティスト:1 アルバム:0 テストアルバム:1 ジャンル:0 Rock:1 作曲者:0 作曲家A:1",
    await tree(),
  );
  // 何度行っても増えない
  await openFromDetail("m1.mp3");
  await dialog().getByRole("button", { name: "タグを付ける" }).click();
  await waitIdle();
  expect((await status()).includes("付けるタグはもう付いています"), await status());
});

await step("A02", "無視する値の一覧：＋で加え、✎で直し、−で消す。空・重なる値は入れられない。閉じて開き直しても残る", async () => {
  await openFromDetail("m4.wav");
  await dialog().getByRole("button", { name: "無視する値を加える" }).click();
  await dialog().getByLabel("加える無視する値").fill("unknown");
  await dialog().getByLabel("加える無視する値").press("Enter");
  expect((await dialog().getByTestId("ignore-values-error").innerText()).includes("もう一覧にあります"), "重なる値が入った");
  await dialog().getByLabel("加える無視する値").fill("情報なし");
  await dialog().getByLabel("加える無視する値").press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=ignore-values] li").length === 4, null, { timeout: 3000 });
  expect((await ignoreValues()).join(",") === "Unknown,アーティスト情報なし,Other,情報なし", (await ignoreValues()).join(","));
  // ✎で直す（Esc は編集だけやめ、ダイアログは閉じない）
  await dialog().getByRole("button", { name: "情報なしを編集", exact: true }).click();
  await dialog().getByLabel("情報なしの新しい値").fill("消す前");
  await dialog().getByLabel("情報なしの新しい値").press("Escape");
  expect((await dialog().count()) === 1 && (await ignoreValues()).at(-1) === "情報なし", "Esc で閉じた・変わった");
  await dialog().getByRole("button", { name: "情報なしを編集", exact: true }).click();
  await dialog().getByLabel("情報なしの新しい値").fill("ジャンル情報なし");
  await dialog().getByLabel("情報なしの新しい値").press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=ignore-values] li")].at(-1)?.dataset.value === "ジャンル情報なし", null, { timeout: 3000 });
  await shot("A02_無視する値の一覧");
  // 閉じて開き直しても残る。−で消す
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 3000 });
  await openFromDetail("m4.wav");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=ignore-values] li").length === 4, null, { timeout: 3000 });
  expect((await ignoreValues()).join(",") === "Unknown,アーティスト情報なし,Other,ジャンル情報なし", (await ignoreValues()).join(","));
  await dialog().getByRole("button", { name: "ジャンル情報なしを消す", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=ignore-values] li").length === 3, null, { timeout: 3000 });
  // 情報のないファイル
  await dialog().getByRole("button", { name: "タグを付ける" }).click();
  await waitIdle();
  expect((await status()).includes("タグにできる情報はありませんでした"), await status());
});

await step("A03", "一括操作の欄の「ファイルの情報からタグを付ける」：確かめてから裏で行い、下の行に結果を出す。無視する値（Unknown・Other）は使わない", async () => {
  for (const rel of ["m1.mp3", "m2.mp3", "m3.flac", "m4.wav"]) await ui.check(rel);
  await page.getByRole("button", { name: "一括操作" }).click();
  await page.getByTestId("bulk-panel").getByRole("button", { name: "ファイルの情報からタグを付ける" }).click();
  await dialog().waitFor({ timeout: 3000 });
  expect((await dialog().innerText()).includes("4件のファイルの情報を読み"), await dialog().innerText());
  await dialog().getByRole("button", { name: "タグを付ける" }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=autotag-status]")?.textContent.includes("タグを付けました"), null, { timeout: 15000 });
  await waitIdle();
  const result = await page.getByTestId("autotag-status").innerText();
  // m2（アルバム）と m3（作曲者）に新しく付く。m1 はもう付いている、m4 は情報なし
  expect(result.includes("読んだファイル 4件") && result.includes("タグを付けたファイル 2件") && result.includes("情報がなかったファイル 1件"), result);
  await shot("A03_一括操作の結果");
  expect((await tagsOf("m2.mp3")).join(",") === "テストアルバム", `m2 ${(await tagsOf("m2.mp3")).join(",")}`);
  expect((await tagsOf("m3.flac")).join(",") === "作曲家A", `m3 ${(await tagsOf("m3.flac")).join(",")}`);
  expect(!(await ui.tagNames()).includes("Unknown") && !(await ui.tagNames()).includes("Other"), "無視する値のタグができた");
  await page.getByRole("button", { name: "一括操作" }).click();
  await ui.clearChecks();
});

await step("A04", "「以下の値は無視する」を外すと、一覧の値もタグにする", async () => {
  await openFromDetail("m2.mp3");
  await dialog().getByLabel("以下の値は無視する").uncheck();
  await dialog().getByRole("button", { name: "タグを付ける" }).click();
  await waitIdle();
  expect((await status()) === "アーティスト：Unknown を付けました", await status());
  expect((await tagItem("Unknown").getAttribute("data-depth")) === "1", "アーティストの下にない");
});

await step("A05", "アーティスト・作曲者は区切り文字（最初は , / ／ feat. with &）で分けてタグにする。区切り文字の一覧は無視する値と同じく編集できる。「以下の文字で区切る」を外すと分けない", async () => {
  const separators = () => dialog().getByTestId("separator-values").locator("li").evaluateAll((ls) => ls.map((l) => l.dataset.value));
  const box = () => dialog().getByTestId("separator-values-box");
  await openFromDetail("m5.mp3");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=separator-values] li").length === 6, null, { timeout: 3000 });
  expect((await separators()).join(" ") === ", / ／ feat. with &", (await separators()).join(" "));
  expect(await dialog().getByLabel("以下の文字で区切る（アーティスト・作曲者）").isChecked(), "最初が ON でない");
  // 一覧に加えて消す（無視する値と同じ）
  await box().getByRole("button", { name: "区切り文字を加える" }).click();
  await dialog().getByLabel("加える区切り文字").fill("×");
  await dialog().getByLabel("加える区切り文字").press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=separator-values] li").length === 7, null, { timeout: 3000 });
  await shot("A05_区切り文字の一覧");
  await box().getByRole("button", { name: "×を消す", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=separator-values] li").length === 6, null, { timeout: 3000 });
  await dialog().getByRole("button", { name: "タグを付ける" }).click();
  await waitIdle();
  // 作曲家A は今あるタグを付ける
  expect((await status()) === "アーティスト：歌手A、アーティスト：歌手B、作曲者：作曲家A、作曲者：作曲家B を付けました", await status());
  // 区切らなければ、値のままのタグ
  await openFromDetail("m5.mp3");
  await dialog().getByLabel("以下の文字で区切る（アーティスト・作曲者）").uncheck();
  await dialog().getByRole("button", { name: "タグを付ける" }).click();
  await waitIdle();
  expect((await status()) === "アーティスト：歌手A feat. 歌手B、作曲者：作曲家A / 作曲家B を付けました", await status());
});

await ui.finish();
