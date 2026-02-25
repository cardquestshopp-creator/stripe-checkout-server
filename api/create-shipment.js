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
    const { 
      customerName, 
      customerEmail,
      items, 
      street, 
      city, 
      state, 
      postal_code, 
      country
    } = req.body;

    if (!street || !city || !state || !postal_code) {
      return res.status(400).json({ error: 'Complete address is required' });
    }

    // Calculate total weight (default 1oz per item)
    const totalWeight = items.reduce((sum, item) => {
      return sum + (1 * item.quantity);
    }, 0);

    // Determine parcel size
    let parcel = { weight: totalWeight, length: 12, width: 9, height: 6 };
    if (totalWeight > 16) {
      parcel = { weight: totalWeight, length: 24, width: 18, height: 12 };
    }

    // Create EasyPost shipment
    const shipment = await easypost.Shipment.create({
      from_address: {
        name: 'Card Quest Games',
        street1: '8701 W Foster Ave',
        street2: 'Unit 301',
        city: 'Chicago',
        state: 'IL',
        zip: '60656',
        country: 'US',
        phone: '312-555-1234',
        email: 'orders@cardquestgames.com',
      },
      to_address: {
        name: customerName,
        street1: street,
        city: city,
        state: state,
        zip: postal_code,
        country: country || 'US',
        email: customerEmail,
      },
      parcel: parcel,
      reference: `Order_${Date.now()}`,
    });

    return res.status(200).json({ 
      success: true,
      shipmentId: shipment.id,
      trackingCode: shipment.tracking_code
    });

  } catch (error) {
    console.error('Error creating shipment:', error);
    return res.status(500).json({ error: error.message });
  }
}
