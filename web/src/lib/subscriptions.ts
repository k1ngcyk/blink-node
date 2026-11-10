export type SubscriptionNode = {
  instanceId: string | null;
  name: string;
  serverName: string;
  kind: "reality" | "anytls" | null;
  address: string | null;
  port: number | null;
  reason: string | null;
};
export type ProxySubscription = {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nodes: SubscriptionNode[];
};
export type SubscriptionData = {
  subscriptions: ProxySubscription[];
  nodes: (SubscriptionNode & { instanceId: string })[];
};
export const subscriptionProtocols = { reality: "VLESS · REALITY", anytls: "AnyTLS" };
