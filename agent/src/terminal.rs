use crate::config::{Config, Identity};
use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use nix::{
    sys::signal::{Signal, kill, killpg},
    unistd::{Pid, Uid, User},
};
use portable_pty::{Child, CommandBuilder, PtySize, native_pty_system};
use serde_json::Value;
use std::{
    io::{Read, Write},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{
    Message, client::IntoClientRequest, protocol::WebSocketConfig,
};

struct ChildGuard {
    child: Box<dyn Child + Send + Sync>,
    pid: Option<u32>,
}
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.pid {
            // PTY children have their own session. Reap all processes in that session,
            // including foreground job groups, before killing/reaping the leader.
            if let Ok(entries) = std::fs::read_dir("/proc") {
                for entry in entries.flatten() {
                    let Ok(id) = entry.file_name().to_string_lossy().parse::<i32>() else {
                        continue;
                    };
                    if id == std::process::id() as i32 {
                        continue;
                    }
                    // SAFETY: getsid only observes a process; errors return -1.
                    if unsafe { libc::getsid(id) } == pid as i32 {
                        let _ = kill(Pid::from_raw(id), Signal::SIGKILL);
                    }
                }
            }
            let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
pub fn allowed(config: &Config) -> bool {
    if !config.terminal_enabled {
        return false;
    }
    let Ok(Some(user)) = User::from_name(&config.terminal_user) else {
        return false;
    };
    (user.uid != Uid::from_raw(0) || config.allow_root_terminal)
        && (Uid::effective().is_root() || Uid::effective() == user.uid)
}
pub async fn run(
    config: Config,
    identity: Identity,
    stream_token: String,
    mut cancel: oneshot::Receiver<()>,
) -> Result<()> {
    if !allowed(&config) {
        bail!("Terminal user is not allowed");
    }
    let user = User::from_name(&config.terminal_user)?.context("Terminal user missing")?;
    let mut request = config.ws_url("/ws/agent-terminal")?.into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", identity.credential).parse()?,
    );
    request
        .headers_mut()
        .insert("x-blink-stream", stream_token.parse()?);
    let settings = WebSocketConfig::default()
        .max_message_size(Some(16384))
        .max_frame_size(Some(16384))
        .max_write_buffer_size(1024 * 1024);
    let (ws, _) = tokio::time::timeout(
        Duration::from_secs(8),
        tokio_tungstenite::connect_async_with_config(request, Some(settings), true),
    )
    .await??;
    let (mut sink, mut stream) = ws.split();
    let pair = native_pty_system().openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let shell = if user.shell.is_absolute() {
        user.shell.clone()
    } else {
        std::path::PathBuf::from("/bin/sh")
    };
    let mut command = if Uid::effective().is_root() && !user.uid.is_root() {
        let mut c = CommandBuilder::new("/usr/sbin/runuser");
        c.args(["-u", &user.name, "--"]);
        c.arg(&shell);
        c.arg("-l");
        c
    } else {
        let mut c = CommandBuilder::new(&shell);
        c.arg("-l");
        c
    };
    command.env_clear();
    command.env("HOME", &user.dir);
    command.env("USER", &user.name);
    command.env("LOGNAME", &user.name);
    command.env("SHELL", &shell);
    command.env("TERM", "xterm-256color");
    command.env("LANG", "C.UTF-8");
    command.env("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    command.cwd(&user.dir);
    let child = pair.slave.spawn_command(command)?;
    let _guard = ChildGuard {
        pid: child.process_id(),
        child,
    };
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(16);
    let writer_task = tokio::task::spawn_blocking(move || {
        while let Some(bytes) = input_rx.blocking_recv() {
            if writer
                .write_all(&bytes)
                .and_then(|()| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(32);
    let reader_task = tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let master = pair.master;
    let result=async move {
        let _guard=_guard;
        loop {
            tokio::select! {
                _=&mut cancel=>break,
                bytes=rx.recv()=>match bytes {Some(bytes)=>{tokio::time::timeout(Duration::from_secs(5),sink.send(Message::Binary(bytes.into()))).await??;},None=>break},
                message=stream.next()=>match message {
                    Some(Ok(Message::Text(text)))=>{
                        let v:Value=serde_json::from_str(&text)?;
                        match v["type"].as_str(){
                            Some("input")=>{let text=v["data"].as_str().context("Invalid input")?;if text.len()>8192{bail!("Input too large");}input_tx.try_send(text.as_bytes().to_vec()).context("Terminal input backpressure")?;},
                            Some("resize")=>{let cols=v["cols"].as_u64().context("Invalid cols")?;let rows=v["rows"].as_u64().context("Invalid rows")?;if !(2..=500).contains(&cols)||!(2..=300).contains(&rows){bail!("Invalid size");}master.resize(PtySize{cols:cols as u16,rows:rows as u16,pixel_width:0,pixel_height:0})?;},
                            _=>bail!("Unknown terminal message"),
                        }
                    },
                    Some(Ok(Message::Ping(p)))=>sink.send(Message::Pong(p)).await?,
                    Some(Ok(Message::Pong(_)))=>{},
                    _=>break,
                }
            }
        }
        Ok(())
    }.await;
    let _ = reader_task.await;
    let _ = writer_task.await;
    result
}
