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

  // Get today's date in YYYY-MM-DD format
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // Production: pull today's invoices by invoice date (TxnDate)
  // Sandbox: pull most recent 100 invoices for testing (sandbox has no today's invoices)
  const query = environment === 'production'
    ? `SELECT * FROM Invoice WHERE TxnDate = '${todayStr}' ORDERBY TxnDate ASC MAXRESULTS 100`
    : `SELECT * FROM Invoice ORDERBY TxnDate DESC MAXRESULTS 100`;

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

    // Helper to format address object
    const formatAddress = (addr) => {
      if (!addr) return null;
      return {
        line1: addr.Line1 || '',
        line2: addr.Line2 || '',
        city: addr.City || '',
        state: addr.CountrySubDivisionCode || '',
        zip: addr.PostalCode || '',
        full: [addr.Line1, addr.City, addr.CountrySubDivisionCode, addr.PostalCode]
          .filter(Boolean)
          .join(', ')
      };
    };

    // Map to a clean format for the app
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
      shipAddress: formatAddress(inv.ShipAddr),
      billAddress: formatAddress(inv.BillAddr)
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

    // Helper to format address object
    const formatAddress = (addr) => {
      if (!addr) return null;
      return {
        line1: addr.Line1 || '',
        line2: addr.Line2 || '',
        city: addr.City || '',
        state: addr.CountrySubDivisionCode || '',
        zip: addr.PostalCode || '',
        full: [addr.Line1, addr.City, addr.CountrySubDivisionCode, addr.PostalCode]
          .filter(Boolean)
          .join(', ')
      };
    };

    // Map to a clean format
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
