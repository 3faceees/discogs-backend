import express from 'express';
import cors from 'cors';
import Discogs from 'discogs-marketplace-api-nodejs';

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from Vercel frontend
app.use(cors({
  origin: [
    'https://discogs-wantlist-optimizer.vercel.app',
    'http://localhost:3000',
    'http://localhost:3001'
  ]
}));

app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Discogs Backend API' });
});

// Main analyze endpoint
app.get('/analyze', async (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }

  try {
    // Get user's wantlist from Discogs API
    const wantlistRes = await fetch(
      `https://api.discogs.com/users/${encodeURIComponent(username)}/wants?per_page=100`,
      { headers: { 'User-Agent': 'WantlistOptimizer/1.0' } }
    );

    if (!wantlistRes.ok) {
      if (wantlistRes.status === 404) {
        return res.status(404).json({ error: 'User not found' });
      }
      return res.status(wantlistRes.status).json({ error: 'Cannot access wantlist. Make sure it is public.' });
    }

    const wantlistData = await wantlistRes.json();
    const wants = wantlistData.wants || [];

    if (wants.length === 0) {
      return res.status(404).json({ error: 'Wantlist is empty' });
    }

    // For each release, scrape marketplace listings
    const vendorCount = {};
    const toCheck = wants.slice(0, 30); // Limit to avoid timeout

    for (const want of toCheck) {
      const releaseId = want.id;

      try {
        const discogs = new Discogs();
        const results = await discogs.search({ releaseId, limit: 50 });

        if (results && results.items) {
          for (const item of results.items) {
            const seller = item.seller;
            if (seller) {
              vendorCount[seller] = (vendorCount[seller] || 0) + 1;
            }
          }
        }

        // Small delay between requests
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        // Continue on error
        console.log(`Error for release ${releaseId}:`, err.message);
        continue;
      }
    }

    // Sort vendors by count
    const vendors = Object.entries(vendorCount)
      .map(([seller, count]) => ({ seller, count }))
      .sort((a, b) => b.count - a.count);

    if (vendors.length === 0) {
      return res.status(404).json({ error: 'No sellers found with items from your wantlist' });
    }

    res.json({
      username,
      totalWants: wants.length,
      analyzedWants: toCheck.length,
      vendors
    });

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
