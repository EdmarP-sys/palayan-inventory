const { createClient } = require('@libsql/client');
const crypto = require('crypto');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:inventory.db',
  authToken: process.env.TURSO_AUTH_TOKEN
});

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  if (!storedPassword) return false;
  const parts = storedPassword.split(':');
  if (parts.length !== 2) {
    // Fallback to legacy SHA-256 for backward compatibility with initial seeds
    const oldHash = crypto.createHash('sha256').update(password).digest('hex');
    return oldHash === storedPassword;
  }
  const [salt, originalHash] = parts;
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return hash === originalHash;
}

async function initDb() {
  // Create tables
  await client.execute(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_name TEXT,
      article TEXT,
      description TEXT,
      property_number TEXT,
      quantity INTEGER,
      unit TEXT,
      unit_value REAL,
      total_value REAL,
      date_acquired TEXT,
      remarks TEXT,
      accountable_officer TEXT,
      status TEXT,
      raw_row TEXT
    )
  `);

  await client.execute(`CREATE INDEX IF NOT EXISTS idx_sheet_name ON items(sheet_name)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_property_number ON items(property_number)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_status ON items(status)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_accountable ON items(accountable_officer)`);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password_hash TEXT,
      role TEXT,
      status TEXT DEFAULT 'approved'
    )
  `);

  // Migration for existing tables: add status column if it doesn't exist
  try {
    await client.execute("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'approved'");
    console.log("Migration: Added status column to users table.");
  } catch (err) {
    // Ignore duplicate column name error
    if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
      console.log("Migration note (status column):", err.message);
    }
  }

  await client.execute(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      action TEXT,
      timestamp TEXT,
      details TEXT
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT,
      expire INTEGER
    )
  `);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire)`);

  // Seed default users if they don't exist
  const checkRes = await client.execute("SELECT count(*) as count FROM users");
  const count = checkRes.rows[0].count;
  
  if (count === 0) {
    const usersToSeed = [
      { username: 'admin', password: 'adminpassword', role: 'admin', status: 'approved' },
      { username: 'employee', password: 'employeepassword', role: 'employee', status: 'approved' }
    ];
    
    const seedQueries = usersToSeed.map(user => ({
      sql: "INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, ?, ?)",
      args: [user.username, hashPassword(user.password), user.role, user.status]
    }));
    
    await client.batch(seedQueries, 'write');
    console.log('Seeded default users.');
  } else {
    console.log('Users already exist in database, skipping seeding.');
  }
}

module.exports = {
  client,
  initDb,
  hashPassword,
  verifyPassword
};
