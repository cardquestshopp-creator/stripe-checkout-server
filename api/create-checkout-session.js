import Stripe from 'stripe';
import { google } from 'googleapis';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const auth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);

const sheets = google.sheets({ version: 'v4', auth });

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { items, shippingRate } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided' });
    }

    // 🔒 INVENTORY CHECK (Google Sheets)
    const sheetRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:I' // Get all columns including productId
    });

    const rows = sheetRes.data.values || [];
    const headers = rows[0];
    const data = rows.slice(1);

    // Find column indexes
    const productIdIndex = headers.findIndex(h => h.toLowerCase() === 'productid');
    const quantityIndex = headers.findIndex(h => h.toLowerCase() === 'quantity');

    for (const item of items) {
      const itemId = item.productId || item.id;
      
      if (!itemId) {
        return res.status(400).json({ error: 'Missing product ID on item' });
      }

      // Find the row by productId
      const row = data.find(r => r[productIdIndex] === itemId);
      const stock = row ? parseInt(row[quantityIndex], 10) : 0;

      if (stock < item.quantity) {
        return res.status(400).json({
          error: `Out of stock: ${item.name}`,
          productId: itemId,
          available: stock,
          requested: item.quantity
        });
      }
    }

    // Create Stripe line items
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          images: item.image ? [item.image] : [],
        },
        unit_amount: Math.round(parseFloat(item.price) * 100),
      },
      quantity: parseInt(item.quantity),
    }));

    // Shipping
    const shippingAmount = Math.round(parseFloat(shippingRate.rate) * 100);
    const deliveryDays = parseInt(shippingRate.deliveryDays || 5);
    const carrier = shippingRate.carrier || 'Standard';
    const service = shippingRate.service || 'Shipping';

    const stripeShippingRate = await stripe.shippingRates.create({
      display_name: `${carrier} - ${service}`,
      type: 'fixed_amount',
      fixed_amount: {
        amount: shippingAmount,
        currency: 'usd',
      },
      delivery_estimate: {
        minimum: { unit: 'business_day', value: deliveryDays },
        maximum: { unit: 'business_day', value: deliveryDays + 2 },
      },
    });

    // Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      shipping_address_collection: { allowed_countries: ['US'] },
      shipping_options: [{ shipping_rate: stripeShippingRate.id }],
      phone_number_collection: { enabled: true },
      automatic_tax: { enabled: true },
      success_url: 'https://cardquestgames.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://cardquestgames.com/cart',

      // 🔑 INVENTORY METADATA
      metadata: {
        items: JSON.stringify(
          items.map(i => ({ 
            productId: i.productId || i.id, 
            qty: i.quantity 
          }))
        )
      }
    });

    return res.status(200).json({
      url: session.url,
      sessionId: session.id
    });

  } catch (error) {
    console.error('Checkout error:', error);
    return res.status(500).json({
      error: 'Failed to create checkout session',
      details: error.message
    });
  }
}
