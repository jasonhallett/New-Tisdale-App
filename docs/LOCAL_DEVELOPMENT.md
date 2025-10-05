# Local Development Setup Guide

## 🚀 Quick Start

Your local development server is now ready! Here's how to get it running:

### 1. Set Up Environment Variables

**Copy your Vercel environment variables:**

1. Go to your [Vercel dashboard](https://vercel.com)
2. Click on your project → **Settings** → **Environment Variables**
3. Copy each variable and its value
4. Create a `.env` file in your project root:

```bash
cp .env.example .env
```

5. Edit `.env` and paste your actual values from Vercel

**Required variables:**
- `APP_JWT_SECRET` - Your JWT signing secret
- `DATABASE_URL` - Your database connection string (likely Neon or similar)

### 2. Start the Development Server

```bash
npm run dev
```

You should see:
```
🚀 Local Development Server Started!
📱 Local URL:     http://localhost:3000
🔧 API endpoints: Available at /api/*
```

### 3. Test Your App

1. Open `http://localhost:3000` in your browser
2. Try logging in with your actual user credentials
3. Navigate through the app - all API calls will work!

## 🔧 How It Works

- **Express Server**: Runs your Vercel API functions locally
- **Same Code**: Uses your exact same API files from the `/api` folder  
- **Real Database**: Connects to your actual database using environment variables
- **Hot Reload**: Restart the server to see API changes

## 📊 What's Different from Vercel?

| Feature | Local Development | Vercel Production |
|---------|-------------------|-------------------|
| API Functions | ✅ All available | ✅ All available |
| Database | ✅ Same database | ✅ Same database |
| Authentication | ✅ Real auth | ✅ Real auth |
| Environment Variables | ✅ From .env file | ✅ From Vercel settings |
| Hot Reload | ⚠️ Manual restart | N/A |
| HTTPS | ❌ HTTP only | ✅ HTTPS |

## 🛠️ Development Commands

```bash
npm run dev    # Start development server
npm start      # Start production-like server  
npm install    # Install dependencies
```

## 🔍 Troubleshooting

### "Cannot connect to database"
- Check your `DATABASE_URL` in `.env`
- Make sure it matches exactly what's in Vercel
- Test the connection string with a database client

### "APP_JWT_SECRET missing"
- Make sure `APP_JWT_SECRET` is set in your `.env` file
- Copy the exact value from Vercel settings

### "API endpoint not found"
- Check that the API file exists in `/api/[route].js`
- Restart the server after adding new API files
- Check the server console for error messages

### Login not working
- Verify your database connection
- Check that user accounts exist in your database
- Look at server console for authentication errors

## 📤 Deploying to Production

**Good news!** This local setup doesn't interfere with your Vercel deployment at all:

1. ✅ **Commit normally** - The `server.js` and `.env` files won't affect Vercel
2. ✅ **Push to GitHub** - Vercel ignores the local development files  
3. ✅ **Deploy as usual** - Your API functions run exactly the same in production

The `.gitignore` file ensures your `.env` (with secrets) never gets committed.

## 📁 Files Added

- `server.js` - Local development server
- `.env.example` - Template for environment variables
- `.env` - Your actual environment variables (create this)
- `.gitignore` - Keeps secrets safe
- `package.json` - Updated with Express dependency

## 🎯 Next Steps

1. **Create your `.env` file** with Vercel variables
2. **Start the server** with `npm run dev`
3. **Test authentication** and database connections
4. **Develop locally** with full API access!

---

**Questions?** Check the server console output for detailed error messages and debugging info.