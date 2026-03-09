const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.options('*', cors());

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

// ─── CLIENT CONFIG (safe to expose to frontend) ───────────────────────────────
// Serves non-secret config values to the frontend so tokens are never hardcoded in source
app.get('/api/config', (req, res) => {
  res.json({
    mapboxToken: process.env.MAPBOX_TOKEN || ''
  });
});

// ─── SAVE CREDENTIALS (manual override from app) ─────────────────────────────
app.post('/api/connect', async (req, res) => {
  const { accessToken, refreshToken, clientId, clientSecret, companyId, environment, expiresIn } = req.body;
  if (!accessToken || !companyId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
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
app.get('/api/invoices', async (req, res) => {
  let accessToken = await getValidAccessToken();
  const companyId = tokenStore.companyId;
  const environment = tokenStore.environment;

  if (!accessToken || !companyId) {
    return res.status(400).json({ error: 'Not connected to QuickBooks. Check Railway environment variables.' });
  }

  const baseUrls = environment === 'production'
    ? ['https://quickbooks.api.intuit.com', 'https://qbo.api.intuit.com', 'https://c1.qbo.intuit.com', 'https://c3.qbo.intuit.com', 'https://c5.qbo.intuit.com']
    : ['https://sandbox-quickbooks.api.intuit.com'];

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const query = environment === 'production'
    ? `SELECT * FROM Invoice WHERE TxnDate = '${todayStr}' ORDERBY TxnDate ASC MAXRESULTS 100`
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
      } catch (urlErr) {
        console.log(`Failed to connect to ${tryUrl}: ${urlErr.message}`);
      }
    }

    if (!response || !response.ok) {
      return res.status(500).json({ error: 'QuickBooks API error', details: data });
    }

    const invoices = data.QueryResponse?.Invoice || [];
    const formatAddress = (addr) => {
      if (!addr) return null;
      const line1 = addr.Line1 || '';
      const line2 = addr.Line2 || '';
      const city = addr.City || '';
      const state = addr.CountrySubDivisionCode || '';
      const zip = addr.PostalCode || '';
      const full = [line2, city, state, zip].filter(Boolean).join(', ')
        || [line1, line2].filter(Boolean).join(' ')
        || line1;
      return { line1, line2, city, state, zip, full };
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
app.get('/api/customers', async (req, res) => {
  let accessToken = await getValidAccessToken();
  const companyId = tokenStore.companyId;
  const environment = tokenStore.environment;

  if (!accessToken || !companyId) {
    return res.status(400).json({ error: 'Not connected to QuickBooks.' });
  }

  const baseUrl = environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

  try {
    const custHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' };
    const custUrl = `${baseUrl}/v3/company/${companyId}/query?query=${encodeURIComponent('SELECT * FROM Customer WHERE Active = true ORDERBY DisplayName ASC MAXRESULTS 200')}&minorversion=65`;

    let response = await fetch(custUrl, { method: 'GET', headers: custHeaders, redirect: 'manual' });

    if ([301, 302, 307, 308].includes(response.status)) {
      const redirectUrl = response.headers.get('location');
      console.log(`Following QB redirect to: ${redirectUrl}`);
      response = await fetch(redirectUrl, { method: 'GET', headers: custHeaders });
    }

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'QuickBooks API error', details: data });
    }

    const formatAddress = (addr) => {
      if (!addr) return null;
      const line1 = addr.Line1 || '';
      const line2 = addr.Line2 || '';
      const city = addr.City || '';
      const state = addr.CountrySubDivisionCode || '';
      const zip = addr.PostalCode || '';
      const full = [line2, city, state, zip].filter(Boolean).join(', ')
        || [line1, line2].filter(Boolean).join(' ')
        || line1;
      return { line1, line2, city, state, zip, full };
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

// ─── OAUTH AUTHORIZE ─────────────────────────────────────────────────────────
app.get('/authorize', (req, res) => {
  const clientId = tokenStore.clientId || process.env.QB_CLIENT_ID;
  const redirectUri = `https://cellar-route-server-production.up.railway.app/callback`;
  const scope = 'com.intuit.quickbooks.accounting';
  const state = 'cellarroute_' + Date.now();
  const url = `https://appcenter.intuit.com/connect/oauth2?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`;
  res.redirect(url);
});

// ─── OAUTH CALLBACK ───────────────────────────────────────────────────────────
app.get('/callback', async (req, res) => {
  const { code, realmId, error } = req.query;

  if (error) {
    return res.send(`<h2>Authorization failed: ${error}</h2><p>Go back and try again.</p>`);
  }
  if (!code || !realmId) {
    return res.send('<h2>Missing code or realmId</h2><p>Something went wrong. Try visiting /authorize again.</p>');
  }

  try {
    const clientId = tokenStore.clientId || process.env.QB_CLIENT_ID;
    const clientSecret = tokenStore.clientSecret || process.env.QB_CLIENT_SECRET;
    const redirectUri = 'https://cellar-route-server-production.up.railway.app/callback';
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}`
    });

    const data = await response.json();

    if (!response.ok) {
      return res.send(`<h2>Token exchange failed</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
    }

    tokenStore.accessToken = data.access_token;
    tokenStore.refreshToken = data.refresh_token;
    tokenStore.companyId = realmId;
    tokenStore.expiresAt = Date.now() + (data.expires_in - 300) * 1000;
    tokenStore.refreshTokenExpiresAt = Date.now() + (101 * 24 * 60 * 60 * 1000);

    console.log(`✓ OAuth complete! Company ID: ${realmId}`);
    console.log(`✓ Refresh Token: ${data.refresh_token}`);
    console.log(`✓ Copy this refresh token to your QB_REFRESH_TOKEN Railway variable!`);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: sans-serif; background: #4A1320; color: #F7F2EA; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
          .card { background: #6B1E2E; border-radius: 16px; padding: 32px; max-width: 500px; width: 100%; }
          h2 { color: #E8C97A; font-size: 22px; margin-bottom: 16px; }
          p { font-size: 14px; line-height: 1.6; margin-bottom: 12px; }
          .token { background: rgba(0,0,0,0.3); border-radius: 8px; padding: 12px; font-size: 12px; word-break: break-all; margin: 12px 0; }
          .label { font-size: 11px; color: #C9A84C; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
          .btn { display: block; background: #C9A84C; color: #4A1320; padding: 14px; border-radius: 10px; text-align: center; font-weight: bold; text-decoration: none; margin-top: 20px; font-size: 15px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>✓ QuickBooks Connected!</h2>
          <p>Your app is now connected to your real QuickBooks company.</p>
          <div class="label">Company (Realm) ID</div>
          <div class="token">${realmId}</div>
          <div class="label">Refresh Token — Save this in Railway as QB_REFRESH_TOKEN</div>
          <div class="token">${data.refresh_token}</div>
          <p style="color:#E8C97A;font-size:13px">⚠️ Copy the Refresh Token above and update QB_REFRESH_TOKEN in your Railway variables to make this permanent.</p>
          <a class="btn" href="/">Go to Cellar Route App →</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Callback error:', err);
    res.send(`<h2>Server error</h2><pre>${err.message}</pre>`);
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Cellar Route Server running on port ${PORT}`);
  await startup();
});
