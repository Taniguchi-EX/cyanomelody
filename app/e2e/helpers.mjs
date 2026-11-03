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
      // フォルダ・ファイルを選ぶOSのダイアログも操作できない。アプリ（dialogs.ts）は、
      // window.__dialogReply が決まっていればダイアログを開かずにそれを返すので、キャンセル（null）にしておく
      window.__dialogReply = null;
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
    /** フォルダ・ファイルを選ぶダイアログで選ぶパス（null ならキャンセル） */
    setDialogReply: (p) => page.evaluate((r) => (window.__dialogReply = r), p),
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
      await ui.addFolderOnly(p);
      // 登録したフォルダだけの表示になるので、ほかのテストのために外す
      const active = page.locator("[data-testid=folder].active .folder-name");
      if (await active.count()) {
        await active.click();
        await page.waitForTimeout(400);
      }
    },
    /** 登録だけして、絞り込みは外さない */
    async addFolderOnly(p) {
      await ui.setDialogReply(p);
      await page.getByRole("button", { name: "フォルダを追加" }).click();
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
    /** チェックの件数の表示。チェックがないときは表示が消えるので、0件の文字列を返す */
    async checkedCount() {
      const el = page.getByTestId("checked-count");
      return (await el.count()) ? el.innerText() : "チェック 0件（表示中 0件）";
    },
    async clearChecks() {
      const b = page.getByRole("button", { name: "チェックをすべて外す" });
      if ((await b.count()) && (await b.isEnabled())) await b.click();
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
    /** 左の欄の行の記号のボタン（✎・🗑）を押す。記号は行にマウスを乗せたときだけ出る */
    async rowAction(item, name) {
      await item.hover();
      await item.getByRole("button", { name, exact: true }).click();
    },
    /** 左の欄のタグの「＋」で、ファイルに付けずにタグを作る（最上位の最後に入る） */
    async createTags(names) {
      for (const n of names) {
        await page.getByRole("button", { name: "タグを作る" }).click();
        await page.getByLabel("新しいタグの名前").fill(n);
        await page.getByLabel("新しいタグの名前").press("Enter");
        await ui.waitIdle();
      }
    },
    /** 左の欄のタグの「✎」で名前を変える（Enterで決める） */
    async renameTag(from, to) {
      await ui.rowAction(ui.tagItem(from), `${from}の名前を変える`);
      await page.getByLabel("タグの新しい名前").fill(to);
      await page.getByLabel("タグの新しい名前").press("Enter");
      await ui.waitIdle();
    },
    /** 右の欄で、表示中のファイルにタグを付ける（名前を入れてEnter。まだないタグは作って付く） */
    async addTag(name) {
      await page.getByLabel("付けるタグ名", { exact: true }).fill(name);
      await page.getByLabel("付けるタグ名", { exact: true }).press("Enter");
      await ui.waitIdle();
    },
    /** 右の欄のタグの入力欄で、候補の一覧からタグを選ぶ（ブラウザが候補で置き換えたときと同じ入力を起こす） */
    async pickTag(name) {
      await page.getByLabel("付けるタグ名", { exact: true }).evaluate((el, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: v }));
      }, name);
      await ui.waitIdle();
    },
    /** 右の欄のプルダウンで、表示中のファイルをプレイリストに加える（選ぶとすぐ加わる） */
    async addToPlaylistHere(name) {
      await page.getByLabel("このファイルを加えるプレイリスト").selectOption({ label: name });
      await ui.waitIdle();
    },
    /** 再生の欄が再生中になるのを待つ（再生の欄は何も再生していないときも出ている） */
    waitPlaying: (timeout = 5000) => page.locator("[data-testid=player-bar][data-playing=true]").waitFor({ timeout }),
    waitStopped: (timeout = 5000) => page.locator("[data-testid=player-bar][data-playing=false]").waitFor({ timeout }),
    isPlaying: async () => (await page.getByTestId("player-bar").getAttribute("data-playing")) === "true",
    /** 開いているプレイリストの名前を、上の行の「✎」で変える（Enterで決める） */
    async renameOpenPlaylist(name) {
      await page.getByRole("button", { name: "プレイリストの名前を変える" }).click();
      await page.getByLabel("プレイリストの名前", { exact: true }).fill(name);
      await page.getByLabel("プレイリストの名前", { exact: true }).press("Enter");
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
