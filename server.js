import express from 'express';
import cors from 'cors';
import * as cheerio from 'cheerio';

const app = express();
const PORT = process.env.PORT || 3000;

const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY; // (mettre la clé dans Railway)

// AJOUT: Condition hierarchy
const CONDITIONS = { 'P': 1, 'F': 2, 'G': 3, 'G+': 4, 'VG': 5, 'VG+': 6, 'NM': 7, 'M': 8 };

// AJOUT: Region mapping
const REGIONS = {
  'us': ['United States', 'USA', 'US'],
  'uk': ['United Kingdom', 'UK', 'Great Britain'],
  'eu': ['Germany', 'France', 'Italy', 'Spain', 'Netherlands', 'Belgium', 'Austria', 'Poland', 'Sweden', 'Portugal', 'Greece', 'Ireland'],
  'jp': ['Japan'],
  'au': ['Australia', 'New Zealand']
};

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Discogs Backend API' });
});

// AJOUT: Parse condition from text
function parseCondition(text) {
  if (!text) return null;
  text = text.toUpperCase().trim();
  if (text.includes('MINT') && !text.includes('NEAR')) return 'M';
  if (text.includes('NEAR MINT') || text === 'NM') return 'NM';
  if (text.includes('VG+')) return 'VG+';
  if (text.includes('VG')) return 'VG';
  if (text.includes('G+')) return 'G+';
  if (text.includes('GOOD') || text === 'G') return 'G';
  if (text.includes('FAIR') || text === 'F') return 'F';
  if (text.includes('POOR') || text === 'P') return 'P';
  return null;
}

// AJOUT: Check if seller matches region filter
function matchesRegion(sellerLocation, regionFilter) {
  if (!regionFilter || !sellerLocation) return true;
  const countries = REGIONS[regionFilter.toLowerCase()];
  if (!countries) return true;
  return countries.some(c => sellerLocation.toLowerCase().includes(c.toLowerCase()));
}

async function scrapeMarketplace(releaseId, minCondition = null, regionFilter = null) {
  try {
    const targetUrl = `https://www.discogs.com/sell/release/${releaseId}?sort=price,asc`;
    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(targetUrl)}&render_js=false`;
    
    const response = await fetch(apiUrl);
    if (!response.ok) return [];
    
    const html = await response.text();
    const $ = cheerio.load(html);
    const sellers = [];
    
    // MODIFIÉ: Parse each listing row for condition and location
    $('.shortcut_navigable').each((i, row) => {
      const $row = $(row);
      const sellerLink = $row.find('a[href*="/seller/"]').first();
      const href = sellerLink.attr('href');
      if (!href) return;
      
      const match = href.match(/\/seller\/([^\/]+)/);
      if (!match) return;
      
      const seller = match[1];
      
      // Get condition
      const conditionText = $row.find('.item_condition .condition-label-desktop').first().text() || 
                           $row.find('.item_condition span').first().text();
      const condition = parseCondition(conditionText);
      
      // Filter by condition if specified
      if (minCondition && condition && CONDITIONS[condition] < CONDITIONS[minCondition]) {
        return;
      }
      
      // Get seller location
      const location = $row.find('.seller_info ul li').last().text().trim();
      
      // Filter by region if specified
      if (!matchesRegion(location, regionFilter)) {
        return;
      }
      
      if (!sellers.includes(seller)) sellers.push(seller);
    });

    // Fallback: simple parsing if no results with detailed parsing
    if (sellers.length === 0) {
      $('a[href*="/seller/"]').each((i, el) => {
        const href = $(el).attr('href');
        if (href) {
          const match = href.match(/\/seller\/([^\/]+)/);
          if (match && !sellers.includes(match[1])) sellers.push(match[1]);
        }
      });
    }

    return sellers;
  } catch (err) {
    console.error('Scrape error:', err.message);
    return [];
  }
}

app.get('/analyze', async (req, res) => {
  const { username, minCondition, region } = req.query; // AJOUT: nouveaux params
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

    const toCheck = wants.slice(0, 20); // 🔥 version stable : analyse les 20 premiers items
    const vendorCount = {};

    for (const want of toCheck) {
      const sellers = await scrapeMarketplace(want.id, minCondition || null, region || null); // MODIFIÉ: pass filters

      for (const seller of sellers) {
        vendorCount[seller] = (vendorCount[seller] || 0) + 1;
      }

      await new Promise(r => setTimeout(r, 300));
    }

    const vendors = Object.entries(vendorCount)
      .map(([seller, count]) => ({ seller, count }))
      .sort((a, b) => b.count - a.count);

    if (vendors.length === 0) return res.status(404).json({ error: 'No sellers found' });

    res.json({
      username,
      totalWants: wants.length,
      analyzedWants: toCheck.length,
      vendors
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
