CREATE TABLE store_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  suffix text NOT NULL DEFAULT '',
  hostname text NOT NULL UNIQUE,
  dns_record_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(store_id, suffix)
);

CREATE INDEX store_publications_store_id_idx ON store_publications(store_id);

CREATE TABLE store_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL REFERENCES store_publications(id) ON DELETE CASCADE,
  path text NOT NULL,
  service_url text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(publication_id, path)
);

CREATE INDEX store_routes_publication_id_idx ON store_routes(publication_id);

INSERT INTO store_publications(store_id, suffix, hostname, dns_record_id, status)
SELECT id, '', hostname, dns_record_id, CASE WHEN dns_record_id IS NULL THEN 'pending' ELSE 'active' END
  FROM stores
ON CONFLICT (hostname) DO NOTHING;

INSERT INTO store_routes(publication_id, path, service_url, sort_order)
SELECT p.id, '/', s.origin_url, 0
  FROM store_publications p
  JOIN stores s ON s.id = p.store_id
ON CONFLICT (publication_id, path) DO NOTHING;

