// 画面テストの共通部分。起動したアプリのWebView2にリモートデバッグでつなぎ、Playwrightで操作する。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

export function parseArgs(script) {
  const [dataDir, shotDir] = process.argv.slice(2);
  if (!dataDir || !shotDir) {
    console.error(`usage: node e2e/${script} <テストデータ> <スクリーンショットの保存先>`);
    process.exit(2);
  }
  fs.mkdirSync(shotDir, { recursive: true });
  return { dataDir: path.resolve(dataDir), shotDir: path.resolve(shotDir) };
}

export function expect(cond, message) {
  if (!cond) throw new Error(message);
}

export async function connect(shotDir) {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  // 確認ダイアログはすべて「OK」で答える
  page.on("dialog", (d) => d.accept());
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(500);

  const results = [];
  const ui = {
    page,
    async step(id, name, fn) {
      try {
        const note = await fn();
        results.push({ id, name, ok: true, note: note ?? "" });
        console.log(`OK   ${id} ${name}${note ? `（${note}）` : ""}`);
      } catch (e) {
        results.push({ id, name, ok: false, note: String(e.message ?? e).split("\n")[0] });
        console.log(`FAIL ${id} ${name}: ${e.message ?? e}`);
      }
    },
    shot: (name) => page.screenshot({ path: path.join(shotDir, `${name}.png`) }),
    status: () => page.getByTestId("status").innerText(),
    fileCount: async () => parseInt(await page.getByTestId("file-count").innerText(), 10),
    row: (rel) => page.locator(`[data-testid=file-row][data-rel-path="${rel}"]`),
    // 左のタグの一覧の行。行の文字列は「名前」+「件数」（例：チャイム2）
    tagItem: (name) =>
      page.getByTestId("tag").filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+$`) }),
    tagNames: async () =>
      (await page.getByTestId("tag").allInnerTexts()).map((t) => t.split("\n")[0].trim()),
    async waitIdle() {
      // 処理中の表示が出るのを少し待ってから（出ないほど速い処理もある）、消えるのを待つ
      await page
        .waitForFunction(() => document.querySelector("[data-testid=status]")?.textContent === "処理中…", null, {
          timeout: 1000,
        })
        .catch(() => {});
      await page.waitForFunction(
        () => document.querySelector("[data-testid=status]")?.textContent !== "処理中…",
        null,
        { timeout: 120000 },
      );
      await page.waitForTimeout(300);
    },
    async addFolder(p) {
      await page.getByLabel("フォルダのパス").fill(p);
      await page.getByRole("button", { name: "登録", exact: true }).click();
      await ui.waitIdle();
    },
    async clearFilter() {
      const b = page.getByRole("button", { name: "絞り込みを解除" });
      if (await b.count()) await b.click();
      await page.waitForTimeout(400);
    },
    async addTag(name) {
      await page.getByLabel("付けるタグ名").fill(name);
      await page.getByRole("button", { name: "付ける" }).click();
      await ui.waitIdle();
    },
    async finish() {
      await ui.shot("最後の状態");
      await browser.close();
      const failed = results.filter((r) => !r.ok).length;
      fs.writeFileSync(path.join(shotDir, "results.json"), JSON.stringify(results, null, 2));
      console.log(`\n${results.length - failed}/${results.length} 件成功`);
      process.exit(failed ? 1 : 0);
    },
  };
  return ui;
}
