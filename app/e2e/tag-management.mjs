// 「音声のタグ管理」の画面テスト。
// 起動したアプリのWebView2にリモートデバッグでつなぎ、Playwrightで操作する。
//
// 準備:
//   bash e2e/make-testdata.sh <テストデータ>
//   CYANOMELODY_DATA_DIR=<空のフォルダ> WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npx tauri dev
// 実行:
//   node e2e/tag-management.mjs <テストデータ> <スクリーンショットの保存先>
import fs from "node:fs";
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("tag-management.mjs");
const formats = path.join(dataDir, "formats");
const large = path.join(dataDir, "large");

const ui = await connect(shotDir);
const { page, step, shot, status, fileCount, row, tagItem, waitIdle, addFolder, clearFilter, addTag } = ui;

await step("T01", "フォルダを登録すると、スキャンして5つの形式のファイルが取り込まれ、そのフォルダだけの表示になる", async () => {
  await ui.addFolderOnly(formats);
  const s = await status();
  expect(s.includes("5件"), `status: ${s}`);
  expect((await fileCount()) === 5, `件数 ${await fileCount()}`);
  expect((await row("サブフォルダ/チャイム.m4a").count()) === 1, "サブフォルダのm4aがない");
  const folder = page.getByTestId("folder");
  expect((await folder.getAttribute("class")).includes("active"), "フォルダが選ばれていない");
  expect((await folder.locator(".folder-name").innerText()) === "formats", await folder.innerText());
  expect((await page.getByRole("button", { name: "すべて解除" }).count()) === 1, "すべて解除が出ない");
  await shot("T01_フォルダ登録");
  // もう一度押すと外れる
  await folder.locator(".folder-name").click();
  await page.waitForTimeout(400);
  expect(!(await folder.getAttribute("class")).includes("active"), "外れない");
});

await step("T02", "登録済みのフォルダの中のフォルダは登録できない", async () => {
  await addFolder(path.join(formats, "サブフォルダ"));
  const s = await status();
  expect(s.includes("登録済みのフォルダの中にある"), `status: ${s}`);
  expect((await page.getByTestId("folder").count()) === 1, "フォルダが増えた");
});

await step("T03", "存在しないフォルダは登録できない", async () => {
  await addFolder(path.join(formats, "存在しない"));
  const s = await status();
  expect(s.includes("フォルダが見つかりません"), `status: ${s}`);
});

for (const rel of ["chime.flac", "chime.mp3", "chime.ogg", "chime.wav", "サブフォルダ/チャイム.m4a"]) {
  await step(`T04-${path.extname(rel).slice(1)}`, `試聴できる: ${rel}`, async () => {
    await row(rel).getByRole("button", { name: "再生" }).click();
    await page.waitForFunction(() => {
      const a = document.querySelector("audio");
      return a && a.currentTime > 0.1;
    }, null, { timeout: 5000 });
    const err = await page.evaluate(() => document.querySelector("audio").error?.message ?? null);
    expect(err === null, `audio error: ${err}`);
    // 停止
    await row(rel).getByRole("button", { name: "停止" }).click();
    expect(await page.evaluate(() => document.querySelector("audio").paused), "止まらない");
  });
}

await step("T05", "チェックした複数のファイルにまとめてタグを付けられる（新しいタグを作る）", async () => {
  await ui.check("chime.wav");
  await ui.check("chime.mp3");
  await ui.bulkAddTag("チャイム");
  const confirm = await ui.lastConfirm();
  expect(confirm.includes("チェックした2件にタグ「チャイム」を付けますか"), confirm);
  await ui.clearChecks();
  const t = await tagItem("チャイム").innerText();
  expect(t.includes("2"), `タグ一覧: ${t}`);
  expect((await row("chime.wav").locator(".chip").allInnerTexts()).includes("チャイム"), "一覧にタグが出ない");
  await shot("T05_タグを付ける");
});

await step("T06", "大文字・小文字が違うだけのタグ名は同じタグになる", async () => {
  await row("chime.wav").click();
  await addTag(" Short ");
  await row("chime.flac").click();
  await addTag("short");
  const items = await page.getByTestId("tag").allInnerTexts();
  expect(items.length === 2, `タグ一覧: ${items.join(",")}`);
  expect((await tagItem("Short").innerText()).includes("2"), "件数が2でない");
});

await step("T07", "複数のタグで絞り込むと、すべてのタグが付いたファイルだけになる（AND）", async () => {
  await tagItem("チャイム").click();
  await page.waitForTimeout(300);
  expect((await fileCount()) === 2, `チャイムのみ: ${await fileCount()}`);
  await tagItem("Short").click();
  await page.waitForTimeout(300);
  expect((await fileCount()) === 1, `AND: ${await fileCount()}`);
  expect((await row("chime.wav").count()) === 1, "chime.wavでない");
  await shot("T07_タグで絞り込む");
  await clearFilter();
});

await step("T08", "タグなしのファイルだけに絞り込める", async () => {
  await page.getByTestId("untagged").click();
  await page.waitForTimeout(300);
  expect((await fileCount()) === 2, `件数 ${await fileCount()}`);
  await clearFilter();
});

await step("T09", "ファイル名の一部で絞り込める（大文字・小文字を区別しない）", async () => {
  await page.getByLabel("ファイル名で絞り込む").fill("CHIME.");
  await page.waitForTimeout(500);
  expect((await fileCount()) === 4, `CHIME.: ${await fileCount()}`);
  await page.getByLabel("ファイル名で絞り込む").fill("サブ");
  await page.waitForTimeout(500);
  expect((await fileCount()) === 1, `サブ: ${await fileCount()}`);
  await clearFilter();
});

await step("T10", "チェックしたファイルからまとめてタグを外せる", async () => {
  await ui.check("chime.wav");
  await ui.check("chime.mp3");
  await ui.bulkMode("タグを外す");
  const t = await page.locator("[data-testid=bulk-tag][data-tag-name=チャイム]").innerText();
  expect(t.includes("2/2"), `件数の表示 ${t}`);
  await page.getByRole("button", { name: "チャイムをまとめて外す" }).click();
  await waitIdle();
  await ui.clearChecks();
  expect((await tagItem("チャイム").innerText()).includes("0"), await tagItem("チャイム").innerText());
});

await step("T11", "Shiftを押しながらチェックすると、範囲をまとめてチェックできる", async () => {
  await ui.check("chime.flac");
  await ui.check("chime.wav", { modifiers: ["Shift"] });
  const t = await ui.checkedCount();
  expect(t.includes("チェック 4件"), t);
  await ui.clearChecks();
});

await step("T12", "見つからなくなったファイルに印が付き、タグは残る", async () => {
  fs.renameSync(path.join(formats, "chime.flac"), path.join(dataDir, "chime.flac.moved"));
  await page.getByRole("button", { name: "スキャン", exact: true }).click();
  await waitIdle();
  const s = await status();
  expect(s.includes("見つからない 1件"), `status: ${s}`);
  const r = row("chime.flac");
  expect((await r.locator(".warn").count()) === 1, "印がない");
  expect((await r.locator(".chip").allInnerTexts()).includes("Short"), "タグが消えた");
  expect(await r.getByRole("button", { name: "再生" }).isDisabled(), "再生ボタンが押せる");
  await shot("T12_見つからないファイル");
});

await step("T13", "見つからないファイルだけに絞り込める（見つからないファイルがあるときだけ、ボタンが出る）", async () => {
  await page.getByRole("button", { name: "見つからないファイルだけ" }).click();
  await page.waitForTimeout(300);
  expect((await fileCount()) === 1, `件数 ${await fileCount()}`);
  await clearFilter();
});

await step("T14", "同じ場所に戻すと印が外れる", async () => {
  fs.renameSync(path.join(dataDir, "chime.flac.moved"), path.join(formats, "chime.flac"));
  await page.getByRole("button", { name: "スキャン", exact: true }).click();
  await waitIdle();
  expect((await page.getByRole("button", { name: "見つからないファイルだけ" }).count()) === 0, "ボタンが残っている");
  const s = await status();
  expect(s.includes("戻った 1件"), `status: ${s}`);
  expect((await row("chime.flac").locator(".warn").count()) === 0, "印が残っている");
});

await step("T15", "見つからないファイルをライブラリから外せる", async () => {
  fs.renameSync(path.join(formats, "chime.ogg"), path.join(dataDir, "chime.ogg.moved"));
  await page.getByRole("button", { name: "スキャン", exact: true }).click();
  await waitIdle();
  await row("chime.ogg").click();
  await page.getByRole("button", { name: "ライブラリから外す" }).click();
  await waitIdle();
  expect((await row("chime.ogg").count()) === 0, "外れていない");
  expect((await fileCount()) === 4, `件数 ${await fileCount()}`);
  fs.renameSync(path.join(dataDir, "chime.ogg.moved"), path.join(formats, "chime.ogg"));
});

await step("T16", "3万ファイルのフォルダを登録・表示・スクロールできる", async () => {
  const t0 = Date.now();
  await addFolder(large);
  const addMs = Date.now() - t0;
  const n = await fileCount();
  expect(n === 30004, `件数 ${n}`);
  const list = page.getByTestId("file-list");
  const t1 = Date.now();
  for (let i = 1; i <= 10; i++) {
    await list.evaluate((el, r) => (el.scrollTop = el.scrollHeight * r), i / 10);
    await page.waitForTimeout(50);
  }
  const scrollMs = Date.now() - t1;
  const rows = await page.getByTestId("file-row").count();
  expect(rows < 200, `描画している行が多すぎる: ${rows}`);
  await page.getByLabel("ファイル名で絞り込む").fill("se_42_1");
  const t2 = Date.now();
  await page.waitForFunction(() => parseInt(document.querySelector("[data-testid=file-count]").textContent, 10) === 100);
  const filterMs = Date.now() - t2;
  await shot("T16_3万件");
  await clearFilter();
  return `登録とスキャン ${addMs}ms、10回スクロール ${scrollMs}ms、絞り込み ${filterMs}ms（入力待ち200msを含む）、描画行 ${rows}`;
});

await step("T17", "3万件をすべてチェックして、まとめてタグを付けられる", async () => {
  await page.getByTestId("file-list").click();
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(500);
  const c = await ui.checkedCount();
  expect(c.includes("チェック 30004件"), c);
  const t0 = Date.now();
  await ui.bulkAddTag("一括");
  const ms = Date.now() - t0;
  expect((await tagItem("一括").innerText()).includes("30004"), await tagItem("一括").innerText());
  return `${ms}ms`;
});

await step("T18", "フォルダの登録を解除すると、ファイルとタグの情報が消える", async () => {
  const folder = page.getByTestId("folder").filter({ hasText: "large" });
  await folder.getByRole("button", { name: "登録解除" }).click();
  await waitIdle();
  expect((await page.getByTestId("folder").count()) === 1, "フォルダが残っている");
  expect((await fileCount()) === 4, `件数 ${await fileCount()}`);
  expect((await tagItem("一括").innerText()).includes("4"), await tagItem("一括").innerText());
  expect(fs.existsSync(path.join(large, "d00", "se_00_000.wav")), "実際のファイルが消えた");
});

await step("T19", "空のタグ名では付けられない", async () => {
  await row("chime.wav").click();
  await page.getByLabel("付けるタグ名", { exact: true }).fill("   ");
  expect(await page.getByTestId("detail-panel").getByRole("button", { name: "付ける", exact: true }).isDisabled(), "ボタンが押せる");
});

await step("T20", "聞き比べ：↑↓で右の欄のファイルを移し、試聴中なら移った先を続けて試聴する。スペースで試聴を始める・止める", async () => {
  await clearFilter();
  const selected = (rel) => row(rel).evaluate((el) => el.classList.contains("selected"));
  const playing = async (rel) => {
    await page.waitForTimeout(200);
    return row(rel).getByRole("button", { name: "停止" }).count();
  };
  // T15でchime.oggは外れている。並びは flac、mp3、wav
  await row("chime.flac").locator(".file-name").click();
  await page.keyboard.press("ArrowDown");
  expect(await selected("chime.mp3"), "↓で移らない");
  expect((await page.evaluate(() => document.querySelector("audio").paused)), "試聴していないのに鳴った");
  await page.keyboard.press(" ");
  expect((await playing("chime.mp3")) === 1, "スペースで試聴しない");
  await page.keyboard.press("ArrowDown");
  expect(await selected("chime.wav"), "↓で移らない");
  expect((await playing("chime.wav")) === 1 && (await playing("chime.mp3")) === 0, `移った先を試聴しない wav:${await playing("chime.wav")} mp3:${await playing("chime.mp3")} src:${await page.evaluate(() => decodeURIComponent(document.querySelector("audio").src))}`);
  await row("chime.wav").getByTestId("row-progress").waitFor({ timeout: 3000 });
  await page.keyboard.press("ArrowUp");
  expect((await playing("chime.mp3")) === 1, "↑で移った先を試聴しない");
  await page.keyboard.press(" ");
  expect((await playing("chime.mp3")) === 0, "スペースで止まらない");
});

await ui.finish();
