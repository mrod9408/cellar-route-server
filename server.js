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
// Stores the current token set in memory on the server
// Automatically refreshes before expiry so the app never goes stale
let tokenStore = {
  accessToken: null,
  refreshToken: null,
  clientId: null,
  clientSecret: null,
  expiresAt: null,      // timestamp when access token expires
  companyId: null,
  environment: 'sandbox'
};

// Refresh the access token using the stored refresh token
async function doTokenRefresh() {
  if (!tokenStore.refreshToken || !tokenStore.clientId || !tokenStore.clientSecret) {
    console.log('No refresh token stored — skipping auto-refresh');
    return false;
  }
  try {
    console.log('Auto-refreshing access token...');
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
      console.error('Auto-refresh failed:', data.error);
      return false;
    }
    tokenStore.accessToken = data.access_token;
    tokenStore.refreshToken = data.refresh_token; // Intuit rotates refresh tokens
    tokenStore.expiresAt = Date.now() + (data.expires_in - 300) * 1000; // refresh 5 min early
    console.log('Access token refreshed successfully');
    return true;
  } catch (err) {
    console.error('Auto-refresh error:', err);
    return false;
  }
}

// Get a valid access token — refreshes automatically if expiring soon
async function getValidAccessToken() {
  if (!tokenStore.accessToken) return null;
  if (tokenStore.expiresAt && Date.now() >= tokenStore.expiresAt) {
    const success = await doTokenRefresh();
    if (!success) return null;
  }
  return tokenStore.accessToken;
}

// Auto-refresh timer — checks every 50 minutes
setInterval(async () => {
  if (tokenStore.refreshToken && tokenStore.expiresAt && Date.now() >= tokenStore.expiresAt) {
    await doTokenRefresh();
  }
}, 50 * 60 * 1000);

// ─── SAVE CREDENTIALS ────────────────────────────────────────────────────────
// Called once when the app first connects — stores credentials server-side
app.post('/api/connect', async (req, res) => {
  const { accessToken, refreshToken, clientId, clientSecret, companyId, environment, expiresIn } = req.body;

  if (!accessToken || !refreshToken || !clientId || !clientSecret || !companyId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  tokenStore = {
    accessToken,
    refreshToken,
    clientId,
    clientSecret,
    companyId,
    environment: environment || 'sandbox',
    expiresAt: Date.now() + ((expiresIn || 3600) - 300) * 1000
  };

  console.log(`Credentials stored for company ${companyId} (${environment})`);
  res.json({ success: true, message: 'Credentials saved. Token will auto-refresh.' });
});

// ─── REFRESH TOKEN (manual) ───────────────────────────────────────────────────
app.post('/api/refresh-token', async (req, res) => {
  const { refreshToken, clientId, clientSecret } = req.body;

  if (!refreshToken || !clientId || !clientSecret) {
    return res.status(400).json({ error: 'Missing required fields: refreshToken, clientId, clientSecret' });
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

    // Update the token store with new tokens
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
  const { companyId, environment } = req.body;

  // Use server-stored token if available, otherwise fall back to request token
  let accessToken = await getValidAccessToken();
  const effectiveCompanyId = companyId || tokenStore.companyId;
  const effectiveEnv = environment || tokenStore.environment;

  if (!accessToken) {
    accessToken = req.body.accessToken;
  }

  if (!accessToken || !effectiveCompanyId) {
    return res.status(400).json({ error: 'Missing required fields: accessToken, companyId' });
  }

  const baseUrl = effectiveEnv === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const query = effectiveEnv === 'production'
    ? `SELECT * FROM Invoice WHERE TxnDate = '${todayStr}' ORDERBY TxnDate ASC MAXRESULTS 100`
    : `SELECT * FROM Invoice ORDERBY TxnDate DESC MAXRESULTS 100`;

  try {
    const response = await fetch(
      `${baseUrl}/v3/company/${effectiveCompanyId}/query?query=${encodeURIComponent(query)}&minorversion=65`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: 'QuickBooks API error', details: data });
    }

    const invoices = data.QueryResponse?.Invoice || [];

    const formatAddress = (addr) => {
      if (!addr) return null;
      return {
        line1: addr.Line1 || '',
        line2: addr.Line2 || '',
        city: addr.City || '',
        state: addr.CountrySubDivisionCode || '',
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
      environment: effectiveEnv,
      tokenAutoRefresh: true,
      queriedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Invoice fetch error:', err);
    res.status(500).json({ error: 'Server error fetching invoices' });
  }
});

// ─── FETCH CUSTOMERS ──────────────────────────────────────────────────────────
app.post('/api/customers', async (req, res) => {
  const { companyId, environment } = req.body;

  let accessToken = await getValidAccessToken();
  const effectiveCompanyId = companyId || tokenStore.companyId;
  const effectiveEnv = environment || tokenStore.environment;

  if (!accessToken) accessToken = req.body.accessToken;
  if (!accessToken || !effectiveCompanyId) {
    return res.status(400).json({ error: 'Missing required fields: accessToken, companyId' });
  }

  const baseUrl = effectiveEnv === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

  const query = `SELECT * FROM Customer WHERE Active = true ORDERBY DisplayName ASC MAXRESULTS 200`;

  try {
    const response = await fetch(
      `${baseUrl}/v3/company/${effectiveCompanyId}/query?query=${encodeURIComponent(query)}&minorversion=65`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: 'QuickBooks API error', details: data });
    }

    const customers = data.QueryResponse?.Customer || [];

    const formatAddress = (addr) => {
      if (!addr) return null;
      return {
        line1: addr.Line1 || '',
        line2: addr.Line2 || '',
        city: addr.City || '',
        state: addr.CountrySubDivisionCode || '',
        zip: addr.PostalCode || '',
        full: [addr.Line1, addr.City, addr.CountrySubDivisionCode, addr.PostalCode].filter(Boolean).join(', ')
      };
    };

    const formatted = customers.map(c => ({
      id: c.Id,
      displayName: c.DisplayName,
      companyName: c.CompanyName || null,
      email: c.PrimaryEmailAddr?.Address || null,
      phone: c.PrimaryPhone?.FreeFormNumber || null,
      balance: c.Balance,
      shipAddress: formatAddress(c.ShipAddr),
      billAddress: formatAddress(c.BillAddr)
    }));

    res.json({
      count: formatted.length,
      customers: formatted,
      environment: effectiveEnv,
      queriedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Customer fetch error:', err);
    res.status(500).json({ error: 'Server error fetching customers' });
  }
});

// ─── TOKEN STATUS ─────────────────────────────────────────────────────────────
app.get('/api/token-status', (req, res) => {
  const hasToken = !!tokenStore.accessToken;
  const expiresIn = tokenStore.expiresAt ? Math.round((tokenStore.expiresAt - Date.now()) / 1000) : null;
  res.json({
    connected: hasToken,
    expiresInSeconds: expiresIn,
    environment: tokenStore.environment,
    companyId: tokenStore.companyId
  });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Cellar Route Server running on port ${PORT}`);
  console.log(`App available at http://localhost:${PORT}/`);
});
