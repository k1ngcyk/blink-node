import { ServerDetail } from "@/components/server-detail";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <ServerDetail id={(await params).id} />;
}
