"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconLock, IconArrowRight, IconEye, IconEyeOff } from "@tabler/icons-react";
import { Brand } from "./shell";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { api } from "@/lib/client";
import { OtpInput } from "./otp-input";
export function Login() {
  const router = useRouter();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [showPassword, setShowPassword] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api("auth/login", "POST", {
        username: form.get("username"),
        password: form.get("password"),
        code: form.get("code"),
      });
      router.replace("/");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-screen">
      <aside className="login-aside">
        <Brand />
        <div>
          <div className="row" style={{ color: "#90d8c8", fontSize: 12, marginBottom: 20 }}>
            <IconLock size={16} /> YOUR INFRASTRUCTURE, UNDER CONTROL
          </div>
          <h1>
            看见每一次变化。
            <br />
            掌握每一台服务器。
          </h1>
          <p>
            硬件状态、网络质量与远程运维，
            <br />
            在一个只属于你的工作区中连接起来。
          </p>
          <div className="linework" aria-hidden>
            {[20, 36, 28, 58, 40, 72, 52, 64].map((h, i) => (
              <span key={i} style={{ height: h }} />
            ))}
          </div>
        </div>
        <small>BLINK NODE / PRIVATE CONTROL PLANE</small>
      </aside>
      <main className="login-main">
        <div className="login-form">
          <div className="mobile-only">
            <Brand />
          </div>
          <h1>登录控制台</h1>
          <p className="muted text-sm">使用管理员账号与动态验证码继续。</p>
          <form onSubmit={submit} className="stack">
            <label className="field">
              管理员账号
              <Input
                name="username"
                autoComplete="username"
                required
                maxLength={32}
                placeholder="admin"
              />
            </label>
            <label className="field">
              密码
              <span className="password-field">
                <Input
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  maxLength={256}
                />
                <button
                  type="button"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <IconEyeOff size={18} /> : <IconEye size={18} />}
                </button>
              </span>
            </label>
            <label className="field">
              动态验证码
              <OtpInput aria-invalid={!!error} />
              <small>在你的身份验证器中查看验证码。</small>
            </label>
            {error && (
              <div role="alert" className="error-banner">
                {error}
              </div>
            )}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "正在验证…" : "安全登录"}
              <IconArrowRight size={16} />
            </Button>
          </form>
          <p className="login-foot">
            <IconLock size={12} className="inline mr-1" />
            双因素认证 · 加密连接 · 操作审计
          </p>
        </div>
      </main>
    </div>
  );
}
