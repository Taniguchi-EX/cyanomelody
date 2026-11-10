// 「グリッドビュー」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/grid.mjs <テストデータ> <スクリーンショットの保存先>
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("grid.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, row, tagItem, waitIdle, addFolder, addTag } = ui;

// 見せ方の切り替えは1つのボタン（押すたびに一覧・グリッドが入れ替わる。data-view は今の見せ方）
const viewSwitch = () => page.getByTestId("view-switch");
const tiles = () => page.locator("[data-testid=file-row].file-tile");
const rels = () => page.getByTestId("file-row").evaluateAll((rows) => rows.map((r) => r.dataset.relPath));
/** 押した（右の欄に出している）タイルの相対パス */
const selected = () => page.locator("[data-testid=file-row].selected").getAttribute("data-rel-path");

await step("G01", "準備：フォルダを登録する。最初は一覧で、切り替えのボタンはグリッドの絵", async () => {
  await addFolder(formats);
  await row("chime.wav").click();
  await addTag("雨");
  expect((await viewSwitch().getAttribute("data-view")) === "list", "最初が一覧でない");
  expect((await viewSwitch().getAttribute("aria-label")) === "グリッドで見る", await viewSwitch().getAttribute("aria-label"));
  expect((await tiles().count()) === 0, "最初からタイルになっている");
});

await step("G02", "切り替えのボタンでグリッドになり、タイルが横に並ぶ（曲名・タグ・再生ボタン・チェック）。再読み込み後も残る", async () => {
  await viewSwitch().click();
  await tiles().first().waitFor({ timeout: 3000 });
  expect((await tiles().count()) === 5, `${await tiles().count()}`);
  const boxes = await tiles().evaluateAll((ts) => ts.map((t) => t.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y) })));
  expect(boxes[1].y === boxes[0].y && boxes[1].x > boxes[0].x, `横に並ばない ${JSON.stringify(boxes)}`);
  const wav = row("chime.wav");
  expect((await wav.locator("[data-testid=file-name]").innerText()) === "chime.wav", await wav.locator("[data-testid=file-name]").innerText());
  expect((await wav.locator(".chip").first().innerText()).includes("雨"), "タグが出ない");
  expect((await wav.getByRole("button", { name: "再生", exact: true }).count()) === 1, "再生ボタンがない");
  expect((await wav.getByTestId("file-check").count()) === 1, "チェックボックスがない");
  await shot("G02_グリッド");
  await ui.reload();
  await tiles().first().waitFor({ timeout: 3000 });
  expect((await viewSwitch().getAttribute("data-view")) === "grid", "再読み込みで一覧に戻った");
});

await step("G03", "タイルを押すと右の欄に出る。←→で前後、↑↓で1段上下に移る", async () => {
  const list = await rels();
  await row(list[0]).locator("[data-testid=file-name]").click();
  expect((await selected()) === list[0], `${await selected()}`);
  expect((await page.getByTestId("detail-path").innerText()).endsWith(list[0].replaceAll("/", "\\")), await page.getByTestId("detail-path").innerText());
  await page.keyboard.press("ArrowRight");
  expect((await selected()) === list[1], `→ ${await selected()}`);
  await page.keyboard.press("ArrowLeft");
  expect((await selected()) === list[0], `← ${await selected()}`);
  // 1段の数（同じ高さのタイルの数）だけ移る
  const perRow = await tiles().evaluateAll((ts) => ts.filter((t) => t.getBoundingClientRect().y === ts[0].getBoundingClientRect().y).length);
  await page.keyboard.press("ArrowDown");
  const expected = list[Math.min(perRow, list.length - 1)];
  expect((await selected()) === expected, `↓ ${await selected()}（1段 ${perRow}）`);
});

await step("G04", "ダブルクリック・再生ボタンでその曲から再生し、鳴らしているタイルの再生ボタンは「■」。チェックと Shift でまとめてチェック", async () => {
  const list = await rels();
  await row(list[1]).locator("[data-testid=file-name]").dblclick();
  await ui.waitPlaying();
  expect((await row(list[1]).getByRole("button", { name: "停止", exact: true }).count()) === 1, "鳴らしているタイルが■でない");
  await row(list[1]).getByRole("button", { name: "停止", exact: true }).click();
  await ui.waitStopped();
  await row(list[0]).getByTestId("file-check").click();
  await row(list[2]).getByTestId("file-check").click({ modifiers: ["Shift"] });
  expect((await page.locator("[data-testid=file-row].checked").count()) === 3, `${await page.locator("[data-testid=file-row].checked").count()}`);
  await shot("G04_チェック");
});

await step("G05", "チェックしたタイルを左の欄のタグにドラッグすると、まとめて付く", async () => {
  await ui.createTags(["グリッドから"]);
  await ui.dragChecked(tagItem("グリッドから"));
  expect((await ui.status()).includes("3件にタグ「グリッドから」を付けました"), await ui.status());
  await ui.clearChecks();
  await waitIdle();
});

await step("G06", "切り替えのボタンで一覧に戻る", async () => {
  await viewSwitch().click();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=file-row].file-tile").length === 0, null, { timeout: 3000 });
  expect((await page.getByTestId("file-row").count()) === 5, `${await page.getByTestId("file-row").count()}`);
});

await ui.finish();
