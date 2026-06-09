const assert = require('assert');

const baseUrl = 'http://localhost:3000';

async function runTests() {
  console.log('--- STARTING ENDPOINT TESTS ---');
  
  // Helper to extract session cookie
  let sessionCookie = null;
  
  async function makeRequest(path, options = {}) {
    const url = `${baseUrl}${path}`;
    options.headers = options.headers || {};
    if (sessionCookie) {
      options.headers['Cookie'] = sessionCookie;
    }
    
    // Auto convert JSON body
    if (options.body && typeof options.body === 'object') {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    
    const res = await fetch(url, options);
    
    // Capture session cookie
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      sessionCookie = setCookie.split(';')[0];
    }
    
    const isJson = res.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await res.json() : await res.text();
    
    return { status: res.status, data };
  }
  
  try {
    // 1. Check initially unauthenticated
    console.log('Testing unauthenticated state...');
    const r1 = await makeRequest('/api/me');
    assert.strictEqual(r1.status, 200);
    assert.deepStrictEqual(r1.data, { user: null });
    
    const r2 = await makeRequest('/api/dashboard');
    assert.strictEqual(r2.status, 401);
    console.log('✓ Successfully rejected unauthenticated dashboard access.');

    // 2. Test Login as Viewer (Should fail since viewer role was removed)
    console.log('\nTrying to log in as Viewer (should fail)...');
    const r3 = await makeRequest('/api/login', {
      method: 'POST',
      body: { username: 'viewer', password: 'viewerpassword' }
    });
    assert.strictEqual(r3.status, 401);
    console.log('✓ Viewer login successfully rejected.');
    
    // 3. Test Login as Employee
    console.log('\nLogging in as Employee...');
    const r8 = await makeRequest('/api/login', {
      method: 'POST',
      body: { username: 'employee', password: 'employeepassword' }
    });
    assert.strictEqual(r8.status, 200);
    assert.strictEqual(r8.data.user.role, 'employee');
    console.log('✓ Logged in as employee.');
    
    // 3.1 Employee create asset
    const testPropNum = 'TEST-PROP-' + Date.now();
    const r9 = await makeRequest('/api/inventory', {
      method: 'POST',
      body: {
        sheet_name: 'LIBRARY',
        article: 'Test Swivel Chair',
        description: 'Verification test item',
        property_number: testPropNum,
        quantity: 2,
        unit_value: 1200,
        status: 'Active'
      }
    });
    assert.strictEqual(r9.status, 201);
    const createdId = r9.data.id;
    console.log(`✓ Employee created item (ID: ${createdId}).`);
    
    // 3.2 Employee update asset
    const r10 = await makeRequest(`/api/inventory/${createdId}`, {
      method: 'PUT',
      body: {
        sheet_name: 'LIBRARY',
        article: 'Updated Test Swivel Chair',
        property_number: testPropNum,
        quantity: 2,
        unit_value: 1300,
        status: 'Active (w/ MR)'
      }
    });
    assert.strictEqual(r10.status, 200);
    console.log('✓ Employee updated item.');
    
    // 3.2.1 Employee download Excel (Should succeed)
    console.log('Testing Employee Excel export...');
    const r10_export = await makeRequest('/api/export');
    assert.strictEqual(r10_export.status, 200);
    assert.ok(r10_export.data.length > 100);
    console.log('✓ Employee successfully exported inventory to Excel.');
    
    // 3.3 Employee try to import Excel (Should fail)
    const r11 = await makeRequest('/api/import', { method: 'POST' });
    assert.strictEqual(r11.status, 403);
    console.log('✓ Employee rejected from importing Excel.');
    
    // 3.4 Employee delete asset
    const r12 = await makeRequest(`/api/inventory/${createdId}`, {
      method: 'DELETE'
    });
    assert.strictEqual(r12.status, 200);
    console.log('✓ Employee deleted item.');
    
    // Logout
    await makeRequest('/api/logout', { method: 'POST' });
    sessionCookie = null;
    
    // 4. Test Login as Admin
    console.log('\nLogging in as Admin...');
    const r13 = await makeRequest('/api/login', {
      method: 'POST',
      body: { username: 'admin', password: 'adminpassword' }
    });
    assert.strictEqual(r13.status, 200);
    assert.strictEqual(r13.data.user.role, 'admin');
    console.log('✓ Logged in as admin.');
    
    // 4.1 Admin read audit logs
    const r14 = await makeRequest('/api/audit-logs');
    assert.strictEqual(r14.status, 200);
    assert.ok(r14.data.logs.length > 0);
    console.log(`✓ Admin fetched audit logs. Found ${r14.data.logs.length} entries.`);
    console.log('Latest action:', r14.data.logs[0].action, '-', r14.data.logs[0].details);
    
    // 5. Test Registration & Admin Approval
    console.log('\nTesting Public Registration & Admin Approval...');
    const testUsername = 'test_reg_' + Date.now();
    const testPassword = 'securepassword123';
    
    // 5.1 Register a new employee account
    const rReg = await makeRequest('/api/register', {
      method: 'POST',
      body: { username: testUsername, password: testPassword }
    });
    assert.strictEqual(rReg.status, 201);
    console.log(`✓ Registration request for ${testUsername} succeeded.`);
    
    // 5.2 Attempt to login as pending employee (should fail with 403)
    const rLogPending = await makeRequest('/api/login', {
      method: 'POST',
      body: { username: testUsername, password: testPassword }
    });
    assert.strictEqual(rLogPending.status, 403);
    assert.ok(rLogPending.data.error.includes('pending approval'));
    console.log('✓ Pending user login attempt rejected with 403.');
    
    // 5.3 Login as Admin to approve
    const rAdminLog = await makeRequest('/api/login', {
      method: 'POST',
      body: { username: 'admin', password: 'adminpassword' }
    });
    assert.strictEqual(rAdminLog.status, 200);
    
    // 5.4 Fetch users list as admin
    const rUsersList = await makeRequest('/api/admin/users');
    assert.strictEqual(rUsersList.status, 200);
    const targetUser = rUsersList.data.users.find(u => u.username === testUsername);
    assert.ok(targetUser);
    assert.strictEqual(targetUser.status, 'pending');
    console.log('✓ Admin retrieved user list and confirmed target user is pending.');
    
    // 5.5 Approve the user
    const rApprove = await makeRequest(`/api/admin/users/${targetUser.id}/approve`, {
      method: 'POST'
    });
    assert.strictEqual(rApprove.status, 200);
    console.log(`✓ Admin approved user ${testUsername}.`);
    
    // 5.6 Log out admin
    await makeRequest('/api/logout', { method: 'POST' });
    sessionCookie = null;
    
    // 5.7 Login as now-approved user (should succeed)
    const rLogApproved = await makeRequest('/api/login', {
      method: 'POST',
      body: { username: testUsername, password: testPassword }
    });
    assert.strictEqual(rLogApproved.status, 200);
    assert.strictEqual(rLogApproved.data.user.role, 'employee');
    console.log(`✓ User ${testUsername} successfully logged in after approval.`);
    
    // 5.8 Log out user
    await makeRequest('/api/logout', { method: 'POST' });
    sessionCookie = null;
    
    // 5.9 Login as Admin to delete user
    await makeRequest('/api/login', {
      method: 'POST',
      body: { username: 'admin', password: 'adminpassword' }
    });
    
    // 5.10 Delete the user
    const rDeleteUser = await makeRequest(`/api/admin/users/${targetUser.id}`, {
      method: 'DELETE'
    });
    assert.strictEqual(rDeleteUser.status, 200);
    console.log(`✓ Admin deleted/rejected user ${testUsername}.`);
    
    console.log('\n=== ALL ENDPOINT ROLE TESTS PASSED ===');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Test Assert Failed:', err.stack || err.message);
    process.exit(1);
  }
}

runTests();
