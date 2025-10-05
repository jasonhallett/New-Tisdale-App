# Tisdale App

A web application for managing bus fleet operations, daily reports, inspections, and schedules.

## Project Structure

```
├── api/                 # Vercel serverless API functions (production)
├── assets/              # Static assets (logos, icons)
├── css/                 # Stylesheets
├── js/                  # Client-side JavaScript
├── *.html               # Application pages
├── dev-tools/           # Local development tools (excluded from deployment)
├── docs/                # Project documentation (excluded from deployment)
├── package.json         # Node.js dependencies and scripts
├── vercel.json          # Vercel deployment configuration
└── .env                 # Environment variables (git-ignored)
```

## Quick Start

### Production Deployment (Vercel)
The app is deployed on Vercel and uses serverless functions in the `api/` folder.

### Local Development
For local development with Live Server:

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment variables:**
   - Copy your `.env` file with database credentials
   - The file should contain `DATABASE_URL` and `APP_JWT_SECRET`

3. **Start local API server:**
   ```bash
   npm run dev
   ```

4. **Open with Live Server:**
   - Use VS Code Live Server extension on port 5500, OR
   - Use the built-in development server: `npm run dev`
   - API requests are handled on the same port

## Environment Variables

Required environment variables (in `.env` file):
- `DATABASE_URL` - PostgreSQL database connection string
- `APP_JWT_SECRET` - JWT token secret for authentication

## Documentation

See the `docs/` folder for detailed documentation:
- Development Guide
- Live Server Setup
- Local Development Instructions

## Features

- User authentication and role management
- Bus fleet management
- Daily reports and inspections
- Schedule management
- Integration with Fleetio and Samsara
- PDF generation and viewing