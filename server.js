const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const { supabase, hashPassword, verifyPassword, initDb } = require('./db');
const { importExcel } = require('./importer');

const app = express();
const port = process.env.PORT || 3000;

// Custom Supabase Session Store
class SupabaseStore extends session.Store {
  constructor(options) {
    super(options);
  }
  
  async get(sid, callback) {
    try {
      const { data, error } = await supabase
        .from('sessions')
        .select('sess')
        .eq('sid', sid)
        .gt('expire', Math.floor(Date.now() / 1000))
        .maybeSingle();
      if (error) return callback(error);
      if (!data) return callback(null, null);
      callback(null, JSON.parse(data.sess));
    } catch (err) {
      callback(err);
    }
  }
  
  async set(sid, sessionData, callback) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge ? sessionData.cookie.maxAge : 1000 * 60 * 60 * 24 * 2;
      const expire = Math.floor((Date.now() + maxAge) / 1000);
      const sessStr = JSON.stringify(sessionData);
      const { error } = await supabase
        .from('sessions')
        .upsert({ sid, sess: sessStr, expire });
      if (error) return callback(error);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
  
  async destroy(sid, callback) {
    try {
      const { error } = await supabase
        .from('sessions')
        .delete()
        .eq('sid', sid);
      if (error) return callback(error);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

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

// Configure session using database store
app.use(session({
  store: new SupabaseStore(),
  secret: 'palayan-city-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 2, // 2 days (48 hours)
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// Lazy database initialization middleware for serverless/Vercel
let dbInitPromise = null;
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    if (!dbInitPromise) {
      dbInitPromise = initDb().then(() => {
        console.log('Database connection and seed successfully verified.');
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
    await supabase
      .from('audit_logs')
      .insert({ username, action, timestamp, details });
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
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .maybeSingle();
      
    if (error) throw error;
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
    const { data: existing, error: checkErr } = await supabase
      .from('users')
      .select('id')
      .ilike('username', trimmedUser)
      .maybeSingle();
      
    if (checkErr) throw checkErr;
    if (existing) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }
    
    // Insert pending employee account
    const pHash = hashPassword(trimmedPass);
    const { error: insertErr } = await supabase
      .from('users')
      .insert({ username: trimmedUser, password_hash: pHash, role: 'employee', status: 'pending' });
      
    if (insertErr) throw insertErr;
    
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
    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, role, status')
      .order('username', { ascending: true });
      
    if (error) throw error;
    res.json({ users: users || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// APPROVE USER (admin only)
app.post('/api/admin/users/:id/approve', requireRole(['admin']), async (req, res) => {
  const targetId = req.params.id;
  
  try {
    const { data: user, error: getErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', targetId)
      .maybeSingle();
      
    if (getErr) throw getErr;
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    
    const { error: updateErr } = await supabase
      .from('users')
      .update({ status: 'approved' })
      .eq('id', targetId);
      
    if (updateErr) throw updateErr;
    
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
    const { data: user, error: getErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', targetId)
      .maybeSingle();
      
    if (getErr) throw getErr;
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    
    // Prevent admin from deleting themselves
    if (user.username === req.session.user.username) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }
    
    const { error: deleteErr } = await supabase
      .from('users')
      .delete()
      .eq('id', targetId);
      
    if (deleteErr) throw deleteErr;
    
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
    const { data: user, error: getErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', targetId)
      .maybeSingle();
      
    if (getErr) throw getErr;
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    
    // Prevent admin from demoting themselves
    if (user.username === req.session.user.username && role !== 'admin') {
      return res.status(400).json({ error: 'You cannot demote yourself from the admin role.' });
    }
    
    const { error: updateErr } = await supabase
      .from('users')
      .update({ role })
      .eq('id', targetId);
      
    if (updateErr) throw updateErr;
    
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
    // Read all items to compute valuations, status breakdowns, and department breakdowns
    const { data: items, error: itemsErr } = await supabase
      .from('items')
      .select('total_value, status, sheet_name');
      
    if (itemsErr) throw itemsErr;
    
    const totalItems = items ? items.length : 0;
    const totalValuation = items ? items.reduce((sum, item) => sum + (item.total_value || 0), 0) : 0;
    
    // Status breakdown
    const statusMap = {};
    (items || []).forEach(item => {
      const status = item.status || 'Active';
      if (!statusMap[status]) {
        statusMap[status] = { status, count: 0, val: 0 };
      }
      statusMap[status].count += 1;
      statusMap[status].val += (item.total_value || 0);
    });
    const statusBreakdown = Object.values(statusMap);
    
    // Department breakdown
    const deptMap = {};
    (items || []).forEach(item => {
      const dept = item.sheet_name;
      if (!dept) return;
      if (!deptMap[dept]) {
        deptMap[dept] = { sheet_name: dept, count: 0, val: 0 };
      }
      deptMap[dept].count += 1;
      deptMap[dept].val += (item.total_value || 0);
    });
    const departmentBreakdown = Object.values(deptMap)
      .sort((a, b) => b.val - a.val)
      .slice(0, 10);
      
    // Recent logs (For Admin view)
    let auditLogs = [];
    if (req.session.user.role === 'admin') {
      const { data: logs, error: logsErr } = await supabase
        .from('audit_logs')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(20);
        
      if (logsErr) throw logsErr;
      auditLogs = logs || [];
    }
    
    res.json({
      summary: {
        totalItems,
        totalValuation
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
    const { data, error } = await supabase
      .from('items')
      .select('sheet_name');
      
    if (error) throw error;
    
    const uniqueDepts = Array.from(new Set((data || []).map(r => r.sheet_name).filter(Boolean))).sort();
    res.json({ departments: uniqueDepts });
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
  
  try {
    // 1. Get exact total count of matching rows
    let countQuery = supabase.from('items').select('*', { count: 'exact', head: true });
    
    if (search) {
      countQuery = countQuery.or(`article.ilike.%${search}%,description.ilike.%${search}%,property_number.ilike.%${search}%,accountable_officer.ilike.%${search}%,remarks.ilike.%${search}%`);
    }
    if (department) {
      countQuery = countQuery.eq('sheet_name', department);
    }
    if (status) {
      countQuery = countQuery.eq('status', status);
    }
    
    const { count: totalItems, error: countErr } = await countQuery;
    if (countErr) throw countErr;
    
    // 2. Fetch the actual items
    let itemsQuery = supabase.from('items').select('*');
    
    if (search) {
      itemsQuery = itemsQuery.or(`article.ilike.%${search}%,description.ilike.%${search}%,property_number.ilike.%${search}%,accountable_officer.ilike.%${search}%,remarks.ilike.%${search}%`);
    }
    if (department) {
      itemsQuery = itemsQuery.eq('sheet_name', department);
    }
    if (status) {
      itemsQuery = itemsQuery.eq('status', status);
    }
    
    itemsQuery = itemsQuery
      .order(sortBy, { ascending: sortOrder.toUpperCase() === 'ASC' })
      .range(offset, offset + limit - 1);
      
    const { data: items, error: itemsErr } = await itemsQuery;
    if (itemsErr) throw itemsErr;
    
    res.json({
      items: items || [],
      pagination: {
        page,
        limit,
        totalItems: totalItems || 0,
        totalPages: Math.ceil((totalItems || 0) / limit)
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
    const { data: existing, error: checkErr } = await supabase
      .from('items')
      .select('id')
      .eq('property_number', property_number.trim())
      .maybeSingle();
      
    if (checkErr) throw checkErr;
    if (existing) {
      return res.status(400).json({ error: `Property number '${property_number}' already exists (ID: ${existing.id}).` });
    }
    
    const { data: inserted, error: insertErr } = await supabase
      .from('items')
      .insert({
        sheet_name: sheet_name.trim(),
        article: article.trim(),
        description: (description || '').trim(),
        property_number: property_number.trim(),
        quantity: qty,
        unit: unit || null,
        unit_value: uv,
        total_value: tv,
        date_acquired: (date_acquired || '').trim(),
        remarks: (remarks || '').trim(),
        accountable_officer: (accountable_officer || '').trim(),
        status: status || 'Active'
      })
      .select('id')
      .single();
      
    if (insertErr) throw insertErr;
    const newId = inserted ? inserted.id : null;
    
    await logAction(
      req.session.user.username,
      'CREATE',
      `Created item ID ${newId}: ${article} (Property Code: ${property_number})`
    );
    
    res.status(201).json({ message: 'Item created successfully.', id: newId });
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
    const { data: item, error: getErr } = await supabase
      .from('items')
      .select('*')
      .eq('id', id)
      .maybeSingle();
      
    if (getErr) throw getErr;
    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    
    // Check if property number is taken by another item
    const { data: existing, error: checkErr } = await supabase
      .from('items')
      .select('id')
      .eq('property_number', property_number.trim())
      .neq('id', id)
      .maybeSingle();
      
    if (checkErr) throw checkErr;
    if (existing) {
      return res.status(400).json({ error: `Property number '${property_number}' is already taken by item ID: ${existing.id}.` });
    }
    
    const { error: updateErr } = await supabase
      .from('items')
      .update({
        sheet_name: sheet_name.trim(),
        article: article.trim(),
        description: (description || '').trim(),
        property_number: property_number.trim(),
        quantity: qty,
        unit: unit || null,
        unit_value: uv,
        total_value: tv,
        date_acquired: (date_acquired || '').trim(),
        remarks: (remarks || '').trim(),
        accountable_officer: (accountable_officer || '').trim(),
        status: status || 'Active'
      })
      .eq('id', id);
      
    if (updateErr) throw updateErr;
    
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
    const { data: item, error: getErr } = await supabase
      .from('items')
      .select('*')
      .eq('id', id)
      .maybeSingle();
      
    if (getErr) throw getErr;
    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    
    const { error: deleteErr } = await supabase
      .from('items')
      .delete()
      .eq('id', id);
      
    if (deleteErr) throw deleteErr;
    
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
    
    const { data: items, error } = await supabase
      .from('items')
      .select('*')
      .order('sheet_name', { ascending: true })
      .order('id', { ascending: true });
      
    if (error) throw error;
    
    // Group items by sheet_name
    const sheetsData = {};
    (items || []).forEach(item => {
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
    const { data: logs, error } = await supabase
      .from('audit_logs')
      .select('*')
      .order('timestamp', { ascending: false });
      
    if (error) throw error;
    res.json({ logs: logs || [] });
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
