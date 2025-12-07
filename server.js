import express from 'express';
import cors from 'cors';
import * as cheerio from 'cheerio';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Discogs Backend API' });
});

async function scrapeMarketplace(releaseId) {
  try {
    const url = `https://www.discogs.com/sell/release/${releaseId}?sort=price,asc`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    if (!response.ok) return [];
    const html = await response.text();
    const $ = cheerio.load(html);
    const sellers = [];
    $('a[href*="/seller/"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        const match = href.match(/\/seller\/([^\/]+)/);
        if (match && !sellers.includes(match[1])) sellers.push(match[1]);
      }
    });
    return sellers;
  } catch (err) {
    return [];
  }
}

app.get('/analyze', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Username required' });

  try {
    const wantlistRes = await fetch(
      `https://api.discogs.com/users/${encodeURIComponent(username)}/wants?per_page=100`,
      { headers: { 'User-Agent': 'WantlistOptimizer/1.0' } }
    );

    if (!wantlistRes.ok) {
      if (wantlistRes.status === 404) return res.status(404).json({ error: 'User not found' });
      return res.status(wantlistRes.status).json({ error: 'Cannot access wantlist' });
    }

    const data = await wantlistRes.json();
    const wants = data.wants || [];
    if (wants.length === 0) return res.status(404).json({ error: 'Wantlist is empty' });

    const vendorCount = {};
    const toCheck = wants.slice(0, 25);

    for (const want of toCheck) {
      const sellers = await scrapeMarketplace(want.id);
      for (const seller of sellers) {
        vendorCount[seller] = (vendorCount[seller] || 0) + 1;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    const vendors = Object.entries(vendorCount)
      .map(([seller, count]) => ({ seller, count }))
      .sort((a, b) => b.count - a.count);

    if (vendors.length === 0) return res.status(404).json({ error: 'No sellers found' });

    res.json({ username, totalWants: wants.length, analyzedWants: toCheck.length, vendors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
