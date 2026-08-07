CREATE TABLE "logs_hourly_counts" (
	"hour" timestamp with time zone NOT NULL,
	"service" text NOT NULL,
	"level" text NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "logs_hourly_counts_hour_service_level_pk" PRIMARY KEY("hour","service","level")
);
