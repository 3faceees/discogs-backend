import express from 'express';
import cors from 'cors';
import * as cheerio from 'cheerio';

const app = express();
const PORT = process.env.PORT || 3000;

// ⚠️ idéalement: const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const SCRAPINGBEE_KEY = 'BWGUROFAWKOCERBQY5DZF2CNOH5TNEKFY4Z9TRGYPO2UQA3C5I8Z5EW5DJRLQBRGU0D201KEDGK59IWE';

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Discogs Backend API with ScrapingBee (full wantlist)' });
});

async function scrapeMarketplace(releaseId) {
  try {
    const targetUrl = `https://www.discogs.com/sell/release/${releaseId}?sort=price,asc`;
    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(
      targetUrl,
    )}&render_js=false`;

    const response = await fetch(apiUrl);
    if (!response.ok) return [];

    const html = await response.text();
    const $ = cheerio.load(html);
    const sellers: string[] = [];

    $('a[href*="/seller/"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        const match = href.match(/\/seller\/([^/]+)/);
        if (match && !sellers.includes(match[1])) sellers.push(match[1]);
      }
    });

    return sellers;
  } catch (err) {
    console.error('Scrape error:', err.message);
    return [];
  }
}

async function fetchFullWantlist(username) {
  const allWants: any[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `https://api.discogs.com/users/${encodeURIComponent(
      username,
    )}/wants?per_page=100&page=${page}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'WantlistOptimizer/1.0' },
    });

    if (!res.ok) {
      throw new Error(`Discogs wantlist error: status ${res.status}`);
    }

    const data = await res.json();
    const wantsPage = data.wants || [];
    const pagination = data.pagination || {};

    allWants.push(...wantsPage);

    totalPages = pagination.pages || 1;
    page += 1;

    // petite pause pour ne pas spammer l’API
    await new Promise((r) => setTimeout(r, 300));
  }

  return allWants;
}

app.get('/analyze', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Username required' });

  try {
    // 🔁 Récupérer TOUTE la wantlist (toutes les pages, pas juste 100 items)
    const wants = await fetchFullWantlist(String(username));

    if (!wants || wants.length === 0) {
      return res.status(404).json({ error: 'Wantlist is empty' });
    }

    const vendorCount: Record<string, number> = {};

    // 🔍 Analyser TOUS les items de la wantlist
    for (const want of wants) {
      const releaseId = want.id;
      if (!releaseId) continue;

      const sellers = await scrapeMarketplace(releaseId);

      for (const seller of sellers) {
        vendorCount[seller] = (vendorCount[seller] || 0) + 1;
      }

      // pause légère entre les scrapes pour éviter les blocages
      await new Promise((r) => setTimeout(r, 300));
    }

    const vendors = Object.entries(vendorCount)
      .map(([seller, count]) => ({ seller, count }))
      .sort((a, b) => b.count - a.count);

    if (vendors.length === 0) {
      return res.status(404).json({ error: 'No sellers found' });
    }

    // ✅ renvoyer le nombre TOTAL analysé
    res.json({
      username,
      totalWants: wants.length,
      analyzedWants: wants.length, // tous analysés
      vendors,
    });
  } catch (err) {
    console.error(err);
    if (String(err.message || '').includes('Discogs wantlist error')) {
      return res.status(502).json({ error: 'Cannot access wantlist. Make sure it is public.' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
