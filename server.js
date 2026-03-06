const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Serve the Cellar Route frontend app from /public folder
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
  refreshTokenExpiresAt: Date.now() + (101 * 24 * 60 * 60 * 1000) // ~101 days from first run
};

// ─── TOKEN REFRESH ────────────────────────────────────────────────────────────
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
    if (!response.ok) {
      console.error('Token refresh failed:', data.error);
      return false;
    }
    tokenStore.accessToken = data.access_token;
    tokenStore.refreshToken = data.refresh_token; // Intuit rotates refresh tokens
    tokenStore.expiresAt = Date.now() + (data.expires_in - 300) * 1000; // refresh 5 min early
    // Intuit refresh tokens last ~101 days — reset the expiry clock on each rotation
    tokenStore.refreshTokenExpiresAt = Date.now() + (101 * 24 * 60 * 60 * 1000);
    console.log('✓ Access token refreshed successfully');
    return true;
  } catch (err) {
    console.error('Token refresh error:', err);
    return false;
  }
}

// Get a valid access token — auto-refreshes if expired
async function getValidAccessToken() {
  if (!tokenStore.accessToken || (tokenStore.expiresAt && Date.now() >= tokenStore.expiresAt)) {
    const success = await doTokenRefresh();
    if (!success) return null;
  }
  return tokenStore.accessToken;
}

// Auto-refresh every 50 minutes
setInterval(async () => {
  await doTokenRefresh();
}, 50 * 60 * 1000);

// ─── STARTUP: GET INITIAL TOKEN ───────────────────────────────────────────────
async function startup() {
  console.log('Cellar Route Server starting...');
  console.log(`Environment: ${tokenStore.environment}`);
  console.log(`Company ID: ${tokenStore.companyId}`);

  if (tokenStore.refreshToken && tokenStore.clientId && tokenStore.clientSecret) {
    console.log('Credentials found in environment variables — fetching initial access token...');
    const success = await doTokenRefresh();
    if (success) {
      console.log('✓ Ready! Auto-refresh is active.');
    } else {
      console.log('⚠️ Could not get initial token — check your Railway environment variables.');
    }
  } else {
    console.log('⚠️ No credentials in environment variables. Manual connection required.');
  }
}

// ─── SAVE CREDENTIALS (manual override from app) ─────────────────────────────
app.post('/api/connect', async (req, res) => {
  const { accessToken, refreshToken, clientId, clientSecret, companyId, environment, expiresIn } = req.body;
  if (!accessToken || !companyId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  // Override store with manually provided credentials
  if (refreshToken) tokenStore.refreshToken = refreshToken;
  if (clientId) tokenStore.clientId = clientId;
  if (clientSecret) tokenStore.clientSecret = clientSecret;
  tokenStore.accessToken = accessToken;
  tokenStore.companyId = companyId;
  tokenStore.environment = environment || tokenStore.environment;
  tokenStore.expiresAt = Date.now() + ((expiresIn || 3600) - 300) * 1000;
  console.log(`Credentials updated manually for company ${companyId}`);
  res.json({ success: true, message: 'Credentials saved. Token will auto-refresh.' });
});

// ─── REFRESH TOKEN (manual) ───────────────────────────────────────────────────
app.post('/api/refresh-token', async (req, res) => {
  const { refreshToken, clientId, clientSecret } = req.body;
  if (!refreshToken || !clientId || !clientSecret) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || 'Token refresh failed', details: data });
    }
    tokenStore.accessToken = data.access_token;
    tokenStore.refreshToken = data.refresh_token;
    tokenStore.expiresAt = Date.now() + (data.expires_in - 300) * 1000;
    res.json({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in
    });
  } catch (err) {
    console.error('Token refresh error:', err);
    res.status(500).json({ error: 'Server error during token refresh' });
  }
});

// ─── FETCH INVOICES ───────────────────────────────────────────────────────────
app.post('/api/invoices', async (req, res) => {
  // Use server-stored token first, fall back to request token
  let accessToken = await getValidAccessToken() || req.body.accessToken;
  const companyId = tokenStore.companyId || req.body.companyId;
  const environment = tokenStore.environment || req.body.environment;

  if (!accessToken || !companyId) {
    return res.status(400).json({ error: 'Not connected to QuickBooks. Check Railway environment variables.' });
  }

  const baseUrl = environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const query = environment === 'production'
    ? `SELECT * FROM Invoice WHERE TxnDate = '${todayStr}' ORDERBY TxnDate ASC MAXRESULTS 100`
    : `SELECT * FROM Invoice ORDERBY TxnDate DESC MAXRESULTS 100`;

  try {
    const response = await fetch(
      `${baseUrl}/v3/company/${companyId}/query?query=${encodeURIComponent(query)}&minorversion=65`,
      { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } }
    );
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'QuickBooks API error', details: data });
    }

    const invoices = data.QueryResponse?.Invoice || [];
    const formatAddress = (addr) => {
      if (!addr) return null;
      return {
        line1: addr.Line1 || '', line2: addr.Line2 || '',
        city: addr.City || '', state: addr.CountrySubDivisionCode || '',
        zip: addr.PostalCode || '',
        full: [addr.Line1, addr.City, addr.CountrySubDivisionCode, addr.PostalCode].filter(Boolean).join(', ')
      };
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
      lineItems: (inv.Line || []).map(l => ({ qty: l.SalesItemLineDetail?.Qty || 0, description: l.Description || '' })),
      shipAddress: formatAddress(inv.ShipAddr),
      billAddress: formatAddress(inv.BillAddr)
    }));

    res.json({
      count: formatted.length,
      invoices: formatted,
      environment,
      autoRefresh: true,
      queriedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Invoice fetch error:', err);
    res.status(500).json({ error: 'Server error fetching invoices' });
  }
});

// ─── FETCH CUSTOMERS ──────────────────────────────────────────────────────────
app.post('/api/customers', async (req, res) => {
  let accessToken = await getValidAccessToken() || req.body.accessToken;
  const companyId = tokenStore.companyId || req.body.companyId;
  const environment = tokenStore.environment || req.body.environment;

  if (!accessToken || !companyId) {
    return res.status(400).json({ error: 'Not connected to QuickBooks.' });
  }

  const baseUrl = environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

  try {
    const response = await fetch(
      `${baseUrl}/v3/company/${companyId}/query?query=${encodeURIComponent('SELECT * FROM Customer WHERE Active = true ORDERBY DisplayName ASC MAXRESULTS 200')}&minorversion=65`,
      { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } }
    );
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'QuickBooks API error', details: data });
    }

    const formatAddress = (addr) => {
      if (!addr) return null;
      return {
        line1: addr.Line1 || '', line2: addr.Line2 || '',
        city: addr.City || '', state: addr.CountrySubDivisionCode || '',
        zip: addr.PostalCode || '',
        full: [addr.Line1, addr.City, addr.CountrySubDivisionCode, addr.PostalCode].filter(Boolean).join(', ')
      };
    };

    const formatted = (data.QueryResponse?.Customer || []).map(c => ({
      id: c.Id, displayName: c.DisplayName, companyName: c.CompanyName || null,
      email: c.PrimaryEmailAddr?.Address || null, phone: c.PrimaryPhone?.FreeFormNumber || null,
      balance: c.Balance, shipAddress: formatAddress(c.ShipAddr), billAddress: formatAddress(c.BillAddr)
    }));

    res.json({ count: formatted.length, customers: formatted, environment, queriedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Customer fetch error:', err);
    res.status(500).json({ error: 'Server error fetching customers' });
  }
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

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Cellar Route Server running on port ${PORT}`);
  await startup();
});
