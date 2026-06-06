import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME || 'jules_supervisor',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

export async function runSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  
  // Clean up statements
  const statements = schemaSql
    .split(';')
    .map(st => st.trim())
    .filter(st => {
      if (!st) return false;
      if (st.startsWith('--') || st.startsWith('/*')) return false;
      // Skip CREATE DATABASE and USE statements to ensure compatibility with restricted Hostinger database users
      const upper = st.toUpperCase();
      if (upper.startsWith('CREATE DATABASE') || upper.startsWith('USE ')) return false;
      return true;
    });

  const connection = await pool.getConnection();
  try {
    for (const statement of statements) {
      await connection.query(statement);
    }
    console.log('Database schema checked/initialized successfully.');
  } catch (error) {
    console.error('Error initializing database schema:', error);
    throw error;
  } finally {
    connection.release();
  }
}
