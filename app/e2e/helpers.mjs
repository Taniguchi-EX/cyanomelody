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
  // ブラウザの確認ダイアログが出たときは「OK」で答える（通常は下の stubConfirm で置き換えるので出ない）
  page.on("dialog", (d) => d.accept());
  // 画面の状態（左の欄のたたみ具合など）は WebView2 の保存領域に残るので、テストごとに消す
  await page.evaluate(() => localStorage.clear());

  // Tauriのダイアログのプラグインは window.confirm をOSのダイアログ（非同期）に置き換える。
  // OSのダイアログはテストから操作できないので、メッセージを記録して決めた答えを返すものに置き換える
  const stubConfirm = () =>
    page.evaluate(() => {
      window.__confirms = [];
      window.__confirmReply = true;
      window.confirm = (message) => {
        window.__confirms.push(String(message));
        return Promise.resolve(window.__confirmReply);
      };
    });
  const reload = async () => {
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(500);
    await stubConfirm();
  };
  await reload();

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
    /** 画面を読み込み直す（確認ダイアログの置き換えもやり直す） */
    reload,
    /** 確認ダイアログに「OK」（true）と「キャンセル」（false）のどちらで答えるか */
    setConfirmReply: (reply) => page.evaluate((r) => (window.__confirmReply = r), reply),
    /** 最後に出た確認ダイアログのメッセージ */
    lastConfirm: () => page.evaluate(() => window.__confirms.at(-1) ?? ""),
    shot: (name) => page.screenshot({ path: path.join(shotDir, `${name}.png`) }),
    status: () => page.getByTestId("status").innerText(),
    fileCount: async () => parseInt(await page.getByTestId("file-count").innerText(), 10),
    row: (rel) => page.locator(`[data-testid=file-row][data-rel-path="${rel}"]`),
    // 左のタグの一覧の行
    tagItem: (name) => page.locator(`[data-testid=tag][data-tag-name="${name}"]`),
    // 左のタグの一覧の名前（表示している順）
    tagNames: () => page.getByTestId("tag").evaluateAll((rows) => rows.map((r) => r.dataset.tagName)),
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
      // 登録したフォルダだけの表示になるので、ほかのテストのために外す
      const active = page.locator("[data-testid=folder].active .folder-name");
      if (await active.count()) {
        await active.click();
        await page.waitForTimeout(400);
      }
    },
    /** 登録だけして、絞り込みは外さない */
    async addFolderOnly(p) {
      await page.getByLabel("フォルダのパス").fill(p);
      await page.getByRole("button", { name: "登録", exact: true }).click();
      await ui.waitIdle();
    },
    async clearFilter() {
      // 「すべて解除」は、絞り込みと一緒にチェックと右の欄の表示も外す
      const b = page.getByRole("button", { name: "すべて解除" });
      if (await b.count()) await b.click();
      await page.waitForTimeout(400);
    },
    /** 行のチェックボックスを押す（Shift などは opts で） */
    check: (rel, opts) => page.locator(`[data-testid=file-row][data-rel-path="${rel}"]`).getByTestId("file-check").click(opts),
    checkedCount: () => page.getByTestId("checked-count").innerText(),
    async clearChecks() {
      const b = page.getByRole("button", { name: "チェックをすべて外す" });
      if (await b.isEnabled()) await b.click();
      await page.waitForTimeout(200);
    },
    /** 一括操作の欄のボタン（タグを付ける・タグを外す・出典・ライセンス）で、その操作の欄を開く */
    async bulkMode(label) {
      const b = page.getByTestId("bulk-bar").getByRole("button", { name: label, exact: true });
      if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
    },
    async bulkAddTag(name) {
      await ui.bulkMode("タグを付ける");
      await page.getByLabel("まとめて付けるタグ名").fill(name);
      await page.getByTestId("bulk-bar").getByRole("button", { name: "付ける", exact: true }).click();
      await ui.waitIdle();
    },
    /** 取っ手 handle をつかんで、target の行の高さの ratio の位置まで動かして離す。
     *  release が false なら離さない（落とす前の表示を確かめるとき。後で page.mouse.up() する） */
    async dragTo(handle, target, ratio, release = true) {
      // つかむ所と落とす先を、画面の中までスクロールしてから操作する
      await target.scrollIntoViewIfNeeded();
      await handle.scrollIntoViewIfNeeded();
      const h = await handle.boundingBox();
      const r = await target.boundingBox();
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(r.x + r.width / 2, r.y + r.height * ratio, { steps: 6 });
      if (!release) return;
      await page.mouse.up();
      await ui.waitIdle();
    },
    /** 裏でのハッシュ値の計算が終わるのを待つ（終わると一覧を読み直すので、それも少し待つ） */
    async waitHashing(timeout = 60000) {
      await page.waitForTimeout(500);
      await page.waitForFunction(
        () => document.querySelector("[data-testid=hash-status]")?.textContent?.includes("計算しました"),
        null,
        { timeout },
      );
      await page.waitForTimeout(1000);
    },
    /** タグの管理画面で、ファイルに付けずにタグを作る（作った順に並ぶ） */
    async createTags(names) {
      await page.getByRole("button", { name: "タグを管理" }).click();
      for (const n of names) {
        await page.getByLabel("新しいタグの名前").fill(n);
        await page.getByRole("button", { name: "作成" }).click();
        await ui.waitIdle();
      }
      await page.getByRole("button", { name: "閉じる" }).click();
    },
    async addTag(name) {
      await page.getByLabel("付けるタグ名", { exact: true }).fill(name);
      await page.getByTestId("detail-panel").getByRole("button", { name: "付ける", exact: true }).click();
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
