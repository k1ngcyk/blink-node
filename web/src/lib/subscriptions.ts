export type SubscriptionNode = {
  instanceId: string | null;
  name: string;
  displayName: string | null;
  serverName: string;
  kind: "reality" | "anytls" | "vless" | null;
  source?: "managed" | "imported";
  address: string | null;
  port: number | null;
  reason: string | null;
};
export type ProxySubscription = {
  id: string;
  name: string;
  displayName: string | null;
  enabled: boolean;
  encrypted: boolean;
  createdAt: string;
  updatedAt: string;
  nodes: SubscriptionNode[];
};
export type SubscriptionData = {
  subscriptions: ProxySubscription[];
  nodes: (SubscriptionNode & { instanceId: string })[];
};
export type SubscriptionAccess = { url: string; encryptionPassword: string; displayName: string };

// Match Shadowrocket's exported sub:// URI: standard UTF-8 Base64 without trailing
// '=' padding, followed by the password query and name fragment (both percent-encoded).
export function shadowrocketSubscriptionUri(access: SubscriptionAccess) {
  const encoded = btoa(
    Array.from(new TextEncoder().encode(access.url), (byte) => String.fromCharCode(byte)).join(""),
  ).replace(/=+$/, "");
  return `sub://${encoded}?password=${encodeURIComponent(access.encryptionPassword)}#${encodeURIComponent(access.displayName)}`;
}
export const subscriptionProtocols = {
  reality: "VLESS · REALITY",
  anytls: "AnyTLS",
  vless: "VLESS · TLS / XTLS",
};
