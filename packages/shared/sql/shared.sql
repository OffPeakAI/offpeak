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

CREATE OR REPLACE FUNCTION shared.guard_usage_records() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  closed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM shared.usage_hours h WHERE h.hour = NEW.hour) THEN
      RAISE EXCEPTION 'hour % is closed', NEW.hour;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.req_id IS DISTINCT FROM OLD.req_id
     OR NEW.hour IS DISTINCT FROM OLD.hour
     OR NEW.ts IS DISTINCT FROM OLD.ts
     OR NEW.payer IS DISTINCT FROM OLD.payer
     OR NEW.buyer_ref IS DISTINCT FROM OLD.buyer_ref
     OR NEW.host IS DISTINCT FROM OLD.host
     OR NEW.model_digest IS DISTINCT FROM OLD.model_digest
     OR NEW.tokens_in IS DISTINCT FROM OLD.tokens_in
     OR NEW.tokens_out IS DISTINCT FROM OLD.tokens_out
     OR NEW.prompt_hash IS DISTINCT FROM OLD.prompt_hash
     OR NEW.output_hash IS DISTINCT FROM OLD.output_hash
     OR NEW.price_in IS DISTINCT FROM OLD.price_in
     OR NEW.price_out IS DISTINCT FROM OLD.price_out
     OR NEW.host_cost_micro IS DISTINCT FROM OLD.host_cost_micro
     OR NEW.fee_micro IS DISTINCT FROM OLD.fee_micro
     OR NEW.fee_bps IS DISTINCT FROM OLD.fee_bps
     OR NEW.pay_mode IS DISTINCT FROM OLD.pay_mode
     OR NEW.pay_ref IS DISTINCT FROM OLD.pay_ref
     OR NEW.sheet_hash IS DISTINCT FROM OLD.sheet_hash
     OR NEW.window_id IS DISTINCT FROM OLD.window_id
     OR NEW.router_sig IS DISTINCT FROM OLD.router_sig
     OR NEW.host_sig IS DISTINCT FROM OLD.host_sig
     OR NEW.leaf IS DISTINCT FROM OLD.leaf
     OR NEW.sealed IS DISTINCT FROM OLD.sealed
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'only status and settled_hour_tx may change';
  END IF;

  SELECT EXISTS (SELECT 1 FROM shared.usage_hours h WHERE h.hour = OLD.hour) INTO closed;
  IF NEW.status IS DISTINCT FROM OLD.status AND closed THEN
    RAISE EXCEPTION 'status is frozen after hour close';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS usage_records_guard ON shared.usage_records;
CREATE TRIGGER usage_records_guard
BEFORE INSERT OR UPDATE ON shared.usage_records
FOR EACH ROW EXECUTE FUNCTION shared.guard_usage_records();

DROP TRIGGER IF EXISTS usage_records_no_delete ON shared.usage_records;
CREATE TRIGGER usage_records_no_delete
BEFORE DELETE ON shared.usage_records
FOR EACH ROW EXECUTE FUNCTION shared.forbid_delete();

DROP TRIGGER IF EXISTS usage_hours_no_delete ON shared.usage_hours;
CREATE TRIGGER usage_hours_no_delete
BEFORE DELETE ON shared.usage_hours
FOR EACH ROW EXECUTE FUNCTION shared.forbid_delete();

DROP TRIGGER IF EXISTS agent_payments_no_delete ON shared.agent_payments;
CREATE TRIGGER agent_payments_no_delete
BEFORE DELETE ON shared.agent_payments
FOR EACH ROW EXECUTE FUNCTION shared.forbid_delete();

DROP TRIGGER IF EXISTS channel_state_no_delete ON shared.channel_state;
CREATE TRIGGER channel_state_no_delete
BEFORE DELETE ON shared.channel_state
FOR EACH ROW EXECUTE FUNCTION shared.forbid_delete();

DROP TRIGGER IF EXISTS window_perf_no_delete ON shared.window_perf;
CREATE TRIGGER window_perf_no_delete
BEFORE DELETE ON shared.window_perf
FOR EACH ROW EXECUTE FUNCTION shared.forbid_delete();

DROP TRIGGER IF EXISTS refunds_no_delete ON shared.refunds;
CREATE TRIGGER refunds_no_delete
BEFORE DELETE ON shared.refunds
FOR EACH ROW EXECUTE FUNCTION shared.forbid_delete();

CREATE TABLE IF NOT EXISTS shared.evidence_bundles (
  samples_root text PRIMARY KEY,
  body         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'offpeak_router') THEN
    CREATE ROLE offpeak_router;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'offpeak_chain') THEN
    CREATE ROLE offpeak_chain;
  END IF;
END $$;

GRANT USAGE ON SCHEMA shared TO offpeak_router, offpeak_chain;
GRANT SELECT ON ALL TABLES IN SCHEMA shared TO offpeak_router, offpeak_chain;
GRANT INSERT ON
  shared.usage_records,
  shared.usage_hours,
  shared.agent_payments,
  shared.channel_state,
  shared.window_perf,
  shared.refunds,
  shared.evidence_bundles
TO offpeak_router;

GRANT INSERT ON shared.refunds TO offpeak_chain;

GRANT UPDATE (status) ON shared.usage_records TO offpeak_router;
GRANT UPDATE (settled_hour_tx) ON shared.usage_records TO offpeak_chain;
GRANT UPDATE (settle_tx, settled_at) ON shared.usage_hours TO offpeak_chain;
GRANT UPDATE (collected_tx, collected_hour, drawn_hour, written_off_hour) ON shared.agent_payments TO offpeak_chain;
GRANT UPDATE (latest_seq, cumulative, voucher_sig, updated_at) ON shared.channel_state TO offpeak_router;
GRANT UPDATE (claimed) ON shared.channel_state TO offpeak_chain;
GRANT UPDATE (paid_hour) ON shared.refunds TO offpeak_chain;
GRANT UPDATE (tokens_per_s, demanded) ON shared.window_perf TO offpeak_router;
