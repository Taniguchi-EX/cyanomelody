// 「出典とライセンスの管理」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/credits.mjs <テストデータ> <スクリーンショットの保存先>
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("credits.mjs");
const formats = path.join(dataDir, "formats");

const ui = await connect(shotDir);
const { page, step, shot, status, fileCount, row, waitIdle, addFolder, clearFilter } = ui;

const LABEL = { source: "出典", license: "ライセンス" };

// 左の欄の出典・ライセンスの行
const leftItem = (kind, name) => page.locator(`[data-testid=${kind}][data-credit-name="${name}"]`);
const leftCount = async (kind, name) => parseInt(await leftItem(kind, name).getByTestId("credit-count").innerText(), 10);
const section = (id) => page.getByTestId(`section-${id}`);
const leftNames = (kind) => page.getByTestId(kind).evaluateAll((rows) => rows.map((r) => r.dataset.creditName));
const form = () => page.getByTestId("credit-form");
const termGroup = (label) => page.getByTestId("terms-editor").getByRole("group", { name: label, exact: true });
const pressed = async (label) =>
  (await termGroup(label).locator("button[aria-pressed=true]").innerText()).trim();
const termsDisabled = () =>
  page.getByTestId("terms-editor").locator("button").evaluateAll((bs) => bs.every((b) => b.disabled));
const termsEnabled = () =>
  page.getByTestId("terms-editor").locator("button").evaluateAll((bs) => bs.every((b) => !b.disabled));
// 左の欄のライセンスの行の、条項の言葉（記号にマウスを乗せると出る言葉）
const shortTerms = (name) => leftItem("license", name).getByTestId("term-marks").getAttribute("title");
// 右の欄のプルダウンで選んでいる名前（「（なし）」は「なし」にする）
const current = async (kind) => {
  const text = await page.getByTestId(`current-${kind}`).evaluate((s) => s.selectedOptions[0].text);
  return text === "（なし）" ? "なし" : text;
};
const detail = (kind) => page.getByTestId(`detail-${kind}`).innerText();

/** 見出しの「＋」で、作るフォームを開く */
async function openCreate(kind) {
  await section(kind).getByRole("button", { name: `${LABEL[kind]}を作る` }).click();
}
/** 行の「✎」で、編集するフォームを開く */
async function openEdit(kind, name) {
  await ui.rowAction(leftItem(kind, name), `${name}の編集`);
}
async function submit(label = "作成") {
  await form().getByRole("button", { name: label, exact: true }).click();
  await waitIdle();
}
/** ライセンスの種類（編集のフォームを開いて読み、Escで閉じる） */
async function typeOf(name) {
  await openEdit("license", name);
  const v = await page.getByLabel("種類").inputValue();
  await page.keyboard.press("Escape");
  return v;
}
async function setCredit(kind, name) {
  // 右の欄では、プルダウンで選ぶとすぐ設定する
  await page.getByLabel(`${LABEL[kind]}を選ぶ`).selectOption({ label: name });
  await waitIdle();
}
/** チェックをすべて外してから、指定したファイルをチェックする */
async function checkRows(...rels) {
  await ui.clearChecks();
  for (const r of rels) await ui.check(r);
}
/** チェックしたファイルを、左の欄の出典・ライセンスの行へドラッグして設定する */
async function dropCredit(kind, name) {
  await ui.dragChecked(leftItem(kind, name));
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

await step("C02", "見出しの「＋」で出典を作成できる（名前・URL・メモ。Enter でも作れる）。作るとフォームが閉じ、左の欄に出る。行の「✎」「🗑」はマウスを乗せたときだけ出る", async () => {
  await openCreate("source");
  expect((await form().locator("h2").innerText()) === "新しい出典", await form().locator("h2").innerText());
  expect((await page.getByLabel("種類").count()) === 0, "出典に種類の欄がある");
  await page.getByLabel("名前", { exact: true }).fill(" 効果音サイトA ");
  await page.getByLabel("URL").fill("https://example.com/");
  await page.getByLabel("メモ").fill("クレジットは「効果音サイトA」");
  await submit();
  expect((await form().count()) === 0, "作ってもフォームが閉じない");
  await openCreate("source");
  await page.getByLabel("名前", { exact: true }).fill("自分で録音");
  await submit();
  const names = await leftNames("source");
  expect(names.join(",") === "効果音サイトA,自分で録音", names.join(","));
  expect((await leftCount("source", "効果音サイトA")) === 0, "左の欄の件数");
  // URLは編集のフォームに入っている
  await openEdit("source", "効果音サイトA");
  expect((await page.getByLabel("URL").inputValue()) === "https://example.com/", "URLが保存されない");
  await page.keyboard.press("Escape");
  // 行の記号はマウスを乗せたときだけ出る。名前の欄で Enter を押しても作れる（旧 C20）
  const actions = leftItem("source", "効果音サイトA").getByTestId("row-actions");
  await row("chime.wav").hover();
  expect(!(await actions.isVisible()), "マウスを乗せる前から出ている");
  await leftItem("source", "効果音サイトA").hover();
  expect(await actions.isVisible(), "マウスを乗せても出ない");
  expect((await page.getByTestId("source-none").getByTestId("row-actions").count()) === 0, "（出典なし）に出ている");
  await shot("C20_行の記号");
  await openCreate("source");
  await page.getByLabel("名前", { exact: true }).fill("Enterで作成");
  await page.getByLabel("名前", { exact: true }).press("Enter");
  await waitIdle();
  expect((await leftItem("source", "Enterで作成").count()) === 1, "作成されない");
  expect((await form().count()) === 0, "閉じない");
});

await step("C04", "ライセンスの作成：最初は種類が「独自」で条項はすべて「不明」。種類を選ぶと条項が決まってグレーアウトし、空の名前に種類の名前が入る", async () => {
  await openCreate("license");
  expect((await page.getByLabel("種類").inputValue()) === "", "種類が独自でない");
  for (const label of ["商用利用", "クレジット表記", "改変", "再配布", "継承"]) {
    expect((await pressed(label)) === "不明", `${label} が不明でない`);
  }
  expect(await termsEnabled(), "条項が選べない");
  await shot("C04_ライセンスの作成");
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
  expect(t === "商用不可 表記要 改変可 再配布可 継承不要", t);
  expect((await typeOf("CC BY-NC 4.0")) === "cc-by-nc-4.0", "種類が保存されない");
});

await step("C06", "種類が「独自」のライセンスは条項を自由に選べる。編集で「独自」に戻すと、条項はそのままで選べるようになり、保存できる", async () => {
  await openCreate("license");
  await page.getByLabel("名前", { exact: true }).fill("サイトB規約");
  await termGroup("商用利用").getByRole("button", { name: "可", exact: true }).click();
  await termGroup("クレジット表記").getByRole("button", { name: "不要" }).click();
  await termGroup("改変").getByRole("button", { name: "不可" }).click();
  await submit();
  const t = await shortTerms("サイトB規約");
  expect(t === "商用可 表記不要 改変不可 再配布？ 継承？", t);
  expect((await typeOf("サイトB規約")) === "", "独自でない");
  await openEdit("license", "CC BY-NC 4.0");
  expect((await form().locator("h2").innerText()) === "「CC BY-NC 4.0」を編集", await form().locator("h2").innerText());
  expect(await termsDisabled(), "編集の最初はグレーアウトしていない");
  await page.getByLabel("種類").selectOption("");
  expect((await pressed("商用利用")) === "不可", "条項が引き継がれない");
  expect(await termsEnabled(), "選べない");
  await page.getByLabel("名前", { exact: true }).fill("サイトC規約");
  await termGroup("継承").getByRole("button", { name: "不明" }).click();
  await submit("保存");
  expect((await form().count()) === 0, "保存してもフォームが閉じない");
  const edited = await shortTerms("サイトC規約");
  expect(edited === "商用不可 表記要 改変可 再配布可 継承？", edited);
  expect((await typeOf("サイトC規約")) === "", "独自でない");
  expect((await leftItem("license", "CC BY-NC 4.0").count()) === 0, "古い名前が残っている");
});

await step("C09", "チェックしたファイルを出典・ライセンスの行にドラッグすると、まとめて設定できる（右の欄にURL・メモ・条項が出る）。（ライセンスなし）には落とせない", async () => {
  await checkRows("chime.wav", "chime.mp3");
  await dropCredit("source", "効果音サイトA");
  expect((await status()).includes("2件に出典「効果音サイトA」を設定しました"), await status());
  await row("chime.wav").click();
  expect((await current("source")) === "効果音サイトA", await current("source"));
  const d = await detail("source");
  expect(d.includes("https://example.com/") && d.includes("クレジットは「効果音サイトA」"), d);
  expect((await leftCount("source", "効果音サイトA")) === 2, "左の欄の件数");
  await shot("C09_出典を設定");
  await openCreate("license");
  await page.getByLabel("名前", { exact: true }).fill("新しい規約");
  await submit();
  await dropCredit("license", "新しい規約");
  expect((await current("license")) === "新しい規約", await current("license"));
  const license = await detail("license");
  expect((license.match(/？/g) ?? []).length === 5, license);
  expect((await page.getByTestId("detail-license").locator(".term-mark.unknown").count()) === 5, "不明の色");
  expect((await leftCount("license", "新しい規約")) === 2, "左の欄の件数");
  // （ライセンスなし）の行は落とす先にならない
  await ui.dragTo(row("chime.wav").locator(".file-name"), page.getByTestId("license-none"), 0.5, false);
  expect(!(await page.getByTestId("license-none").getAttribute("class")).includes("drop-target"), "（ライセンスなし）に枠が出る");
  await page.mouse.up();
  await waitIdle();
  expect((await leftCount("license", "新しい規約")) === 2, "（ライセンスなし）に落として変わった");
  await ui.clearChecks();
});


await step("C13", "絞り込み：出典を選んだまま「（出典なし）」を選ぶと、出典の選択が外れる（同時には選べない）", async () => {
  await ui.filtered(() => leftItem("source", "効果音サイトA").click());
  expect((await page.locator("[data-testid=source].active").count()) === 1, "選べない");
  await ui.filtered(() => page.getByTestId("source-none").click());
  expect((await page.locator("[data-testid=source].active").count()) === 0, "出典の選択が残る");
  expect((await page.getByTestId("source-none").getAttribute("class")).includes("active"), "（出典なし）が選ばれない");
  await ui.filtered(() => leftItem("source", "効果音サイトA").click());
  expect(!(await page.getByTestId("source-none").getAttribute("class")).includes("active"), "（出典なし）が残る");
  await shot("C13_絞り込み");
  await clearFilter();
});

await step("C17", "削除：設定されていたファイルは「なし」になり、絞り込みの条件からも外れる", async () => {
  await ui.filtered(() => leftItem("license", "新しい規約").click());
  expect((await fileCount()) === 2, `件数 ${await fileCount()}`);
  await ui.rowAction(leftItem("license", "新しい規約"), "新しい規約を削除");
  await waitIdle();
  expect((await leftItem("license", "新しい規約").count()) === 0, "消えていない");
  expect((await fileCount()) === 5, `条件が外れない ${await fileCount()}`);
  await row("chime.wav").click();
  expect((await current("license")) === "なし", await current("license"));
});

await step("C18", "フォームを「やめる」・Escで閉じると何も変わらない。🗑でキャンセルすると削除せず、絞り込みもしない", async () => {
  await openEdit("license", "サイトB規約");
  await page.getByLabel("名前", { exact: true }).fill("変えない");
  await form().getByRole("button", { name: "やめる" }).click();
  await openEdit("license", "サイトB規約");
  await page.getByLabel("名前", { exact: true }).fill("変えない");
  await page.getByLabel("名前", { exact: true }).press("Escape");
  await page.waitForTimeout(200);
  expect((await form().count()) === 0, "Escで閉じない");
  expect((await leftNames("license")).join(",") === "サイトB規約,サイトC規約", (await leftNames("license")).join(","));
  await ui.setConfirmReply(false);
  await ui.rowAction(leftItem("license", "サイトB規約"), "サイトB規約を削除");
  await page.waitForTimeout(300);
  await ui.setConfirmReply(true);
  expect((await ui.lastConfirm()).includes("ライセンス「サイトB規約」を削除しますか"), await ui.lastConfirm());
  expect((await leftItem("license", "サイトB規約").count()) === 1, "キャンセルしたのに削除した");
  expect((await page.getByTestId("selected-count").count()) === 0, "🗑を押して絞り込んだ");
});

await step("C19", "URLを押すとブラウザで開く（エラーが出ない）", async () => {
  await row("chime.wav").click();
  await setCredit("source", "効果音サイトA");
  await page.getByTestId("detail-source").getByRole("link", { name: "https://example.com/" }).click();
  await page.waitForTimeout(1500);
  const s = await status();
  expect(!(await page.getByTestId("status").getAttribute("class")).includes("error"), `status: ${s}`);
});

await step("C21", "左の欄のライセンスの行に、条項が色分けした記号で出る（マウスを乗せると言葉）", async () => {
  const marks = leftItem("license", "サイトC規約").getByTestId("term-marks");
  const states = await marks.locator(".term-mark").evaluateAll((els) => els.map((e) => e.className.replace("term-mark ", "")).join(","));
  expect(states === "bound,bound,free,free,unknown", states);
  const title = await marks.getAttribute("title");
  expect(title === "商用不可 表記要 改変可 再配布可 継承？", title);
  await shot("C21_条項の記号");
});

await step("C22", "右の欄の出典・ライセンスはプルダウン：（なし）と既にある名前が並び、選ぶとすぐ設定し、（なし）で外す", async () => {
  await row("chime.ogg").click();
  const select = page.getByLabel("出典を選ぶ");
  const options = await select.locator("option").allInnerTexts();
  expect(options.join(",") === "（なし）," + (await leftNames("source")).join(","), options.join(","));
  expect((await page.getByTestId("credit-field-source").getByRole("button", { name: "設定" }).count()) === 0, "「設定」が残っている");
  await select.selectOption({ label: "自分で録音" });
  await waitIdle();
  expect((await current("source")) === "自分で録音", await current("source"));
  await select.selectOption({ label: "（なし）" });
  await waitIdle();
  expect((await current("source")) === "なし", await current("source"));
  await shot("C22_右の欄のプルダウン");
});

await ui.finish();
