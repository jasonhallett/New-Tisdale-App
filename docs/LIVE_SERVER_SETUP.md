# Simplified Development Setup

## 🚀 One Simple Workflow

1. **Start the development server**:
   ```bash
   npm run dev
   ```

2. **Open your browser**:
   Go to `http://localhost:5500`

3. **Login with your real credentials**:
   Use your actual database user accounts (like `jason@tisdalebus.com`)

## ✅ What This Gives You

- **Real database connection** - No mock data needed
- **All API endpoints working** - Connected to your Neon database  
- **Actual user authentication** - Login with real accounts
- **Live reload friendly** - Restart server to see API changes
- **Port 5500** - Standard development port, no conflicts

## 🔧 How It Works

- **Server**: Runs your Vercel API functions locally on port 5500
- **Database**: Connects to your real Neon database using `.env` credentials
- **Authentication**: Uses your actual user accounts from the database
- **Development**: Make changes, restart server, refresh browser

## 🌐 Production Deployment

- **Git commit/push** works normally - only production code is deployed
- **Vercel ignores** server.js and other development files  
- **Environment variables** come from Vercel dashboard in production
- **No mock data** or development files reach production

Simple and clean! 🎉