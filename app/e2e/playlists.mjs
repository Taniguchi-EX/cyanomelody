// 「プレイリスト」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/playlists.mjs <テストデータ> <スクリーンショットの保存先>
import fs from "node:fs";
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("playlists.mjs");
const formats = path.join(dataDir, "formats");
const large = path.join(dataDir, "large");

const ui = await connect(shotDir);
const { page, step, shot, status, row, tagItem, waitIdle, addFolder, clearFilter, addTag } = ui;

const playlistItem = (name) => page.locator(`[data-testid=playlist][data-playlist-name="${name}"]`);
/** 左の欄のプレイリストを「名前:深さ」で表示順に */
const tree = () =>
  page
    .getByTestId("playlist")
    .evaluateAll((rows) => rows.map((r) => `${r.dataset.playlistName}:${r.dataset.depth}`).join(" "));
/** 編集画面の項目を「種類:内容」で */
const items = () =>
  page.getByTestId("playlist-item").evaluateAll((rows) =>
    rows.map((r) => `${r.querySelector(".item-kind").title}:${r.querySelector(".item-content").textContent}`),
  );
const itemRow = (content) => page.getByTestId("playlist-item").filter({ hasText: content });
const editor = () => page.getByTestId("playlist-editor");

async function createPlaylist(name) {
  await page.getByRole("button", { name: "プレイリストを作る" }).click();
  await page.getByLabel("新しいプレイリストの名前").fill(name);
  await page.getByRole("button", { name: "作る", exact: true }).first().click();
  await waitIdle();
}
async function open(name) {
  await playlistItem(name).locator(".tag-name").click();
  await page.waitForTimeout(400);
}
/** 編集画面を開いていれば、ファイルの一覧に戻る */
async function back() {
  const b = page.getByRole("button", { name: "ファイルの一覧に戻る" });
  if ((await b.count()) === 0) return;
  await b.click();
  await page.waitForTimeout(300);
}
const position = () => page.getByTestId("player-position").innerText();

await step("P01", "準備：フォルダを登録し、タグを付け、左の欄でプレイリストを作る（最上位の最後に入る）", async () => {
  await addFolder(formats);
  await row("chime.wav").click();
  await addTag("雨");
  await row("chime.mp3").click();
  await addTag("雨");
  await row("chime.flac").click();
  await addTag("風");
  for (const n of ["戦闘", "環境", "足音"]) await createPlaylist(n);
  expect((await tree()) === "戦闘:0 環境:0 足音:0", await tree());
  await createPlaylist("戦闘");
  expect((await status()).includes("同じ名前のプレイリストがあります"), await status());
  // 作成の入力欄を閉じる
  await page.getByRole("button", { name: "プレイリストを作る" }).click();
});

await step("P02", "一括操作の欄から、チェックしたファイルをプレイリストに追加できる（加えるだけなので確認しない）", async () => {
  await ui.check("chime.wav");
  await ui.check("chime.ogg");
  await ui.bulkMode("プレイリストに追加");
  await page.getByLabel("チェックしたファイルを加えるプレイリスト").selectOption({ label: "戦闘" });
  await page.getByTestId("bulk-bar").getByRole("button", { name: "追加", exact: true }).click();
  await waitIdle();
  expect((await status()).includes("2件をプレイリスト「戦闘」に追加しました"), await status());
  await ui.clearChecks();
});

await step("P03", "右の欄から、1件のファイルをプレイリストに追加できる", async () => {
  await row("chime.flac").click();
  await page.getByLabel("このファイルを加えるプレイリスト").selectOption({ label: "戦闘" });
  await page.getByTestId("detail-panel").getByRole("button", { name: "追加", exact: true }).click();
  await waitIdle();
  await open("戦闘");
  const list = (await items()).join(" / ");
  expect(list === "ファイル:chime.ogg / ファイル:chime.wav / ファイル:chime.flac", list);
});

await step("P04", "タグの組み合わせを加えられる（選んで加える、いまの絞り込みのタグを加える）。ファイル数が出る", async () => {
  await page.getByLabel("組み合わせに選ぶタグ").fill("雨");
  await page.getByRole("button", { name: "選ぶ", exact: true }).click();
  await page.getByRole("button", { name: "この組み合わせを加える" }).click();
  await waitIdle();
  expect((await itemRow("雨").locator(".item-count").innerText()) === "2件", "雨の件数");
  await tagItem("風").click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "いまの絞り込みのタグを加える" }).click();
  await waitIdle();
  expect((await itemRow("風").locator(".item-count").innerText()) === "1件", "風の件数");
  await tagItem("風").click();
  await shot("P04_タグの組み合わせ");
});

await step("P05", "抽象的な項目の再生方法を変えられる（ランダムセレクトは1件）", async () => {
  await page.getByLabel("雨の再生方法").selectOption("random");
  await waitIdle();
  expect((await itemRow("雨").locator(".item-count").innerText()) === "1件", "ランダムセレクトの件数");
  expect((await page.getByLabel("雨の再生方法").inputValue()) === "random", "再生方法が残らない");
});

await step("P06", "別の階層のプレイリストを参照として加えられる。ループになるプレイリストは選べない", async () => {
  await page.getByLabel("加えるプレイリスト", { exact: true }).selectOption({ label: "環境" });
  await page.getByRole("button", { name: "加える", exact: true }).click();
  await waitIdle();
  expect((await items()).includes("プレイリスト:環境"), (await items()).join(" / "));
  // 自分自身は選べない
  expect(await page.locator("select[aria-label=加えるプレイリスト] option", { hasText: "戦闘" }).isDisabled(), "自分自身");
  await open("環境");
  // 戦闘は環境を含むので、環境に戦闘を入れるとループになる
  const opt = page.locator("select[aria-label=加えるプレイリスト] option", { hasText: "戦闘" });
  expect(await opt.isDisabled(), "ループになるのに選べる");
  expect((await opt.innerText()).includes("ループになるため選べません"), await opt.innerText());
  await shot("P06_ループの候補");
});

await step("P07", "子のプレイリストを作ると、左の欄に子として出て、親の項目にも入る", async () => {
  await open("戦闘");
  await page.getByLabel("子のプレイリストの名前").fill("剣");
  await page.getByRole("button", { name: "作る", exact: true }).last().click();
  await waitIdle();
  expect((await tree()) === "戦闘:0 剣:1 環境:0 足音:0", await tree());
  expect((await items()).at(-1) === "子のプレイリスト:剣", (await items()).join(" / "));
});

await step("P08", "項目を取っ手で並べ替えられる", async () => {
  const handles = page.getByTestId("item-handle");
  await ui.dragTo(handles.last(), page.getByTestId("playlist-item").first(), 0.2);
  expect((await items())[0] === "子のプレイリスト:剣", (await items()).join(" / "));
  // 子の項目の位置は、左の欄の子の並びにもなる
  expect((await tree()) === "戦闘:0 剣:1 環境:0 足音:0", await tree());
});

await step("P09", "左の欄の取っ手で、プレイリストを別のプレイリストの子にできる。ループになる位置には落とせない", async () => {
  await ui.dragTo(playlistItem("足音").getByTestId("drag-handle"), playlistItem("環境"), 0.5);
  expect((await tree()) === "戦闘:0 剣:1 環境:0 足音:1", await tree());
  // 戦闘は環境を参照しているので、戦闘を環境の子にするとループになる
  await ui.dragTo(playlistItem("戦闘").getByTestId("drag-handle"), playlistItem("環境"), 0.5, false);
  const cls = await playlistItem("環境").getAttribute("class");
  expect(!/drop-/.test(cls), `ループになる位置に表示が出た: ${cls}`);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect((await tree()) === "戦闘:0 剣:1 環境:0 足音:1", await tree());
  await shot("P09_階層");
});

await step("P10", "子の項目を外すと、その子は最上位に移る（消えない）", async () => {
  await open("環境");
  await itemRow("足音").getByRole("button", { name: "足音を外す" }).click();
  await waitIdle();
  expect((await tree()) === "戦闘:0 剣:1 環境:0 足音:0", await tree());
});

await step("P11", "再生：再生の欄に名前・何曲目か・ファイル名が出て、次へ・前へ・一時停止・停止ができる", async () => {
  await open("戦闘");
  // 剣（空）、ogg・wav・flac、雨から1つ、風の1つ（flac）、環境（空）
  await page.getByRole("button", { name: "順に再生" }).click();
  await page.getByTestId("player-bar").waitFor({ timeout: 5000 });
  expect((await position()) === "1/5", await position());
  expect((await page.getByTestId("player-file").innerText()) === "chime.ogg", await page.getByTestId("player-file").innerText());
  await page.getByRole("button", { name: "次へ" }).click();
  expect((await position()) === "2/5", await position());
  await page.getByRole("button", { name: "前へ" }).click();
  expect((await position()) === "1/5", await position());
  await page.getByRole("button", { name: "一時停止" }).click();
  expect(await page.evaluate(() => document.querySelector("audio").paused), "止まっていない");
  await page.getByRole("button", { name: "再開" }).click();
  expect(!(await page.evaluate(() => document.querySelector("audio").paused)), "再開しない");
  await shot("P11_再生中");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  expect((await page.getByTestId("player-bar").count()) === 0, "再生の欄が残っている");
});

await step("P12", "1曲終わると次を再生し、最後まで再生したら止まる", async () => {
  await open("足音");
  await page.getByRole("button", { name: "ファイルの一覧に戻る" }).click();
  await row("chime.mp3").click();
  await page.getByLabel("このファイルを加えるプレイリスト").selectOption({ label: "足音" });
  await page.getByTestId("detail-panel").getByRole("button", { name: "追加", exact: true }).click();
  await waitIdle();
  await playlistItem("足音").getByRole("button", { name: "足音を再生" }).click();
  await page.getByTestId("player-bar").waitFor({ timeout: 5000 });
  await page.getByTestId("player-bar").waitFor({ state: "detached", timeout: 20000 });
  expect((await status()).includes("「足音」の再生が終わりました"), await status());
});

await step("P13", "再生できないファイルは飛ばして、そのことを表示する", async () => {
  // 一度再生したファイルはWebView2が覚えていることがあるので、まだ再生していないファイルを使う。
  // スキャンせずにファイルを動かすと、見つからない印は付かないが再生できない
  await back();
  await createPlaylist("壊れ");
  for (const rel of ["サブフォルダ/チャイム.m4a", "chime.flac"]) {
    await row(rel).click();
    await page.getByLabel("このファイルを加えるプレイリスト").selectOption({ label: "壊れ" });
    await page.getByTestId("detail-panel").getByRole("button", { name: "追加", exact: true }).click();
    await waitIdle();
  }
  const m4a = path.join(formats, "サブフォルダ", "チャイム.m4a");
  fs.renameSync(m4a, path.join(dataDir, "chime.m4a.moved"));
  try {
    await playlistItem("壊れ").getByRole("button", { name: "壊れを再生" }).click();
    await page.waitForFunction(() => document.querySelector("[data-testid=status]")?.textContent?.includes("飛ばしました"), null, {
      timeout: 5000,
    });
    expect((await status()).includes("サブフォルダ/チャイム.m4a"), await status());
    expect((await position()) === "2/2", await position());
    await page.getByRole("button", { name: "停止", exact: true }).click();
  } finally {
    fs.renameSync(path.join(dataDir, "chime.m4a.moved"), m4a);
  }
});

await step("P14", "試聴を始めると、プレイリストの再生は止まる", async () => {
  await playlistItem("足音").getByRole("button", { name: "足音を再生" }).click();
  await page.getByTestId("player-bar").waitFor({ timeout: 5000 });
  await back();
  await row("chime.wav").getByRole("button", { name: "再生", exact: true }).click();
  await page.waitForTimeout(300);
  expect((await page.getByTestId("player-bar").count()) === 0, "再生の欄が残っている");
  await row("chime.wav").getByRole("button", { name: "停止", exact: true }).click();
});

await step("P15", "名前を変えられる（同じ名前はエラー）", async () => {
  await open("足音");
  await page.getByLabel("プレイリストの名前", { exact: true }).fill("環境");
  await page.getByRole("button", { name: "名前を変える" }).click();
  await waitIdle();
  expect((await status()).includes("同じ名前のプレイリストがあります"), await status());
  await page.getByLabel("プレイリストの名前", { exact: true }).fill("足音（短い）");
  await page.getByRole("button", { name: "名前を変える" }).click();
  await waitIdle();
  expect((await tree()).includes("足音（短い）:0"), await tree());
  // 名前を書き換えていないときは「名前を変える」を出さない
  expect((await page.getByRole("button", { name: "名前を変える" }).count()) === 0, "名前を変えるが残っている");
});

await step("P16", "削除すると、子は繰り上がり、参照していたプレイリストから外れる（確認に書いてある）", async () => {
  // 環境の子に足音（短い）を入れてから、環境を削除する
  await ui.dragTo(playlistItem("足音（短い）").getByTestId("drag-handle"), playlistItem("環境"), 0.5);
  await open("環境");
  await page.getByRole("button", { name: "このプレイリストを削除" }).click();
  await waitIdle();
  const message = await ui.lastConfirm();
  expect(message.includes("子のプレイリスト1件は") && message.includes("入れているプレイリスト1件から外れます"), message);
  expect((await tree()) === "戦闘:0 剣:1 足音（短い）:0 壊れ:0", await tree());
  expect((await editor().count()) === 0, "削除したプレイリストの編集画面が残っている");
  await open("戦闘");
  expect(!(await items()).includes("プレイリスト:環境"), (await items()).join(" / "));
});

await step("P17", "3万件が対象のタグの組み合わせを再生し始めるまでの時間", async () => {
  await back();
  await addFolder(large);
  await page.getByTestId("file-list").click();
  await page.keyboard.press("Control+a");
  await ui.bulkAddTag("大量");
  await ui.clearChecks();
  await createPlaylist("大量");
  await open("大量");
  await page.getByLabel("組み合わせに選ぶタグ").fill("大量");
  await page.getByRole("button", { name: "選ぶ", exact: true }).click();
  await page.getByRole("button", { name: "この組み合わせを加える" }).click();
  await waitIdle();
  // 裏でのハッシュ値の計算（3万件）とデータベースを取り合うと時間がばらつくので、終わるのを待ってから測る
  await ui.waitHashing(120000);
  const t0 = Date.now();
  await page.getByRole("button", { name: "順に再生" }).click();
  await page.getByTestId("player-bar").waitFor({ timeout: 30000 });
  const ms = Date.now() - t0;
  // formats の5件にも「大量」を付けたので 30005件
  expect((await position()) === "1/30005", await position());
  await page.getByRole("button", { name: "停止", exact: true }).click();
  return `${ms}ms`;
});

await step("P18", "編集画面：名前や子のプレイリストの名前の欄でEnterを押すと、変更・作成できる", async () => {
  await open("戦闘");
  await page.getByLabel("プレイリストの名前", { exact: true }).fill("戦闘（Enter）");
  await page.getByLabel("プレイリストの名前", { exact: true }).press("Enter");
  await waitIdle();
  expect((await tree()).startsWith("戦闘（Enter）:0"), await tree());
  await page.getByLabel("子のプレイリストの名前").fill("Enterの子");
  await page.getByLabel("子のプレイリストの名前").press("Enter");
  await waitIdle();
  expect((await tree()).includes("Enterの子:1"), await tree());
});

await step("P19", "項目に別名を付けると、編集画面と再生の欄に別名と元の名前が出る。Escでやめ、空にすると外れる", async () => {
  await back();
  await createPlaylist("別名");
  await row("chime.wav").click();
  await page.getByLabel("このファイルを加えるプレイリスト").selectOption({ label: "別名" });
  await page.getByTestId("detail-panel").getByRole("button", { name: "追加", exact: true }).click();
  await waitIdle();
  await open("別名");
  await page.getByRole("button", { name: "chime.wavの別名を付ける" }).click();
  await page.getByLabel("chime.wavの別名", { exact: true }).fill("途中でやめる");
  await page.getByLabel("chime.wavの別名", { exact: true }).press("Escape");
  expect((await items())[0] === "ファイル:chime.wav", (await items())[0]);
  await page.getByRole("button", { name: "chime.wavの別名を付ける" }).click();
  await page.getByLabel("chime.wavの別名", { exact: true }).fill(" 激しめの雨 ");
  await page.getByLabel("chime.wavの別名", { exact: true }).press("Enter");
  await waitIdle();
  expect((await items())[0] === "ファイル:激しめの雨（chime.wav）", (await items())[0]);
  await shot("P19_別名");
  await page.getByRole("button", { name: "順に再生" }).click();
  await page.getByTestId("player-bar").waitFor({ timeout: 5000 });
  const label = await page.getByTestId("player-file").innerText();
  expect(label === "激しめの雨（chime.wav）", label);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.getByRole("button", { name: "chime.wavの別名を付ける" }).click();
  await page.getByLabel("chime.wavの別名", { exact: true }).fill("");
  await page.getByLabel("chime.wavの別名", { exact: true }).press("Enter");
  await waitIdle();
  expect((await items())[0] === "ファイル:chime.wav", (await items())[0]);
});

await step("P20", "ファイルの行を左の欄のプレイリストへドラッグすると加わる（チェックした行をつかむとチェックしたファイルすべて）", async () => {
  await back();
  await createPlaylist("ドラッグ");
  const target = playlistItem("ドラッグ");
  await ui.dragTo(row("chime.flac").locator(".file-name"), target, 0.5);
  await ui.check("chime.ogg");
  await ui.check("chime.mp3");
  await ui.dragTo(row("chime.ogg").locator(".file-name"), target, 0.5);
  await open("ドラッグ");
  const list = (await items()).join(" / ");
  expect(list === "ファイル:chime.flac / ファイル:chime.mp3 / ファイル:chime.ogg", list);
  await back();
  await ui.clearChecks();
});

await step("P21", "シャッフル・1曲のボタンで、再生方法を選んですぐ再生できる。進み具合のバーを押すとその位置へ移る", async () => {
  await open("ドラッグ");
  await page.getByRole("button", { name: "シャッフル再生" }).click();
  await page.getByTestId("player-bar").waitFor({ timeout: 5000 });
  expect((await position()).endsWith("/3"), await position());
  await page.waitForFunction(() => document.querySelector("audio").duration > 0, null, { timeout: 5000 });
  const bar = page.getByTestId("player-progress");
  const box = await bar.boundingBox();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  const ratio = await page.evaluate(() => {
    const a = document.querySelector("audio");
    return a.currentTime / a.duration;
  });
  expect(ratio > 0.4, `移っていない: ${ratio}`);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.getByRole("button", { name: "ランダムセレクト再生" }).click();
  await page.getByTestId("player-bar").waitFor({ timeout: 5000 });
  expect((await position()) === "1/1", await position());
  await page.getByRole("button", { name: "停止", exact: true }).click();
});

await step("P22", "編集画面で項目の種類の記号を押すと、その項目だけ再生する", async () => {
  await page.getByRole("button", { name: "chime.mp3を再生" }).click();
  await page.getByTestId("player-bar").waitFor({ timeout: 5000 });
  expect((await position()) === "1/1", await position());
  expect((await page.getByTestId("player-file").innerText()) === "chime.mp3", await page.getByTestId("player-file").innerText());
  await page.getByRole("button", { name: "停止", exact: true }).click();
});

await step("P23", "右の欄に、そのファイルを入れているプレイリストが出て、押すと開く", async () => {
  await back();
  await row("chime.flac").click();
  await page.waitForTimeout(300);
  const names = await page.getByTestId("used-in").getByRole("button").allInnerTexts();
  expect(names.includes("ドラッグ"), names.join(","));
  await shot("P23_入っているプレイリスト");
  await page.getByTestId("used-in").getByRole("button", { name: "ドラッグ", exact: true }).click();
  await page.waitForTimeout(300);
  const name = await page.getByLabel("プレイリストの名前", { exact: true }).inputValue();
  expect(name === "ドラッグ", name);
  await back();
});

await ui.finish();
