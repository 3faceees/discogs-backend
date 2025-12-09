const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN;
const DISCOGS_API = 'https://api.discogs.com';
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;

const userSubscriptions = new Map();
const userAnalyses = new Map();

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
    price: 9.99, 
    analyses: 10, 
    items: 1000, 
    stripeId: process.env.STRIPE_PRICE_STARTER || 'price_1ScGpXB2OrJ9THG7O30zKNLW'
  },
  pro: { 
    name: 'Pro', 
    price: 19.99, 
    analyses: 30, 
    items: 2000, 
    stripeId: process.env.STRIPE_PRICE_PRO || 'price_1ScGqYB2OrJ9THG7AEOjfnVs'
  },
  collector: { 
    name: 'Collector', 
    price: 39.99, 
    analyses: 100, 
    items: 5000, 
    stripeId: process.env.STRIPE_PRICE_COLLECTOR || 'price_1ScGrNB2OrJ9THG78TJ45CRc'
  }
};

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
    const { plan } = req.body;
    
    console.log('📧 Checkout request:', { plan });
    
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
      metadata: { plan: plan }
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

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

app.all('/analyze', async (req, res) => {
  const startTime = Date.now();
  
  const username = req.query.username || req.body.username;
  const email = req.query.email || req.body.email;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  console.log(`\n🎵 Analysis Request: ${username}`);

  try {
    let userPlan = 'free';
    let itemsLimit = 50;
    
    if (email) {
      const subscription = userSubscriptions.get(email);
      if (subscription && subscription.status === 'active') {
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
      }
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

    // Scrape marketplace with MULTIPLE PATTERNS
    const vendorMap = {};
    let processedCount = 0;

    for (const want of wantsToAnalyze) {
      processedCount++;
      
      if (processedCount % 10 === 0) {
        console.log(`📊 Progress: ${processedCount}/${wantsToAnalyze.length}`);
      }

      try {
        const releaseId = want.basic_information.id;
        const releaseTitle = want.basic_information.title;
        const releaseArtist = want.basic_information.artists?.[0]?.name || 'Unknown';

        const discogsMarketplaceUrl = `https://www.discogs.com/sell/list?release_id=${releaseId}&ev=rb`;
        const scrapingBeeUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_API_KEY}&url=${encodeURIComponent(discogsMarketplaceUrl)}&render_js=false`;

        const response = await fetch(scrapingBeeUrl);
        
        if (!response.ok) {
          console.error(`❌ ScrapingBee error for ${releaseId}: ${response.status}`);
          continue;
        }
        
        const html = await response.text();

        // FIX: Try MULTIPLE patterns to find sellers
        let sellers = [];
        
        // Pattern 1: data-seller-username (most reliable)
        const pattern1 = html.matchAll(/data-seller-username="([^"]+)"/g);
        sellers = Array.from(pattern1).map(m => m[1]);
        
        // Pattern 2: /seller/ links (fallback)
        if (sellers.length === 0) {
          const pattern2 = html.matchAll(/href="\/seller\/([^\/"\s?]+)/g);
          sellers = Array.from(pattern2).map(m => m[1]);
        }
        
        // Pattern 3: seller_info class (another fallback)
        if (sellers.length === 0) {
          const pattern3 = html.matchAll(/class="seller_info"[^>]*>[\s\S]*?href="\/seller\/([^"]+)"/g);
          sellers = Array.from(pattern3).map(m => m[1]);
        }

        // Get prices
        const priceMatches = html.matchAll(/data-price="([^"]+)"/g);
        const prices = Array.from(priceMatches).map(m => parseFloat(m[1]));

        if (sellers.length > 0) {
          console.log(`✅ Found ${sellers.length} sellers for: ${releaseTitle}`);
        } else {
          console.log(`⚠️ No sellers found for: ${releaseTitle}`);
        }

        // Deduplicate sellers and add to vendorMap
        const uniqueSellers = [...new Set(sellers)];
        
        uniqueSellers.forEach((seller, idx) => {
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
