import mysql from 'mysql2/promise';

// Single shared connection pool. No ORM — hand-written parameterized SQL per
// CLAUDE.md ("avoid unnecessary abstraction", "escape SQL parameters").
export const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'champpower',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: false,
});
