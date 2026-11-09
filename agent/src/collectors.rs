use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, time::Instant};
use sysinfo::{Components, Disks, Networks, System};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub name: String,
    pub mount: String,
    pub total: u64,
    pub used: u64,
    pub inodes_total: Option<u64>,
    pub inodes_used: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub name: String,
    pub rx: u64,
    pub tx: u64,
    pub rx_delta: u64,
    pub tx_delta: u64,
    pub rx_rate: f64,
    pub tx_rate: f64,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Temperature {
    pub name: String,
    pub value: f32,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Metric {
    pub boot_id: String,
    pub seq: u64,
    pub at: String,
    pub uptime: u64,
    pub cpu: f32,
    pub cores: Vec<f32>,
    pub load: [f64; 3],
    pub memory_total: u64,
    pub memory_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub disks: Vec<Disk>,
    pub networks: Vec<Network>,
    pub disk_read_rate: f64,
    pub disk_write_rate: f64,
    pub temperatures: Vec<Temperature>,
}
pub fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("timestamp")
}
pub fn delta(current: u64, previous: u64) -> u64 {
    current.saturating_sub(previous)
}
pub struct Collector {
    sys: System,
    networks: Networks,
    disks: Disks,
    components: Components,
    previous_net: HashMap<String, (u64, u64)>,
    previous_io: HashMap<String, (u64, u64)>,
    last: Instant,
    boot: String,
    seq: u64,
    ticks: u64,
}
impl Collector {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        let networks = Networks::new_with_refreshed_list();
        let previous_net = networks
            .iter()
            .map(|(n, d)| (n.clone(), (d.total_received(), d.total_transmitted())))
            .collect();
        Self {
            sys,
            networks,
            disks: Disks::new_with_refreshed_list(),
            components: Components::new_with_refreshed_list(),
            previous_net,
            previous_io: disk_io(),
            last: Instant::now(),
            boot: uuid::Uuid::new_v4().to_string(),
            seq: 0,
            ticks: 0,
        }
    }
    pub fn info(&self, terminal: bool, diagnostics: bool) -> serde_json::Value {
        serde_json::json!({"hostname":System::host_name().unwrap_or_else(||"unknown".into()),"os":System::long_os_version().unwrap_or_else(||"Linux".into()),"kernel":System::kernel_version().unwrap_or_else(||"unknown".into()),"arch":std::env::consts::ARCH,"cpuModel":self.sys.cpus().first().map(|c|c.brand()).filter(|brand|!brand.trim().is_empty()).unwrap_or("unknown"),"cpuCount":self.sys.cpus().len().max(1),"version":env!("CARGO_PKG_VERSION"),"terminal":terminal,"diagnostics":diagnostics})
    }
    pub fn collect(&mut self) -> Metric {
        let elapsed = self.last.elapsed().as_secs_f64().max(0.001);
        self.last = Instant::now();
        self.seq += 1;
        self.ticks += 1;
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.networks.refresh(true);
        if self.ticks % 6 == 1 {
            self.disks.refresh(true);
            self.components.refresh(true);
        }
        let networks = self
            .networks
            .iter()
            .filter(|(n, _)| n.as_str() != "lo" && n.as_str() != "lo0")
            .take(128)
            .map(|(n, d)| {
                let rx = d.total_received();
                let tx = d.total_transmitted();
                let previous = self.previous_net.insert(n.clone(), (rx, tx));
                let (rx_delta, tx_delta) = previous
                    .map(|(r, t)| (delta(rx, r), delta(tx, t)))
                    .unwrap_or((0, 0));
                Network {
                    name: n.clone(),
                    rx,
                    tx,
                    rx_delta,
                    tx_delta,
                    rx_rate: rx_delta as f64 / elapsed,
                    tx_rate: tx_delta as f64 / elapsed,
                }
            })
            .collect();
        self.previous_net
            .retain(|n, _| self.networks.contains_key(n));
        let current = disk_io();
        let mut read = 0u64;
        let mut write = 0u64;
        for (n, (r, w)) in &current {
            if let Some((pr, pw)) = self.previous_io.get(n) {
                read = read.saturating_add(delta(*r, *pr));
                write = write.saturating_add(delta(*w, *pw));
            }
        }
        self.previous_io = current;
        let load = System::load_average();
        Metric {
            boot_id: self.boot.clone(),
            seq: self.seq,
            at: now(),
            uptime: System::uptime(),
            cpu: self.sys.global_cpu_usage().clamp(0.0, 100.0),
            cores: self
                .sys
                .cpus()
                .iter()
                .take(1024)
                .map(|c| c.cpu_usage().clamp(0.0, 100.0))
                .collect(),
            load: [load.one.max(0.0), load.five.max(0.0), load.fifteen.max(0.0)],
            memory_total: self.sys.total_memory(),
            memory_used: self
                .sys
                .total_memory()
                .saturating_sub(self.sys.available_memory()),
            swap_total: self.sys.total_swap(),
            swap_used: self.sys.used_swap(),
            disks: self
                .disks
                .iter()
                .filter(|d| d.total_space() > 0)
                .take(128)
                .map(|d| {
                    let (it, iu) = inodes(d.mount_point());
                    Disk {
                        name: d.name().to_string_lossy().into(),
                        mount: d.mount_point().to_string_lossy().into(),
                        total: d.total_space(),
                        used: d.total_space().saturating_sub(d.available_space()),
                        inodes_total: it,
                        inodes_used: iu,
                    }
                })
                .collect(),
            networks,
            disk_read_rate: read as f64 / elapsed,
            disk_write_rate: write as f64 / elapsed,
            temperatures: self
                .components
                .iter()
                .take(128)
                .filter_map(|c| {
                    c.temperature()
                        .filter(|t| t.is_finite() && (-100.0..=250.0).contains(t))
                        .map(|value| Temperature {
                            name: c.label().into(),
                            value,
                        })
                })
                .collect(),
        }
    }
}
fn inodes(path: &std::path::Path) -> (Option<u64>, Option<u64>) {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else {
        return (None, None);
    };
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: c is NUL terminated, stat points to sufficient writable storage.
    if unsafe { libc::statvfs(c.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return (None, None);
    }
    // SAFETY: statvfs initialized the struct on success.
    let stat = unsafe { stat.assume_init() };
    (
        Some(stat.f_files as u64),
        Some(stat.f_files.saturating_sub(stat.f_favail) as u64),
    )
}
fn disk_io() -> HashMap<String, (u64, u64)> {
    fs::read_to_string("/proc/diskstats")
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let f: Vec<_> = line.split_whitespace().collect();
            if f.len() < 14 {
                return None;
            }
            let name = f[2];
            // Whole physical devices only; skip partitions and stacked virtual devices.
            if name.starts_with("loop")
                || name.starts_with("ram")
                || name.starts_with("dm-")
                || name.starts_with("md")
                || std::path::Path::new(&format!("/sys/class/block/{name}/partition")).exists()
            {
                return None;
            }
            Some((
                name.into(),
                (
                    f[5].parse::<u64>().ok()?.saturating_mul(512),
                    f[9].parse::<u64>().ok()?.saturating_mul(512),
                ),
            ))
        })
        .collect()
}
pub fn processes() -> String {
    let mut s = System::new_all();
    std::thread::sleep(std::time::Duration::from_millis(300));
    s.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let mut p:Vec<_>=s.processes().iter().map(|(id,p)|serde_json::json!({"pid":id.as_u32(),"name":p.name().to_string_lossy(),"cpu":p.cpu_usage(),"memory":p.memory()})).collect();
    p.sort_by(|a, b| {
        b["cpu"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&a["cpu"].as_f64().unwrap_or(0.0))
    });
    p.truncate(30);
    serde_json::to_string_pretty(&p).unwrap_or_default()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counter_reset_does_not_wrap() {
        assert_eq!(delta(10, 100), 0);
        assert_eq!(delta(110, 100), 10);
    }
    #[test]
    fn collects_valid_metrics() {
        let mut c = Collector::new();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let m = c.collect();
        assert!((0.0..=100.0).contains(&m.cpu));
        assert!(m.memory_used <= m.memory_total);
        assert!(m.seq > 0);
        assert!(serde_json::to_string(&m).is_ok());
    }
}
