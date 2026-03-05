const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080;

// ── MIDDLEWARE ─────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── HEALTH CHECK ───────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Cellar Route Server',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ── REFRESH ACCESS TOKEN ───────────────────────────────
// Called automatically when access token expires (every 1 hour)
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

// ── FETCH INVOICES ─────────────────────────────────────
// Pulls open invoices from QuickBooks with delivery addresses
app.post('/api/invoices', async (req, res) => {
  const { accessToken, companyId, environment } = req.body;

  if (!accessToken || !companyId) {
    return res.status(400).json({ error: 'Missing required fields: accessToken, companyId' });
  }

  const baseUrl = environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

  // Query for open invoices ordered by due date
  const query = `SELECT * FROM Invoice WHERE Balance > '0' ORDERBY DueDate ASC MAXRESULTS 100`;
  const url = `${baseUrl}/v3/company/${companyId}/query?query=${encodeURIComponent(query)}&minorversion=65`;

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    if (response.status === 401) {
      return res.status(401).json({ error: 'Access token expired. Please refresh your token.' });
    }

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: `QuickBooks API error: ${errText}` });
    }

    const data = await response.json();
    const rawInvoices = data?.QueryResponse?.Invoice || [];

    // Format invoices for the route optimizer
    const invoices = rawInvoices.map(inv => {
      const shipAddr = inv.ShipAddr;
      const billAddr = inv.BillAddr;
      const addr = shipAddr || billAddr;

      const addressLine = addr
        ? [addr.Line1, addr.City, addr.CountrySubDivisionCode, addr.PostalCode]
            .filter(Boolean).join(', ')
        : 'No address on file';

      const today = new Date().toISOString().split('T')[0];
      const dueDate = inv.DueDate || '';
      const balance = parseFloat(inv.Balance || 0);
      const status = balance > 0 ? (dueDate < today ? 'overdue' : 'open') : 'paid';

      return {
        docNumber: inv.DocNumber,
        customerName: inv.CustomerRef?.name || 'Unknown Customer',
        customerId: inv.CustomerRef?.value,
        address: addressLine,
        addressComponents: addr ? {
          line1: addr.Line1 || '',
          city: addr.City || '',
          state: addr.CountrySubDivisionCode || '',
          zip: addr.PostalCode || '',
        } : null,
        balance: balance,
        amount: `$${balance.toFixed(2)}`,
        dueDate: dueDate,
        status: status,
        txnDate: inv.TxnDate,
      };
    });

    res.json({
      success: true,
      count: invoices.length,
      invoices: invoices,
      fetchedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Invoice fetch error:', err);
    res.status(500).json({ error: 'Server error while fetching invoices' });
  }
});

// ── FETCH CUSTOMERS ────────────────────────────────────
// Pulls customer list with addresses for manual stop entry
app.post('/api/customers', async (req, res) => {
  const { accessToken, companyId, environment } = req.body;

  if (!accessToken || !companyId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const baseUrl = environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

  const query = `SELECT * FROM Customer WHERE Active = true ORDERBY DisplayName ASC MAXRESULTS 100`;
  const url = `${baseUrl}/v3/company/${companyId}/query?query=${encodeURIComponent(query)}&minorversion=65`;

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    const customers = (data?.QueryResponse?.Customer || []).map(c => {
      const addr = c.ShipAddr || c.BillAddr;
      return {
        id: c.Id,
        name: c.DisplayName,
        address: addr
          ? [addr.Line1, addr.City, addr.CountrySubDivisionCode, addr.PostalCode].filter(Boolean).join(', ')
          : 'No address on file'
      };
    });

    res.json({ success: true, count: customers.length, customers });

  } catch (err) {
    console.error('Customer fetch error:', err);
    res.status(500).json({ error: 'Server error while fetching customers' });
  }
});

// ── START ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Cellar Route Server running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/`);
  console.log(`   Invoices:     POST http://localhost:${PORT}/api/invoices`);
  console.log(`   Customers:    POST http://localhost:${PORT}/api/customers`);
  console.log(`   Refresh:      POST http://localhost:${PORT}/api/refresh-token`);
});
