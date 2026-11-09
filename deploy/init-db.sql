DO $$
DECLARE app_password text := btrim(pg_read_file('/run/secrets/db_app_password'), E' \t\r\n');
BEGIN
  EXECUTE format('CREATE ROLE blink LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', app_password);
END $$;
CREATE DATABASE blink OWNER blink;
REVOKE ALL ON DATABASE blink FROM PUBLIC;
GRANT CONNECT ON DATABASE blink TO blink;
\connect blink
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO blink;
