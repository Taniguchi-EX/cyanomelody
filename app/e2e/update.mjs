// 「アップデートの確認」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/update.mjs <テストデータ> <スクリーンショットの保存先>
// run.sh が、このテストのときだけ環境変数 CYANOMELODY_FAKE_UPDATE=9.9.9 を渡すので、起動すると 9.9.9 が見つかったことになる。
// 「はい」はダウンロードを始めてしまうので押さない。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { shotDir } = parseArgs("update.mjs");
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const current = JSON.parse(fs.readFileSync(path.join(appDir, "src-tauri", "tauri.conf.json"), "utf8")).version;

const ui = await connect(shotDir);
const { page, step, shot } = ui;
const dialog = () => page.getByTestId("update-dialog");

await step("U01", "起動して新しい版が見つかると、確認を出す。「現在」「最新」の版は、その版のリリースノートへのリンク。「いいえ」で閉じる", async () => {
  await dialog().waitFor({ timeout: 10000 });
  const text = await page.getByTestId("update-versions").innerText();
  expect(text === `現在：${current}\n最新：9.9.9`, JSON.stringify(text));
  const links = await page
    .getByTestId("update-versions")
    .locator("a")
    .evaluateAll((as) => as.map((a) => `${a.textContent} ${a.getAttribute("href")}`));
  const base = "https://github.com/Taniguchi-EX/cyanomelody/releases/tag/v";
  expect(links.join(",") === `${current} ${base}${current},9.9.9 ${base}9.9.9`, links.join(","));
  await shot("U01_アップデートの確認");
  await dialog().getByRole("button", { name: "いいえ" }).click();
  await dialog().waitFor({ state: "detached", timeout: 3000 });
});

await ui.finish();
