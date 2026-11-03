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
  await page.getByLabel("新しいプレイリストの名前").press("Enter");
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
  // 作れなかったときは入力欄が残る。Escで閉じる
  await page.getByLabel("新しいプレイリストの名前").press("Escape");
  expect((await page.getByLabel("新しいプレイリストの名前").count()) === 0, "Escで閉じない");
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
  await ui.addToPlaylistHere("戦闘");
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
  await page.getByRole("button", { name: "作る", exact: true }).click();
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
  await ui.waitPlaying();
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
  expect(!(await ui.isPlaying()), "再生中のまま");
  // 再生の欄は何も再生していないときも出ていて、曲の名前は空、ボタンは開いているプレイリストの再生だけ押せる
  expect((await page.getByTestId("player-file").innerText()) === "", "曲の名前が残っている");
  expect(await page.getByRole("button", { name: "次へ" }).isDisabled(), "次へが押せる");
  expect(!(await page.getByRole("button", { name: "順に再生" }).isDisabled()), "開いているのに順に再生が押せない");
});

await step("P12", "1曲終わると次を再生し、最後まで再生したら止まる", async () => {
  await back();
  await row("chime.mp3").click();
  await ui.addToPlaylistHere("足音");
  await open("足音");
  await page.getByRole("button", { name: "順に再生" }).click();
  await ui.waitPlaying();
  await ui.waitStopped(20000);
  expect((await status()).includes("「足音」の再生が終わりました"), await status());
});

await step("P13", "再生できないファイルは飛ばして、そのことを表示する", async () => {
  // 一度再生したファイルはWebView2が覚えていることがあるので、まだ再生していないファイルを使う。
  // スキャンせずにファイルを動かすと、見つからない印は付かないが再生できない
  await back();
  await createPlaylist("壊れ");
  for (const rel of ["サブフォルダ/チャイム.m4a", "chime.flac"]) {
    await row(rel).click();
    await ui.addToPlaylistHere("壊れ");
  }
  const m4a = path.join(formats, "サブフォルダ", "チャイム.m4a");
  fs.renameSync(m4a, path.join(dataDir, "chime.m4a.moved"));
  try {
    await open("壊れ");
    await page.getByRole("button", { name: "順に再生" }).click();
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
  await open("足音");
  await page.getByRole("button", { name: "順に再生" }).click();
  await ui.waitPlaying();
  await back();
  await row("chime.wav").getByRole("button", { name: "再生", exact: true }).click();
  await page.waitForTimeout(300);
  expect(!(await ui.isPlaying()), "プレイリストの再生が止まらない");
  await row("chime.wav").getByRole("button", { name: "停止", exact: true }).click();
});

await step("P15", "上の行の「✎」で名前を変えられる（同じ名前はエラー。Escでやめる）", async () => {
  await open("足音");
  const input = page.getByLabel("プレイリストの名前", { exact: true });
  expect((await input.count()) === 0, "最初から入力欄になっている");
  expect((await page.getByTestId("playlist-title").innerText()) === "足音", await page.getByTestId("playlist-title").innerText());
  await page.getByRole("button", { name: "プレイリストの名前を変える" }).click();
  await input.fill("やめる");
  await input.press("Escape");
  expect((await input.count()) === 0, "Escで閉じない");
  expect((await tree()).includes("足音:"), await tree());
  await page.getByRole("button", { name: "プレイリストの名前を変える" }).click();
  await input.fill("環境");
  await input.press("Enter");
  await waitIdle();
  expect((await status()).includes("同じ名前のプレイリストがあります"), await status());
  // 変えられなかったときは入力欄が残る
  await input.fill("足音（短い）");
  await input.press("Enter");
  await waitIdle();
  expect((await tree()).includes("足音（短い）:0"), await tree());
  expect((await page.getByTestId("playlist-title").innerText()) === "足音（短い）", "見出しが変わらない");
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
  await ui.waitPlaying(30000);
  const ms = Date.now() - t0;
  // formats の5件にも「大量」を付けたので 30005件
  expect((await position()) === "1/30005", await position());
  await page.getByRole("button", { name: "停止", exact: true }).click();
  return `${ms}ms`;
});

await step("P18", "編集画面：名前や子のプレイリストの名前の欄でEnterを押すと、変更・作成できる", async () => {
  await open("戦闘");
  await ui.renameOpenPlaylist("戦闘（Enter）");
  expect((await tree()).startsWith("戦闘（Enter）:0"), await tree());
  await page.getByLabel("子のプレイリストの名前").fill("Enterの子");
  await page.getByLabel("子のプレイリストの名前").press("Enter");
  await waitIdle();
  expect((await tree()).includes("Enterの子:1"), await tree());
});

await step("P19", "項目の行を押すと右の欄に出て、「プレイリスト上での名前」を付けられる。一覧と再生の欄はその名前で出る。Escで戻し、空にすると外れる", async () => {
  await back();
  await createPlaylist("別名");
  await row("chime.wav").click();
  await ui.addToPlaylistHere("別名");
  await open("別名");
  const alias = page.getByLabel("プレイリスト上での名前");
  expect((await alias.count()) === 0, "押す前から出ている");
  await itemRow("chime.wav").locator(".item-content").click();
  expect((await itemRow("chime.wav").getAttribute("class")).includes("selected"), "押した行に色が付かない");
  // 右の欄には、一番上に「プレイリスト上での名前」、その下にファイルの詳細が出る
  expect((await page.getByTestId("detail-path").innerText()) === "chime.wav", await page.getByTestId("detail-path").innerText());
  await alias.fill("途中でやめる");
  await alias.press("Escape");
  expect((await alias.inputValue()) === "", "Escで戻らない");
  await alias.fill(" 激しめの雨 ");
  await alias.press("Enter");
  await waitIdle();
  // 一覧はプレイリスト上での名前だけを出し、元の名前はマウスを乗せたときに出す
  expect((await items())[0] === "ファイル:激しめの雨", (await items())[0]);
  expect((await itemRow("激しめの雨").locator(".item-content").getAttribute("title")) === "chime.wav", "元の名前が出ない");
  await shot("P19_プレイリスト上での名前");
  await page.getByRole("button", { name: "順に再生" }).click();
  await ui.waitPlaying();
  const label = await page.getByTestId("player-file").innerText();
  expect(label === "激しめの雨", label);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.getByLabel("プレイリスト上での名前").fill("");
  await page.getByLabel("プレイリスト上での名前").press("Enter");
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
  await ui.waitPlaying();
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
  await ui.waitPlaying();
  expect((await position()) === "1/1", await position());
  await page.getByRole("button", { name: "停止", exact: true }).click();
});

await step("P22", "編集画面で項目の種類の記号を押すと、その項目だけ再生する", async () => {
  await page.getByRole("button", { name: "chime.mp3を再生" }).click();
  await ui.waitPlaying();
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
  const name = await page.getByTestId("playlist-title").innerText();
  expect(name === "ドラッグ", name);
  await back();
});

await step("P24", "左の欄のプレイリストの行には、開閉の印・名前・数・取っ手だけが出る（再生・名前の変更・削除は詳細画面）", async () => {
  await back();
  const item = playlistItem("ドラッグ");
  await item.hover();
  expect((await item.getByRole("button").count()) === 0, `行にボタンがある: ${await item.getByRole("button").allInnerTexts()}`);
  expect((await item.getByTestId("drag-handle").count()) === 1, "取っ手がない");
});

await step("P25", "詳細画面：丸い「＜」で戻る。「書き出す」と「🗑」は一番下の行。タグの組み合わせの項目を押すと、右の欄にその名前の欄と内容が出る", async () => {
  await createPlaylist("消す用");
  await open("消す用");
  await page.getByLabel("組み合わせに選ぶタグ").fill("雨");
  await page.getByRole("button", { name: "選ぶ", exact: true }).click();
  await page.getByRole("button", { name: "この組み合わせを加える" }).click();
  await waitIdle();
  const foot = page.locator(".editor-foot");
  expect((await foot.getByRole("button", { name: "書き出す" }).count()) === 1, "書き出すが下の行にない");
  expect((await foot.getByRole("button", { name: "このプレイリストを削除" }).count()) === 1, "削除が下の行にない");
  await itemRow("雨").locator(".item-content").click();
  expect((await page.getByTestId("item-detail-content").innerText()) === "雨", await page.getByTestId("item-detail-content").innerText());
  await page.getByLabel("プレイリスト上での名前").fill("雨の組");
  await page.getByLabel("プレイリスト上での名前").press("Enter");
  await waitIdle();
  expect((await items())[0] === "タグ:雨の組", (await items())[0]);
  // 行の中のプルダウンを押しても、右の欄は変わらない（別の項目を押していないので、そのまま）
  await page.getByLabel("雨のエフェクト").click();
  await page.keyboard.press("Escape");
  await shot("P25_詳細画面");
  await page.getByRole("button", { name: "このプレイリストを削除" }).click();
  await waitIdle();
  expect((await ui.lastConfirm()).includes("プレイリスト「消す用」を削除しますか"), await ui.lastConfirm());
  expect(!(await tree()).includes("消す用"), await tree());
  expect((await editor().count()) === 0, "削除したのに詳細画面が残っている");
});

await step("P26", "再生の欄：何も再生していないときは、開いているプレイリストがなければ再生のボタンは押せない。シークバーをドラッグして位置を変えられる", async () => {
  await back();
  for (const name of ["順に再生", "シャッフル再生", "ランダムセレクト再生", "前へ", "次へ", "停止"]) {
    expect(await page.getByRole("button", { name, exact: true }).isDisabled(), `${name}が押せる`);
  }
  await open("ドラッグ");
  await page.getByRole("button", { name: "順に再生" }).click();
  await ui.waitPlaying();
  await page.waitForFunction(() => document.querySelector("audio").duration > 0, null, { timeout: 5000 });
  await page.getByRole("button", { name: "一時停止" }).click();
  const bar = page.getByTestId("player-progress");
  const box = await bar.boundingBox();
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 5 });
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const ratio = await page.evaluate(() => {
    const a = document.querySelector("audio");
    return a.currentTime / a.duration;
  });
  expect(ratio > 0.6, `移っていない: ${ratio}`);
  await shot("P26_再生の欄");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await back();
});

await ui.finish();
