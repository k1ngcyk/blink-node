ALTER TABLE servers ADD COLUMN connection_ip inet;

CREATE TABLE proxy_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  token_hash text NOT NULL UNIQUE,
  encrypted_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE proxy_subscription_nodes (
  subscription_id uuid NOT NULL REFERENCES proxy_subscriptions ON DELETE CASCADE,
  instance_id uuid REFERENCES proxy_instances ON DELETE SET NULL,
  name text NOT NULL,
  position integer NOT NULL CHECK(position >= 0),
  PRIMARY KEY(subscription_id, position),
  UNIQUE(subscription_id, instance_id)
);
CREATE INDEX proxy_subscription_nodes_instance ON proxy_subscription_nodes(instance_id);
