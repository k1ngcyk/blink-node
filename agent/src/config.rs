use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
};
use url::Url;

#[derive(Debug, Deserialize, Clone)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub server_url: String,
    pub state_file: String,
    pub spool_file: String,
    pub terminal_enabled: bool,
    pub terminal_user: String,
    pub allow_root_terminal: bool,
    pub diagnostics_enabled: bool,
    pub proxy_enabled: bool,
    pub allow_insecure_localhost: bool,
    pub sample_seconds: u64,
    pub max_spool_samples: usize,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            state_file: "/var/lib/blink-agent/identity.json".into(),
            spool_file: "/var/lib/blink-agent/spool.json".into(),
            terminal_enabled: false,
            terminal_user: "blink-agent".into(),
            allow_root_terminal: false,
            diagnostics_enabled: true,
            proxy_enabled: true,
            allow_insecure_localhost: false,
            sample_seconds: 5,
            max_spool_samples: 720,
        }
    }
}
impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let c: Self = toml::from_str(&fs::read_to_string(path).context("Cannot read config")?)?;
        c.validate()?;
        Ok(c)
    }
    pub fn validate(&self) -> Result<()> {
        let url = Url::parse(&self.server_url)?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if url.scheme() != "https"
            && !(url.scheme() == "http" && local && self.allow_insecure_localhost)
        {
            bail!("HTTPS required; insecure mode is limited to explicitly configured localhost");
        }
        if url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            bail!("server_url must be an origin");
        }
        if !(5..=60).contains(&self.sample_seconds) || self.max_spool_samples > 17280 {
            bail!("Invalid sampling or spool limit");
        }
        if self.terminal_user.is_empty()
            || !self
                .terminal_user
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        {
            bail!("Invalid terminal user");
        }
        Ok(())
    }
    pub fn ws_url(&self, path: &str) -> Result<String> {
        let mut url = Url::parse(&self.server_url)?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|_| anyhow::anyhow!("Invalid scheme"))?;
        url.set_path(path);
        Ok(url.to_string())
    }
}
#[derive(Serialize, Deserialize, Clone)]
pub struct Identity {
    pub credential: String,
    pub node_id: Option<String>,
}
pub fn read_identity(path: &str) -> Result<Identity> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || meta.permissions().mode() & 0o077 != 0 {
        bail!("Identity file must be a regular private file (0600)");
    }
    let id: Identity = serde_json::from_slice(&fs::read(path)?)?;
    if id.credential.len() != 43
        || !id
            .credential
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        bail!("Invalid credential");
    }
    Ok(id)
}
pub fn atomic_private(path: &str, data: &[u8]) -> Result<()> {
    let path = Path::new(path);
    let parent = path.parent().context("Missing parent directory")?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".blink-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        f.write_all(data)?;
        f.sync_all()?;
        fs::rename(&temp, path)?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_insecure_public_master() {
        let c = Config {
            server_url: "http://example.com".into(),
            allow_insecure_localhost: true,
            ..Default::default()
        };
        assert!(c.validate().is_err());
    }
    #[test]
    fn rejects_url_credentials_and_paths() {
        for s in [
            "https://u:p@host/",
            "https://host/path",
            "https://host/?x=y",
        ] {
            assert!(
                Config {
                    server_url: s.into(),
                    ..Default::default()
                }
                .validate()
                .is_err()
            );
        }
    }
}
