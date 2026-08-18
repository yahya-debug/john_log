CREATE TABLE "logs_minute_counts" (
	"minute" timestamp with time zone NOT NULL,
	"service" text NOT NULL,
	"level" text NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "logs_minute_counts_minute_service_level_pk" PRIMARY KEY("minute","service","level")
);
