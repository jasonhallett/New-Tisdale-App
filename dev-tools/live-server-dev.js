// live-server-dev.js - Reusable Live Server development helper
// Copy this file to any project that needs Live Server + API mocking

(function() {
  'use strict';
  
  // Auto-detect Live Server environment
  const isLiveServer = window.location.port === '5500' || 
                      window.location.hostname === '127.0.0.1' || 
                      window.location.protocol === 'file:' ||
                      (window.location.hostname === 'localhost' && window.location.port !== '3000');
  
  if (!isLiveServer) return;
  
  console.log('🔧 Live Server detected - Mock API system active');
  
  // Customize these for your project:
  const CONFIG = {
    // Add your test user accounts here
    mockUsers: {
      'admin@example.com': { password: 'admin123', role: 'ADMIN' },
      'user@example.com': { password: 'user123', role: 'USER' }
    },
    
    // Add your API endpoints here
    mockEndpoints: {
      'POST /api/auth/login': (data) => {
        const user = CONFIG.mockUsers[data.email?.toLowerCase()];
        if (!user || user.password !== data.password) {
          throw new Error('Invalid credentials');
        }
        localStorage.setItem('mockUser', JSON.stringify(user));
        return { ok: true, user };
      },
      
      'GET /api/auth/me': () => {
        const user = JSON.parse(localStorage.getItem('mockUser') || 'null');
        if (!user) throw new Error('Not authenticated');
        return { ok: true, user };
      },
      
      'POST /api/auth/logout': () => {
        localStorage.removeItem('mockUser');
        return { ok: true };
      }
    }
  };
  
  // Mock fetch implementation
  const originalFetch = window.fetch;
  window.fetch = async function(url, options = {}) {
    if (typeof url === 'string' && url.startsWith('/api/')) {
      const method = (options.method || 'GET').toUpperCase();
      const key = `${method} ${url.split('?')[0]}`;
      const handler = CONFIG.mockEndpoints[key];
      
      if (handler) {
        try {
          const data = options.body ? JSON.parse(options.body) : null;
          const result = await handler(data, url);
          
          return {
            ok: true,
            status: 200,
            json: async () => result,
            text: async () => JSON.stringify(result)
          };
        } catch (error) {
          return {
            ok: false,
            status: 400,
            json: async () => ({ ok: false, error: error.message }),
            text: async () => JSON.stringify({ ok: false, error: error.message })
          };
        }
      }
      
      console.warn(`🔧 No mock handler for: ${key}`);
      return {
        ok: false,
        status: 501,
        json: async () => ({ ok: false, error: 'API not mocked' })
      };
    }
    
    return originalFetch.call(this, url, options);
  };
  
  // Add visual indicator
  const notice = document.createElement('div');
  notice.innerHTML = `
    <div style="position:fixed;top:10px;right:10px;background:#333;color:white;padding:8px;border-radius:4px;font-size:12px;z-index:9999;">
      🔧 Live Server Mode - Mock APIs Active
    </div>
  `;
  document.body?.appendChild(notice) || document.addEventListener('DOMContentLoaded', () => document.body.appendChild(notice));
})();