# Live Server Setup

To use Live Server with mock APIs:

1. **Copy the template**:
   ```bash
   cp dev-config.example.js dev-config.js
   ```

2. **Edit `dev-config.js`** and customize:
   - Your email addresses and passwords
   - Mock API endpoints for your project
   - Any test data you need

3. **Use Live Server**:
   - Right-click `index.html` → "Open with Live Server"
   - Login with the credentials you set in `dev-config.js`

## Security

- `dev-config.js` is git-ignored and never committed
- Only the safe template `dev-config.example.js` is in the repository
- Production deployments ignore these files completely
- Use any passwords you want for local testing

## Production vs Development

- **Live Server (dev)**: Uses `dev-config.js` mock APIs
- **Local Server (dev)**: `npm run dev` uses real database  
- **Production**: Uses Vercel environment variables, ignores dev-config files