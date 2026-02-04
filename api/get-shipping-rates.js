import EasyPost from '@easypost/api';

const easypost = new EasyPost(process.env.EASYPOST_API_KEY);

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
    const { items, street, city, state, postal_code, country } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided' });
    }

    if (!street || !city || !state || !postal_code) {
      return res.status(400).json({ error: 'Complete address is required' });
    }

    console.log('Calculating shipping rates for:', { items, street, city, state, postal_code });

    // Calculate total weight based on items
    const totalWeight = items.reduce((sum, item) => {
      const itemWeight = 1; // Default weight per item in oz
      return sum + (itemWeight * item.quantity);
    }, 0);

    console.log('Total weight:', totalWeight, 'oz');

    // Create EasyPost shipment - shipping FROM your location
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
        street1: street,
        city: city,
        state: state,
        zip: postal_code,
        country: country || 'US',
      },
      parcel: {
        weight: totalWeight,
        length: 12,
        width: 9,
        height: 6,
      },
    });

    console.log('EasyPost shipment created:', shipment.id);

    // Format rates for frontend
    const rates = shipment.rates
      .filter(rate => ['USPS', 'UPS', 'FedEx'].includes(rate.carrier))
      .map(rate => ({
        id: rate.id,
        carrier: rate.carrier,
        service: rate.service,
        rate: parseFloat(rate.rate),
        deliveryDays: rate.delivery_days || 5,
        delivery_date: rate.delivery_date,
        description: `${rate.carrier} ${rate.service}`,
      }))
      .sort((a, b) => a.rate - b.rate); // Sort by price

    if (rates.length === 0) {
      return res.status(404).json({ error: 'No shipping rates available for this address' });
    }

    return res.status(200).json({ 
      rates,
      shipmentId: shipment.id 
    });

  } catch (error) {
    console.error('Error getting shipping rates:', error);
    
    // Handle EasyPost specific errors
    if (error.message && error.message.includes('Address')) {
      return res.status(400).json({ 
        error: 'Invalid shipping address. Please check your address and try again.',
        details: error.message 
      });
    }
    
    return res.status(500).json({ 
      error: 'Failed to get shipping rates',
      details: error.message 
    });
  }
}
