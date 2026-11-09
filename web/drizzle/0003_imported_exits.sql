CREATE TABLE proxy_external_exits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers ON DELETE RESTRICT,
  import_id uuid NOT NULL REFERENCES proxy_imports ON DELETE RESTRICT,
  candidate_key text NOT NULL,
  name text NOT NULL,
  port integer NOT NULL CHECK(port BETWEEN 1 AND 65535),
  method text NOT NULL,
  udp boolean NOT NULL,
  encrypted_credentials text NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','stale')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(import_id,candidate_key)
);
CREATE INDEX proxy_external_exits_server ON proxy_external_exits(server_id);
