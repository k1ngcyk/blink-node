"use client";
import { useEffect, useRef, useState } from "react";
import { IconArrowLeft, IconShieldLock } from "@tabler/icons-react";
import { api, ApiError } from "@/lib/client";
import { finishElevation, useElevation } from "@/lib/elevation";
import { Button } from "./ui/button";
import { OtpInput } from "./otp-input";

export function ElevationForm() {
  const challenge = useElevation();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  useEffect(() => {
    input.current?.focus();
  }, []);
  if (!challenge) return null;
  return (
    <section className="verification">
      <span className="verification-icon">
        <IconShieldLock size={26} stroke={1.6} />
      </span>
      <div>
        <h2>验证身份以继续</h2>
        <p className="muted text-sm mt-2">
          正在{challenge.action}。请输入身份验证器中的 6 位动态验证码。
        </p>
      </div>
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current) return;
          submitting.current = true;
          setBusy(true);
          setError("");
          try {
            await api("auth/elevate", "POST", {
              code: new FormData(event.currentTarget).get("code"),
            });
            window.dispatchEvent(new Event("blink:elevated"));
            finishElevation(true, challenge.id);
          } catch (error) {
            setError(
              error instanceof ApiError && error.status === 429
                ? "尝试次数过多，请稍后重试。已填写的内容会保留。"
                : (error as Error).message,
            );
            input.current?.select();
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <label className="field">
          动态验证码
          <OtpInput
            ref={input}
            readOnly={busy}
            aria-invalid={!!error}
            aria-describedby="verification-feedback"
          />
        </label>
        <div id="verification-feedback">
          {error ? (
            <p role="alert" className="error-text text-sm">
              {error}
            </p>
          ) : (
            <p className="muted text-xs">
              验证后 10 分钟内，无需再次输入。已使用的验证码请等待下一组。
            </p>
          )}
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "正在验证…" : "验证并继续"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => finishElevation(false, challenge.id)}>
          <IconArrowLeft size={16} />
          返回，保留已填内容
        </Button>
      </form>
    </section>
  );
}
