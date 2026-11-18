ALTER TABLE "mcp_connections" ADD COLUMN "oauth_state" jsonb;
--> statement-breakpoint
CREATE FUNCTION fence_mcp_oauth_on_connection_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pending jsonb;
BEGIN
  IF OLD.agent_id IS DISTINCT FROM NEW.agent_id
    OR OLD.endpoint IS DISTINCT FROM NEW.endpoint
    OR OLD.bearer_token_encrypted IS DISTINCT FROM NEW.bearer_token_encrypted THEN
    NEW.oauth_state := NULL;
  ELSIF NOT NEW.enabled AND OLD.enabled AND NEW.oauth_state IS NOT NULL THEN
    pending := NEW.oauth_state -> 'flow';
    IF jsonb_typeof(pending) = 'object' THEN
      NEW.oauth_state := jsonb_set(NEW.oauth_state, '{lastOutcome}', jsonb_build_object(
        'id', pending -> 'id', 'client', pending -> 'client', 'outcome', 'superseded'
      ));
      NEW.oauth_state := jsonb_set(NEW.oauth_state, '{flow}', 'null'::jsonb);
    END IF;
    IF jsonb_typeof(NEW.oauth_state #> '{grant,refresh}') = 'object' THEN
      NEW.oauth_state := jsonb_set(NEW.oauth_state, '{grant,refresh}', 'null'::jsonb);
      NEW.oauth_state := jsonb_set(NEW.oauth_state, '{grant,reconnectRequired}', 'true'::jsonb);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mcp_connections_fence_oauth
BEFORE UPDATE OF "agent_id", "endpoint", "enabled", "bearer_token_encrypted" ON "mcp_connections"
FOR EACH ROW EXECUTE FUNCTION fence_mcp_oauth_on_connection_change();
