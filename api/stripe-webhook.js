import Stripe from 'stripe';
import EasyPost from '@easypost/api';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const easypost = new EasyPost(process.env.EASYPOST_API_KEY);

// Disable body parser for webhook
export const config = {
  api: {
    bodyParser: false,
  },
};

// Get raw body as buffer
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, stripe-signature');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  
  let event;

  try {
    // Get raw body FIRST for signature verification
    const rawBody = await getRawBody(req);
    
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle checkout.session.completed
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    console.log('=== CHECKOUT COMPLETED ===');
    console.log('Session ID:', session.id);
    
    try {
      // Get FULL session details with customer (not shipping_details - not expandable)
      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['customer']
      });
      
      const customerName = fullSession.customer?.name || fullSession.customer_details?.name || 'Customer';
      const customerEmail = fullSession.customer?.email || fullSession.customer_details?.email || '';
      
      // Get shipping address directly from session (already included, no expand needed)
      const shipping = fullSession.shipping_details;
      const shippingAddress = shipping?.address ? {
        name: shipping.name || customerName,
        street: shipping.address.line1,
        city: shipping.address.city,
        state: shipping.address.state,
        zipCode: shipping.address.postal_code,
        country: shipping.address.country
      } : null;

      console.log('Customer:', customerName, customerEmail);
      console.log('Shipping:', JSON.stringify(shippingAddress));
      
      if (!shippingAddress) {
        console.log('No shipping address found, skipping shipment creation');
        return res.status(200).json({ received: true });
      }

      // Parse items from metadata
      let items = [];
      try {
        items = JSON.parse(session.metadata?.items || '[]');
      } catch (e) {
        console.error('Failed to parse items from metadata:', e);
      }

      console.log('Items:', JSON.stringify(items));

      // === CREATE EASYPOST SHIPMENT ===
      console.log('Creating EasyPost shipment...');
      
      // Calculate parcel weight (estimate: 1 oz per item, max 50 lbs)
      const totalItems = items.reduce((sum, item) => sum + (item.qty || 1), 0);
      const weightOz = Math.min(totalItems * 1, 50);
      
      const shipment = await easypost.Shipment.create({
        to_address: {
          name: shippingAddress.name,
          street1: shippingAddress.street,
          city: shippingAddress.city,
          state: shippingAddress.state,
          zip: shippingAddress.zipCode,
          country: shippingAddress.country || 'US',
        },
        from_address: {
          name: 'Card Quest Games',
          street1: '8701 W Foster Ave',
          street2: 'Unit 301',
          city: 'Chicago',
          state: 'IL',
          zip: '60656',
          country: 'US',
        },
        parcel: {
          length: 12,
          width: 9,
          height: 6,
          weight: Math.ceil(weightOz * 28.3495), // oz to grams
        },
      });

      console.log('Shipment created:', shipment.id);

      // Get cheapest rate and buy label
      const rates = shipment.rates.sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate));
      const cheapestRate = rates[0];
      
      console.log('Cheapest rate:', cheapestRate.rate, cheapestRate.carrier, cheapestRate.service);

      // Buy the label automatically
      const purchasedShipment = await shipment.buy(cheapestRate.id);
      
      console.log('LABEL PURCHASED!');
      console.log('Tracking:', purchasedShipment.tracker?.tracking_code);
      console.log('Label URL:', purchasedShipment.postage_label?.label_url);

      // === UPDATE INVENTORY ===
      try {
        const { google } = await import('googleapis');
        
        const privateKey = process.env.GOOGLE_PRIVATE_KEY.includes('\\n')
          ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
          : process.env.GOOGLE_PRIVATE_KEY;

        const auth = new google.auth.JWT(
          process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          null,
          privateKey,
          ['https://www.googleapis.com/auth/spreadsheets']
        );

        const sheets = google.sheets({ version: 'v4', auth });

        const sheetRes = await sheets.spreadsheets.values.get({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: 'Sheet1!A1:G',
        });

        const rows = sheetRes.data.values || [];
        const data = rows.slice(1);

        const productIdIndex = 6; // Column G
        const quantityIndex = 2;  // Column C

        for (const item of items) {
          const itemId = item.productId;
          
          const rowIndex = data.findIndex(row => row[productIdIndex] === itemId);
          
          if (rowIndex !== -1) {
            const currentQty = parseInt(data[rowIndex][quantityIndex]) || 0;
            const newQty = Math.max(0, currentQty - (item.qty || 1));
            
            await sheets.spreadsheets.values.update({
              spreadsheetId: process.env.GOOGLE_SHEET_ID,
              range: `Sheet1!C${rowIndex + 2}`,
              valueInputOption: 'USER_ENTERED',
              requestBody: { values: [[newQty]] }
            });
            
            console.log(`Updated ${itemId}: ${currentQty} → ${newQty}`);
          }
        }
      } catch (invError) {
        console.error('Inventory update error:', invError.message);
      }

      console.log('=== DONE ===');
      
    } catch (error) {
      console.error('Error processing checkout:', error);
    }
  }

  return res.status(200).json({ received: true });
}
