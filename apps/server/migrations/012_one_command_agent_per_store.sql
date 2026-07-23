CREATE OR REPLACE FUNCTION prevent_duplicate_command_agent_route()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_store_id uuid;
BEGIN
  IF NEW.route_kind <> 'command_agent' THEN
    RETURN NEW;
  END IF;

  SELECT store_id
    INTO target_store_id
    FROM store_publications
   WHERE id = NEW.publication_id;

  IF EXISTS (
    SELECT 1
      FROM store_routes existing_route
      JOIN store_publications publication ON publication.id = existing_route.publication_id
     WHERE publication.store_id = target_store_id
       AND existing_route.route_kind = 'command_agent'
       AND existing_route.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'Only one command agent route is allowed per store';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER store_routes_one_command_agent
BEFORE INSERT OR UPDATE OF route_kind, publication_id ON store_routes
FOR EACH ROW
EXECUTE FUNCTION prevent_duplicate_command_agent_route();
