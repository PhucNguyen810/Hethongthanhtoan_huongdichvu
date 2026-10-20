require('dotenv').config();

const express = require('express');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const app = express();
app.use(express.json());

function readNonNegativeNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function readProbability(name) {
  const value = Number(process.env[name] ?? 0);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return value;
}

const delayMs = readNonNegativeNumber('DELAY_MS', 0);
const failRate = readProbability('FAIL_RATE');
const dropRate = readProbability('DROP_RATE');
const port = Number(process.env.PORT ?? 4002);

const chargesByReference = new Map();
const chargesByKey = new Map();
const inFlightByReference = new Map();
const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendCharge(res, charge) {
  res.status(201).json(charge);
}

app.post('/charges', async (req, res) => {
  stats.requests += 1;

  const { reference, amount } = req.body ?? {};
  const idempotencyKey = req.get('Idempotency-Key');

  if (
    typeof reference !== 'string' ||
    reference.trim() === '' ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !idempotencyKey
  ) {
    return res.status(400).json({ error: 'reference, Idempotency-Key, and a positive integer amount are required' });
  }

  const previousKeyUse = chargesByKey.get(idempotencyKey);
  if (previousKeyUse) {
    if (previousKeyUse.reference !== reference || previousKeyUse.amount !== amount) {
      return res.status(409).json({ error: 'Idempotency-Key was already used for a different charge' });
    }
    return sendCharge(res, previousKeyUse);
  }

  const previousReferenceUse = chargesByReference.get(reference);
  if (previousReferenceUse) {
    if (previousReferenceUse.amount !== amount) {
      return res.status(409).json({ error: 'reference was already charged with a different amount' });
    }
    chargesByKey.set(idempotencyKey, previousReferenceUse);
    return sendCharge(res, previousReferenceUse);
  }

  let chargePromise = inFlightByReference.get(reference);
  let isOriginalRequest = false;

  if (!chargePromise) {
    isOriginalRequest = true;
    chargePromise = (async () => {
      if (amount > 20_000_000) {
        return { error: 'Amount exceeds the bank limit', status: 402 };
      }
      await wait(delayMs);
      if (Math.random() < failRate) {
        return { error: 'Temporary bank error', status: 500 };
      }

      const charge = { chargeId: randomUUID(), reference, amount };
      chargesByReference.set(reference, charge);
      chargesByKey.set(idempotencyKey, charge);
      stats.charges += 1;
      return { charge };
    })();
    inFlightByReference.set(reference, chargePromise);
  }

  try {
    const result = await chargePromise;
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    if (isOriginalRequest && Math.random() < dropRate) {
      res.destroy();
      return;
    }
    return sendCharge(res, result.charge);
  } finally {
    if (isOriginalRequest) {
      inFlightByReference.delete(reference);
    }
  }
});

app.get('/stats', (_req, res) => {
  res.json(stats);
});

const server = http.createServer(app);
server.keepAliveTimeout = 5_000;
server.on('connection', (socket) => {
  stats.connections += 1;
  console.log(`New TCP connection from ${socket.remoteAddress}:${socket.remotePort}`);
});

if (require.main === module) {
  server.listen(port, () => {
    console.log(`Bank service listening on port ${port}`);
    console.log(`DELAY_MS=${delayMs} FAIL_RATE=${failRate} DROP_RATE=${dropRate}`);
  });
}

module.exports = { app, server, stats };