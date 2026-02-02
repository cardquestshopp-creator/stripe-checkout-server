import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  // CORS Headers - CRITICAL: Allow requests from Landingsite
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  
  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Log to help debugging
    console.log('Received request body:', req.body);

    const { items } = req.body;

    // Validate items
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided in cart' });
    }

    // Convert cart items to Stripe line items format
    const line_items = items.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          images: item.image ? [item.image] : [],
        },
        unit_amount: Math.round(item.price * 100), // Convert dollars to cents
      },
      quantity: item.quantity,
    }));

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: `${req.headers.origin || 'https://yourdomain.com'}/success`,
      cancel_url: `${req.headers.origin || 'https://yourdomain.com'}/cart`,
    });

    console.log('Checkout session created:', session.id);

    // Return checkout URL
    return res.status(200).json({ url: session.url });
    
  } catch (error) {
    console.error('Stripe checkout error:', error);
    return res.status(500).json({ 
      error: error.message || 'Failed to create checkout session' 
    });
  }
}
