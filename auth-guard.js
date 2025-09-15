// auth-guard.js — block access to this page unless logged in
(async () => {
  try {
    const res = await fetch('/api/technicians/me', { credentials: 'include' });
    if (!res.ok) {
      window.location.replace('/');
    }
  } catch {
    window.location.replace('/');
  }
})();
