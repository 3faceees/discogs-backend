import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe setup
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');
const PRICE_IDS = {
  pro: process.env.STRIPE_PRO_PRICE_ID,
  collector: process.env.STRIPE_COLLECTOR_PRICE_ID
};

// PLUS BESOIN DE SCRAPINGBEE !
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN;

if (!DISCOGS_TOKEN) {
  console.warn('⚠️  WARNING: No DISCOGS_TOKEN set. Rate limit will be 60 req/min instead of 1000 req/min');
}

const CONDITIONS = { 'P': 1, 'F': 2, 'G': 3, 'G+': 4, 'VG': 5, 'VG+': 6, 'NM': 7, 'M': 8 };

const REGIONS = {
  'us': ['United States', 'USA', 'US'],
  'uk': ['United Kingdom', 'UK', 'Great Britain'],
  'eu': ['Germany', 'France', 'Italy', 'Spain', 'Netherlands', 'Belgium', 'Austria', 'Poland', 'Sweden', 'Portugal', 'Greece', 'Ireland', 'Switzerland', 'Czech Republic', 'Denmark', 'Finland', 'Norway'],
  'jp': ['Japan'],
  'au': ['Australia', 'New Zealand'],
  'ca': ['Canada'],
  'asia': ['Japan', 'South Korea', 'Singapore', 'Hong Kong', 'Taiwan', 'Thailand'],
  'latam': ['Mexico', 'Brazil', 'Argentina', 'Chile', 'Colombia']
};

app.use(cors({ origin: '*' }));
app.use(express.json());

// Rate Limiter
class RateLimiter {
  constructor(maxPerMinute = 60) {
    this.maxPerMinute = maxPerMinute;
    this.queue = [];
  }
  
  async throttle() {
    const now = Date.now();
    this.queue = this.queue.filter(time => now - time < 60000);
    
    if (this.queue.length >= this.maxPerMinute) {
      const oldestRequest = this.queue[0];
      const waitTime = 60000 - (now - oldestRequest) + 100;
      await new Promise(r => setTimeout(r, waitTime));
      return this.throttle();
    }
    
    this.queue.push(Date.now());
  }
  
  getStats() {
    const now = Date.now();
    const recent = this.queue.filter(time => now - time < 60000);
    return {
      requestsLastMinute: recent.length,
      limit: this.maxPerMinute,
      available: this.maxPerMinute - recent.length
    };
  }
}

const rateLimiter = new RateLimiter(DISCOGS_TOKEN ? 1000 : 60);

function matchesRegion(location, regionFilter) {
  if (!regionFilter || !location) return true;
  const countries = REGIONS[regionFilter.toLowerCase()];
  if (!countries) return true;
  return countries.some(c => location.toLowerCase().includes(c.toLowerCase()));
}

function meetsCondition(itemCondition, minCondition) {
  if (!minCondition || !itemCondition) return true;
  return CONDITIONS[itemCondition] >= CONDITIONS[minCondition];
}

async function getMarketplaceSellersDetailed(releaseId, filters = {}) {
  try {
    await rateLimiter.throttle();
    
    const url = `https://api.discogs.com/marketplace/listings?release_id=${releaseId}&per_page=100`;
    
    const headers = {
      'User-Agent': 'WantlistOptimizer/2.0'
    };
    
    if (DISCOGS_TOKEN) {
      headers['Authorization'] = `Discogs token=${DISCOGS_TOKEN}`;
    }
    
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      if (response.status === 429) {
        console.log('⚠️  Rate limited, waiting...');
        await new Promise(r => setTimeout(r, 2000));
        return getMarketplaceSellersDetailed(releaseId, filters);
      }
      return [];
    }
    
    const data = await response.json();
    const listings = data.listings || [];
    
    const sellersData = [];
    
    for (const listing of listings) {
      const seller = listing.seller?.username;
      if (!seller) continue;
      
      const { minCondition, minSleeveCondition, region, minRating, maxPrice } = filters;
      
      if (minCondition && listing.condition) {
        if (!meetsCondition(listing.condition, minCondition)) continue;
      }
      
      if (minSleeveCondition && listing.sleeve_condition) {
        if (!meetsCondition(listing.sleeve_condition, minSleeveCondition)) continue;
      }
      
      if (region && listing.seller?.location) {
        if (!matchesRegion(listing.seller.location, region)) continue;
      }
      
      if (minRating && listing.seller?.rating) {
        if (parseFloat(listing.seller.rating) < minRating) continue;
      }
      
      if (maxPrice && listing.price?.value) {
        if (parseFloat(listing.price.value) > maxPrice) continue;
      }
      
      const sellerData = {
        seller: seller,
        price: listing.price?.value || 0,
        currency: listing.price?.currency || 'USD',
        condition: listing.condition || 'Unknown',
        sleeveCondition: listing.sleeve_condition || 'Unknown',
        location: listing.seller?.location || 'Unknown',
        rating: listing.seller?.rating || 0,
        rating_count: listing.seller?.num_ratings || 0,
        ships_from: listing.ships_from || listing.seller?.location || 'Unknown',
        uri: listing.uri || '',
        comments: listing.comments || ''
      };
      
      sellersData.push(sellerData);
    }
    
    return sellersData;
    
  } catch (err) {
    console.error('Marketplace fetch error:', err.message);
    return [];
  }
}

async function analyzeWantlistParallel(wantlist, filters = {}, maxItems = null) {
  const toAnalyze = maxItems ? wantlist.slice(0, maxItems) : wantlist;
  
  const BATCH_SIZE = DISCOGS_TOKEN ? 20 : 10;
  const BATCH_DELAY = DISCOGS_TOKEN ? 1200 : 10000;
  
  const vendorDetails = {};
  
  console.log(`🚀 Analyzing ${toAnalyze.length} items (batch size: ${BATCH_SIZE})`);
  
  for (let i = 0; i < toAnalyze.length; i += BATCH_SIZE) {
    const batch = toAnalyze.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(toAnalyze.length / BATCH_SIZE);
    
    console.log(`📦 Processing batch ${batchNum}/${totalBatches} (items ${i + 1}-${i + batch.length})`);
    
    const results = await Promise.all(
      batch.map(want => getMarketplaceSellersDetailed(want.id, filters))
    );
    
    results.forEach((sellersData, idx) => {
      const want = batch[idx];
      
      for (const sellerData of sellersData) {
        const seller = sellerData.seller;
        
        if (!vendorDetails[seller]) {
          vendorDetails[seller] = {
            seller: seller,
            count: 0,
            listings: [],
            totalPrice: 0,
            avgPrice: 0,
            location: sellerData.location,
            rating: sellerData.rating,
            rating_count: sellerData.rating_count
          };
        }
        
        vendorDetails[seller].count += 1;
        vendorDetails[seller].totalPrice += parseFloat(sellerData.price) || 0;
        vendorDetails[seller].listings.push({
          releaseId: want.id,
          releaseTitle: want.basic_information?.title || 'Unknown',
          price: sellerData.price,
          currency: sellerData.currency,
          condition: sellerData.condition,
          sleeveCondition: sellerData.sleeveCondition,
          uri: sellerData.uri
        });
      }
    });
    
    if (i + BATCH_SIZE < toAnalyze.length) {
      const stats = rateLimiter.getStats();
      console.log(`⏳ Rate limit: ${stats.requestsLastMinute}/${stats.limit} req/min, waiting ${BATCH_DELAY}ms...`);
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }
  
  const vendors = Object.values(vendorDetails).map(v => ({
    ...v,
    avgPrice: v.count > 0 ? (v.totalPrice / v.count).toFixed(2) : 0,
    estimatedTotal: (v.totalPrice + (v.count * 5)).toFixed(2),
    savingsVsMultiple: 0
  })).sort((a, b) => b.count - a.count);
  
  if (vendors.length > 0) {
    const topVendor = vendors[0];
    const shippingPerOrder = 5;
    const totalIfSeparate = toAnalyze.length * shippingPerOrder;
    const totalWithTopVendor = shippingPerOrder;
    const savings = totalIfSeparate - totalWithTopVendor;
    
    vendors[0].estimatedSavings = savings.toFixed(2);
  }
  
  return vendors;
}

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'WantlistOptimizer API v2.0',
    cost: '0€/month (using Discogs API directly)',
    rateLimit: DISCOGS_TOKEN ? '1000 req/min' : '60 req/min'
  });
});

app.get('/status', (req, res) => {
  const stats = rateLimiter.getStats();
  res.json({
    status: 'ok',
    hasToken: !!DISCOGS_TOKEN,
    rateLimit: {
      max: stats.limit,
      used: stats.requestsLastMinute,
      available: stats.available
    },
    cost: '0€/month 🎉'
  });
});

app.get('/analyze', async (req, res) => {
  const { 
    username, 
    plan = 'free',
    minCondition,
    minSleeveCondition, 
    region,
    minRating,
    maxPrice,
    genre,
    yearMin,
    yearMax,
    format
  } = req.query;
  
  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }

  try {
    console.log(`\n🎵 Analyzing wantlist for: ${username} (plan: ${plan})`);
    
    const wantlistRes = await fetch(
      `https://api.discogs.com/users/${encodeURIComponent(username)}/wants?per_page=100`,
      { 
        headers: { 
          'User-Agent': 'WantlistOptimizer/2.0',
          ...(DISCOGS_TOKEN ? { 'Authorization': `Discogs token=${DISCOGS_TOKEN}` } : {})
        } 
      }
    );

    if (!wantlistRes.ok) {
      if (wantlistRes.status === 404) {
        return res.status(404).json({ error: 'User not found' });
      }
      return res.status(wantlistRes.status).json({ error: 'Cannot access wantlist' });
    }

    const data = await wantlistRes.json();
    let wants = data.wants || [];
    
    if (wants.length === 0) {
      return res.status(404).json({ error: 'Wantlist is empty' });
    }

    console.log(`📊 Wantlist size: ${wants.length} items`);

    if (genre || yearMin || yearMax || format) {
      wants = wants.filter(want => {
        const info = want.basic_information;
        
        if (genre && info.genres) {
          if (!info.genres.some(g => g.toLowerCase().includes(genre.toLowerCase()))) {
            return false;
          }
        }
        
        if (yearMin && info.year && info.year < parseInt(yearMin)) return false;
        if (yearMax && info.year && info.year > parseInt(yearMax)) return false;
        
        if (format && info.formats) {
          if (!info.formats.some(f => f.name.toLowerCase().includes(format.toLowerCase()))) {
            return false;
          }
        }
        
        return true;
      });
      
      console.log(`🔍 After filters: ${wants.length} items`);
    }

    let maxItems;
    switch(plan) {
      case 'free':
        maxItems = 200;
        break;
      case 'pro':
        maxItems = 1000;
        break;
      case 'collector':
        maxItems = 20000;
        break;
      default:
        maxItems = 200;
    }

    if (wants.length > maxItems) {
      return res.status(400).json({ 
        error: `Wantlist too large (${wants.length} items). Plan ${plan} limited to ${maxItems} items.`,
        upgradeRequired: true,
        currentSize: wants.length,
        planLimit: maxItems
      });
    }

    const filters = {
      minCondition: minCondition || null,
      minSleeveCondition: minSleeveCondition || null,
      region: region || null,
      minRating: minRating ? parseFloat(minRating) : null,
      maxPrice: maxPrice ? parseFloat(maxPrice) : null
    };

    const startTime = Date.now();
    const vendors = await analyzeWantlistParallel(wants, filters, maxItems);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    if (vendors.length === 0) {
      return res.status(404).json({ error: 'No sellers found matching your criteria' });
    }

    console.log(`✅ Analysis complete in ${duration}s - Found ${vendors.length} sellers`);

    res.json({
      username,
      plan,
      totalWants: wants.length,
      analyzedWants: Math.min(wants.length, maxItems),
      processingTime: `${duration}s`,
      filters: filters,
      topVendor: vendors[0],
      vendors: vendors.slice(0, 50),
      estimatedSavings: vendors[0]?.estimatedSavings || 0,
      stats: {
        totalSellers: vendors.length,
        avgItemsPerSeller: (vendors.reduce((sum, v) => sum + v.count, 0) / vendors.length).toFixed(1),
        bestSellerHas: `${vendors[0]?.count}/${wants.length} items (${((vendors[0]?.count / wants.length) * 100).toFixed(1)}%)`
      }
    });

  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// STRIPE ROUTES
app.post('/create-checkout-session', async (req, res) => {
  const { plan, userEmail, userId } = req.body;
  
  if (!plan || !userEmail) {
    return res.status(400).json({ error: 'Plan and email required' });
  }
  
  const priceId = PRICE_IDS[plan];
  if (!priceId) {
    return res.status(400).json({ error: 'Invalid plan' });
  }
  
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/pricing`,
      customer_email: userEmail,
      client_reference_id: userId,
      metadata: {
        userId: userId || 'guest',
        plan: plan
      },
      subscription_data: {
        metadata: {
          userId: userId || 'guest',
          plan: plan
        }
      }
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('✅ Payment successful!');
        console.log('User:', session.metadata.userId);
        console.log('Plan:', session.metadata.plan);
        console.log('Customer:', session.customer);
        break;
        
      case 'customer.subscription.updated':
        console.log('📝 Subscription updated');
        break;
        
      case 'customer.subscription.deleted':
        console.log('❌ Subscription cancelled');
        break;
        
      case 'invoice.payment_failed':
        console.log('⚠️  Payment failed');
        break;
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('Error handling webhook:', error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

app.listen(PORT, () => {
  console.log('\n🎵 ===================================');
  console.log('🚀 WantlistOptimizer API v2.0');
  console.log('🎵 ===================================');
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`💰 Cost: 0€/month (Discogs API direct)`);
  console.log(`⚡ Rate: ${DISCOGS_TOKEN ? '1000' : '60'} req/min`);
  console.log(`🔑 Token: ${DISCOGS_TOKEN ? '✅ Active' : '⚠️  Missing (performance degraded)'}`);
  console.log('🎵 ===================================\n');
});