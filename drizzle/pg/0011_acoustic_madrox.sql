CREATE TABLE "call_metadata" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(191) NOT NULL,
	"keys" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" varchar(191),
	CONSTRAINT "call_metadata_name_unique" UNIQUE("name")
);
