// 「ハッシュ値を使った機能」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/hash-features.mjs <テストデータ> <スクリーンショットの保存先>
import fs from "node:fs";
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("hash-features.mjs");
const hashDir = path.join(dataDir, "hash");
const outside = path.join(dataDir, "outside");
// リンク切れのテスト（H11〜H15）で作るフォルダ。前に途中で止まって残っていると件数が変わるので、最初に消す
const linkDir = path.join(hashDir, "link");
const searchDir = path.join(dataDir, "link_search");
const emptyDir = path.join(dataDir, "link_empty");
// まとめての操作のテスト（H16）で作るフォルダ
const bulkDir = path.join(dataDir, "link_bulk");
const bulkSearch = path.join(dataDir, "link_bulk_search");
for (const dir of [linkDir, searchDir, emptyDir, bulkDir, bulkSearch]) fs.rmSync(dir, { recursive: true, force: true });

const ui = await connect(shotDir);
const { page, step, shot, status, fileCount, row, waitIdle, addFolder, clearFilter, addTag } = ui;

const hashStatus = () => page.getByTestId("hash-status").innerText();
const currentHashStatus = () =>
  page.evaluate(() => document.querySelector("[data-testid=hash-status]")?.textContent ?? "");
/** action を行い、ハッシュ値の計算が終わる（表示が前と変わって「計算しました」か「中止しました」になる）のを待つ */
async function hashingAfter(action) {
  const before = await currentHashStatus();
  await action();
  await page.waitForFunction(
    (before) => {
      const t = document.querySelector("[data-testid=hash-status]")?.textContent ?? "";
      return t !== before && (t.includes("計算しました") || t.includes("中止しました"));
    },
    before,
    { timeout: 120000 },
  );
  await page.waitForTimeout(500);
}
async function scan() {
  await page.getByTestId("folder").first().getByRole("button", { name: "スキャン", exact: true }).click();
  await waitIdle();
}
const selectedHash = () => page.getByTestId("selected-hash").innerText();
/** 名前に name を含むフォルダの行の「⟳」でスキャンする */
async function scanFolder(name) {
  await page.getByTestId("folder").filter({ hasText: name }).getByRole("button", { name: "スキャン", exact: true }).click();
  await waitIdle();
}
/** 検索の欄に入れて、一覧をその名前のファイルに絞る（3万件のフォルダがあると、後ろの行は描かれないため） */
async function search(text) {
  await ui.filtered(() => page.getByLabel("ファイル名で検索", { exact: true }).fill(text));
}
const tagsOf = (rel) => row(rel).locator(".chip").allInnerTexts();

await step("H01", "フォルダを登録すると、ハッシュ値の計算が自動で始まり、終わると件数が出る", async () => {
  await hashingAfter(() => addFolder(hashDir));
  const s = await hashStatus();
  expect(s.includes("ハッシュ値を計算しました（5件、計算できなかったファイル 1件）"), s);
});

await step("H02", "1件選ぶとハッシュ値が出る。計算できなかったファイルは理由が出て、探すボタンが押せない", async () => {
  await row("se1.mp3").click();
  const h = await selectedHash();
  expect(/^[0-9a-f]{64}$/.test(h.trim()), h);
  await row("broken.wav").click();
  const broken = await selectedHash();
  expect(broken.includes("計算できませんでした"), broken);
  expect(await page.getByRole("button", { name: "同じ音声のファイルを探す" }).isDisabled(), "押せる");
});

await step("H04", "重複しているファイルだけに絞り込める（タグだけ違うファイルも重複になる）", async () => {
  await ui.filtered(() => ui.otherItem("duplicatesOnly").click());
  expect((await fileCount()) === 3, `件数 ${await fileCount()}`);
  for (const rel of ["se1.mp3", "dup/se1_copy.mp3", "se1_retag.mp3"]) {
    expect((await row(rel).count()) === 1, `${rel}がない`);
  }
  // 同じ音声のファイルは同じ色の印
  const marks = page.locator("[data-testid=file-row] .hash");
  const hashes = await marks.evaluateAll((els) => els.map((e) => e.dataset.hash));
  const colors = await marks.evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
  expect(hashes.length === 3 && new Set(hashes).size === 1 && hashes[0].length === 64, `ハッシュ値 ${hashes.join(",")}`);
  expect(new Set(colors).size === 1, `色 ${colors.join(",")}`);
  await shot("H04_重複");
  await clearFilter();
});

await step("H05", "選んだファイルと同じ音声のファイルを探せる", async () => {
  await row("se1_retag.mp3").click();
  await ui.filtered(() => page.getByRole("button", { name: "同じ音声のファイルを探す" }).click());
  expect((await fileCount()) === 3, `件数 ${await fileCount()}`);
  expect((await page.getByTestId("hash-filter").count()) === 1, "絞り込み中の表示がない");
  await clearFilter();
  expect((await page.getByTestId("hash-filter").count()) === 0, "解除されない");
  expect((await fileCount()) === 5, `解除後 ${await fileCount()}`);
});

await step("H08", "移動したファイルに、見つからないファイルのタグをひも付け直せる", async () => {
  await row("se2.wav").click();
  await addTag("ひも付けテスト");
  fs.mkdirSync(path.join(hashDir, "moved"), { recursive: true });
  fs.renameSync(path.join(hashDir, "se2.wav"), path.join(hashDir, "moved", "se2_moved.wav"));
  await hashingAfter(scan);
  expect((await row("se2.wav").locator(".warn").count()) === 1, "見つからない印がない");
  expect((await row("moved/se2_moved.wav").locator(".chip").count()) === 0, "移動先に最初からタグがある");
  await row("se2.wav").click();
  await page.getByRole("button", { name: "ひも付け直す" }).click();
  await waitIdle();
  const s = await status();
  expect(s.includes("ひも付け直した 1件"), s);
  expect((await row("se2.wav").count()) === 0, "見つからないファイルが残っている");
  const chips = await row("moved/se2_moved.wav").locator(".chip").allInnerTexts();
  expect(chips.includes("ひも付けテスト"), `移動先のタグ ${chips.join(",")}`);
  await shot("H08_ひも付け直し後");
  fs.renameSync(path.join(hashDir, "moved", "se2_moved.wav"), path.join(hashDir, "se2.wav"));
});

// ===== リンク切れのファイルを、選んだファイル・フォルダからひも付ける =====

await step("H11", "「ファイルを紐づける」：ライブラリの中のファイルを選ぶと、タグなどがそのファイルに移る（ハッシュ値は比べない）", async () => {
  fs.mkdirSync(path.join(linkDir, "moved"), { recursive: true });
  fs.copyFileSync(path.join(hashDir, "se2.wav"), path.join(linkDir, "l1.wav"));
  await hashingAfter(() => scanFolder("hash"));
  await search("l1");
  await row("link/l1.wav").click();
  await addTag("紐づけ");
  fs.renameSync(path.join(linkDir, "l1.wav"), path.join(linkDir, "moved", "l1_moved.wav"));
  await scanFolder("hash");
  await search("l1");
  await row("link/l1.wav").click();
  const buttons = page.getByTestId("detail-panel");
  expect((await buttons.getByRole("button", { name: "ファイルを紐づける" }).count()) === 1, "ボタンがない");
  await shot("H11_リンク切れの操作");
  await ui.setDialogReply(path.join(linkDir, "moved", "l1_moved.wav"));
  await buttons.getByRole("button", { name: "ファイルを紐づける" }).click();
  await waitIdle();
  expect((await status()).includes("ひも付けました"), await status());
  expect((await row("link/l1.wav").count()) === 0, "リンク切れのファイルが残っている");
  expect((await tagsOf("link/moved/l1_moved.wav")).includes("紐づけ"), "タグが移らない");
});

await step("H12", "「ファイルを紐づける」：ライブラリの外のファイルを選ぶと、そのフォルダを登録してからひも付ける", async () => {
  fs.rmSync(path.join(linkDir, "moved", "l1_moved.wav"));
  await scanFolder("hash");
  await search("l1");
  await row("link/moved/l1_moved.wav").click();
  const folders = await page.getByTestId("folder").count();
  await ui.setDialogReply(path.join(outside, "se2_outside.wav"));
  await page.getByRole("button", { name: "ファイルを紐づける" }).click();
  await waitIdle();
  const s = await status();
  expect(s.includes("ライブラリに登録し") && s.includes("outside"), s);
  expect((await page.getByTestId("folder").count()) === folders + 1, "フォルダが登録されない");
  await search("se2_outside");
  expect((await tagsOf("se2_outside.wav")).includes("紐づけ"), "タグが移らない");
  await search("l1");
  expect((await row("link/moved/l1_moved.wav").count()) === 0, "リンク切れのファイルが残っている");
  await ui.waitHashing();
});

await step("H13", "「指定フォルダから自動で探す」：見つからなければ知らせ、見つかればフォルダを登録してひも付ける。ハッシュ値のないリンク切れのファイルでは押せない", async () => {
  const original = path.join(outside, "se2_outside.wav");
  const renamed = path.join(searchDir, "deep", "renamed.wav");
  fs.mkdirSync(path.dirname(renamed), { recursive: true });
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.copyFileSync(path.join(hashDir, "se1.mp3"), path.join(emptyDir, "other.mp3"));
  fs.renameSync(original, renamed);
  try {
    await scanFolder("outside");
    await search("se2_outside");
    await row("se2_outside.wav").click();
    const find = page.getByRole("button", { name: "指定フォルダから自動で探す" });
    // 同じ音声がないフォルダ
    const folders = await page.getByTestId("folder").count();
    await ui.setDialogReply(emptyDir);
    await find.click();
    await waitIdle();
    expect((await status()).includes("同じ音声のファイルは見つかりませんでした"), await status());
    expect((await page.getByTestId("folder").count()) === folders, "見つからないのにフォルダが登録された");
    // サブフォルダに、名前の違う同じ音声がある
    await ui.setDialogReply(searchDir);
    await find.click();
    await waitIdle();
    expect((await status()).includes("ひも付けました"), await status());
    expect((await page.getByTestId("folder").count()) === folders + 1, "フォルダが登録されない");
    await search("renamed");
    expect((await tagsOf("deep/renamed.wav")).includes("紐づけ"), "タグが移らない");
  } finally {
    fs.renameSync(renamed, original);
  }
  // ハッシュ値のないリンク切れのファイルでは押せない（理由が出る）
  const broken = path.join(hashDir, "broken.wav");
  fs.renameSync(broken, `${broken}.moved`);
  try {
    await scanFolder("hash");
    await search("broken");
    await row("broken.wav").click();
    const find = page.getByRole("button", { name: "指定フォルダから自動で探す" });
    expect(await find.isDisabled(), "押せる");
    expect((await find.getAttribute("title")).includes("ハッシュ値がない"), await find.getAttribute("title"));
    expect(!(await page.getByRole("button", { name: "ファイルを紐づける" }).isDisabled()), "紐づけるが押せない");
  } finally {
    fs.renameSync(`${broken}.moved`, broken);
  }
});

await step("H15", "再生の欄の曲の名前は、曲名がなければ拡張子を除いたファイル名（パスは出さない）", async () => {
  await search("no_title");
  await row("no_title.wav").getByRole("button", { name: "再生", exact: true }).click();
  await page
    .waitForFunction(() => document.querySelector("[data-testid=player-file]")?.textContent === "no_title", null, { timeout: 3000 })
    .catch(() => {});
  expect((await page.getByTestId("player-file").innerText()) === "no_title", await page.getByTestId("player-file").innerText());
  expect((await page.getByTestId("player-file-name").innerText()) === "no_title.wav", "2行目にファイル名が出ない");
  await row("no_title.wav").locator(".file-name").click();
  expect((await page.getByTestId("track-title").innerText()) === "no_title", "右の欄のタイトル");
  await row("no_title.wav").getByRole("button", { name: "停止", exact: true }).click();
  await search("");
  for (const dir of [linkDir, searchDir, emptyDir]) fs.rmSync(dir, { recursive: true, force: true });
});

await step("H16", "チェックしたファイルがすべてリンク切れのときだけ、チェックの操作の行の右端にリンク切れの操作が出る。「指定フォルダから自動で探す」はまとめて探してひも付け、「ライブラリから外す」はまとめて外す", async () => {
  // 3つの音声（b1・b2 は探す先に移す、b3 は消す）にタグを付けてから、リンク切れにする
  fs.mkdirSync(bulkDir, { recursive: true });
  fs.copyFileSync(path.join(hashDir, "se1.mp3"), path.join(bulkDir, "b1.mp3"));
  fs.copyFileSync(path.join(hashDir, "se2.wav"), path.join(bulkDir, "b2.wav"));
  fs.copyFileSync(path.join(dataDir, "formats", "chime.wav"), path.join(bulkDir, "b3.wav"));
  await hashingAfter(() => addFolder(bulkDir));
  const actions = page.getByTestId("missing-actions");
  await search("b");
  for (const rel of ["b1.mp3", "b2.wav", "b3.wav"]) {
    await row(rel).click();
    await addTag("まとめ");
  }
  fs.mkdirSync(path.join(bulkSearch, "deep"), { recursive: true });
  fs.renameSync(path.join(bulkDir, "b1.mp3"), path.join(bulkSearch, "deep", "moved1.mp3"));
  fs.renameSync(path.join(bulkDir, "b2.wav"), path.join(bulkSearch, "moved2.wav"));
  fs.rmSync(path.join(bulkDir, "b3.wav"));
  await scanFolder("link_bulk");
  // リンク切れの3件をチェックすると出る
  await search("");
  await ui.filtered(() => ui.otherItem("missingOnly").click());
  await search("b");
  for (const rel of ["b1.mp3", "b2.wav", "b3.wav"]) await ui.check(rel);
  await actions.waitFor({ timeout: 3000 });
  expect((await actions.innerText()).includes("リンク切れ 3件"), await actions.innerText());
  // 行の右端にある
  const [bar, box] = await Promise.all([actions.locator("..").boundingBox(), actions.boundingBox()]);
  expect(Math.abs(bar.x + bar.width - (box.x + box.width)) < 16, `右端にない ${bar.x + bar.width} / ${box.x + box.width}`);
  await shot("H16_リンク切れの操作");
  // リンク切れでないファイルが混ざると出ない
  await ui.filtered(() => ui.otherItem("missingOnly").click());
  await search("se1.mp3");
  await ui.check("se1.mp3");
  await page.waitForTimeout(300);
  expect((await actions.count()) === 0, "リンク切れでないファイルが混ざっても出る");
  await ui.check("se1.mp3");
  await actions.waitFor({ timeout: 3000 });
  // 指定フォルダから自動で探す：フォルダを1回選び、まとめてひも付ける（ライブラリの外なので登録する）
  await ui.setDialogReply(bulkSearch);
  await page.getByTestId("missing-actions").getByRole("button", { name: "指定フォルダから自動で探す" }).click();
  await waitIdle();
  expect((await status()).includes("ひも付けた 2件、見つからなかった 1件"), await status());
  await search("moved");
  expect((await tagsOf("deep/moved1.mp3")).includes("まとめ") && (await tagsOf("moved2.wav")).includes("まとめ"), "タグが移らない");
  // 残った1件（b3）だけがチェックに残り、まとめて外せる
  await actions.waitFor({ timeout: 3000 });
  expect((await actions.innerText()).includes("リンク切れ 1件"), await actions.innerText());
  await ui.setConfirmReply(true);
  await ui.confirmed(() => page.getByTestId("missing-actions").getByRole("button", { name: "ライブラリから外す" }).click());
  await waitIdle();
  expect((await ui.lastConfirm()).includes("見つからないファイル1件"), await ui.lastConfirm());
  expect((await status()).includes("1件をライブラリから外しました"), await status());
  await search("b3");
  expect((await fileCount()) === 0, "外れていない");
  await search("");
  await ui.setDialogReply(undefined);
  for (const dir of [bulkDir, bulkSearch]) fs.rmSync(dir, { recursive: true, force: true });
});

await ui.finish();
