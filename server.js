const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Discogs API Configuration
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN;
const DISCOGS_API = 'https://api.discogs.com';

// Helper: Fetch with Discogs API
async function discogsAPI(endpoint, params = {}) {
  const url = new URL(`${DISCOGS_API}${endpoint}`);
  
  // Add token if available
  if (DISCOGS_TOKEN) {
    url.searchParams.append('token', DISCOGS_TOKEN);
  }
  
  // Add other params
  Object.keys(params).forEach(key => {
    url.searchParams.append(key, params[key]);
  });

  const response = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'WantlistOptimizer/2.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Discogs API error: ${response.status}`);
  }

  return response.json();
}

// Helper: Fisher-Yates shuffle
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Status endpoint
app.get('/status', async (req, res) => {
  const hasToken = !!DISCOGS_TOKEN;
  const rateLimit = hasToken ? 1000 : 60;
  
  res.json({
    status: 'ok',
    hasToken,
    rateLimit: {
      max: rateLimit,
      used: 0,
      available: rateLimit
    },
    cost: '0€/month 🎉'
  });
});

// Main analyze endpoint
app.all('/analyze', async (req, res) => {
  const startTime = Date.now();
  
  // Accept both GET and POST
  const username = req.query.username || req.body.username;
  const plan = req.query.plan || req.body.plan || 'free';


  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  console.log(`\n🎵 ===================================`);
  console.log(`📊 New Analysis Request`);
  console.log(`👤 Username: ${username}`);
  console.log(`💎 Plan: ${plan.toUpperCase()}`);
  console.log(`🎵 ===================================\n`);

  try {
    // Plan limits
    const limits = {
      free: 200,
      pro: 1000,
      collector: Infinity
    };
    const maxItems = limits[plan] || limits.free;

    // Step 1: Fetch wantlist
    console.log(`📥 Fetching wantlist for ${username}...`);
    
    let allWants = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const data = await discogsAPI(`/users/${username}/wants`, {
        page,
        per_page: 100
      });

      allWants = allWants.concat(data.wants);
      
      if (data.pagination.page >= data.pagination.pages) {
        hasMore = false;
      } else {
        page++;
      }
    }

    if (allWants.length === 0) {
      return res.status(404).json({ error: 'Wantlist is empty' });
    }

    console.log(`✅ Wantlist loaded: ${allWants.length} total items`);

    // Step 2: Apply randomization and limits
    let wantsToAnalyze = allWants;
    let wasRandomized = false;

    if (plan !== 'collector' && allWants.length > maxItems) {
      console.log(`🎲 Randomizing ${maxItems} items from ${allWants.length} total`);
      wantsToAnalyze = shuffleArray(allWants).slice(0, maxItems);
      wasRandomized = true;
    } else if (allWants.length > maxItems) {
      wantsToAnalyze = allWants.slice(0, maxItems);
    }

    console.log(`🔍 Analyzing ${wantsToAnalyze.length} items...`);

    // Step 3: Fetch marketplace listings for each item
    const vendorMap = {};
    const itemDetails = [];
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

        // Fetch marketplace listings
        const marketplaceData = await discogsAPI('/marketplace/listings', {
          release_id: releaseId,
          per_page: 100
        });

        const listings = marketplaceData.results || [];

        // Count items per vendor
        listings.forEach(listing => {
          const vendorName = listing.seller?.username;
          if (!vendorName) return;

          if (!vendorMap[vendorName]) {
            vendorMap[vendorName] = {
              username: vendorName,
              count: 0,
              items: [],
              totalPrice: 0
            };
          }

          vendorMap[vendorName].count++;
          vendorMap[vendorName].items.push({
            title: releaseTitle,
            artist: releaseArtist,
            price: listing.price?.value || 0,
            condition: listing.condition || 'Unknown'
          });
          vendorMap[vendorName].totalPrice += (listing.price?.value || 0);
        });

        itemDetails.push({
          id: releaseId,
          title: releaseTitle,
          artist: releaseArtist,
          listingsFound: listings.length
        });

        // Rate limiting: 1000 req/min = ~60ms between requests
        await new Promise(resolve => setTimeout(resolve, 70));

      } catch (error) {
        console.error(`❌ Error fetching item ${want.basic_information.id}:`, error.message);
      }
    }

    console.log(`✅ Analysis complete!`);

    // Step 4: Sort vendors by count
    const vendors = Object.values(vendorMap)
      .sort((a, b) => b.count - a.count)
      .map((vendor, index) => ({
        rank: index + 1,
        username: vendor.username,
        count: vendor.count,
        percentage: ((vendor.count / wantsToAnalyze.length) * 100).toFixed(1),
        averagePrice: (vendor.totalPrice / vendor.count).toFixed(2),
        totalPrice: vendor.totalPrice.toFixed(2),
        estimatedSavings: (15 * (vendor.count - 1)).toFixed(2), // $15 shipping saved per combined item
        items: vendor.items.slice(0, 10) // Top 10 items
      }));

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n🎉 Results:`);
    console.log(`   Top vendor: ${vendors[0]?.username} with ${vendors[0]?.count} items`);
    console.log(`   Total vendors found: ${vendors.length}`);
    console.log(`   Processing time: ${duration}s`);
    console.log(`🎵 ===================================\n`);

    // Step 5: Return results
    res.json({
      success: true,
      username,
      plan,
      totalWants: allWants.length,
      analyzedWants: wantsToAnalyze.length,
      randomized: wasRandomized,
      processingTime: `${duration}s`,
      topVendor: vendors[0] || null,
      vendors: vendors.slice(0, 50),
      estimatedSavings: vendors[0]?.estimatedSavings || 0,
      stats: {
        totalSellers: vendors.length,
        avgItemsPerSeller: vendors.length > 0 
          ? (vendors.reduce((sum, v) => sum + v.count, 0) / vendors.length).toFixed(1)
          : 0,
        bestSellerHas: vendors[0] 
          ? `${vendors[0].count}/${wantsToAnalyze.length} items (${vendors[0].percentage}%)`
          : 'N/A'
      },
      message: wasRandomized 
        ? `Analyzed ${wantsToAnalyze.length} random items from your ${allWants.length} item wantlist. Results will vary each search. Upgrade to COLLECTOR to analyze ALL items and find THE optimal seller.`
        : null
    });

  } catch (error) {
    console.error('❌ Analysis error:', error);
    res.status(500).json({ 
      error: 'Analysis failed', 
      details: error.message 
    });
  }
});

// Stripe: Create checkout session
app.post('/create-checkout-session', async (req, res) => {
  const { plan, userEmail, userId } = req.body;

  if (!plan || !userEmail) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const priceIds = {
    pro: process.env.STRIPE_PRO_PRICE_ID,
    collector: process.env.STRIPE_COLLECTOR_PRICE_ID
  };

  const priceId = priceIds[plan];
  if (!priceId) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/#pricing`,
      customer_email: userEmail,
      client_reference_id: userId,
      metadata: {
        plan: plan,
        userId: userId
      }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stripe: Webhook
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Webhook received:', event.type);

  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      console.log('Payment successful for:', session.customer_email);
      break;
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      console.log('Subscription updated:', event.data.object.id);
      break;
    case 'invoice.payment_failed':
      console.log('Payment failed:', event.data.object.customer_email);
      break;
  }

  res.json({ received: true });
});

// Stripe: Get subscription status
app.get('/subscription-status', async (req, res) => {
  const { userId } = req.query;
  
  if (!userId) {
    return res.status(400).json({ error: 'userId required' });
  }

  try {
    const subscriptions = await stripe.subscriptions.list({
      limit: 1,
      customer: userId
    });

    if (subscriptions.data.length === 0) {
      return res.json({ plan: 'free', status: 'inactive' });
    }

    const sub = subscriptions.data[0];
    res.json({
      plan: sub.metadata.plan || 'pro',
      status: sub.status,
      currentPeriodEnd: sub.current_period_end
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stripe: Create portal session
app.post('/create-portal-session', async (req, res) => {
  const { customerId } = req.body;

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: process.env.FRONTEND_URL,
    });

    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  const hasToken = !!DISCOGS_TOKEN;
  const rateLimit = hasToken ? 1000 : 60;
  
  console.log('\n🎵 ===================================');
  console.log('🚀 WantlistOptimizer API v2.0');
  console.log('🎵 ===================================');
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`💰 Cost: 0€/month (Discogs API direct)`);
  console.log(`⚡ Rate: ${rateLimit} req/min`);
  console.log(`🔑 Token: ${hasToken ? '✅ Active' : '⚠️  Missing (performance degraded)'}`);
  console.log('🎵 ===================================\n');
});