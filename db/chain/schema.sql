CREATE SCHEMA IF NOT EXISTS chain;

CREATE TABLE IF NOT EXISTS chain.cursor (
  id         text PRIMARY KEY,
  block      bigint NOT NULL,
  block_hash text NOT NULL
);

CREATE TABLE IF NOT EXISTS chain.events (
  tx_hash      text NOT NULL,
  log_index    integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash   text NOT NULL,
  block_ts     bigint NOT NULL,
  contract     text NOT NULL,
  event        text NOT NULL,
  args         jsonb NOT NULL,
  processed    boolean NOT NULL DEFAULT false,
  error        text,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS events_block_idx ON chain.events (block_number, log_index);

CREATE TABLE IF NOT EXISTS chain.vault_state (
  id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  initial_settled_hour bigint NOT NULL,
  last_settled_hour bigint NOT NULL,
  usage_paused      boolean NOT NULL DEFAULT false,
  settles_paused    boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS chain.buyers (
  address                   text PRIMARY KEY,
  balance                   numeric(78,0) NOT NULL DEFAULT 0,
  hourly_cap                numeric(39,0) NOT NULL DEFAULT 0,
  daily_cap                 numeric(39,0) NOT NULL DEFAULT 0,
  pending_hourly_cap        numeric(39,0) NOT NULL DEFAULT 0,
  pending_daily_cap         numeric(39,0) NOT NULL DEFAULT 0,
  caps_effective_after_hour bigint NOT NULL DEFAULT 0,
  withdraw_requested_at     bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chain.hosts (
  address         text PRIMARY KEY,
  status          smallint NOT NULL DEFAULT 0,
  bond_usdg       numeric(78,0) NOT NULL DEFAULT 0,
  bond_ofpk       numeric(78,0) NOT NULL DEFAULT 0,
  image_digest    text,
  gpu_class       text,
  attestation_ref text,
  endpoint_hash   text,
  probation_ends  bigint NOT NULL DEFAULT 0,
  strikes         smallint NOT NULL DEFAULT 0,
  open_challenges integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chain.host_models (
  host    text NOT NULL,
  digest  text NOT NULL,
  max_tps integer NOT NULL,
  PRIMARY KEY (host, digest)
);

CREATE TABLE IF NOT EXISTS chain.host_status_log (
  host   text NOT NULL,
  ts     bigint NOT NULL,
  seq    bigint NOT NULL,
  status smallint NOT NULL,
  PRIMARY KEY (host, seq)
);

CREATE TABLE IF NOT EXISTS chain.host_credits (
  id            bigserial PRIMARY KEY,
  host          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('credit','reward')),
  hour          bigint NOT NULL,
  amount        numeric(39,0) NOT NULL,
  accrued_at    bigint NOT NULL,
  releasable_at bigint NOT NULL,
  state         text NOT NULL DEFAULT 'open' CHECK (state IN ('open','clawed','withdrawn'))
);
CREATE INDEX IF NOT EXISTS host_credits_host_idx ON chain.host_credits (host, state);

CREATE TABLE IF NOT EXISTS chain.settlements (
  hour        bigint PRIMARY KEY,
  root        text NOT NULL,
  totals_hash text NOT NULL,
  debited     numeric(39,0) NOT NULL,
  credited    numeric(39,0) NOT NULL,
  fees        numeric(39,0) NOT NULL,
  tx_hash     text NOT NULL,
  block       bigint NOT NULL,
  settled_at  bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS chain.roots (
  hour        bigint PRIMARY KEY,
  root        text NOT NULL,
  totals_hash text NOT NULL,
  records     integer NOT NULL
);

CREATE TABLE IF NOT EXISTS chain.refunds_paid (
  refund_id text PRIMARY KEY,
  payer     text NOT NULL,
  amount    numeric(39,0) NOT NULL,
  tx_hash   text NOT NULL
);

CREATE TABLE IF NOT EXISTS chain.signer_sets (
  contract text NOT NULL,
  block    bigint NOT NULL,
  signers  jsonb NOT NULL,
  PRIMARY KEY (contract, block)
);

-- A collection can land before the router writes its agent_payments row; ingest reconciles the two.
CREATE TABLE IF NOT EXISTS chain.collections (
  payment_id text PRIMARY KEY,
  tx_hash    text NOT NULL,
  hour       bigint NOT NULL
);

-- Signatures are public. Each signer stores the batch it computed, keyed by what it signed.
CREATE TABLE IF NOT EXISTS chain.settlement_sigs (
  kind       text NOT NULL CHECK (kind IN ('settle','refund','ruling','perf','reward')),
  hour       bigint NOT NULL,
  signer     text NOT NULL,
  batch_hash text NOT NULL,
  sig        text NOT NULL,
  batch      jsonb NOT NULL,
  PRIMARY KEY (kind, hour, signer)
);

-- Excluded records are public and permanent, so nothing is ever dropped silently.
CREATE TABLE IF NOT EXISTS chain.settlement_rejects (
  hour   bigint NOT NULL,
  req_id text NOT NULL,
  reason text NOT NULL,
  PRIMARY KEY (hour, req_id)
);
