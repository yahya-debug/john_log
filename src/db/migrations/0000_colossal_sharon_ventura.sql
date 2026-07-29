CREATE TABLE "logs" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"level" text NOT NULL,
	"service" text NOT NULL,
	"message" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
    PRIMARY KEY (id, timestamp),
	CONSTRAINT "level_check" CHECK ("logs"."level" IN ('debug', 'info', 'warn', 'error'))
) PARTITION BY RANGE (timestamp);

-- default partition for rows whose timestamp doesn't fall in a declared partition
CREATE TABLE logs_default PARTITION OF logs DEFAULT;

-- partition today + the coming next 6 days
DO $$
DECLARE
  d DATE := CURRENT_DATE;
BEGIN
  FOR i IN 0..6 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS logs_%s PARTITION OF logs FOR VALUES FROM (%L) TO (%L)',
      to_char(d + i, 'YYYY_MM_DD'),
      d + i,
      d + i + 1
    );
  END LOOP;
END $$;


-- indexing
CREATE INDEX idx_logs_service_timestamp ON logs (service, timestamp DESC);
CREATE INDEX idx_logs_level_timestamp ON logs (level, timestamp DESC);
CREATE INDEX idx_logs_timestamp ON logs (timestamp DESC);

-- GIN: Generalized Inverted Index.
-- CREATE INDEX index_name ON table_name USING GIN (column_name [operator_class]);

-- Generic fallback: any attribute key is indexed via containment (attributes @> '{"key":"value"}').
-- Requires attribute values to be normalized to strings at ingestion time,
-- since GIN containment requires an exact type match.
-- json_path_ops: supports only @>. Smaller, faster index, because it doesn't need to track key-existence separately.
CREATE INDEX idx_attrs_gin ON logs USING GIN (attributes jsonb_path_ops);


-- Needed for the trigram index on `message` (accelerates q=<substring>).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Trigram index to accelerate q=<substring> matches on message, which a
-- plain B-tree cannot help with (leading-wildcard LIKE).
-- gin_trgm_ops: it exists specifically to make GIN understand substring similarity on plain text
CREATE INDEX idx_message_trgm ON logs USING GIN (message gin_trgm_ops);