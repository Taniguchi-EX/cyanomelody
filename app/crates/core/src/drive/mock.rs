//! テスト用の、Google Drive の応答を真似る HTTP サーバ。
//! フォルダの一覧（検索式の一部とページ分け）、ファイルの情報、Range 指定の部分取得、
//! フォルダとファイルの作成、中身の置き換え、ゴミ箱への移動に応える。

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
    trashed: bool,
}

#[derive(Default)]
struct State {
    nodes: Vec<Node>,
    page_size: usize,
    reject: usize,
    latency: Duration,
    next_id: usize,
}

impl State {
    fn add(&mut self, parent: &str, name: &str, mime: &str, data: Vec<u8>) -> Node {
        self.next_id += 1;
        let node = Node {
            id: format!("id{}", self.next_id),
            parent: parent.into(),
            name: name.into(),
            mime: mime.into(),
            data,
            modified: "2026-10-26T00:00:00.000Z".into(),
            trashed: false,
        };
        self.nodes.push(node.clone());
        node
    }
}

pub(crate) struct MockDrive {
    port: u16,
    state: Arc<Mutex<State>>,
    pub media_requests: Arc<AtomicUsize>,
}

struct Request {
    method: String,
    path: String,
    params: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
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

    pub fn add_folder(&self, parent: &str, name: &str) -> String {
        self.state
            .lock()
            .unwrap()
            .add(parent, name, FOLDER_MIME, Vec::new())
            .id
    }

    pub fn add_file(&self, parent: &str, name: &str, data: Vec<u8>) -> String {
        self.state
            .lock()
            .unwrap()
            .add(parent, name, "audio/mpeg", data)
            .id
    }

    pub fn remove(&self, id: &str) {
        self.state.lock().unwrap().nodes.retain(|n| n.id != id);
    }

    /// `parent` の直下の、ゴミ箱にないものの名前。
    pub fn names(&self, parent: &str) -> Vec<String> {
        let st = self.state.lock().unwrap();
        let mut names: Vec<String> = st
            .nodes
            .iter()
            .filter(|n| n.parent == parent && !n.trashed)
            .map(|n| n.name.clone())
            .collect();
        names.sort();
        names
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

fn read_request(stream: &TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
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
    let mut body = Vec::new();
    if let Some(len) = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
    {
        body.resize(len, 0);
        reader.read_exact(&mut body).ok()?;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let params = query
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
    Some(Request {
        method,
        path: path.to_string(),
        params,
        headers,
        body,
    })
}

fn handle(stream: TcpStream, state: &Mutex<State>, media_requests: &AtomicUsize) {
    let Some(req) = read_request(&stream) else {
        return;
    };
    let (status, body, extra) = respond(state, &req, media_requests);
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

const JSON: &str = "Content-Type: application/json\r\n";

fn ok_json(v: Value) -> (u16, Vec<u8>, String) {
    (200, v.to_string().into_bytes(), JSON.into())
}

fn respond(
    state: &Mutex<State>,
    req: &Request,
    media_requests: &AtomicUsize,
) -> (u16, Vec<u8>, String) {
    let mut st = state.lock().unwrap();
    if st.reject > 0 {
        st.reject -= 1;
        return (401, b"{\"error\":\"unauthorized\"}".to_vec(), JSON.into());
    }
    let not_found = (404, b"{\"error\":\"not found\"}".to_vec(), JSON.to_string());
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/drive/v3/about") => {
            ok_json(json!({ "user": { "emailAddress": "test@example.com" } }))
        }
        ("GET", "/drive/v3/files") => {
            let q = req.params.get("q").cloned().unwrap_or_default();
            let parent = between(&q, "'", "' in parents").unwrap_or_default();
            let name = between(&q, "name = '", "'").map(|n| n.replace("\\'", "'"));
            let folders_only = q.contains(&format!("mimeType = '{FOLDER_MIME}'"));
            let files_only = q.contains(&format!("mimeType != '{FOLDER_MIME}'"));
            let matches: Vec<&Node> = st
                .nodes
                .iter()
                .filter(|n| n.parent == parent && !n.trashed)
                .filter(|n| name.as_ref().is_none_or(|nm| &n.name == nm))
                .filter(|n| !folders_only || n.mime == FOLDER_MIME)
                .filter(|n| !files_only || n.mime != FOLDER_MIME)
                .collect();
            let start: usize = req
                .params
                .get("pageToken")
                .and_then(|t| t.parse().ok())
                .unwrap_or(0);
            let end = (start + st.page_size).min(matches.len());
            let mut body = json!({ "files": matches[start..end].iter().map(|n| node_json(n)).collect::<Vec<_>>() });
            if end < matches.len() {
                body["nextPageToken"] = json!(end.to_string());
            }
            ok_json(body)
        }
        ("POST", "/drive/v3/files") => {
            let meta: Value = serde_json::from_slice(&req.body).unwrap_or_default();
            let node = st.add(
                meta["parents"][0].as_str().unwrap_or("root"),
                meta["name"].as_str().unwrap_or(""),
                meta["mimeType"]
                    .as_str()
                    .unwrap_or("application/octet-stream"),
                Vec::new(),
            );
            ok_json(node_json(&node))
        }
        ("POST", "/upload/drive/v3/files") => {
            let content_type = req.headers.get("content-type").cloned().unwrap_or_default();
            let boundary = content_type
                .split("boundary=")
                .nth(1)
                .unwrap_or("")
                .to_string();
            let (meta, data) = parse_multipart(&req.body, &boundary);
            let node = st.add(
                meta["parents"][0].as_str().unwrap_or("root"),
                meta["name"].as_str().unwrap_or(""),
                meta["mimeType"]
                    .as_str()
                    .unwrap_or("application/octet-stream"),
                data,
            );
            ok_json(node_json(&node))
        }
        ("PATCH", path) if path.starts_with("/upload/drive/v3/files/") => {
            let id = &path["/upload/drive/v3/files/".len()..];
            let Some(node) = st.nodes.iter_mut().find(|n| n.id == id) else {
                return not_found;
            };
            node.data = req.body.clone();
            let v = node_json(node);
            ok_json(v)
        }
        ("PATCH", path) if path.starts_with("/drive/v3/files/") => {
            let id = &path["/drive/v3/files/".len()..];
            let meta: Value = serde_json::from_slice(&req.body).unwrap_or_default();
            let Some(node) = st.nodes.iter_mut().find(|n| n.id == id) else {
                return not_found;
            };
            if meta["trashed"] == json!(true) {
                node.trashed = true;
            }
            let v = node_json(node);
            ok_json(v)
        }
        ("GET", path) if path.starts_with("/drive/v3/files/") => {
            let id = &path["/drive/v3/files/".len()..];
            let Some(node) = st.nodes.iter().find(|n| n.id == id && !n.trashed).cloned() else {
                return not_found;
            };
            if req.params.get("alt").map(String::as_str) != Some("media") {
                return ok_json(node_json(&node));
            }
            let latency = st.latency;
            drop(st);
            std::thread::sleep(latency);
            media_requests.fetch_add(1, Ordering::Relaxed);
            let len = node.data.len() as u64;
            if len == 0 {
                return (200, Vec::new(), String::new());
            }
            let (start, end) = req
                .headers
                .get("range")
                .and_then(|r| r.strip_prefix("bytes="))
                .and_then(|r| r.split_once('-'))
                .map(|(s, e)| {
                    (
                        s.parse().unwrap_or(0),
                        e.parse().unwrap_or(len - 1).min(len - 1),
                    )
                })
                .unwrap_or((0, len - 1));
            let body = node.data[start as usize..=end as usize].to_vec();
            (
                206,
                body,
                format!("Content-Range: bytes {start}-{end}/{len}\r\n"),
            )
        }
        _ => not_found,
    }
}

/// `multipart/related` の本文から、最初の部分（JSON のメタデータ）と 2 番目の部分（中身）を取り出す。
fn parse_multipart(body: &[u8], boundary: &str) -> (Value, Vec<u8>) {
    let delimiter = format!("--{boundary}");
    let mut parts = Vec::new();
    let mut rest = body;
    while let Some(i) = find(rest, delimiter.as_bytes()) {
        rest = &rest[i + delimiter.len()..];
        if rest.starts_with(b"--") {
            break;
        }
        let end = find(rest, delimiter.as_bytes()).unwrap_or(rest.len());
        let part = &rest[..end];
        // 部分のヘッダと中身は空行で分かれ、中身の末尾には改行が付く
        if let Some(h) = find(part, b"\r\n\r\n") {
            let content = &part[h + 4..];
            parts.push(content.strip_suffix(b"\r\n").unwrap_or(content).to_vec());
        }
        rest = &rest[end..];
    }
    let meta = parts
        .first()
        .and_then(|m| serde_json::from_slice(m).ok())
        .unwrap_or_default();
    (meta, parts.get(1).cloned().unwrap_or_default())
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
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
