-- What the plain role `aipr_app` (the api and the worker) may do in the current database. Idempotent. Run by the
-- database's first start (docker-entrypoint-initdb.d) and again by scripts/ops/restore.sh after a restore, because
-- `--no-privileges` dumps carry no grants and a re-created database starts without any.
--
-- Run as the owner role (the one that migrates), which owns every table: the default privileges below are the ones of
-- that role, so tables created by later migrations are covered too.
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO aipr_app', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO aipr_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aipr_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO aipr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aipr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aipr_app;
