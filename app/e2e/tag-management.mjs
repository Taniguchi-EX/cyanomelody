// 「音声のタグ管理」の画面テスト。
// 起動したアプリのWebView2にリモートデバッグでつなぎ、Playwrightで操作する。
//
// 準備:
//   bash e2e/make-testdata.sh <テストデータ>
//   CYANOMELODY_DATA_DIR=<空のフォルダ> WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npx tauri dev
// 実行:
//   node e2e/tag-management.mjs <テストデータ> <スクリーンショットの保存先>
import fs from "node:fs";
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("tag-management.mjs");
const formats = path.join(dataDir, "formats");
const large = path.join(dataDir, "large");

const ui = await connect(shotDir);
const { page, step, shot, status, fileCount, row, tagItem, waitIdle, addFolder, clearFilter, addTag } = ui;

await step("T01", "フォルダを登録すると、スキャンして5つの形式のファイルが取り込まれ、そのフォルダだけの表示になる", async () => {
  await ui.addFolderOnly(formats);
  const s = await status();
  expect(s.includes("5件"), `status: ${s}`);
  expect((await fileCount()) === 5, `件数 ${await fileCount()}`);
  expect((await row("サブフォルダ/チャイム.m4a").count()) === 1, "サブフォルダのm4aがない");
  const folder = page.getByTestId("folder");
  expect((await folder.getAttribute("class")).includes("active"), "フォルダが選ばれていない");
  expect((await folder.locator(".folder-name").innerText()) === "formats", await folder.innerText());
  expect((await page.getByRole("button", { name: "すべて解除" }).count()) === 1, "すべて解除が出ない");
  await shot("T01_フォルダ登録");
  // もう一度押すと外れる
  await folder.locator(".folder-name").click();
  await page.waitForTimeout(400);
  expect(!(await folder.getAttribute("class")).includes("active"), "外れない");
});

await step("T02", "登録済みのフォルダの中のフォルダは登録できない", async () => {
  await addFolder(path.join(formats, "サブフォルダ"));
  const s = await status();
  expect(s.includes("登録済みのフォルダの中にある"), `status: ${s}`);
  expect((await page.getByTestId("folder").count()) === 1, "フォルダが増えた");
});

await step("T03", "存在しないフォルダは登録できない", async () => {
  await addFolder(path.join(formats, "存在しない"));
  const s = await status();
  expect(s.includes("フォルダが見つかりません"), `status: ${s}`);
});

for (const rel of ["chime.flac", "chime.mp3", "chime.ogg", "chime.wav", "サブフォルダ/チャイム.m4a"]) {
  await step(`T04-${path.extname(rel).slice(1)}`, `試聴できる: ${rel}`, async () => {
    await row(rel).getByRole("button", { name: "再生" }).click();
    await page.waitForFunction(() => {
      const a = document.querySelector("audio");
      return a && a.currentTime > 0.1;
    }, null, { timeout: 5000 });
    const err = await page.evaluate(() => document.querySelector("audio").error?.message ?? null);
    expect(err === null, `audio error: ${err}`);
    // 停止
    await row(rel).getByRole("button", { name: "停止" }).click();
    expect(await page.evaluate(() => document.querySelector("audio").paused), "止まらない");
  });
}

await step("T05", "チェックした複数のファイルに、タグの行へのドラッグでまとめてタグを付けられる", async () => {
  await ui.check("chime.wav");
  await ui.check("chime.mp3");
  await ui.bulkAddTag("チャイム");
  expect((await status()).includes("2件にタグ「チャイム」を付けました"), await status());
  await ui.clearChecks();
  const t = await tagItem("チャイム").innerText();
  expect(t.includes("2"), `タグ一覧: ${t}`);
  expect((await row("chime.wav").locator(".chip").allInnerTexts()).includes("チャイム"), "一覧にタグが出ない");
  await shot("T05_タグを付ける");
});

await step("T06", "右の欄では、大文字・小文字が違うだけのタグ名でも既にあるタグを付ける", async () => {
  await row("chime.wav").click();
  await addTag(" Short ");
  await row("chime.flac").click();
  await addTag("short");
  const items = await page.getByTestId("tag").allInnerTexts();
  expect(items.length === 2, `タグ一覧: ${items.join(",")}`);
  expect((await tagItem("Short").innerText()).includes("2"), "件数が2でない");
});

await step("T07", "複数のタグで絞り込むと、すべてのタグが付いたファイルだけになる（AND）", async () => {
  await tagItem("チャイム").click();
  await page.waitForTimeout(300);
  expect((await fileCount()) === 2, `チャイムのみ: ${await fileCount()}`);
  await tagItem("Short").click();
  await page.waitForTimeout(300);
  expect((await fileCount()) === 1, `AND: ${await fileCount()}`);
  expect((await row("chime.wav").count()) === 1, "chime.wavでない");
  await shot("T07_タグで絞り込む");
  await clearFilter();
});

await step("T08", "タグなしのファイルだけに絞り込める", async () => {
  await page.getByTestId("untagged").click();
  await page.waitForTimeout(300);
  expect((await fileCount()) === 2, `件数 ${await fileCount()}`);
  await clearFilter();
});

await step("T09", "ファイル名の一部で絞り込める（大文字・小文字を区別しない）", async () => {
  await page.getByLabel("検索", { exact: true }).fill("CHIME.");
  await page.waitForTimeout(500);
  expect((await fileCount()) === 4, `CHIME.: ${await fileCount()}`);
  await page.getByLabel("検索", { exact: true }).fill("サブ");
  await page.waitForTimeout(500);
  expect((await fileCount()) === 1, `サブ: ${await fileCount()}`);
  await clearFilter();
});

await step("T10", "右の欄の付いているタグは、条件のチップと同じ形で出て、押すとそのタグを外せる", async () => {
  for (const rel of ["chime.wav", "chime.mp3"]) {
    await row(rel).click();
    const chip = page.locator("[data-testid=selected-tag][data-tag-name=チャイム]");
    expect((await chip.innerText()).replace(/\s+/g, "") === "🏷チャイム✕", await chip.innerText());
    expect((await chip.getAttribute("class")).includes("filter-chip"), "条件のチップと同じ形でない");
    await chip.click();
    await waitIdle();
  }
  expect((await tagItem("チャイム").innerText()).includes("0"), await tagItem("チャイム").innerText());
});

await step("T11", "Shiftを押しながらチェックすると、範囲をまとめてチェックできる", async () => {
  await ui.check("chime.flac");
  await ui.check("chime.wav", { modifiers: ["Shift"] });
  const t = await ui.checkedCount();
  expect(t.includes("チェック 4件"), t);
  await ui.clearChecks();
});

await step("T12", "見つからなくなったファイルに印が付き、タグは残る", async () => {
  fs.renameSync(path.join(formats, "chime.flac"), path.join(dataDir, "chime.flac.moved"));
  await page.getByRole("button", { name: "スキャン", exact: true }).click();
  await waitIdle();
  const s = await status();
  expect(s.includes("見つからない 1件"), `status: ${s}`);
  const r = row("chime.flac");
  expect((await r.locator(".warn").count()) === 1, "印がない");
  expect((await r.locator(".chip").allInnerTexts()).includes("Short"), "タグが消えた");
  expect(await r.getByRole("button", { name: "再生" }).isDisabled(), "再生ボタンが押せる");
  await shot("T12_見つからないファイル");
});

await step("T13", "見つからないファイルだけに絞り込める（見つからないファイルがあるときだけ、ボタンが出る）", async () => {
  await page.getByRole("button", { name: "見つからないファイルだけ" }).click();
  await page.waitForTimeout(300);
  expect((await fileCount()) === 1, `件数 ${await fileCount()}`);
  await clearFilter();
});

await step("T14", "同じ場所に戻すと印が外れる", async () => {
  fs.renameSync(path.join(dataDir, "chime.flac.moved"), path.join(formats, "chime.flac"));
  await page.getByRole("button", { name: "スキャン", exact: true }).click();
  await waitIdle();
  expect((await page.getByRole("button", { name: "見つからないファイルだけ" }).count()) === 0, "ボタンが残っている");
  const s = await status();
  expect(s.includes("戻った 1件"), `status: ${s}`);
  expect((await row("chime.flac").locator(".warn").count()) === 0, "印が残っている");
});

await step("T15", "見つからないファイルをライブラリから外せる", async () => {
  fs.renameSync(path.join(formats, "chime.ogg"), path.join(dataDir, "chime.ogg.moved"));
  await page.getByRole("button", { name: "スキャン", exact: true }).click();
  await waitIdle();
  await row("chime.ogg").click();
  await page.getByRole("button", { name: "ライブラリから外す" }).click();
  await waitIdle();
  expect((await row("chime.ogg").count()) === 0, "外れていない");
  expect((await fileCount()) === 4, `件数 ${await fileCount()}`);
  fs.renameSync(path.join(dataDir, "chime.ogg.moved"), path.join(formats, "chime.ogg"));
});

await step("T16", "3万ファイルのフォルダを登録・表示・スクロールできる", async () => {
  const t0 = Date.now();
  await addFolder(large);
  const addMs = Date.now() - t0;
  const n = await fileCount();
  expect(n === 30004, `件数 ${n}`);
  const list = page.getByTestId("file-list");
  const t1 = Date.now();
  for (let i = 1; i <= 10; i++) {
    await list.evaluate((el, r) => (el.scrollTop = el.scrollHeight * r), i / 10);
    await page.waitForTimeout(50);
  }
  const scrollMs = Date.now() - t1;
  const rows = await page.getByTestId("file-row").count();
  expect(rows < 200, `描画している行が多すぎる: ${rows}`);
  await page.getByLabel("検索", { exact: true }).fill("se_42_1");
  const t2 = Date.now();
  await page.waitForFunction(() => parseInt(document.querySelector("[data-testid=file-count]").textContent, 10) === 100);
  const filterMs = Date.now() - t2;
  await shot("T16_3万件");
  await clearFilter();
  return `登録とスキャン ${addMs}ms、10回スクロール ${scrollMs}ms、絞り込み ${filterMs}ms（入力待ち200msを含む）、描画行 ${rows}`;
});

await step("T17", "3万件をすべてチェックして、まとめてタグを付けられる", async () => {
  await page.getByTestId("file-list").click();
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(500);
  const c = await ui.checkedCount();
  expect(c.includes("チェック 30004件"), c);
  const t0 = Date.now();
  await ui.bulkAddTag("一括");
  const ms = Date.now() - t0;
  expect((await tagItem("一括").innerText()).includes("30004"), await tagItem("一括").innerText());
  return `${ms}ms`;
});

await step("T18", "フォルダの登録を解除すると、ファイルとタグの情報が消える", async () => {
  // フォルダが複数あっても「すべてスキャン」は出さない（フォルダごとの「⟳」を使う）
  expect((await page.getByTestId("folder").count()) === 2, "フォルダが2つでない");
  expect((await page.getByRole("button", { name: "すべてスキャン" }).count()) === 0, "すべてスキャンが残っている");
  const folder = page.getByTestId("folder").filter({ hasText: "large" });
  await folder.getByRole("button", { name: "登録解除" }).click();
  await waitIdle();
  expect((await page.getByTestId("folder").count()) === 1, "フォルダが残っている");
  expect((await fileCount()) === 4, `件数 ${await fileCount()}`);
  expect((await tagItem("一括").innerText()).includes("4"), await tagItem("一括").innerText());
  expect(fs.existsSync(path.join(large, "d00", "se_00_000.wav")), "実際のファイルが消えた");
});

await step("T19", "右の欄のタグ：候補から選ぶとすぐ付く。まだない名前でEnterなら最上位に作って付く。空・付いている名前では何もしない", async () => {
  await row("chime.wav").click();
  const field = page.getByLabel("付けるタグ名", { exact: true });
  expect((await page.getByTestId("detail-panel").getByRole("button", { name: "付ける", exact: true }).count()) === 0, "「＋」が残っている");
  const tagTexts = () => page.getByTestId("selected-tag").evaluateAll((els) => els.map((e) => e.dataset.tagName));
  const attached = await tagTexts();
  const before = (await ui.tagNames()).length;
  // 空、付いている名前（大文字・小文字の違いを含む）では何もしない
  for (const name of ["   ", attached[0].toUpperCase()]) {
    await field.fill(name);
    await field.press("Enter");
    await waitIdle();
  }
  expect((await ui.tagNames()).length === before, "タグが増えた");
  expect((await tagTexts()).join(",") === attached.join(","), "付いているタグが変わった");
  // まだない名前でEnter：最上位に作って付ける
  await field.fill("右で作ったタグ");
  await field.press("Enter");
  await waitIdle();
  expect((await tagTexts()).includes("右で作ったタグ"), "付いていない");
  expect((await tagItem("右で作ったタグ").getAttribute("data-depth")) === "0", "最上位でない");
  expect((await field.inputValue()) === "", "入力欄が空にならない");
  // 候補から選ぶと、Enterを押さなくてもすぐ付く
  await row("chime.flac").click();
  await ui.pickTag("右で作ったタグ");
  expect((await tagTexts()).includes("右で作ったタグ"), "選んでも付かない");
  // 打ち込んでいる途中で名前が一致しても、Enterを押すまでは付けない
  await row("chime.mp3").click();
  await field.fill("右で作ったタグ");
  await page.waitForTimeout(300);
  expect(!(await tagTexts()).includes("右で作ったタグ"), "打ち込みだけで付いた");
  await field.fill("");
});

await step("T20", "聞き比べ：↑↓で右の欄のファイルを移し、試聴中なら移った先を続けて試聴する。スペースで試聴を始める・止める", async () => {
  await clearFilter();
  const selected = (rel) => row(rel).evaluate((el) => el.classList.contains("selected"));
  const playing = async (rel) => {
    await page.waitForTimeout(200);
    return row(rel).getByRole("button", { name: "停止" }).count();
  };
  // T15でchime.oggは外れている。並びは flac、mp3、wav
  await row("chime.flac").locator(".file-name").click();
  await page.keyboard.press("ArrowDown");
  expect(await selected("chime.mp3"), "↓で移らない");
  expect((await page.evaluate(() => document.querySelector("audio").paused)), "試聴していないのに鳴った");
  await page.keyboard.press(" ");
  expect((await playing("chime.mp3")) === 1, "スペースで試聴しない");
  await page.keyboard.press("ArrowDown");
  expect(await selected("chime.wav"), "↓で移らない");
  expect((await playing("chime.wav")) === 1 && (await playing("chime.mp3")) === 0, `移った先を試聴しない wav:${await playing("chime.wav")} mp3:${await playing("chime.mp3")} src:${await page.evaluate(() => decodeURIComponent(document.querySelector("audio").src))}`);
  await row("chime.wav").getByTestId("row-progress").waitFor({ timeout: 3000 });
  await page.keyboard.press("ArrowUp");
  expect((await playing("chime.mp3")) === 1, "↑で移った先を試聴しない");
  await page.keyboard.press(" ");
  expect((await playing("chime.mp3")) === 0, "スペースで止まらない");
});

await step("T21", "右の欄は、トラック名・ファイル名・タグ・プレイリスト・出典・ライセンス・ハッシュ値の順に出る。何も選んでいないときは空", async () => {
  await clearFilter();
  expect((await page.getByTestId("detail-panel").count()) === 0, "選んでいないのに右の欄が出る");
  expect(!(await page.locator(".detail").innerText()).includes("ファイルの詳細"), "見出しが残っている");
  await row("chime.mp3").locator(".file-name").click();
  await page.getByTestId("track-title").waitFor({ timeout: 3000 });
  expect((await page.getByTestId("track-title").innerText()) === "チャイム", await page.getByTestId("track-title").innerText());
  const p = page.getByTestId("detail-path");
  expect((await p.innerText()) === "chime.mp3", await p.innerText());
  expect((await p.getAttribute("title")) === path.join(formats, "chime.mp3"), `絶対パス ${await p.getAttribute("title")}`);
  const order = await page.getByTestId("detail-panel").evaluate((panel) =>
    [...panel.querySelectorAll("[data-testid]")]
      .map((e) => e.dataset.testid)
      .filter((id) =>
        ["track-title", "detail-path", "section-detail-tags", "section-detail-playlists", "credit-field-source", "credit-field-license", "selected-hash"].includes(id),
      ),
  );
  expect(order.join(",") === "track-title,detail-path,section-detail-tags,section-detail-playlists,credit-field-source,credit-field-license,selected-hash", order.join(","));
  // ハッシュ値は欄の幅いっぱいに折り返して出る（縦に細長くならない）
  const box = await page.getByTestId("selected-hash").boundingBox();
  expect(box.width > 150 && box.height < 80, `ハッシュ値の大きさ ${box.width}x${box.height}`);
  await shot("T21_右の欄");
});

await step("T22", "右の欄のタグ・プレイリストはたためて、たたんでも件数が出る。たたんだ状態は再読み込み後も残る", async () => {
  const tagsSection = page.getByTestId("section-detail-tags");
  const n = await page.getByTestId("selected-tag").count();
  expect(n > 0, "タグが付いていない");
  expect((await tagsSection.getByTestId("section-count").innerText()) === String(n), "件数");
  await tagsSection.locator(".collapse-toggle").click();
  expect((await page.getByTestId("selected-tag").count()) === 0, "たためない");
  expect((await page.getByLabel("付けるタグ名", { exact: true }).count()) === 0, "入力欄が残る");
  expect((await tagsSection.getByTestId("section-count").innerText()) === String(n), "たたむと件数が消える");
  await ui.reload();
  await row("chime.mp3").locator(".file-name").click();
  expect((await page.getByTestId("section-detail-tags").getAttribute("data-collapsed")) === "true", "再読み込みで開いた");
  expect((await page.getByTestId("section-detail-playlists").getAttribute("data-collapsed")) === "false", "プレイリストがたたまれた");
  await page.getByTestId("section-detail-tags").locator(".collapse-toggle").click();
  expect((await page.getByTestId("selected-tag").count()) === n, "開かない");
});

await step("T23", "欄の境界をドラッグして左・右の欄の幅を変えられる（最小の幅より狭くならない）。幅は再読み込み後も残る", async () => {
  const width = (sel) => page.locator(sel).evaluate((e) => e.getBoundingClientRect().width);
  const drag = async (label, dx) => {
    const b = await page.getByRole("separator", { name: label }).boundingBox();
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 5 });
    await page.mouse.up();
  };
  const side0 = await width(".side");
  const detail0 = await width(".detail");
  await drag("左の欄の幅", 100);
  const side1 = await width(".side");
  expect(Math.abs(side1 - side0 - 100) <= 2, `左 ${side0} → ${side1}`);
  await drag("右の欄の幅", -60);
  const detail1 = await width(".detail");
  expect(Math.abs(detail1 - detail0 - 60) <= 2, `右 ${detail0} → ${detail1}`);
  await shot("T23_欄の幅");
  await ui.reload();
  expect(Math.abs((await width(".side")) - side1) <= 2 && Math.abs((await width(".detail")) - detail1) <= 2, "再読み込みで戻った");
  await drag("左の欄の幅", -1000);
  expect((await width(".side")) === 180, `最小の幅 ${await width(".side")}`);
  await drag("左の欄の幅", side0 - 180);
  await drag("右の欄の幅", 60);
});

await step("T24", "左の欄はライブラリ・タグ・プレイリスト・出典・ライセンスの順。ライブラリの欄はたためて、たたんでも「追加」は押せる", async () => {
  const sections = await page.locator(".side [data-testid^=section-]").evaluateAll((els) => els.map((e) => e.dataset.testid));
  expect(sections.join(",") === "section-folders,section-tags,section-playlists,section-source,section-license", sections.join(","));
  const heads = await page.locator(".side .collapsible-head h2").allInnerTexts();
  expect(heads.join(",") === "ライブラリ,タグ,プレイリスト,出典,ライセンス", heads.join(","));
  const section = page.getByTestId("section-folders");
  expect((await section.locator("h2").innerText()) === "ライブラリ", await section.locator("h2").innerText());
  expect((await page.getByLabel("フォルダのパス").count()) === 0, "パスの欄が残っている");
  await section.locator(".collapse-toggle").click();
  expect((await page.getByTestId("folder").count()) === 0, "たためない");
  expect(await page.getByRole("button", { name: "フォルダを追加" }).isEnabled(), "追加が押せない");
  expect((await page.getByRole("button", { name: "フォルダを追加" }).innerText()) === "＋", "「＋」でない");
  await section.locator(".collapse-toggle").click();
  expect((await page.getByTestId("folder").count()) === 1, "開かない");
});

await step("T25", "絞り込みの操作（検索・✕・⧉・条件のチップ）は左の欄の一番上にあり、左の欄をスクロールしても残る。中央には件数とチェックだけ", async () => {
  const bar = page.getByTestId("filter-bar");
  const side = page.locator("aside.side");
  expect((await page.getByRole("button", { name: "ライブラリの外のファイルと同じ音声を探す" }).count()) === 0, "🔊が残っている");
  for (const name of ["重複しているファイルだけ"]) {
    expect((await bar.getByRole("button", { name }).count()) === 1, `${name}が左の欄にない`);
  }
  expect((await bar.getByLabel("検索", { exact: true }).count()) === 1, "検索が左の欄にない");
  expect((await page.locator("main").getByLabel("検索", { exact: true }).count()) === 0, "検索が中央に残っている");
  await ui.clearChecks();
  // 一覧の件数とチェックしている件数は、一番下の行に出す
  expect((await page.locator("main").getByTestId("file-count").count()) === 0, "件数が中央に残っている");
  expect((await page.locator(".status-bar").getByTestId("file-count").count()) === 1, "件数が下の行にない");
  expect((await page.locator(".status-bar").getByTestId("checked-count").innerText()).startsWith("チェック 0件"), "チェックの件数が下の行にない");
  // チェックしていないときは、中央のツールバー（チェックの操作）を出さない。一覧の見出しに「ファイル」の文字は出さない
  expect((await page.locator("main .toolbar").count()) === 0, "中央のツールバーが出ている");
  expect((await page.locator(".list-head").count()) === 0, "一覧の見出しの行が残っている");
  // フォルダを選ぶと、条件のチップが出る
  await page.getByTestId("folder").first().click();
  await page.waitForTimeout(300);
  expect((await bar.getByTestId("filter-chips").count()) === 1, "条件のチップが左の欄にない");
  expect((await bar.getByRole("button", { name: "すべて解除" }).count()) === 1, "✕が左の欄にない");
  // 左の欄を高くしてスクロールしても、絞り込みの部分は一番上に残る
  await side.evaluate((el) => {
    const spacer = document.createElement("div");
    spacer.id = "t25-spacer";
    spacer.style.height = "3000px";
    el.appendChild(spacer);
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(200);
  const [b, a] = [await bar.boundingBox(), await side.boundingBox()];
  await side.evaluate((el) => {
    document.getElementById("t25-spacer").remove();
    el.scrollTop = 0;
  });
  expect(Math.abs(b.y - a.y) < 2, `スクロールで動いた: ${b.y} / ${a.y}`);
  await clearFilter();
});

await step("T26", "ファイルの行をタグの行にドラッグするとタグが付く（チェックした行ならすべて）。（タグなし）には落とせない", async () => {
  await ui.createTags(["ドラッグ先"]);
  const target = tagItem("ドラッグ先");
  await ui.dragTo(row("chime.flac").locator(".file-name"), target, 0.5);
  await waitIdle();
  expect((await row("chime.flac").locator(".chip").allInnerTexts()).includes("ドラッグ先"), "付いていない");
  expect((await status()).includes("1件にタグ「ドラッグ先」を付けました"), await status());
  await ui.check("chime.wav");
  await ui.check("chime.mp3");
  await ui.dragTo(row("chime.wav").locator(".file-name"), target, 0.5);
  await waitIdle();
  for (const rel of ["chime.wav", "chime.mp3"]) {
    expect((await row(rel).locator(".chip").allInnerTexts()).includes("ドラッグ先"), `${rel}に付いていない`);
  }
  expect((await status()).includes("2件にタグ「ドラッグ先」を付けました"), await status());
  await ui.clearChecks();
  // （タグなし）の行は落とす先にならない
  const before = await status();
  await ui.dragTo(row("サブフォルダ/チャイム.m4a").locator(".file-name"), page.getByTestId("untagged"), 0.5, false);
  expect(!(await page.getByTestId("untagged").getAttribute("class")).includes("drop-target"), "（タグなし）に枠が出る");
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect((await status()) === before, `何かが起きた: ${await status()}`);
});

await step("T27", "絞り込みの条件のチップが2つ以上になると、名前のない「✕」のチップが出て、押すと条件だけがすべて外れる（チェックと右の欄はそのまま）", async () => {
  const clearChip = page.getByRole("button", { name: "絞り込みの条件をすべて外す" });
  await page.getByTestId("folder").first().click();
  await page.waitForTimeout(300);
  expect((await clearChip.count()) === 0, "条件が1つなのに出ている");
  await tagItem("ドラッグ先").locator(".tag-name").click();
  await page.getByLabel("検索", { exact: true }).fill("chime");
  await page.waitForTimeout(500);
  expect((await clearChip.count()) === 1, "条件が2つなのに出ない");
  expect((await clearChip.innerText()).trim() === "✕", `名前がある: ${await clearChip.innerText()}`);
  await row("chime.wav").click();
  await ui.check("chime.wav");
  await shot("T27_すべての条件を外す");
  await clearChip.click();
  await page.waitForTimeout(500);
  expect((await page.getByTestId("filter-chips").count()) === 0, "条件が残っている");
  expect((await page.getByLabel("検索", { exact: true }).inputValue()) === "", "検索の文字が残っている");
  expect((await ui.checkedCount()).startsWith("チェック 1件"), "チェックが外れた");
  expect((await page.getByTestId("detail-path").innerText()) === "chime.wav", "右の欄が変わった");
  await clearFilter();
});

await ui.finish();
