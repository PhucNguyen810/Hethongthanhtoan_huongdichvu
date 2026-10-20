const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { app } = require('./server');

test('fee lookup returns the configured student balances', async (t) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const studentOne = await fetch(`${baseUrl}/students/1/fees`);
  assert.equal(studentOne.status, 200);
  assert.deepEqual(await studentOne.json(), { studentId: '1', outstanding: 50_000_000 });

  const studentTwo = await fetch(`${baseUrl}/students/2/fees`);
  assert.equal(studentTwo.status, 200);
  assert.deepEqual(await studentTwo.json(), { studentId: '2', outstanding: 0 });

  const unknownStudent = await fetch(`${baseUrl}/students/unknown/fees`);
  assert.equal(unknownStudent.status, 404);
});

test('fee service rejects non-positive and over-balance payments without contacting the bank', async (t) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const zeroPayment = await fetch(`${baseUrl}/students/1/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 0 })
  });
  assert.equal(zeroPayment.status, 400);
  assert.equal((await zeroPayment.json()).status, 'FAILED');

  const overBalance = await fetch(`${baseUrl}/students/1/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 50_000_001 })
  });
  assert.equal(overBalance.status, 400);
  assert.equal((await overBalance.json()).status, 'FAILED');
});
