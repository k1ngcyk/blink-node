use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, LazyLock},
    time::{Duration, Instant},
};
use tokio::{net::TcpStream, process::Command};
use url::Url;
use x509_parser::prelude::FromDer;

static DENIED: LazyLock<Vec<ipnet::IpNet>> = LazyLock::new(|| {
    [
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
        "2001::/23",
        "2001:db8::/32",
        "2002::/16",
        "3fff::/20",
    ]
    .iter()
    .map(|n| n.parse().expect("network constant"))
    .collect()
});
pub fn is_public(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V6(v) => v.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        _ => ip,
    };
    if let IpAddr::V6(v) = ip
        && v.segments()[0] & 0xe000 != 0x2000
    {
        return false;
    }
    !DENIED.iter().any(|n| n.contains(&ip))
}
async fn resolve(host: &str, port: u16) -> Result<SocketAddr> {
    let host = host.trim_matches(['[', ']']);
    let list: Vec<_> = tokio::net::lookup_host((host, port)).await?.collect();
    if list.is_empty() || list.iter().any(|a| !is_public(a.ip())) {
        bail!("Private and special-use targets are disabled");
    }
    Ok(list[0])
}
fn target_url(kind: &str, target: &str) -> Result<Url> {
    let u = Url::parse(&if kind == "http" {
        target.into()
    } else {
        format!(
            "{}://{target}",
            if kind == "tls" { "https" } else { "http" }
        )
    })?;
    if !matches!(u.scheme(), "http" | "https")
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || u.host_str().is_none()
    {
        bail!("Invalid target");
    }
    Ok(u)
}
pub async fn run(id: &str, kind: &str, target: &str) -> Value {
    let start = Instant::now();
    let mut r = json!({"id":id,"at":crate::collectors::now(),"ok":false,"latencyMs":null,"loss":null,"status":null,"certificateDays":null,"error":null});
    let inner = async {
        if kind == "icmp" {
            if target.starts_with('-') || target.len() > 256 {
                bail!("Invalid ICMP host");
            }
            let address = resolve(target, 0).await?;
            let mut cmd = Command::new("ping");
            cmd.args(["-n", "-c", "3", "-W", "2", &address.ip().to_string()])
                .env_clear()
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                .env("LANG", "C")
                .kill_on_drop(true);
            let output = cmd.output().await?;
            let text = String::from_utf8_lossy(&output.stdout);
            let loss = text
                .split('%')
                .next()
                .and_then(|s| s.split_whitespace().last())
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(100.0)
                .clamp(0.0, 100.0);
            r["loss"] = json!(loss);
            r["ok"] = json!(loss < 100.0);
            for line in text.lines() {
                if let Some((_, stats)) = line.split_once(" = ")
                    && let Some(avg) = stats.split('/').nth(1).and_then(|s| s.parse::<f64>().ok())
                {
                    r["latencyMs"] = json!(avg);
                }
            }
        } else {
            let u = target_url(kind, target)?;
            let host = u.host_str().context("Missing host")?;
            let address = resolve(host, u.port_or_known_default().unwrap_or(80)).await?;
            if kind == "http" {
                let client = reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(8))
                    .resolve(host, address)
                    .tls_info(true)
                    .build()?;
                let response = client
                    .get(u)
                    .header("User-Agent", "BlinkNode/0.1")
                    .send()
                    .await?;
                r["ok"] =
                    json!(response.status().as_u16() >= 200 && response.status().as_u16() < 400);
                r["status"] = json!(response.status().as_u16());
                if let Some(cert) = response
                    .extensions()
                    .get::<reqwest::tls::TlsInfo>()
                    .and_then(|i| i.peer_certificate())
                {
                    r["certificateDays"] = certificate_days(cert);
                }
            } else if kind == "tcp" {
                let stream = TcpStream::connect(address).await?;
                drop(stream);
                r["ok"] = json!(true);
            } else if kind == "tls" {
                let roots = rustls::RootCertStore::from_iter(
                    webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
                );
                let config = rustls::ClientConfig::builder()
                    .with_root_certificates(roots)
                    .with_no_client_auth();
                let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
                let server_name = rustls::pki_types::ServerName::try_from(
                    host.trim_matches(['[', ']']).to_string(),
                )?;
                let stream = connector
                    .connect(server_name, TcpStream::connect(address).await?)
                    .await?;
                if let Some(cert) = stream
                    .get_ref()
                    .1
                    .peer_certificates()
                    .and_then(|c| c.first())
                {
                    r["certificateDays"] = certificate_days(cert.as_ref());
                }
                r["ok"] = json!(true);
            } else {
                bail!("Unsupported check");
            }
            r["latencyMs"] = json!(start.elapsed().as_secs_f64() * 1000.0);
        }
        Ok::<(), anyhow::Error>(())
    };
    match tokio::time::timeout(Duration::from_secs(10), inner).await {
        Ok(Ok(())) => {
            if r["ok"] == false {
                r["error"] = json!("检查未通过");
            }
        }
        _ => {
            r["ok"] = json!(false);
            r["error"] = json!("连接失败、超时或目标地址不受允许");
        }
    }
    r
}
fn certificate_days(der: &[u8]) -> Value {
    x509_parser::certificate::X509Certificate::from_der(der)
        .ok()
        .map(|(_, c)| {
            json!(
                (c.validity().not_after.timestamp()
                    - time::OffsetDateTime::now_utc().unix_timestamp()) as f64
                    / 86400.0
            )
        })
        .unwrap_or(Value::Null)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_metadata_private_and_mapped_addresses() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "100.100.100.200",
            "::1",
            "::ffff:127.0.0.1",
            "fe80::1",
            "2001:db8::1",
            "224.0.0.1",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
    }
}
