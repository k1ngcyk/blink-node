"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  IconActivityHeartbeat,
  IconServer,
  IconRadar,
  IconBell,
  IconShieldCheck,
  IconSettings,
  IconLogout,
  IconChevronRight,
} from "@tabler/icons-react";
import { Button } from "./ui/button";
import { api } from "@/lib/client";
import { useEffect, useState } from "react";
const links = [
  { href: "/", label: "服务器", icon: IconServer },
  { href: "/checks", label: "网络检查", icon: IconRadar },
  { href: "/alerts", label: "告警中心", icon: IconBell },
  { href: "/audit", label: "操作审计", icon: IconShieldCheck },
  { href: "/settings", label: "设置", icon: IconSettings },
];
export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <IconActivityHeartbeat size={23} stroke={1.7} />
      </span>
      <div>
        Blink Node<small>INFRASTRUCTURE</small>
      </div>
    </div>
  );
}
export function Shell({ children, username }: { children: React.ReactNode; username: string }) {
  const router = useRouter();
  useEffect(() => {
    const logout = () => {
      router.replace("/login");
      router.refresh();
    };
    window.addEventListener("blink:unauthorized", logout);
    return () => window.removeEventListener("blink:unauthorized", logout);
  }, [router]);
  const path = usePathname();
  const title =
    links.find((l) =>
      l.href === "/" ? path === "/" || path.startsWith("/servers") : path.startsWith(l.href),
    )?.label ?? "控制台";
  const [error, setError] = useState("");
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/" aria-label="Blink Node 首页">
          <Brand />
        </Link>
        <div>
          <div className="nav-caption">管理工作区</div>
          <nav className="nav">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={title === l.label ? "active" : ""}
                aria-current={title === l.label ? "page" : undefined}
              >
                <l.icon size={19} stroke={1.65} />
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="sidebar-bottom">
          <strong>私有控制平面</strong>只有你能管理服务器
          <br />
          <span className="mono">v0.1.0</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="row">
            <span>工作区</span>
            <IconChevronRight size={12} />
            <strong className="text-xs font-medium">{title}</strong>
          </div>
          <div className="row">
            <span>{username} · 所有者</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="退出登录"
              onClick={async () => {
                try {
                  await api("auth/logout", "POST", {});
                  router.replace("/login");
                  router.refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <IconLogout size={17} />
            </Button>
          </div>
        </header>
        <main className="content">
          {error && (
            <div role="alert" className="error-banner">
              {error}
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
