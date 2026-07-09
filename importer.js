const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const { supabase, initDb } = require('./db');

const defaultExcelPath = 'C:\\pineda\\Inventory 2025.xlsx';

function isPropertyNumber(str) {
  if (!str || typeof str !== 'string') return false;
  str = str.trim();
  if (str.includes(' ')) return false; // Strict: No spaces!
  const hasDash = str.includes('-');
  const hasNumber = /\d/.test(str);
  if (/^[A-Za-z]{3,10}-\d{1,2}-\d{2,4}$/.test(str)) return false;
  if (/^\d{1,2}-[A-Za-z]{3,10}-\d{2,4}$/.test(str)) return false;
  return hasDash && hasNumber && str.length >= 4 && str.length < 40;
}

function parseRemarks(remarksStr) {
  if (!remarksStr || typeof remarksStr !== 'string') {
    return { officer: null, status: 'Active', cleanRemarks: '' };
  }
  const raw = remarksStr.trim();
  let status = 'Active';
  let officer = null;
  const lower = raw.toLowerCase();
  
  if (lower.includes('unserviceable')) {
    status = 'Unserviceable';
  } else if (lower.includes('returned')) {
    status = 'Returned';
  } else if (lower.includes('transferred')) {
    status = 'Transferred';
  } else if (lower.includes('missing')) {
    status = 'Missing';
  } else if (lower.includes('lost')) {
    status = 'Lost';
  } else if (lower.includes('auction')) {
    status = 'Auction';
  } else if (lower.includes('w/ mr') || lower.includes('w/mr') || lower.includes('mr')) {
    status = 'Active (w/ MR)';
  } else if (lower.includes('c/o') || lower.includes('assigned')) {
    status = 'Active (Assigned)';
  }
  
  let namePart = raw;
  namePart = namePart.replace(/\b(unserviceable|returned to gso|returned|transferred to|transferred|missing|lost|auction|w\/ mr|w\/mr|w\/ m\.r\.|w\/m\.r\.|c\/o|from:)\b/gi, '');
  namePart = namePart.replace(/[()]/g, '');
  namePart = namePart.trim();
  
  const isGeneric = /^(valueless|missing|lost|unserviceable|returned|transferred|various|brgy|hall|office|school|pnp|coa|cctv|cmo|gso)$/i.test(namePart);
  
  if (namePart.length > 2 && !isGeneric && namePart.split(/\s+/).length >= 2) {
    officer = namePart;
  }
  
  return { officer, status, cleanRemarks: raw };
}

async function importExcel(excelFilePath, username = 'system') {
  console.log(`Starting import from: ${excelFilePath} by ${username}`);
  
  if (!fs.existsSync(excelFilePath)) {
    throw new Error(`Excel file does not exist at: ${excelFilePath}`);
  }
  
  try {
    const workbook = xlsx.readFile(excelFilePath);
    const sheetNames = workbook.SheetNames;
    console.log(`Loaded ${sheetNames.length} sheets from workbook.`);
    
    // Clear items table
    await supabase.from('items').delete().neq('id', 0);
    
    let itemsToInsert = [];
    let currentItem = null;
    
    for (const sheetName of sheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
      
      let sheetImported = 0;
      
      // Column detection
      let headerRowIdx = -1;
      let colMap = {
        article: 0,
        description: -1,
        property: -1,
        qty: -1,
        unitVal: -1,
        totalVal: -1,
        date: -1,
        remarks: -1
      };
      
      for (let r = 0; r < Math.min(data.length, 15); r++) {
        const row = data[r] || [];
        const rowStr = JSON.stringify(row).toUpperCase();
        if (rowStr.includes('ARTICLE') || rowStr.includes('DESCRIPTION') || rowStr.includes('ON HAND PER COUNT')) {
          headerRowIdx = r;
          break;
        }
      }
      
      if (headerRowIdx !== -1) {
        const rowsToScan = [];
        for (let i = 0; i < 3; i++) {
          if (data[headerRowIdx + i]) {
            rowsToScan.push(data[headerRowIdx + i]);
          }
        }
        const maxCols = Math.max(...rowsToScan.map(r => r.length));
        
        for (let c = 0; c < maxCols; c++) {
          let colCells = rowsToScan.map(r => String(r[c] || '').toUpperCase().trim()).join(' ');
          
          if (colCells.includes('ARTICLE')) {
            colMap.article = c;
          } else if (colCells.includes('DESCRIPTION')) {
            colMap.description = c;
          } else if (colCells.includes('NUMBER') || colCells.includes('PROPERTY')) {
            colMap.property = c;
          } else if (colCells.includes('QTY') || colCells.includes('QUANTITY')) {
            if (colMap.qty === -1) colMap.qty = c;
          } else if (colCells.includes('UNIT VALUE') || colCells.includes('UNIT COST')) {
            colMap.unitVal = c;
          } else if (colCells.includes('VALUE') || colCells.includes('TOTAL VALUE') || colCells.includes('TOTAL COST')) {
            if (!colCells.includes('UNIT')) {
              colMap.totalVal = c;
            }
          } else if (colCells.includes('DATE')) {
            colMap.date = c;
          } else if (colCells.includes('REMARKS') || colCells.includes('WHEREABOUTS')) {
            colMap.remarks = c;
          }
        }
      }
      
      if (colMap.property === -1) {
        for (let r = 0; r < Math.min(data.length, 15); r++) {
          const row = data[r] || [];
          for (let c = 0; c < row.length; c++) {
            if (isPropertyNumber(String(row[c]))) {
              colMap.property = c;
              break;
            }
          }
          if (colMap.property !== -1) break;
        }
      }
      
      if (colMap.property === -1) colMap.property = 4;
      if (colMap.qty === -1) colMap.qty = colMap.property + 1;
      if (colMap.unitVal === -1) colMap.unitVal = colMap.property + 2;
      if (colMap.totalVal === -1) colMap.totalVal = colMap.property + 3;
      if (colMap.date === -1) colMap.date = colMap.property + 4;
      if (colMap.remarks === -1) colMap.remarks = colMap.property + 6;
      
      let isLowValue = headerRowIdx === -1;
      let startRow = isLowValue ? 0 : headerRowIdx + 1;
      
      if (headerRowIdx !== -1) {
        for (let i = 1; i <= 2; i++) {
          const checkRow = data[headerRowIdx + i] || [];
          const checkRowStr = JSON.stringify(checkRow).toUpperCase();
          if (checkRowStr.includes('QTY') || checkRowStr.includes('QUANTITY') || checkRowStr.includes('VALUE')) {
            startRow = headerRowIdx + i + 1;
          }
        }
      }
      
      for (let r = startRow; r < data.length; r++) {
        const row = data[r] || [];
        if (row.length === 0) continue;
        
        const rowStr = JSON.stringify(row).toUpperCase();
        if (rowStr.includes('TOTAL') || rowStr.includes('GRAND TOTAL') || rowStr.includes('SUBTOTAL') || rowStr.includes('SUB-TOTAL')) {
          continue;
        }
        
        const cleanRow = row.map(cell => (cell === undefined || cell === null) ? '' : cell);
        const propCell = String(cleanRow[colMap.property] || '').trim();
        const isProp = isPropertyNumber(propCell);
        
        if (isProp) {
          const propertyNumber = propCell;
          let article = String(cleanRow[colMap.article] || '').trim();
          
          let descParts = [];
          let startDesc = colMap.description !== -1 ? colMap.description : colMap.article + 1;
          for (let c = startDesc; c < colMap.property; c++) {
            const val = String(cleanRow[c] || '').trim();
            if (val && c !== colMap.article) {
              descParts.push(val);
            }
          }
          const description = descParts.join(' ');
          
          let qty = 1;
          const qtyVal = cleanRow[colMap.qty];
          if (typeof qtyVal === 'number') {
            qty = qtyVal;
          } else if (typeof qtyVal === 'string' && /^\d+$/.test(qtyVal.trim())) {
            qty = parseInt(qtyVal.trim());
          }
          
          let unit_value = 0;
          const uvVal = cleanRow[colMap.unitVal];
          if (typeof uvVal === 'number') {
            unit_value = uvVal;
          } else if (typeof uvVal === 'string' && /^\d+(\.\d+)?$/.test(uvVal.trim())) {
            unit_value = parseFloat(uvVal.trim());
          }
          
          let total_value = 0;
          const tvVal = cleanRow[colMap.totalVal];
          if (typeof tvVal === 'number') {
            total_value = tvVal;
          } else if (typeof tvVal === 'string' && /^\d+(\.\d+)?$/.test(tvVal.trim())) {
            total_value = parseFloat(tvVal.trim());
          }
          
          if (!total_value && unit_value) {
            total_value = qty * unit_value;
          }
          if (total_value && !unit_value) {
            unit_value = qty > 0 ? total_value / qty : total_value;
          }
          
          let date_acquired = String(cleanRow[colMap.date] || '').trim();
          let remarks = String(cleanRow[colMap.remarks] || '').trim();
          
          const { officer, status, cleanRemarks } = parseRemarks(remarks);
          
          currentItem = {
            sheet_name: sheetName,
            article: article || 'UNKNOWN ARTICLE',
            description: description,
            property_number: propertyNumber,
            quantity: qty,
            unit: null,
            unit_value: unit_value,
            total_value: total_value,
            date_acquired: date_acquired,
            remarks: cleanRemarks,
            accountable_officer: officer,
            status: status,
            raw_row: JSON.stringify(cleanRow)
          };
          
          itemsToInsert.push(currentItem);
          sheetImported++;
        } else {
          const nonValColumns = cleanRow.filter((cell, idx) => String(cell).trim().length > 0 && idx !== colMap.qty && idx !== colMap.unitVal && idx !== colMap.totalVal);
          const hasNumberInValues = typeof cleanRow[colMap.qty] === 'number' || typeof cleanRow[colMap.unitVal] === 'number' || typeof cleanRow[colMap.totalVal] === 'number';
          
          if (currentItem && nonValColumns.length > 0 && !hasNumberInValues) {
            const textToAppend = nonValColumns.join(' ');
            // Append continuation text in-memory directly to the last added item
            const lastItem = itemsToInsert[itemsToInsert.length - 1];
            if (lastItem) {
              lastItem.description = (lastItem.description + ' ' + textToAppend).trim();
            }
          }
        }
      }
      console.log(`Sheet '${sheetName}' parsed: ${sheetImported} items queued.`);
    }
    
    // Execute inserts in batches of 500
    const chunkSize = 500;
    console.log(`Importing ${itemsToInsert.length} total items in chunks of ${chunkSize}...`);
    for (let i = 0; i < itemsToInsert.length; i += chunkSize) {
      const chunk = itemsToInsert.slice(i, i + chunkSize);
      const { error: insertError } = await supabase.from('items').insert(chunk);
      if (insertError) throw insertError;
    }
    
    // Log audit trail
    const timestamp = new Date().toISOString();
    const { error: logError } = await supabase.from('audit_logs').insert({
      username,
      action: 'IMPORT',
      timestamp,
      details: `Imported ${itemsToInsert.length} items from Excel sheet: ${path.basename(excelFilePath)}`
    });
    if (logError) throw logError;
    
    return itemsToInsert.length;
  } catch (err) {
    console.error('Import process failed:', err);
    throw err;
  }
}

if (require.main === module) {
  (async () => {
    try {
      await initDb();
      await importExcel(defaultExcelPath, 'system_init');
      console.log('Database populated successfully.');
      process.exit(0);
    } catch (e) {
      console.error('Direct run import failed:', e);
      process.exit(1);
    }
  })();
}

module.exports = {
  importExcel
};
