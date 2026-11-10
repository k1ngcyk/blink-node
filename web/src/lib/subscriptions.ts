export type SubscriptionNode = {
  instanceId: string | null;
  name: string;
  displayName: string | null;
  serverName: string;
  kind: "reality" | "anytls" | null;
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

// Shadowrocket's export format includes the password, but its 2.2.93 sub:// importer
// does not restore that query field. Always offer a separate password copy control.
export function shadowrocketSubscriptionUri(access: SubscriptionAccess) {
  const encoded = btoa(
    Array.from(new TextEncoder().encode(access.url), (byte) => String.fromCharCode(byte)).join(""),
  );
  return `sub://${encoded}?password=${encodeURIComponent(access.encryptionPassword)}#${encodeURIComponent(access.displayName)}`;
}
export const subscriptionProtocols = { reality: "VLESS · REALITY", anytls: "AnyTLS" };
