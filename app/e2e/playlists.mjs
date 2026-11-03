// 「プレイリスト」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/playlists.mjs <テストデータ> <スクリーンショットの保存先>
import fs from "node:fs";
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("playlists.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, status, row, tagItem, waitIdle, addFolder, addTag } = ui;

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
  await page.getByTestId("playlist-title").filter({ hasText: name }).waitFor({ timeout: 3000 });
}
/** 編集画面を開いていれば、ファイルの一覧に戻る */
async function back() {
  const b = page.getByRole("button", { name: "ファイルの一覧に戻る" });
  if ((await b.count()) === 0) return;
  await b.click();
  await page.getByTestId("list-title").waitFor({ timeout: 3000 });
}
const position = () => page.getByTestId("player-position").innerText();

await step("P01", "準備：フォルダを登録し、タグを付け、左の欄でプレイリストを作る（最上位の最後に入る。同じ名前は作れない）。チェックしたファイルをドラッグしてまとめて加える", async () => {
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
  // チェックしたファイルを、左の欄のプレイリストにドラッグしてまとめて加える（旧 P02）
  await ui.check("chime.wav");
  await ui.check("chime.ogg");
  await ui.dragChecked(playlistItem("戦闘"));
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

await step("P04", "左の欄で選んでいるタグを「選択タグをリストに追加」で加えられる（選んでいないときは押せない）。ファイル数が出る", async () => {
  const addSelected = page.getByRole("button", { name: "選択タグをリストに追加" });
  expect(await addSelected.isDisabled(), "タグを選んでいないのに押せる");
  expect((await page.getByLabel("組み合わせに選ぶタグ").count()) === 0, "タグをその場で選ぶ欄が残っている");
  for (const [tag, count] of [["雨", "2件"], ["風", "1件"]]) {
    await ui.filtered(() => tagItem(tag).click());
    await addSelected.click();
    await waitIdle();
    expect((await itemRow(tag).locator(".item-count").innerText()) === count, `${tag}の件数`);
    await ui.filtered(() => tagItem(tag).click());
  }
  await shot("P04_タグの組み合わせ");
});

await step("P05", "抽象的な項目の再生方法を変えられる（ランダムセレクトは1件）", async () => {
  await page.getByLabel("雨の再生方法").selectOption("random");
  await waitIdle();
  expect((await itemRow("雨").locator(".item-count").innerText()) === "1件", "ランダムセレクトの件数");
  expect((await page.getByLabel("雨の再生方法").inputValue()) === "random", "再生方法が残らない");
});

await step("P06", "別の階層のプレイリストを参照として加えられる。ループになるプレイリストは選べない", async () => {
  // プルダウンで選ぶとすぐに加わる（「加える」ボタンはない）
  const select = page.getByLabel("加えるプレイリスト", { exact: true });
  expect((await select.locator("option").first().innerText()) === "プレイリストを追加", await select.locator("option").first().innerText());
  await select.selectOption({ label: "環境" });
  await waitIdle();
  expect((await select.inputValue()) === "", "プルダウンが戻らない");
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

await step("P07", "左の欄で作ったプレイリストを、取っ手で別のプレイリストの中に落とすと子になり、親の項目にも入る", async () => {
  await createPlaylist("剣");
  await ui.dragTo(playlistItem("剣").getByTestId("drag-handle"), playlistItem("戦闘"), 0.5);
  expect((await tree()) === "戦闘:0 剣:1 環境:0 足音:0", await tree());
  await open("戦闘");
  expect((await items()).at(-1) === "子のプレイリスト:剣", (await items()).join(" / "));
  // 詳細画面に「子のプレイリストを作る」の欄はない
  expect((await page.getByLabel("子のプレイリストの名前").count()) === 0, "子のプレイリストを作る欄が残っている");
});

await step("P08", "項目を取っ手で並べ替えられる。左の欄の取っ手で別のプレイリストの子にでき、ループになる位置には落とせない", async () => {
  const handles = page.getByTestId("item-handle");
  await ui.dragTo(handles.last(), page.getByTestId("playlist-item").first(), 0.2);
  expect((await items())[0] === "子のプレイリスト:剣", (await items()).join(" / "));
  // 子の項目の位置は、左の欄の子の並びにもなる
  expect((await tree()) === "戦闘:0 剣:1 環境:0 足音:0", await tree());
  // 左の欄の取っ手で子にする。ループになる位置には落とせない（旧 P09）
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
  // 子の項目を外すと、その子は最上位に移る（旧 P10）
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
  // 曲の名前は音声ファイルの中の曲名（タグ情報のタイトル）、2行目にファイル名
  expect((await page.getByTestId("player-file").innerText()) === "チャイム", await page.getByTestId("player-file").innerText());
  expect((await page.getByTestId("player-file-name").innerText()) === "chime.ogg", await page.getByTestId("player-file-name").innerText());
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

await step("P14", "一覧の行の「▶」を押すと、プレイリストの再生をやめて、表示中の一覧の再生になる", async () => {
  await open("足音");
  await page.getByRole("button", { name: "順に再生" }).click();
  await ui.waitPlaying();
  await back();
  await row("chime.wav").getByRole("button", { name: "再生", exact: true }).click();
  await ui.waitPlaying();
  expect((await page.locator(".player-name").innerText()) === "ファイルの一覧", await page.locator(".player-name").innerText());
  await row("chime.wav").getByRole("button", { name: "停止", exact: true }).click();
  await ui.waitStopped();
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
  expect((await page.getByTestId("detail-path").innerText()).endsWith("chime.wav"), await page.getByTestId("detail-path").innerText());
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
  // プレイリスト上での名前があるときは、2行目にファイル名も出す
  expect((await page.getByTestId("player-file-name").innerText()) === "chime.wav", "ファイル名が出ない");
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

await step("P21", "シャッフル・1曲のボタンで、再生方法を選んですぐ再生できる。何も再生していないときは、開いているプレイリストがなければ再生のボタンは押せない。シークバーは押す・ドラッグで位置が変わる", async () => {
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
  // 何も再生していないときの再生の欄と、シークバーのドラッグ（旧 P26）
  {
    await back();
    // 何も再生していないとき、「⏮」「⏭」「■」は押せない（「▶」「🔀」「🎲」は表示中の一覧を再生するので押せる）
    for (const name of ["前へ", "次へ", "停止"]) {
      expect(await page.getByRole("button", { name, exact: true }).isDisabled(), `${name}が押せる`);
    }
    // ボタンの並びは「⏮ ▶ ⏭ 🔀 🎲 ■」（シャッフル再生は右に寄せる）
    const order = await page.locator(".play-buttons button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")).join(","));
    expect(order === "前へ,順に再生,次へ,シャッフル再生,ランダムセレクト再生,停止", order);
    // 「▶／⏸」はボタンの並びの中央（真下のシークバーの中央とそろう）
    const center = async (sel) => {
      const b = await page.locator(sel).boundingBox();
      return b.x + b.width / 2;
    };
    const diff = Math.abs((await center(".play-main")) - (await center(".play-seek input")));
    expect(diff <= 2, `中央からずれている: ${diff}px`);
    // 丸の中の記号は丸の中心に来る
    const iconOff = await page.locator(".play-main").evaluate((b) => {
      const o = b.getBoundingClientRect();
      const i = b.querySelector("svg").getBoundingClientRect();
      return Math.max(Math.abs(o.x + o.width / 2 - (i.x + i.width / 2)), Math.abs(o.y + o.height / 2 - (i.y + i.height / 2)));
    });
    expect(iconOff <= 1.5, `記号が丸の中心からずれている: ${iconOff}px`);
    // 「■」（停止）の右端は、曲の長さの文字の右端とそろう
    const rightGap = await page.evaluate(() => {
      const stop = document.querySelector(".play-modes button:last-child").getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("[data-testid=player-duration]"));
      return Math.abs(stop.right - range.getBoundingClientRect().right);
    });
    expect(rightGap <= 2, `右端がそろっていない: ${rightGap}px`);
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
  }
});

await step("P22", "編集画面で項目の種類の記号を押すと、その項目だけ再生する", async () => {
  await page.getByRole("button", { name: "chime.mp3を再生" }).click();
  await ui.waitPlaying();
  expect((await position()) === "1/1", await position());
  expect((await page.getByTestId("player-file-name").innerText()) === "chime.mp3", await page.getByTestId("player-file-name").innerText());
  await page.getByRole("button", { name: "停止", exact: true }).click();
});

await step("P23", "右の欄に、そのファイルを入れているプレイリストが条件のチップと同じ形で出る。名前を押すと開き、「✕」でそのプレイリストから外れる", async () => {
  await back();
  await row("chime.flac").click();
  await page.getByTestId("used-in").waitFor({ timeout: 3000 });
  const usedIn = page.getByTestId("used-in");
  const names = await usedIn.locator("[data-playlist-name]").evaluateAll((els) => els.map((e) => e.dataset.playlistName));
  expect(names.includes("ドラッグ"), names.join(","));
  await shot("P23_入っているプレイリスト");
  await usedIn.getByRole("button", { name: "ドラッグを開く" }).click();
  await page.getByTestId("playlist-title").filter({ hasText: "ドラッグ" }).waitFor({ timeout: 3000 });
  const name = await page.getByTestId("playlist-title").innerText();
  expect(name === "ドラッグ", name);
  const before = (await items()).length;
  await back();
  await row("chime.flac").click();
  await page.getByTestId("used-in").getByRole("button", { name: "ドラッグから外す" }).click();
  await waitIdle();
  expect((await status()).includes("プレイリスト「ドラッグ」から外しました"), await status());
  expect((await page.locator("[data-testid=used-in] [data-playlist-name=ドラッグ]").count()) === 0, "チップが残っている");
  await open("ドラッグ");
  expect((await items()).length === before - 1, (await items()).join(" / "));
  expect(!(await items()).includes("ファイル:chime.flac"), (await items()).join(" / "));
  // 後のテストのために戻す
  await back();
  await row("chime.flac").click();
  await ui.addToPlaylistHere("ドラッグ");
  await back();
});

await step("P25", "左の欄の行は開閉の印・名前・数・取っ手だけ。詳細画面：丸い「＜」で戻る。「書き出す」と「🗑」は一番下の行。タグの組み合わせの項目を押すと、右の欄にその名前の欄と内容が出る", async () => {
  // 左の欄のプレイリストの行には、開閉の印・名前・数・取っ手だけ（旧 P24）
  await back();
  const item = playlistItem("ドラッグ");
  await item.hover();
  expect((await item.getByRole("button").count()) === 0, `行にボタンがある: ${await item.getByRole("button").allInnerTexts()}`);
  expect((await item.getByTestId("drag-handle").count()) === 1, "取っ手がない");
  await createPlaylist("消す用");
  await open("消す用");
  await ui.filtered(() => tagItem("雨").click());
  await page.getByRole("button", { name: "選択タグをリストに追加" }).click();
  await waitIdle();
  await ui.filtered(() => tagItem("雨").click());
  const foot = page.locator(".editor-foot");
  expect((await foot.getByRole("button", { name: "書出" }).count()) === 1, "書出が下の行にない");
  expect((await foot.getByRole("button", { name: "このプレイリストを削除" }).count()) === 1, "削除が下の行にない");
  await itemRow("雨").locator(".item-content").click();
  expect((await page.getByTestId("item-detail-content").innerText()) === "雨", await page.getByTestId("item-detail-content").innerText());
  // その項目の曲のリスト（ファイル名で、順に再生したときの並び）と曲数
  await page.getByTestId("item-tracks").waitFor({ timeout: 3000 });
  const tracks = await page.getByTestId("item-tracks").locator("li").allInnerTexts();
  expect(tracks.join(",") === "chime.mp3,chime.wav", tracks.join(","));
  expect((await page.getByTestId("item-track-count").innerText()) === "2", "曲数");
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

await step("P27", "再生の欄：一覧の再生でも曲名を出し、2行目にファイル名と「ファイルの一覧」・何曲目", async () => {
  await back();
  await row("chime.mp3").getByRole("button", { name: "再生", exact: true }).click();
  await ui.waitPlaying();
  // 曲名はファイルから読むので、読み終わるのを待つ（それまでは拡張子を除いたファイル名）
  await page.waitForFunction(() => document.querySelector("[data-testid=player-file]")?.textContent === "チャイム", null, {
    timeout: 3000,
  }).catch(() => {});
  expect((await page.getByTestId("player-file").innerText()) === "チャイム", await page.getByTestId("player-file").innerText());
  expect((await page.getByTestId("player-file-name").innerText()) === "chime.mp3", "ファイル名が出ない");
  expect((await page.locator(".player-name").innerText()) === "ファイルの一覧", "一覧の再生と出ない");
  await shot("P27_一覧の再生");
  await row("chime.mp3").getByRole("button", { name: "停止", exact: true }).click();
  await ui.waitStopped();
});

await step("P28", "再生の欄の音量のバーで音量を変えられる（試聴にも効く）。音量は再読み込み後も残る", async () => {
  const volume = page.getByLabel("音量");
  expect((await volume.inputValue()) === "100", `最初の音量: ${await volume.inputValue()}`);
  await volume.focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowLeft");
  expect((await volume.inputValue()) === "60", await volume.inputValue());
  const v = await page.evaluate(() => document.querySelector("audio").volume);
  expect(Math.abs(v - 0.6) < 0.001, `音が小さくならない: ${v}`);
  await ui.reload();
  expect((await page.getByLabel("音量").inputValue()) === "60", "再読み込みで戻った");
  await row("chime.wav").getByRole("button", { name: "再生", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("audio").paused, null, { timeout: 3000 });
  const pv = await page.evaluate(() => document.querySelector("audio").volume);
  expect(Math.abs(pv - 0.6) < 0.001, `試聴の音量: ${pv}`);
  await row("chime.wav").getByRole("button", { name: "停止", exact: true }).click();
});

await step("P29", "「その他」の「直近で再生したもの」：試聴とプレイリストの再生を数え、新しく再生した順に並ぶ", async () => {
  await back();
  for (const rel of ["chime.ogg", "chime.flac"]) {
    await row(rel).getByRole("button", { name: "再生", exact: true }).click();
    await row(rel).getByRole("button", { name: "停止", exact: true }).click();
  }
  await waitIdle();
  const item = ui.otherItem("recentOnly");
  await ui.filtered(() => item.click());
  const rels = await page.getByTestId("file-row").evaluateAll((rows) => rows.map((r) => r.dataset.relPath));
  expect(rels[0] === "chime.flac" && rels[1] === "chime.ogg", rels.join(","));
  // それまでに試聴・プレイリストで再生した chime.wav・chime.mp3 も入る
  expect(rels.includes("chime.wav") && rels.includes("chime.mp3"), rels.join(","));
  expect((await item.locator(".sub").innerText()) === String(rels.length), "件数が一覧と合わない");
  expect((await page.getByTestId("filter-chips").innerText()).includes("直近で再生"), "チップが出ない");
  await shot("P29_直近で再生したもの");
  await ui.filtered(() => item.click());
});

await step("P30", "一覧の再生：行の「▶」でその行から表示中の一覧を順に再生し、「⏭」で次の行へ。プレイリストを開いていなければ再生の欄の「▶」も一覧を再生する", async () => {
  await back();
  await ui.clearFilter();
  const rels = await page.getByTestId("file-row").evaluateAll((rows) => rows.map((r) => r.dataset.relPath));
  await row(rels[1]).getByRole("button", { name: "再生", exact: true }).click();
  await ui.waitPlaying();
  const position = () => page.getByTestId("player-position").innerText();
  expect((await position()) === `2/${rels.length}`, await position());
  await page.getByRole("button", { name: "次へ" }).click();
  await page
    .waitForFunction((t) => document.querySelector("[data-testid=player-position]")?.textContent === t, `3/${rels.length}`, {
      timeout: 3000,
    })
    .catch(() => {});
  expect((await position()) === `3/${rels.length}`, await position());
  // 鳴らしている行が移る
  expect((await row(rels[2]).getByRole("button", { name: "停止", exact: true }).count()) === 1, "鳴らしている行が移らない");
  await page.getByRole("button", { name: "停止", exact: true }).first().click();
  await ui.waitStopped();
  // プレイリストを開いていないとき、再生の欄の「▶」は表示中の一覧を最初から再生する
  await page.getByRole("button", { name: "順に再生" }).click();
  await ui.waitPlaying();
  expect((await position()) === `1/${rels.length}`, await position());
  expect((await page.locator(".player-name").innerText()) === "ファイルの一覧", "一覧の再生でない");
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
  await ui.waitStopped();
});

await step("P31", "プレイリストの再生中は、再生中の曲を出している項目の行がハイライトされる", async () => {
  await open("ドラッグ");
  await page.getByRole("button", { name: "順に再生" }).click();
  await ui.waitPlaying();
  const playing = () =>
    page.getByTestId("playlist-item").evaluateAll((rows) => rows.findIndex((r) => r.classList.contains("playing")));
  expect((await playing()) === 0, `1曲目: ${await playing()}`);
  await page.getByRole("button", { name: "次へ" }).click();
  await page
    .waitForFunction(() => document.querySelectorAll("[data-testid=playlist-item]")[1]?.classList.contains("playing"), null, {
      timeout: 3000,
    })
    .catch(() => {});
  expect((await playing()) === 1, `2曲目: ${await playing()}`);
  await shot("P31_再生中の項目");
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
  await ui.waitStopped();
  expect((await playing()) === -1, "止めてもハイライトが残る");
  await back();
});

await step("P32", "詳細画面の項目のチェック：チェックした行をタグにドラッグすると中の曲すべてに付く（タグの組み合わせの行は中の曲すべて）。まとめて外せる", async () => {
  await open("ドラッグ");
  const check = (content) => itemRow(content).getByTestId("item-check");
  await check("chime.ogg").check();
  await check("chime.flac").check();
  expect((await page.getByTestId("item-checks").innerText()).includes("チェック 2件"), await page.getByTestId("item-checks").innerText());
  await ui.createTags(["項目から"]);
  await ui.dragTo(itemRow("chime.ogg").locator(".item-content"), tagItem("項目から"), 0.5);
  expect((await status()).includes("2件にタグ「項目から」を付けました"), await status());
  // タグの組み合わせの行：中の曲すべて（雨は2件）
  await ui.filtered(() => tagItem("雨").locator(".tag-name").click());
  await page.getByRole("button", { name: "選択タグをリストに追加" }).click();
  await waitIdle();
  await ui.filtered(() => tagItem("雨").locator(".tag-name").click());
  await page.getByRole("button", { name: "チェックをすべて外す" }).click();
  await ui.createTags(["組み合わせから"]);
  await ui.dragTo(itemRow("雨").locator(".item-content"), tagItem("組み合わせから"), 0.5);
  expect((await status()).includes("2件にタグ「組み合わせから」を付けました"), await status());
  await shot("P32_項目のチェック");
  // まとめて外す（確認する）
  await check("chime.ogg").check();
  await check("雨").check();
  const before = (await items()).length;
  await page.getByRole("button", { name: "まとめて外す" }).click();
  await waitIdle();
  expect((await ui.lastConfirm()).includes("チェックした2件の項目"), await ui.lastConfirm());
  expect((await items()).length === before - 2, (await items()).join(" / "));
  expect((await page.getByTestId("item-checks").count()) === 0, "チェックの操作の行が残る");
  await back();
});

await ui.finish();
