"use client";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { bytes } from "@/lib/utils";
export type History = {
  at: string;
  data: Record<string, number | { avg: number; min: number; max: number }>;
};
function num(value: History["data"][string]) {
  return typeof value === "number" ? value : (value?.avg ?? null);
}
export function MetricCharts({ data }: { data: History[] }) {
  // The first two samples can straddle an outage or an offline replay.
  const gaps = data
    .slice(1)
    .map((p, i) => Date.parse(p.at) - Date.parse(data[i].at))
    .filter((n) => n > 0);
  const expected = gaps.length ? Math.max(5000, Math.min(3600000, ...gaps)) : 5000;
  const points = data.flatMap((p, i) => {
    const value = {
      at: new Date(p.at).getTime(),
      cpu: num(p.data.cpu),
      memory: num(p.data.memory),
      rxRate: num(p.data.rxRate),
      txRate: num(p.data.txRate),
    };
    return i > 0 && value.at - new Date(data[i - 1].at).getTime() > expected * 3
      ? [{ at: value.at - expected, cpu: null, memory: null, rxRate: null, txRate: null }, value]
      : [value];
  });
  const time = (v: number) =>
    new Date(v).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  return (
    <div className="two-col">
      <section className="panel">
        <div className="panel-header">
          <h2>资源使用率</h2>
          <small className="muted">CPU / 内存</small>
        </div>
        <div className="chart-box">
          {!data.length ? (
            <div className="empty" style={{ minHeight: 180, padding: 12 }}>
              <p>等待采样数据。历史聚合可能延迟约 1 分钟。</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 8, right: 12, left: -20, bottom: 4 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="at"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(v) =>
                    new Date(v).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
                  }
                  minTickGap={60}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  tickFormatter={(v) => `${v}%`}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--card)",
                    borderColor: "var(--border)",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  labelFormatter={(v) => time(Number(v))}
                  formatter={(v) => `${Number(v).toFixed(1)}%`}
                />
                <Legend iconType="plainline" wrapperStyle={{ fontSize: 11 }} />
                <Area
                  isAnimationActive={false}
                  type="linear"
                  dataKey="cpu"
                  name="CPU"
                  stroke="var(--chart-1)"
                  fill="var(--chart-1)"
                  fillOpacity={0.08}
                  strokeWidth={1.8}
                />
                <Area
                  isAnimationActive={false}
                  type="linear"
                  dataKey="memory"
                  name="内存"
                  stroke="var(--chart-2)"
                  fill="var(--chart-2)"
                  fillOpacity={0.03}
                  strokeWidth={1.5}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-header">
          <h2>网络速率</h2>
          <small className="muted">每秒字节</small>
        </div>
        <div className="chart-box">
          {!data.length ? (
            <div className="empty" style={{ minHeight: 180, padding: 12 }}>
              <p>服务器上报后显示网络趋势。</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 8, right: 12, left: -10, bottom: 4 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="at"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(v) =>
                    new Date(v).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
                  }
                  minTickGap={60}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={(v) => bytes(v)}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--card)",
                    borderColor: "var(--border)",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  labelFormatter={(v) => time(Number(v))}
                  formatter={(v) => `${bytes(Number(v))}/s`}
                />
                <Legend iconType="plainline" wrapperStyle={{ fontSize: 11 }} />
                <Line
                  isAnimationActive={false}
                  dataKey="rxRate"
                  name="接收"
                  dot={false}
                  stroke="var(--chart-1)"
                  strokeWidth={1.8}
                />
                <Line
                  isAnimationActive={false}
                  dataKey="txRate"
                  name="发送"
                  dot={false}
                  stroke="var(--chart-3)"
                  strokeWidth={1.5}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>
    </div>
  );
}
