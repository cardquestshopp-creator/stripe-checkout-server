import EasyPost from '@easypost/api';

const easypost = new EasyPost(process.env.EASYPOST_API_KEY);

// Size tier parcel dimensions (in inches)
const SIZE_DIMENSIONS = {
  Small: { length: 7, width: 4, height: 1 },    // Singles, small accessories
  Medium: { length: 8, width: 6, height: 4 },    // ETBs, booster boxes
  Large: { length: 16, width: 12, height: 6 }   // Large sealed products
};

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
    console.log('Items received:', items);

    if (!street || !city || !state || !postal_code) {
      return res.status(400).json({ error: 'Complete address is required' });
    }

    // Determine the maximum size tier in the cart
    let maxSizeTier = 'Small';
    let totalWeight = 0;

    items.forEach(item => {
      // Get size tier (Small, Medium, Large) - default to Small
      const itemSize = item.size || 'Small';
      
      // Track largest size tier
      if (itemSize === 'Large') {
        maxSizeTier = 'Large';
      } else if (itemSize === 'Medium' && maxSizeTier !== 'Large') {
        maxSizeTier = 'Medium';
      }
      
      // Calculate total weight (item weight × quantity), default to 1 lb
      const itemWeight = item.weight || 1;
      totalWeight += itemWeight * item.quantity;
    });

    // Get dimensions based on largest item in cart
    const dims = SIZE_DIMENSIONS[maxSizeTier] || SIZE_DIMENSIONS.Small;

    // Create parcel with correct dimensions and calculated weight
    const parcel = {
      weight: totalWeight,
      length: dims.length,
      width: dims.width,
      height: dims.height
    };

    console.log('Max size tier:', maxSizeTier);
    console.log('Total weight:', totalWeight, 'lbs');
    console.log('Parcel dimensions:', parcel);

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
