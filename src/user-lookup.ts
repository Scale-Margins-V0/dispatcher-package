/**
 * User ID to PII Lookup
 *
 * This module maps pseudonymous user_ids from ScaleMargin
 * to actual PII (name, email, phone) from your database.
 *
 * CUSTOMIZE THIS FILE for your database. The reference implementation
 * uses an in-memory Map for demonstration. Replace with your actual
 * database queries (PostgreSQL, MySQL, DynamoDB, etc.).
 */

export interface UserRecord {
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  company_name?: string;
}

/**
 * Look up users by their IDs.
 *
 * REPLACE THIS with your actual database query:
 *   - PostgreSQL: SELECT * FROM users WHERE id = ANY($1)
 *   - DynamoDB: BatchGetItem
 *   - MySQL: SELECT * FROM users WHERE id IN (...)
 */
export async function lookupUsers(
  userIds: string[]
): Promise<Map<string, UserRecord>> {
  const result = new Map<string, UserRecord>();

  // --- REPLACE THIS WITH YOUR DATABASE QUERY ---
  //
  // Example with PostgreSQL (using pg):
  //
  //   import { pool } from './db.js';
  //   const { rows } = await pool.query(
  //     'SELECT id as user_id, first_name, last_name, email, phone, company_name FROM users WHERE id = ANY($1)',
  //     [userIds]
  //   );
  //   for (const row of rows) {
  //     result.set(row.user_id, row);
  //   }
  //
  // Example with DynamoDB:
  //
  //   import { DynamoDBClient, BatchGetItemCommand } from '@aws-sdk/client-dynamodb';
  //   const client = new DynamoDBClient({});
  //   const keys = userIds.map(id => ({ user_id: { S: id } }));
  //   // ... BatchGetItem logic ...

  // Demo: return placeholder records for any user_id
  for (const id of userIds) {
    result.set(id, {
      user_id: id,
      first_name: "Demo",
      last_name: "User",
      email: `demo-${id}@example.com`,
      phone: "+919876543210",
      company_name: "Demo Corp",
    });
  }

  console.log(`[UserLookup] Resolved ${result.size}/${userIds.length} users`);
  return result;
}
