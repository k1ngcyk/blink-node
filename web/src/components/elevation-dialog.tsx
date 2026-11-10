"use client";
import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useElevation, finishElevation } from "@/lib/elevation";
import { ElevationForm } from "./elevation-form";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";

export function ElevationDialog() {
  const challenge = useElevation();
  const path = usePathname();
  const query = useSearchParams().toString();
  useEffect(() => {
    const cancel = () => finishElevation(false);
    window.addEventListener("blink:unauthorized", cancel);
    return () => {
      cancel();
      window.removeEventListener("blink:unauthorized", cancel);
    };
  }, [path, query]);
  return (
    <Dialog
      open={!!challenge && !challenge.surface}
      onOpenChange={(open) => {
        if (!open) finishElevation(false);
      }}
    >
      <DialogContent elevationHost={false} className="sm:max-w-md" showCloseButton={false}>
        <DialogTitle className="sr-only">安全验证</DialogTitle>
        <DialogDescription className="sr-only">验证后继续当前操作</DialogDescription>
        <ElevationForm key={challenge?.id} />
      </DialogContent>
    </Dialog>
  );
}
