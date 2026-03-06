const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Cellar Route Server',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Refresh OAuth token
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

// Fetch invoices from QuickBooks
app.post('/api/invoices', async (req, res) => {
  const { accessToken, companyId, environment } = req.body;

  if (!accessToken || !companyId) {
    return res.status(400).json({ error: 'Missing required fields: accessToken, companyId' });
  }

  const baseUrl = environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

  // Calculate tomorrow's date in YYYY-MM-DD format
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  // Query for unpaid invoices due on or before tomorrow
  const query = `SELECT * FROM Invoice WHERE Balance > '0' AND DueDate <= '${tomorrowStr}' ORDERBY DueDate ASC MAXRESULTS 100`;

  try {
    const response = await fetch(
      `${baseUrl}/v3/company/${companyId}/query?query=${encodeURIComponent(query)}&minorversion=65`,
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
      return res.status(response.status).json({
        error: 'QuickBooks API error',
        details: data
      });
    }

    const invoices = data.QueryResponse?.Invoice || [];

    // Map to a clean format for the app
    const formatted = invoices.map(inv => ({
      id: inv.Id,
      docNumber: inv.DocNumber,
      customerName: inv.CustomerRef?.name || 'Unknown',
      customerId: inv.CustomerRef?.value,
      dueDate: inv.DueDate,
      balance: inv.Balance,
      totalAmount: inv.TotalAmt,
      status: inv.EmailStatus,
      shipAddress: inv.ShipAddr || null,
      billAddress: inv.BillAddr || null
    }));

    res.json({
      count: formatted.length,
      invoices: formatted,
      environment: environment || 'sandbox',
      queriedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Invoice fetch error:', err);
    res.status(500).json({ error: 'Server error fetching invoices' });
  }
});

// Fetch active customers from QuickBooks
app.post('/api/customers', async (req, res) => {
  const { accessToken, companyId, environment } = req.body;

  if (!accessToken || !companyId) {
    return res.status(400).json({ error: 'Missing required fields: accessToken, companyId' });
  }

  const baseUrl = environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

  const query = `SELECT * FROM Customer WHERE Active = true ORDERBY DisplayName ASC MAXRESULTS 200`;

  try {
    const response = await fetch(
      `${baseUrl}/v3/company/${companyId}/query?query=${encodeURIComponent(query)}&minorversion=65`,
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
      return res.status(response.status).json({
        error: 'QuickBooks API error',
        details: data
      });
    }

    const customers = data.QueryResponse?.Customer || [];

    // Map to a clean format
    const formatted = customers.map(c => ({
      id: c.Id,
      displayName: c.DisplayName,
      companyName: c.CompanyName || null,
      email: c.PrimaryEmailAddr?.Address || null,
      phone: c.PrimaryPhone?.FreeFormNumber || null,
      balance: c.Balance,
      shipAddress: c.ShipAddr || null,
      billAddress: c.BillAddr || null
    }));

    res.json({
      count: formatted.length,
      customers: formatted,
      environment: environment || 'sandbox',
      queriedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Customer fetch error:', err);
    res.status(500).json({ error: 'Server error fetching customers' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Cellar Route Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
});
