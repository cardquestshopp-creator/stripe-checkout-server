import Stripe from 'stripe';
import { google } from 'googleapis';
import EasyPost from '@easypost/api';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const easypost = new EasyPost(process.env.EASYPOST_API_KEY);

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

export const config = {
  api: {
    bodyParser: false,
  },
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, stripe-signature');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('Missing STRIPE_WEBHOOK_SECRET environment variable');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;

  try {
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    console.log('=== CHECKOUT COMPLETED ===');
    console.log('Session ID:', session.id);

    try {
      // Parse items from metadata
      let items = [];
      if (session.metadata && session.metadata.items) {
        try {
          items = JSON.parse(session.metadata.items);
        } catch (parseError) {
          console.error('Failed to parse metadata items:', parseError);
          items = [];
        }
      }

      // Get customer shipping info from Stripe
      const customerName = session.customer_details?.name || 'Customer';
      const customerEmail = session.customer_details?.email;
      const shipping = session.shipping_details?.address;

      console.log('Customer:', customerName);
      console.log('Shipping:', shipping);

      // Create EasyPost shipment AFTER payment succeeds
      if (shipping) {
        try {
          const totalWeight = items.reduce((sum, item) => sum + (1 * (item.qty || 1)), 0);
          let parcel = { weight: totalWeight || 1, length: 12, width: 9, height: 6 };
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
              street1: shipping.line1,
              street2: shipping.line2,
              city: shipping.city,
              state: shipping.state,
              zip: shipping.postal_code,
              country: shipping.country || 'US',
              email: customerEmail,
            },
            parcel: parcel,
            reference: session.id,
          });

          // Find cheapest rate and buy label
          const rates = shipment.rates.sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate));
          const cheapestRate = rates[0];
          
          console.log('Cheapest rate:', cheapestRate.carrier, cheapestRate.service, '$' + cheapestRate.rate);
          console.log('Buying label...');

          const purchased = await shipment.buy(cheapestRate.id);

          console.log('=== LABEL PURCHASED ===');
          console.log('Tracking:', purchased.tracking_code);
          console.log('Label URL:', purchased.postage_label?.label_url);
          console.log('Shipment ID:', purchased.id);

        } catch (easypostError) {
          console.error('EasyPost error:', easypostError.message);
        }
      } else {
        console.log('No shipping address found, skipping shipment creation');
      }

      // Update inventory (existing code)
      if (!items || items.length === 0) {
        return res.status(200).json({ received: true });
      }

      // Get current sheet data
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Sheet1!A:Z'
      });

      const rows = response.data.values || [];
      if (rows.length === 0) {
        return res.status(200).json({ received: true });
      }

      const headers = rows[0].map(h => (h || '').toLowerCase().trim());
      const data = rows.slice(1);

      const productIdIndex = headers.findIndex(h => 
        h === 'productid' || h === 'product_id' || h === 'sku' || h === 'id'
      );
      const quantityIndex = headers.findIndex(h => 
        h === 'quantity' || h === 'qty' || h === 'stock'
      );

      if (productIdIndex === -1 || quantityIndex === -1) {
        return res.status(200).json({ received: true });
      }

      for (const item of items) {
        const productId = item.productId;
        const quantityPurchased = parseInt(item.qty) || 1;

        const dataRowIndex = data.findIndex(row => {
          const rowProductId = (row[productIdIndex] || '').toString().trim();
          return rowProductId === productId;
        });

        if (dataRowIndex === -1) continue;

        const sheetRowNumber = dataRowIndex + 2;
        const currentQuantity = parseInt(data[dataRowIndex][quantityIndex]) || 0;
        const newQuantity = Math.max(0, currentQuantity - quantityPurchased);

        const columnLetter = String.fromCharCode(65 + quantityIndex);
        
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: `Sheet1!${columnLetter}${sheetRowNumber}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[newQuantity]] }
        });

        console.log(`Updated ${productId}: ${currentQuantity} → ${newQuantity}`);
      }
      
      console.log('=== DONE ===');
      return res.status(200).json({ received: true });
      
    } catch (error) {
      console.error('Error:', error);
      return res.status(200).json({ received: true });
    }
  }

  res.status(200).json({ received: true });
}
