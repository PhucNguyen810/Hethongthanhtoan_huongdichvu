const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { app, stats } = require('./server');

test('bank returns the original charge for an idempotent retry', async (t) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const chargesBefore = stats.charges;
  const reference = `test-${Date.now()}`;
  const request = () => fetch(`${baseUrl}/charges`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': reference
    },
    body: JSON.stringify({ reference, amount: 1_000 })
  });

  const firstResponse = await request();
  const firstCharge = await firstResponse.json();
  const retryResponse = await request();
  const retryCharge = await retryResponse.json();

  assert.equal(firstResponse.status, 201);
  assert.equal(retryResponse.status, 201);
  assert.equal(retryCharge.chargeId, firstCharge.chargeId);
  assert.equal(stats.charges, chargesBefore + 1);
  assert.equal(stats.duplicates, 0);
});

test('bank rejects amounts above its limit without charging', async (t) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const chargesBefore = stats.charges;
  const response = await fetch(`${baseUrl}/charges`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': `limit-${Date.now()}`
    },
    body: JSON.stringify({ reference: `limit-${Date.now()}`, amount: 25_000_000 })
  });

  assert.equal(response.status, 402);
  assert.equal(stats.charges, chargesBefore);
});
