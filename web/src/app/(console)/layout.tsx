import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { owner } from "@/server/auth";
import { Shell } from "@/components/shell";
export const dynamic = "force-dynamic";
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  let username: string;
  try {
    username = (await owner(await headers())).username;
  } catch {
    redirect("/login");
  }
  return <Shell username={username}>{children}</Shell>;
}
