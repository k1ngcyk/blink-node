"use client";
import { useResource } from "@/lib/client";
import { when } from "@/lib/utils";
import { ErrorBanner, Loading } from "./common";
export function Audit() {
  const events = useResource<
    {
      id: number;
      username: string | null;
      action: string;
      resource_id: string | null;
      detail: Record<string, unknown>;
      created_at: string;
    }[]
  >("audit", 15000);
  const terminals = useResource<
    {
      id: string;
      server_name: string;
      started_at: string;
      ended_at: string | null;
      reason: string | null;
    }[]
  >("terminal-sessions", 15000);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>操作审计</h1>
          <p>记录身份验证、配置变更和终端会话生命周期。</p>
        </div>
        <span className="muted text-xs">保留 180 天</span>
      </div>
      <ErrorBanner error={events.error || terminals.error} />
      {events.loading ? (
        <Loading />
      ) : (
        <section className="panel">
          <div className="panel-header">
            <h2>最近操作</h2>
            <small className="muted">最近 200 条</small>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作者</th>
                  <th>事件</th>
                  <th>资源 / 详情</th>
                </tr>
              </thead>
              <tbody>
                {events.data?.map((e) => (
                  <tr key={e.id}>
                    <td className="mono text-xs">{when(e.created_at)}</td>
                    <td>{e.username ?? "系统 / 未认证"}</td>
                    <td className="mono text-xs">{e.action}</td>
                    <td className="audit-detail text-left">
                      <span className="mono text-xs">{e.resource_id ?? "—"}</span>
                      {Object.keys(e.detail).length > 0 && (
                        <span className="subline">{JSON.stringify(e.detail)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="panel section-gap">
        <div className="panel-header">
          <h2>终端会话</h2>
          <small className="muted">默认不记录输入和输出内容</small>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>服务器</th>
                <th>开始时间</th>
                <th>结束时间</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {terminals.data?.map((t) => (
                <tr key={t.id}>
                  <td>{t.server_name}</td>
                  <td>{when(t.started_at)}</td>
                  <td>{t.ended_at ? when(t.ended_at) : "会话进行中"}</td>
                  <td>{t.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!terminals.data?.length && <p className="panel-body muted">暂无终端会话</p>}
        </div>
      </section>
    </>
  );
}
