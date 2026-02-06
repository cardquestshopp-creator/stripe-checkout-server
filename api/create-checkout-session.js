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
    console.log('=== CHECKOUT REQUEST ===');
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
    const { items, shippingRate } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      console.error('No items provided');
      return res.status(400).json({ error: 'No items provided' });
    }

    console.log(`Processing ${items.length} items`);

    // Create Stripe line items (skip inventory check for now to test)
    const lineItems = items.map(item => {
      console.log(`Creating line item for: ${item.name} - $${item.price} x ${item.quantity}`);
      return {
        price_data: {
          currency: 'usd',
          product_data: {
            name: item.name,
            images: item.image ? [item.image] : [],
          },
          unit_amount: Math.round(parseFloat(item.price) * 100),
        },
        quantity: parseInt(item.quantity),
      };
    });

    // Shipping
    const shippingAmount = Math.round(parseFloat(shippingRate.rate) * 100);
    const deliveryDays = parseInt(shippingRate.deliveryDays || 5);
    const carrier = shippingRate.carrier || 'Standard';
    const service = shippingRate.service || 'Shipping';

    console.log(`Creating shipping rate: ${carrier} - ${service} ($${shippingRate.rate})`);

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

    console.log('Creating Stripe checkout session...');

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
      metadata: {
        items: JSON.stringify(
          items.map(i => ({ 
            productId: i.productId || i.id, 
            qty: i.quantity 
          }))
        )
      }
    });

    console.log('Session created successfully:', session.id);

    return res.status(200).json({
      url: session.url,
      sessionId: session.id
    });

  } catch (error) {
    console.error('=== CHECKOUT ERROR ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    
    return res.status(500).json({
      error: 'Failed to create checkout session',
      details: error.message,
      type: error.type || 'unknown'
    });
  }
}
