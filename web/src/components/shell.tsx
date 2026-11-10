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
  IconMenu2,
  IconNetwork,
  IconRss,
} from "@tabler/icons-react";
import { Button } from "./ui/button";
import { api } from "@/lib/client";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";
import { ElevationDialog } from "./elevation-dialog";
const links = [
  { href: "/", label: "服务器", icon: IconServer },
  { href: "/proxies", label: "代理服务", icon: IconNetwork },
  { href: "/subscriptions", label: "代理订阅", icon: IconRss },
  { href: "/checks", label: "网络检查", icon: IconRadar },
  { href: "/alerts", label: "告警中心", icon: IconBell },
  { href: "/audit", label: "操作审计", icon: IconShieldCheck },
  { href: "/settings", label: "设置", icon: IconSettings },
];
function Navigation({ title, onNavigate }: { title: string; onNavigate?: () => void }) {
  return (
    <nav className="nav" aria-label="主导航">
      {links.map((link, index) => (
        <div key={link.href}>
          {[0, 3, 5].includes(index) && (
            <div className="nav-caption">
              {index === 0 ? "基础设施" : index === 3 ? "观测与告警" : "工作区"}
            </div>
          )}
          <Link
            href={link.href}
            onClick={onNavigate}
            className={title === link.label ? "active" : ""}
            aria-current={title === link.label ? "page" : undefined}
          >
            <link.icon size={19} stroke={1.7} />
            {link.label}
          </Link>
        </div>
      ))}
    </nav>
  );
}
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
  const [error, setError] = useState(""),
    [menuOpen, setMenuOpen] = useState(false);
  async function logout() {
    try {
      await api("auth/logout", "POST", {});
      router.replace("/login");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/" aria-label="Blink Node 首页">
          <Brand />
        </Link>
        <Navigation title={title} />
        <div className="sidebar-bottom">
          <div className="row between">
            <div className="row">
              <span className="account-avatar">{username.slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{username}</strong>
                <span>所有者 · 私有工作区</span>
              </div>
            </div>
            <Button variant="ghost" size="icon" aria-label="退出登录" onClick={logout}>
              <IconLogout size={17} />
            </Button>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <Link href="/" aria-label="Blink Node 首页">
            <Brand />
          </Link>
          <Button
            variant="ghost"
            size="icon"
            aria-label="打开导航"
            onClick={() => setMenuOpen(true)}
          >
            <IconMenu2 size={21} />
          </Button>
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
      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogContent className="mobile-nav-dialog">
          <DialogTitle>工作区导航</DialogTitle>
          <DialogDescription>{username} · 所有者</DialogDescription>
          <Navigation title={title} onNavigate={() => setMenuOpen(false)} />
          <Button variant="outline" onClick={logout}>
            <IconLogout size={16} />
            退出登录
          </Button>
        </DialogContent>
      </Dialog>
      <ElevationDialog />
    </div>
  );
}
