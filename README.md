# Cellar Route Server

Backend API server for the Cellar Route wine delivery route optimizer.
Handles QuickBooks Online OAuth2 token management and invoice fetching.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/api/invoices` | Fetch open invoices from QuickBooks |
| POST | `/api/customers` | Fetch active customers from QuickBooks |
| POST | `/api/refresh-token` | Refresh an expired access token |

## Deployed on Railway
