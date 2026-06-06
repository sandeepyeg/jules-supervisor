/**
 * Strict Express-level request blocker to prevent sensitive/config file exposure and directory traversal.
 */
export const securityBlocker = (req, res, next) => {
  let decodedPath = '';
  try {
    decodedPath = decodeURIComponent(req.path || '');
  } catch (e) {
    decodedPath = req.path || '';
  }

  let decodedUrl = '';
  try {
    decodedUrl = decodeURIComponent(req.originalUrl || '');
  } catch (e) {
    decodedUrl = req.originalUrl || '';
  }

  const checkPath = decodedPath.toLowerCase();
  const checkUrl = decodedUrl.toLowerCase();

  // 1. Block directory traversal attempts
  if (
    checkPath.includes('..') || 
    checkUrl.includes('..') || 
    checkPath.includes('\\') || 
    checkUrl.includes('\\')
  ) {
    console.warn(`[SECURITY WARNING] Blocked potential directory traversal: ${req.originalUrl}`);
    return res.status(403).send('Forbidden');
  }

  // 2. Block any path segment starting with a dot (e.g. .env, .git, etc.)
  const segments = checkPath.split('/');
  const hasDotSegment = segments.some(segment => segment.startsWith('.'));
  if (hasDotSegment) {
    console.warn(`[SECURITY WARNING] Blocked access to dotfile/dot-directory: ${req.originalUrl}`);
    return res.status(403).send('Forbidden');
  }

  // 3. Block access to sensitive repository configuration/documentation files and source directories
  const forbiddenPatterns = [
    'package.json',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'docker-compose.yml',
    'docker-compose.yaml',
    'readme.md',
    'claude.md',
    'agents.md',
    'node_modules',
    'tests',
    'src'
  ];

  const isForbiddenPattern = forbiddenPatterns.some(pattern => {
    return checkPath.includes(`/${pattern}`) || checkPath === pattern || checkPath.endsWith(pattern);
  });

  if (isForbiddenPattern) {
    console.warn(`[SECURITY WARNING] Blocked access to forbidden resource/file: ${req.originalUrl}`);
    return res.status(403).send('Forbidden');
  }

  // 4. Block access to any file ending with source/configuration/shell/backup extensions
  const forbiddenExtensions = ['.js', '.ts', '.json', '.yml', '.yaml', '.sh', '.py', '.sql', '.bak', '.conf', '.config', '.env'];
  const hasForbiddenExtension = forbiddenExtensions.some(ext => checkPath.endsWith(ext));
  if (hasForbiddenExtension) {
    console.warn(`[SECURITY WARNING] Blocked access to restricted file extension: ${req.originalUrl}`);
    return res.status(403).send('Forbidden');
  }

  next();
};
