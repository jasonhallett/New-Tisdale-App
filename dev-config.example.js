// dev-config.example.js - Template for local development configuration
// Copy this to dev-config.js and customize for your needs

(function() {
  'use strict';
  
  // Detect if we're running with Live Server (usually port 5500) or file:// protocol
  const isLiveServer = window.location.port === '5500' || 
                      window.location.hostname === '127.0.0.1' || 
                      window.location.protocol === 'file:' ||
                      (window.location.hostname === 'localhost' && window.location.port !== '3000');
  
  if (!isLiveServer) {
    return; // Exit if not using Live Server
  }
  
  console.log('🔧 Live Server development mode detected - Using mock API responses');
  
  // CUSTOMIZE THESE FOR YOUR PROJECT:
  // Mock user data for Live Server testing
  const mockUsers = {
    'admin@yourcompany.com': {
      password: 'your-admin-password-here',
      user: {
        id: 1,
        email: 'admin@yourcompany.com',
        name: 'Admin User',
        role: 'ADMIN',
        technician: {
          id: 1,
          name: 'Admin User',
          signature: null
        }
      }
    },
    'your-email@yourcompany.com': {
      password: 'your-password-here',
      user: {
        id: 2,
        email: 'your-email@yourcompany.com', 
        name: 'Your Name',
        role: 'ADMIN',
        technician: {
          id: 2,
          name: 'Your Name',
          signature: null
        }
      }
    },
    'tech@yourcompany.com': {
      password: 'tech-password-here',
      user: {
        id: 3,
        email: 'tech@yourcompany.com', 
        name: 'Technician User',
        role: 'TECHNICIAN',
        technician: {
          id: 3,
          name: 'Technician User',
          signature: null
        }
      }
    }
  };
  
  // Store current logged-in user
  let currentUser = localStorage.getItem('mockCurrentUser') ? 
    JSON.parse(localStorage.getItem('mockCurrentUser')) : null;
  
  // Mock API responses - customize these for your endpoints
  const mockApiHandlers = {
    'POST /api/auth/login': async (data) => {
      const { email, password } = data;
      const userRecord = mockUsers[email?.toLowerCase()];
      
      if (!userRecord || userRecord.password !== password) {
        throw new Error('Invalid email or password');
      }
      
      // Store the user session
      currentUser = userRecord.user;
      localStorage.setItem('mockCurrentUser', JSON.stringify(currentUser));
      
      return { ok: true, user: currentUser };
    },
    
    'GET /api/users/me': async () => {
      if (!currentUser) {
        const error = new Error('Not authenticated');
        error.status = 401;
        throw error;
      }
      
      return { ok: true, user: currentUser };
    },
    
    'POST /api/auth/logout': async () => {
      currentUser = null;
      localStorage.removeItem('mockCurrentUser');
      return { ok: true };
    },
    
    // Add more API endpoints as needed for your project
    'GET /api/your-endpoint': async () => {
      return { ok: true, data: 'your mock data here' };
    }
  };
  
  // Override fetch for API calls
  const originalFetch = window.fetch;
  window.fetch = async function(url, options = {}) {
    // Only intercept API calls
    if (typeof url === 'string' && url.startsWith('/api/')) {
      const method = (options.method || 'GET').toUpperCase();
      const key = `${method} ${url.split('?')[0]}`;
      const handler = mockApiHandlers[key];
      
      if (handler) {
        try {
          let requestData = null;
          
          // Parse request body if present
          if (options.body) {
            try {
              requestData = JSON.parse(options.body);
            } catch (e) {
              requestData = options.body;
            }
          }
          
          console.log(`🔧 Mock API: ${key}`, requestData);
          
          const result = await handler(requestData, url);
          
          // Return a mock Response object
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({
              'Content-Type': 'application/json'
            }),
            json: async () => result,
            text: async () => JSON.stringify(result)
          };
          
        } catch (error) {
          console.log(`🔧 Mock API Error: ${key}`, error.message);
          
          const status = error.status || 400;
          return {
            ok: false,
            status: status,
            statusText: error.message,
            headers: new Headers({
              'Content-Type': 'application/json'
            }),
            json: async () => ({ ok: false, error: error.message }),
            text: async () => JSON.stringify({ ok: false, error: error.message })
          };
        }
      }
      
      // For unhandled API routes, return a helpful error
      console.warn(`🔧 Mock API: No handler for ${key}`);
      return {
        ok: false,
        status: 501,
        statusText: 'Not Implemented',
        headers: new Headers({
          'Content-Type': 'application/json'
        }),
        json: async () => ({ 
          ok: false, 
          error: 'This API endpoint is not mocked for Live Server development' 
        }),
        text: async () => JSON.stringify({ 
          ok: false, 
          error: 'This API endpoint is not mocked for Live Server development' 
        })
      };
    }
    
    // For non-API calls, use the original fetch
    return originalFetch.call(this, url, options);
  };
  
  // Add helpful dev info to the page
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addDevInfo);
  } else {
    addDevInfo();
  }
  
  function addDevInfo() {
    // Add a development notice
    const devNotice = document.createElement('div');
    devNotice.innerHTML = `
      <div style="
        position: fixed;
        top: 10px;
        right: 10px;
        background: #333;
        color: white;
        padding: 10px;
        border-radius: 5px;
        font-family: monospace;
        font-size: 12px;
        z-index: 10000;
        max-width: 320px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      ">
        <strong>🔧 Live Server Mode (Port 5500)</strong><br>
        <small>Using mock API responses</small><br>
        <details style="margin-top: 5px;">
          <summary style="cursor: pointer;">Test Accounts</summary>
          <div style="margin-top: 5px; font-size: 11px;">
            Check dev-config.js for available test accounts
          </div>
        </details>
      </div>
    `;
    document.body.appendChild(devNotice);
    
    // Auto-hide after 15 seconds
    setTimeout(() => {
      devNotice.style.opacity = '0.3';
    }, 15000);
  }
  
})();