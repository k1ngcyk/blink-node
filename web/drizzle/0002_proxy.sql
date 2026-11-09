CREATE TABLE proxy_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  encrypted_token text,
  zone_id text NOT NULL DEFAULT '',
  zone_name text NOT NULL DEFAULT '',
  acme_email text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO proxy_settings(id) VALUES (1);
CREATE TABLE proxy_hosts (
  server_id uuid PRIMARY KEY REFERENCES servers ON DELETE CASCADE,
  addresses text[] NOT NULL DEFAULT '{}',
  firewall text NOT NULL DEFAULT 'existing' CHECK(firewall IN ('existing','enable','external')),
  desired_version integer NOT NULL DEFAULT 0,
  applied_version integer NOT NULL DEFAULT 0,
  scanned_at timestamptz,
  observed jsonb NOT NULL DEFAULT '{}',
  encrypted_scan text
);
CREATE TABLE proxy_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers ON DELETE RESTRICT,
  name text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('reality','anytls','shadowsocks2022')),
  spec jsonb NOT NULL,
  encrypted_credentials text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','active','failed','disabled','deleting')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proxy_instances_server ON proxy_instances(server_id);
CREATE TABLE proxy_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers ON DELETE CASCADE,
  user_id uuid REFERENCES users ON DELETE SET NULL,
  operation text NOT NULL CHECK(operation IN ('scan','apply')),
  desired_version integer NOT NULL DEFAULT 0,
  encrypted_payload text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','failed')),
  result jsonb,
  attempts integer NOT NULL DEFAULT 0,
  depends_on uuid[] NOT NULL DEFAULT '{}',
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes'
);
CREATE INDEX proxy_jobs_dispatch ON proxy_jobs(state,created_at);
CREATE UNIQUE INDEX proxy_jobs_one_pending ON proxy_jobs(server_id) WHERE state IN ('queued','running');
CREATE TABLE proxy_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers ON DELETE CASCADE,
  source_key text NOT NULL,
  summary jsonb NOT NULL,
  encrypted_snapshot text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(server_id,source_key)
);
CREATE TABLE proxy_dns_records (
  hostname text NOT NULL,
  type text NOT NULL CHECK(type IN ('A','AAAA')),
  zone_id text NOT NULL,
  record_id text NOT NULL,
  server_id uuid NOT NULL REFERENCES servers ON DELETE CASCADE,
  PRIMARY KEY(hostname,type)
);
