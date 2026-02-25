import EasyPost from '@easypost/api';

const easypost = new EasyPost(process.env.EASYPOST_API_KEY);

export default async function handler(req, res) {
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
    console.log('=== CREATE SHIPMENT STARTED ===');
    console.log('API Key exists:', !!process.env.EASYPOST_API_KEY);
    console.log('API Key prefix:', process.env.EASYPOST_API_KEY?.substring(0, 10));
    
    const { customerName, customerEmail, items, street, city, state, postal_code, country } = req.body;
    
    console.log('Received data:', { customerName, street, city, state, postal_code });

    if (!street || !city || !state || !postal_code) {
      return res.status(400).json({ error: 'Complete address is required' });
    }

    const totalWeight = items.reduce((sum, item) => sum + (1 * item.quantity), 0);
    let parcel = { weight: totalWeight, length: 12, width: 9, height: 6 };
    if (totalWeight > 16) {
      parcel = { weight: totalWeight, length: 24, width: 18, height: 12 };
    }

    console.log('Creating EasyPost shipment with parcel:', parcel);

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

    console.log('=== SHIPMENT CREATED SUCCESS ===');
    console.log('Shipment ID:', shipment.id);
    console.log('Tracking:', shipment.tracking_code);

    return res.status(200).json({ 
      success: true,
      shipmentId: shipment.id,
      trackingCode: shipment.tracking_code
    });

  } catch (error) {
    console.error('=== SHIPMENT ERROR ===');
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    console.error('Full error:', error);
    return res.status(500).json({ error: error.message, code: error.code });
  }
}
