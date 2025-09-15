// utils/body.js — shared raw body reader
export function readRawBody(req, { maxBytes = 10_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    try {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', chunk => {
        data += chunk;
        if (data.length > maxBytes) {
          reject(new Error('Request too large'));
          try { req.destroy(); } catch {}
        }
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    } catch (err) { reject(err); }
  });
}
