import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

function App() {
  const [coreVersion, setCoreVersion] = useState<string>("");

  useEffect(() => {
    invoke<string>("core_version")
      .then(setCoreVersion)
      .catch((e) => setCoreVersion(`取得できません: ${e}`));
  }, []);

  return (
    <main className="container">
      <h1>cyanomelody</h1>
      <p>中核のバージョン: {coreVersion}</p>
    </main>
  );
}

export default App;
