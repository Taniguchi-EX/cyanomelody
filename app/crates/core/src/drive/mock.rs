//! テスト用の、Google Drive の応答を真似る HTTP サーバ。
//! フォルダの一覧（検索式の一部とページ分け）、ファイルの情報、Range 指定の部分取得に応える。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use super::FOLDER_MIME;

#[derive(Clone)]
struct Node {
    id: String,
    parent: String,
    name: String,
    mime: String,
    data: Vec<u8>,
    modified: String,
}

#[derive(Default)]
struct State {
    nodes: Vec<Node>,
    page_size: usize,
    reject: usize,
    latency: Duration,
}

pub(crate) struct MockDrive {
    port: u16,
    state: Arc<Mutex<State>>,
    pub media_requests: Arc<AtomicUsize>,
}

impl MockDrive {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(Mutex::new(State {
            page_size: 1000,
            ..Default::default()
        }));
        let media_requests = Arc::new(AtomicUsize::new(0));
        let (s, r) = (state.clone(), media_requests.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (s, r) = (s.clone(), r.clone());
                std::thread::spawn(move || handle(stream, &s, &r));
            }
        });
        Self {
            port,
            state,
            media_requests,
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn add(&self, parent: &str, name: &str, mime: &str, data: Vec<u8>) -> String {
        let mut st = self.state.lock().unwrap();
        let id = format!("id{}", st.nodes.len() + 1);
        st.nodes.push(Node {
            id: id.clone(),
            parent: parent.into(),
            name: name.into(),
            mime: mime.into(),
            data,
            modified: "2026-10-26T00:00:00.000Z".into(),
        });
        id
    }

    pub fn add_folder(&self, parent: &str, name: &str) -> String {
        self.add(parent, name, FOLDER_MIME, Vec::new())
    }

    pub fn add_file(&self, parent: &str, name: &str, data: Vec<u8>) -> String {
        self.add(parent, name, "audio/mpeg", data)
    }

    pub fn remove(&self, id: &str) {
        self.state.lock().unwrap().nodes.retain(|n| n.id != id);
    }

    pub fn set_page_size(&self, size: usize) {
        self.state.lock().unwrap().page_size = size;
    }

    /// 次の `n` 回の要求を 401 で拒否する。
    pub fn reject_next_requests(&self, n: usize) {
        self.state.lock().unwrap().reject = n;
    }

    /// 部分取得の応答を遅らせる（本物の Drive の約 1 秒の待ちを真似る）。
    pub fn set_latency(&self, latency: Duration) {
        self.state.lock().unwrap().latency = latency;
    }
}

fn handle(stream: TcpStream, state: &Mutex<State>, media_requests: &AtomicUsize) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let mut headers = HashMap::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.trim_end().split_once(':') {
            headers.insert(k.to_ascii_lowercase(), v.trim().to_string());
        }
    }
    if let Some(len) = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
    {
        let mut body = vec![0; len];
        let _ = reader.read_exact(&mut body);
    }
    let target = line.split_whitespace().nth(1).unwrap_or("/").to_string();
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let params: HashMap<String, String> = query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| {
            (
                k.to_string(),
                urlencoding::decode(&v.replace('+', " "))
                    .unwrap_or_default()
                    .into_owned(),
            )
        })
        .collect();

    let (status, body, extra) = respond(state, path, &params, &headers, media_requests);
    let reason = match status {
        200 => "OK",
        206 => "Partial Content",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Error",
    };
    let mut out = stream;
    let _ = write!(
        out,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",
        body.len()
    );
    let _ = out.write_all(&body);
}

fn respond(
    state: &Mutex<State>,
    path: &str,
    params: &HashMap<String, String>,
    headers: &HashMap<String, String>,
    media_requests: &AtomicUsize,
) -> (u16, Vec<u8>, String) {
    let json_type = "Content-Type: application/json\r\n".to_string();
    let mut st = state.lock().unwrap();
    if st.reject > 0 {
        st.reject -= 1;
        return (401, b"{\"error\":\"unauthorized\"}".to_vec(), json_type);
    }
    if path == "/drive/v3/files" {
        let q = params.get("q").cloned().unwrap_or_default();
        let parent = between(&q, "'", "' in parents").unwrap_or_default();
        let name = between(&q, "name = '", "'");
        let folders_only = q.contains(FOLDER_MIME);
        let matches: Vec<&Node> = st
            .nodes
            .iter()
            .filter(|n| n.parent == parent)
            .filter(|n| name.as_ref().is_none_or(|nm| &n.name == nm))
            .filter(|n| !folders_only || n.mime == FOLDER_MIME)
            .collect();
        let start: usize = params
            .get("pageToken")
            .and_then(|t| t.parse().ok())
            .unwrap_or(0);
        let end = (start + st.page_size).min(matches.len());
        let mut body = json!({ "files": matches[start..end].iter().map(|n| node_json(n)).collect::<Vec<_>>() });
        if end < matches.len() {
            body["nextPageToken"] = json!(end.to_string());
        }
        return (200, body.to_string().into_bytes(), json_type);
    }
    let Some(id) = path.strip_prefix("/drive/v3/files/") else {
        return (404, Vec::new(), String::new());
    };
    let Some(node) = st.nodes.iter().find(|n| n.id == id).cloned() else {
        return (404, b"{\"error\":\"not found\"}".to_vec(), json_type);
    };
    if params.get("alt").map(String::as_str) != Some("media") {
        return (200, node_json(&node).to_string().into_bytes(), json_type);
    }
    let latency = st.latency;
    drop(st);
    std::thread::sleep(latency);
    media_requests.fetch_add(1, Ordering::Relaxed);
    let len = node.data.len() as u64;
    let (start, end) = headers
        .get("range")
        .and_then(|r| r.strip_prefix("bytes="))
        .and_then(|r| r.split_once('-'))
        .map(|(s, e)| {
            (
                s.parse().unwrap_or(0),
                e.parse().unwrap_or(len - 1).min(len - 1),
            )
        })
        .unwrap_or((0, len.saturating_sub(1)));
    let body = node.data[start as usize..=end as usize].to_vec();
    (
        206,
        body,
        format!("Content-Range: bytes {start}-{end}/{len}\r\n"),
    )
}

fn node_json(n: &Node) -> Value {
    let mut v =
        json!({ "id": n.id, "name": n.name, "mimeType": n.mime, "modifiedTime": n.modified });
    if n.mime != FOLDER_MIME {
        v["size"] = json!(n.data.len().to_string());
    }
    v
}

fn between(s: &str, start: &str, end: &str) -> Option<String> {
    let i = s.find(start)? + start.len();
    let j = s[i..].find(end)? + i;
    Some(s[i..j].to_string())
}
