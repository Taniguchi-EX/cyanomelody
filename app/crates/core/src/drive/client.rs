//! Drive API の呼び出し。

use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use super::{DriveError, FOLDER_MIME, TokenProvider};

const DEFAULT_BASE: &str = "https://www.googleapis.com";

/// Drive のファイルやフォルダ。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    /// Drive は大きさを文字列で返す。フォルダにはない
    #[serde(default, deserialize_with = "size_from_str")]
    pub size: Option<u64>,
    pub modified_time: Option<String>,
}

impl DriveFile {
    pub fn is_folder(&self) -> bool {
        self.mime_type == FOLDER_MIME
    }
}

fn size_from_str<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    let s: Option<String> = Option::deserialize(d)?;
    Ok(s.and_then(|s| s.parse().ok()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileList {
    #[serde(default)]
    files: Vec<DriveFile>,
    next_page_token: Option<String>,
}

const FILE_FIELDS: &str = "id,name,mimeType,size,modifiedTime";

/// Drive API の呼び出し口。接続を使い回すため、複製して共有する。
#[derive(Clone)]
pub struct DriveClient {
    agent: ureq::Agent,
    base: Arc<str>,
    tokens: Arc<dyn TokenProvider>,
}

impl DriveClient {
    pub fn new(tokens: Arc<dyn TokenProvider>) -> Self {
        Self::with_base(DEFAULT_BASE, tokens)
    }

    /// 呼び出し先を変える（テスト用）。
    pub fn with_base(base: &str, tokens: Arc<dyn TokenProvider>) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(30))
            .build();
        Self { agent, base: base.trim_end_matches('/').into(), tokens }
    }

    /// 呼び出す。Drive に拒否された（401）ときは、アクセストークンを更新して 1 回だけやり直す。
    fn send(
        &self,
        method: &str,
        path: &str,
        query: &[(&str, &str)],
        range: Option<(u64, u64)>,
        body: Option<(&str, &[u8])>,
    ) -> Result<ureq::Response, DriveError> {
        for attempt in 0..2 {
            let token = self.tokens.access_token()?;
            let mut req = self
                .agent
                .request(method, &format!("{}{path}", self.base))
                .set("Authorization", &format!("Bearer {token}"));
            for (k, v) in query {
                req = req.query(k, v);
            }
            if let Some((start, end)) = range {
                req = req.set("Range", &format!("bytes={start}-{end}"));
            }
            let result = match body {
                Some((content_type, bytes)) => req.set("Content-Type", content_type).send_bytes(bytes),
                None => req.call(),
            };
            match result {
                Ok(resp) => return Ok(resp),
                Err(ureq::Error::Status(401, _)) if attempt == 0 => {
                    log::info!("アクセストークンが拒否されたため更新する");
                    self.tokens.invalidate();
                }
                Err(e) => return Err(http_error(e)),
            }
        }
        Err(DriveError::Auth("アクセストークンを更新しても拒否された".into()))
    }

    fn get(
        &self,
        path: &str,
        query: &[(&str, &str)],
        range: Option<(u64, u64)>,
    ) -> Result<ureq::Response, DriveError> {
        self.send("GET", path, query, range, None)
    }

    fn json_response<T: serde::de::DeserializeOwned>(resp: ureq::Response) -> Result<T, DriveError> {
        resp.into_json().map_err(|e| DriveError::Parse(e.to_string()))
    }

    /// フォルダを作る。
    pub fn create_folder(&self, parent_id: &str, name: &str) -> Result<DriveFile, DriveError> {
        let meta = serde_json::json!({ "name": name, "mimeType": FOLDER_MIME, "parents": [parent_id] });
        let body = meta.to_string();
        let resp = self.send(
            "POST",
            "/drive/v3/files",
            &[("fields", FILE_FIELDS)],
            None,
            Some(("application/json; charset=UTF-8", body.as_bytes())),
        )?;
        Self::json_response(resp)
    }

    /// フォルダの中にファイルを作る（中身ごと）。
    pub fn create_file(
        &self,
        parent_id: &str,
        name: &str,
        mime: &str,
        content: &[u8],
    ) -> Result<DriveFile, DriveError> {
        let boundary = "cyanomelody-boundary-7c1f";
        let meta = serde_json::json!({ "name": name, "mimeType": mime, "parents": [parent_id] });
        let mut body = Vec::new();
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n")
                .as_bytes(),
        );
        body.extend_from_slice(content);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let content_type = format!("multipart/related; boundary={boundary}");
        let resp = self.send(
            "POST",
            "/upload/drive/v3/files",
            &[("uploadType", "multipart"), ("fields", FILE_FIELDS)],
            None,
            Some((&content_type, &body)),
        )?;
        Self::json_response(resp)
    }

    /// ファイルの中身を置き換える。
    pub fn update_file(&self, id: &str, mime: &str, content: &[u8]) -> Result<DriveFile, DriveError> {
        let resp = self.send(
            "PATCH",
            &format!("/upload/drive/v3/files/{id}"),
            &[("uploadType", "media"), ("fields", FILE_FIELDS)],
            None,
            Some((mime, content)),
        )?;
        Self::json_response(resp)
    }

    /// ファイルの中身をすべて取得する。
    pub fn download(&self, id: &str) -> Result<Vec<u8>, DriveError> {
        let resp = self.get(&format!("/drive/v3/files/{id}"), &[("alt", "media")], None)?;
        let mut buf = Vec::new();
        resp.into_reader().read_to_end(&mut buf).map_err(|e| DriveError::Network(e.to_string()))?;
        Ok(buf)
    }

    /// ファイルをゴミ箱に移す（Drive のゴミ箱から戻せる）。
    pub fn trash(&self, id: &str) -> Result<(), DriveError> {
        let body = serde_json::json!({ "trashed": true }).to_string();
        self.send(
            "PATCH",
            &format!("/drive/v3/files/{id}"),
            &[("fields", "id")],
            None,
            Some(("application/json; charset=UTF-8", body.as_bytes())),
        )?;
        Ok(())
    }

    /// フォルダの直下の、名前が `name` のファイル（フォルダは除く）。
    pub fn find_file(&self, parent_id: &str, name: &str) -> Result<Option<DriveFile>, DriveError> {
        let q = format!(
            "'{}' in parents and name = '{}' and mimeType != '{FOLDER_MIME}' and trashed = false",
            escape(parent_id),
            escape(name)
        );
        Ok(self.search(&q)?.into_iter().next())
    }

    fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T, DriveError> {
        self.get(path, query, None)?.into_json().map_err(|e| DriveError::Parse(e.to_string()))
    }

    /// ログインしているアカウントのメールアドレス。通信できるかの確認にも使う
    /// （通信できなければ `DriveError::Network`）。
    pub fn account_email(&self) -> Result<String, DriveError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct About {
            user: User,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct User {
            email_address: String,
        }
        let about: About = self.get_json("/drive/v3/about", &[("fields", "user(emailAddress)")])?;
        Ok(about.user.email_address)
    }

    /// ファイルやフォルダの情報。
    pub fn file(&self, id: &str) -> Result<DriveFile, DriveError> {
        self.get_json(&format!("/drive/v3/files/{id}"), &[("fields", FILE_FIELDS)])
    }

    /// `query`（Drive の検索式）に合うものをすべて返す。
    fn search(&self, query: &str) -> Result<Vec<DriveFile>, DriveError> {
        let fields = format!("nextPageToken,files({FILE_FIELDS})");
        let mut out = Vec::new();
        let mut page = String::new();
        loop {
            let mut params = vec![("q", query), ("fields", fields.as_str()), ("pageSize", "1000")];
            if !page.is_empty() {
                params.push(("pageToken", page.as_str()));
            }
            let list: FileList = self.get_json("/drive/v3/files", &params)?;
            out.extend(list.files);
            match list.next_page_token {
                Some(token) => page = token,
                None => return Ok(out),
            }
        }
    }

    /// フォルダの直下のファイルとフォルダ（ゴミ箱のものは除く）。
    pub fn list_children(&self, folder_id: &str) -> Result<Vec<DriveFile>, DriveError> {
        self.search(&format!("'{}' in parents and trashed = false", escape(folder_id)))
    }

    /// フォルダの直下の、名前が `name` のフォルダ。
    pub fn find_folder(&self, parent_id: &str, name: &str) -> Result<Option<DriveFile>, DriveError> {
        let q = format!(
            "'{}' in parents and name = '{}' and mimeType = '{FOLDER_MIME}' and trashed = false",
            escape(parent_id),
            escape(name)
        );
        Ok(self.search(&q)?.into_iter().next())
    }

    /// マイドライブからのパス（`music/cyanomelody_test` のように `/` 区切り）でフォルダの ID を得る。
    pub fn folder_by_path(&self, path: &str) -> Result<String, DriveError> {
        let mut id = "root".to_string();
        for name in path.split('/').filter(|s| !s.is_empty()) {
            id = self
                .find_folder(&id, name)?
                .ok_or_else(|| DriveError::NotFound(format!("フォルダ {path} の {name}")))?
                .id;
        }
        Ok(id)
    }

    /// ファイルの `start` から `end`（含む）までのバイトを取得する。
    pub fn read_range(&self, id: &str, start: u64, end: u64) -> Result<Vec<u8>, DriveError> {
        let resp = self.get(&format!("/drive/v3/files/{id}"), &[("alt", "media")], Some((start, end)))?;
        if resp.status() != 206 && resp.status() != 200 {
            return Err(DriveError::Http {
                status: resp.status(), message: "部分取得できない".into()
            });
        }
        let mut buf = Vec::with_capacity((end - start + 1) as usize);
        resp.into_reader().read_to_end(&mut buf).map_err(|e| DriveError::Network(e.to_string()))?;
        Ok(buf)
    }
}

/// Drive の検索式の文字列の中で、`'` と `\` を逃がす。
fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

fn http_error(e: ureq::Error) -> DriveError {
    match e {
        ureq::Error::Status(401, _) => DriveError::Auth("Google Drive に拒否された".into()),
        ureq::Error::Status(404, resp) => DriveError::NotFound(resp.into_string().unwrap_or_default()),
        ureq::Error::Status(status, resp) => {
            DriveError::Http { status, message: resp.into_string().unwrap_or_default() }
        }
        ureq::Error::Transport(t) => DriveError::Network(t.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drive::StaticToken;
    use crate::drive::mock::MockDrive;

    fn client(mock: &MockDrive) -> DriveClient {
        DriveClient::with_base(&mock.base_url(), Arc::new(StaticToken("token".into())))
    }

    #[test]
    fn lists_children_across_pages_and_finds_folders_by_path() {
        let mock = MockDrive::start();
        let music = mock.add_folder("root", "music");
        let test = mock.add_folder(&music, "cyanomelody_test");
        for i in 0..5 {
            mock.add_file(&test, &format!("{i}.mp3"), vec![0; 10]);
        }
        mock.set_page_size(2);
        let c = client(&mock);
        assert_eq!(c.folder_by_path("music/cyanomelody_test").unwrap(), test);
        let children = c.list_children(&test).unwrap();
        assert_eq!(children.len(), 5, "ページをまたいで全部取る");
        assert_eq!(children[0].size, Some(10));
        assert!(matches!(c.folder_by_path("music/ない"), Err(DriveError::NotFound(_))));
    }

    #[test]
    fn creates_updates_downloads_and_trashes_files() {
        let mock = MockDrive::start();
        let c = client(&mock);
        let folder = c.create_folder("root", "cyanomelody").unwrap();
        assert!(folder.is_folder());
        assert_eq!(c.find_folder("root", "cyanomelody").unwrap().unwrap().id, folder.id);
        let file =
            c.create_file(&folder.id, "a.json", "application/json", "{\"名前\":1}".as_bytes()).unwrap();
        assert_eq!(c.download(&file.id).unwrap(), "{\"名前\":1}".as_bytes());
        c.update_file(&file.id, "application/json", b"{}").unwrap();
        assert_eq!(c.download(&file.id).unwrap(), b"{}");
        assert_eq!(c.find_file(&folder.id, "a.json").unwrap().unwrap().id, file.id);
        c.trash(&file.id).unwrap();
        assert!(c.find_file(&folder.id, "a.json").unwrap().is_none(), "ゴミ箱のものは見えない");
    }

    #[test]
    fn reads_ranges() {
        let mock = MockDrive::start();
        let id = mock.add_file("root", "a.wav", (0..=255u8).collect());
        let c = client(&mock);
        assert_eq!(c.read_range(&id, 10, 13).unwrap(), vec![10, 11, 12, 13]);
        assert_eq!(c.file(&id).unwrap().size, Some(256));
    }

    #[test]
    fn retries_once_after_401_and_maps_network_errors() {
        let mock = MockDrive::start();
        let id = mock.add_file("root", "a.wav", vec![1, 2, 3]);
        mock.reject_next_requests(1);
        let c = client(&mock);
        assert_eq!(c.read_range(&id, 0, 2).unwrap(), vec![1, 2, 3], "1 回拒否されても、やり直して読める");
        let offline = DriveClient::with_base("http://127.0.0.1:9", Arc::new(StaticToken("t".into())));
        assert!(offline.list_children("root").unwrap_err().is_offline());
        assert!(offline.account_email().unwrap_err().is_offline());
        assert_eq!(c.account_email().unwrap(), "test@example.com");
    }
}
