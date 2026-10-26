ALTER TABLE "memories" ADD COLUMN "owner_correction" jsonb;
--> statement-breakpoint
ALTER TABLE "owner_editor_operations" DROP CONSTRAINT "owner_editor_operation_command";
--> statement-breakpoint
ALTER TABLE "owner_editor_operations" ADD CONSTRAINT "owner_editor_operation_command" CHECK ("owner_editor_operations"."command" IN ('create_person','update_person_identity','add_family_relationship','correct_owner_family_relationship','correct_owner_memory'));
