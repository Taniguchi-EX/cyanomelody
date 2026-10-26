const { invoke } = window.__TAURI__.core;

window.addEventListener("DOMContentLoaded", () => {
  const msg = document.querySelector("#msg");
  const state = document.querySelector("#state");
  const list = document.querySelector("#music-list");

  // 押したボタンの処理を呼び、結果か失敗を表示する
  const run = async (label, command, args) => {
    try {
      const result = await invoke(command, args);
      msg.textContent = `${label}: ${result ?? "OK"}`;
      return result;
    } catch (e) {
      msg.textContent = `${label} 失敗: ${e}`;
    }
  };

  // 再生の状態を 1 秒ごとに表示する（通知やロック画面からの操作が画面に反映されるかを見る）
  setInterval(async () => {
    state.textContent = await invoke("player_state");
  }, 1000);

  document.querySelector("#chime-button").addEventListener("click", () => run("再生", "play_chime"));
  document.querySelector("#playlist-button").addEventListener("click", () => run("プレイリスト", "play_playlist"));
  document.querySelectorAll(".command").forEach((button) =>
    button.addEventListener("click", () => run(button.textContent, "player_command", { cmd: button.dataset.cmd })),
  );
  document.querySelector("#id-button").addEventListener("click", () => run("端末ID", "device_id"));

  document.querySelector("#list-button").addEventListener("click", async () => {
    const dir = document.querySelector("#dir-input").value;
    const files = await run("曲の一覧", "list_music", { dir });
    if (!files) return;
    msg.textContent = `曲の一覧: ${files.length}曲`;
    list.replaceChildren(
      ...files.map((path) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = path.slice(dir.length + 1);
        button.addEventListener("click", () => run("再生", "play_file", { path }));
        item.append(button);
        return item;
      }),
    );
  });
});
