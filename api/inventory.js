import { google } from 'googleapis';

const auth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY, // Remove the .replace() since it already has real line breaks
  ['https://www.googleapis.com/auth/spreadsheets']
);

const sheets = google.sheets({ version: 'v4', auth });

export default async function handler(req, res) {
  const { category, tcg } = req.query;

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:I', // Adjust if your sheet has a different name
    });

    const rows = response.data.values || [];
    const headers = rows[0];
    const data = rows.slice(1);

    // Convert to JSON
    let products = data.map(row => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index];
      });
      return obj;
    }).filter(item => parseInt(item.quantity) > 0); // Only in-stock items

    // Filter by category if provided
    if (category) {
      products = products.filter(item => 
        item.category && item.category.toLowerCase() === category.toLowerCase()
      );
    }

    // Filter by TCG if provided
    if (tcg) {
      products = products.filter(item => 
        item.tcg && item.tcg.toLowerCase() === tcg.toLowerCase()
      );
    }

    res.status(200).json(products);
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
}
