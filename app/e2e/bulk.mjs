// 「ファイルの一括操作」（チェックと、ドラッグでのまとめての操作）の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/bulk.mjs <テストデータ> <スクリーンショットの保存先>
import fs from "node:fs";
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("bulk.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, status, fileCount, row, tagItem, waitIdle, addFolder, clearFilter, addTag } = ui;

// 右の欄のパス（絶対パス）のファイル名
const detailPath = async () => path.win32.basename(await page.getByTestId("detail-path").innerText());
const isChecked = (rel) => row(rel).getByTestId("file-check").isChecked();
const filterText = async (text) => {
  await ui.filtered(() => page.getByLabel("ファイル名で検索", { exact: true }).fill(text));
};
const checkedOnly = () => page.getByLabel("チェックしたファイルだけ表示");
const checkToolbar = () => page.locator("main .toolbar:not(.library-head)");
async function scan() {
  await page.getByRole("button", { name: "スキャン", exact: true }).click();
  await waitIdle();
}

await step("B01", "準備：チェックの件数は0件でも下の行に常に出て、チェックの操作の行と一括操作の欄は出ない", async () => {
  await addFolder(formats);
  const c = await ui.checkedCount();
  expect(c === "チェック 0件（表示中 0件）", c);
  expect((await checkToolbar().count()) === 0, "チェックの操作の行が出ている");
  expect((await page.getByTestId("bulk-panel").count()) === 0, "一括操作の欄がある");
  expect((await page.getByLabel("表示中のファイルをすべてチェック").count()) === 0, "見出しのチェックボックスが残っている");
  await row("chime.wav").click();
  await addTag("雨");
  await row("chime.flac").click();
  await addTag("風");
});

await step("B02", "行のクリックは1件の詳細の表示だけ（Ctrl・Shiftを押しても複数選択にならない）", async () => {
  await row("chime.wav").click();
  expect((await detailPath()) === "chime.wav", await detailPath());
  await row("chime.mp3").click({ modifiers: ["Control"] });
  expect((await detailPath()) === "chime.mp3", await detailPath());
  await row("chime.ogg").click({ modifiers: ["Shift"] });
  expect((await detailPath()) === "chime.ogg", await detailPath());
  expect((await page.locator(".file-row.selected").count()) === 1, "複数の行が選ばれている");
  expect((await ui.checkedCount()).startsWith("チェック 0件"), "チェックが付いた");
});

await step("B03", "チェックボックスを押しても右の欄は変わらない。チェックすると、全てチェック・チェックをすべて外す・チェックしたファイルだけ表示が出る", async () => {
  await row("chime.wav").click();
  await ui.check("chime.mp3");
  expect((await detailPath()) === "chime.wav", await detailPath());
  expect(await isChecked("chime.mp3"), "チェックされていない");
  const labels = (await checkToolbar().innerText()).replace(/\s+/g, " ").trim();
  expect(labels === "全てチェック チェックをすべて外す チェックしたファイルだけ表示 一括操作", labels);
  expect((await page.getByTestId("bulk-panel").count()) === 0, "一括操作の欄が出ている");
  await shot("B03_チェックの操作");
});

await step("B04", "チェックは絞り込みの条件を変えても外れない（別のタグで絞り込んでも持ち越す）", async () => {
  await ui.filtered(() => tagItem("雨").click());
  await ui.check("chime.wav");
  await ui.filtered(() => tagItem("雨").click());
  await ui.filtered(() => tagItem("風").click());
  await ui.check("chime.flac");
  let c = await ui.checkedCount();
  expect(c === "チェック 3件（表示中 1件）", `風で絞り込み中 ${c}`);
  await ui.filtered(() => tagItem("風").click());
  c = await ui.checkedCount();
  expect(c === "チェック 3件（表示中 3件）", `解除後 ${c}`);
  expect((await isChecked("chime.wav")) && (await isChecked("chime.flac")) && (await isChecked("chime.mp3")), "外れた");
});

await step("B05", "「チェックしたファイルだけ表示」はほかの条件とAND。チェックをすべて外すと「チェックしたファイルだけ表示」も消える", async () => {
  await ui.filtered(() => checkedOnly().check());
  expect((await fileCount()) === 3, `チェックしたファイルだけ ${await fileCount()}`);
  await filterText("wav");
  expect((await fileCount()) === 1, `ファイル名とAND ${await fileCount()}`);
  // ファイル名の検索欄はライブラリの見出しの行にあり、「×」で消せる
  expect((await page.locator(".library-head [aria-label=\"ファイル名で検索\"]").count()) === 1, "ライブラリの見出しにない");
  await ui.filtered(() => page.getByRole("button", { name: "ファイル名で検索の文字を消す" }).click());
  expect((await fileCount()) === 3, `×で消した後 ${await fileCount()}`);
  await clearFilter();
  // チェックがなくなると「チェックしたファイルだけ表示」自体が消える
  expect((await checkedOnly().count()) === 0, "チェックしたファイルだけが残っている");
  expect((await fileCount()) === 5, `解除後 ${await fileCount()}`);
  expect((await ui.checkedCount()).startsWith("チェック 0件"), "チェックが外れない");
  // 検索の欄の右に「✕」（すべて解除）はない
  expect((await page.getByRole("button", { name: "すべて解除" }).count()) === 0, "すべて解除が残っている");
});

await step("B06", "「全てチェック」で表示中のファイルをすべてチェックする（すべてチェック済みなら押せない）。Ctrl+A でも同じ。「チェックをすべて外す」で外れる", async () => {
  await ui.check("chime.wav");
  await ui.check("chime.mp3");
  await ui.check("chime.flac");
  await filterText("chime.");
  const all = page.getByRole("button", { name: "全てチェック" });
  await all.click();
  const c = await ui.checkedCount();
  expect(c === "チェック 4件（表示中 4件）", `全てチェック ${c}`);
  expect(await all.isDisabled(), "すべてチェック済みなのに押せる");
  await ui.clearChecks();
  expect((await ui.checkedCount()) === "チェック 0件（表示中 0件）", await ui.checkedCount());
  await clearFilter();
  await page.getByTestId("file-list").click();
  await page.keyboard.press("Control+a");
  expect((await ui.checkedCount()) === "チェック 5件（表示中 5件）", await ui.checkedCount());
  await ui.clearChecks();
  expect((await ui.checkedCount()) === "チェック 0件（表示中 0件）", await ui.checkedCount());
  expect((await checkToolbar().count()) === 0, "チェックの操作の行が残る");
});

await step("B08", "表示していないファイルも含めて、チェックしたファイルすべてにドラッグで設定する（確認は出さない）。操作の後もチェックは残る", async () => {
  await page.getByRole("button", { name: "ライセンスを作る" }).click();
  await page.getByLabel("名前", { exact: true }).fill("規約A");
  await page.getByTestId("credit-form").getByRole("button", { name: "作成", exact: true }).click();
  await waitIdle();
  await ui.check("chime.wav");
  await ui.check("chime.flac");
  await ui.filtered(() => tagItem("雨").click());
  expect((await fileCount()) === 1, "絞り込めていない");
  await ui.dragChecked(page.locator("[data-testid=license][data-credit-name=規約A]"));
  expect((await status()).includes("2件にライセンス「規約A」を設定しました"), await status());
  // 絞り込みだけを外す（チェックは残す）
  await ui.filtered(() => tagItem("雨").click());
  const n = await page.getByTestId("license").filter({ hasText: "規約A" }).locator(".sub").innerText();
  expect(n === "2", `規約Aの件数 ${n}`);
  await shot("B08_ドラッグでライセンスを設定");
  expect((await ui.checkedCount()).startsWith("チェック 2件"), await ui.checkedCount());
});

await step("B10", "チェックしていない行をつかんだときは、その1件だけが対象になる（チェックはそのまま）", async () => {
  await ui.dragTo(row("chime.mp3").locator(".file-name"), tagItem("雨"), 0.5);
  expect((await status()).includes("1件にタグ「雨」を付けました"), await status());
  expect((await row("chime.mp3").locator(".chip").allInnerTexts()).includes("雨"), "付いていない");
  expect(!(await row("chime.flac").locator(".chip").allInnerTexts()).includes("雨"), "チェックした行にも付いた");
  expect((await ui.checkedCount()).startsWith("チェック 2件"), await ui.checkedCount());
});

await step("B12", "「一括操作」で右の欄が一括操作に変わり、チェックしたファイルのタグを「名前 件数 ✕」で出す。✕で確かめてから外す。もう一度押すか行を押すとファイルの詳細に戻る", async () => {
  await ui.check("chime.mp3");
  const bulkButton = () => checkToolbar().getByRole("button", { name: "一括操作" });
  const panel = page.getByTestId("bulk-panel");
  // 「一括操作」は、チェックの操作の行の右端
  const [bar, button] = await Promise.all([checkToolbar().boundingBox(), bulkButton().boundingBox()]);
  expect(Math.abs(bar.x + bar.width - (button.x + button.width)) < 16, "右端にない");
  await bulkButton().click();
  await panel.waitFor({ timeout: 3000 });
  expect((await page.getByTestId("detail-panel").count()) === 0, "ファイルの詳細が残っている");
  expect((await bulkButton().getAttribute("aria-pressed")) === "true", "押した状態でない");
  expect((await page.getByTestId("bulk-count").innerText()).includes("チェックしたファイル 3件"), await page.getByTestId("bulk-count").innerText());
  const chip = (name) => panel.getByTestId("bulk-tags").locator(`[data-tag-name="${name}"]`);
  await chip("雨").waitFor({ timeout: 3000 });
  // wav・mp3 に雨、flac に風
  const count = (name) => chip(name).locator(".chip-count").innerText();
  expect((await count("雨")) === "2", `雨: ${await count("雨")}`);
  expect((await count("風")) === "1", `風: ${await count("風")}`);
  const colors = await chip("雨").evaluate((b) => [getComputedStyle(b).color, getComputedStyle(b.querySelector(".chip-count")).color]);
  expect(colors[0] !== colors[1], `件数の色が同じ: ${colors.join(" / ")}`);
  await shot("B12_一括操作の欄");
  // キャンセルすると外れない
  await ui.setConfirmReply(false);
  await ui.confirmed(() => chip("雨").click());
  expect((await ui.lastConfirm()).includes("対象の2件から、タグ「雨」を外しますか"), await ui.lastConfirm());
  expect((await chip("雨").count()) === 1, "キャンセルしたのに外れた");
  await ui.setConfirmReply(true);
  await chip("雨").click();
  await waitIdle();
  expect((await status()).includes("2件からタグ「雨」を外しました"), await status());
  await chip("雨").waitFor({ state: "detached", timeout: 3000 });
  expect(!(await row("chime.wav").locator(".chip").allInnerTexts()).includes("雨"), "wavから外れていない");
  // 付ける：入力欄から、チェックしたファイルすべてに（まだない名前なら作る）
  await panel.getByLabel("付けるタグ名").fill("まとめ");
  await panel.getByLabel("付けるタグ名").press("Enter");
  await waitIdle();
  expect((await status()).includes("3件にタグ「まとめ」を付けました"), await status());
  for (const rel of ["chime.wav", "chime.mp3", "chime.flac"]) {
    expect((await row(rel).locator(".chip").allInnerTexts()).includes("まとめ"), `${rel}に付いていない`);
  }
  // もう一度押すと、ファイルの詳細に戻る。行を押しても戻る
  await bulkButton().click();
  await panel.waitFor({ state: "detached", timeout: 3000 });
  await bulkButton().click();
  await panel.waitFor({ timeout: 3000 });
  await row("chime.wav").click();
  await panel.waitFor({ state: "detached", timeout: 3000 });
  expect((await detailPath()) === "chime.wav", await detailPath());
  // 後のテストのため、まとめ を外し、mp3 のチェックを外しておく
  await bulkButton().click();
  await panel.waitFor({ timeout: 3000 });
  await chip("まとめ").click();
  await waitIdle();
  await row("chime.mp3").getByTestId("file-check").uncheck();
  expect((await ui.checkedCount()).startsWith("チェック 2件"), await ui.checkedCount());
  // チェックがなくなると、ファイルの詳細に戻る
  await page.getByRole("button", { name: "チェックをすべて外す" }).click();
  await panel.waitFor({ state: "detached", timeout: 3000 });
  await ui.check("chime.wav");
  await ui.check("chime.flac");
});

await step("B13", "一括操作の欄：プレイリストに加える・外す（件数付きのチップ）、出典・ライセンスはばらばらなら「（複数）」で、選ぶとすべてに設定する", async () => {
  const panel = page.getByTestId("bulk-panel");
  await page.getByRole("button", { name: "プレイリストを作る" }).click();
  await page.getByLabel("新しいプレイリストの名前").fill("一括");
  await page.getByLabel("新しいプレイリストの名前").press("Enter");
  await waitIdle();
  await checkToolbar().getByRole("button", { name: "一括操作" }).click();
  await panel.waitFor({ timeout: 3000 });
  await panel.getByLabel("対象のファイルを加えるプレイリスト").selectOption({ label: "一括" });
  await waitIdle();
  expect((await status()).includes("2件をプレイリスト「一括」に追加しました"), await status());
  const pchip = panel.getByTestId("bulk-playlists").locator('[data-playlist-name="一括"]');
  await pchip.waitFor({ timeout: 3000 });
  expect((await pchip.locator(".chip-count").innerText()) === "2", await pchip.innerText());
  await ui.setConfirmReply(true);
  await ui.confirmed(() => pchip.getByRole("button", { name: "一括から対象のファイルを外す" }).click());
  await waitIdle();
  expect((await ui.lastConfirm()).includes("プレイリスト「一括」から、対象の2件を外しますか"), await ui.lastConfirm());
  await pchip.waitFor({ state: "detached", timeout: 3000 });
  // 出典：1件だけに設定すると「（複数）」、選ぶとすべてに設定する
  await page.getByRole("button", { name: "出典を作る" }).click();
  await page.getByLabel("名前", { exact: true }).fill("素材A");
  await page.getByLabel("名前", { exact: true }).press("Enter");
  await waitIdle();
  // 1件（wav）だけに、ファイルの詳細で設定する（行を押すとファイルの詳細に戻る）
  await row("chime.wav").click();
  await page.getByTestId("detail-panel").getByLabel("出典を選ぶ").selectOption({ label: "素材A" });
  await waitIdle();
  await checkToolbar().getByRole("button", { name: "一括操作" }).click();
  await panel.waitFor({ timeout: 3000 });
  const source = panel.getByTestId("bulk-credit-source").locator("select");
  await page.waitForFunction(() => document.querySelector("[data-testid=bulk-credit-source] select")?.selectedOptions[0]?.text === "（複数）", null, { timeout: 3000 });
  await shot("B13_一括操作の欄");
  await source.selectOption({ label: "素材A" });
  await waitIdle();
  expect((await status()).includes("2件に出典「素材A」を設定しました"), await status());
  await page.waitForFunction(() => document.querySelector("[data-testid=bulk-credit-source] select")?.selectedOptions[0]?.text === "素材A", null, { timeout: 3000 });
  await source.selectOption({ label: "（なし）" });
  await waitIdle();
  await checkToolbar().getByRole("button", { name: "一括操作" }).click();
});

await step("B11", "チェックしたファイルをライブラリから外すと、チェックからも外れる", async () => {
  fs.renameSync(path.join(formats, "chime.ogg"), path.join(dataDir, "chime.ogg.moved"));
  try {
    await scan();
    await ui.check("chime.ogg");
    expect((await ui.checkedCount()).startsWith("チェック 3件"), await ui.checkedCount());
    await row("chime.ogg").click();
    await page.getByTestId("detail-panel").getByRole("button", { name: "ライブラリから外す" }).click();
    await waitIdle();
    expect((await row("chime.ogg").count()) === 0, "外れていない");
    await page.waitForFunction(() => document.querySelector("[data-testid=checked-count]")?.textContent?.startsWith("チェック 2件"), null, {
      timeout: 3000,
    });
    const c = await ui.checkedCount();
    expect(c === "チェック 2件（表示中 2件）", c);
  } finally {
    fs.renameSync(path.join(dataDir, "chime.ogg.moved"), path.join(formats, "chime.ogg"));
  }
});


await step("B14", "一括操作の欄の「情報を書き出す…」：対象のファイルのタグ・出典・ライセンス・曲名を、データのエクスポートと同じ形の JSON に書き出す", async () => {
  await clearFilter();
  await ui.clearChecks();
  await ui.check("chime.wav");
  await ui.check("chime.mp3");
  await checkToolbar().getByRole("button", { name: "一括操作" }).click();
  const panel = page.getByTestId("bulk-panel");
  await panel.waitFor({ timeout: 3000 });
  const out = path.join(shotDir, "files.json");
  fs.rmSync(out, { force: true });
  await ui.setDialogReply(out);
  await panel.getByRole("button", { name: "メタデータを書き出し…" }).click();
  await ui.waitStatus("件のファイルのメタデータを書き出しました");
  await ui.setDialogReply(null);
  const data = JSON.parse(fs.readFileSync(out, "utf8"));
  expect(data.app === "cyanomelody" && data.sections.tags && data.sections.credits && !data.sections.playlists, JSON.stringify(data.sections));
  const rels = data.files.map((f) => f.relPath).sort();
  expect(rels.join(",") === "chime.mp3,chime.wav", rels.join(","));
  expect(data.files.every((f) => f.title === "チャイム"), data.files.map((f) => f.title).join(","));
  expect((await status()).includes("2件のファイルのメタデータを書き出しました"), await status());
  await ui.clearChecks();
});

await step("B15", "一括操作の欄の「ファイルをまとめて書出…」：選んだフォルダの中にフォルダを作り、対象のファイルをそのままコピーする", async () => {
  await ui.check("chime.wav");
  await ui.check("chime.mp3");
  await checkToolbar().getByRole("button", { name: "一括操作" }).click();
  const panel = page.getByTestId("bulk-panel");
  await panel.waitFor({ timeout: 3000 });
  const out = path.join(shotDir, "copied");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  await ui.setDialogReply(out);
  await panel.getByRole("button", { name: "ファイルをまとめて書出…" }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=export-status]")?.textContent?.includes("書き出しました"), null, { timeout: 15000 });
  await ui.setDialogReply(null);
  const [folder] = fs.readdirSync(out);
  expect(folder.startsWith("cyanomelody-files-"), folder);
  const copied = fs.readdirSync(path.join(out, folder)).sort();
  expect(copied.join(",") === "chime.mp3,chime.wav", copied.join(","));
  expect(fs.readFileSync(path.join(out, folder, "chime.wav")).equals(fs.readFileSync(path.join(formats, "chime.wav"))), "中身が違う");
  await ui.clearChecks();
});

await ui.finish();
