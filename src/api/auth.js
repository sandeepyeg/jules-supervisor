/**
 * Simple middleware to secure API endpoints with PORTAL_SECRET.
 */
export const portalAuth = (req, res, next) => {
  const portalSecret = process.env.PORTAL_SECRET;
  
  // If no portal secret is defined, bypass authentication for easier onboarding
  if (!portalSecret || portalSecret === 'choose_a_random_string') {
    return next();
  }

  const key = req.headers['x-portal-key'];
  if (key !== portalSecret) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing x-portal-key header' });
  }

  next();
};
