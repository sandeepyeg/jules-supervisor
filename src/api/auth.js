import crypto from 'crypto';

let activeSecret = process.env.PORTAL_SECRET;

if (!activeSecret || activeSecret === 'choose_a_random_string') {
  activeSecret = crypto.randomBytes(16).toString('hex');
  console.warn(`\n[SECURITY] WARNING: PORTAL_SECRET is not configured in your .env file!`);
  console.warn(`[SECURITY] A temporary secure session key has been generated for your protection:`);
  console.warn(`\n           ===>  ${activeSecret}  <===\n`);
  console.warn(`[SECURITY] Use this key to unlock the portal, or configure a persistent PORTAL_SECRET in .env.\n`);
}

/**
 * Returns the currently active portal secret key.
 */
export function getPortalSecret() {
  return activeSecret;
}

/**
 * Middleware to secure API endpoints with mandatory key verification.
 */
export const portalAuth = (req, res, next) => {
  const key = req.headers['x-portal-key'];
  if (key !== activeSecret) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing x-portal-key header' });
  }
  next();
};
