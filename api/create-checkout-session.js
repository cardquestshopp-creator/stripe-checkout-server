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

    console.log('===== CHECKOUT REQUEST =====');
    console.log('Items received:', JSON.stringify(items, null, 2));
    console.log('Shipping rate received:', JSON.stringify(shippingRate, null, 2));

    if (!items || !Array.isArray(items) || items.length === 0) {
      console.error('No items provided');
      return res.status(400).json({ error: 'No items provided' });
    }

    if (!shippingRate) {
      console.error('No shipping rate provided');
      return res.status(400).json({ error: 'No shipping rate selected' });
    }

    // Validate shipping rate has required fields
    if (!shippingRate.id || !shippingRate.rate) {
      console.error('Invalid shipping rate structure:', shippingRate);
      return res.status(400).json({ error: 'Invalid shipping rate data' });
    }

    // Create line items for Stripe
    const lineItems = items.map(item => {
      const unitAmount = Math.round(parseFloat(item.price) * 100);
      console.log(`Item: ${item.name}, Price: $${item.price}, Unit Amount: ${unitAmount} cents`);
      
      return {
        price_data: {
          currency: 'usd',
          product_data: {
            name: item.name,
            images: item.image ? [item.image] : [],
          },
          unit_amount: unitAmount,
        },
        quantity: parseInt(item.quantity),
      };
    });

    console.log('Line items created successfully');

    // Parse shipping rate details with fallbacks
    const shippingAmount = Math.round(parseFloat(shippingRate.rate) * 100);
    const deliveryDays = parseInt(shippingRate.deliveryDays || shippingRate.delivery_days || 5);
    const carrier = shippingRate.carrier || 'Standard';
    const service = shippingRate.service || 'Shipping';

    console.log('Shipping details:', {
      amount: shippingAmount,
      deliveryDays,
      carrier,
      service
    });

    // Create a Stripe shipping rate
    const stripeShippingRate = await stripe.shippingRates.create({
      display_name: `${carrier} - ${service}`,
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

    console.log('✅ Created Stripe shipping rate:', stripeShippingRate.id);

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

    console.log('✅ Created checkout session:', session.id);
    console.log('✅ Checkout URL:', session.url);

    // Return the session URL
    return res.status(200).json({ 
      url: session.url,
      sessionId: session.id 
    });

  } catch (error) {
    console.error('❌ ERROR creating checkout session');
    console.error('Error message:', error.message);
    console.error('Error type:', error.type);
    console.error('Error code:', error.code);
    console.error('Full error:', error);
    
    return res.status(500).json({ 
      error: 'Failed to create checkout session',
      details: error.message,
      type: error.type || 'unknown',
      code: error.code || 'unknown'
    });
  }
}
