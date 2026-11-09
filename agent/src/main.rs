mod checks;
mod collectors;
mod config;
mod diagnostics;
mod terminal;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use collectors::{Collector, Metric};
use config::{Config, Identity, atomic_private, read_identity};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, Semaphore, mpsc, oneshot};
use tokio_tungstenite::tungstenite::{
    Message, client::IntoClientRequest, protocol::WebSocketConfig,
};

#[derive(Parser)]
#[command(version, about = "Blink Node secure host agent")]
struct Cli {
    #[arg(long, default_value = "/etc/blink-agent/config.toml", global = true)]
    config: PathBuf,
    #[command(subcommand)]
    command: Action,
}
#[derive(Subcommand)]
enum Action {
    /// Enroll with a short-lived token read from a private file, never a command-line value.
    Enroll {
        #[arg(long)]
        token_file: PathBuf,
    },
    /// Run collectors and the authenticated control connection.
    Run,
    /// Collect and print one local sample without connecting.
    Inspect,
}
fn new_credential() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    const B: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let mut bits = 0u32;
    let mut acc = 0u32;
    for byte in bytes {
        acc = (acc << 8) | byte as u32;
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            out.push(B[((acc >> bits) & 63) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B[((acc << (6 - bits)) & 63) as usize] as char);
    }
    out
}
#[tokio::main]
async fn main() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .json()
        .init();
    let cli = Cli::parse();
    if matches!(cli.command, Action::Inspect) {
        let mut c = Collector::new();
        tokio::time::sleep(Duration::from_millis(500)).await;
        println!("{}", serde_json::to_string_pretty(&c.collect())?);
        return Ok(());
    }
    let config = Config::load(&cli.config)?;
    match cli.command {
        Action::Enroll { token_file } => enroll(&config, &token_file).await?,
        Action::Run => run(config).await?,
        Action::Inspect => {}
    }
    Ok(())
}
async fn enroll(config: &Config, token_file: &std::path::Path) -> Result<()> {
    let enrollment = std::fs::read_to_string(token_file)?.trim().to_string();
    if enrollment.len() != 43
        || !enrollment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        bail!("Invalid enrollment token");
    }
    let mut identity = if std::path::Path::new(&config.state_file).exists() {
        read_identity(&config.state_file)?
    } else {
        let id = Identity {
            credential: new_credential(),
            node_id: None,
        };
        atomic_private(&config.state_file, &serde_json::to_vec(&id)?)?;
        id
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()?;
    let response = client
        .post(format!(
            "{}/agent/enroll",
            config.server_url.trim_end_matches('/')
        ))
        .json(&json!({"token":enrollment,"credential":identity.credential}))
        .send()
        .await?;
    if !response.status().is_success() {
        bail!("Enrollment rejected (HTTP {})", response.status().as_u16());
    }
    let response: Value = response.json().await?;
    let id = response["id"].as_str().context("Missing node id")?;
    uuid::Uuid::parse_str(id)?;
    identity.node_id = Some(id.into());
    atomic_private(&config.state_file, &serde_json::to_vec(&identity)?)?;
    tracing::info!(
        node_id = id,
        "Enrollment complete; delete the enrollment token file"
    );
    Ok(())
}
type Spool = Arc<Mutex<VecDeque<Metric>>>;
async fn run(config: Config) -> Result<()> {
    let identity = read_identity(&config.state_file)?;
    if identity.node_id.is_none() {
        bail!("Enroll this agent first");
    }
    if config.terminal_enabled && !terminal::allowed(&config) {
        bail!("Terminal enabled but requested Unix user is not permitted");
    }
    let mut collector = Collector::new();
    let info = collector.info(terminal::allowed(&config), config.diagnostics_enabled);
    let restored = std::fs::read(&config.spool_file)
        .ok()
        .filter(|b| b.len() < 64 * 1024 * 1024)
        .and_then(|b| serde_json::from_slice::<VecDeque<Metric>>(&b).ok())
        .unwrap_or_default();
    let spool: Spool = Arc::new(Mutex::new(
        restored
            .into_iter()
            .rev()
            .take(config.max_spool_samples)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect(),
    ));
    let sample_spool = spool.clone();
    let sample_config = config.clone();
    let sample_task = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(sample_config.sample_seconds));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        tick.tick().await;
        let mut ticks = 0;
        loop {
            tick.tick().await;
            let metric = collector.collect();
            let mut q = sample_spool.lock().await;
            q.push_back(metric);
            while q.len() > sample_config.max_spool_samples {
                q.pop_front();
            }
            ticks += 1;
            if ticks % 6 == 0
                && let Ok(bytes) = serde_json::to_vec(&*q)
            {
                let path = sample_config.spool_file.clone();
                drop(q);
                let _ = tokio::task::spawn_blocking(move || atomic_private(&path, &bytes)).await;
            }
        }
    });
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut failures = 0u32;
    loop {
        let started = std::time::Instant::now();
        let session = connect(&config, &identity, &info, spool.clone());
        tokio::select! {
            _=tokio::signal::ctrl_c()=>break,
            _=terminate.recv()=>break,
            result=session=>{if result.is_err(){tracing::warn!("Control connection lost; retrying");}}
        }
        failures = if started.elapsed() > Duration::from_secs(60) {
            0
        } else {
            (failures + 1).min(6)
        };
        let delay =
            Duration::from_millis((1000u64 << failures).min(60000) + rand::random::<u64>() % 1000);
        tokio::select! {_=tokio::time::sleep(delay)=>{},_=tokio::signal::ctrl_c()=>break,_=terminate.recv()=>break}
    }
    sample_task.abort();
    let _ = sample_task.await;
    atomic_private(
        &config.spool_file,
        &serde_json::to_vec(&*spool.lock().await)?,
    )?;
    Ok(())
}
struct Terminals(HashMap<String, oneshot::Sender<()>>);
impl Drop for Terminals {
    fn drop(&mut self) {
        for (_, tx) in self.0.drain() {
            let _ = tx.send(());
        }
    }
}
async fn connect(config: &Config, identity: &Identity, info: &Value, spool: Spool) -> Result<()> {
    let mut request = config.ws_url("/ws/agent")?.into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", identity.credential).parse()?,
    );
    let settings = WebSocketConfig::default()
        .max_message_size(Some(65536))
        .max_frame_size(Some(65536))
        .max_write_buffer_size(1024 * 1024);
    let (ws, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async_with_config(request, Some(settings), true),
    )
    .await??;
    let (mut sink, mut stream) = ws.split();
    sink.send(Message::Text(
        json!({"v":1,"type":"hello","info":info}).to_string().into(),
    ))
    .await?;
    let (out_tx, mut out_rx) = mpsc::channel::<Value>(32);
    let (done_tx, mut done_rx) = mpsc::channel::<String>(8);
    let semaphore = Arc::new(Semaphore::new(4));
    let mut terminals = Terminals(HashMap::new());
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut awaiting: Option<(String, u64, std::time::Instant)> = None;
    let mut welcome = false;
    let mut last_message = std::time::Instant::now();
    loop {
        tokio::select! {
            _=tick.tick()=>{
                if last_message.elapsed()>Duration::from_secs(50){bail!("Heartbeat timeout");}
                if awaiting.as_ref().is_some_and(|(_,_,at)|at.elapsed()>Duration::from_secs(20)){bail!("Metrics acknowledgement timeout");}
                if welcome && awaiting.is_none(){
                    let q=spool.lock().await;let mut batch=Vec::new();let mut bytes=0usize;
                    for sample in q.iter().take(10){let size=serde_json::to_vec(sample)?.len();if !batch.is_empty() && bytes+size>220000{break;}bytes+=size;batch.push(sample.clone());}drop(q);
                    if let Some(last)=batch.last(){awaiting=Some((last.boot_id.clone(),last.seq,std::time::Instant::now()));tokio::time::timeout(Duration::from_secs(5),sink.send(Message::Text(json!({"v":1,"type":"metrics","samples":batch}).to_string().into()))).await??;}
                }
            },
            Some(id)=done_rx.recv()=>{terminals.0.remove(&id);},
            Some(message)=out_rx.recv()=>{tokio::time::timeout(Duration::from_secs(5),sink.send(Message::Text(message.to_string().into()))).await??;},
            msg=stream.next()=>{
                let Some(msg)=msg else{break};last_message=std::time::Instant::now();
                match msg? {
                    Message::Ping(p)=>sink.send(Message::Pong(p)).await?,
                    Message::Pong(_)=>{},
                    Message::Close(_)=>break,
                    Message::Text(text)=>{
                        let m:Value=serde_json::from_str(&text)?;
                        if m["v"]!=1{bail!("Unsupported protocol");}
                        match m["type"].as_str(){
                            Some("welcome")=>{welcome=true;tracing::info!("Connected to master");},
                            Some("metrics.ack")=>{
                                if let Some((boot,seq,_))=&awaiting && m["bootId"]==*boot && m["seq"].as_u64()==Some(*seq){let mut q=spool.lock().await;let pos=q.iter().position(|s|s.boot_id==*boot&&s.seq==*seq);if let Some(pos)=pos{q.drain(..=pos);}awaiting=None;}
                            },
                            Some("terminal.open")=>{
                                if !terminal::allowed(config)||terminals.0.len()>=4{continue;}
                                let id=m["id"].as_str().context("Missing id")?.to_string();uuid::Uuid::parse_str(&id)?;
                                if terminals.0.contains_key(&id){continue;}
                                let stream=m["streamToken"].as_str().context("Missing stream token")?.to_string();if stream.len()!=43{bail!("Invalid stream token");}
                                let (tx,rx)=oneshot::channel();terminals.0.insert(id.clone(),tx);
                                let c=config.clone();let i=identity.clone();let done=done_tx.clone();
                                tokio::spawn(async move{if terminal::run(c,i,stream,rx).await.is_err(){tracing::warn!("Terminal session ended with error");}let _=done.send(id).await;});
                            },
                            Some("terminal.close")=>{if let Some(id)=m["id"].as_str() && let Some(tx)=terminals.0.remove(id){let _=tx.send(());}},
                            Some("check.run")|Some("diagnostic.run")=>{
                                let id=m["id"].as_str().context("Missing task id")?.to_string();uuid::Uuid::parse_str(&id)?;
                                let kind=m["kind"].as_str().context("Missing task kind")?.to_string();let tx=out_tx.clone();
                                let permit=semaphore.clone().try_acquire_owned();
                                if m["type"]=="check.run" {
                                    let target=m["target"].as_str().context("Missing target")?.to_string();if target.len()>2048{bail!("Target too long");}
                                    tokio::spawn(async move{let result=if let Ok(_permit)=permit{checks::run(&id,&kind,&target).await}else{json!({"id":id,"at":collectors::now(),"ok":false,"latencyMs":null,"loss":null,"status":null,"certificateDays":null,"error":"Agent check capacity reached"})};let _=tx.send(json!({"v":1,"type":"check.result","result":result})).await;});
                                } else {
                                    let enabled=config.diagnostics_enabled;let unit=m["unit"].as_str().map(str::to_string);
                                    tokio::spawn(async move{let result=if let Ok(_permit)=permit{if enabled{diagnostics::run(&kind,unit.as_deref()).await}else{Err(anyhow::anyhow!("Diagnostics disabled"))}}else{Err(anyhow::anyhow!("Agent busy"))};let ok=result.is_ok();let text=result.unwrap_or_else(|_|"诊断不可用、无权限或执行超时".into());let _=tx.send(json!({"v":1,"type":"diagnostic.result","id":id,"ok":ok,"result":text})).await;});
                                }
                            },
                            _=>bail!("Unsupported control message"),
                        }
                    },
                    _=>bail!("Unexpected binary message"),
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_have_full_entropy_encoding() {
        for _ in 0..10 {
            let t = new_credential();
            assert_eq!(t.len(), 43);
            assert!(
                t.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            );
        }
    }
}
