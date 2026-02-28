import Stripe from 'stripe';
import EasyPost from '@easypost/api';
import { Resend } from 'resend';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const easypost = new EasyPost(process.env.EASYPOST_API_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
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

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    try {
      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['customer']
      });
      
      const customerName = fullSession.customer?.name || fullSession.customer_details?.name || 'Customer';
      const customerEmail = fullSession.customer?.email || fullSession.customer_details?.email || '';
      
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
      
      // Parse items from metadata
      let items = [];
      try {
        items = JSON.parse(session.metadata?.items || '[]');
      } catch (e) {
        console.error('Failed to parse items:', e);
      }

      console.log('Items:', JSON.stringify(items));

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
            
            console.log(`Inventory updated: ${itemId} from ${currentQty} to ${newQty}`);
          }
        }
        
        console.log('Inventory update complete');
      } catch (invError) {
        console.error('Inventory update error:', invError.message);
      }

      // === CREATE EASYPOST SHIPMENT ===
      if (!shippingAddress) {
        console.log('No shipping address found, skipping shipment');
        return res.status(200).json({ received: true });
      }
      
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
          weight: Math.ceil(weightOz * 28.3495),
        },
      });

      const rates = shipment.rates.sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate));
      const cheapestRate = rates[0];
      
      const purchasedShipment = await easypost.Shipment.buy(shipment.id, cheapestRate.id);
      
      const trackingCode = purchasedShipment.tracking_code;
      const trackingUrl = purchasedShipment.tracker?.public_url;
      const carrier = purchasedShipment.carrier;
      const service = purchasedShipment.service;

      console.log('LABEL PURCHASED! Tracking:', trackingCode);

      // === SEND EMAIL WITH RESEND ===
      if (customerEmail) {
        const itemsHtml = items.map(item => `
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd;">${item.name}</td>
            <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${item.qty || 1}</td>
            <td style="padding: 8px; border: 1px solid #ddd;">$${parseFloat(item.price).toFixed(2)}</td>
          </tr>
        `).join('');

        const totalAmount = items.reduce((sum, item) => sum + (parseFloat(item.price) * (item.qty || 1)), 0);

        try {
          await resend.emails.send({
            from: 'Card Quest Games <onboarding@resend.dev>',
            to: customerEmail,
            subject: 'Your Order Has Shipped! - Card Quest Games',
            html: `
              <h1>Thank you for your order, ${customerName}!</h1>
              <p>Great news - your order has shipped! Here are the details:</p>
              
              <h2>Shipping Information</h2>
              <p><strong>Carrier:</strong> ${carrier} (${service})</p>
              <p><strong>Tracking Number:</strong> ${trackingCode}</p>
              <p><strong>Tracking Link:</strong> <a href="${trackingUrl}">${trackingUrl}</a></p>
              
              <h3>Shipping Address:</h3>
              <p>
                ${shippingAddress.name}<br>
                ${shippingAddress.street}<br>
                ${shippingAddress.city}, ${shippingAddress.state} ${shippingAddress.zipCode}
              </p>
              
              <h2>Order Details</h2>
              <table style="border-collapse: collapse; width: 100%;">
                <thead>
                  <tr style="background: #f5f5f5;">
                    <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Item</th>
                    <th style="padding: 8px; border: 1px solid #ddd;">Qty</th>
                    <th style="padding: 8px; border: 1px solid #ddd;">Price</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsHtml}
                  <tr style="background: #f9f9f9;">
                    <td colspan="2" style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Total</td>
                    <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">$${totalAmount.toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
              
              <p>Thank you for shopping with Card Quest Games!</p>
            `,
          });
          console.log('Email sent to:', customerEmail);
        } catch (emailError) {
          console.error('Error sending email:', emailError);
        }
      }

      console.log('=== DONE ===');
      
    } catch (error) {
      console.error('Error processing checkout:', error);
    }
  }

  return res.status(200).json({ received: true });
}
