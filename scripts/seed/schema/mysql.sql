-- Reference schema for MySQL / MariaDB
DROP TABLE IF EXISTS users;
CREATE TABLE users (
  user_id VARCHAR(50) PRIMARY KEY,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone_no VARCHAR(20),
  company_name VARCHAR(200)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Example: joins belong in a VIEW, not in YAML.
-- CREATE VIEW v_dispatch_profile AS
--   SELECT u.user_id, u.first_name, u.last_name, u.email, o.name AS company_name
--   FROM users u LEFT JOIN orgs o ON u.org_id = o.id;
