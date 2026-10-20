const axios = require('axios');

const feeUrl = process.env.FEE_URL ?? 'http://localhost:4001';
const bankUrl = process.env.BANK_URL ?? 'http://localhost:4002';
const paymentCount = 200;
const concurrency = 10;
const amount = 1_000;

async function main() {
  const before = (await axios.get(`${bankUrl}/stats`)).data;
  const startedAt = Date.now();
  let succeeded = 0;
  const failures = [];

  for (let offset = 0; offset < paymentCount; offset += concurrency) {
    const batch = Array.from({ length: concurrency }, (_, index) => {
      const requestNumber = offset + index + 1;
      return axios.post(`${feeUrl}/students/1/payments`, { amount })
        .then((response) => {
          if (response.status === 201 && response.data.status === 'PAID') {
            succeeded += 1;
          } else {
            failures.push({ requestNumber, status: response.status, body: response.data });
          }
        })
        .catch((error) => {
          failures.push({
            requestNumber,
            status: error.response?.status ?? null,
            body: error.response?.data ?? error.message
          });
        });
    });
    await Promise.all(batch);
  }

  const elapsedMs = Date.now() - startedAt;
  const after = (await axios.get(`${bankUrl}/stats`)).data;
  console.log(JSON.stringify({
    succeeded,
    failed: failures.length,
    elapsedMs,
    bankConnectionsBefore: before.connections,
    bankConnectionsAfter: after.connections,
    bankStats: after,
    failures: failures.slice(0, 10)
  }, null, 2));

  if (succeeded !== paymentCount) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Load test could not run:', error.message);
  process.exitCode = 1;
});
