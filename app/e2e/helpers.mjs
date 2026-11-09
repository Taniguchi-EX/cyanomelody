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
  // 画面テストが最後に見た、終わった処理の数（アプリの data-run-count。読み込み直すと0に戻る）
  let seenRuns = 0;
  const reload = async () => {
    seenRuns = 0;
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    // 一覧を読み終わる（一覧の版が1以上になる）のを待つ
    await page.waitForFunction(() => Number(document.querySelector("[data-testid=counts]")?.dataset.listVersion) > 0, null, {
      timeout: 10000,
    });
    await stubConfirm();
  };
  await reload();

  const results = [];
  const ui = {
    page,
    /** テストを1件行う。かかった時間（ms）も results.json に残す（テストの時間を見直すため） */
    async step(id, name, fn) {
      const t0 = Date.now();
      try {
        const note = await fn();
        results.push({ id, name, ok: true, note: note ?? "", ms: Date.now() - t0 });
        console.log(`OK   ${id} ${name}${note ? `（${note}）` : ""}`);
      } catch (e) {
        results.push({ id, name, ok: false, note: String(e.message ?? e).split("\n")[0], ms: Date.now() - t0 });
        console.log(`FAIL ${id} ${name}: ${e.message ?? e}`);
      }
    },
    /** 画面を読み込み直す（確認ダイアログの置き換えもやり直す） */
    reload,
    /** 確認ダイアログに「OK」（true）と「キャンセル」（false）のどちらで答えるか */
    setConfirmReply: (reply) => page.evaluate((r) => (window.__confirmReply = r), reply),
    /** フォルダ・ファイルを選ぶダイアログで選ぶパス（null ならキャンセル） */
    setDialogReply: (p) => page.evaluate((r) => (window.__dialogReply = r), p),
    /** action を行い、確認ダイアログが出る（答えは setConfirmReply のとおり）のを待つ */
    async confirmed(action) {
      const n = await page.evaluate(() => window.__confirms.length);
      await action();
      await page.waitForFunction((n) => window.__confirms.length > n, n, { timeout: 5000 });
    },
    /** 下の行（処理の結果）に text が出るのを待つ */
    waitStatus: (text, timeout = 5000) =>
      page.waitForFunction((t) => document.querySelector("[data-testid=status]")?.textContent?.includes(t), text, { timeout }),
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
    /**
     * 絞り込みの条件を変える操作 action を行い、一覧が読み直されるのを待つ。
     * アプリは一覧を読み直すたびに data-list-version を増やすので、操作の前より増えるのを待つ（検索の欄は入力を少し待ってから読み直す）
     */
    async filtered(action) {
      const version = () => page.getByTestId("counts").getAttribute("data-list-version").then(Number);
      const before = await version();
      await action();
      await page
        .waitForFunction((b) => Number(document.querySelector("[data-testid=counts]")?.dataset.listVersion) > b, before, {
          timeout: 3000,
        })
        .catch(() => {});
      await page.waitForTimeout(50);
    },
    /**
     * 操作で始まった処理が終わるのを待つ。アプリは処理（run）が終わるたびに data-run-count を増やすので、
     * 前に見たときより増えて、処理中でなくなるのを待つ。処理を伴わない操作では、1秒待って戻る
     */
    async waitIdle() {
      const done = (seen) => {
        const el = document.querySelector("[data-testid=status]");
        return el && el.textContent !== "処理中…" && Number(el.dataset.runCount) > seen;
      };
      await page.waitForFunction(done, seenRuns, { timeout: 1000 }).catch(() => {});
      // 1秒より長い処理（スキャンなど）は、処理中が終わるまで待つ
      await page.waitForFunction(
        () => document.querySelector("[data-testid=status]")?.textContent !== "処理中…",
        null,
        { timeout: 120000 },
      );
      seenRuns = Number(await page.getByTestId("status").getAttribute("data-run-count"));
      // 読み直した一覧などが描かれるのを待つ
      await page.waitForTimeout(50);
    },
    async addFolder(p) {
      await ui.addFolderOnly(p);
      // 登録したフォルダだけの表示になるので、ほかのテストのために外す
      const active = page.locator("[data-testid=folder].active .folder-name");
      if (await active.count()) {
        await ui.filtered(() => active.click());
      }
    },
    /** 登録だけして、絞り込みは外さない */
    async addFolderOnly(p) {
      await ui.setDialogReply(p);
      await page.getByRole("button", { name: "フォルダを追加" }).click();
      await ui.waitIdle();
    },
    /** 絞り込みの条件（検索の文字、条件のチップ、チェックしたファイルだけ表示）とチェックを外す */
    async clearFilter() {
      const search = page.getByLabel("ファイル名で検索", { exact: true });
      if ((await search.count()) && (await search.inputValue())) await ui.filtered(() => search.fill(""));
      // 条件のチップが2つ以上なら名前のない「✕」でまとめて、1つならそのチップを押して外す
      const all = page.getByRole("button", { name: "絞り込みの条件をすべて外す" });
      const chip = page.getByTestId("filter-chips").getByRole("button");
      if (await all.count()) await ui.filtered(() => all.click());
      else if (await chip.count()) await ui.filtered(() => chip.first().click());
      const only = page.getByLabel("チェックしたファイルだけ表示");
      if ((await only.count()) && (await only.isChecked())) await ui.filtered(() => only.uncheck());
      await ui.clearChecks();
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
      if (!((await b.count()) && (await b.isEnabled()))) return;
      await b.click();
      // チェックの件数が0件になる（表示が消える）のを待つ
      await page.waitForFunction(
        () => !document.querySelector("[data-testid=checked-count]")?.textContent?.match(/チェック [1-9]/),
        null,
        { timeout: 3000 },
      );
    },
    /** チェックしている行（表示中の最初の1行）をつかんで target に落とす。チェックしたファイルすべてが対象になる */
    async dragChecked(target) {
      await ui.dragTo(page.locator("[data-testid=file-row].checked").first().locator(".file-name"), target, 0.5);
      await ui.waitIdle();
    },
    /** チェックしたファイルすべてに、ドラッグでタグを付ける（まだないタグは左の欄の「＋」で作っておく） */
    async bulkAddTag(name) {
      if (!(await ui.tagNames()).includes(name)) await ui.createTags([name]);
      await ui.dragChecked(ui.tagItem(name));
    },
    /** handle（行の名前など、行の中のつかむ所）をつかんで、target の行の高さの ratio の位置まで動かして離す。
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
    /** 左の欄の「その他」の項目（duplicatesOnly・recentOnly・missingOnly） */
    otherItem: (key) => page.locator(`[data-testid=other][data-other=${key}]`),
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
    /** 左の欄のタグの「✎」で詳細画面を開く */
    async openTagDetail(name) {
      await ui.rowAction(ui.tagItem(name), `${name}の詳細を設定する`);
      await page.getByTestId("tag-detail").waitFor();
    },
    /** タグの詳細画面で名前を変える（Enterで保存する） */
    async renameTag(from, to) {
      await ui.openTagDetail(from);
      await page.getByLabel("タグ名", { exact: true }).fill(to);
      await page.getByLabel("タグ名", { exact: true }).press("Enter");
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
    /** 左の欄のプレイリストの行 */
    playlistItem: (name) => page.locator(`[data-testid=playlist][data-playlist-name="${name}"]`),
    /** プレイリストの編集画面（重ねて出す） */
    editor: () => page.getByTestId("playlist-editor"),
    /** 編集画面を開いていれば閉じる */
    async closeEditor() {
      if ((await ui.editor().count()) === 0) return;
      await ui.editor().getByRole("button", { name: "閉じる", exact: true }).click();
      await ui.editor().waitFor({ state: "detached", timeout: 3000 });
    },
    /** 編集画面を閉じ、プレイリストの選択も外す（ライブラリの一覧に戻る） */
    async leavePlaylist() {
      await ui.closeEditor();
      const chip = page.getByTestId("playlist-filter");
      if ((await chip.count()) > 0) await ui.filtered(() => chip.click());
    },
    /** 左の欄の「＋」でプレイリストを作る（編集画面を開いていれば閉じてから） */
    async createPlaylist(name) {
      await ui.closeEditor();
      await page.getByRole("button", { name: "プレイリストを作る" }).click();
      await page.getByLabel("新しいプレイリストの名前").fill(name);
      await page.getByLabel("新しいプレイリストの名前").press("Enter");
      await ui.waitIdle();
    },
    /** 左の欄の行を押してプレイリストを選ぶ（抽選して、中央の一覧がその並びになる）。選んでいれば何もしない */
    async selectPlaylist(name) {
      await ui.closeEditor();
      if ((await page.getByTestId("playlist-filter").filter({ hasText: name }).count()) > 0) return;
      await ui.filtered(() => ui.playlistItem(name).locator(".tag-name").click());
      await page.getByTestId("list-title").filter({ hasText: name }).waitFor({ timeout: 3000 });
    },
    /** 左の欄の行のダブルクリックで、プレイリストの編集画面を開く（1回目の押しで選ぶ） */
    async openEditor(name) {
      await ui.closeEditor();
      await ui.playlistItem(name).locator(".tag-name").dblclick();
      await ui.editor().waitFor({ timeout: 3000 });
      await page.getByTestId("playlist-title").filter({ hasText: name }).waitFor({ timeout: 3000 });
    },
    /** 編集画面で、タグの組み合わせの項目を加える */
    async addCombo(tags) {
      const input = page.getByLabel("組み合わせに加えるタグ");
      for (const t of tags) {
        await input.fill(t);
        await input.press("Enter");
      }
      await page.getByRole("button", { name: "タグの組み合わせを追加" }).click();
      await ui.waitIdle();
    },
    async addToPlaylistHere(name) {
      await page.getByLabel("このファイルを加えるプレイリスト").selectOption({ label: name });
      await ui.waitIdle();
    },
    /** 再生の欄が再生中になるのを待つ（再生の欄は何も再生していないときも出ている） */
    waitPlaying: (timeout = 5000) => page.locator("[data-testid=player-bar][data-playing=true]").waitFor({ timeout }),
    waitStopped: (timeout = 5000) => page.locator("[data-testid=player-bar][data-playing=false]").waitFor({ timeout }),
    isPlaying: async () => (await page.getByTestId("player-bar").getAttribute("data-playing")) === "true",
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
