"use client";
import type { ComponentProps } from "react";
import { Input } from "./ui/input";

export function OtpInput(props: Omit<ComponentProps<typeof Input>, "type">) {
  return (
    <Input
      name="code"
      aria-label="动态验证码"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      placeholder="000000"
      required
      {...props}
      className={`otp-input ${props.className ?? ""}`}
      onPaste={(event) => {
        props.onPaste?.(event);
        const code = event.clipboardData.getData("text").replace(/\s/g, "");
        if (/^\d{6}$/.test(code)) {
          event.preventDefault();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(event.currentTarget, code);
          event.currentTarget.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }}
    />
  );
}
