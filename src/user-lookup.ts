/**
 * User ID to PII Lookup
 *
 * Maps pseudonymous user_ids from ScaleMargin to actual PII
 * (name, email, phone) from the customer's database.
 *
 * CUSTOMIZE THIS FILE for your database.
 *
 * Example below shows MySQL (mysql2) — the most common pattern for
 * Indian enterprise customers. Replace with your actual DB queries.
 *
 * Supported patterns:
 *   - MySQL/MariaDB: mysql2 (shown below)
 *   - PostgreSQL: pg
 *   - DynamoDB: @aws-sdk/client-dynamodb
 *   - Any ORM: Prisma, Drizzle, Sequelize, etc.
 */

export interface UserRecord {
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  company_name?: string;
}

// ---------------------------------------------------------------------------
// MySQL implementation (uncomment and configure for production)
//
// Required env vars:
//   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
//
// Expected table schema:
//   CREATE TABLE users (
//     user_id    VARCHAR(50) PRIMARY KEY,
//     first_name VARCHAR(100),
//     last_name  VARCHAR(100),
//     email      VARCHAR(255) NOT NULL,
//     phone_no   VARCHAR(20),
//     company_name VARCHAR(200)
//   );
// ---------------------------------------------------------------------------
//
// import mysql from "mysql2/promise";
//
// const pool = mysql.createPool({
//   host: process.env.DB_HOST || "localhost",
//   port: parseInt(process.env.DB_PORT || "3306"),
//   user: process.env.DB_USER || "root",
//   password: process.env.DB_PASSWORD || "",
//   database: process.env.DB_NAME || "customers",
//   waitForConnections: true,
//   connectionLimit: 10,
// });
//
// export async function lookupUsers(
//   userIds: string[]
// ): Promise<Map<string, UserRecord>> {
//   const result = new Map<string, UserRecord>();
//   if (userIds.length === 0) return result;
//
//   const placeholders = userIds.map(() => "?").join(",");
//   const [rows] = await pool.query<mysql.RowDataPacket[]>(
//     `SELECT user_id, first_name, last_name, email, phone_no AS phone, company_name
//      FROM users
//      WHERE user_id IN (${placeholders})`,
//     userIds
//   );
//
//   for (const row of rows) {
//     result.set(row.user_id, {
//       user_id: row.user_id,
//       first_name: row.first_name || "",
//       last_name: row.last_name || "",
//       email: row.email || "",
//       phone: row.phone || undefined,
//       company_name: row.company_name || undefined,
//     });
//   }
//
//   console.log(`[UserLookup] Resolved ${result.size}/${userIds.length} users from MySQL`);
//   return result;
// }

// ---------------------------------------------------------------------------
// Demo implementation (for local testing without a real database)
// Replace with the MySQL implementation above for production.
// ---------------------------------------------------------------------------

export async function lookupUsers(
  userIds: string[]
): Promise<Map<string, UserRecord>> {
  const result = new Map<string, UserRecord>();

  for (const id of userIds) {
    // Generate deterministic demo data from user_id
    const num = parseInt(id.replace(/\D/g, "")) || 0;
    result.set(id, {
      user_id: id,
      first_name: ["Nikhil", "Priya", "Rahul", "Anita", "Vikram"][num % 5],
      last_name: ["Singh", "Sharma", "Patel", "Gupta", "Kumar"][num % 5],
      email: `user-${id}@example.com`,
      phone: `+9198765${String(num).padStart(5, "0")}`,
      company_name: ["Acme Corp", "Tata Digital", "Infosys", "Reliance", "Wipro"][num % 5],
    });
  }

  console.log(`[UserLookup] Resolved ${result.size}/${userIds.length} users (demo mode)`);
  return result;
}
