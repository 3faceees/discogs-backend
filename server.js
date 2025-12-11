import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import * as cheerio from 'cheerio';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN;
const DISCOGS_API = 'https://api.discogs.com';
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;

const userSubscriptions = new Map();
const userAnalyses = new Map();
const emailAnalyses = new Map();

// Condition hierarchy
const CONDITIONS = { 'P': 1, 'F': 2, 'G': 3, 'G+': 4, 'VG': 5, 'VG+': 6, 'NM': 7, 'M': 8 };

// Region mapping
const REGIONS = {
  'us': ['United States', 'USA', 'US'],
  'uk': ['United Kingdom', 'UK', 'Great Britain'],
  'eu': ['Germany', 'France', 'Italy', 'Spain', 'Netherlands', 'Belgium', 'Austria', 'Poland', 'Sweden', 'Portugal', 'Greece', 'Ireland'],
  'jp': ['Japan'],
  'au': ['Australia', 'New Zealand']
};

const PLANS = {
  free: { 
    name: 'Free Preview', 
    price: 0, 
    analyses: 0, 
    items: 50, 
    stripeId: null 
  },
  starter: { 
    name: 'Starter', 
    price: 4.99, 
    analyses: 8, 
    items: 500, 
    stripeId: process.env.STRIPE_PRICE_STARTER
  },
  pro: { 
    name: 'Pro', 
    price: 12.99, 
    analyses: 15, 
    items: 2000, 
    stripeId: process.env.STRIPE_PRICE_PRO
  },
  collector: { 
    name: 'Collector', 
    price: 24.99, 
    analyses: 25, 
    items: 5000, 
    stripeId: process.env.STRIPE_PRICE_COLLECTOR
  }
};

// Parse condition from text
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

// Check if seller matches region filter
function matchesRegion(sellerLocation, regionFilter) {
  if (!regionFilter || !sellerLocation) return true;
  const countries = REGIONS[regionFilter.toLowerCase()];
  if (!countries) return true;
  return countries.some(c => sellerLocation.toLowerCase().includes(c.toLowerCase()));
}

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    hasToken: !!DISCOGS_TOKEN,
    hasScrapingBee: !!SCRAPINGBEE_API_KEY,
    hasStripe: !!process.env.STRIPE_SECRET_KEY,
    plans: PLANS
  });
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { plan, clerk_id } = req.body; // Récupérer clerk_id du body
    
    console.log('🔧 Checkout request:', { plan, clerk_id: clerk_id ? 'provided' : 'not provided' });
    
    if (!PLANS[plan] || plan === 'free') {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price: PLANS[plan].stripeId,
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${req.headers.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/#pricing`,
      metadata: { 
        plan: plan,
        clerk_id: clerk_id || null // Passer clerk_id dans les metadata si disponible
      }
    });

    console.log('✅ Stripe session created:', session.id);
    res.json({ sessionId: session.id, url: session.url });
    
  } catch (error) {
    console.error('❌ Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;
      const plan = session.metadata.plan;
      
      if (email) {
        userSubscriptions.set(email, {
          plan: plan,
          startDate: new Date(),
          stripeCustomerId: session.customer,
          status: 'active'
        });
        console.log(`✅ New subscription: ${email} → ${plan}`);
      }
      break;

    case 'customer.subscription.deleted':
      const customer = event.data.object.customer;
      for (let [email, sub] of userSubscriptions.entries()) {
        if (sub.stripeCustomerId === customer) {
          sub.status = 'cancelled';
          console.log(`❌ Subscription cancelled: ${email}`);
        }
      }
      break;
  }

  res.json({received: true});
});

app.post('/check-subscription', (req, res) => {
  const { email } = req.body;
  
  const subscription = userSubscriptions.get(email);
  
  if (!subscription || subscription.status !== 'active') {
    return res.json({ plan: 'free', analyses: userAnalyses.get(email) || [] });
  }

  const analyses = userAnalyses.get(email) || [];
  const currentMonth = new Date().getMonth();
  const monthlyAnalyses = analyses.filter(a => new Date(a.date).getMonth() === currentMonth);

  res.json({
    plan: subscription.plan,
    analysesUsed: monthlyAnalyses.length,
    analysesLimit: PLANS[subscription.plan].analyses,
    analyses: analyses
  });
});

// Scrape marketplace avec Cheerio
async function scrapeMarketplace(releaseId, minCondition = null, regionFilter = null) {
  try {
    const targetUrl = `https://www.discogs.com/sell/release/${releaseId}?sort=price,asc`;
    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_API_KEY}&url=${encodeURIComponent(targetUrl)}&render_js=false`;
    
    const response = await fetch(apiUrl);
    if (!response.ok) {
      console.error(`❌ ScrapingBee error: ${response.status}`);
      return { sellers: [], prices: [] };
    }
    
    const html = await response.text();
    const $ = cheerio.load(html);
    const sellers = [];
    const prices = [];
    
    // Parse each listing row
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
      
      // Get price
      const priceText = $row.find('.price').first().text().trim();
      const priceMatch = priceText.match(/[\d,.]+/);
      const price = priceMatch ? parseFloat(priceMatch[0].replace(',', '')) : 0;
      
      sellers.push(seller);
      prices.push(price);
    });

    // Fallback: simple parsing if no results
    if (sellers.length === 0) {
      $('a[href*="/seller/"]').each((i, el) => {
        const href = $(el).attr('href');
        if (href) {
          const match = href.match(/\/seller\/([^\/]+)/);
          if (match && !sellers.includes(match[1])) {
            sellers.push(match[1]);
            prices.push(0);
          }
        }
      });
    }

    return { sellers, prices };
    
  } catch (err) {
    console.error('Scrape error:', err.message);
    return { sellers: [], prices: [] };
  }
}

app.all('/analyze', async (req, res) => {
  const startTime = Date.now();
  
  const username = req.query.username || req.body.username;
  const email = req.query.email || req.body.email;
  const minCondition = req.query.minCondition || req.body.minCondition || null;
  const region = req.query.region || req.body.region || null;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  console.log(`\n🎵 Analysis Request: ${username} (${email})`);

  try {
    let userPlan = 'free';
    let itemsLimit = 50;
    
    const subscription = userSubscriptions.get(email);
    
    if (subscription && subscription.status === 'active') {
      // PAID USER
      userPlan = subscription.plan;
      itemsLimit = PLANS[userPlan].items;
      
      const analyses = userAnalyses.get(email) || [];
      const currentMonth = new Date().getMonth();
      const monthlyAnalyses = analyses.filter(a => new Date(a.date).getMonth() === currentMonth);
      
      if (PLANS[userPlan].analyses > 0 && monthlyAnalyses.length >= PLANS[userPlan].analyses) {
        return res.status(429).json({ 
          error: 'Monthly analysis limit reached',
          limit: PLANS[userPlan].analyses,
          used: monthlyAnalyses.length,
          plan: userPlan
        });
      }
    } else {
      // FREE USER - Check IP rate limit
      const userIP = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
      const ipAnalyses = emailAnalyses.get(userIP) || [];
      const today = new Date().setHours(0, 0, 0, 0);
      const todayAnalyses = ipAnalyses.filter(a => new Date(a.date).setHours(0, 0, 0, 0) === today);
      
      if (todayAnalyses.length >= 3) {
        return res.status(429).json({ 
          error: 'Free limit: 3 analyses per day per device. Upgrade for unlimited!',
          limit: 3,
          used: todayAnalyses.length
        });
      }
      
      // Save IP analysis
      ipAnalyses.push({ date: new Date(), username, email });
      emailAnalyses.set(userIP, ipAnalyses);
    }

    console.log(`💎 Plan: ${userPlan} (limit: ${itemsLimit} items)`);

    // Fetch wantlist
    let allWants = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const wantlistUrl = `${DISCOGS_API}/users/${username}/wants?page=${page}&per_page=100`;
      const headers = { 'User-Agent': 'WantlistOptimizer/3.0' };
      
      if (DISCOGS_TOKEN) {
        headers['Authorization'] = `Discogs token=${DISCOGS_TOKEN}`;
      }

      const response = await fetch(wantlistUrl, { headers });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch wantlist: ${response.status}`);
      }
      
      const data = await response.json();
      allWants = allWants.concat(data.wants || []);
      
      hasMore = data.pagination && data.pagination.page < data.pagination.pages;
      page++;
    }

    console.log(`✅ Wantlist: ${allWants.length} items`);

    if (allWants.length === 0) {
      return res.json({
        success: true,
        message: 'No items in wantlist',
        username: username,
        totalItems: 0,
        sellers: []
      });
    }

    // Randomize items
    let wantsToAnalyze = allWants;
    let isPreview = (userPlan === 'free');

    if (allWants.length > itemsLimit) {
      console.log(`🎲 Selecting ${itemsLimit} random items from ${allWants.length}`);
      wantsToAnalyze = shuffleArray(allWants).slice(0, itemsLimit);
    } else {
      console.log(`🎲 Randomizing all ${allWants.length} items`);
      wantsToAnalyze = shuffleArray(allWants);
    }

    console.log(`🔍 Analyzing ${wantsToAnalyze.length} items...`);

    // Scrape marketplace avec Cheerio
    const vendorMap = {};
    let processedCount = 0;

    for (const want of wantsToAnalyze) {
      processedCount++;
      
      if (processedCount % 10 === 0) {
        console.log(`📊 Progress: ${processedCount}/${wantsToAnalyze.length}`);
      }

      try {
        const releaseId = want.basic_information?.id || want.id;
        const releaseTitle = want.basic_information?.title || 'Unknown';
        const releaseArtist = want.basic_information?.artists?.[0]?.name || 'Unknown';

        const { sellers, prices } = await scrapeMarketplace(releaseId, minCondition, region);

        if (sellers.length > 0) {
          console.log(`✅ Found ${sellers.length} sellers for: ${releaseTitle}`);
        } else {
          console.log(`⚠️ No sellers found for: ${releaseTitle}`);
        }

        // Add sellers to vendorMap
        sellers.forEach((seller, idx) => {
          if (!vendorMap[seller]) {
            vendorMap[seller] = {
              username: seller,
              count: 0,
              items: [],
              totalPrice: 0
            };
          }

          vendorMap[seller].count++;
          vendorMap[seller].items.push({
            title: releaseTitle,
            artist: releaseArtist,
            price: prices[idx] || 0
          });
          vendorMap[seller].totalPrice += (prices[idx] || 0);
        });

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 150));

      } catch (error) {
        console.error(`❌ Error processing item: ${error.message}`);
      }
    }

    // Sort results
    const sortedSellers = Object.values(vendorMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, isPreview ? 3 : 20);

    console.log(`📊 Total unique sellers found: ${sortedSellers.length}`);

    // Lock data for FREE preview
    if (isPreview) {
      sortedSellers.forEach(seller => {
        seller.items = [];
        seller.totalPrice = 0;
        seller.isLocked = true;
      });
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Analysis complete in ${duration}s\n`);

    // Save analysis
    if (email) {
      const analyses = userAnalyses.get(email) || [];
      analyses.push({
        username: username,
        date: new Date(),
        itemsAnalyzed: wantsToAnalyze.length,
        totalItems: allWants.length,
        topSeller: sortedSellers[0]?.username,
        plan: userPlan
      });
      userAnalyses.set(email, analyses);
    }

    res.json({
      success: true,
      username: username,
      plan: userPlan,
      isPreview: isPreview,
      totalItems: allWants.length,
      itemsAnalyzed: wantsToAnalyze.length,
      sellers: sortedSellers,
      duration: duration
    });

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ 
      error: error.message,
      details: 'Analysis failed'
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n🎵 WantlistOptimizer API v3.0`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🔑 Discogs: ${DISCOGS_TOKEN ? '✅' : '❌'}`);
  console.log(`🐝 ScrapingBee: ${SCRAPINGBEE_API_KEY ? '✅' : '❌'}`);
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌'}\n`);
});
