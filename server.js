const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const { client, hashPassword, verifyPassword, initDb } = require('./db');
const { importExcel } = require('./importer');

const app = express();
const port = 3000;

// Setup directories
const uploadDir = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'uploads');
if (!process.env.VERCEL && !fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Multer storage configuration for Excel upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, 'upload_' + Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configure session
app.use(session({
  secret: 'palayan-city-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 // 24 hours
  }
}));

// Lazy database initialization middleware for serverless/Vercel
let dbInitPromise = null;
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    if (!dbInitPromise) {
      dbInitPromise = initDb().then(() => {
        console.log('Database schema successfully initialized/migrated.');
      }).catch(err => {
        console.error('Database initialization failed:', err);
        dbInitPromise = null; // Reset to retry on next request
        next(err);
      });
    }
    dbInitPromise.then(() => next()).catch(next);
  } else {
    next();
  }
});

// LibSQL DB helpers mapping
const dbAll = async (sql, params = []) => {
  const res = await client.execute({ sql, args: params });
  return res.rows;
};

const dbGet = async (sql, params = []) => {
  const res = await client.execute({ sql, args: params });
  return res.rows[0];
};

const dbRun = async (sql, params = []) => {
  const res = await client.execute({ sql, args: params });
  return { 
    lastID: res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : null, 
    changes: res.rowsAffected 
  };
};

// Middleware to protect routes and verify login
const requireLogin = (req, res, next) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }
  next();
};

// Middleware to check roles: viewer, employee, admin
const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    const role = req.session.user.role;
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({ error: 'Permission denied. Insufficient privileges.' });
    }
    next();
  };
};

// Log action helper
async function logAction(username, action, details) {
  const timestamp = new Date().toISOString();
  try {
    await dbRun(
      "INSERT INTO audit_logs (username, action, timestamp, details) VALUES (?, ?, ?, ?)",
      [username, action, timestamp, details]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

// ================= AUTHENTICATION & USER MANAGEMENT ENDPOINTS =================

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  
  try {
    const user = await dbGet("SELECT * FROM users WHERE username = ?", [username]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    
    // Check if user status is pending
    if (user.status === 'pending') {
      return res.status(403).json({ error: 'Your account is pending approval by an administrator.' });
    }
    
    // Check password using pbkdf2 verifier
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    
    req.session.user = {
      username: user.username,
      role: user.role
    };
    
    res.json({ message: 'Login successful.', user: req.session.user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  
  const trimmedUser = username.trim();
  const trimmedPass = password.trim();
  
  // Validation checks:
  // 1. Username alphanumeric, underscores, hyphens, 3 to 30 chars
  const usernameRegex = /^[a-zA-Z0-9_-]{3,30}$/;
  if (!usernameRegex.test(trimmedUser)) {
    return res.status(400).json({ error: 'Username must be 3-30 characters long and contain only letters, numbers, underscores, or hyphens.' });
  }
  
  // 2. Password minimum 8 characters
  if (trimmedPass.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }
  
  try {
    // Check if username is taken (case-insensitive)
    const existing = await dbGet("SELECT id FROM users WHERE LOWER(username) = LOWER(?)", [trimmedUser]);
    if (existing) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }
    
    // Insert pending employee account
    const pHash = hashPassword(trimmedPass);
    const sql = "INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, 'employee', 'pending')";
    await dbRun(sql, [trimmedUser, pHash]);
    
    // Log the registration attempt
    await logAction('system', 'REGISTER', `New user registration request: '${trimmedUser}' (pending approval)`);
    
    res.status(201).json({ message: 'Registration submitted successfully. Please wait for an administrator to approve your account.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Could not log out.' });
    }
    res.json({ message: 'Logout successful.' });
  });
});

app.get('/api/me', (req, res) => {
  if (req.session.user) {
    res.json({ user: req.session.user });
  } else {
    res.json({ user: null });
  }
});

// GET ALL USERS (admin only)
app.get('/api/admin/users', requireRole(['admin']), async (req, res) => {
  try {
    const users = await dbAll("SELECT id, username, role, status FROM users ORDER BY username ASC");
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// APPROVE USER (admin only)
app.post('/api/admin/users/:id/approve', requireRole(['admin']), async (req, res) => {
  const targetId = req.params.id;
  
  try {
    const user = await dbGet("SELECT * FROM users WHERE id = ?", [targetId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    
    await dbRun("UPDATE users SET status = 'approved' WHERE id = ?", [targetId]);
    
    await logAction(
      req.session.user.username,
      'APPROVE_USER',
      `Approved user account: '${user.username}' (ID: ${targetId})`
    );
    
    res.json({ message: `User '${user.username}' approved successfully.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE/REJECT USER (admin only)
app.delete('/api/admin/users/:id', requireRole(['admin']), async (req, res) => {
  const targetId = req.params.id;
  
  try {
    const user = await dbGet("SELECT * FROM users WHERE id = ?", [targetId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    
    // Prevent admin from deleting themselves
    if (user.username === req.session.user.username) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }
    
    await dbRun("DELETE FROM users WHERE id = ?", [targetId]);
    
    await logAction(
      req.session.user.username,
      'DELETE_USER',
      `Deleted/Rejected user account: '${user.username}' (ID: ${targetId})`
    );
    
    res.json({ message: `User '${user.username}' deleted/rejected successfully.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE USER ROLE (admin only)
app.post('/api/admin/users/:id/role', requireRole(['admin']), async (req, res) => {
  const targetId = req.params.id;
  const { role } = req.body;
  
  if (!role || !['employee', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be employee or admin.' });
  }
  
  try {
    const user = await dbGet("SELECT * FROM users WHERE id = ?", [targetId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    
    // Prevent admin from demoting themselves
    if (user.username === req.session.user.username && role !== 'admin') {
      return res.status(400).json({ error: 'You cannot demote yourself from the admin role.' });
    }
    
    await dbRun("UPDATE users SET role = ? WHERE id = ?", [role, targetId]);
    
    await logAction(
      req.session.user.username,
      'UPDATE_USER_ROLE',
      `Updated role of '${user.username}' to '${role}'`
    );
    
    res.json({ message: `User '${user.username}' role updated to '${role}'.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ================= DASHBOARD & STATS =================

app.get('/api/dashboard', requireLogin, async (req, res) => {
  try {
    // 1. Total items count & valuation
    const summary = await dbGet("SELECT count(*) as count, sum(total_value) as val FROM items");
    
    // 2. Status Breakdown
    const statusBreakdown = await dbAll("SELECT status, count(*) as count, sum(total_value) as val FROM items GROUP BY status");
    
    // 3. Top 10 Departments by Valuation
    const departmentBreakdown = await dbAll(
      "SELECT sheet_name, count(*) as count, sum(total_value) as val FROM items GROUP BY sheet_name ORDER BY val DESC LIMIT 10"
    );
    
    // 4. Recent Logs (For Admin view)
    let auditLogs = [];
    if (req.session.user.role === 'admin') {
      auditLogs = await dbAll("SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 20");
    }
    
    res.json({
      summary: {
        totalItems: summary.count || 0,
        totalValuation: summary.val || 0
      },
      statusBreakdown,
      departmentBreakdown,
      auditLogs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/departments', requireLogin, async (req, res) => {
  try {
    const rows = await dbAll("SELECT DISTINCT sheet_name FROM items ORDER BY sheet_name ASC");
    res.json({ departments: rows.map(r => r.sheet_name) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ================= INVENTORY CRUD ENDPOINTS =================

// READ (Paginated, filtered, searched)
app.get('/api/inventory', requireLogin, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';
  const department = req.query.department || '';
  const status = req.query.status || '';
  const sortBy = req.query.sortBy || 'id';
  const sortOrder = req.query.sortOrder || 'DESC';
  
  // Whitelist sort columns to prevent SQL Injection
  const allowedSortCols = ['id', 'sheet_name', 'article', 'description', 'property_number', 'quantity', 'unit_value', 'total_value', 'date_acquired', 'status', 'accountable_officer'];
  if (!allowedSortCols.includes(sortBy)) {
    return res.status(400).json({ error: 'Invalid sort column.' });
  }
  
  const sortDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  
  // Build query
  let sqlConditions = [];
  let sqlParams = [];
  
  if (search) {
    sqlConditions.push("(article LIKE ? OR description LIKE ? OR property_number LIKE ? OR accountable_officer LIKE ? OR remarks LIKE ?)");
    const searchTerm = `%${search}%`;
    sqlParams.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
  }
  if (department) {
    sqlConditions.push("sheet_name = ?");
    sqlParams.push(department);
  }
  if (status) {
    sqlConditions.push("status = ?");
    sqlParams.push(status);
  }
  
  const whereClause = sqlConditions.length > 0 ? "WHERE " + sqlConditions.join(" AND ") : "";
  
  try {
    // Get total count for pagination
    const countSql = `SELECT count(*) as count FROM items ${whereClause}`;
    const countResult = await dbGet(countSql, sqlParams);
    const totalItems = countResult.count;
    
    // Get items
    const querySql = `
      SELECT * FROM items 
      ${whereClause} 
      ORDER BY ${sortBy} ${sortDir} 
      LIMIT ? OFFSET ?
    `;
    const items = await dbAll(querySql, [...sqlParams, limit, offset]);
    
    res.json({
      items,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CREATE (employee & admin)
app.post('/api/inventory', requireRole(['employee', 'admin']), async (req, res) => {
  const { sheet_name, article, description, property_number, quantity, unit, unit_value, total_value, date_acquired, remarks, accountable_officer, status } = req.body;
  
  if (!sheet_name || !article || !property_number) {
    return res.status(400).json({ error: 'Department, Article name, and Property number are required.' });
  }
  
  const qty = parseInt(quantity) || 1;
  const uv = parseFloat(unit_value) || 0;
  const tv = parseFloat(total_value) || (qty * uv);
  
  try {
    // Check if property number already exists in DB
    const existing = await dbGet("SELECT id FROM items WHERE property_number = ?", [property_number.trim()]);
    if (existing) {
      return res.status(400).json({ error: `Property number '${property_number}' already exists (ID: ${existing.id}).` });
    }
    
    const sql = `
      INSERT INTO items (sheet_name, article, description, property_number, quantity, unit, unit_value, total_value, date_acquired, remarks, accountable_officer, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const params = [
      sheet_name.trim(),
      article.trim(),
      (description || '').trim(),
      property_number.trim(),
      qty,
      unit || null,
      uv,
      tv,
      (date_acquired || '').trim(),
      (remarks || '').trim(),
      (accountable_officer || '').trim(),
      status || 'Active'
    ];
    
    const result = await dbRun(sql, params);
    
    await logAction(
      req.session.user.username,
      'CREATE',
      `Created item ID ${result.lastID}: ${article} (Property Code: ${property_number})`
    );
    
    res.status(201).json({ message: 'Item created successfully.', id: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE (employee & admin)
app.put('/api/inventory/:id', requireRole(['employee', 'admin']), async (req, res) => {
  const id = req.params.id;
  const { sheet_name, article, description, property_number, quantity, unit, unit_value, total_value, date_acquired, remarks, accountable_officer, status } = req.body;
  
  if (!sheet_name || !article || !property_number) {
    return res.status(400).json({ error: 'Department, Article name, and Property number are required.' });
  }
  
  const qty = parseInt(quantity) || 1;
  const uv = parseFloat(unit_value) || 0;
  const tv = parseFloat(total_value) || (qty * uv);
  
  try {
    // Check if item exists
    const item = await dbGet("SELECT * FROM items WHERE id = ?", [id]);
    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    
    // Check if property number is taken by another item
    const existing = await dbGet("SELECT id FROM items WHERE property_number = ? AND id != ?", [property_number.trim(), id]);
    if (existing) {
      return res.status(400).json({ error: `Property number '${property_number}' is already taken by item ID: ${existing.id}.` });
    }
    
    const sql = `
      UPDATE items SET 
        sheet_name = ?, article = ?, description = ?, property_number = ?, 
        quantity = ?, unit = ?, unit_value = ?, total_value = ?, 
        date_acquired = ?, remarks = ?, accountable_officer = ?, status = ?
      WHERE id = ?
    `;
    
    const params = [
      sheet_name.trim(),
      article.trim(),
      (description || '').trim(),
      property_number.trim(),
      qty,
      unit || null,
      uv,
      tv,
      (date_acquired || '').trim(),
      (remarks || '').trim(),
      (accountable_officer || '').trim(),
      status || 'Active',
      id
    ];
    
    await dbRun(sql, params);
    
    await logAction(
      req.session.user.username,
      'UPDATE',
      `Updated item ID ${id}: Changed from '${item.article}' to '${article}'`
    );
    
    res.json({ message: 'Item updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE (employee & admin)
app.delete('/api/inventory/:id', requireRole(['employee', 'admin']), async (req, res) => {
  const id = req.params.id;
  
  try {
    const item = await dbGet("SELECT * FROM items WHERE id = ?", [id]);
    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    
    await dbRun("DELETE FROM items WHERE id = ?", [id]);
    
    await logAction(
      req.session.user.username,
      'DELETE',
      `Deleted item ID ${id}: ${item.article} (Property Code: ${item.property_number})`
    );
    
    res.json({ message: 'Item deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ================= ADMIN ACTIONS: IMPORT & EXPORT =================

// EXPORT TO EXCEL (employee & admin)
app.get('/api/export', requireRole(['employee', 'admin']), async (req, res) => {
  try {
    console.log('Building Excel workbook export...');
    
    // Read all items
    const items = await dbAll("SELECT * FROM items ORDER BY sheet_name ASC, id ASC");
    
    // Group items by sheet_name
    const sheetsData = {};
    items.forEach(item => {
      if (!sheetsData[item.sheet_name]) {
        sheetsData[item.sheet_name] = [];
      }
      
      sheetsData[item.sheet_name].push({
        'Article': item.article,
        'Description': item.description,
        'Property Number': item.property_number,
        'Quantity': item.quantity,
        'Unit Value': item.unit_value,
        'Total Value': item.total_value,
        'Date Acquired': item.date_acquired,
        'Remarks': item.remarks,
        'Accountable Officer': item.accountable_officer,
        'Status': item.status
      });
    });
    
    // Create Excel Workbook
    const wb = xlsx.utils.book_new();
    
    Object.keys(sheetsData).forEach(sheetName => {
      // Limit sheet names to 31 chars (Excel limit)
      const excelSheetName = sheetName.substring(0, 30);
      const ws = xlsx.utils.json_to_sheet(sheetsData[sheetName]);
      xlsx.utils.book_append_sheet(wb, ws, excelSheetName);
    });
    
    // Write workbook to buffer
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    const filename = `Inventory_Export_${new Date().toISOString().split('T')[0]}.xlsx`;
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(buf);
    
    await logAction(req.session.user.username, 'EXPORT', 'Exported full inventory database to Excel workbook.');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// IMPORT FROM EXCEL (admin only)
app.post('/api/import', requireRole(['admin']), upload.single('excelFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No Excel file was uploaded.' });
  }
  
  const filePath = req.file.path;
  
  try {
    const importedCount = await importExcel(filePath, req.session.user.username);
    
    // Remove temporary uploaded file
    fs.unlinkSync(filePath);
    
    res.json({ message: `Successfully imported ${importedCount} items and rebuilt inventory database.` });
  } catch (err) {
    // Cleanup on error
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.status(500).json({ error: 'Excel import failed: ' + err.message });
  }
});

// GET AUDIT LOGS (admin only)
app.get('/api/audit-logs', requireRole(['admin']), async (req, res) => {
  try {
    const logs = await dbAll("SELECT * FROM audit_logs ORDER BY timestamp DESC");
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Start server
if (!process.env.VERCEL) {
  initDb().then(() => {
    app.listen(port, () => {
      console.log(`Inventory server is running at http://localhost:${port}`);
    });
  }).catch(err => {
    console.error('Failed to initialize database schema:', err);
  });
}

module.exports = app;
