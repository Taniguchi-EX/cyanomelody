// 「ハッシュ値を使った機能」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/hash-features.mjs <テストデータ> <スクリーンショットの保存先>
import fs from "node:fs";
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("hash-features.mjs");
const hashDir = path.join(dataDir, "hash");
const outside = path.join(dataDir, "outside");
const large = path.join(dataDir, "large");

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

await step("H01", "フォルダを登録すると、ハッシュ値の計算が自動で始まり、終わると件数が出る", async () => {
  await hashingAfter(() => addFolder(hashDir));
  const s = await hashStatus();
  expect(s.includes("ハッシュ値を計算しました（5件、計算できなかったファイル 1件）"), s);
});

await step("H02", "1件選ぶと、ハッシュ値が出る", async () => {
  await row("se1.mp3").click();
  const h = await selectedHash();
  expect(/^[0-9a-f]{64}$/.test(h.trim()), h);
});

await step("H03", "計算できなかったファイルは、理由が出て、探すボタンが押せない", async () => {
  await row("broken.wav").click();
  const h = await selectedHash();
  expect(h.includes("計算できませんでした"), h);
  expect(await page.getByRole("button", { name: "同じ音声のファイルを探す" }).isDisabled(), "押せる");
});

await step("H04", "重複しているファイルだけに絞り込める（タグだけ違うファイルも重複になる）", async () => {
  await page.getByLabel("重複しているファイルだけ").check();
  await page.waitForTimeout(400);
  expect((await fileCount()) === 3, `件数 ${await fileCount()}`);
  for (const rel of ["se1.mp3", "dup/se1_copy.mp3", "se1_retag.mp3"]) {
    expect((await row(rel).count()) === 1, `${rel}がない`);
  }
  const hashes = await page.locator("[data-testid=file-row] .hash").allInnerTexts();
  expect(hashes.length === 3 && new Set(hashes).size === 1, `ハッシュ値の表示 ${hashes.join(",")}`);
  await shot("H04_重複");
  await clearFilter();
});

await step("H05", "選んだファイルと同じ音声のファイルを探せる", async () => {
  await row("se1_retag.mp3").click();
  await page.getByRole("button", { name: "同じ音声のファイルを探す" }).click();
  await page.waitForTimeout(400);
  expect((await fileCount()) === 3, `件数 ${await fileCount()}`);
  expect((await page.getByTestId("hash-filter").count()) === 1, "絞り込み中の表示がない");
  await clearFilter();
  expect((await page.getByTestId("hash-filter").count()) === 0, "解除されない");
  expect((await fileCount()) === 5, `解除後 ${await fileCount()}`);
});

await step("H06", "ライブラリ外のファイルを指定して、同じ音声のファイルを探せる", async () => {
  await page.getByRole("button", { name: "ファイルを指定して探す" }).click();
  await page.getByLabel("探す音声ファイルのパス").fill(path.join(outside, "se2_outside.wav"));
  await page.getByRole("button", { name: "探す", exact: true }).click();
  await waitIdle();
  expect((await fileCount()) === 1, `件数 ${await fileCount()}`);
  expect((await row("se2.wav").count()) === 1, "se2.wavでない");
  await shot("H06_ファイルを指定して探す");
  await clearFilter();
});

await step("H07", "音声でないファイルを指定すると、エラーが出る", async () => {
  await page.getByRole("button", { name: "ファイルを指定して探す" }).click();
  await page.getByLabel("探す音声ファイルのパス").fill(path.join(outside, "text.mp3"));
  await page.getByRole("button", { name: "探す", exact: true }).click();
  await waitIdle();
  const s = await status();
  expect(s.includes("ハッシュ値を計算できませんでした"), s);
  await page.getByRole("button", { name: "ファイルを指定して探す" }).click();
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

await step("H09", "同じ音声の候補が複数あるときは、ひも付け直さない", async () => {
  const backup = path.join(dataDir, "se1.mp3.bak");
  fs.renameSync(path.join(hashDir, "se1.mp3"), backup);
  await scan();
  await row("se1.mp3").click();
  await page.getByRole("button", { name: "ひも付け直す" }).click();
  await waitIdle();
  const s = await status();
  expect(s.includes("ひも付け直した 0件") && s.includes("候補が複数ある 1件"), s);
  expect((await row("se1.mp3").count()) === 1, "消えた");
  fs.renameSync(backup, path.join(hashDir, "se1.mp3"));
  await scan();
});

await step("H10", "ハッシュ値の計算を中止でき、次のスキャンの後に続きから計算する", async () => {
  await hashingAfter(async () => {
    await page.getByLabel("フォルダのパス").fill(large);
    await page.getByRole("button", { name: "登録", exact: true }).click();
    // 計算が始まったらすぐに中止する
    const cancel = page.getByTestId("hash-status").getByRole("button", { name: "中止" });
    await cancel.waitFor({ timeout: 60000 });
    await cancel.click();
  });
  const s1 = await hashStatus();
  expect(s1.includes("中止しました"), s1);
  const done1 = parseInt(s1.match(/（(\d+)件/)?.[1] ?? "-1", 10);
  expect(done1 >= 0 && done1 < 30000, `中止までの件数 ${done1}`);
  const t0 = Date.now();
  await hashingAfter(() =>
    page.getByTestId("folder").filter({ hasText: "large" }).getByRole("button", { name: "スキャン" }).click(),
  );
  const s2 = await hashStatus();
  const done2 = parseInt(s2.match(/（(\d+)件/)?.[1] ?? "-1", 10);
  expect(s2.includes("計算しました") && done1 + done2 === 30000, `1回目 ${done1}件、2回目 ${s2}`);
  return `中止までに ${done1}件、続きの ${done2}件に ${Date.now() - t0}ms（中身がダミーで、すべて計算できないファイル）`;
});

await ui.finish();
