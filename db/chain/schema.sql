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
  max_tps bigint NOT NULL,
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

CREATE TABLE IF NOT EXISTS chain.settlements_audit (
  hour         bigint PRIMARY KEY,
  records      integer NOT NULL,
  rejected     integer NOT NULL,
  close_matched boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS chain.refund_ids (
  refund_id text PRIMARY KEY,
  id        text NOT NULL
);

CREATE TABLE IF NOT EXISTS chain.challenges (
  id             bigint PRIMARY KEY,
  host           text NOT NULL,
  challenger     text NOT NULL,
  kind           smallint NOT NULL,
  evidence_hash  text NOT NULL,
  model_digest   text,
  samples_root   text,
  sample_count   bigint,
  test_id        text,
  statistic      numeric(78,0),
  threshold      numeric(78,0),
  uri            text,
  filed_at       bigint NOT NULL,
  filed_block    bigint NOT NULL,
  response_hash  text,
  appeal_hash    text,
  outcome        smallint,
  decision       smallint,
  slash_bps      integer,
  slashed_usdg   numeric(78,0),
  review_ends_at bigint,
  finalized_at   bigint,
  state          text NOT NULL CHECK (state IN ('filed','panel_review','decided','finalized'))
);
CREATE INDEX IF NOT EXISTS challenges_host_idx ON chain.challenges (host);

-- One tree per possible slash size, since the panel can land on either.
CREATE TABLE IF NOT EXISTS chain.refund_trees (
  challenge_id bigint NOT NULL,
  slash_bps    integer NOT NULL,
  buyer        text NOT NULL,
  amount       numeric(78,0) NOT NULL,
  proof        jsonb NOT NULL,
  claimed      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (challenge_id, slash_bps, buyer)
);

CREATE TABLE IF NOT EXISTS chain.channels (
  channel_id        text PRIMARY KEY,
  payer             text NOT NULL,
  deposit           numeric(78,0) NOT NULL,
  claimed           numeric(39,0) NOT NULL DEFAULT 0,
  last_seq          numeric(20,0) NOT NULL DEFAULT 0,
  expiry            bigint NOT NULL,
  challenge_ends_at bigint NOT NULL DEFAULT 0,
  status            smallint NOT NULL DEFAULT 1,
  opened_at         bigint NOT NULL,
  last_claim_at     bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS channels_status_idx ON chain.channels (status, expiry);

-- Every point a channel's collected total moved. A cooperative close lands as the highest sequence.
CREATE TABLE IF NOT EXISTS chain.channel_claims (
  channel_id text NOT NULL,
  seq        numeric(20,0) NOT NULL,
  cumulative numeric(39,0) NOT NULL,
  tx_hash    text NOT NULL,
  hour       bigint NOT NULL,
  PRIMARY KEY (channel_id, seq)
);

CREATE TABLE IF NOT EXISTS chain.escrows (
  req_id       text PRIMARY KEY,
  payer        text NOT NULL,
  max_amount   numeric(39,0) NOT NULL,
  captured     numeric(39,0) NOT NULL DEFAULT 0,
  valid_before bigint NOT NULL DEFAULT 0,
  status       text NOT NULL CHECK (status IN ('authorized','captured','expired')),
  tx_hash      text NOT NULL
);
CREATE INDEX IF NOT EXISTS escrows_status_idx ON chain.escrows (status, valid_before);

-- The durable claim that stops one payload being accepted twice, written before the chain sees it.
CREATE TABLE IF NOT EXISTS chain.x402_claims (
  req_id     text PRIMARY KEY,
  payer      text NOT NULL,
  scheme     text NOT NULL CHECK (scheme IN ('upto','exact')),
  status     text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','submitted','confirmed','failed')),
  tx_hash    text,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE chain.x402_claims ADD COLUMN IF NOT EXISTS payload_hash text;

-- Agent records no payment ever covered, paid to their hosts from the reserve.
CREATE TABLE IF NOT EXISTS chain.orphan_writeoffs (
  req_id text PRIMARY KEY,
  hour   bigint NOT NULL
);

-- Money that reached the pool with no payment row, drawn into fees once a day has passed.
CREATE TABLE IF NOT EXISTS chain.swept_payments (
  payment_id text PRIMARY KEY,
  source     text NOT NULL,
  amount     numeric(39,0) NOT NULL,
  hour       bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS swept_payments_source_idx ON chain.swept_payments (source);

CREATE TABLE IF NOT EXISTS chain.windows (
  id                numeric(78,0) PRIMARY KEY,
  host              text NOT NULL,
  model_digest      text NOT NULL,
  t0                bigint NOT NULL,
  t1                bigint NOT NULL,
  min_tps           bigint NOT NULL,
  units             numeric(39,0) NOT NULL,
  perf_state        smallint NOT NULL DEFAULT 0,
  measured_seconds  bigint,
  below_min_seconds bigint,
  failed            boolean NOT NULL DEFAULT false,
  perf_final_at     bigint
);
CREATE INDEX IF NOT EXISTS windows_end_idx ON chain.windows (t1, perf_state);

CREATE TABLE IF NOT EXISTS chain.window_holdings (
  window_id     numeric(78,0) NOT NULL,
  holder        text NOT NULL,
  balance       numeric(39,0) NOT NULL DEFAULT 0,
  drawn_partial bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (window_id, holder)
);

CREATE TABLE IF NOT EXISTS chain.listings (
  listing_id     numeric(78,0) PRIMARY KEY,
  window_id      numeric(78,0) NOT NULL,
  seller         text NOT NULL,
  units          numeric(78,0) NOT NULL,
  price_per_unit numeric(78,0) NOT NULL
);

-- Both come from uint32 event fields. Changed here as well as above, so a database from an earlier step upgrades on boot.
DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'chain' AND table_name = 'challenges' AND column_name = 'sample_count' AND data_type = 'integer') THEN
    ALTER TABLE chain.challenges ALTER COLUMN sample_count TYPE bigint;
  END IF;
  IF EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'chain' AND table_name = 'host_models' AND column_name = 'max_tps' AND data_type = 'integer') THEN
    ALTER TABLE chain.host_models ALTER COLUMN max_tps TYPE bigint;
  END IF;
END $$;
