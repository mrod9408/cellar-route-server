const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch(e) { console.warn('pdf-parse not installed — sales rep extraction disabled'); }

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.options('*', cors());

app.use(express.static(path.join(__dirname, 'public')));

// ─── TOKEN STORE ─────────────────────────────────────────────────────────────
let tokenStore = {
  accessToken: null,
  refreshToken: process.env.QB_REFRESH_TOKEN || null,
  clientId: process.env.QB_CLIENT_ID || null,
  clientSecret: process.env.QB_CLIENT_SECRET || null,
  companyId: process.env.QB_COMPANY_ID || null,
  environment: process.env.QB_ENVIRONMENT || 'sandbox',
  expiresAt: null,
  refreshTokenExpiresAt: Date.now() + (101 * 24 * 60 * 60 * 1000)
};

async function doTokenRefresh() {
  if (!tokenStore.refreshToken || !tokenStore.clientId || !tokenStore.clientSecret) {
    console.log('Missing credentials — cannot refresh token');
    return false;
  }
  try {
    console.log('Refreshing access token...');
    const credentials = Buffer.from(`${tokenStore.clientId}:${tokenStore.clientSecret}`).toString('base64');
    const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(tokenStore.refreshToken)}`
    });
    const data = await response.json();
    if (!response.ok) { console.error('Token refresh failed:', data.error); return false; }
    tokenStore.accessToken = data.access_token;
    tokenStore.refreshToken = data.refresh_token;
    tokenStore.expiresAt = Date.now() + (data.expires_in - 300) * 1000;
    tokenStore.refreshTokenExpiresAt = Date.now() + (101 * 24 * 60 * 60 * 1000);
    console.log('✓ Access token refreshed successfully');
    if (data.refresh_token !== process.env.QB_REFRESH_TOKEN) await saveRefreshTokenToRailway(data.refresh_token);
    return true;
  } catch (err) { console.error('Token refresh error:', err); return false; }
}

async function getValidAccessToken() {
  if (!tokenStore.accessToken || (tokenStore.expiresAt && Date.now() >= tokenStore.expiresAt)) {
    const success = await doTokenRefresh();
    if (!success) return null;
  }
  return tokenStore.accessToken;
}

async function saveRefreshTokenToRailway(newRefreshToken) {
  const railwayToken = process.env.RAILWAY_TOKEN, projectId = process.env.RAILWAY_PROJECT_ID,
        serviceId = process.env.RAILWAY_SERVICE_ID, environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  if (!railwayToken || !projectId || !serviceId || !environmentId) { console.log("Railway credentials not set — skipping auto-save"); return; }
  try {
    const mutation = `mutation UpsertVariables($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`;
    const variables = { input: { projectId, serviceId, environmentId, variables: { QB_REFRESH_TOKEN: newRefreshToken } } };
    const response = await fetch("https://backboard.railway.app/graphql/v2", {
      method: "POST",
      headers: { "Authorization": `Bearer ${railwayToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: mutation, variables })
    });
    const data = await response.json();
    if (data.errors) { console.error("Failed to save refresh token:", JSON.stringify(data.errors)); }
    else { console.log("✓ Refresh token auto-saved to Railway"); }
  } catch (err) { console.error("Error saving refresh token:", err.message); }
}

setInterval(async () => { await doTokenRefresh(); }, 50 * 60 * 1000);

async function startup() {
  console.log('Cellar Route Server starting...');
  console.log(`Environment: ${tokenStore.environment}, Company ID: ${tokenStore.companyId}`);
  if (tokenStore.refreshToken && tokenStore.clientId && tokenStore.clientSecret) {
    const success = await doTokenRefresh();
    if (success) { console.log('✓ Ready! Auto-refresh is active.'); }
    else { console.log('⚠️ Could not get initial token — check Railway environment variables.'); }
  } else { console.log('⚠️ No credentials. Manual connection required.'); }
}

app.get('/api/config', (req, res) => {
  res.json({ googleMapsKey: process.env.GOOGLE_MAPS_KEY || '', mapboxToken: process.env.MAPBOX_TOKEN || '' });
});

app.post('/api/connect', async (req, res) => {
  const { accessToken, refreshToken, clientId, clientSecret, companyId, environment, expiresIn } = req.body;
  if (!accessToken || !companyId) return res.status(400).json({ error: 'Missing required fields' });
  if (refreshToken) tokenStore.refreshToken = refreshToken;
  if (clientId) tokenStore.clientId = clientId;
  if (clientSecret) tokenStore.clientSecret = clientSecret;
  tokenStore.accessToken = accessToken;
  tokenStore.companyId = companyId;
  tokenStore.environment = environment || tokenStore.environment;
  tokenStore.expiresAt = Date.now() + ((expiresIn || 3600) - 300) * 1000;
  res.json({ success: true, message: 'Credentials saved. Token will auto-refresh.' });
});

app.post('/api/refresh-token', async (req, res) => {
  const { refreshToken, clientId, clientSecret } = req.body;
  if (!refreshToken || !clientId || !clientSecret) return res.status(400).json({ error: 'Missing required fields' });
  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error || 'Token refresh failed', details: data });
    tokenStore.accessToken = data.access_token;
    tokenStore.refreshToken = data.refresh_token;
    tokenStore.expiresAt = Date.now() + (data.expires_in - 300) * 1000;
    res.json({ accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in });
  } catch (err) { res.status(500).json({ error: 'Server error during token refresh' }); }
});

// ─── FETCH INVOICES ── accepts optional ?date=YYYY-MM-DD, defaults to today ──
app.get('/api/invoices', async (req, res) => {
  let accessToken = await getValidAccessToken();
  const companyId = tokenStore.companyId;
  const environment = tokenStore.environment;
  if (!accessToken || !companyId) return res.status(400).json({ error: 'Not connected to QuickBooks. Check Railway environment variables.' });

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const requestedDate = req.query.date || todayStr;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }

  console.log(`Fetching invoices for date: ${requestedDate} (env: ${environment})`);

  const baseUrls = environment === 'production'
    ? ['https://quickbooks.api.intuit.com', 'https://qbo.api.intuit.com', 'https://c1.qbo.intuit.com', 'https://c3.qbo.intuit.com', 'https://c5.qbo.intuit.com']
    : ['https://sandbox-quickbooks.api.intuit.com'];

  const query = environment === 'production'
    ? `SELECT * FROM Invoice WHERE TxnDate = '${requestedDate}' ORDERBY TxnDate ASC MAXRESULTS 100`
    : `SELECT * FROM Invoice ORDERBY TxnDate DESC MAXRESULTS 100`;

  try {
    const qbHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' };
    let response = null, data = null;
    for (const tryUrl of baseUrls) {
      try {
        const qbUrl = `${tryUrl}/v3/company/${companyId}/query?query=${encodeURIComponent(query)}&minorversion=65`;
        console.log(`Trying QB endpoint: ${tryUrl}`);
        response = await fetch(qbUrl, { method: 'GET', headers: qbHeaders });
        data = await response.json();
        if (response.ok) { console.log(`✓ Success with: ${tryUrl}`); break; }
        if (data?.Fault?.Error?.[0]?.code !== '130') break;
        console.log(`Wrong cluster, trying next...`);
      } catch (urlErr) { console.log(`Failed to connect to ${tryUrl}: ${urlErr.message}`); }
    }
    if (!response || !response.ok) return res.status(500).json({ error: 'QuickBooks API error', details: data });

    const invoices = data.QueryResponse?.Invoice || [];
    const formatAddress = (addr) => {
      if (!addr) return null;
      const line1 = addr.Line1 || '', line2 = addr.Line2 || '', line3 = addr.Line3 || '',
            line4 = addr.Line4 || '', line5 = addr.Line5 || '';
      let city = addr.City || '', state = addr.CountrySubDivisionCode || '', zip = addr.PostalCode || '';
      if (!zip) { const m = [line3, line4, line5].join(' ').match(/\b(\d{5})(?:-\d{4})?\b/); if (m) zip = m[1]; }
      if (!city || !state) {
        for (const line of [line3, line4, line5].filter(Boolean)) {
          const match = line.match(/^([^,]+),?\s+([A-Z]{2})\s+\d{5}/);
          if (match) { if (!city) city = match[1].trim(); if (!state) state = match[2].trim(); break; }
        }
      }
      const full = [line2, city, state, zip].filter(Boolean).join(', ') || [line1, line2].filter(Boolean).join(' ') || line1;
      return { line1, line2, line3, city, state, zip, full };
    };

    const formatted = invoices.map(inv => ({
      id: inv.Id,
      invoiceNumber: inv.DocNumber || 'N/A',
      customerName: inv.CustomerRef?.name || 'Unknown',
      customerId: inv.CustomerRef?.value,
      invoiceDate: inv.TxnDate,
      dueDate: inv.DueDate,
      balance: inv.Balance,
      totalAmount: inv.TotalAmt,
      status: inv.EmailStatus,
      lineItems: (inv.Line || [])
        .filter(l => l.DetailType === 'SalesItemLineDetail' && l.SalesItemLineDetail?.ItemRef)
        .map(l => ({
          qty:         Number(l.SalesItemLineDetail?.Qty || 0),
          unitPrice:   Number(l.SalesItemLineDetail?.UnitPrice || 0),
          amount:      Number(l.Amount || 0),
          description: l.Description || '',
          itemId:      l.SalesItemLineDetail?.ItemRef?.value || '',
          itemName:    l.SalesItemLineDetail?.ItemRef?.name  || l.Description || '',
        })),
      shipAddress: formatAddress(inv.ShipAddr),
      billAddress: formatAddress(inv.BillAddr)
    }));

    res.json({ count: formatted.length, invoices: formatted, environment, autoRefresh: true, queriedAt: new Date().toISOString(), requestedDate });
  } catch (err) {
    console.error('Invoice fetch error:', err);
    res.status(500).json({ error: 'Server error fetching invoices' });
  }
});

// ─── OVERDUE CUSTOMERS ────────────────────────────────────────────────────────
app.get('/api/overdue', async (req, res) => {
  const accessToken = await getValidAccessToken();
  const companyId   = tokenStore.companyId;
  const environment = tokenStore.environment;
  if (!accessToken || !companyId) return res.status(400).json({ error: 'Not connected to QuickBooks.' });

  const baseUrls = environment === 'production'
    ? ['https://quickbooks.api.intuit.com', 'https://qbo.api.intuit.com', 'https://c1.qbo.intuit.com', 'https://c3.qbo.intuit.com', 'https://c5.qbo.intuit.com']
    : ['https://sandbox-quickbooks.api.intuit.com'];

  const today = new Date().toISOString().split('T')[0];
  const qbHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' };

  const runQbQuery = async (query) => {
    for (const tryUrl of baseUrls) {
      try {
        const url  = `${tryUrl}/v3/company/${companyId}/query?query=${encodeURIComponent(query)}&minorversion=65`;
        const r    = await fetch(url, { method: 'GET', headers: qbHeaders });
        const data = await r.json();
        if (r.ok) return data;
        const errCode = data?.Fault?.Error?.[0]?.code;
        if (errCode !== '130') throw new Error('QB query failed: ' + JSON.stringify(data?.Fault || data).slice(0, 200));
        console.log('[OVERDUE] Wrong cluster (' + tryUrl + '), trying next...');
      } catch (err) {
        if (tryUrl === baseUrls[baseUrls.length - 1]) throw err;
      }
    }
    throw new Error('All QB cluster URLs failed');
  };

  try {
    const invoiceQuery = environment === 'production'
      ? `SELECT * FROM Invoice WHERE Balance > '0' AND DueDate < '${today}' MAXRESULTS 1000`
      : `SELECT * FROM Invoice WHERE Balance > '0' MAXRESULTS 1000`;

    const invoiceData = await runQbQuery(invoiceQuery);
    const rawInvoices = invoiceData.QueryResponse?.Invoice || [];

    const pastDueByCustomer = {};
    rawInvoices.forEach(inv => {
      const custId = inv.CustomerRef?.value ? String(inv.CustomerRef.value) : null;
      const custName = inv.CustomerRef?.name || 'Unknown';
      if (!custId) return;
      const due = inv.DueDate ? new Date(inv.DueDate) : null;
      const now = new Date(today);
      if (!due || due >= now) return;
      if (!pastDueByCustomer[custId]) {
        pastDueByCustomer[custId] = { customerName: custName, overdueInvoiceBalance: 0, invoiceCount: 0, oldestDueDate: inv.DueDate };
      }
      pastDueByCustomer[custId].overdueInvoiceBalance += Number(inv.Balance || 0);
      pastDueByCustomer[custId].invoiceCount++;
      if (inv.DueDate < pastDueByCustomer[custId].oldestDueDate) pastDueByCustomer[custId].oldestDueDate = inv.DueDate;
    });

    const pastDueCustomerIds = Object.keys(pastDueByCustomer);
    if (!pastDueCustomerIds.length) return res.json({ count: 0, overdueCustomers: [] });

    const BATCH = 30;
    const customerBalances = {};
    for (let i = 0; i < pastDueCustomerIds.length; i += BATCH) {
      const batch = pastDueCustomerIds.slice(i, i + BATCH);
      const idList = batch.map(id => `'${id}'`).join(', ');
      try {
        const custData = await runQbQuery(`SELECT Id, DisplayName, Balance FROM Customer WHERE Id IN (${idList}) MAXRESULTS ${BATCH}`);
        (custData.QueryResponse?.Customer || []).forEach(c => {
          customerBalances[String(c.Id)] = { balance: Number(c.Balance || 0), displayName: c.DisplayName || pastDueByCustomer[String(c.Id)]?.customerName || 'Unknown' };
        });
      } catch (err) {
        batch.forEach(id => { if (!customerBalances[id]) customerBalances[id] = { balance: pastDueByCustomer[id]?.overdueInvoiceBalance || 0, displayName: pastDueByCustomer[id]?.customerName || 'Unknown' }; });
      }
    }

    const overdueCustomers = pastDueCustomerIds
      .map(custId => {
        const invInfo = pastDueByCustomer[custId];
        const custInfo = customerBalances[custId];
        const accountBalance = custInfo !== undefined ? custInfo.balance : invInfo.overdueInvoiceBalance;
        if (accountBalance <= 0) return null;
        return { customerId: custId, customerName: custInfo?.displayName || invInfo.customerName, overdueBalance: accountBalance, overdueInvoiceBalance: invInfo.overdueInvoiceBalance, invoiceCount: invInfo.invoiceCount, oldestDueDate: invInfo.oldestDueDate, daysOverdue: Math.floor((new Date(today) - new Date(invInfo.oldestDueDate)) / (1000 * 60 * 60 * 24)) };
      })
      .filter(Boolean)
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    res.json({ count: overdueCustomers.length, overdueCustomers });
  } catch (err) {
    console.error('[OVERDUE] Fatal error:', err.message);
    res.status(500).json({ error: 'Server error fetching overdue data', detail: err.message });
  }
});

// ─── INVOICE REP LOOKUP — downloads QB PDF and extracts sales rep text ────────
// Accepts invoice QB entity ID (not doc number). Returns { rep: "KK - Kimberly Kunzik Ungrafted" }
// Results are cached in memory for the life of the server process.
const repCache = {};

app.get('/api/invoice-rep/:invoiceId', async (req, res) => {
  const accessToken = await getValidAccessToken();
  const companyId   = tokenStore.companyId;
  const environment = tokenStore.environment;
  const { invoiceId } = req.params;
  if (!accessToken || !companyId) return res.status(400).json({ error: 'Not connected.' });

  // Return cached result immediately
  if (repCache[invoiceId] !== undefined) {
    return res.json({ rep: repCache[invoiceId], cached: true });
  }

  const baseUrls = environment === 'production'
    ? ['https://quickbooks.api.intuit.com', 'https://qbo.api.intuit.com', 'https://c1.qbo.intuit.com', 'https://c3.qbo.intuit.com', 'https://c5.qbo.intuit.com']
    : ['https://sandbox-quickbooks.api.intuit.com'];

  // Download the PDF bytes
  let pdfBuffer = null;
  for (const baseUrl of baseUrls) {
    try {
      const pdfUrl = `${baseUrl}/v3/company/${companyId}/invoice/${invoiceId}/pdf?minorversion=65`;
      const qbRes  = await fetch(pdfUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/pdf' } });
      if (qbRes.ok) {
        const arrayBuf = await qbRes.arrayBuffer();
        pdfBuffer = Buffer.from(arrayBuf);
        break;
      }
      if (qbRes.status === 401 || qbRes.status === 403) return res.status(qbRes.status).json({ error: 'QB auth error' });
    } catch (err) { /* try next cluster */ }
  }

  if (!pdfBuffer) {
    repCache[invoiceId] = '';
    return res.json({ rep: '', error: 'PDF not found' });
  }

  // Extract text with pdf-parse and look for SALES REP
  try {
    if (!pdfParse) {
      repCache[invoiceId] = '';
      return res.json({ rep: '', error: 'pdf-parse not installed on server' });
    }
    const parsed   = await pdfParse(pdfBuffer);
    const text     = parsed.text || '';

    // Your QB PDF layout:
    //   LICENSE #    SALES REP
    //   LIP.15640    KK - Kimberly Kunzik Ungrafted
    //
    // pdf-parse merges both label columns onto one line, then the values onto the next.
    // We find the value line after "LICENSE" + "SALES REP" headers, then extract
    // just the initials before the first dash (e.g. "KK").
    let rep = '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    // QB PDF layouts seen in the wild:
    //
    // Layout A (standard customer invoice):
    //   One merged line: "LICENSE #SALES REP LIP.15640KK - Kimberly Kunzik Ungrafted SKU..."
    //   or with injected date: "LICENSE #SALES REP 03/17/2026LIP.14175KK - Kimberly..."
    //   or full name: "LICENSE #SALES REP LIP.14175Branden Hylwa, Premium Beverage Solutions SKU..."
    //
    // Layout B (logistics/winery invoices — no LICENSE # header):
    //   "SALES REP 10157 - Mill CreekDR - Dominic SKU..."
    //   Rep is the part matching XX - Name after the winery name

    // From the logs we know pdf-parse produces lines like:
    //   "LICENSE #SALES REP LIP.15640KK - Kimberly Kunzik Ungrafted SKUPRODUCT..."
    // i.e. the headers AND the values are ALL on ONE merged line.
    // We search every line for this pattern and extract the rep.

    const extractRepFromValueStr = (str) => {
      // Strip license number (LIP.XXXXX or similar) and any injected dates
      const cleaned = str
        .replace(/\d{2}\/\d{2}\/\d{4}\s*/g, '')   // dates like 03/17/2026
        .replace(/[A-Z]{1,5}\.\d{4,6}\s*/i, '')      // license like LIP.15640
        .trim();

      // Format 1: initials before dash "KK - Kimberly" / "TRANS - Transatlantic" / "DR - Dominic"
      const m1 = cleaned.match(/^([A-Z]{1,6})\s*-\s*[A-Z]/);
      if (m1) return m1[1].trim();

      // Format 2: full name no dash "Branden Hylwa, Premium Beverage Solutions"
      const nameBeforeComma = cleaned.split(',')[0].trim();
      const parts = nameBeforeComma.split(/\s+/).filter(p => /^[A-Za-z]/.test(p));
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

      return '';
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // ── Case 1: headers and values on same merged line ──
      // "LICENSE #SALES REP LIP.15640KK - Kimberly..."
      if (/LICENSE/i.test(line) && /SALES.{0,6}REP/i.test(line)) {
        // Strip the header labels to isolate the value portion
        const afterHeaders = line.replace(/.*SALES\s*REP\s*/i, '').trim();
        rep = extractRepFromValueStr(afterHeaders);
        if (rep) break;

        // Fallback: value might be on next line
        const nextLine = (lines[i + 1] || '').replace(/\d{2}\/\d{2}\/\d{4}\s*/g, '').trim();
        if (nextLine) {
          rep = extractRepFromValueStr(nextLine);
          if (rep) break;
        }
        break;
      }

      // ── Case 2: "SALES REP" line with no LICENSE # (logistics invoices) ──
      // "SALES REP 10157 - Mill CreekDR - Dominic"
      // The rep initials always come AFTER the last winery number (e.g. 10157)
      if (/SALES\s*REP/i.test(line) && !/LICENSE/i.test(line)) {
        // Strip everything up to and including the last number sequence and winery name
        // Pattern: "SALES REP 10157 - Mill CreekDR - Dominic"
        // After the number + dash + winery, the rep initials start
        // Find the portion after the last run of digits
        const afterNum = line.replace(/.*\d+\s*-\s*/i, '').trim();
        // afterNum = "Mill CreekDR - Dominic SKUPRODUCT..."
        // The rep initials are the all-caps block that appears before " - " followed by a name
        // They are glued directly after the winery name with no space: "Mill CreekDR - Dominic"
        // Extract the last "XX - Name" where XX is all caps
        const m = afterNum.match(/([A-Z]+)\s*-\s*([A-Z][a-z])/);
        if (m) {
          // Make sure it's not a long word (winery names in all caps) — rep codes are 1-5 chars
          const candidate = m[1].trim();
          // Walk backwards from the match to find just the uppercase-only suffix
          // e.g. from "CreekDR" we want "DR" not "CREEKDR"
          const pureInitials = candidate.match(/[A-Z]+$/)?.[0] || candidate;
          rep = pureInitials.length <= 5 ? pureInitials : pureInitials.slice(-3);
          break;
        }
        // Fallback: value on next line
        const nextLine = (lines[i + 1] || '').trim();
        if (nextLine) { rep = extractRepFromValueStr(nextLine); if (rep) break; }
        break;
      }
    }

    // Log the section around LICENSE/SALES REP for debugging
    const repIdx = text.search(/LICENSE|SALES\s+REP/i);
    const textSnippet = repIdx >= 0 ? text.slice(repIdx, repIdx + 200).replace(/\n/g,' ') : text.slice(0,200).replace(/\n/g,' ');
    console.log(`[REP] Invoice ${invoiceId} → "${rep}" | around-rep: ${textSnippet}`);
    repCache[invoiceId] = rep;
    res.json({ rep });
  } catch (err) {
    console.error(`[REP] pdf-parse error for invoice ${invoiceId}:`, err.message);
    repCache[invoiceId] = '';
    res.json({ rep: '', error: err.message });
  }
});

// ─── INVOICE PDF PROXY ────────────────────────────────────────────────────────
app.get('/api/invoice-pdf/:invoiceId', async (req, res) => {
  const accessToken = await getValidAccessToken();
  const companyId = tokenStore.companyId;
  const environment = tokenStore.environment;
  const { invoiceId } = req.params;
  if (!accessToken || !companyId) return res.status(400).json({ error: 'Not connected to QuickBooks.' });

  const baseUrls = environment === 'production'
    ? ['https://quickbooks.api.intuit.com', 'https://qbo.api.intuit.com', 'https://c1.qbo.intuit.com', 'https://c3.qbo.intuit.com', 'https://c5.qbo.intuit.com']
    : ['https://sandbox-quickbooks.api.intuit.com'];

  for (const baseUrl of baseUrls) {
    const pdfUrl = `${baseUrl}/v3/company/${companyId}/invoice/${invoiceId}/pdf?minorversion=65`;
    try {
      const qbRes = await fetch(pdfUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/pdf' } });
      if (qbRes.ok) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Access-Control-Allow-Origin', '*');
        qbRes.body.pipe(res);
        return;
      }
      const errText = await qbRes.text();
      if (qbRes.status === 401 || qbRes.status === 403) return res.status(qbRes.status).json({ error: `QB auth error ${qbRes.status}` });
      if (qbRes.status !== 404) return res.status(qbRes.status).json({ error: `QB returned ${qbRes.status} for invoice ${invoiceId}` });
    } catch (err) { console.error(`Network error fetching PDF from ${baseUrl}:`, err.message); }
  }
  res.status(404).json({ error: `Invoice ${invoiceId} PDF not found in QuickBooks` });
});

// ─── CUSTOMER STATEMENT DATA ─────────────────────────────────────────────────
app.get('/api/customer-statement/:customerId', async (req, res) => {
  const accessToken = await getValidAccessToken();
  const companyId = tokenStore.companyId;
  const environment = tokenStore.environment;
  const { customerId } = req.params;
  if (!accessToken || !companyId) return res.status(400).json({ error: 'Not connected to QuickBooks.' });

  const today = new Date();
  const startDate = new Date(today.getFullYear(), 0, 1).toISOString().split('T')[0];
  const endDate = today.toISOString().split('T')[0];

  const baseUrls = environment === 'production'
    ? ['https://quickbooks.api.intuit.com', 'https://qbo.api.intuit.com', 'https://c1.qbo.intuit.com', 'https://c3.qbo.intuit.com', 'https://c5.qbo.intuit.com']
    : ['https://sandbox-quickbooks.api.intuit.com'];

  const qbGet = async (url) => {
    for (const baseUrl of baseUrls) {
      try {
        const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`;
        const r = await fetch(fullUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } });
        const data = await r.json();
        if (r.ok) return data;
        if (data?.Fault?.Error?.[0]?.code !== '130') throw new Error(JSON.stringify(data?.Fault));
      } catch (err) {
        if (baseUrl === baseUrls[baseUrls.length - 1]) throw err;
      }
    }
  };

  try {
    // Fetch the balance detail report
    let report = null;
    for (const baseUrl of baseUrls) {
      try {
        const url = `${baseUrl}/v3/company/${companyId}/reports/CustomerBalanceDetail?customer=${customerId}&start_date=${startDate}&end_date=${endDate}&minorversion=65`;
        const r = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } });
        const data = await r.json();
        if (r.ok) { report = data; break; }
        if (data?.Fault?.Error?.[0]?.code !== '130') break;
      } catch (err) { /* try next cluster */ }
    }
    if (!report) return res.status(404).json({ error: `Statement data not available for customer ${customerId}` });

    // Fetch invoices for this customer to build docNumber → salesRep map
    // QB Invoice has SalesRepRef (name of rep) if set
    const salesRepByInvoiceNum = {};
    try {
      const invQuery = `SELECT DocNumber, SalesTermRef, CustomField FROM Invoice WHERE CustomerRef = '${customerId}' AND TxnDate >= '${startDate}' MAXRESULTS 200`;
      for (const baseUrl of baseUrls) {
        try {
          const invUrl = `${baseUrl}/v3/company/${companyId}/query?query=${encodeURIComponent(invQuery)}&minorversion=65`;
          const invRes = await fetch(invUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } });
          const invData = await invRes.json();
          if (invRes.ok) {
            const invoices = invData.QueryResponse?.Invoice || [];
            for (const inv of invoices) {
              const docNum = inv.DocNumber || '';
              // QB Online stores sales rep in CustomField array — field name varies by company
              // Check common field names: "Sales Rep", "Rep", "Salesperson", "Sales Person"
              let rep = '';
              if (inv.CustomField && Array.isArray(inv.CustomField)) {
                for (const cf of inv.CustomField) {
                  const name = (cf.Name || '').toLowerCase();
                  if (name.includes('rep') || name.includes('sales') || name.includes('person')) {
                    rep = cf.StringValue || cf.BooleanValue || '';
                    if (rep) break;
                  }
                }
                // If nothing matched by name, take the first non-empty custom field
                if (!rep) {
                  for (const cf of inv.CustomField) {
                    if (cf.StringValue) { rep = cf.StringValue; break; }
                  }
                }
              }
              if (docNum) salesRepByInvoiceNum[docNum] = rep;
            }
            break;
          }
          if (invData?.Fault?.Error?.[0]?.code !== '130') break;
        } catch (err) { /* try next cluster */ }
      }
    } catch (err) {
      console.warn('[STATEMENT] Could not fetch sales rep data:', err.message);
    }

    res.json({ ok: true, report, startDate, endDate, salesRepByInvoiceNum });
  } catch (err) {
    console.error('[STATEMENT] Error:', err.message);
    res.status(500).json({ error: 'Statement fetch failed', detail: err.message });
  }
});

// ─── STATEMENT DEBUG ENDPOINT ────────────────────────────────────────────────
app.get('/api/debug-statement/:customerId', async (req, res) => {
  const accessToken = await getValidAccessToken();
  const companyId = tokenStore.companyId;
  const environment = tokenStore.environment;
  const { customerId } = req.params;
  if (!accessToken || !companyId) return res.json({ error: 'Not connected', hasToken: !!accessToken, companyId });

  const today = new Date();
  const startDate = new Date(today.getFullYear(), 0, 1).toISOString().split('T')[0];
  const endDate = today.toISOString().split('T')[0];
  const baseUrl = environment === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com';

  const urlsToTry = [
    { label: 'CustomerBalanceDetail (PDF)', url: `${baseUrl}/v3/company/${companyId}/reports/CustomerBalanceDetail?customer=${customerId}&start_date=${startDate}&end_date=${endDate}&minorversion=65`, accept: 'application/pdf' },
    { label: 'CustomerBalanceDetail (JSON)', url: `${baseUrl}/v3/company/${companyId}/reports/CustomerBalanceDetail?customer=${customerId}&start_date=${startDate}&end_date=${endDate}&minorversion=65`, accept: 'application/json' },
    { label: 'AgedReceivableDetail (PDF)', url: `${baseUrl}/v3/company/${companyId}/reports/AgedReceivableDetail?customer=${customerId}&report_date=${endDate}&minorversion=65`, accept: 'application/pdf' },
    { label: 'AgedReceivableDetail (JSON)', url: `${baseUrl}/v3/company/${companyId}/reports/AgedReceivableDetail?customer=${customerId}&report_date=${endDate}&minorversion=65`, accept: 'application/json' },
    { label: 'Legacy entity URL (PDF)', url: `${baseUrl}/v3/company/${companyId}/customer/${customerId}/statement?startDate=${startDate}&endDate=${endDate}&minorversion=65`, accept: 'application/pdf' },
  ];

  const results = [];
  for (const { label, url, accept } of urlsToTry) {
    try {
      const r = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': accept } });
      const body = await r.text();
      results.push({ label, status: r.status, contentType: r.headers.get('content-type'), bodyPreview: body.slice(0, 400) });
    } catch (err) { results.push({ label, error: err.message }); }
  }
  res.json({ customerId, environment, companyId: 'REDACTED', dateRange: { startDate, endDate }, results });
});

// ─── DEBUG: RAW INVOICE FIELDS FOR A CUSTOMER ────────────────────────────────
// ─── DEBUG: QB SALES REP / EMPLOYEE LIST + INVOICE FULL OBJECT ───────────────
app.get('/api/debug-salesrep/:customerId', async (req, res) => {
  const accessToken = await getValidAccessToken();
  const companyId   = tokenStore.companyId;
  const environment = tokenStore.environment;
  const { customerId } = req.params;
  if (!accessToken || !companyId) return res.json({ error: 'Not connected' });

  const baseUrls = environment === 'production'
    ? ['https://quickbooks.api.intuit.com', 'https://qbo.api.intuit.com', 'https://c1.qbo.intuit.com', 'https://c3.qbo.intuit.com', 'https://c5.qbo.intuit.com']
    : ['https://sandbox-quickbooks.api.intuit.com'];

  const startDate = `${new Date().getFullYear()}-01-01`;
  const results = {};

  const qbQuery = async (query) => {
    for (const baseUrl of baseUrls) {
      try {
        const url = `${baseUrl}/v3/company/${companyId}/query?query=${encodeURIComponent(query)}&minorversion=65`;
        const r = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } });
        const data = await r.json();
        if (r.ok) return data;
        if (data?.Fault?.Error?.[0]?.code !== '130') return { error: data?.Fault };
      } catch (err) { /* try next */ }
    }
    return { error: 'all clusters failed' };
  };

  // 1. Fetch the raw full invoice object (not SELECT * — fetch by entity read)
  const startDate2 = `${new Date().getFullYear()}-01-01`;
  const invData = await qbQuery(`SELECT * FROM Invoice WHERE CustomerRef = '${customerId}' AND TxnDate >= '${startDate2}' ORDERBY TxnDate DESC MAXRESULTS 1`);
  const rawInv = invData?.QueryResponse?.Invoice?.[0] || null;
  results.rawInvoiceFull = rawInv;

  // 2. Try fetching the invoice by entity read (sometimes returns more fields)
  if (rawInv?.Id) {
    for (const baseUrl of baseUrls) {
      try {
        const url = `${baseUrl}/v3/company/${companyId}/invoice/${rawInv.Id}?minorversion=65`;
        const r = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } });
        const data = await r.json();
        if (r.ok) { results.invoiceEntityRead = data.Invoice; break; }
      } catch (err) { /* skip */ }
    }
  }

  // 3. Fetch Employee list (sales reps are often stored as employees in QB)
  const empData = await qbQuery(`SELECT * FROM Employee MAXRESULTS 50`);
  results.employees = empData?.QueryResponse?.Employee || empData?.error || [];

  // 4. Fetch Vendor list (some companies store reps as vendors)
  const vendData = await qbQuery(`SELECT Id, DisplayName, CustomField FROM Vendor WHERE Active = true MAXRESULTS 50`);
  results.vendors = vendData?.QueryResponse?.Vendor || vendData?.error || [];

  res.json(results);
});

// ─── DEBUG: QB SALESREP ENTITY LIST + FETCH INVOICE BY DOC NUMBER ────────────
app.get('/api/debug-salesrep-list', async (req, res) => {
  const accessToken = await getValidAccessToken();
  const companyId   = tokenStore.companyId;
  const environment = tokenStore.environment;
  if (!accessToken || !companyId) return res.json({ error: 'Not connected' });

  const baseUrls = environment === 'production'
    ? ['https://quickbooks.api.intuit.com', 'https://qbo.api.intuit.com', 'https://c1.qbo.intuit.com', 'https://c3.qbo.intuit.com', 'https://c5.qbo.intuit.com']
    : ['https://sandbox-quickbooks.api.intuit.com'];

  const results = {};

  const qbQuery = async (query) => {
    for (const baseUrl of baseUrls) {
      try {
        const url = `${baseUrl}/v3/company/${companyId}/query?query=${encodeURIComponent(query)}&minorversion=65`;
        const r = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } });
        const data = await r.json();
        if (r.ok) return data;
        if (data?.Fault?.Error?.[0]?.code !== '130') return { error: data?.Fault };
      } catch (err) { /* try next */ }
    }
    return { error: 'all clusters failed' };
  };

  // 1. Try the SalesRep entity directly
  const srData = await qbQuery(`SELECT * FROM SalesRep MAXRESULTS 100`);
  results.salesRepEntity = srData?.QueryResponse?.SalesRep || srData?.error || 'no results';

  // 2. Try OtherName list (some QB setups store reps here)
  const onData = await qbQuery(`SELECT * FROM OtherName MAXRESULTS 100`);
  results.otherNames = onData?.QueryResponse?.OtherName || onData?.error || 'no results';

  // 3. Fetch a specific invoice by DocNumber — pass ?docnum=XXXXX
  const docNum = req.query.docnum;
  if (docNum) {
    const invData = await qbQuery(`SELECT * FROM Invoice WHERE DocNumber = '${docNum}'`);
    const inv = invData?.QueryResponse?.Invoice?.[0] || null;
    results.invoiceByDocNum = inv ? {
      DocNumber:   inv.DocNumber,
      CustomField: inv.CustomField || [],
      // Dump every field that might reference a rep
      _allKeys:    Object.keys(inv),
      _full:       inv
    } : 'not found';
  }

  res.json(results);
});

// ─── DEBUG: RAW CUSTOMER FIELDS ──────────────────────────────────────────────
app.get('/api/debug-customer-fields/:customerId', async (req, res) => {
  const accessToken = await getValidAccessToken();
  const companyId   = tokenStore.companyId;
  const environment = tokenStore.environment;
  const { customerId } = req.params;
  if (!accessToken || !companyId) return res.json({ error: 'Not connected' });

  const baseUrls = environment === 'production'
    ? ['https://quickbooks.api.intuit.com', 'https://qbo.api.intuit.com', 'https://c1.qbo.intuit.com', 'https://c3.qbo.intuit.com', 'https://c5.qbo.intuit.com']
    : ['https://sandbox-quickbooks.api.intuit.com'];

  for (const baseUrl of baseUrls) {
    try {
      const url = `${baseUrl}/v3/company/${companyId}/customer/${customerId}?minorversion=65`;
      const r   = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } });
      const data = await r.json();
      if (!r.ok) {
        if (data?.Fault?.Error?.[0]?.code === '130') continue;
        return res.json({ error: 'QB error', detail: data?.Fault });
      }
      const c = data.Customer || data;
      return res.json({
        environment,
        Id:           c.Id,
        DisplayName:  c.DisplayName,
        CustomField:  c.CustomField  || [],
        SalesRepRef:  c.SalesRepRef  || null,
        _allTopLevelKeys: Object.keys(c),
        _fullRecord: c
      });
    } catch (err) {
      if (baseUrl === baseUrls[baseUrls.length - 1])
        return res.status(500).json({ error: err.message });
    }
  }
});

// Hit /api/debug-invoice-fields/:customerId to see exactly what QB returns
// for that customer's invoices — use this to find the sales rep field name.
app.get('/api/debug-invoice-fields/:customerId', async (req, res) => {
  const accessToken = await getValidAccessToken();
  const companyId   = tokenStore.companyId;
  const environment = tokenStore.environment;
  const { customerId } = req.params;
  if (!accessToken || !companyId) return res.json({ error: 'Not connected' });

  const baseUrls = environment === 'production'
    ? ['https://quickbooks.api.intuit.com', 'https://qbo.api.intuit.com', 'https://c1.qbo.intuit.com', 'https://c3.qbo.intuit.com', 'https://c5.qbo.intuit.com']
    : ['https://sandbox-quickbooks.api.intuit.com'];

  const startDate = `${new Date().getFullYear()}-01-01`;

  // Try fetching with * (all fields) so we can see everything QB returns
  const query = `SELECT * FROM Invoice WHERE CustomerRef = '${customerId}' AND TxnDate >= '${startDate}' ORDERBY TxnDate DESC MAXRESULTS 3`;

  for (const baseUrl of baseUrls) {
    try {
      const url = `${baseUrl}/v3/company/${companyId}/query?query=${encodeURIComponent(query)}&minorversion=65`;
      const r   = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } });
      const data = await r.json();
      if (!r.ok) {
        if (data?.Fault?.Error?.[0]?.code === '130') continue;
        return res.json({ error: 'QB error', detail: data?.Fault });
      }
      const invoices = data.QueryResponse?.Invoice || [];
      // Return a stripped-down view: just the fields that could contain a sales rep
      const summary = invoices.map(inv => ({
        DocNumber:    inv.DocNumber,
        TxnDate:      inv.TxnDate,
        // These are the most common places QB stores sales rep info:
        SalesTermRef: inv.SalesTermRef || null,
        ClassRef:     inv.ClassRef     || null,
        DepartmentRef:inv.DepartmentRef|| null,
        CustomField:  inv.CustomField  || [],   // <-- what we need to see
        // Also dump the full top-level keys so nothing is missed
        _allTopLevelKeys: Object.keys(inv),
      }));
      return res.json({ count: invoices.length, environment, invoices: summary });
    } catch (err) {
      if (baseUrl === baseUrls[baseUrls.length - 1])
        return res.status(500).json({ error: err.message });
    }
  }
});

// ─── FETCH CUSTOMERS ──────────────────────────────────────────────────────────
app.get('/api/customers', async (req, res) => {
  let accessToken = await getValidAccessToken();
  const companyId = tokenStore.companyId;
  const environment = tokenStore.environment;
  if (!accessToken || !companyId) return res.status(400).json({ error: 'Not connected to QuickBooks.' });

  const baseUrl = environment === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com';
  try {
    const custHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' };
    const custUrl = `${baseUrl}/v3/company/${companyId}/query?query=${encodeURIComponent('SELECT * FROM Customer WHERE Active = true ORDERBY DisplayName ASC MAXRESULTS 200')}&minorversion=65`;
    let response = await fetch(custUrl, { method: 'GET', headers: custHeaders, redirect: 'manual' });
    if ([301, 302, 307, 308].includes(response.status)) response = await fetch(response.headers.get('location'), { method: 'GET', headers: custHeaders });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: 'QuickBooks API error', details: data });

    const formatAddress = (addr) => {
      if (!addr) return null;
      const line1 = addr.Line1||'', line2 = addr.Line2||'', line3 = addr.Line3||'', line4 = addr.Line4||'', line5 = addr.Line5||'';
      let city = addr.City||'', state = addr.CountrySubDivisionCode||'', zip = addr.PostalCode||'';
      if (!zip) { const m = [line3,line4,line5].join(' ').match(/\b(\d{5})(?:-\d{4})?\b/); if(m) zip=m[1]; }
      if (!city||!state) { for(const l of [line3,line4,line5].filter(Boolean)) { const m=l.match(/^([^,]+),?\s+([A-Z]{2})\s+\d{5}/); if(m){if(!city)city=m[1].trim();if(!state)state=m[2].trim();break;} } }
      const full = [line2,city,state,zip].filter(Boolean).join(', ') || [line1,line2].filter(Boolean).join(' ') || line1;
      return { line1, line2, line3, city, state, zip, full };
    };

    const formatted = (data.QueryResponse?.Customer || []).map(c => ({
      id: c.Id, displayName: c.DisplayName, companyName: c.CompanyName||null,
      email: c.PrimaryEmailAddr?.Address||null, phone: c.PrimaryPhone?.FreeFormNumber||null,
      balance: c.Balance, shipAddress: formatAddress(c.ShipAddr), billAddress: formatAddress(c.BillAddr)
    }));
    res.json({ count: formatted.length, customers: formatted, environment, queriedAt: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: 'Server error fetching customers' }); }
});

// ─── TOKEN STATUS ─────────────────────────────────────────────────────────────
app.get('/api/token-status', (req, res) => {
  const refreshTokenExpiresInDays = tokenStore.refreshTokenExpiresAt
    ? Math.round((tokenStore.refreshTokenExpiresAt - Date.now()) / (1000 * 60 * 60 * 24))
    : null;
  res.json({
    connected: !!tokenStore.accessToken,
    expiresInSeconds: tokenStore.expiresAt ? Math.round((tokenStore.expiresAt - Date.now()) / 1000) : null,
    refreshTokenExpiresInDays,
    refreshTokenExpiringSoon: refreshTokenExpiresInDays !== null && refreshTokenExpiresInDays <= 14,
    refreshTokenExpired: refreshTokenExpiresInDays !== null && refreshTokenExpiresInDays <= 0,
    environment: tokenStore.environment,
    companyId: tokenStore.companyId
  });
});

// ─── OAUTH AUTHORIZE ─────────────────────────────────────────────────────────
app.get('/authorize', (req, res) => {
  const clientId = tokenStore.clientId || process.env.QB_CLIENT_ID;
  const redirectUri = `https://cellar-route-server-production.up.railway.app/callback`;
  const url = `https://appcenter.intuit.com/connect/oauth2?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent('com.intuit.quickbooks.accounting')}&state=cellarroute_${Date.now()}`;
  res.redirect(url);
});

// ─── OAUTH CALLBACK ───────────────────────────────────────────────────────────
app.get('/callback', async (req, res) => {
  const { code, realmId, error } = req.query;
  if (error) return res.send(`<h2>Authorization failed: ${error}</h2>`);
  if (!code || !realmId) return res.send('<h2>Missing code or realmId</h2>');
  try {
    const clientId = tokenStore.clientId || process.env.QB_CLIENT_ID;
    const clientSecret = tokenStore.clientSecret || process.env.QB_CLIENT_SECRET;
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent('https://cellar-route-server-production.up.railway.app/callback')}`
    });
    const data = await response.json();
    if (!response.ok) return res.send(`<h2>Token exchange failed</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
    tokenStore.accessToken = data.access_token;
    tokenStore.refreshToken = data.refresh_token;
    tokenStore.companyId = realmId;
    tokenStore.expiresAt = Date.now() + (data.expires_in - 300) * 1000;
    tokenStore.refreshTokenExpiresAt = Date.now() + (101 * 24 * 60 * 60 * 1000);
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:sans-serif;background:#4A1320;color:#F7F2EA;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}.card{background:#6B1E2E;border-radius:16px;padding:32px;max-width:500px;width:100%}h2{color:#E8C97A;font-size:22px;margin-bottom:16px}.token{background:rgba(0,0,0,0.3);border-radius:8px;padding:12px;font-size:12px;word-break:break-all;margin:12px 0}.label{font-size:11px;color:#C9A84C;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px}.btn{display:block;background:#C9A84C;color:#4A1320;padding:14px;border-radius:10px;text-align:center;font-weight:bold;text-decoration:none;margin-top:20px;font-size:15px}</style></head><body><div class="card"><h2>✓ QuickBooks Connected!</h2><p>Your app is now connected to your real QuickBooks company.</p><div class="label">Company (Realm) ID</div><div class="token">${realmId}</div><div class="label">Refresh Token — Save this in Railway as QB_REFRESH_TOKEN</div><div class="token">${data.refresh_token}</div><p style="color:#E8C97A;font-size:13px">⚠️ Copy the Refresh Token above and update QB_REFRESH_TOKEN in your Railway variables.</p><a class="btn" href="/">Go to Cellar Route App →</a></div></body></html>`);
  } catch (err) { res.send(`<h2>Server error</h2><pre>${err.message}</pre>`); }
});

app.listen(PORT, async () => {
  console.log(`Cellar Route Server running on port ${PORT}`);
  await startup();
});
