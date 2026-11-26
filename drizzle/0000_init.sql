CREATE TYPE "public"."concert_status" AS ENUM('planned', 'attending', 'attended', 'cancelled', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concert_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"concert_id" uuid NOT NULL,
	"invited_by" text NOT NULL,
	"email" text,
	"role" "member_role" DEFAULT 'editor' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concert_invites_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "concert_members" (
	"concert_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concert_members_concert_id_user_id_pk" PRIMARY KEY("concert_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "concert_people" (
	"concert_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	CONSTRAINT "concert_people_concert_id_person_id_pk" PRIMARY KEY("concert_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "concerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"artist" text NOT NULL,
	"title" text,
	"venue" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"status" "concert_status" DEFAULT 'planned' NOT NULL,
	"ticket_info" text,
	"setlist_url" text,
	"notes" text DEFAULT '' NOT NULL,
	"rating" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rating_range" CHECK ("concerts"."rating" is null or ("concerts"."rating" between 1 and 5))
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#f97316' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"linked_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photo_labels" (
	"photo_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "photo_labels_photo_id_label_id_pk" PRIMARY KEY("photo_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "photo_people" (
	"photo_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"tagged_by" text,
	"x" real,
	"y" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photo_people_photo_id_person_id_pk" PRIMARY KEY("photo_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"concert_id" uuid NOT NULL,
	"uploader_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"width" integer,
	"height" integer,
	"bytes" bigint NOT NULL,
	"mime" text NOT NULL,
	"taken_at" timestamp with time zone,
	"caption" text,
	"thumbs_ready" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "tag_email_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tagger_id" text NOT NULL,
	"user_id" text NOT NULL,
	"concert_id" uuid NOT NULL,
	"send_after" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'user' NOT NULL,
	"email_notifications" boolean DEFAULT true NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concert_invites" ADD CONSTRAINT "concert_invites_concert_id_concerts_id_fk" FOREIGN KEY ("concert_id") REFERENCES "public"."concerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concert_invites" ADD CONSTRAINT "concert_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concert_invites" ADD CONSTRAINT "concert_invites_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concert_members" ADD CONSTRAINT "concert_members_concert_id_concerts_id_fk" FOREIGN KEY ("concert_id") REFERENCES "public"."concerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concert_members" ADD CONSTRAINT "concert_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concert_people" ADD CONSTRAINT "concert_people_concert_id_concerts_id_fk" FOREIGN KEY ("concert_id") REFERENCES "public"."concerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concert_people" ADD CONSTRAINT "concert_people_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concerts" ADD CONSTRAINT "concerts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_linked_user_id_users_id_fk" FOREIGN KEY ("linked_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_labels" ADD CONSTRAINT "photo_labels_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_labels" ADD CONSTRAINT "photo_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_people" ADD CONSTRAINT "photo_people_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_people" ADD CONSTRAINT "photo_people_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_people" ADD CONSTRAINT "photo_people_tagged_by_users_id_fk" FOREIGN KEY ("tagged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_concert_id_concerts_id_fk" FOREIGN KEY ("concert_id") REFERENCES "public"."concerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_email_batches" ADD CONSTRAINT "tag_email_batches_tagger_id_users_id_fk" FOREIGN KEY ("tagger_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_email_batches" ADD CONSTRAINT "tag_email_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_email_batches" ADD CONSTRAINT "tag_email_batches_concert_id_concerts_id_fk" FOREIGN KEY ("concert_id") REFERENCES "public"."concerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_index" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "concert_invites_concert_id_index" ON "concert_invites" USING btree ("concert_id");--> statement-breakpoint
CREATE INDEX "concert_members_user_id_index" ON "concert_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "concerts_starts_at_index" ON "concerts" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "concerts_owner_id_index" ON "concerts" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_owner_id_name_index" ON "labels" USING btree ("owner_id","name");--> statement-breakpoint
CREATE INDEX "notifications_user_id_created_at_index" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "people_owner_id_index" ON "people" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "people_linked_user_id_index" ON "people" USING btree ("linked_user_id");--> statement-breakpoint
CREATE INDEX "photo_labels_label_id_index" ON "photo_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "photo_people_person_id_index" ON "photo_people" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "photos_concert_id_index" ON "photos" USING btree ("concert_id");--> statement-breakpoint
CREATE INDEX "photos_uploader_id_index" ON "photos" USING btree ("uploader_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_index" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tag_email_batches_user_id_concert_id_tagger_id_index" ON "tag_email_batches" USING btree ("user_id","concert_id","tagger_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_index" ON "verifications" USING btree ("identifier");