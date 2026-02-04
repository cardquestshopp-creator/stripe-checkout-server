import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { items, shippingRate } = req.body;

    console.log('Received checkout request:', JSON.stringify({ items, shippingRate }, null, 2));

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided' });
    }

    if (!shippingRate || !shippingRate.id) {
      return res.status(400).json({ error: 'No shipping rate selected' });
    }

    // Create line items for Stripe
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          images: item.image ? [item.image] : [],
        },
        unit_amount: Math.round(parseFloat(item.price) * 100), // Convert to cents
      },
      quantity: parseInt(item.quantity),
    }));

    console.log('Line items created:', lineItems);

    // Parse shipping rate details
    const shippingAmount = Math.round(parseFloat(shippingRate.rate) * 100); // Convert to cents
    const deliveryDays = parseInt(shippingRate.deliveryDays) || 5;

    console.log('Creating Stripe shipping rate:', {
      amount: shippingAmount,
      deliveryDays,
      carrier: shippingRate.carrier,
      service: shippingRate.service
    });

    // Create a Stripe shipping rate
    const stripeShippingRate = await stripe.shippingRates.create({
      display_name: `${shippingRate.carrier} - ${shippingRate.service}`,
      type: 'fixed_amount',
      fixed_amount: {
        amount: shippingAmount,
        currency: 'usd',
      },
      delivery_estimate: {
        minimum: {
          unit: 'business_day',
          value: deliveryDays,
        },
        maximum: {
          unit: 'business_day',
          value: deliveryDays + 2,
        },
      },
    });

    console.log('Created Stripe shipping rate:', stripeShippingRate.id);

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: 'https://cardquestgames.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://cardquestgames.com/cart',
      shipping_address_collection: {
        allowed_countries: ['US'],
      },
      shipping_options: [
        {
          shipping_rate: stripeShippingRate.id,
        },
      ],
      phone_number_collection: {
        enabled: true,
      },
      automatic_tax: {
        enabled: true,
      },
    });

    console.log('Created checkout session:', session.id);
    console.log('Checkout URL:', session.url);

    // Return the session URL
    return res.status(200).json({ 
      url: session.url,
      sessionId: session.id 
    });

  } catch (error) {
    console.error('Error creating checkout session:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);
    
    return res.status(500).json({ 
      error: 'Failed to create checkout session',
      details: error.message,
      type: error.type || 'unknown'
    });
  }
}
