import test from 'node:test';
import assert from 'node:assert';
import webhookRouter from '../src/api/webhook.js';

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
    process.env.PORTAL_SECRET = 'test_portal_secret';
    
    // We simulate express calling the router stack
    const handler = webhookRouter.stack.find(layer => layer.route && layer.route.path === '/telegram/:secret').route.stack[0].handle;
    
    const req = {
      params: { secret: 'wrong_secret' },
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

  await t.test('allows request with correct secret key in path parameter', async () => {
    process.env.PORTAL_SECRET = 'test_portal_secret';
    
    const handler = webhookRouter.stack.find(layer => layer.route && layer.route.path === '/telegram/:secret').route.stack[0].handle;
    
    const req = {
      params: { secret: 'test_portal_secret' },
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
