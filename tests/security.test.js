import test from 'node:test';
import assert from 'node:assert';
import webhookRouter from '../src/api/webhook.js';
import { getPortalSecret } from '../src/api/auth.js';
import { securityBlocker } from '../src/api/securityBlocker.js';
import { pool } from '../src/db/connection.js';

test('Webhook Routing Security and Secret Matching', async (t) => {
  const mockRes = () => {
    const res = {};
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.send = (body) => {
      res.body = body;
      return res;
    };
    return res;
  };

  await t.test('rejects request with wrong secret key in path parameter', async () => {
    const activeSecret = getPortalSecret();
    const handler = webhookRouter.stack.find(layer => layer.route && layer.route.path === '/telegram/:secret').route.stack[0].handle;
    
    const req = {
      params: { secret: 'wrong_secret_' + activeSecret },
      body: {}
    };
    const res = mockRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    
    await handler(req, res, next);
    
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body, 'Forbidden');
    assert.strictEqual(nextCalled, false);
  });

  await t.test('allows request with correct active secret key in path parameter', async () => {
    const activeSecret = getPortalSecret();
    const handler = webhookRouter.stack.find(layer => layer.route && layer.route.path === '/telegram/:secret').route.stack[0].handle;
    
    const req = {
      params: { secret: activeSecret },
      body: {}
    };
    const res = mockRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    
    await handler(req, res, next);
    
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, 'OK');
    assert.strictEqual(nextCalled, false);
  });
});

test('Security Request Blocker Middleware', async (t) => {
  const mockRes = () => {
    const res = {};
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.send = (body) => {
      res.body = body;
      return res;
    };
    return res;
  };

  const testBlock = async (path, originalUrl, shouldBlock) => {
    const req = {
      path,
      originalUrl: originalUrl || path
    };
    const res = mockRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    securityBlocker(req, res, next);

    if (shouldBlock) {
      assert.strictEqual(res.statusCode, 403, `Should block path: ${path}`);
      assert.strictEqual(res.body, 'Forbidden');
      assert.strictEqual(nextCalled, false);
    } else {
      assert.strictEqual(res.statusCode, undefined, `Should not block path: ${path}`);
      assert.strictEqual(nextCalled, true);
    }
  };

  await t.test('blocks path traversal attempts', async () => {
    await testBlock('/foo/../../.env', null, true);
    await testBlock('/..\\bar', null, true);
    await testBlock('/some/path/%2e%2e/file', '/some/path/../file', true);
  });

  await t.test('blocks access to dotfiles and dot-directories', async () => {
    await testBlock('/.env', null, true);
    await testBlock('/.git/config', null, true);
    await testBlock('/src/api/.env', null, true);
    await testBlock('/.gitignore', null, true);
  });

  await t.test('blocks access to sensitive configuration and source paths', async () => {
    await testBlock('/package.json', null, true);
    await testBlock('/package-lock.json', null, true);
    await testBlock('/docker-compose.yml', null, true);
    await testBlock('/node_modules/express/index.js', null, true);
    await testBlock('/src/api/auth.js', null, true);
    await testBlock('/tests/security.test.js', null, true);
    await testBlock('/README.md', null, true);
  });

  await t.test('blocks restricted extensions', async () => {
    await testBlock('/config.yml', null, true);
    await testBlock('/setup.sh', null, true);
    await testBlock('/database.sql', null, true);
  });

  await t.test('allows safe and standard system endpoints', async () => {
    await testBlock('/', null, false);
    await testBlock('/api/phases', null, false);
    await testBlock('/api/status/123', null, false);
    await testBlock('/api/webhook/telegram/some-secret-key', null, false);
  });

  t.after(async () => {
    await pool.end();
  });
});
