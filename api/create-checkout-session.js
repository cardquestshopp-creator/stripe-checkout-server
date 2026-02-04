import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
    const { items, shippingRate, shippingAddress } = req.body;

    // Validate items
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Invalid cart items' });
    }

    // Validate shipping
    if (!shippingRate || !shippingRate.rate || !shippingRate.description) {
      return res.status(400).json({ error: 'Invalid shipping rate' });
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

    // Add shipping as a line item
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Shipping - ${shippingRate.description}`,
          description: shippingRate.delivery_days 
            ? `Estimated delivery: ${shippingRate.delivery_days} days`
            : 'Standard shipping',
        },
        unit_amount: Math.round(shippingRate.rate * 100), // Convert to cents
      },
      quantity: 1,
    });

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: 'https://cardquestgames.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://cardquestgames.com/cart',
      // Pre-fill shipping address if provided
      ...(shippingAddress && {
        shipping_address_collection: {
          allowed_countries: ['US'],
        },
        shipping_options: [], // Empty because we're adding shipping as line item
      }),
      // Collect phone number
      phone_number_collection: {
        enabled: true,
      },
      // Automatic tax calculation
      automatic_tax: {
        enabled: true,
      },
      // Store shipping rate ID in metadata
      metadata: {
        shipping_rate_id: shippingRate.id,
        carrier: shippingRate.carrier,
        service: shippingRate.service,
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
