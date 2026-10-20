# Lab 3: Fee and Bank Services

Node.js 18 or newer is required. Both services use in-memory state; restarting a
service resets its fee balances, payment IDs, bank charges, and statistics.

## Start the services

In separate terminals:

```powershell
cd bank-service
npm start
```

```powershell
cd fee-service
npm start
```

Fee Service listens on port `4001`; the simulated bank listens on port `4002`.
Set `BANK_URL` in `fee-service/.env` to change the bank address. The default is
`http://localhost:4002`.

## API

- `GET /students/:id/fees` returns the outstanding fee for students 1, 2, or 3.
- `POST /students/:id/payments` accepts a JSON body such as `{"amount":100000}`.
- Bank `POST /charges` requires `reference`, `amount`, and an
  `Idempotency-Key` header.
- Bank `GET /stats` reports TCP connections, requests, successful charges, and
  duplicate debits.

Fee Service reuses up to 20 bank connections. A bank connection failure returns
503; an ambiguous timeout or interrupted response returns 504/PENDING. The
payment reference is also the idempotency key, so a retry after a dropped
response returns the original charge instead of charging again.

## Failure simulation

Configure these values in `bank-service/.env`, then restart the bank:

- `DELAY_MS`: response/charge delay in milliseconds.
- `FAIL_RATE`: probability of a 500 response before debiting.
- `DROP_RATE`: probability of closing the connection after debiting and before
  sending the response.

Values for `FAIL_RATE` and `DROP_RATE` must be between 0 and 1. For example,
set `DELAY_MS=5000` to exercise the payment timeout, or `DROP_RATE=0.3` to
simulate an ambiguous charge response.

## Connection-pool load check

With both services running normally, run:

```powershell
cd fee-service
npm run load-test
```

The script sends 200 payments of 1,000 units in batches of 10 and prints the
elapsed time and bank connection statistics before and after the run.
