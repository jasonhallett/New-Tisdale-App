// dev-config.js - Local development configuration for Live Server
// This file provides mock API responses when using Live Server (port 5500)

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
  
  // Mock user data for Live Server testing
  const mockUsers = {
    'admin@tisdale.com': {
      password: 'admin123',
      user: {
        id: 1,
        email: 'admin@tisdale.com',
        name: 'Admin User',
        role: 'ADMIN',
        technician: {
          id: 1,
          name: 'Admin User',
          signature: null
        }
      }
    },
    'jason@tisdalebus.com': {
      password: '12345',
      user: {
        id: 2,
        email: 'jason@tisdalebus.com', 
        name: 'Jason Hallett',
        role: 'ADMIN',
        technician: {
          id: 2,
          name: 'Jason Hallett',
          signature: null
        }
      }
    },
    'tech@tisdale.com': {
      password: 'tech123',
      user: {
        id: 3,
        email: 'tech@tisdale.com', 
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
  
  // Mock API responses
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
    
    'GET /api/schedule4s/list': async () => {
      return {
        ok: true,
        items: [
          {
            id: 1,
            created_at: new Date(Date.now() - 86400000).toISOString(),
            unit: '1234',
            unit_number: '1234',
            odometer: 45678,
            technician_name: 'John Smith',
            location: 'Main Depot'
          },
          {
            id: 2,
            created_at: new Date(Date.now() - 172800000).toISOString(),
            unit: '5678',
            unit_number: '5678', 
            odometer: 23456,
            technician_name: 'Jane Doe',
            location: 'North Terminal'
          },
          {
            id: 3,
            created_at: new Date().toISOString(),
            unit: '9012',
            unit_number: '9012',
            odometer: 67890,
            technician_name: 'Bob Johnson',
            location: 'South Garage'
          }
        ]
      };
    },
    
    'GET /api/buses': async () => {
      return {
        ok: true,
        buses: [
          { id: 1, unit_number: '1234', make: 'Blue Bird', model: 'Vision', year: 2020 },
          { id: 2, unit_number: '5678', make: 'Thomas', model: 'C2', year: 2019 },
          { id: 3, unit_number: '9012', make: 'IC Bus', model: 'CE', year: 2021 }
        ]
      };
    },
    
    'GET /api/drivers': async () => {
      return {
        ok: true,
        drivers: [
          { id: 1, name: 'Alice Driver', license: 'D123456' },
          { id: 2, name: 'Bob Driver', license: 'D789012' },
          { id: 3, name: 'Carol Driver', license: 'D345678' }
        ]
      };
    },
    
    'GET /api/supervisors': async () => {
      return {
        ok: true,
        supervisors: [
          { id: 1, name: 'Manager One', department: 'Operations' },
          { id: 2, name: 'Manager Two', department: 'Maintenance' }
        ]
      };
    },
    
    'GET /api/worksheets': async (data, url) => {
      const urlParams = new URLSearchParams(url.split('?')[1] || '');
      const id = urlParams.get('id');
      
      if (id) {
        return {
          ok: true,
          worksheet: {
            id: parseInt(id),
            name: `Worksheet ${id}`,
            is_default: id === '1',
            sections: [
              {
                id: 1,
                name: 'Pre-Trip Inspection',
                rows: [
                  { id: 1, item: 'Check mirrors' },
                  { id: 2, item: 'Check lights' },
                  { id: 3, item: 'Check tires' }
                ]
              }
            ]
          }
        };
      } else {
        return {
          ok: true,
          worksheets: [
            { id: 1, name: 'Default Worksheet', is_default: true },
            { id: 2, name: 'Custom Worksheet', is_default: false }
          ]
        };
      }
    },
    
    'GET /api/daily-report': async (data, url) => {
      const urlParams = new URLSearchParams(url.split('?')[1] || '');
      const id = urlParams.get('id');
      
      if (id) {
        return {
          ok: true,
          report: {
            id: parseInt(id),
            date: new Date().toISOString().split('T')[0],
            supervisor: 'John Manager',
            notes: 'Sample daily report'
          }
        };
      } else {
        return {
          ok: true,
          reports: [
            { id: 1, date: '2025-10-05', supervisor: 'John Manager' },
            { id: 2, date: '2025-10-04', supervisor: 'Jane Manager' }
          ]
        };
      }
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
            <strong>Your Account:</strong><br>
            Email: jason@tisdalebus.com<br>
            Password: 12345<br><br>
            <strong>Admin:</strong><br>
            Email: admin@tisdale.com<br>
            Password: admin123<br><br>
            <strong>Technician:</strong><br>
            Email: tech@tisdale.com<br>
            Password: tech123
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