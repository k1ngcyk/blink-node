CREATE TABLE proxy_external_entrances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers ON DELETE RESTRICT,
  import_id uuid NOT NULL REFERENCES proxy_imports ON DELETE RESTRICT,
  candidate_key text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('reality','anytls','vless')),
  spec jsonb NOT NULL,
  encrypted_credentials text NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','stale')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(import_id,candidate_key)
);
CREATE INDEX proxy_external_entrances_server ON proxy_external_entrances(server_id);

ALTER TABLE proxy_subscription_nodes
  ADD COLUMN entrance_id uuid REFERENCES proxy_external_entrances ON DELETE SET NULL,
  ADD CONSTRAINT proxy_subscription_nodes_one_source CHECK(instance_id IS NULL OR entrance_id IS NULL),
  ADD CONSTRAINT proxy_subscription_nodes_entrance_unique UNIQUE(subscription_id,entrance_id);
CREATE INDEX proxy_subscription_nodes_entrance ON proxy_subscription_nodes(entrance_id);
