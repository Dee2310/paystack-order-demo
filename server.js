const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Capture raw body for Paystack webhook signature check
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

// 1. Create pending order & initialize Paystack checkout
app.post('/api/orders', async (req, res) => {
  try {
    const { customer_name, customer_phone, item_name, amount_naira } = req.body;
    const reference = 'ORD_' + Date.now();
    const amountKobo = Number(amount_naira) * 100;

    await pool.query(
      'INSERT INTO orders (reference, customer_name, customer_phone, item_name, amount_naira) VALUES ($1, $2, $3, $4, $5)',
      [reference, customer_name, customer_phone, item_name, Number(amount_naira)]
    );

    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: `${reference.toLowerCase()}@demo-customer.com`,
        amount: amountKobo,
        reference,
        callback_url: `${req.protocol}://${req.get('host')}/?paid=1`
      })
    });

    const data = await paystackRes.json();
    if (!data.status) return res.status(400).json({ error: data.message });

    res.json({ authorization_url: data.data.authorization_url, reference });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// 2. Paystack Webhook Listener (auto-marks order PAID)
app.post('/api/webhooks/paystack', async (req, res) => {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(req.rawBody)
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.sendStatus(401);
  }

  const event = req.body;
  if (event.event === 'charge.success') {
    await pool.query(
      "UPDATE orders SET status = 'PAID' WHERE reference = $1",
      [event.data.reference]
    );
  }

  res.sendStatus(200);
});

// 3. Fetch all orders for the Merchant Dashboard
app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database fetch error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
