use anyhow::{Result, bail};
use std::time::Duration;
use tokio::{io::AsyncReadExt, process::Command};
pub async fn run(kind: &str, unit: Option<&str>) -> Result<String> {
    if kind == "processes" {
        return Ok(tokio::task::spawn_blocking(crate::collectors::processes).await?);
    }
    let mut command = match kind {
        "services" => {
            let mut c = Command::new("/usr/bin/systemctl");
            c.args([
                "list-units",
                "--type=service",
                "--all",
                "--no-pager",
                "--plain",
                "--no-legend",
            ]);
            c
        }
        "logs" => {
            let mut c = Command::new("/usr/bin/journalctl");
            c.args([
                "--no-pager",
                "--lines=100",
                "--output=short-iso",
                "--since=-1h",
            ]);
            if let Some(unit) = unit {
                if unit.len() > 128
                    || !unit.ends_with(".service")
                    || !unit
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_.@:-".contains(&b))
                {
                    bail!("Invalid unit");
                }
                c.args(["--unit", unit]);
            }
            c
        }
        _ => bail!("Unsupported diagnostic"),
    };
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("Missing stdout"))?;
    tokio::time::timeout(Duration::from_secs(8), async {
        let mut bytes = Vec::new();
        stdout.take(60000).read_to_end(&mut bytes).await?;
        if bytes.len() == 60000 {
            let _ = child.kill().await;
            bytes.extend_from_slice(b"\n[output truncated]");
        }
        let status = child.wait().await?;
        if !status.success() && bytes.is_empty() {
            bail!("Insufficient permission or command unavailable");
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await?
}
