CREATE TABLE "logs_dead_letter" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"entries" jsonb NOT NULL,
	CONSTRAINT "logs_dead_letter_id_pk" PRIMARY KEY("id")
);
