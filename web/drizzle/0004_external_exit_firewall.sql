ALTER TABLE proxy_hosts ADD COLUMN firewall_desired_version integer NOT NULL DEFAULT 0;
ALTER TABLE proxy_hosts ADD COLUMN firewall_applied_version integer NOT NULL DEFAULT 0;
ALTER TABLE proxy_jobs DROP CONSTRAINT proxy_jobs_operation_check;
ALTER TABLE proxy_jobs ADD CONSTRAINT proxy_jobs_operation_check CHECK(operation IN ('scan','apply','firewall'));
ALTER TABLE proxy_jobs ADD COLUMN queue_seq bigint GENERATED ALWAYS AS IDENTITY;
DROP INDEX proxy_jobs_one_pending;
CREATE UNIQUE INDEX proxy_jobs_one_running ON proxy_jobs(server_id) WHERE state='running';
CREATE INDEX proxy_jobs_server_queue ON proxy_jobs(server_id,queue_seq) WHERE state IN ('queued','running');
