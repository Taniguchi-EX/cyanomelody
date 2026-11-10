// 「タグのシノニム」の画面テスト。準備と実行の方法は tag-management.mjs と同じ。
//   node e2e/synonyms.mjs <テストデータ> <スクリーンショットの保存先>
// ファイルの情報からのタグ付けでシノニムを使うことは、単体テスト（autotag）で確かめる。
import path from "node:path";
import { connect, expect, parseArgs } from "./helpers.mjs";

const { dataDir, shotDir } = parseArgs("synonyms.mjs");

const ui = await connect(shotDir);
const { page, step, shot, status, row, tagItem, waitIdle } = ui;

const detail = () => page.getByTestId("tag-detail");
const synonymList = () => detail().getByTestId("synonym-list").locator("li").evaluateAll((els) => els.map((e) => e.dataset.value));
const synonymError = () => detail().getByTestId("synonym-list-error").innerText().catch(() => "");
/** 詳細画面のシノニムの一覧に value を加える（Enter で決める） */
async function addSynonym(value) {
  await detail().getByRole("button", { name: "シノニムを加える" }).click();
  await detail().getByLabel("加えるシノニム").fill(value);
  await detail().getByLabel("加えるシノニム").press("Enter");
}
async function saveDetail() {
  await detail().getByRole("button", { name: "保存" }).click();
  await detail().waitFor({ state: "detached", timeout: 3000 });
  await waitIdle();
}
const rowTags = (rel) => row(rel).locator(".row-tags .tag-chip").allInnerTexts();

await step("S01", "タグの詳細画面でシノニムを加えて保存できる。ほかのタグの名前・タグ名と同じものはその場で理由を出して入れない。左の欄の名前にマウスを乗せるとシノニムが出る", async () => {
  await ui.addFolder(path.join(dataDir, "formats"));
  await ui.createTags(["歌手A", "歌手B"]);
  await ui.openTagDetail("歌手A");
  await addSynonym("別名義A");
  await addSynonym("Second Name");
  // ほかのタグの名前・自分のタグ名と同じものは入れない（入力は続く。Esc で入力だけやめる）
  await addSynonym("歌手b");
  expect((await synonymError()) === "「歌手b」は、タグ「歌手B」の名前です", await synonymError());
  // 理由はエラーの色（赤）で出す
  const [color, error] = await detail().getByTestId("synonym-list-error").evaluate((e) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--error)";
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return [getComputedStyle(e).color, c];
  });
  expect(color === error, `理由の文字の色: ${color}（エラーの色 ${error}）`);
  await shot("S01_重なりの理由");
  await detail().getByLabel("加えるシノニム").fill("歌手A");
  await detail().getByLabel("加えるシノニム").press("Enter");
  expect((await synonymError()) === "タグ名と同じです", await synonymError());
  // 入力している間は保存できない
  expect(await detail().getByRole("button", { name: "保存" }).isDisabled(), "入力中に保存できる");
  await detail().getByLabel("加えるシノニム").press("Escape");
  expect((await synonymList()).join(",") === "別名義A,Second Name", (await synonymList()).join(","));
  await shot("S01_シノニムの一覧");
  await saveDetail();
  expect((await status()) === "タグ「歌手A」の詳細を保存しました", await status());
  const title = await tagItem("歌手A").locator(".tag-name").getAttribute("title");
  expect(title === "歌手A\nシノニム：別名義A、Second Name", JSON.stringify(title));
  // 開き直すと、保存したシノニムが出る
  await ui.openTagDetail("歌手A");
  expect((await synonymList()).join(",") === "別名義A,Second Name", (await synonymList()).join(","));
  await detail().getByRole("button", { name: "やめる" }).click();
});

await step("S02", "左の欄の検索で、シノニムでもタグが引っかかる", async () => {
  await page.getByLabel("検索", { exact: true }).fill("second");
  await page.waitForTimeout(300);
  const names = await page.getByTestId("tag").evaluateAll((els) => els.map((e) => e.dataset.tagName));
  expect(names.join(",") === "歌手A", names.join(","));
  await page.getByLabel("検索", { exact: true }).fill("");
});

await step("S03", "付けるタグ名：候補の横にシノニムが出る。シノニムを入れて Enter で、新しいタグを作らずにそのタグを付ける（付いていれば何もしない）", async () => {
  await row("chime.wav").click();
  const option = page.getByTestId("detail-panel").locator("datalist option[value='歌手A']");
  expect((await option.getAttribute("label")) === "別名義A / Second Name", await option.getAttribute("label"));
  await ui.addTag("別名義a");
  expect((await rowTags("chime.wav")).join(",") === "歌手A", (await rowTags("chime.wav")).join(","));
  expect(!(await ui.tagNames()).includes("別名義a"), (await ui.tagNames()).join(","));
  // もう付いているタグのシノニムなら、何もしない（入力欄は空になる）
  await ui.addTag("SECOND NAME");
  expect((await rowTags("chime.wav")).join(",") === "歌手A", (await rowTags("chime.wav")).join(","));
  expect((await page.getByLabel("付けるタグ名", { exact: true }).inputValue()) === "", "入力欄が空にならない");
  // 一括操作の欄でも同じ
  await ui.check("chime.mp3");
  await ui.check("chime.ogg");
  await page.getByRole("button", { name: "一括操作" }).click();
  const panel = page.getByTestId("bulk-panel");
  await panel.getByLabel("付けるタグ名").fill("別名義A");
  await panel.getByLabel("付けるタグ名").press("Enter");
  await waitIdle();
  expect((await rowTags("chime.mp3")).join(",") === "歌手A" && (await rowTags("chime.ogg")).join(",") === "歌手A", "一括操作でシノニムのタグが付かない");
  await ui.clearChecks();
});

await step("S04", "ほかのタグの名前かシノニムに名前を変えると統合になり、統合元の名前とシノニムが統合先のシノニムに加わる", async () => {
  await ui.openTagDetail("歌手B");
  await addSynonym("B別名");
  await saveDetail();
  await row("chime.flac").click();
  await ui.addTag("B別名");
  expect((await rowTags("chime.flac")).join(",") === "歌手B", (await rowTags("chime.flac")).join(","));
  // 「歌手B」を、歌手A のシノニム「別名義A」に変える → 歌手A への統合
  await ui.setConfirmReply(true);
  await ui.renameTag("歌手B", "別名義A");
  const message = await ui.lastConfirm();
  expect(message.startsWith("「別名義A」は、タグ「歌手A」のシノニムです。") && message.includes("「歌手B」の名前とシノニムは、「歌手A」のシノニムになります。"), message);
  expect((await ui.tagNames()).join(",") === "歌手A", (await ui.tagNames()).join(","));
  expect((await rowTags("chime.flac")).join(",") === "歌手A", (await rowTags("chime.flac")).join(","));
  await ui.openTagDetail("歌手A");
  expect((await synonymList()).join(",") === "別名義A,Second Name,歌手B,B別名", (await synonymList()).join(","));
  await shot("S04_統合した後のシノニム");
  await detail().getByRole("button", { name: "やめる" }).click();
});

await ui.finish();
