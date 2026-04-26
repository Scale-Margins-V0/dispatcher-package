-- Reference schema for PostgreSQL (TEXT ids for shared fixtures; use UUID in prod if you prefer.)
DROP TABLE IF EXISTS users CASCADE;
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone_no TEXT,
  company_name TEXT
);

-- Example: expose a join-free row shape to the dispatcher.
-- CREATE VIEW v_dispatch_profile AS
--   SELECT u.user_id::text AS user_id, u.first_name, u.last_name, u.email, o.name AS company_name
--   FROM users u LEFT JOIN orgs o ON u.org_id = o.id;
