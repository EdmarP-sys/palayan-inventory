const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Safe custom environment variable loader (replaces dotenv dependency)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const index = trimmed.indexOf('=');
      if (index > 0) {
        const key = trimmed.substring(0, index).trim();
        const value = trimmed.substring(index + 1).trim().replace(/^["']|["']$/g, '');
        if (key && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    });
  }
} catch (e) {
  console.warn('Error loading local .env file:', e.message);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const supabaseSchema = process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'traffic';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn("Warning: Supabase environment variables are not set in the environment!");
}

const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co', 
  supabaseAnonKey || 'placeholder', 
  {
    db: {
      schema: supabaseSchema
    },
    global: {
      headers: {
        'ngrok-skip-browser-warning': 'true'
      }
    }
  }
);

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
  console.log('Verifying default database seed in Supabase...');
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('id')
      .limit(1);
    
    if (error) {
      console.error('Error accessing users table in Supabase:', error.message);
      return;
    }
    
    if (!users || users.length === 0) {
      console.log('No users found in database. Seeding default users...');
      const usersToSeed = [
        { username: 'admin', password_hash: hashPassword('adminpassword'), role: 'admin', status: 'approved' },
        { username: 'employee', password_hash: hashPassword('employeepassword'), role: 'employee', status: 'approved' }
      ];
      
      const { error: insertError } = await supabase
        .from('users')
        .insert(usersToSeed);
      
      if (insertError) {
        console.error('Failed to seed default users:', insertError.message);
      } else {
        console.log('Seeded default users successfully.');
      }
    } else {
      console.log('Users already exist in database, skipping seeding.');
    }
  } catch (err) {
    console.error('Database initialization hook error:', err.message);
  }
}

module.exports = {
  supabase,
  initDb,
  hashPassword,
  verifyPassword
};
