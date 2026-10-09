ALTER TABLE "call_sessions" ADD COLUMN "transcript_state" jsonb DEFAULT '{"nextSequence":1,"pending":[],"acknowledged":[]}'::jsonb NOT NULL;
