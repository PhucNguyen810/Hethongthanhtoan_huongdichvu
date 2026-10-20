require('dotenv').config();

const express = require('express');
const http = require('node:http');
const https = require('node:https');
const axios = require('axios');

const app = express();
app.use(express.json());

const port = Number(process.env.PORT ?? 4001);
const bankUrl = process.env.BANK_URL ?? 'http://localhost:4002';
const configuredTimeoutMs = Number(process.env.BANK_TIMEOUT_MS ?? 4_000);
const bankTimeoutMs = Math.min(configuredTimeoutMs, 4_300);
const maxRetries = Number(process.env.MAX_RETRIES ?? 4);

if (!Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
  throw new Error('BANK_TIMEOUT_MS must be a positive number');
}
if (!Number.isInteger(maxRetries) || maxRetries < 0) {
  throw new Error('MAX_RETRIES must be a non-negative integer');
}
try {
  new URL(bankUrl);
} catch (error) {
  throw new Error('BANK_URL must be a valid URL', { cause: error });
}

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 20 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 20 });
const bankClient = axios.create({
  baseURL: bankUrl,
  httpAgent,
  httpsAgent,
  validateStatus: () => true
});

const fees = new Map([
  ['1', 50_000_000],
  ['2', 0],
  ['3', 3_200_000]
]);
const reservedByStudent = new Map();
const payments = new Map();
let nextPaymentNumber = 1;

function paymentError(res, statusCode, error, payment) {
  return res.status(statusCode).json({
    error,
    paymentId: payment.paymentId,
    status: payment.status
  });
}

function reservedAmount(studentId) {
  return reservedByStudent.get(studentId) ?? 0;
}

function releaseReservation(studentId, amount) {
  const updated = reservedAmount(studentId) - amount;
  if (updated <= 0) {
    reservedByStudent.delete(studentId);
  } else {
    reservedByStudent.set(studentId, updated);
  }
}

function isConnectionUnavailable(error) {
  return ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(error.code);
}

function isAmbiguousConnectionFailure(error) {
  return ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED'].includes(error.code);
}

app.get('/students/:id/fees', (req, res) => {
  const due = fees.get(req.params.id);
  if (due === undefined) {
    return res.status(404).json({ error: 'Student not found' });
  }
  return res.json({ studentId: req.params.id, outstanding: due });
});

app.post('/students/:id/payments', async (req, res) => {
  const studentId = req.params.id;
  const due = fees.get(studentId);
  if (due === undefined) {
    return res.status(404).json({ error: 'Student not found' });
  }

  const payment = {
    paymentId: `P${nextPaymentNumber++}`,
    studentId,
    status: 'PROCESSING'
  };
  payments.set(payment.paymentId, payment);

  const { amount } = req.body ?? {};
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    payment.status = 'FAILED';
    return paymentError(res, 400, 'amount must be a positive integer', payment);
  }
  if (amount > due - reservedAmount(studentId)) {
    payment.status = 'FAILED';
    return paymentError(res, 400, 'amount exceeds the outstanding fee available for payment', payment);
  }

  reservedByStudent.set(studentId, reservedAmount(studentId) + amount);
  const deadline = Date.now() + bankTimeoutMs;
  let lastBankError = 'Bank request failed';
  let ambiguousFailureOccurred = false;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    try {
      const response = await bankClient.post('/charges', {
        reference: payment.paymentId,
        amount
      }, {
        timeout: remainingMs,
        headers: { 'Idempotency-Key': payment.paymentId }
      });

      if (response.status >= 200 && response.status < 300) {
        fees.set(studentId, fees.get(studentId) - amount);
        releaseReservation(studentId, amount);
        payment.status = 'PAID';
        payment.chargeId = response.data.chargeId;
        payment.amount = amount;
        return res.status(201).json({
          paymentId: payment.paymentId,
          status: payment.status,
          amount,
          remainingDue: fees.get(studentId),
          chargeId: payment.chargeId
        });
      }

      const bankError = response.data?.error ?? `Bank returned HTTP ${response.status}`;
      if (response.status === 500 && attempt < maxRetries && Date.now() < deadline - 100) {
        lastBankError = bankError;
        await new Promise((resolve) => setTimeout(resolve, Math.min(100 * (attempt + 1), Math.max(0, deadline - Date.now()))));
        continue;
      }

      releaseReservation(studentId, amount);
      payment.status = 'FAILED';
      payment.error = bankError;
      payment.amount = amount;
      return paymentError(res, response.status, bankError, payment);
    } catch (error) {
      if (isConnectionUnavailable(error)) {
        if (ambiguousFailureOccurred) {
          payment.status = 'PENDING';
          payment.error = 'Bank became unavailable after an interrupted request; charge outcome is unknown';
          return paymentError(res, 504, payment.error, payment);
        }
        releaseReservation(studentId, amount);
        payment.status = 'FAILED';
        payment.error = 'Bank is unavailable';
        return paymentError(res, 503, payment.error, payment);
      }

      if (['ECONNRESET', 'EPIPE'].includes(error.code)) {
        ambiguousFailureOccurred = true;
        if (attempt < maxRetries && Date.now() < deadline - 100) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
      }

      if (isAmbiguousConnectionFailure(error) || !error.response) {
        payment.status = 'PENDING';
        payment.error = 'Bank response timed out or the connection was interrupted; charge outcome is unknown';
        return paymentError(res, 504, payment.error, payment);
      }

      throw error;
    }
  }

  releaseReservation(studentId, amount);
  payment.status = 'FAILED';
  payment.error = lastBankError;
  payment.amount = amount;
  return paymentError(res, 500, lastBankError, payment);
});

app.use((error, _req, res, _next) => {
  console.error('Fee service request failed:', error);
  res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);

if (require.main === module) {
  server.listen(port, () => {
    console.log(`Fee service listening on port ${port}`);
    console.log(`Bank URL: ${bankUrl}; timeout: ${bankTimeoutMs}ms; keep-alive pool: 20`);
  });
}

module.exports = { app, server, fees, payments, httpAgent, httpsAgent };