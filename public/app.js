// ================= PALAYAN CITY INVENTORY APP LOGIC =================

// State Management
let currentUser = null;
let currentView = 'dashboard-view';
let departmentChart = null;
let statusChart = null;

// Inventory Table State
let inventoryPage = 1;
let inventoryLimit = 25;
let inventorySortBy = 'id';
let inventorySortOrder = 'DESC';

// Cache for suggestion lists
let departmentsList = [];

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  checkSession();
  setupEventListeners();
});

// Check if user has active session
async function checkSession() {
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (data.user) {
      loginSuccess(data.user);
    } else {
      showLoginScreen();
    }
  } catch (err) {
    console.error('Session check failed:', err);
    showLoginScreen();
  }
}

// Setup Event Listeners
function setupEventListeners() {
  // Login Form
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  
  // Logout Button
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  
  // Sidebar Navigation
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const target = e.currentTarget.getAttribute('data-target');
      switchView(target);
    });
  });
  
  // Filters & Search
  const searchInput = document.getElementById('search-input');
  const filterDept = document.getElementById('filter-dept');
  const filterStatus = document.getElementById('filter-status');
  
  let searchTimeout = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      inventoryPage = 1;
      loadInventoryTable();
    }, 400);
  });
  
  filterDept.addEventListener('change', () => {
    inventoryPage = 1;
    loadInventoryTable();
  });
  
  filterStatus.addEventListener('change', () => {
    inventoryPage = 1;
    loadInventoryTable();
  });
  
  document.getElementById('clear-filters-btn').addEventListener('click', () => {
    searchInput.value = '';
    filterDept.value = '';
    filterStatus.value = '';
    inventoryPage = 1;
    loadInventoryTable();
  });
  
  // Sorting columns
  document.querySelectorAll('.data-table th.sortable').forEach(th => {
    th.addEventListener('click', (e) => {
      const col = e.currentTarget.getAttribute('data-col');
      if (inventorySortBy === col) {
        inventorySortOrder = inventorySortOrder === 'ASC' ? 'DESC' : 'ASC';
      } else {
        inventorySortBy = col;
        inventorySortOrder = 'ASC';
      }
      
      // Update icons
      document.querySelectorAll('.data-table th.sortable i').forEach(icon => {
        icon.className = 'fa-solid fa-sort';
      });
      const icon = e.currentTarget.querySelector('i');
      icon.className = inventorySortOrder === 'ASC' ? 'fa-solid fa-sort-up' : 'fa-solid fa-sort-down';
      
      loadInventoryTable();
    });
  });
  
  // Pagination buttons
  document.getElementById('pagination-prev').addEventListener('click', () => {
    if (inventoryPage > 1) {
      inventoryPage--;
      loadInventoryTable();
    }
  });
  
  document.getElementById('pagination-next').addEventListener('click', () => {
    inventoryPage++;
    loadInventoryTable();
  });
  
  // Modal close buttons
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modalId = e.currentTarget.getAttribute('data-close');
      closeModal(modalId);
    });
  });
  
  // Add Asset Modal trigger
  document.getElementById('add-asset-btn').addEventListener('click', () => {
    openAssetModal();
  });
  
  // Asset Modal Form Submit
  document.getElementById('asset-form').addEventListener('submit', handleAssetSubmit);
  
  // Auto-calculate total value in modal
  const qtyInput = document.getElementById('asset-qty');
  const valInput = document.getElementById('asset-val');
  const totalInput = document.getElementById('asset-total');
  
  const autoComputeTotal = () => {
    const q = parseInt(qtyInput.value) || 0;
    const v = parseFloat(valInput.value) || 0;
    totalInput.value = (q * v).toFixed(2);
  };
  
  qtyInput.addEventListener('input', autoComputeTotal);
  valInput.addEventListener('input', autoComputeTotal);
  
  // Delete item confirm action
  document.getElementById('confirm-delete-btn').addEventListener('click', executeDeleteItem);
  
  // Admin triggers
  document.getElementById('sidebar-export-btn').addEventListener('click', () => {
    window.location.href = '/api/export';
  });
  
  document.getElementById('sidebar-import-btn').addEventListener('click', () => {
    openModal('import-modal');
  });
  
  document.getElementById('import-form').addEventListener('submit', handleExcelImport);
}

// ================= ROUTING & VISIBILITY =================

function showLoginScreen() {
  document.getElementById('login-container').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
  document.getElementById('login-password').value = '';
}

function loginSuccess(user) {
  currentUser = user;
  document.getElementById('login-container').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
  
  // Profile displays
  document.getElementById('user-display-name').textContent = user.username;
  const roleBadge = document.getElementById('user-display-role');
  roleBadge.textContent = user.role;
  roleBadge.className = `role-badge ${user.role}`;
  
  // Role based UI customizations
  updateRoleVisibility(user.role);
  
  // Reset navigation to Dashboard
  switchView('dashboard-view');
  
  // Load data catalogs
  loadDepartmentsDropdown();
}

function updateRoleVisibility(role) {
  // Hide all role-specific classes first
  document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.employee-only').forEach(el => el.classList.add('hidden'));
  
  if (role === 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
    document.querySelectorAll('.employee-only').forEach(el => el.classList.remove('hidden'));
  } else if (role === 'employee') {
    document.querySelectorAll('.employee-only').forEach(el => el.classList.remove('hidden'));
  }
  // Viewers will see neither class
}

function switchView(viewId) {
  currentView = viewId;
  
  // Toggle active class on sidebar links
  document.querySelectorAll('.nav-link').forEach(link => {
    if (link.getAttribute('data-target') === viewId) {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
  });
  
  // Toggle views panels
  document.querySelectorAll('.view-panel').forEach(panel => {
    if (panel.id === viewId) {
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  });
  
  // Update header titles
  const title = document.getElementById('view-title');
  const subtitle = document.getElementById('view-subtitle');
  
  if (viewId === 'dashboard-view') {
    title.textContent = 'Dashboard';
    subtitle.textContent = 'Summary and analytics of municipal property.';
    loadDashboardData();
  } else if (viewId === 'inventory-view') {
    title.textContent = 'Assets Directory';
    subtitle.textContent = 'Browse, search, and update city registry records.';
    inventoryPage = 1;
    loadInventoryTable();
  } else if (viewId === 'logs-view') {
    title.textContent = 'System Audits';
    subtitle.textContent = 'Track and review property manipulations and administrative actions.';
    loadAuditLogsTable();
  }
}


// ================= AUTHENTICATION HANDLERS =================

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  
  errorEl.classList.add('hidden');
  
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    const data = await res.json();
    if (res.ok) {
      loginSuccess(data.user);
    } else {
      errorEl.textContent = data.error || 'Login failed.';
      errorEl.classList.remove('hidden');
    }
  } catch (err) {
    errorEl.textContent = 'Connection error. Check backend server.';
    errorEl.classList.remove('hidden');
    console.error(err);
  }
}

async function handleLogout() {
  try {
    const res = await fetch('/api/logout', { method: 'POST' });
    if (res.ok) {
      currentUser = null;
      showLoginScreen();
    }
  } catch (err) {
    console.error('Logout failed:', err);
  }
}


// ================= METRICS & CHARTS =================

async function loadDashboardData() {
  try {
    const res = await fetch('/api/dashboard');
    if (!res.ok) throw new Error('Failed to fetch dashboard data');
    const data = await res.json();
    
    // Set text metrics
    document.getElementById('stat-total-items').textContent = data.summary.totalItems.toLocaleString();
    document.getElementById('stat-total-val').textContent = formatCurrency(data.summary.totalValuation);
    
    const unserviceableVal = data.statusBreakdown.find(s => s.status === 'Unserviceable');
    document.getElementById('stat-unserviceable').textContent = unserviceableVal ? unserviceableVal.count.toLocaleString() : '0';
    
    const missingVal = data.statusBreakdown.find(s => s.status === 'Missing');
    const lostVal = data.statusBreakdown.find(s => s.status === 'Lost');
    const totalMissing = (missingVal ? missingVal.count : 0) + (lostVal ? lostVal.count : 0);
    document.getElementById('stat-missing').textContent = totalMissing.toLocaleString();
    
    // Render Charts
    renderCharts(data.departmentBreakdown, data.statusBreakdown);
    
  } catch (err) {
    console.error('Dashboard load error:', err);
  }
}

function renderCharts(depts, statuses) {
  // Theme Color Presets
  const primaryColor = '#3b82f6';
  const colorsList = [
    '#3b82f6', // Blue
    '#10b981', // Emerald
    '#8b5cf6', // Purple
    '#f59e0b', // Amber
    '#ef4444', // Red
    '#06b6d4', // Cyan
    '#ec4899', // Pink
    '#14b8a6', // Teal
    '#f97316', // Orange
    '#64748b'  // Slate
  ];

  // 1. Department Chart (Horizontal Bar Chart)
  if (departmentChart) departmentChart.destroy();
  
  const deptCtx = document.getElementById('departmentChart').getContext('2d');
  departmentChart = new Chart(deptCtx, {
    type: 'bar',
    data: {
      labels: depts.map(d => d.sheet_name),
      datasets: [{
        label: 'Total Value (₱)',
        data: depts.map(d => d.val),
        backgroundColor: primaryColor,
        borderRadius: 6,
        borderWidth: 0
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          ticks: {
            callback: (val) => '₱' + (val / 1000000) + 'M'
          },
          grid: { color: '#f1f5f9' }
        },
        y: {
          grid: { display: false }
        }
      }
    }
  });

  // 2. Status Chart (Doughnut Chart)
  if (statusChart) statusChart.destroy();
  
  const statusCtx = document.getElementById('statusChart').getContext('2d');
  statusChart = new Chart(statusCtx, {
    type: 'doughnut',
    data: {
      labels: statuses.map(s => s.status),
      datasets: [{
        data: statuses.map(s => s.count),
        backgroundColor: colorsList.slice(0, statuses.length),
        borderWidth: 2,
        borderColor: '#ffffff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { boxWidth: 12, font: { size: 11 } }
        }
      },
      cutout: '65%'
    }
  });
}


// ================= DATA LOADING FOR TABLES =================

async function loadDepartmentsDropdown() {
  try {
    const res = await fetch('/api/departments');
    const data = await res.json();
    departmentsList = data.departments;
    
    // Fill select filter
    const select = document.getElementById('filter-dept');
    select.innerHTML = '<option value="">All Departments</option>';
    
    // Fill datalist suggestions for asset create
    const datalist = document.getElementById('dept-suggestions');
    datalist.innerHTML = '';
    
    departmentsList.forEach(dept => {
      const opt = document.createElement('option');
      opt.value = dept;
      opt.textContent = dept;
      select.appendChild(opt);
      
      const suggestOpt = document.createElement('option');
      suggestOpt.value = dept;
      datalist.appendChild(suggestOpt);
    });
  } catch (err) {
    console.error('Failed to load departments drop:', err);
  }
}

async function loadInventoryTable() {
  const tableTbody = document.getElementById('inventory-tbody');
  const loadingEl = document.getElementById('table-loading');
  const emptyEl = document.getElementById('table-empty');
  
  tableTbody.innerHTML = '';
  loadingEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');
  
  const search = document.getElementById('search-input').value.trim();
  const dept = document.getElementById('filter-dept').value;
  const status = document.getElementById('filter-status').value;
  
  const queryParams = new URLSearchParams({
    page: inventoryPage,
    limit: inventoryLimit,
    search,
    department: dept,
    status,
    sortBy: inventorySortBy,
    sortOrder: inventorySortOrder
  });
  
  try {
    const res = await fetch(`/api/inventory?${queryParams.toString()}`);
    const data = await res.json();
    
    loadingEl.classList.add('hidden');
    
    if (data.items.length === 0) {
      emptyEl.classList.remove('hidden');
      updatePagination(0, 0, 0);
      return;
    }
    
    // Populate items
    data.items.forEach(item => {
      const tr = document.createElement('tr');
      
      // Map status class
      let statusClass = 'returned';
      const statusLower = item.status.toLowerCase();
      if (statusLower === 'active') statusClass = 'active';
      else if (statusLower.includes('mr')) statusClass = 'active-mr';
      else if (statusLower.includes('assigned')) statusClass = 'active-assigned';
      else if (statusLower === 'unserviceable') statusClass = 'unserviceable';
      else if (statusLower === 'missing' || statusLower === 'lost') statusClass = 'missing';
      
      // Determine description truncate
      const descriptionShort = item.description 
        ? (item.description.length > 60 ? `${item.description.substring(0, 57)}...` : item.description)
        : '';
        
      tr.innerHTML = `
        <td class="font-semibold text-primary">${item.property_number}</td>
        <td>
          <div class="font-semibold">${item.article}</div>
          <div class="text-xs text-muted" title="${item.description || ''}">${descriptionShort}</div>
        </td>
        <td><span class="text-secondary">${item.sheet_name}</span></td>
        <td>${item.quantity}</td>
        <td>${formatCurrency(item.unit_value)}</td>
        <td><strong>${formatCurrency(item.total_value)}</strong></td>
        <td>${item.date_acquired || '-'}</td>
        <td>${item.accountable_officer || '-'}</td>
        <td><span class="status-tag ${statusClass}">${item.status}</span></td>
        <td class="actions-col employee-only ${['admin', 'employee'].includes(currentUser.role) ? '' : 'hidden'}">
          <div class="action-btn-group">
            <button class="action-icon-btn edit-btn" onclick="openEditAssetModal(${item.id})" title="Edit Asset"><i class="fa-solid fa-pen"></i></button>
            <button class="action-icon-btn delete-btn" onclick="openDeleteModal(${item.id}, '${item.article.replace(/'/g, "\\'")}', '${item.property_number}')" title="Delete Asset"><i class="fa-solid fa-trash"></i></button>
          </div>
        </td>
      `;
      
      tableTbody.appendChild(tr);
    });
    
    const pagStart = (data.pagination.page - 1) * data.pagination.limit + 1;
    const pagEnd = pagStart + data.items.length - 1;
    updatePagination(pagStart, pagEnd, data.pagination.totalItems, data.pagination.totalPages, data.pagination.page);
    
  } catch (err) {
    loadingEl.classList.add('hidden');
    console.error('Inventory load error:', err);
  }
}

function updatePagination(start, end, total, totalPages, currentPage) {
  document.getElementById('pagination-start').textContent = start;
  document.getElementById('pagination-end').textContent = end;
  document.getElementById('pagination-total').textContent = total;
  
  const prevBtn = document.getElementById('pagination-prev');
  const nextBtn = document.getElementById('pagination-next');
  
  prevBtn.disabled = inventoryPage <= 1;
  nextBtn.disabled = inventoryPage >= totalPages;
  
  const pagesContainer = document.getElementById('pagination-pages');
  pagesContainer.innerHTML = '';
  
  // Show surrounding page numbers (e.g. current-1, current, current+1)
  const maxPages = 5;
  let startPage = Math.max(1, currentPage - 2);
  let endPage = Math.min(totalPages, startPage + maxPages - 1);
  if (endPage - startPage + 1 < maxPages) {
    startPage = Math.max(1, endPage - maxPages + 1);
  }
  
  for (let i = startPage; i <= endPage; i++) {
    const btn = document.createElement('button');
    btn.className = `page-btn ${i === currentPage ? 'active' : ''}`;
    btn.textContent = i;
    btn.addEventListener('click', () => {
      inventoryPage = i;
      loadInventoryTable();
    });
    pagesContainer.appendChild(btn);
  }
}

async function loadAuditLogsTable() {
  const tbody = document.getElementById('logs-tbody');
  tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Loading security logs...</td></tr>';
  
  try {
    const res = await fetch('/api/audit-logs');
    const data = await res.json();
    
    tbody.innerHTML = '';
    if (data.logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No security records logged.</td></tr>';
      return;
    }
    
    data.logs.forEach(log => {
      const tr = document.createElement('tr');
      const timeLocal = new Date(log.timestamp).toLocaleString();
      
      let actionClass = 'text-primary';
      if (log.action === 'DELETE') actionClass = 'text-red font-semibold';
      else if (log.action === 'CREATE') actionClass = 'text-green font-semibold';
      else if (log.action === 'IMPORT') actionClass = 'text-purple font-semibold';
      
      tr.innerHTML = `
        <td class="text-muted" style="white-space: nowrap;">${timeLocal}</td>
        <td><strong>${log.username}</strong></td>
        <td><span class="${actionClass}">${log.action}</span></td>
        <td class="text-secondary">${log.details}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Logs fetch failed:', err);
  }
}


// ================= MODALS & FORMS HANDLERS =================

function openModal(modalId) {
  document.getElementById(modalId).classList.remove('hidden');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.add('hidden');
}

// Reset and open modal for Add
function openAssetModal() {
  document.getElementById('modal-title').textContent = 'Register New Asset';
  document.getElementById('asset-id').value = '';
  document.getElementById('asset-form').reset();
  document.getElementById('asset-error').classList.add('hidden');
  
  // Make property field editable
  document.getElementById('asset-property').disabled = false;
  
  openModal('asset-modal');
}

// Fetch and open modal for Edit
async function openEditAssetModal(itemId) {
  document.getElementById('modal-title').textContent = 'Modify Asset Details';
  document.getElementById('asset-id').value = itemId;
  document.getElementById('asset-error').classList.add('hidden');
  
  try {
    // We can fetch item directly by filtering our inventory table view state,
    // or run a quick fetch query. For safety, let's run a quick query in frontend
    // by searching items in inventory? Since we are already showing it, let's just
    // query backend. Wait, we don't have a single-item GET endpoint yet!
    // But we can query via inventory endpoint with search or just add one.
    // Actually, we can fetch all details using search filter page=1 limit=1 search=itemId,
    // or just fetch by filtering loaded rows. Let's do a fetch call.
    const res = await fetch(`/api/inventory?sortBy=id&sortOrder=ASC&limit=1&page=1&search=${itemId}`);
    const data = await res.json();
    const item = data.items.find(i => i.id === itemId);
    
    if (!item) {
      alert('Asset record not found.');
      return;
    }
    
    // Fill forms
    document.getElementById('asset-dept').value = item.sheet_name;
    document.getElementById('asset-property').value = item.property_number;
    document.getElementById('asset-article').value = item.article;
    document.getElementById('asset-desc').value = item.description || '';
    document.getElementById('asset-qty').value = item.quantity;
    document.getElementById('asset-val').value = item.unit_value.toFixed(2);
    document.getElementById('asset-total').value = item.total_value.toFixed(2);
    document.getElementById('asset-date').value = item.date_acquired || '';
    document.getElementById('asset-status').value = item.status;
    document.getElementById('asset-officer').value = item.accountable_officer || '';
    document.getElementById('asset-remarks').value = item.remarks || '';
    
    // Disable property number edit for consistency during audit trails
    document.getElementById('asset-property').disabled = true;
    
    openModal('asset-modal');
  } catch (err) {
    console.error('Failed to load asset details:', err);
  }
}

// Submit Create or Update
async function handleAssetSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('asset-id').value;
  const errorEl = document.getElementById('asset-error');
  errorEl.classList.add('hidden');
  
  const payload = {
    sheet_name: document.getElementById('asset-dept').value,
    property_number: document.getElementById('asset-property').value,
    article: document.getElementById('asset-article').value,
    description: document.getElementById('asset-desc').value,
    quantity: parseInt(document.getElementById('asset-qty').value) || 1,
    unit_value: parseFloat(document.getElementById('asset-val').value) || 0,
    total_value: parseFloat(document.getElementById('asset-total').value) || 0,
    date_acquired: document.getElementById('asset-date').value,
    status: document.getElementById('asset-status').value,
    accountable_officer: document.getElementById('asset-officer').value,
    remarks: document.getElementById('asset-remarks').value
  };
  
  const url = id ? `/api/inventory/${id}` : '/api/inventory';
  const method = id ? 'PUT' : 'POST';
  
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const data = await res.json();
    if (res.ok) {
      closeModal('asset-modal');
      loadInventoryTable();
      loadDepartmentsDropdown(); // Refresh dropdown list
    } else {
      errorEl.textContent = data.error || 'Failed to save asset registry.';
      errorEl.classList.remove('hidden');
    }
  } catch (err) {
    errorEl.textContent = 'Server connection error.';
    errorEl.classList.remove('hidden');
  }
}

// Delete Asset Confirmation Modal
let assetToDeleteId = null;
function openDeleteModal(itemId, itemName, itemCode) {
  assetToDeleteId = itemId;
  document.getElementById('delete-item-name').textContent = itemName;
  document.getElementById('delete-item-code').textContent = itemCode;
  document.getElementById('delete-error').classList.add('hidden');
  openModal('delete-modal');
}

async function executeDeleteItem() {
  if (!assetToDeleteId) return;
  const errorEl = document.getElementById('delete-error');
  errorEl.classList.add('hidden');
  
  try {
    const res = await fetch(`/api/inventory/${assetToDeleteId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    
    if (res.ok) {
      closeModal('delete-modal');
      loadInventoryTable();
    } else {
      errorEl.textContent = data.error || 'Failed to delete asset.';
      errorEl.classList.remove('hidden');
    }
  } catch (err) {
    errorEl.textContent = 'Server error.';
    errorEl.classList.remove('hidden');
  }
}

// Excel Import Upload
async function handleExcelImport(e) {
  e.preventDefault();
  const fileInput = document.getElementById('import-file');
  const spinner = document.getElementById('import-spinner');
  const submitBtn = document.getElementById('import-submit-btn');
  const errorEl = document.getElementById('import-error');
  const successEl = document.getElementById('import-success');
  
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');
  spinner.classList.remove('hidden');
  submitBtn.disabled = true;
  
  const formData = new FormData();
  formData.append('excelFile', fileInput.files[0]);
  
  try {
    const res = await fetch('/api/import', {
      method: 'POST',
      body: formData
    });
    
    const data = await res.json();
    spinner.classList.add('hidden');
    
    if (res.ok) {
      successEl.textContent = data.message;
      successEl.classList.remove('hidden');
      fileInput.value = '';
      
      // Refresh app catalogs and views
      setTimeout(() => {
        closeModal('import-modal');
        loadDashboardData();
        loadInventoryTable();
        loadDepartmentsDropdown();
      }, 1500);
    } else {
      submitBtn.disabled = false;
      errorEl.textContent = data.error || 'Import failed.';
      errorEl.classList.remove('hidden');
    }
  } catch (err) {
    spinner.classList.add('hidden');
    submitBtn.disabled = false;
    errorEl.textContent = 'Server connection error during upload.';
    errorEl.classList.remove('hidden');
  }
}


// ================= FORMAT HELPERS =================

function formatCurrency(value) {
  if (value === undefined || value === null || isNaN(value)) return '₱0.00';
  return '₱' + parseFloat(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// Global functions for inline click triggers
window.openEditAssetModal = openEditAssetModal;
window.openDeleteModal = openDeleteModal;
