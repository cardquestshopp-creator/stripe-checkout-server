import Stripe from 'stripe';
import EasyPost from '@easypost/api';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const easypost = new EasyPost(process.env.EASYPOST_API_KEY);

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { items, shippingRate } = req.body;

    // Validate items
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Invalid cart items' });
    }

    // Validate shipping rate object
    if (!shippingRate || !shippingRate.rate || !shippingRate.service) {
      return res.status(400).json({ error: 'Shipping rate information is required' });
    }

    // Create line items for Stripe
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          images: item.image ? [item.image] : [],
        },
        unit_amount: Math.round(item.price * 100), // Convert to cents
      },
      quantity: item.quantity,
    }));

    // Create a Stripe shipping rate dynamically with the EasyPost price
    const stripeShippingRate = await stripe.shippingRates.create({
      display_name: `${shippingRate.carrier} ${shippingRate.service}`,
      type: 'fixed_amount',
      fixed_amount: {
        amount: Math.round(parseFloat(shippingRate.rate) * 100), // Convert to cents
        currency: 'usd',
      },
      delivery_estimate: {
        minimum: {
          unit: 'business_day',
          value: parseInt(shippingRate.deliveryDays) || 5,
        },
        maximum: {
          unit: 'business_day',
          value: (parseInt(shippingRate.deliveryDays) || 5) + 2,
        },
      },
    });

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: 'https://cardquestgames.com/success',
      cancel_url: 'https://cardquestgames.com/cart',
      // US Shipping only
      shipping_address_collection: {
        allowed_countries: ['US'],
      },
      // Use the dynamically created shipping rate
      shipping_options: [
        {
          shipping_rate: stripeShippingRate.id,
        },
      ],
      // Collect phone number
      phone_number_collection: {
        enabled: true,
      },
      // Automatic tax calculation
      automatic_tax: {
        enabled: true,
      },
    });

    // Return the session URL
    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error('Error creating checkout session:', error);
    return res.status(500).json({ 
      error: 'Failed to create checkout session',
      details: error.message 
    });
  }
}
