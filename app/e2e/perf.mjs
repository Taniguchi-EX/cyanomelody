// 性能の画面テスト（3万件のフォルダ）。普段は流さない。
// 一覧・スキャン・絞り込み・ハッシュ値の計算・プレイリストの展開を変えたときに流す（`bash check.sh perf`）。
//   node e2e/perf.mjs <テストデータ> <スクリーンショットの保存先>
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("perf.mjs");
const formats = path.join(dataDir, "formats");
const large = path.join(dataDir, "large");

const ui = await connect(shotDir);
const { page, step, shot, fileCount, tagItem, waitIdle, clearFilter } = ui;

const hashStatus = () => page.evaluate(() => document.querySelector("[data-testid=hash-status]")?.textContent ?? "");
/** ハッシュ値の計算の表示が、前と変わって「計算しました」か「中止しました」になるのを待つ */
async function waitHashDone(before) {
  await page.waitForFunction(
    (before) => {
      const t = document.querySelector("[data-testid=hash-status]")?.textContent ?? "";
      return t !== before && (t.includes("計算しました") || t.includes("中止しました"));
    },
    before,
    { timeout: 120000 },
  );
}
const doneCount = (s) => parseInt(s.match(/（(\d+)件/)?.[1] ?? "-1", 10);

let done1 = -1;

// 準備：鳴らせる5件のフォルダを先に登録し、ハッシュ値の計算が終わるのを待つ
// （プレイリストの再生を、鳴らせるファイルから始めるため。3万件のファイルは中身がダミーで鳴らせない）
await ui.addFolder(formats);
await ui.waitHashing();

await step("PF01", "3万ファイルのフォルダを登録・表示・スクロール・絞り込みできる。ハッシュ値の計算を途中で中止できる", async () => {
  const before = await hashStatus();
  const t0 = Date.now();
  await ui.setDialogReply(large);
  await page.getByRole("button", { name: "フォルダを追加" }).click();
  await waitIdle();
  const addMs = Date.now() - t0;
  // 計算が始まったらすぐに中止する
  const cancel = page.getByTestId("hash-status").getByRole("button", { name: "中止" });
  await cancel.waitFor({ timeout: 60000 });
  await cancel.click();
  await waitHashDone(before);
  const s = await hashStatus();
  expect(s.includes("中止しました"), s);
  done1 = doneCount(s);
  expect(done1 >= 0 && done1 < 30000, `中止までの件数 ${done1}`);

  // 登録したフォルダだけの一覧になるのを待つ（3万件の読み直しは、処理の終わりより後になることがある）
  await page
    .waitForFunction(() => document.querySelector("[data-testid=file-count]")?.textContent === "30000件", null, { timeout: 30000 })
    .catch(() => {});
  expect((await fileCount()) === 30000, `件数 ${await fileCount()}`);
  const list = page.getByTestId("file-list");
  const t1 = Date.now();
  for (let i = 1; i <= 10; i++) {
    await list.evaluate((el, r) => (el.scrollTop = el.scrollHeight * r), i / 10);
    await page.waitForTimeout(50);
  }
  const scrollMs = Date.now() - t1;
  const rows = await page.getByTestId("file-row").count();
  expect(rows < 200, `描画している行が多すぎる: ${rows}`);
  await page.getByLabel("ファイル名で検索", { exact: true }).fill("se_42_1");
  const t2 = Date.now();
  await page.waitForFunction(() => parseInt(document.querySelector("[data-testid=file-count]").textContent, 10) === 100);
  const filterMs = Date.now() - t2;
  await shot("PF01_3万件");
  await clearFilter();
  return `登録とスキャン ${addMs}ms、10回スクロール ${scrollMs}ms、絞り込み ${filterMs}ms（入力待ち200msを含む）、描画行 ${rows}、中止までに ${done1}件`;
});

await step("PF02", "中止したハッシュ値の計算は、次のスキャンの後に続きから計算する", async () => {
  const before = await hashStatus();
  const t0 = Date.now();
  await page.getByTestId("folder").filter({ hasText: "large" }).getByRole("button", { name: "スキャン", exact: true }).click();
  await waitHashDone(before);
  const s = await hashStatus();
  const done2 = doneCount(s);
  expect(s.includes("計算しました") && done1 + done2 === 30000, `1回目 ${done1}件、2回目 ${s}`);
  return `続きの ${done2}件に ${Date.now() - t0}ms（中身がダミーで、すべて計算できないファイル）`;
});

await step("PF03", "3万件をすべてチェックして、ドラッグでまとめてタグを付けられる", async () => {
  // フォルダを登録すると、そのフォルダだけの表示になるので、外して両方のフォルダを出す
  await ui.filtered(() => clearFilter());
  await page.getByTestId("file-list").click();
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(500);
  const c = await ui.checkedCount();
  expect(c.includes("チェック 30005件"), c);
  const t0 = Date.now();
  await ui.bulkAddTag("大量");
  const ms = Date.now() - t0;
  expect((await tagItem("大量").innerText()).includes("30005"), await tagItem("大量").innerText());
  await ui.clearChecks();
  return `${ms}ms`;
});

await step("PF04", "3万件が対象のタグの組み合わせのプレイリストを選ぶ（抽選して一覧を出す）までの時間と、再生し始めるまでの時間", async () => {
  await page.getByRole("button", { name: "プレイリストを作る" }).click();
  await page.getByLabel("新しいプレイリストの名前").fill("大量");
  await page.getByLabel("新しいプレイリストの名前").press("Enter");
  await waitIdle();
  const node = page.locator('[data-testid=playlist][data-playlist-name="大量"] .tag-name');
  // 0曲のプレイリストは選べないので、ダブルクリックで編集画面を開いてタグの組み合わせを加える
  await node.dblclick();
  const editor = page.getByTestId("playlist-editor");
  await editor.waitFor({ timeout: 3000 });
  await page.getByLabel("組み合わせに加えるタグ").fill("大量");
  await page.getByLabel("組み合わせに加えるタグ").press("Enter");
  await page.getByRole("button", { name: "タグの組み合わせを追加" }).click();
  await waitIdle();
  await editor.getByRole("button", { name: "閉じる", exact: true }).click();
  // 選ぶ（抽選して一覧を出す）までの時間
  const s0 = Date.now();
  await ui.filtered(() => node.click());
  const selectMs = Date.now() - s0;
  expect((await ui.fileCount()) === 30005, `${await ui.fileCount()}`);
  const t0 = Date.now();
  await page.getByRole("button", { name: "再生を始める" }).click();
  await ui.waitPlaying(30000);
  const ms = Date.now() - t0;
  const position = await page.getByTestId("player-position").innerText();
  expect(position === "1/30005", position);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  return `選ぶ ${selectMs}ms、再生 ${ms}ms`;
});

await ui.finish();
