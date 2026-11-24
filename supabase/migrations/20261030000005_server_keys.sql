-- Keys the timeclock-db Edge Function accepts. Only SHA-256 hashes are
-- stored; the key itself lives in Vercel as TIMECLOCK_DB_KEY. The private
-- schema has no grants, so neither the API roles nor timeclock_app can read it.
--
-- Add a key:     insert into timeclock_private.server_keys (label, key_sha256)
--                values ('vercel-production', encode(extensions.digest('<key>', 'sha256'), 'hex'));
-- Revoke a key:  update timeclock_private.server_keys set revoked_at = now() where label = '...';

create schema if not exists timeclock_private;
revoke all on schema timeclock_private from public;

create table timeclock_private.server_keys (
  id          bigint generated always as identity primary key,
  label       text not null unique,
  key_sha256  text not null unique check (key_sha256 ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
