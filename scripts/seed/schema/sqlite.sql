-- Reference schema for SQLite (TEXT ids; use a VIEW when you need joins.)
DROP TABLE IF EXISTS users;
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone_no TEXT,
  company_name TEXT
);

-- Example: flatten joins behind a stable surface for the dispatcher.
-- CREATE VIEW v_dispatch_profile AS
--   SELECT u.user_id, u.first_name, u.last_name, u.email, o.name AS company_name
--   FROM users u LEFT JOIN orgs o ON u.org_id = o.id;
