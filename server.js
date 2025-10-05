import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Load environment variables from .env file if it exists
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  console.log('📄 Loading environment variables from .env file...');
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0 && !key.startsWith('#')) {
      const value = valueParts.join('=').trim();
      if (value && !process.env[key.trim()]) {
        process.env[key.trim()] = value;
      }
    }
  });
} else {
  console.log('⚠️  No .env file found. You may need to create one for database connections.');
}

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files (HTML, CSS, JS, etc.)
app.use(express.static('.', {
  index: ['index.html']
}));

// Enhanced error handling for API routes
const handleApiRoute = async (routePath, req, res) => {
  try {
    const filePath = path.join(__dirname, 'api', routePath + '.js');
    
    if (!fs.existsSync(filePath)) {
      console.log(`❌ API endpoint not found: ${routePath}`);
      return res.status(404).json({ ok: false, error: 'API endpoint not found' });
    }

    console.log(`🔄 Handling API request: ${req.method} ${req.url}`);
    console.log(`📝 Request body:`, req.body);

    // Import the API handler with cache busting for development
    const moduleUrl = `file://${filePath}?t=${Date.now()}`;
    const module = await import(moduleUrl);
    const handler = module.default;
    
    if (typeof handler !== 'function') {
      console.log(`❌ Invalid API handler for: ${routePath}`);
      return res.status(500).json({ ok: false, error: 'Invalid API handler' });
    }

    // Adapt Express request for Vercel handler compatibility
    // Vercel handlers expect to read body manually, but Express has already parsed it
    if (req.body && typeof req.body === 'object') {
      // Create a readable stream from the parsed body for handlers that expect to read manually
      const bodyString = JSON.stringify(req.body);
      let bodyConsumed = false;
      
      // Override the request methods that Vercel handlers might use
      const originalOn = req.on.bind(req);
      req.on = function(event, callback) {
        if (event === 'data' && !bodyConsumed) {
          bodyConsumed = true;
          callback(bodyString);
          return req;
        } else if (event === 'end' && bodyConsumed) {
          callback();
          return req;
        }
        return originalOn(event, callback);
      };
      
      req.setEncoding = () => {}; // No-op since we're providing the string directly
    }

    // Call the Vercel function handler
    await handler(req, res);
    
  } catch (error) {
    console.error(`❌ Error in API route ${routePath}:`, error);
    
    // Send error response if headers haven't been sent
    if (!res.headersSent) {
      res.status(500).json({ 
        ok: false, 
        error: error.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
};

// API route handlers - matches your Vercel API structure
app.all('/api/auth/login', (req, res) => handleApiRoute('auth/login', req, res));
app.all('/api/auth/logout', (req, res) => handleApiRoute('auth/logout', req, res));
app.all('/api/users/me', (req, res) => handleApiRoute('users/me', req, res));
app.all('/api/users/list', (req, res) => handleApiRoute('users/list', req, res));
app.all('/api/users/create', (req, res) => handleApiRoute('users/create', req, res));
app.all('/api/users/update-roles', (req, res) => handleApiRoute('users/update-roles', req, res));
app.all('/api/technicians/me', (req, res) => handleApiRoute('technicians/me', req, res));
app.all('/api/technicians/list', (req, res) => handleApiRoute('technicians/list', req, res));
app.all('/api/technicians/signature', (req, res) => handleApiRoute('technicians/signature', req, res));
app.all('/api/roles/list', (req, res) => handleApiRoute('roles/list', req, res));
app.all('/api/roles/seed', (req, res) => handleApiRoute('roles/seed', req, res));
app.all('/api/buses', (req, res) => handleApiRoute('buses', req, res));
app.all('/api/drivers', (req, res) => handleApiRoute('drivers', req, res));
app.all('/api/supervisors', (req, res) => handleApiRoute('supervisors', req, res));
app.all('/api/worksheets', (req, res) => handleApiRoute('worksheets', req, res));
app.all('/api/daily-report', (req, res) => handleApiRoute('daily-report', req, res));
app.all('/api/cote-daily-reports', (req, res) => handleApiRoute('cote-daily-reports', req, res));
app.all('/api/inspections', (req, res) => handleApiRoute('inspections', req, res));
app.all('/api/inspections/get', (req, res) => handleApiRoute('inspections/get', req, res));
app.all('/api/schedule4s/get', (req, res) => handleApiRoute('schedule4s/get', req, res));
app.all('/api/schedule4s/list', (req, res) => handleApiRoute('schedule4s/list', req, res));
app.all('/api/workday-status', (req, res) => handleApiRoute('workday-status', req, res));
app.all('/api/pdf/print', (req, res) => handleApiRoute('pdf/print', req, res));
app.all('/api/samsara/vehicles', (req, res) => handleApiRoute('samsara/vehicles', req, res));
app.all('/api/samsara/vehicle-stats', (req, res) => handleApiRoute('samsara/vehicle-stats', req, res));
app.all('/api/fleetio/create-work-order', (req, res) => handleApiRoute('fleetio/create-work-order', req, res));
app.all('/api/fleetio/update-work-order', (req, res) => handleApiRoute('fleetio/update-work-order', req, res));
app.all('/api/fleetio/vehicle-matching', (req, res) => handleApiRoute('fleetio/vehicle-matching', req, res));

// Fallback for any other API routes
app.all('/api/*', (req, res) => {
  const routePath = req.path.replace('/api/', '');
  handleApiRoute(routePath, req, res);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    ok: false, 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Start the server
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 Local Development Server Started!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📱 Local URL:     http://localhost:${PORT}`);
  console.log(`🌐 Network URL:   http://localhost:${PORT}`);
  console.log('🔧 API endpoints: Available at /api/*');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('✨ Your Vercel API functions are now running locally!');
  console.log('📄 Make sure to set up your .env file with database credentials');
  console.log('🛑 Press Ctrl+C to stop the server');
  console.log('');
});