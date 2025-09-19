// auth-guard.js — block access to this page unless logged in (generic user)
(async () => {
  try {
    const res = await fetch('/api/users/me', { credentials: 'include' });
    if (!res.ok) {
      window.location.replace('/');
    }
  } catch {
    window.location.replace('/');
  }
})();
