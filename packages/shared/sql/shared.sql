CREATE SCHEMA IF NOT EXISTS shared;

CREATE TABLE IF NOT EXISTS shared.usage_records (
  req_id          text PRIMARY KEY,
  hour            bigint NOT NULL,
  ts              bigint NOT NULL,
  payer           text NOT NULL,
  buyer_ref       text NOT NULL,
  host            text NOT NULL,
  model_digest    text NOT NULL,
  tokens_in       integer NOT NULL,
  tokens_out      integer NOT NULL,
  prompt_hash     text NOT NULL,
  output_hash     text NOT NULL,
  price_in        bigint NOT NULL,
  price_out       bigint NOT NULL,
  host_cost_micro bigint NOT NULL,
  fee_micro       bigint NOT NULL,
  fee_bps         integer NOT NULL,
  pay_mode        smallint NOT NULL CHECK (pay_mode BETWEEN 0 AND 4),
  pay_ref         text NOT NULL,
  sheet_hash      text NOT NULL,
  window_id       numeric(78,0),
  router_sig      text NOT NULL,
  host_sig        text NOT NULL,
  leaf            text NOT NULL,
  sealed          boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'final' CHECK (status IN ('final','void')),
  settled_hour_tx text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_records_hour_idx ON shared.usage_records (hour, status);
CREATE INDEX IF NOT EXISTS usage_records_payer_idx ON shared.usage_records (payer, hour);

CREATE TABLE IF NOT EXISTS shared.usage_hours (
  hour             bigint PRIMARY KEY,
  records          integer NOT NULL,
  root             text NOT NULL,
  totals           jsonb NOT NULL,
  totals_hash      text NOT NULL,
  router_close_sig text NOT NULL,
  closed_at        timestamptz NOT NULL DEFAULT now(),
  settle_tx        text,
  settled_at       timestamptz
);

CREATE TABLE IF NOT EXISTS shared.agent_payments (
  payment_id     text PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('upto','exact','channel')),
  payer          text NOT NULL,
  amount_micro   bigint NOT NULL CHECK (amount_micro >= 0),
  req_ids        text[] NOT NULL,
  channel_id     text,
  voucher_seq    bigint,
  voucher_sig    text,
  collected_tx   text,
  collected_hour bigint,
  drawn_hour     bigint,
  written_off_hour bigint,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shared.channel_state (
  channel_id   text PRIMARY KEY,
  payer        text NOT NULL,
  latest_seq   bigint NOT NULL,
  cumulative   bigint NOT NULL,
  voucher_sig  text NOT NULL,
  claimed      bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shared.window_perf (
  window_id     numeric(78,0) NOT NULL,
  ts            timestamptz NOT NULL,
  tokens_per_s  double precision NOT NULL,
  demanded      boolean NOT NULL,
  PRIMARY KEY (window_id, ts)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('shared.window_perf', 'ts', if_not_exists => TRUE);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS shared.refunds (
  id          text PRIMARY KEY,
  payer       text NOT NULL,
  amount      bigint NOT NULL,
  reason      text NOT NULL,
  req_ids     text[] NOT NULL,
  paid_hour   bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION shared.forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'deletes are forbidden on %', TG_TABLE_NAME;
END;
$$;
