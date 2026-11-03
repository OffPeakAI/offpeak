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

CREATE TABLE IF NOT EXISTS serving.jobs (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  wallet text NOT NULL,
  model text NOT NULL,
  model_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress','completed','failed','expired','cancelled')),
  deadline bigint NOT NULL,
  last_hour bigint NOT NULL,
  locked_price_in bigint NOT NULL,
  locked_price_out bigint NOT NULL,
  fee_bps integer NOT NULL,
  cap_locked boolean NOT NULL DEFAULT false,
  estimated_max_micro bigint NOT NULL,
  actual_micro bigint NOT NULL DEFAULT 0,
  input_file_id text NOT NULL,
  output_file_id text NOT NULL,
  output_bytes bigint NOT NULL DEFAULT 0,
  output_lines integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_account_idx ON serving.jobs (account_id, status);

CREATE TABLE IF NOT EXISTS serving.job_lines (
  job_id text NOT NULL,
  line_no integer NOT NULL,
  custom_id text NOT NULL,
  tokens_in integer NOT NULL,
  max_tokens_out integer NOT NULL,
  hour bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled','expired')),
  attempt integer NOT NULL DEFAULT 0,
  claimed_at bigint,
  req_id text,
  actual_micro bigint NOT NULL DEFAULT 0,
  output_offset bigint,
  output_bytes integer,
  PRIMARY KEY (job_id, line_no)
);
CREATE INDEX IF NOT EXISTS job_lines_due_idx ON serving.job_lines (status, hour);

CREATE TABLE IF NOT EXISTS serving.job_slots (
  job_id text NOT NULL,
  hour bigint NOT NULL,
  line_nos integer[] NOT NULL,
  tokens bigint NOT NULL,
  est_micro bigint NOT NULL,
  hold_id text,
  PRIMARY KEY (job_id, hour)
);
CREATE INDEX IF NOT EXISTS job_slots_hour_idx ON serving.job_slots (hour);

CREATE TABLE IF NOT EXISTS serving.files (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  purpose text NOT NULL,
  bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  expires_at timestamptz
);

CREATE TABLE IF NOT EXISTS serving.file_chunks (
  storage_key text NOT NULL,
  seq integer NOT NULL,
  content bytea NOT NULL,
  PRIMARY KEY (storage_key, seq)
);

CREATE TABLE IF NOT EXISTS serving.audit_samples (
  req_id text PRIMARY KEY,
  host text NOT NULL,
  model_digest text NOT NULL,
  enc_body text NOT NULL,
  day_key_id text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS serving.canary_accounts (
  wallet text PRIMARY KEY,
  label text NOT NULL
);

CREATE TABLE IF NOT EXISTS serving.canary_runs (
  id text PRIMARY KEY,
  host text NOT NULL,
  expected jsonb NOT NULL,
  output text,
  passed boolean
);

CREATE TABLE IF NOT EXISTS serving.audit_scores (
  req_id text PRIMARY KEY,
  host text NOT NULL,
  model_digest text NOT NULL,
  bucket text NOT NULL,
  ll_mean double precision NOT NULL,
  z double precision NOT NULL,
  ref_host text NOT NULL
);

CREATE TABLE IF NOT EXISTS serving.audit_baselines (
  model_digest text NOT NULL,
  gpu_class text NOT NULL,
  image_digest text NOT NULL,
  temp_bucket text NOT NULL,
  len_bucket text NOT NULL,
  mu double precision NOT NULL,
  sigma double precision NOT NULL,
  n integer NOT NULL,
  version text NOT NULL,
  PRIMARY KEY (model_digest, gpu_class, image_digest, temp_bucket, len_bucket, version)
);

CREATE TABLE IF NOT EXISTS serving.audit_runs (
  host text NOT NULL,
  model_digest text NOT NULL,
  week integer NOT NULL,
  n integer NOT NULL,
  llr double precision NOT NULL,
  threshold double precision NOT NULL,
  flagged boolean NOT NULL,
  filed_challenge_id text,
  PRIMARY KEY (host, model_digest, week)
);

CREATE TABLE IF NOT EXISTS serving.disputes (
  id text PRIMARY KEY,
  wallet text NOT NULL,
  req_ids text[] NOT NULL,
  reason text NOT NULL,
  submitted_material_hash text,
  status text NOT NULL,
  outcome text,
  refund_id text,
  refund_micro bigint NOT NULL DEFAULT 0,
  checks jsonb NOT NULL DEFAULT '[]',
  created_at bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS disputes_wallet_idx ON serving.disputes (wallet);

CREATE TABLE IF NOT EXISTS serving.hour_locks (
  hour bigint PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS serving.sealed_attestations (
  host text PRIMARY KEY,
  attestation_ref text NOT NULL,
  verified_at timestamptz NOT NULL,
  tcb_status text NOT NULL,
  transcript jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS serving.sheet_counts (
  host text NOT NULL,
  week integer NOT NULL,
  n integer NOT NULL,
  PRIMARY KEY (host, week)
);

CREATE TABLE IF NOT EXISTS serving.owed_boundaries (
  channel_id text NOT NULL,
  cumulative bigint NOT NULL,
  req_ids text[] NOT NULL,
  PRIMARY KEY (channel_id, cumulative)
);

CREATE TABLE IF NOT EXISTS serving.channel_reservations (
  id text PRIMARY KEY,
  channel_id text NOT NULL,
  amount bigint NOT NULL,
  expires_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS channel_reservations_channel_idx ON serving.channel_reservations (channel_id);

CREATE TABLE IF NOT EXISTS serving.pending_captures (
  req_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('prepaid', 'upto')),
  wallet text NOT NULL,
  hold_id text,
  hour bigint NOT NULL,
  amount bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS serving.window_minutes (
  window_id numeric(78,0) NOT NULL,
  minute bigint NOT NULL,
  tokens bigint NOT NULL DEFAULT 0,
  busy_ms bigint NOT NULL DEFAULT 0,
  demanded boolean NOT NULL DEFAULT false,
  written boolean NOT NULL DEFAULT false,
  PRIMARY KEY (window_id, minute)
);
CREATE INDEX IF NOT EXISTS window_minutes_unwritten_idx ON serving.window_minutes (minute) WHERE NOT written;

-- Brings a database made before these columns existed up to date.
ALTER TABLE serving.requests
  ADD COLUMN IF NOT EXISTS host_counts jsonb;
ALTER TABLE serving.channels_local
  ADD COLUMN IF NOT EXISTS frozen_until bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS close_final bigint,
  ADD COLUMN IF NOT EXISTS close_deadline bigint,
  ADD COLUMN IF NOT EXISTS close_payer_sig text,
  ADD COLUMN IF NOT EXISTS close_router_sig text,
  ADD COLUMN IF NOT EXISTS close_settled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS contract_voucher boolean NOT NULL DEFAULT false;
ALTER TABLE serving.jobs
  ADD COLUMN IF NOT EXISTS cap_locked boolean NOT NULL DEFAULT false;
ALTER TABLE serving.x402_requests
  ADD COLUMN IF NOT EXISTS valid_before bigint,
  ADD COLUMN IF NOT EXISTS created_at bigint NOT NULL DEFAULT 0;
ALTER TABLE serving.disputes
  ADD COLUMN IF NOT EXISTS refund_micro bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checks jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS created_at bigint NOT NULL DEFAULT 0;

-- Auditor. Columns added here, not above, so a database from an earlier step upgrades on boot.

ALTER TABLE serving.audit_samples ADD COLUMN IF NOT EXISTS ts bigint NOT NULL DEFAULT 0;
ALTER TABLE serving.audit_samples ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE serving.audit_samples ADD COLUMN IF NOT EXISTS scored_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'audit_samples_within_72h') THEN
    ALTER TABLE serving.audit_samples ADD CONSTRAINT audit_samples_within_72h CHECK (expires_at <= created_at + interval '72 hours');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS audit_samples_expiry_idx ON serving.audit_samples (expires_at);

-- One row per UTC day. Deleting the row destroys that day's key.
CREATE TABLE IF NOT EXISTS serving.audit_day_keys (
  id         text PRIMARY KEY,
  day        integer NOT NULL UNIQUE,
  wrapped    text NOT NULL,
  retire_at  timestamptz NOT NULL
);

ALTER TABLE serving.canary_accounts ADD COLUMN IF NOT EXISTS opened_at bigint NOT NULL DEFAULT 0;
ALTER TABLE serving.canary_accounts ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

-- Accepted answers for one deterministic prompt, as observed on reference hosts.
CREATE TABLE IF NOT EXISTS serving.canary_expected (
  prompt_id    text NOT NULL,
  model_digest text NOT NULL,
  body         jsonb NOT NULL,
  accepted     jsonb NOT NULL,
  gpu_classes  jsonb NOT NULL,
  observed_at  bigint NOT NULL,
  PRIMARY KEY (prompt_id, model_digest)
);

ALTER TABLE serving.canary_runs ADD COLUMN IF NOT EXISTS req_id text;
ALTER TABLE serving.canary_runs ADD COLUMN IF NOT EXISTS model_digest text NOT NULL DEFAULT '';
ALTER TABLE serving.canary_runs ADD COLUMN IF NOT EXISTS prompt_id text NOT NULL DEFAULT '';
ALTER TABLE serving.canary_runs ADD COLUMN IF NOT EXISTS deterministic boolean NOT NULL DEFAULT false;
ALTER TABLE serving.canary_runs ADD COLUMN IF NOT EXISTS body jsonb;
ALTER TABLE serving.canary_runs ADD COLUMN IF NOT EXISTS tool_calls jsonb;
ALTER TABLE serving.canary_runs ADD COLUMN IF NOT EXISTS wallet text NOT NULL DEFAULT '';
ALTER TABLE serving.canary_runs ADD COLUMN IF NOT EXISTS tokens_out integer NOT NULL DEFAULT 0;
ALTER TABLE serving.canary_runs ADD COLUMN IF NOT EXISTS ts bigint NOT NULL DEFAULT 0;
ALTER TABLE serving.canary_runs ADD COLUMN IF NOT EXISTS scored_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS canary_runs_req_idx ON serving.canary_runs (req_id);
CREATE INDEX IF NOT EXISTS canary_runs_host_idx ON serving.canary_runs (host, model_digest, ts);

-- The shape of live requests, never their content. Canary parameters are drawn from these counts.
CREATE TABLE IF NOT EXISTS serving.audit_traffic (
  model_digest text NOT NULL,
  week         integer NOT NULL,
  shape        text NOT NULL,
  n            bigint NOT NULL,
  PRIMARY KEY (model_digest, week, shape)
);

CREATE TABLE IF NOT EXISTS serving.audit_reference_hosts (
  host         text NOT NULL,
  model_digest text NOT NULL,
  endpoint     text NOT NULL,
  gpu_class    text NOT NULL,
  image_digest text NOT NULL,
  attested     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (host, model_digest)
);

ALTER TABLE serving.audit_scores ALTER COLUMN z DROP NOT NULL;
ALTER TABLE serving.audit_scores ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'sample';
ALTER TABLE serving.audit_scores ADD COLUMN IF NOT EXISTS ts bigint NOT NULL DEFAULT 0;
ALTER TABLE serving.audit_scores ADD COLUMN IF NOT EXISTS gpu_class text NOT NULL DEFAULT '';
ALTER TABLE serving.audit_scores ADD COLUMN IF NOT EXISTS image_digest text NOT NULL DEFAULT '';
ALTER TABLE serving.audit_scores ADD COLUMN IF NOT EXISTS temp_bucket text NOT NULL DEFAULT '';
ALTER TABLE serving.audit_scores ADD COLUMN IF NOT EXISTS len_bucket text NOT NULL DEFAULT '';
ALTER TABLE serving.audit_scores ADD COLUMN IF NOT EXISTS baseline_version text;

CREATE INDEX IF NOT EXISTS audit_scores_week_idx ON serving.audit_scores (host, model_digest, ts, req_id);

-- A second reference host's score of the same response.
CREATE TABLE IF NOT EXISTS serving.audit_replications (
  req_id   text NOT NULL,
  ref_host text NOT NULL,
  ll_mean  double precision NOT NULL,
  z        double precision,
  PRIMARY KEY (req_id, ref_host)
);

ALTER TABLE serving.audit_runs ADD COLUMN IF NOT EXISTS stopped_at integer;
ALTER TABLE serving.audit_runs ADD COLUMN IF NOT EXISTS stopped_ts bigint;
ALTER TABLE serving.audit_runs ADD COLUMN IF NOT EXISTS boost_until bigint;
ALTER TABLE serving.audit_runs ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'open';

CREATE TABLE IF NOT EXISTS serving.audit_calibrations (
  id           text PRIMARY KEY,
  model_digest text NOT NULL,
  source       text NOT NULL CHECK (source IN ('hardware', 'live', 'simulation')),
  ready        boolean NOT NULL,
  report       jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_calibrations_model_idx ON serving.audit_calibrations (model_digest, created_at DESC);

-- Failed scoring tries, so one row that keeps failing cannot sit at the head of every pass.
ALTER TABLE serving.audit_samples ADD COLUMN IF NOT EXISTS score_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE serving.audit_samples ADD COLUMN IF NOT EXISTS retry_at bigint NOT NULL DEFAULT 0;
ALTER TABLE serving.canary_runs ADD COLUMN IF NOT EXISTS score_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE serving.canary_runs ADD COLUMN IF NOT EXISTS retry_at bigint NOT NULL DEFAULT 0;

-- Written before a challenge goes out. The checks refuse a swap row without both signals, whatever
-- the code above it does, and the key stops a crash or a rerun from filing the same case twice.
CREATE TABLE IF NOT EXISTS serving.audit_filings (
  id                 text PRIMARY KEY,
  host               text NOT NULL,
  model_digest       text NOT NULL,
  week               integer NOT NULL,
  kind               smallint NOT NULL CHECK (kind IN (0, 1, 2)),
  samples_root       text NOT NULL,
  evidence           jsonb NOT NULL,
  signal_sequential  boolean NOT NULL DEFAULT false,
  signal_canary      boolean NOT NULL DEFAULT false,
  signal_replication boolean NOT NULL DEFAULT false,
  status             text NOT NULL CHECK (status IN ('prepared', 'sent', 'filed', 'failed')),
  tx_hash            text,
  challenge_id       text,
  outcome            text,
  from_block         bigint NOT NULL,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (host, model_digest, week, kind),
  CONSTRAINT swap_needs_two_signals CHECK (kind <> 0 OR (signal_sequential AND (signal_canary OR signal_replication)))
);

-- The signed transaction, written before it is broadcast, so a resend can only ever be the same one.
ALTER TABLE serving.audit_filings ADD COLUMN IF NOT EXISTS signed_tx text;

-- A refused signature leaves no usage record, so the flag has to carry its own time.
ALTER TABLE serving.metering_flags ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Expiring replay identifiers, shared by all router instances.
CREATE TABLE IF NOT EXISTS serving.expansion_replays (
  id text PRIMARY KEY,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS expansion_replays_expiry_idx ON serving.expansion_replays(expires_at);
GRANT SELECT, INSERT, DELETE ON serving.expansion_replays TO offpeak_router;
