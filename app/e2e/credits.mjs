// 「出典とライセンスの管理」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/credits.mjs <テストデータ> <スクリーンショットの保存先>
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("credits.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, status, fileCount, row, waitIdle, addFolder, clearFilter } = ui;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LABEL = { source: "出典", license: "ライセンス" };

// 左の欄の出典・ライセンスの行。行の文字列は「名前」+「件数」
const leftItem = (kind, name) => page.getByTestId(kind).filter({ hasText: new RegExp(`^${escape(name)}\\d+$`) });
const leftCount = async (kind, name) => parseInt((await leftItem(kind, name).innerText()).replace(/^.*?(\d+)$/s, "$1"), 10);
const section = (id) => page.getByTestId(`section-${id}`);
const manageRow = (name) => page.locator(`[data-testid=manage-credit][data-credit-name="${name}"]`);
const manageNames = () => page.getByTestId("manage-credit").evaluateAll((rows) => rows.map((r) => r.dataset.creditName));
const termGroup = (label) => page.getByTestId("terms-editor").getByRole("group", { name: label, exact: true });
const pressed = async (label) =>
  (await termGroup(label).locator("button[aria-pressed=true]").innerText()).trim();
const termsDisabled = () =>
  page.getByTestId("terms-editor").locator("button").evaluateAll((bs) => bs.every((b) => b.disabled));
const termsEnabled = () =>
  page.getByTestId("terms-editor").locator("button").evaluateAll((bs) => bs.every((b) => !b.disabled));
const shortTerms = (name) => manageRow(name).getByTestId("terms-short").innerText();
const current = (kind) => page.getByTestId(`current-${kind}`).innerText();
const detail = (kind) => page.getByTestId(`detail-${kind}`).innerText();

async function openManager(kind) {
  await page.getByRole("button", { name: `${LABEL[kind]}を管理` }).click();
}
async function closeManager() {
  await page.getByRole("button", { name: "閉じる" }).click();
}
async function submit(label = "作成") {
  await page.getByTestId("credit-form").getByRole("button", { name: label, exact: true }).click();
  await waitIdle();
}
async function setCredit(kind, name) {
  await page.getByLabel(`設定する${LABEL[kind]}の名前`).fill(name);
  await page.getByTestId(`credit-field-${kind}`).getByRole("button", { name: "設定" }).click();
  await waitIdle();
}
async function selectRows(...rels) {
  await row(rels[0]).click();
  for (const r of rels.slice(1)) await row(r).click({ modifiers: ["Control"] });
}

await step("C01", "準備：フォルダを登録する。左の欄に3つの欄が開いた状態で並ぶ", async () => {
  await addFolder(formats);
  for (const id of ["tags", "source", "license"]) {
    expect((await section(id).getAttribute("data-collapsed")) === "false", `${id} がたたまれている`);
  }
  expect((await page.getByTestId("source-none").count()) === 1, "（出典なし）がない");
  expect((await page.getByTestId("license-none").count()) === 1, "（ライセンスなし）がない");
  await shot("C01_左の欄");
});

await step("C02", "出典を作成できる（名前・URL・メモ）。左の欄にも出る", async () => {
  await openManager("source");
  expect((await page.getByLabel("種類").count()) === 0, "出典に種類の欄がある");
  await page.getByLabel("名前", { exact: true }).fill(" 効果音サイトA ");
  await page.getByLabel("URL").fill("https://example.com/");
  await page.getByLabel("メモ").fill("クレジットは「効果音サイトA」");
  await submit();
  await page.getByLabel("名前", { exact: true }).fill("自分で録音");
  await submit();
  const names = await manageNames();
  expect(names.join(",") === "効果音サイトA,自分で録音", names.join(","));
  expect((await manageRow("効果音サイトA").innerText()).includes("https://example.com/"), "URLが出ない");
  await closeManager();
  expect((await leftCount("source", "効果音サイトA")) === 0, "左の欄の件数");
});

await step("C03", "同じ名前（大文字・小文字の違いを含む）の出典は作れない", async () => {
  await openManager("source");
  await page.getByLabel("名前", { exact: true }).fill("効果音サイトa");
  await submit();
  const s = await status();
  expect(s.includes("同じ名前の出典があります"), `status: ${s}`);
  expect((await manageNames()).length === 2, "増えた");
  await page.getByLabel("名前", { exact: true }).fill("");
  await closeManager();
});

await step("C04", "ライセンスの作成：最初は種類が「独自」、条項はすべて「不明」で選べる", async () => {
  await openManager("license");
  expect((await page.getByLabel("種類").inputValue()) === "", "種類が独自でない");
  for (const label of ["商用利用", "クレジット表記", "改変", "再配布", "継承"]) {
    expect((await pressed(label)) === "不明", `${label} が不明でない`);
  }
  expect(await termsEnabled(), "条項が選べない");
  await shot("C04_ライセンスの作成");
});

await step("C05", "種類を選ぶと条項が自動で設定されてグレーアウトし、空の名前に種類の名前が入る", async () => {
  await page.getByLabel("種類").selectOption("cc-by-nc-4.0");
  expect((await page.getByLabel("名前", { exact: true }).inputValue()) === "CC BY-NC 4.0", "名前が入らない");
  expect((await pressed("商用利用")) === "不可", "商用利用");
  expect((await pressed("クレジット表記")) === "必要", "クレジット表記");
  expect((await pressed("改変")) === "可", "改変");
  expect((await pressed("再配布")) === "可", "再配布");
  expect((await pressed("継承")) === "不要", "継承");
  expect(await termsDisabled(), "グレーアウトしていない");
  await shot("C05_種類を選んだ状態");
  // 名前が入っているときは、種類を変えても名前は変わらない
  await page.getByLabel("種類").selectOption("cc0");
  expect((await page.getByLabel("名前", { exact: true }).inputValue()) === "CC BY-NC 4.0", "名前が変わった");
  expect((await pressed("商用利用")) === "可", "CC0の商用利用");
  await page.getByLabel("種類").selectOption("cc-by-nc-4.0");
  await submit();
  const t = await shortTerms("CC BY-NC 4.0");
  expect(t.includes("CC BY-NC 4.0") && t.includes("商用不可 表記要 改変可 再配布可 継承不要"), t);
});

await step("C06", "種類が「独自」のライセンスは、条項を自由に選べる（選ばなかった条項は不明）", async () => {
  await page.getByLabel("名前", { exact: true }).fill("サイトB規約");
  await termGroup("商用利用").getByRole("button", { name: "可", exact: true }).click();
  await termGroup("クレジット表記").getByRole("button", { name: "不要" }).click();
  await termGroup("改変").getByRole("button", { name: "不可" }).click();
  await submit();
  const t = await shortTerms("サイトB規約");
  expect(t.includes("独自") && t.includes("商用可 表記不要 改変不可 再配布？ 継承？"), t);
});

await step("C07", "編集：「独自」に戻すと条項はそのままで選べるようになる。変更を保存できる", async () => {
  await manageRow("CC BY-NC 4.0").getByRole("button", { name: "編集" }).click();
  expect(await termsDisabled(), "編集の最初はグレーアウトしていない");
  await page.getByLabel("種類").selectOption("");
  expect((await pressed("商用利用")) === "不可", "条項が引き継がれない");
  expect(await termsEnabled(), "選べない");
  await page.getByLabel("名前", { exact: true }).fill("サイトC規約");
  await termGroup("継承").getByRole("button", { name: "不明" }).click();
  await submit("保存");
  const t = await shortTerms("サイトC規約");
  expect(t.includes("独自") && t.includes("商用不可 表記要 改変可 再配布可 継承？"), t);
  expect((await manageRow("CC BY-NC 4.0").count()) === 0, "古い名前が残っている");
});

await step("C08", "編集で別の既存の名前にはできない", async () => {
  await manageRow("サイトC規約").getByRole("button", { name: "編集" }).click();
  await page.getByLabel("名前", { exact: true }).fill("サイトb規約");
  await submit("保存");
  const s = await status();
  expect(s.includes("同じ名前のライセンスがあります"), `status: ${s}`);
  await page.getByTestId("credit-form").getByRole("button", { name: "やめる" }).click();
  await closeManager();
});

await step("C09", "選んだファイル（複数）に出典を設定できる。URL・メモが出る", async () => {
  await selectRows("chime.wav", "chime.mp3");
  await setCredit("source", "効果音サイトa");
  expect((await current("source")) === "効果音サイトA", await current("source"));
  const d = await detail("source");
  expect(d.includes("https://example.com/") && d.includes("クレジットは「効果音サイトA」"), d);
  expect((await leftCount("source", "効果音サイトA")) === 2, "左の欄の件数");
  await shot("C09_出典を設定");
});

await step("C10", "まだない名前のライセンスを設定すると、独自・条項はすべて不明で作られる", async () => {
  await setCredit("license", "新しい規約");
  expect((await current("license")) === "新しい規約", await current("license"));
  const d = await detail("license");
  expect(d.includes("種類：独自"), d);
  expect((d.match(/不明/g) ?? []).length === 5, d);
  expect((await leftCount("license", "新しい規約")) === 2, "左の欄の件数");
});

await step("C11", "設定が違うファイルを選ぶと「（ばらばら）」と件数が出る", async () => {
  await selectRows("chime.wav", "chime.mp3", "chime.flac");
  const c = await current("source");
  expect(c.includes("（ばらばら）") && c.includes("効果音サイトA：2件") && c.includes("なし：1件"), c);
  expect((await page.getByTestId("detail-source").count()) === 0, "ばらばらなのに詳細が出る");
  await shot("C11_ばらばら");
});

await step("C12", "設定済みのファイルに設定すると置き換わる", async () => {
  await row("chime.mp3").click();
  await setCredit("source", "自分で録音");
  expect((await current("source")) === "自分で録音", await current("source"));
  expect((await leftCount("source", "効果音サイトA")) === 1, "効果音サイトAの件数");
});

await step("C13", "絞り込み：出典どうしはOR、「なし」とは同時に選べない、ライセンスとはAND", async () => {
  await leftItem("source", "効果音サイトA").click();
  await page.waitForTimeout(400);
  expect((await fileCount()) === 1, `1つ選択 ${await fileCount()}`);
  await leftItem("source", "自分で録音").click();
  await page.waitForTimeout(400);
  expect((await fileCount()) === 2, `OR ${await fileCount()}`);
  await page.getByTestId("source-none").click();
  await page.waitForTimeout(400);
  expect((await fileCount()) === 3, `なし ${await fileCount()}`);
  expect((await page.locator("[data-testid=source].active").count()) === 0, "出典の選択が残る");
  await page.getByTestId("source-none").click();
  await leftItem("source", "効果音サイトA").click();
  await leftItem("source", "自分で録音").click();
  await leftItem("license", "新しい規約").click();
  await page.waitForTimeout(400);
  expect((await fileCount()) === 2, `AND ${await fileCount()}`);
  await page.getByTestId("license-none").click();
  await page.waitForTimeout(400);
  expect((await fileCount()) === 0, `出典あり・ライセンスなし ${await fileCount()}`);
  await shot("C13_絞り込み");
});

await step("C14", "たたんでも選んでいる条件の数が見出しに出る。たたんだ状態は再読み込み後も残る", async () => {
  await page.getByRole("button", { name: "出典で絞り込む" }).click();
  expect((await section("source").getAttribute("data-collapsed")) === "true", "たたまれない");
  expect((await page.getByTestId("source").count()) === 0, "たたんでも一覧が出る");
  expect((await section("source").getByTestId("selected-count").innerText()) === "2", "選択数");
  expect((await section("license").getByTestId("selected-count").innerText()) === "1", "ライセンスの選択数");
  await shot("C14_たたんだ状態");
  await ui.reload();
  expect((await section("source").getAttribute("data-collapsed")) === "true", "再読み込みで開いた");
  expect((await section("license").getAttribute("data-collapsed")) === "false", "ライセンスがたたまれた");
  await page.getByRole("button", { name: "出典で絞り込む" }).click();
  expect((await section("source").getAttribute("data-collapsed")) === "false", "開かない");
});

await step("C15", "「絞り込みを解除」で出典・ライセンスの条件も外れる", async () => {
  await leftItem("source", "効果音サイトA").click();
  await page.getByTestId("license-none").click();
  await page.waitForTimeout(400);
  await clearFilter();
  expect((await fileCount()) === 5, `件数 ${await fileCount()}`);
  expect((await page.locator(".tag-list li.active").count()) === 0, "選択が残る");
});

await step("C16", "外す：選んだファイルの設定がすべて外れる", async () => {
  await selectRows("chime.wav", "chime.mp3");
  await page.getByRole("button", { name: "出典を外す" }).click();
  await waitIdle();
  expect((await current("source")) === "なし", await current("source"));
  expect((await page.getByRole("button", { name: "出典を外す" }).isDisabled()), "外すが押せる");
  expect((await current("license")) === "新しい規約", "ライセンスまで外れた");
});

await step("C17", "削除：設定されていたファイルは「なし」になり、絞り込みの条件からも外れる", async () => {
  await leftItem("license", "新しい規約").click();
  await page.waitForTimeout(400);
  expect((await fileCount()) === 2, `件数 ${await fileCount()}`);
  await openManager("license");
  await manageRow("新しい規約").getByRole("button", { name: "削除" }).click();
  await waitIdle();
  expect((await manageRow("新しい規約").count()) === 0, "消えていない");
  await closeManager();
  expect((await fileCount()) === 5, `条件が外れない ${await fileCount()}`);
  await row("chime.wav").click();
  expect((await current("license")) === "なし", await current("license"));
});

await step("C18", "編集中のライセンスを削除すると、フォームは作成に戻る", async () => {
  await openManager("license");
  await manageRow("サイトB規約").getByRole("button", { name: "編集" }).click();
  await manageRow("サイトB規約").getByRole("button", { name: "削除" }).click();
  await waitIdle();
  const head = await page.getByTestId("credit-form").locator("h2").innerText();
  expect(head === "新しいライセンス", head);
  expect((await page.getByTestId("credit-form").getByRole("button", { name: "作成" }).count()) === 1, "作成ボタンがない");
  await closeManager();
});

await step("C19", "URLを押すとブラウザで開く（エラーが出ない）", async () => {
  await row("chime.wav").click();
  await setCredit("source", "効果音サイトA");
  await page.getByTestId("detail-source").getByRole("link", { name: "https://example.com/" }).click();
  await page.waitForTimeout(1500);
  const s = await status();
  expect(!(await page.getByTestId("status").getAttribute("class")).includes("error"), `status: ${s}`);
});

await ui.finish();
