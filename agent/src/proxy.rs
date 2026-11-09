use anyhow::{Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};

const SOCKET: &str = "/run/blink-proxy/control.sock";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub v: u8,
    #[serde(rename = "type")]
    pub kind: String,
    pub task_id: String,
    pub resource_id: String,
    pub desired_version: u32,
    pub deadline: String,
    pub operation: String,
    pub payload: Value,
}
pub fn available() -> bool {
    std::path::Path::new(SOCKET).exists()
}
pub async fn status() -> Option<Value> {
    let content = tokio::fs::read("/run/blink-proxy/status.json").await.ok()?;
    if content.len() > 220000 {
        return None;
    }
    let value: Value = serde_json::from_slice(&content).ok()?;
    Some(json!({"v":1,"type":"proxy.status","status":value}))
}
pub async fn run(message: Value, node_id: &str) -> Result<Value> {
    let task: Task = serde_json::from_value(message.clone())?;
    uuid::Uuid::parse_str(&task.task_id)?;
    uuid::Uuid::parse_str(&task.resource_id)?;
    if task.v != 1
        || task.kind != "proxy.run"
        || task.resource_id != node_id
        || !matches!(task.operation.as_str(), "scan" | "apply" | "firewall")
        || !task.payload.is_object()
    {
        bail!("Invalid proxy task");
    }
    let deadline = time::OffsetDateTime::parse(
        &task.deadline,
        &time::format_description::well_known::Rfc3339,
    )?;
    if deadline <= time::OffsetDateTime::now_utc() {
        bail!("Expired proxy task");
    }
    let bytes = serde_json::to_vec(&message)?;
    if bytes.len() > 220000 {
        bail!("Proxy task too large");
    }
    let outcome = tokio::time::timeout(Duration::from_secs(1200), async {
        let mut socket = UnixStream::connect(SOCKET).await?;
        socket.write_all(&bytes).await?;
        socket.shutdown().await?;
        let mut result = Vec::new();
        socket.take(220001).read_to_end(&mut result).await?;
        if result.len() > 220000 {
            bail!("Proxy result too large");
        }
        Ok::<Value, anyhow::Error>(serde_json::from_slice(&result)?)
    })
    .await;
    // A disconnected socket is not proof of deployment failure. Redelivery asks
    // the durable helper ledger for the final result using the same task ID.
    let result = outcome??;
    Ok(
        json!({"v":1,"type":"proxy.result","taskId":task.task_id,"desiredVersion":task.desired_version,
        "ok": result["ok"].as_bool().unwrap_or(false), "result": result["result"]}),
    )
}
