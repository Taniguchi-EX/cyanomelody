// cyanomelody の画面を、WebView2 のリモートデバッグ経由で操作して確かめる（Windows）。
// 使い方は app/README.md の「画面の自動操作による確認」を参照。
// 本物の Google Drive を使う。プレイリスト「E2E 確認」を作って最後に消し、Drive の指定フォルダを
// music/cyanomelody_test に設定する。
import { chromium } from "playwright-core";

const shots = process.argv[2];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts()[0].pages()[0];
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.accept());
let n = 0;
const shot = async (name) => page.screenshot({ path: `${shots}/${String(++n).padStart(2, "0")}_${name}.png` });
const text = (t) => page.getByText(t, { exact: false });
const button = (name) => page.getByRole("button", { name, exact: true });

try {
  await text("cyanomelody").first().waitFor();
  // 前回の実行で残ったテスト用のプレイリストを消す
  await button("プレイリスト").click();
  await page.getByPlaceholder("新しいプレイリストの名前").waitFor({ timeout: 20000 });
  await page.waitForTimeout(3000);
  while ((await page.locator("ul.list li", { hasText: "E2E 確認" }).count()) > 0) {
    await page.locator("ul.list li", { hasText: "E2E 確認" }).first().click();
    await button("削除").click();
    await page.getByPlaceholder("新しいプレイリストの名前").waitFor({ timeout: 30000 });
    await page.waitForTimeout(2000);
    log("残っていたテスト用のプレイリストを消した");
  }
  await button("設定").click();
  await text("でログイン中").waitFor({ timeout: 20000 });
  log("ログイン済み:", await text("でログイン中").textContent());
  await shot("設定");

  // Drive の指定フォルダ
  await page.locator(".field").first().getByRole("button", { name: "選ぶ" }).click();
  await text("📁 music").click();
  await page.locator(".picker .path .grow").filter({ hasText: /^\/music$/ }).waitFor({ timeout: 20000 });
  await text("📁 cyanomelody_test").click();
  await page.locator(".picker .path .grow").filter({ hasText: "/music/cyanomelody_test" }).waitFor({ timeout: 20000 });
  await button("このフォルダにする").click();
  await page.locator(".field .row > span.grow").first().filter({ hasText: "/music/cyanomelody_test" }).waitFor({ timeout: 20000 });
  log("Drive の指定フォルダを設定した");

  // 手動更新
  await button("曲の一覧を更新").click();
  await text("Google Drive：追加").waitFor({ timeout: 180000 });
  log("手動更新:", await text("Google Drive：追加").textContent());
  await shot("手動更新");

  // プレイリストを作って曲を追加
  await button("プレイリスト").click();
  await page.getByPlaceholder("新しいプレイリストの名前").fill("E2E 確認（消してよい）");
  await button("作成").click();
  await button("＋ 曲を追加").waitFor({ timeout: 20000 });
  await button("＋ 曲を追加").click();
  const addButtons = page.getByRole("button", { name: "追加", exact: true });
  await addButtons.first().waitFor();
  const count = await addButtons.count();
  for (let i = 0; i < count; i++) {
    await addButtons.nth(i).click();
    await text(`${i + 1} 曲を追加しました`).waitFor({ timeout: 30000 });
  }
  log(`${count} 曲を追加した`);
  await shot("曲の追加");
  await button("← 完了").click();
  await page.locator("ol.list li").nth(count - 1).waitFor();
  await shot("プレイリスト");

  // 再生
  await button("▶ 最初から再生").click();
  await page.locator(".player .title").filter({ hasNotText: "停止中" }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(3000);
  log("再生中:", await page.locator(".player .now").textContent(), await page.locator(".player .time").first().textContent());
  await shot("再生中");
  const before = await page.locator(".player .title").textContent();
  await page.getByTitle("次の曲", { exact: true }).click();
  await page.locator(".player .title").filter({ hasNotText: before }).waitFor({ timeout: 30000 });
  log("次の曲:", await page.locator(".player .title").textContent());
  await page.waitForTimeout(2000);
  await page.getByTitle("一時停止", { exact: true }).click();
  await page.getByTitle("再生", { exact: true }).waitFor();
  const paused = await page.locator(".player .time").first().textContent();
  await page.waitForTimeout(1500);
  log("一時停止:", paused, "→", await page.locator(".player .time").first().textContent());
  await shot("一時停止");

  // 編集
  await page.getByTitle("お気に入り").click();
  await page.locator("button.star.on").waitFor({ timeout: 30000 });
  await button("名前の変更").click();
  await page.locator("section input").first().fill("E2E 確認（改名・消してよい）");
  await page.locator("section input").first().press("Enter");
  await text("E2E 確認（改名・消してよい）").first().waitFor({ timeout: 30000 });
  const firstTitle = await page.locator("ol.list li").first().locator(".grow").textContent();
  await page.locator("ol.list li").first().getByTitle("下へ").click();
  await page.locator("ol.list li").nth(1).locator(".grow").filter({ hasText: firstTitle }).waitFor({ timeout: 30000 });
  await page.locator(".banner.busy").waitFor({ state: "hidden", timeout: 30000 });
  await page.locator("ol.list li").last().getByTitle("プレイリストから外す").click();
  await page.locator(".banner.busy").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await page.locator(".banner.busy").waitFor({ state: "hidden", timeout: 30000 });
  log("編集後の曲数:", await page.locator("ol.list li").count());
  await shot("編集後");

  // 一覧（お気に入りが上）
  await button("← 一覧").click();
  await text("E2E 確認（改名・消してよい）").waitFor({ timeout: 30000 });
  log("一覧:", (await page.locator("ul.list li").allTextContents()).join(" | "));
  await shot("一覧");

  // 削除
  await text("E2E 確認（改名・消してよい）").click();
  await button("削除").click();
  await page.getByPlaceholder("新しいプレイリストの名前").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  log("削除後の一覧:", (await page.locator("ul.list li").allTextContents()).join(" | ") || "(なし)");
  await shot("削除後");
  await page.getByTitle("再生", { exact: true }).click().catch(() => {});
  await page.waitForTimeout(300);
} catch (e) {
  log("失敗:", e.message.split("\n")[0]);
  await shot("失敗");
  process.exitCode = 1;
} finally {
  log("画面のエラー:", errors.length ? errors : "なし");
  await browser.close();
}
