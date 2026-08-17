CREATE SCHEMA IF NOT EXISTS serving;

CREATE TABLE IF NOT EXISTS serving.accounts (
  id text PRIMARY KEY,
  wallet text NOT NULL UNIQUE,
  audit_opt_in boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS serving.api_keys (
  key_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES serving.accounts(id),
  label text NOT NULL,
  rpm_limit integer NOT NULL DEFAULT 600,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS serving.siwe_sessions (
  id text PRIMARY KEY,
  wallet text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS serving.holds (
  id text PRIMARY KEY,
  account_id text,
  wallet text NOT NULL,
  hour bigint NOT NULL,
  amount bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('held','captured','released','expired')),
  req_id text,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS serving.hosts_cache (
  address text PRIMARY KEY,
  endpoint text NOT NULL,
  status integer NOT NULL,
  routable boolean NOT NULL,
  bond_usdg bigint NOT NULL,
  routing_bonus_bps integer NOT NULL DEFAULT 0,
  gpu_class text NOT NULL,
  image_digest text NOT NULL,
  attestation_ref text,
  strikes integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS serving.host_models (
  host text NOT NULL,
  model_digest text NOT NULL,
  model_name text NOT NULL,
  context integer NOT NULL,
  max_tps integer NOT NULL,
  PRIMARY KEY (host, model_digest)
);

CREATE TABLE IF NOT EXISTS serving.price_sheets (
  sheet_hash text PRIMARY KEY,
  host text NOT NULL,
  model_digest text NOT NULL,
  valid_from bigint NOT NULL,
  base_in jsonb NOT NULL,
  base_out jsonb NOT NULL,
  floor_in bigint NOT NULL,
  floor_out bigint NOT NULL,
  nonce bigint NOT NULL,
  sig text NOT NULL
);

CREATE TABLE IF NOT EXISTS serving.host_load (
  host text NOT NULL,
  model_digest text NOT NULL,
  ts timestamptz NOT NULL,
  util double precision NOT NULL,
  ttft_p95_ms double precision NOT NULL,
  inflight integer NOT NULL,
  healthy boolean NOT NULL,
  PRIMARY KEY (host, model_digest, ts)
);

CREATE TABLE IF NOT EXISTS serving.host_stats (
  host text NOT NULL,
  day date NOT NULL,
  served_tokens bigint NOT NULL,
  billed_host_micro bigint NOT NULL,
  base_value_micro bigint NOT NULL,
  effective_discount_bps integer NOT NULL,
  PRIMARY KEY (host, day)
);

CREATE TABLE IF NOT EXISTS serving.requests (
  req_id text PRIMARY KEY,
  account_id text,
  wallet text NOT NULL,
  model_digest text NOT NULL,
  host text NOT NULL,
  pay_mode smallint NOT NULL,
  tokens_in integer NOT NULL,
  tokens_out integer NOT NULL,
  ttft_ms integer,
  duration_ms integer,
  status text NOT NULL,
  error_code text,
  sealed boolean NOT NULL DEFAULT false,
  ts bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS serving.metering_flags (
  req_id text PRIMARY KEY,
  host text NOT NULL,
  router_counts jsonb NOT NULL,
  host_counts jsonb NOT NULL,
  reason text NOT NULL
);

CREATE TABLE IF NOT EXISTS serving.channels_local (
  channel_id text PRIMARY KEY,
  payer text NOT NULL,
  unvouchered_micro bigint NOT NULL,
  last_owed bigint NOT NULL,
  last_owed_req_ids text[] NOT NULL,
  frozen_until bigint NOT NULL DEFAULT 0,
  close_final bigint,
  close_deadline bigint,
  close_payer_sig text,
  close_router_sig text,
  close_settled boolean NOT NULL DEFAULT false,
  contract_voucher boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS serving.x402_requests (
  req_id text PRIMARY KEY,
  payer text NOT NULL,
  max_amount bigint NOT NULL,
  status text NOT NULL,
  preconfirm_stall_ms integer,
  valid_before bigint,
  created_at bigint NOT NULL DEFAULT 0
);

-- The first shape of these tables was never written to, so it is safe to replace.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'serving' AND table_name = 'job_lines' AND column_name = 'body') THEN
    DROP TABLE serving.job_lines, serving.job_slots, serving.jobs, serving.files;
  END IF;
END
$$;
