//! Android：曲のファイル（SAF）を画面の audio 要素に渡すプロトコル（`cm-media`）。
//! プラグインのプロトコル（`android-fs-content`）は、別のオリジンから読んでよいという印（CORS のヘッダー）を付けないので、
//! audio 要素の音を Web Audio（AudioContext）に通すと、ブラウザの決まりで無音にされる。
//! このプロトコルは同じファイルを、範囲を指定した読み出し（Range）に応えて返し、CORS のヘッダーを付ける。
//! URL は `http://cm-media.localhost/<場所（FsUri の JSON）を URL エンコードしたもの>`（画面では convertFileSrc(場所, "cm-media")）

use std::io::{Read, Seek, SeekFrom};

/// 終わりを指定しない範囲（`bytes=100-`）のとき、1回に返す最大の大きさ。audio 要素は続きを改めて求める
const CHUNK: u64 = 2 * 1024 * 1024;

/// 返す範囲（始まりと終わり。終わりを含む）
#[derive(Debug, PartialEq)]
pub enum Span {
    /// 範囲の指定がない：全体を返す
    Whole,
    /// 範囲の指定がある：その部分を返す
    Part(u64, u64),
    /// 範囲がファイルの外
    Unsatisfiable,
}

/// Range ヘッダー（`bytes=a-b`・`bytes=a-`・`bytes=-n`。複数の範囲は最初の1つだけ）から、返す範囲を決める
pub fn span(range: Option<&str>, len: u64) -> Span {
    let Some(spec) = range.and_then(|r| r.trim().strip_prefix("bytes=")) else { return Span::Whole };
    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = first.split_once('-') else { return Span::Whole };
    let (a, b) = (a.trim(), b.trim());
    if len == 0 {
        return Span::Unsatisfiable;
    }
    let (start, end) = if a.is_empty() {
        // 終わりから n バイト
        let Ok(n) = b.parse::<u64>() else { return Span::Whole };
        if n == 0 {
            return Span::Unsatisfiable;
        }
        (len.saturating_sub(n), len - 1)
    } else {
        let Ok(start) = a.parse::<u64>() else { return Span::Whole };
        let end = if b.is_empty() {
            (start + CHUNK - 1).min(len - 1)
        } else {
            let Ok(end) = b.parse::<u64>() else { return Span::Whole };
            end.min(len - 1)
        };
        (start, end)
    };
    if start >= len || start > end {
        return Span::Unsatisfiable;
    }
    Span::Part(start, end)
}

/// URL のパス（先頭の `/` を除いたもの）の %XX を戻す
pub fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 拡張子から、返す種類（Content-Type）を決める
pub fn content_type(path: &str) -> &'static str {
    // 場所が JSON（FsUri）のときは、ファイルを指す uri の値から拡張子を取る（ほかの値にはフォルダのアドレスも入っている）
    let target = if path.starts_with('{') {
        serde_json::from_str::<serde_json::Value>(path)
            .ok()
            .and_then(|v| v.get("uri").and_then(|u| u.as_str()).map(str::to_string))
            .unwrap_or_default()
    } else {
        path.to_string()
    };
    let lower = target.to_ascii_lowercase();
    let name = lower.rsplit(['/', '\\']).next().unwrap_or("");
    let ext = if name.contains('.') { name.rsplit('.').next().unwrap_or("") } else { "" };
    match ext {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/ogg",
        "m4a" | "mp4" | "aac" => "audio/mp4",
        _ => "application/octet-stream",
    }
}

/// ファイルから、範囲を読んで応答を作る
pub fn respond<F: Read + Seek>(mut file: F, range: Option<&str>, kind: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let base = || {
        Response::builder()
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCEPT_RANGES, "bytes")
    };
    let error = |status: StatusCode| base().status(status).body(Vec::new()).unwrap_or_default();
    let Ok(len) = file.seek(SeekFrom::End(0)) else { return error(StatusCode::INTERNAL_SERVER_ERROR) };
    let (start, end, partial) = match span(range, len) {
        Span::Whole => (0, len.saturating_sub(1), false),
        Span::Part(s, e) => (s, e, true),
        Span::Unsatisfiable => {
            return base()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Vec::new())
                .unwrap_or_default()
        }
    };
    let size = if len == 0 { 0 } else { end - start + 1 };
    let mut body = vec![0u8; size as usize];
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut body).is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let builder = base().header(header::CONTENT_TYPE, kind).header(header::CONTENT_LENGTH, size);
    let builder = if partial {
        builder.status(StatusCode::PARTIAL_CONTENT).header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
    } else {
        builder.status(StatusCode::OK)
    };
    builder.body(body).unwrap_or_default()
}

/// プロトコルの処理（Android）。ファイルを開くのは時間がかかることがあるので、別のスレッドで行う
#[cfg(target_os = "android")]
pub fn protocol<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    use tauri::http::{header, Response, StatusCode};
    std::thread::spawn(move || {
        let path = request.uri().path().trim_start_matches('/');
        let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
        let response = match percent_decode(path).filter(|p| p.starts_with('{')) {
            Some(location) => match crate::saf::open(&location) {
                Ok(file) => respond(file, range.as_deref(), content_type(&location)),
                Err(_) => Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(Vec::new())
                    .unwrap_or_default(),
            },
            None => Response::builder().status(StatusCode::BAD_REQUEST).body(Vec::new()).unwrap_or_default(),
        };
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn 範囲の指定を読む() {
        assert_eq!(span(None, 100), Span::Whole);
        assert_eq!(span(Some("bytes=0-9"), 100), Span::Part(0, 9));
        assert_eq!(span(Some("bytes=90-200"), 100), Span::Part(90, 99));
        assert_eq!(span(Some("bytes=-10"), 100), Span::Part(90, 99));
        assert_eq!(span(Some("bytes=50-"), 100), Span::Part(50, 99));
        assert_eq!(span(Some("bytes=0-"), CHUNK * 3), Span::Part(0, CHUNK - 1));
        assert_eq!(span(Some("bytes=100-"), 100), Span::Unsatisfiable);
        assert_eq!(span(Some("bytes=0-1, 5-6"), 100), Span::Part(0, 1));
        assert_eq!(span(Some("items=0-1"), 100), Span::Whole);
    }

    #[test]
    fn 場所の_url_エンコードを戻す() {
        assert_eq!(percent_decode("%7B%22uri%22%3A%22a%2Fb%22%7D").as_deref(), Some("{\"uri\":\"a/b\"}"));
        assert_eq!(percent_decode("%E6%9B%B2.mp3").as_deref(), Some("曲.mp3"));
        assert_eq!(percent_decode("%Z1"), None);
    }

    #[test]
    fn 種類を拡張子で決める() {
        assert_eq!(
            content_type("{\"uri\":\"content://x/document/primary%3AMusic%2Fa.MP3\",\"documentTopTreeUri\":\"content://com.android.externalstorage.documents/tree/x\"}"),
            "audio/mpeg"
        );
        assert_eq!(content_type("a.flac"), "audio/flac");
        assert_eq!(content_type("a.xyz"), "application/octet-stream");
    }

    #[test]
    fn 範囲を読んで返す() {
        let data: Vec<u8> = (0..100).collect();
        let r = respond(Cursor::new(data.clone()), Some("bytes=10-19"), "audio/wav");
        assert_eq!(r.status(), 206);
        assert_eq!(r.body(), &data[10..20]);
        assert_eq!(r.headers()["content-range"], "bytes 10-19/100");
        assert_eq!(r.headers()["access-control-allow-origin"], "*");
        let r = respond(Cursor::new(data.clone()), None, "audio/wav");
        assert_eq!(r.status(), 200);
        assert_eq!(r.body().len(), 100);
        let r = respond(Cursor::new(data), Some("bytes=200-"), "audio/wav");
        assert_eq!(r.status(), 416);
    }
}
