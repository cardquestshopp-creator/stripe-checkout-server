import Stripe from 'stripe';
import EasyPost from '@easypost/api';
import { Resend } from 'resend';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const easypost = new EasyPost(process.env.EASYPOST_API_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

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

// Send shipping confirmation email with tracking
async function sendShippingEmail(customerEmail, customerName, items, shippingAddress, trackingCode, carrier, service) {
  const itemsList = items.map(item => `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid #eee;">${item.name}</td>
      <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center;">${item.qty || 1}</td>
      <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right;">$${(item.price || 0).toFixed(2)}</td>
    </tr>
  `).join('');

  const trackingUrl = `https://www.easypost.com/trackers/${trackingCode}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #1a1f2e; margin: 0;">🎉 Your Order Has Shipped!</h1>
      </div>
      
      <p style="color: #555; font-size: 16px;">Hi ${customerName},</p>
      <p style="color: #555; font-size: 16px;">Great news! Your order has been shipped and is on its way to you.</p>
      
      <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #1a1f2e;">📦 Shipping Details</h3>
        <p style="margin: 5px 0; color: #555;"><strong>Carrier:</strong> ${carrier} - ${service}</p>
        <p style="margin: 5px 0; color: #555;"><strong>Tracking Number:</strong> ${trackingCode}</p>
        <p style="margin: 5px 0; color: #555;"><a href="${trackingUrl}" style="color: #0066cc;">Track your package on EasyPost</a></p>
      </div>
      
      <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #1a1f2e;">📍 Shipping Address</h3>
        <p style="margin: 5px 0; color: #555;">${shippingAddress.name}</p>
        <p style="margin: 5px 0; color: #555;">${shippingAddress.street}</p>
        <p style="margin: 5px 0; color: #555;">${shippingAddress.city}, ${shippingAddress.state} ${shippingAddress.zipCode}</p>
      </div>
      
      <h3 style="color: #1a1f2e; margin-top: 30px;">📋 Order Items</h3>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <thead>
          <tr>
            <th style="padding: 12px; text-align: left; border-bottom: 2px solid #1a1f2e;">Item</th>
            <th style="padding: 12px; text-align: center; border-bottom: 2px solid #1a1f2e;">Qty</th>
            <th style="padding: 12px; text-align: right; border-bottom: 2px solid #1a1f2e;">Price</th>
          </tr>
        </thead>
        <tbody>
          ${itemsList}
        </tbody>
      </table>
      
      <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
        <p style="color: #888; font-size: 14px;">Thank you for your purchase!</p>
        <p style="color: #888; font-size: 14px;">— The Card Quest Games Team</p>
      </div>
    </div>
  `;

  try {
    const data = await resend.emails.send({
      from: 'Card Quest Games <orders@cardquestgames.com>',
      to: customerEmail,
      subject: `🎉 Your Order Has Shipped! - Tracking: ${trackingCode}`,
      html: html,
    });
    
    console.log('Email sent successfully:', data);
    return data;
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
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
      // Get FULL session details with customer
      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['customer']
      });
      
      const customerName = fullSession.customer?.name || fullSession.customer_details?.name || 'Customer';
      const customerEmail = fullSession.customer?.email || fullSession.customer_details?.email || '';
      
      // Get shipping address directly from session (already included)
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

      // === UPDATE INVENTORY FIRST ===
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
            
            console.log(`Inventory updated: ${itemId} from ${currentQty} to ${newQty}`);
          }
        }
        
        console.log('Inventory update complete');
      } catch (invError) {
        console.error('Inventory update error:', invError.message);
      }

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

      // Get cheapest rate
      const rates = shipment.rates.sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate));
      const cheapestRate = rates[0];
      
      console.log('Cheapest rate:', cheapestRate.rate, cheapestRate.carrier, cheapestRate.service);

      // Buy the label - use static method
      const purchasedShipment = await easypost.Shipment.buy(shipment.id, cheapestRate.id);
      
      console.log('LABEL PURCHASED!');
      console.log('Tracking:', purchasedShipment.tracker?.tracking_code);
      console.log('Label URL:', purchasedShipment.postage_label?.label_url);

      // === SEND SHIPPING EMAIL WITH TRACKING ===
      if (customerEmail && purchasedShipment.tracker?.tracking_code) {
        console.log('Sending shipping confirmation email...');
        await sendShippingEmail(
          customerEmail,
          customerName,
          items,
          shippingAddress,
          purchasedShipment.tracker.tracking_code,
          cheapestRate.carrier,
          cheapestRate.service
        );
        console.log('Shipping email sent!');
      }

      console.log('=== DONE ===');
      
    } catch (error) {
      console.error('Error processing checkout:', error);
    }
  }

  return res.status(200).json({ received: true });
}

  return res.status(200).json({ received: true });
}
