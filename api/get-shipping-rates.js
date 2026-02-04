import EasyPost from '@easypost/api';

const easypost = new EasyPost(process.env.EASYPOST_API_KEY);

// Estimated weights for product types (in ounces)
const PRODUCT_WEIGHTS = {
  'booster box': 32, // ~2 lbs
  'elite trainer box': 24, // ~1.5 lbs
  'booster pack': 1, // ~0.06 lbs
  'single card': 0.5, // ~0.03 lbs
  'deck': 8, // ~0.5 lbs
  'collection box': 40, // ~2.5 lbs
  'default': 16 // ~1 lb default
};

// Estimate weight based on product name
function estimateWeight(productName) {
  const name = productName.toLowerCase();
  
  if (name.includes('booster box') || name.includes('box')) return PRODUCT_WEIGHTS['booster box'];
  if (name.includes('elite trainer') || name.includes('etb')) return PRODUCT_WEIGHTS['elite trainer box'];
  if (name.includes('booster pack') || name.includes('pack')) return PRODUCT_WEIGHTS['booster pack'];
  if (name.includes('single') || name.includes('card')) return PRODUCT_WEIGHTS['single card'];
  if (name.includes('deck')) return PRODUCT_WEIGHTS['deck'];
  if (name.includes('collection')) return PRODUCT_WEIGHTS['collection box'];
  
  return PRODUCT_WEIGHTS['default'];
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { items, shippingAddress } = req.body;

    // Validate input
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Invalid cart items' });
    }

    if (!shippingAddress || !shippingAddress.zip || !shippingAddress.state || !shippingAddress.city) {
      return res.status(400).json({ error: 'Invalid shipping address' });
    }

    // Calculate total weight
    let totalWeight = 0;
    items.forEach(item => {
      const itemWeight = estimateWeight(item.name);
      totalWeight += itemWeight * item.quantity;
    });

    // Minimum weight of 1 oz
    totalWeight = Math.max(totalWeight, 1);

    // Create EasyPost shipment
    const shipment = await easypost.Shipment.create({
      from_address: {
        street1: '8701 W Foster Ave',
        street2: 'Unit 301',
        city: 'Chicago',
        state: 'IL',
        zip: '60656',
        country: 'US',
      },
      to_address: {
        street1: shippingAddress.line1,
        street2: shippingAddress.line2 || '',
        city: shippingAddress.city,
        state: shippingAddress.state,
        zip: shippingAddress.zip,
        country: 'US',
      },
      parcel: {
        weight: totalWeight,
        length: 12,
        width: 9,
        height: 6,
      },
    });

    // Format rates for frontend
    const rates = shipment.rates
      .filter(rate => ['USPS', 'UPS', 'FedEx'].includes(rate.carrier))
      .map(rate => ({
        id: rate.id,
        carrier: rate.carrier,
        service: rate.service,
        rate: parseFloat(rate.rate),
        delivery_days: rate.delivery_days,
        delivery_date: rate.delivery_date,
        description: `${rate.carrier} ${rate.service}`,
      }))
      .sort((a, b) => a.rate - b.rate); // Sort by price

    return res.status(200).json({ 
      rates,
      shipmentId: shipment.id 
    });

  } catch (error) {
    console.error('Error getting shipping rates:', error);
    return res.status(500).json({ 
      error: 'Failed to get shipping rates',
      details: error.message 
    });
  }
}
