// 「狭い画面での表示」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/layout.mjs <テストデータ> <スクリーンショットの保存先>
// 画面の大きさは page.setViewportSize で変え、最後に元の大きさ（1280×800）に戻す。
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("layout.mjs");

const ui = await connect(shotDir);
const { page, step, shot, row } = ui;

const LONG_TAGS = ["長めのタグその一", "長めのタグその二", "長めのタグその三", "長めのタグその四", "長めのタグその五", "短い"];

/** 行のタグの、出ている数・隠れている数・「+N tags」の文字・タグの欄の高さ・最後に出したチップの右の余白 */
const tagState = () =>
  row("chime.wav").evaluate((r) => {
    const box = r.querySelector(".row-tags");
    const shown = [...box.querySelectorAll(".tag-chip")].filter((c) => getComputedStyle(c).display !== "none");
    const more = r.querySelector("[data-testid=more-tags]");
    const last = (more ?? shown[shown.length - 1]).getBoundingClientRect().right;
    return {
      shown: shown.length,
      hidden: Number(box.dataset.hidden),
      more: more?.textContent ?? "",
      height: Math.round(box.getBoundingClientRect().height),
      gap: Math.round(box.getBoundingClientRect().right - last),
    };
  });

await step("L01", "ファイルの行のタグは1行に収まる分だけ出し、残りは「+N tags」にたたむ。幅を狭めるとたたむ数が増える。マウスを乗せるとすべて出る", async () => {
  await ui.addFolder(path.join(dataDir, "formats"));
  await ui.check("chime.wav");
  for (const name of LONG_TAGS) await ui.bulkAddTag(name);
  await ui.clearChecks();
  const wide = await tagState();
  expect(wide.hidden > 0 && wide.more === `+${wide.hidden} tags`, JSON.stringify(wide));
  expect(wide.shown + wide.hidden === LONG_TAGS.length && wide.height <= 22, JSON.stringify(wide));
  // 出したチップと「+N tags」の間・後ろに余白を残さない
  expect(wide.gap <= 1, JSON.stringify(wide));
  // マウスを乗せると、すべてのタグを出す
  await row("chime.wav").getByTestId("row-tags").hover();
  const popup = page.getByTestId("tags-popup");
  await popup.waitFor({ timeout: 3000 });
  expect((await popup.locator(".chip").allInnerTexts()).join(",") === LONG_TAGS.join(","), await popup.innerText());
  await shot("L01_たたんだタグ");
  await page.mouse.move(5, 5);
  await popup.waitFor({ state: "detached", timeout: 3000 });
  // 狭めると、たたむ数が増える（改行はしない）
  await page.setViewportSize({ width: 960, height: 800 });
  await page.waitForTimeout(300);
  const narrow = await tagState();
  expect(narrow.hidden > wide.hidden && narrow.more === `+${narrow.hidden} tags` && narrow.height <= 22, JSON.stringify(narrow));
  expect(narrow.gap <= 1, JSON.stringify(narrow));
  await shot("L01_狭いとき");
  // タグが少ない行には「+N tags」を出さない
  expect((await row("chime.mp3").getByTestId("more-tags").count()) === 0, "タグのない行に出た");
  await page.setViewportSize({ width: 1280, height: 800 });
});

/** 再生の欄：「▶」の中心、「■」の右端、右側（fx・音量・歯車）の左端 */
const playerLayout = () =>
  page.evaluate(() => {
    const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
    const main = rect(".play-main");
    const stop = document.querySelector(".play-modes button:last-child");
    const s = stop.getBoundingClientRect();
    return {
      center: main.left + main.width / 2,
      stopRight: s.right,
      sideLeft: rect(".play-side").left,
      // 「■」の真ん中で一番上にあるのが「■」自身か（ほかのものに隠れていないか）
      stopVisible: document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2)?.closest("button") === stop,
      width: window.innerWidth,
    };
  });

await step("L02", "再生の欄：広いときは「▶」が真ん中。狭めても再生方法・停止のボタンは右側に隠れず、中央のボタンが左へずれる", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const wide = await playerLayout();
  expect(Math.abs(wide.center - wide.width / 2) < 3 && wide.stopVisible, JSON.stringify(wide));
  let last = wide;
  for (const width of [1000, 860, 760]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(300);
    const l = await playerLayout();
    expect(l.stopVisible && l.stopRight <= l.sideLeft, `${width}: ${JSON.stringify(l)}`);
    last = l;
  }
  // 一番狭いときは、真ん中より左にずれている
  expect(last.center < last.width / 2 - 20, JSON.stringify(last));
  await shot("L02_狭い画面の再生の欄");
  await page.setViewportSize({ width: 1280, height: 800 });
});

await step("L03", "エフェクトセットの管理画面は広く（1200px まで）、試聴の曲の名前が長くても横のスクロールバーが出ない", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("player-fx").selectOption({ label: "新しいfxを作る" });
  const dialog = page.getByRole("dialog", { name: "エフェクトセットの管理" });
  await dialog.waitFor({ timeout: 3000 });
  const width = await dialog.evaluate((d) => Math.round(d.getBoundingClientRect().width));
  expect(width === 1200, `幅 ${width}`);
  // 試聴のボタンに長い曲の名前を入れる（画面テストでは鳴らしている曲がないので、文字だけ入れ替える）
  await page.locator(".preview-button").evaluate((b) => (b.textContent = `▶ ${"とても長い曲の名前".repeat(30)}.wav`));
  const overflow = await dialog.evaluate((d) => d.scrollWidth - d.clientWidth);
  expect(overflow <= 0, `横にはみ出した ${overflow}px`);
  await shot("L03_管理画面");
  await ui.setConfirmReply(true);
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await dialog.waitFor({ state: "detached", timeout: 3000 });
});

await ui.finish();
