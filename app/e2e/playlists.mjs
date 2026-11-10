// 「プレイリスト」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/playlists.mjs <テストデータ> <スクリーンショットの保存先>
// 左の欄のプレイリストの行を押すと選んで（抽選して）中央の一覧がその並びになり、ダブルクリック・「✎」で編集画面（重ねて出す）を開く。
// 抽選の乱数の種は run.sh が CYANOMELODY_DRAW_SEED で決める
import fs from "node:fs";
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("playlists.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, status, row, tagItem, waitIdle, addFolder, addTag } = ui;

/** 左の欄のプレイリストを「名前:深さ」で表示順に */
const tree = () =>
  page
    .getByTestId("playlist")
    .evaluateAll((rows) => rows.map((r) => `${r.dataset.playlistName}:${r.dataset.depth}`).join(" "));
/** 編集画面の項目を「種類:内容」で */
const items = () =>
  page.getByTestId("playlist-item").evaluateAll((rows) =>
    rows.map((r) => `${r.querySelector(".item-kind").title}:${r.querySelector(".item-content")?.textContent ?? ""}`),
  );
const itemRow = (content) => page.getByTestId("playlist-item").filter({ hasText: content });
/** 中央の一覧の行（相対パス、表示順） */
const rels = () => page.getByTestId("file-row").evaluateAll((rows) => rows.map((r) => r.dataset.relPath));
/** 中央の一覧の行の名前（別名があれば別名）と来た項目のアイコン */
const rowNames = () =>
  page.getByTestId("file-row").evaluateAll((rows) =>
    rows.map((r) => (r.querySelector("[data-testid=row-origin]")?.textContent ?? "") + r.querySelector("[data-testid=file-name]").textContent),
  );
const listTitle = () => page.getByTestId("list-title").innerText();

const { playlistItem, editor, closeEditor, createPlaylist, addCombo } = ui;
const select = ui.selectPlaylist;
const open = ui.openEditor;
/** 編集画面を閉じ、プレイリストの選択も外して、ライブラリの一覧に戻る */
async function back() {
  await ui.leavePlaylist();
  await page.getByTestId("list-title").filter({ hasText: "ライブラリ" }).waitFor({ timeout: 3000 });
}
const position = () => page.getByTestId("player-position").innerText();
const startPlay = async () => {
  await page.getByRole("button", { name: "再生を始める" }).click();
  await ui.waitPlaying();
};
const stopPlay = async () => {
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
  await ui.waitStopped();
};

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
  await ui.check("chime.wav");
  await ui.check("chime.ogg");
  await ui.dragChecked(playlistItem("戦闘"));
  expect((await status()).includes("2件をプレイリスト「戦闘」に追加しました"), await status());
  await ui.clearChecks();
});

await step("P03", "右の欄から、1件のファイルをプレイリストに追加できる。行のダブルクリックで編集画面が開く（2回目の押しで選択は外れない）", async () => {
  await row("chime.flac").click();
  await ui.addToPlaylistHere("戦闘");
  await open("戦闘");
  const list = (await items()).join(" / ");
  expect(list === "ファイル:chime.ogg / ファイル:chime.wav / ファイル:chime.flac", list);
  // ダブルクリックの1回目で選んだまま
  expect((await page.getByTestId("playlist-filter").innerText()).includes("戦闘"), "選ばれていない");
});

await step("P04", "編集画面のタグの入力欄でタグを並べ、「タグの組み合わせを追加」で加えられる（並べていないときは押せない。ないタグは並べられない）。ファイル数が出る", async () => {
  const add = page.getByRole("button", { name: "タグの組み合わせを追加" });
  expect(await add.isDisabled(), "タグを並べていないのに押せる");
  expect((await page.getByRole("button", { name: "選択タグをリストに追加" }).count()) === 0, "選択タグをリストに追加が残っている");
  const input = page.getByLabel("組み合わせに加えるタグ");
  await input.fill("ないタグ");
  await input.press("Enter");
  expect((await status()).includes("タグ「ないタグ」はありません"), await status());
  for (const [tag, count] of [["雨", "2件"], ["風", "1件"]]) {
    await addCombo([tag]);
    expect((await itemRow(tag).locator(".item-count").innerText()) === count, `${tag}の件数`);
  }
  expect((await page.getByTestId("combo-tags").locator(".chip").count()) === 0, "加えた後も並べたタグが残る");
  await shot("P04_タグの組み合わせ");
});

await step("P05", "抽象的な項目の再生方法を変えられる（ランダムセレクトは1件）", async () => {
  await page.getByLabel("雨の再生方法").selectOption("random");
  await waitIdle();
  expect((await itemRow("雨").locator(".item-count").innerText()) === "1件", "ランダムセレクトの件数");
  expect((await page.getByLabel("雨の再生方法").inputValue()) === "random", "再生方法が残らない");
});

await step("P06", "別の階層のプレイリストを参照として加えられる。ループになるプレイリストは選べない", async () => {
  const select = page.getByLabel("加えるプレイリスト", { exact: true });
  expect((await select.locator("option").first().innerText()) === "プレイリストを追加", await select.locator("option").first().innerText());
  await select.selectOption({ label: "環境" });
  await waitIdle();
  expect((await select.inputValue()) === "", "プルダウンが戻らない");
  expect((await items()).includes("プレイリスト:環境"), (await items()).join(" / "));
  expect(await page.locator("select[aria-label=加えるプレイリスト] option", { hasText: "戦闘" }).isDisabled(), "自分自身");
  await open("環境");
  const opt = page.locator("select[aria-label=加えるプレイリスト] option", { hasText: "戦闘" });
  expect(await opt.isDisabled(), "ループになるのに選べる");
  expect((await opt.innerText()).includes("ループになるため選べません"), await opt.innerText());
  await shot("P06_ループの候補");
  await closeEditor();
});

await step("P07", "左の欄で作ったプレイリストを、行のドラッグで別のプレイリストの中に落とすと子になり、親の項目にも入る", async () => {
  await createPlaylist("剣");
  await ui.dragTo(playlistItem("剣").locator(".tag-name").first(), playlistItem("戦闘"), 0.5);
  expect((await tree()) === "戦闘:0 剣:1 環境:0 足音:0", await tree());
  await open("戦闘");
  expect((await items()).at(-1) === "子のプレイリスト:剣", (await items()).join(" / "));
});

await step("P08", "項目を行のドラッグで並べ替えられる。左の欄の行のドラッグで別のプレイリストの子にでき、ループになる位置には落とせない", async () => {
  await ui.dragTo(page.getByTestId("item-content").last(), page.getByTestId("playlist-item").first(), 0.2);
  expect((await items())[0] === "子のプレイリスト:剣", (await items()).join(" / "));
  expect((await tree()) === "戦闘:0 剣:1 環境:0 足音:0", await tree());
  await closeEditor();
  await ui.dragTo(playlistItem("足音").locator(".tag-name").first(), playlistItem("環境"), 0.5);
  expect((await tree()) === "戦闘:0 剣:1 環境:0 足音:1", await tree());
  // 戦闘は環境を参照しているので、戦闘を環境の子にするとループになる
  await ui.dragTo(playlistItem("戦闘").locator(".tag-name").first(), playlistItem("環境"), 0.5, false);
  const cls = await playlistItem("環境").getAttribute("class");
  expect(!/drop-/.test(cls), `ループになる位置に表示が出た: ${cls}`);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect((await tree()) === "戦闘:0 剣:1 環境:0 足音:1", await tree());
  await shot("P09_階層");
  // 子の項目を外すと、その子は最上位に移る
  await open("環境");
  await itemRow("足音").getByRole("button", { name: "足音を外す" }).click();
  await waitIdle();
  expect((await tree()) === "戦闘:0 剣:1 環境:0 足音:0", await tree());
  await closeEditor();
});

await step("P11", "選んだプレイリストの再生：再生の欄に名前・何曲目か・ファイル名が出て、次へ・前へ・一時停止・停止ができる", async () => {
  await select("戦闘");
  // 剣（空）、ogg・wav・flac、雨から1つ（🎲）、風の1つ（flac）、環境（空）
  expect((await rels()).length === 5, (await rels()).join(","));
  await startPlay();
  expect((await position()) === "1/5", await position());
  expect((await page.locator(".player-name").innerText()) === "戦闘", await page.locator(".player-name").innerText());
  expect((await page.getByTestId("player-file").innerText()) === "チャイム", await page.getByTestId("player-file").innerText());
  expect((await page.getByTestId("player-file-name").innerText()) === "chime.ogg", await page.getByTestId("player-file-name").innerText());
  await page.getByRole("button", { name: "次へ" }).click();
  expect((await position()) === "2/5", await position());
  await page.getByRole("button", { name: "前へ" }).click();
  expect((await position()) === "1/5", await position());
  // 鳴り始めてから一時停止する
  await page.waitForFunction(() => document.querySelector("audio").currentTime > 0, null, { timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: "一時停止" }).click();
  expect(await page.evaluate(() => document.querySelector("audio").paused), "止まっていない");
  await page.getByRole("button", { name: "再開" }).click();
  await page.waitForFunction(() => !document.querySelector("audio").paused, null, { timeout: 3000 }).catch(() => {});
  expect(!(await page.evaluate(() => document.querySelector("audio").paused)), "再開しない");
  await shot("P11_再生中");
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
  expect(!(await ui.isPlaying()), "再生中のまま");
  expect((await page.getByTestId("player-file").innerText()) === "", "曲の名前が残っている");
  expect(await page.getByRole("button", { name: "次へ" }).isDisabled(), "次へが押せる");
  expect(!(await page.getByRole("button", { name: "再生を始める" }).isDisabled()), "一覧があるのに再生が押せない");
});

await step("P12", "1曲終わると次を再生し、最後まで再生したら止まる", async () => {
  await back();
  await row("chime.mp3").click();
  await ui.addToPlaylistHere("足音");
  await select("足音");
  await startPlay();
  await ui.waitStopped(20000);
  expect((await status()).includes("「足音」の再生が終わりました"), await status());
});

await step("P13", "再生できないファイルは飛ばして、そのことを表示する", async () => {
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
    await select("壊れ");
    await page.getByRole("button", { name: "再生を始める" }).click();
    await page.waitForFunction(() => document.querySelector("[data-testid=status]")?.textContent?.includes("飛ばしました"), null, {
      timeout: 5000,
    });
    expect((await status()).includes("サブフォルダ/チャイム.m4a"), await status());
    expect((await position()) === "2/2", await position());
    await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
  } finally {
    fs.renameSync(path.join(dataDir, "chime.m4a.moved"), m4a);
  }
});

await step("P14", "プレイリストの選択を外して一覧の行の「▶」を押すと、プレイリストの再生をやめて、ライブラリの一覧の再生になる", async () => {
  await select("足音");
  await startPlay();
  await back();
  await row("chime.wav").getByRole("button", { name: "再生", exact: true }).click();
  await ui.waitPlaying();
  expect((await page.locator(".player-name").innerText()) === "ファイルの一覧", await page.locator(".player-name").innerText());
  await row("chime.wav").getByRole("button", { name: "停止", exact: true }).click();
  await ui.waitStopped();
});

await step("P15", "編集画面の「✎」で名前を変えられる（同じ名前はエラー。Escでやめ、編集画面は閉じない）。左の欄の「✎」は編集画面を開く", async () => {
  await ui.rowAction(playlistItem("足音"), "足音の編集");
  await editor().waitFor({ timeout: 3000 });
  const input = page.getByLabel("プレイリストの新しい名前", { exact: true });
  expect((await input.count()) === 0, "最初から入力欄になっている");
  await page.getByRole("button", { name: "プレイリストの名前を変える" }).click();
  await input.fill("やめる");
  await input.press("Escape");
  expect((await input.count()) === 0, "Escで入力をやめない");
  expect((await editor().count()) === 1, "Escで編集画面まで閉じた");
  await page.getByRole("button", { name: "プレイリストの名前を変える" }).click();
  await input.fill("環境");
  await input.press("Enter");
  await waitIdle();
  expect((await status()).includes("同じ名前のプレイリストがあります"), await status());
  await input.fill("足音（短い）");
  await input.press("Enter");
  await waitIdle();
  expect((await tree()).includes("足音（短い）:0"), await tree());
  expect((await page.getByTestId("playlist-title").innerText()) === "足音（短い）", "編集画面の見出しが変わらない");
  // Escで編集画面を閉じる
  await page.keyboard.press("Escape");
  await editor().waitFor({ state: "detached", timeout: 3000 });
});

await step("P16", "左の欄の行の「🗑」で削除すると、子は繰り上がり、参照していたプレイリストから外れる（確認に書いてある）。選んでいたら選択が外れる", async () => {
  await ui.dragTo(playlistItem("足音（短い）").locator(".tag-name").first(), playlistItem("環境"), 0.5);
  await select("環境");
  await ui.rowAction(playlistItem("環境"), "環境を削除");
  await waitIdle();
  const message = await ui.lastConfirm();
  expect(message.includes("子のプレイリスト1件は") && message.includes("入れているプレイリスト1件から外れます"), message);
  expect((await tree()) === "戦闘:0 剣:1 足音（短い）:0 壊れ:0", await tree());
  expect((await listTitle()) === "ライブラリ", `選択が外れない: ${await listTitle()}`);
  await open("戦闘");
  expect(!(await items()).includes("プレイリスト:環境"), (await items()).join(" / "));
  await back();
});

await step("P19", "項目の行の「✎」でプレイリスト上での名前を付けられる。中央の一覧と再生の欄はその名前で出る。Escでやめ、空にすると外れる", async () => {
  await createPlaylist("別名");
  await row("chime.wav").click();
  await ui.addToPlaylistHere("別名");
  await open("別名");
  const alias = page.getByLabel("chime.wavのプレイリスト上での名前", { exact: true });
  const edit = page.getByRole("button", { name: "chime.wavのプレイリスト上での名前を付ける" });
  expect((await alias.count()) === 0, "押す前から出ている");
  await edit.click();
  await alias.fill("途中でやめる");
  await alias.press("Escape");
  expect((await alias.count()) === 0, "Escでやめない");
  expect((await items())[0] === "ファイル:chime.wav", (await items())[0]);
  await edit.click();
  await alias.fill(" 激しめの雨 ");
  await alias.press("Enter");
  await waitIdle();
  // 項目の一覧はプレイリスト上での名前だけを出し、元の名前はマウスを乗せたときに出す
  expect((await items())[0] === "ファイル:激しめの雨", (await items())[0]);
  expect((await itemRow("激しめの雨").locator(".item-content").getAttribute("title")) === "chime.wav", "元の名前が出ない");
  await shot("P19_プレイリスト上での名前");
  await closeEditor();
  // 中央の一覧も別名で出る（マウスを乗せると相対パス）
  expect((await rowNames()).join(",") === "激しめの雨", (await rowNames()).join(","));
  await startPlay();
  expect((await page.getByTestId("player-file").innerText()) === "激しめの雨", await page.getByTestId("player-file").innerText());
  expect((await page.getByTestId("player-file-name").innerText()) === "chime.wav", "ファイル名が出ない");
  await stopPlay();
  await open("別名");
  await edit.click();
  await alias.fill("");
  await alias.press("Enter");
  await waitIdle();
  expect((await items())[0] === "ファイル:chime.wav", (await items())[0]);
  await back();
});

await step("P20", "ファイルの行を左の欄のプレイリストへドラッグすると加わる（チェックした行をつかむとチェックしたファイルすべて）", async () => {
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

await step("P21", "再生方法のボタン：押すたびに 一曲だけ→順に連続→ランダム→ランダムセレクト と変わり（再読み込み後も残る）、「▶」と行の「▶」はそれに従う。再生中に変えると今の曲の後に効く。シークバーは押す・ドラッグで位置が変わる", async () => {
  const modeButton = () => page.getByTestId("play-mode");
  const mode = () => modeButton().getAttribute("data-mode");
  const setMode = async (m) => {
    for (let i = 0; i < 4 && (await mode()) !== m; i++) await modeButton().click();
    expect((await mode()) === m, `再生方法 ${await mode()}`);
  };
  await select("ドラッグ");
  const first = (await rels())[0];
  expect((await mode()) === "order", `最初 ${await mode()}`);
  expect((await modeButton().getAttribute("title")) === "再生方法：順に連続再生", await modeButton().getAttribute("title"));
  const icons = [];
  for (let i = 0; i < 4; i++) {
    icons.push(`${await mode()}:${await modeButton().innerText()}`);
    await modeButton().click();
  }
  expect(icons.join(",") === "order:⇒,shuffle:🔀,random:🎲,one:①", icons.join(","));
  await setMode("one");
  await startPlay();
  expect((await position()) === "1/1", `一曲だけ ${await position()}`);
  expect((await page.getByTestId("player-file-name").innerText()) === first, await page.getByTestId("player-file-name").innerText());
  await stopPlay();
  await setMode("shuffle");
  await startPlay();
  expect((await position()).endsWith("/3"), `ランダム ${await position()}`);
  await page.waitForFunction(() => document.querySelector("audio").duration > 0, null, { timeout: 5000 });
  const bar = page.getByTestId("player-progress");
  const box = await bar.boundingBox();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  const ratio = await page.evaluate(() => {
    const a = document.querySelector("audio");
    return a.currentTime / a.duration;
  });
  expect(ratio > 0.4, `移っていない: ${ratio}`);
  await stopPlay();
  await setMode("random");
  await startPlay();
  expect((await position()) === "1/1", `ランダムセレクト ${await position()}`);
  await stopPlay();
  await setMode("order");
  await startPlay();
  const changes = [];
  for (let i = 0; i < 4; i++) {
    await modeButton().click();
    changes.push(`${await mode()}:${await position()}:${await page.getByTestId("player-file-name").innerText()}`);
  }
  expect(changes.join(",") === ["shuffle:1/3", "random:1/1", "one:1/1", "order:1/3"].map((m) => `${m}:${first}`).join(","), changes.join(","));
  await shot("P21_再生方法のボタン");
  await setMode("one");
  await ui.waitStopped(10000);
  await back();
  await ui.clearFilter();
  const all = await rels();
  await setMode("order");
  await row(all[1]).getByRole("button", { name: "再生", exact: true }).click();
  await ui.waitPlaying();
  expect((await position()) === `2/${all.length}`, await position());
  await modeButton().click();
  expect((await position()) === `1/${all.length}`, `ランダムにした後 ${await position()}`);
  await stopPlay();
  await setMode("shuffle");
  await row(all[2]).getByRole("button", { name: "再生", exact: true }).click();
  await ui.waitPlaying();
  expect((await position()) === `1/${all.length}`, await position());
  expect((await page.getByTestId("player-file-name").innerText()) === all[2], await page.getByTestId("player-file-name").innerText());
  await stopPlay();
  await setMode("one");
  await row(all[2]).getByRole("button", { name: "再生", exact: true }).click();
  await ui.waitPlaying();
  expect((await position()) === "1/1", await position());
  await stopPlay();
  await ui.reload();
  expect((await mode()) === "one", `再読み込み後 ${await mode()}`);
  await setMode("order");
  for (const name of ["前へ", "次へ", "停止"]) {
    expect(await page.getByRole("button", { name, exact: true }).isDisabled(), `${name}が押せる`);
  }
  const order = await page.locator(".play-buttons button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")).join(","));
  expect(order === "前へ,再生を始める,次へ,再生方法,停止", order);
  await select("ドラッグ");
  await startPlay();
  await page.waitForFunction(() => document.querySelector("audio").duration > 0, null, { timeout: 5000 });
  await page.getByRole("button", { name: "一時停止" }).click();
  const box2 = await page.getByTestId("player-progress").boundingBox();
  await page.mouse.move(box2.x + 4, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width * 0.5, box2.y + box2.height / 2, { steps: 5 });
  await page.mouse.move(box2.x + box2.width * 0.8, box2.y + box2.height / 2, { steps: 5 });
  await page.mouse.up();
  const ratio2 = await page.evaluate(() => {
    const a = document.querySelector("audio");
    return a.currentTime / a.duration;
  });
  expect(ratio2 > 0.6, `移っていない: ${ratio2}`);
  await shot("P26_再生の欄");
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
});

await step("P22", "編集画面で項目の種類の記号を押すと、その項目だけ再生する", async () => {
  await open("ドラッグ");
  await page.getByRole("button", { name: "chime.mp3を再生" }).click();
  await ui.waitPlaying();
  expect((await position()) === "1/1", await position());
  expect((await page.getByTestId("player-file-name").innerText()) === "chime.mp3", await page.getByTestId("player-file-name").innerText());
  await page.locator(".play-buttons").getByRole("button", { name: "停止", exact: true }).click();
  await closeEditor();
});

await step("P23", "右の欄に、そのファイルを入れているプレイリストが条件のチップと同じ形で出る。名前を押すと編集画面がその項目を選んで開き、「✕」でそのプレイリストから外れる", async () => {
  await back();
  await row("chime.flac").click();
  await page.getByTestId("used-in").waitFor({ timeout: 3000 });
  const usedIn = page.getByTestId("used-in");
  const names = await usedIn.locator("[data-playlist-name]").evaluateAll((els) => els.map((e) => e.dataset.playlistName));
  expect(names.includes("ドラッグ"), names.join(","));
  await shot("P23_入っているプレイリスト");
  await usedIn.getByRole("button", { name: "ドラッグを開く" }).click();
  await editor().waitFor({ timeout: 3000 });
  expect((await page.getByTestId("playlist-title").innerText()) === "ドラッグ", await page.getByTestId("playlist-title").innerText());
  const selected = await page.locator(".playlist-item.selected [data-testid=item-content]").allInnerTexts();
  expect(selected.join(",") === "chime.flac", `選ばれた項目: ${selected.join(",")}`);
  const before = (await items()).length;
  await closeEditor();
  await usedIn.getByRole("button", { name: "ドラッグから外す" }).click();
  await waitIdle();
  expect((await status()).includes("プレイリスト「ドラッグ」から外しました"), await status());
  expect((await page.locator("[data-testid=used-in] [data-playlist-name=ドラッグ]").count()) === 0, "チップが残っている");
  await open("ドラッグ");
  expect((await items()).length === before - 1, (await items()).join(" / "));
  await back();
  await row("chime.flac").click();
  await ui.addToPlaylistHere("ドラッグ");
});

await step("P25", "左の欄の行は開閉の印・名前・✎・🗑・数の順。編集画面：「書出」は一番下の行。項目の行を押すと選んだ色になる", async () => {
  const item = playlistItem("ドラッグ");
  await item.hover();
  const order = await item.evaluate((li) =>
    [...li.children].map((c) => c.dataset.testid ?? (c.classList.contains("sub") ? "count" : c.className)).join(","),
  );
  expect(order === "tag-twisty,tag-name,row-actions,count", order);
  await createPlaylist("消す用");
  await open("消す用");
  await addCombo(["雨"]);
  const foot = page.locator(".editor-foot");
  expect((await foot.getByRole("button", { name: "書出" }).count()) === 1, "書出が下の行にない");
  await itemRow("雨").locator(".item-content").click();
  expect((await itemRow("雨").getAttribute("class")).includes("selected"), "押した行に色が付かない");
  await page.getByRole("button", { name: "雨のプレイリスト上での名前を付ける" }).click();
  await page.getByLabel("雨のプレイリスト上での名前", { exact: true }).fill("雨の組");
  await page.getByLabel("雨のプレイリスト上での名前", { exact: true }).press("Enter");
  await waitIdle();
  expect((await items())[0] === "タグ:雨の組", (await items())[0]);
  await shot("P25_編集画面");
  await closeEditor();
  await ui.rowAction(playlistItem("消す用"), "消す用を削除");
  await waitIdle();
  expect((await ui.lastConfirm()).includes("プレイリスト「消す用」を削除しますか"), await ui.lastConfirm());
  expect(!(await tree()).includes("消す用"), await tree());
  await back();
});

await step("P27", "再生の欄：一覧の再生でも曲名を出し、2行目にファイル名と「ファイルの一覧」・何曲目", async () => {
  await back();
  await row("chime.mp3").getByRole("button", { name: "再生", exact: true }).click();
  await ui.waitPlaying();
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
  const list = await rels();
  expect(list[0] === "chime.flac" && list[1] === "chime.ogg", list.join(","));
  expect(list.includes("chime.wav") && list.includes("chime.mp3"), list.join(","));
  expect((await item.locator(".sub").innerText()) === String(list.length), "件数が一覧と合わない");
  expect((await page.getByTestId("filter-chips").innerText()).includes("直近で再生"), "チップが出ない");
  await shot("P29_直近で再生したもの");
  await ui.filtered(() => item.click());
});

await step("P30", "一覧の再生：行の「▶」でその行から表示中の一覧を順に再生し、「⏭」で次の行へ。再生の欄の「▶」も表示中の一覧を再生する", async () => {
  await back();
  await ui.clearFilter();
  const all = await rels();
  await row(all[1]).getByRole("button", { name: "再生", exact: true }).click();
  await ui.waitPlaying();
  expect((await position()) === `2/${all.length}`, await position());
  await page.getByRole("button", { name: "次へ" }).click();
  await page
    .waitForFunction((t) => document.querySelector("[data-testid=player-position]")?.textContent === t, `3/${all.length}`, {
      timeout: 3000,
    })
    .catch(() => {});
  expect((await position()) === `3/${all.length}`, await position());
  expect((await row(all[2]).getByRole("button", { name: "停止", exact: true }).count()) === 1, "鳴らしている行が移らない");
  await page.getByRole("button", { name: "停止", exact: true }).first().click();
  await ui.waitStopped();
  await startPlay();
  expect((await position()) === `1/${all.length}`, await position());
  expect((await page.locator(".player-name").innerText()) === "ファイルの一覧", "一覧の再生でない");
  await stopPlay();
});

await step("P31", "編集画面の「▶ 再生」：プレイリストを選んで一覧を頭から再生し、再生中の曲を出している項目の行がハイライトされる", async () => {
  await back();
  await ui.rowAction(playlistItem("ドラッグ"), "ドラッグの編集");
  await editor().waitFor({ timeout: 3000 });
  await editor().getByRole("button", { name: "プレイリストを再生" }).click();
  await ui.waitPlaying();
  expect((await page.getByTestId("playlist-filter").innerText()).includes("ドラッグ"), "選ばれていない");
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
  await stopPlay();
  expect((await playing()) === -1, "止めてもハイライトが残る");
  await closeEditor();
});

await step("P32", "編集画面の項目のチェック：まとめて外せる。チェックした項目の再生方法を変えると、チェックした項目すべて", async () => {
  await createPlaylist("チェック");
  await open("チェック");
  await addCombo(["雨"]);
  await addCombo(["風"]);
  await page.getByLabel("加えるプレイリスト", { exact: true }).selectOption({ label: "ドラッグ" });
  await waitIdle();
  const check = (content) => itemRow(content).getByTestId("item-check");
  await check("雨").check();
  await check("風").check();
  expect((await page.getByTestId("item-checks").innerText()).includes("チェック 2件"), await page.getByTestId("item-checks").innerText());
  await page.getByLabel("雨の再生方法").selectOption("shuffle");
  await waitIdle();
  expect((await page.getByLabel("風の再生方法").inputValue()) === "shuffle", "チェックした項目すべてに効かない");
  expect((await page.getByLabel("ドラッグの再生方法").inputValue()) === "order", "チェックしていない項目まで変わった");
  await shot("P32_項目のチェック");
  await page.getByRole("button", { name: "まとめて外す" }).click();
  await waitIdle();
  expect((await ui.lastConfirm()).includes("チェックした2件の項目"), await ui.lastConfirm());
  expect((await items()).join(" / ") === "プレイリスト:ドラッグ", (await items()).join(" / "));
  expect((await page.getByTestId("item-checks").count()) === 0, "チェックの操作の行が残る");
  await closeEditor();
});

await step("P33", "再生の欄の曲名を押すと、鳴らしている曲へ飛ぶ：選んでいるプレイリストの曲なら一覧のその行、選んでいないプレイリストの曲なら編集画面のその項目、一覧の再生ならその行。絞り込みで一覧にないときは知らせる", async () => {
  const jump = () => page.getByTestId("player-file").click();
  await select("ドラッグ");
  await startPlay();
  await page.getByRole("button", { name: "次へ" }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=player-position]")?.textContent?.startsWith("2/"), null, { timeout: 3000 });
  const second = (await rels())[1];
  await jump();
  expect((await row(second).getAttribute("class")).includes("selected"), "選んでいる一覧のその行が選ばれない");
  await stopPlay();
  // 選んでいないプレイリストの項目を再生して曲名を押すと、編集画面のその項目
  await back();
  await open("戦闘");
  await page.getByRole("button", { name: "chime.oggを再生" }).click();
  await ui.waitPlaying();
  await closeEditor();
  await back();
  await jump();
  await editor().waitFor({ timeout: 3000 });
  const selected = await page.locator(".playlist-item.selected [data-testid=item-content]").allInnerTexts();
  expect(selected.join(",") === "chime.ogg", `選ばれた項目: ${selected.join(",")}`);
  await shot("P33_プレイリストの項目へ飛ぶ");
  await stopPlay();
  await closeEditor();
  // 一覧の再生：ライブラリのその行へ。絞り込みで一覧に出ていないときは、そのことを出す（絞り込みは変えない）
  await ui.clearFilter();
  const all = await rels();
  await row(all[3]).getByRole("button", { name: "再生", exact: true }).click();
  await ui.waitPlaying();
  await jump();
  expect((await row(all[3]).getAttribute("class")).includes("selected"), "その行が選ばれない");
  await ui.filtered(() => tagItem("風").locator(".tag-name").click());
  await jump();
  expect((await status()).includes("今の絞り込みでは一覧に出ていません"), await status());
  expect((await ui.fileCount()) === 1, `絞り込みが変わった ${await ui.fileCount()}`);
  await ui.clearFilter();
  await stopPlay();
  expect((await page.getByTestId("player-file").getAttribute("role")) === null, "鳴らしていないのに押せる");
  await ui.filtered(() => ui.otherItem("recentOnly").click());
  expect(await page.getByTestId("file-sort").isDisabled(), "直近で再生したものなのに並び順を選べる");
  await ui.filtered(() => ui.otherItem("recentOnly").click());
  expect(!(await page.getByTestId("file-sort").isDisabled()), "並び順を選べない");
});

await step("P40", "プレイリストを選ぶと：見出しがその名前・条件のチップ「📃 名前」・件数の単位は曲とファイル・同じ曲は2行・チェックはファイルごと。もう一度押すと外れる", async () => {
  await back();
  await createPlaylist("重なり");
  // 同じファイルを2回入れる
  for (let i = 0; i < 2; i++) {
    await row("chime.ogg").click();
    await ui.addToPlaylistHere("重なり");
  }
  await row("chime.mp3").click();
  await ui.addToPlaylistHere("重なり");
  await select("重なり");
  expect((await listTitle()) === "重なり", await listTitle());
  expect((await rels()).join(",") === "chime.ogg,chime.ogg,chime.mp3", (await rels()).join(","));
  expect((await page.getByTestId("file-count").innerText()) === "3曲", await page.getByTestId("file-count").innerText());
  // 左の欄の件数は、通しで流したときの曲数
  expect((await playlistItem("重なり").locator(".sub").innerText()) === "3", await playlistItem("重なり").locator(".sub").innerText());
  // 1行をチェックすると、同じファイルの行もチェックされる。チェックはファイルの数
  await page.getByTestId("file-check").first().click();
  const checkedRows = await page.locator("[data-testid=file-row].checked").count();
  expect(checkedRows === 2, `チェックした行 ${checkedRows}`);
  expect((await page.getByTestId("checked-count").innerText()) === "チェック 1ファイル（表示中 1ファイル）", await page.getByTestId("checked-count").innerText());
  await shot("P40_選んだプレイリスト");
  await ui.clearChecks();
  // もう一度押すと外れる
  await ui.filtered(() => playlistItem("重なり").locator(".tag-name").click());
  expect((await listTitle()) === "ライブラリ", await listTitle());
  expect((await page.getByTestId("file-count").innerText()).endsWith("件"), await page.getByTestId("file-count").innerText());
});

await step("P41", "選んだプレイリストの中を、タグなどで絞り込める（抽選した並びの中だけ。件数・グレーアウトも並びの中で）。0曲のプレイリストはグレーアウト", async () => {
  await select("戦闘");
  const total = (await rels()).length;
  await ui.filtered(() => tagItem("風").locator(".tag-name").click());
  const list = await rels();
  expect(list.length > 0 && list.length < total && list.every((r) => r === "chime.flac"), list.join(","));
  expect((await page.getByTestId("filter-chips").innerText()).includes("戦闘"), "プレイリストのチップが消えた");
  await ui.filtered(() => tagItem("風").locator(".tag-name").click());
  // 剣（空）は0曲でグレーアウト
  expect((await playlistItem("剣").getAttribute("class")).includes("disabled"), "0曲なのにグレーアウトしない");
  // 「すべての条件を外す」ではプレイリストの選択も外れる
  await ui.filtered(() => tagItem("雨").locator(".tag-name").click());
  await ui.filtered(() => page.getByRole("button", { name: "絞り込みの条件をすべて外す" }).click());
  expect((await listTitle()) === "ライブラリ", await listTitle());
});

await step("P42", "タグの組み合わせ・プレイリストの項目から来た行には、その項目のアイコンが出て、マウスを乗せると説明、押すと編集画面のその項目。ファイルの項目の行には出ない", async () => {
  await select("戦闘");
  const names = await rowNames();
  // ogg・wav・flac はファイルの項目、雨（🎲）から1つ、風から1つ
  expect(names.filter((n) => n.startsWith("🏷")).length === 2, names.join(","));
  expect(names.filter((n) => !n.startsWith("🏷") && !n.startsWith("📃")).length === 3, names.join(","));
  const rain = page.locator("[data-testid=row-origin][data-origin-kind=tags]").first();
  const title = await rain.getAttribute("title");
  expect(title === "タグの組み合わせ「雨」（🎲 1曲）から", title);
  await rain.click();
  await editor().waitFor({ timeout: 3000 });
  const selected = await page.locator(".playlist-item.selected [data-testid=item-content]").allInnerTexts();
  expect(selected.join(",") === "雨", `選ばれた項目: ${selected.join(",")}`);
  await shot("P42_来た項目から編集画面");
  await closeEditor();
});

await step("P43", "並び順：プレイリストを選んでいるときは最初「プレイリストの順」。ライブラリとプレイリストで別々に覚える", async () => {
  await select("ドラッグ");
  const sort = page.getByTestId("file-sort");
  expect((await sort.inputValue()) === "playlist", await sort.inputValue());
  await ui.filtered(() => sort.selectOption("name"));
  const byName = await rels();
  expect(byName.join(",") === [...byName].sort().join(","), byName.join(","));
  await back();
  expect((await page.getByTestId("file-sort").inputValue()) === "path", "ライブラリの並び順が変わった");
  await select("ドラッグ");
  expect((await page.getByTestId("file-sort").inputValue()) === "name", "プレイリストの並び順を覚えていない");
  await ui.filtered(() => page.getByTestId("file-sort").selectOption("playlist"));
});

await step("P44", "抽選：🎲の項目は1曲だけ出て、読み直しても変わらない。プレイリストを編集すると抽選し直す（🎲を「順に」にすると全部出る）", async () => {
  await select("戦闘");
  const rainRows = async () => (await rowNames()).filter((n) => n.startsWith("🏷")).length;
  expect((await rainRows()) === 2, `雨1・風1 のはず ${await rainRows()}`);
  // 別の条件を選んで外しても（読み直しても）抽選し直さない
  const before = (await rels()).join(",");
  await ui.filtered(() => tagItem("雨").locator(".tag-name").click());
  await ui.filtered(() => tagItem("雨").locator(".tag-name").click());
  expect((await rels()).join(",") === before, "読み直しで並びが変わった");
  await open("戦闘");
  await page.getByLabel("雨の再生方法").selectOption("order");
  await waitIdle();
  await closeEditor();
  // 雨（wav・mp3）が2曲とも出る
  expect((await rainRows()) === 3, `編集で抽選し直さない ${await rainRows()}`);
});

await step("P45", "書出は編集画面から：中央の一覧に出ている曲（絞り込みと並び順のとおり）を書き出す", async () => {
  const out = path.join(shotDir, "export-out");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  await select("ドラッグ");
  await ui.filtered(() => tagItem("雨").locator(".tag-name").click());
  const shown = await rels();
  await open("ドラッグ");
  await ui.setDialogReply(out);
  await page.locator(".editor-foot").getByRole("button", { name: "ファイル", exact: true }).click();
  await ui.setDialogReply(null);
  await page.getByTestId("export-status").filter({ hasText: "書き出しました" }).waitFor({ timeout: 10000 }).catch(() => {});
  const written = fs.readdirSync(path.join(out, "ドラッグ")).sort();
  expect(written.length === shown.length, `${written.join(",")} / ${shown.join(",")}`);
  await closeEditor();
  await back();
  await ui.clearFilter();
});

/** CSS の色（var(--accent) など）を、計算した rgb にする */
const cssColor = (value) =>
  page.evaluate((v) => {
    const e = document.createElement("span");
    e.style.color = v;
    document.body.appendChild(e);
    const c = getComputedStyle(e).color;
    e.remove();
    return c;
  }, value);

await step("P35", "再生の欄：歯車とスピーカーは絵。スピーカーを押すとミュート（音量0・×のアイコン）、もう一度押すと前の音量に戻る。つまみで0にしても×になり、押すと100%", async () => {
  const volume = page.getByLabel("音量");
  const mute = page.getByTestId("player-mute");
  const icon = () => mute.locator("svg").getAttribute("data-icon");
  expect((await page.getByRole("button", { name: "設定", exact: true }).locator("svg[data-icon=gear]").count()) === 1, "歯車の絵がない");
  const before = await volume.inputValue();
  expect(before !== "0" && (await icon()) === "speaker", `${before} ${await icon()}`);
  await mute.click();
  expect((await volume.inputValue()) === "0" && (await icon()) === "speaker-muted", `${await volume.inputValue()} ${await icon()}`);
  expect((await page.evaluate(() => document.querySelector("audio").volume)) === 0, "音が消えない");
  await shot("P35_ミュート");
  await mute.click();
  expect((await volume.inputValue()) === before && (await icon()) === "speaker", `戻らない ${await volume.inputValue()}`);
  await volume.focus();
  await page.keyboard.press("Home");
  expect((await icon()) === "speaker-muted", await icon());
  await ui.reload();
  await page.getByTestId("player-mute").click();
  expect((await page.getByLabel("音量").inputValue()) === "100", await page.getByLabel("音量").inputValue());
});

await step("P36", "ライブラリの行をダブルクリックすると再生する（鳴らしている行なら止めずに鳴らし直す）。鳴らしている行の停止ボタンは青い", async () => {
  await back();
  await ui.clearFilter();
  await row("chime.wav").locator(".file-name").dblclick();
  await ui.waitPlaying();
  const stop = row("chime.wav").getByRole("button", { name: "停止", exact: true });
  expect((await stop.count()) === 1, "ダブルクリックで再生しない");
  const color = await stop.evaluate((e) => getComputedStyle(e).color);
  expect(color === (await cssColor("var(--accent)")), `停止ボタンの色: ${color}`);
  await shot("P36_鳴らしている行");
  await row("chime.wav").locator(".file-name").dblclick();
  await page.waitForTimeout(500);
  expect((await stop.count()) === 1, "鳴らし直さずに止まった");
  await stop.click();
  await ui.waitStopped();
});

await step("P37", "編集画面の項目：行のダブルクリックで再生する。行をつかんで項目の行の上で離すと並べ替え（チェックしていても、つかんだ項目だけ）", async () => {
  await open("ドラッグ");
  const contents = () => page.getByTestId("item-content").allInnerTexts();
  const before = await contents();
  expect(before.length === 3, before.join(","));
  await itemRow(before[0]).locator(".item-content").dblclick();
  await ui.waitPlaying();
  await stopPlay();
  await itemRow(before[0]).getByTestId("item-check").check();
  await itemRow(before[1]).getByTestId("item-check").check();
  await ui.dragTo(itemRow(before[1]).locator(".item-content"), itemRow(before[0]), 0.2);
  expect((await contents()).slice(0, 2).join(",") === [before[1], before[0]].join(","), (await contents()).join(","));
  await closeEditor();
});

await ui.finish();
