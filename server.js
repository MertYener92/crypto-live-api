const express = require('express');
const WebSocket = require('ws').WebSocket;
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = 'https://xzfrrskovooqiyiqqidy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh6ZnJyc2tvdm9vcWl5aXFxaWR5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODE2MTU3MCwiZXhwIjoyMDkzNzM3NTcwfQ.XI1AYOZpTM6i01JRGl_Dl9qyoMSOdWXeng50Z1UwzNE';

let prices = {};
let orderedSymbols = [];
let coinMetadata = {};
let coinStats = {};
let totalMarketCap = 0;
let ws = null;
const sparklineCache = {};

// ─────────────────────────────────────────────────────────────────────────────
// Supabase — metadata oku
// ─────────────────────────────────────────────────────────────────────────────
async function loadMetadataFromSupabase() {
  try {
    console.log('Supabase metadata yukleniyor...');
    const response = await axios.get(
      `${SUPABASE_URL}/rest/v1/coin_metadata?select=*&limit=2000`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        timeout: 10000,
      }
    );

    console.log(`Supabase response status: ${response.status}, kayit sayisi: ${response.data?.length}`);

    if (response.data && response.data.length > 0) {
      response.data.forEach((row) => {
        coinMetadata[row.symbol] = {
          rank: row.rank || 9999,
          symbol: row.symbol,
          name: row.name || row.symbol,
          marketCap: Number(row.market_cap || 0),
          logo: row.logo_url || '',
          geckoId: row.gecko_id || '',
        };
      });
      console.log(`Supabase'den ${response.data.length} coin metadata yuklendi`);
      return true;
    }
    console.log('Supabase bos dondu');
    return false;
  } catch (e) {
    console.log('Supabase okuma hatasi:', e.message, e.response?.status, e.response?.data);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase — metadata kaydet (upsert)
// ─────────────────────────────────────────────────────────────────────────────
async function saveMetadataToSupabase(data) {
  try {
    const rows = data.map((coin) => ({
      symbol: coin.symbol,
      name: coin.name,
      rank: coin.rank || 9999,
      market_cap: coin.marketCap || 0,
      logo_url: coin.logo || '',
      gecko_id: coin.geckoId || '',
      updated_at: new Date().toISOString(),
    }));

    // 500'er batch ile kaydet
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await axios.post(
        `${SUPABASE_URL}/rest/v1/coin_metadata`,
        batch,
        {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates',
          },
          timeout: 15000,
        }
      );
    }
    console.log(`${rows.length} coin metadata Supabase'e kaydedildi`);
  } catch (e) {
    console.log('Supabase kayit hatasi:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CoinGecko — metadata cek ve Supabase'e kaydet
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAndSaveCoinGeckoMetadata(symbols) {
  const symbolSet = new Set(symbols);
  const collected = [];

  for (let page = 1; page <= 4; page++) {
    let success = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await axios.get(
          'https://api.coingecko.com/api/v3/coins/markets',
          {
            params: {
              vs_currency: 'usd',
              order: 'market_cap_desc',
              per_page: 125,
              page,
              sparkline: false,
            },
            timeout: 10000,
          }
        );

        response.data.forEach((coin) => {
          const symbol = coin.symbol.toUpperCase();
          if (symbolSet.has(symbol)) {
            collected.push({
              symbol,
              name: coin.name,
              rank: coin.market_cap_rank || 9999,
              marketCap: Number(coin.market_cap || 0),
              logo: coin.image || '',
              geckoId: coin.id,
            });
          }
        });

        console.log(`CoinGecko sayfa ${page} yuklendi (${collected.length} coin)`);
        success = true;
        break;
      } catch (e) {
        const wait = attempt * 60000;
        console.log(`CoinGecko sayfa ${page} hata, ${wait / 1000}sn bekleniyor...`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (!success) console.log(`CoinGecko sayfa ${page} atlandi`);
    if (page < 4) await new Promise((r) => setTimeout(r, 30000));
  }

  if (collected.length > 0) {
    // Supabase'e kaydet
    await saveMetadataToSupabase(collected);

    // Memory'i guncelle
    collected.forEach((coin) => {
      coinMetadata[coin.symbol] = coin;
    });

    // Rank'e gore sirala
    orderedSymbols.sort((a, b) => {
      return (coinMetadata[a]?.rank || 9999) - (coinMetadata[b]?.rank || 9999);
    });

    console.log(`Toplam ${collected.length} coin metadata guncellendi`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coinbase aktif USD coinleri
// ─────────────────────────────────────────────────────────────────────────────
async function loadCoinbaseSymbols() {
  const response = await axios.get(
    'https://api.exchange.coinbase.com/products',
    { timeout: 10000 }
  );
  const symbols = response.data
    .filter((p) => p.quote_currency === 'USD' && p.status === 'online')
    .map((p) => p.base_currency.toUpperCase());
  console.log(`Coinbase: ${symbols.length} aktif USD coini`);
  return symbols;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coinbase 24s stats
// ─────────────────────────────────────────────────────────────────────────────
async function loadCoinStats() {
  for (const symbol of orderedSymbols) {
    try {
      const response = await axios.get(
        `https://api.exchange.coinbase.com/products/${symbol}-USD/stats`,
        { timeout: 5000 }
      );
      coinStats[symbol] = {
        high24h:   Number(response.data.high),
        low24h:    Number(response.data.low),
        volume24h: Number(response.data.volume),
      };
    } catch (_) {}
  }
  console.log('Coin stats yuklendi');
}

// ─────────────────────────────────────────────────────────────────────────────
// Sparkline
// ─────────────────────────────────────────────────────────────────────────────
async function loadSparklines() {
  const promises = orderedSymbols.map(async (symbol) => {
    try {
      const end   = new Date();
      const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
      const response = await axios.get(
        `https://api.exchange.coinbase.com/products/${symbol}-USD/candles`,
        {
          params: { start: start.toISOString(), end: end.toISOString(), granularity: 3600 },
          timeout: 5000,
        }
      );
      if (response.data && response.data.length > 0) {
        sparklineCache[symbol] = response.data.map((c) => c[4]).reverse().slice(-24);
        // prices varsa guncelle, yoksa cache'de beklesin
        if (prices[symbol]) {
          prices[symbol].sparkline = sparklineCache[symbol];
        }
      }
    } catch (_) {}
  });
  await Promise.allSettled(promises);
  console.log('Sparklines yuklendi');
}

// ─────────────────────────────────────────────────────────────────────────────
// Global market cap
// ─────────────────────────────────────────────────────────────────────────────
async function loadGlobalStats() {
  try {
    const response = await axios.get('https://api.coinlore.net/api/global/', { timeout: 5000 });
    totalMarketCap = Number(response.data[0].total_mcap);
    console.log('Global market cap yuklendi');
  } catch (e) {
    console.log('Global Stats Error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coinbase WebSocket
// ─────────────────────────────────────────────────────────────────────────────
function startWebSocket() {
  if (ws) ws.close();

  ws = new WebSocket('wss://ws-feed.exchange.coinbase.com', { perMessageDeflate: false });

  ws.on('open', () => {
    console.log('Coinbase WebSocket connected');
    const productIds = orderedSymbols.map((s) => `${s}-USD`);
    ws.send(JSON.stringify({
      type: 'subscribe',
      channels: [{ name: 'ticker', product_ids: productIds }],
    }));
  });

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type !== 'ticker') return;

      const symbol  = data.product_id.replace('-USD', '');
      const price   = parseFloat(data.price);
      const open    = parseFloat(data.open_24h);
      const change  = open > 0 ? Number((((price - open) / open) * 100).toFixed(2)) : 0;
      const meta    = coinMetadata[symbol] || { rank: 9999, name: symbol, marketCap: 0 };
      const dominance = totalMarketCap > 0
        ? Number(((meta.marketCap / totalMarketCap) * 100).toFixed(2))
        : 0;

      prices[symbol] = {
        rank:      meta.rank,
        symbol,
        name:      meta.name || symbol,
        marketCap: meta.marketCap || 0,
        dominance,
        high24h:   coinStats[symbol]?.high24h   || parseFloat(data.high_24h) || 0,
        low24h:    coinStats[symbol]?.low24h    || parseFloat(data.low_24h)  || 0,
        volume24h: coinStats[symbol]?.volume24h ? coinStats[symbol].volume24h * price : 0,
        logo:      `https://crypto-live-api.onrender.com/logo/${symbol}`,
        price,
        change,
        sparkline: sparklineCache[symbol] || [],
      };
    } catch (e) {
      console.log('WS Parse Error:', e.message);
    }
  });

  ws.on('error', (err) => console.log('WebSocket Error:', err.message));
  ws.on('close', () => {
    console.log('WebSocket closed. Reconnecting in 3s...');
    setTimeout(() => startWebSocket(), 3000);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ana baslama
// ─────────────────────────────────────────────────────────────────────────────
async function initialize() {
  try {
    // 1. Coinbase sembollerini al
    const symbols = await loadCoinbaseSymbols();
    orderedSymbols = symbols;

    // 2. Supabase'den onceki metadata'yi yukle
    const hasCache = await loadMetadataFromSupabase();

    // 3. Rank'e gore sirala
    orderedSymbols.sort((a, b) => {
      return (coinMetadata[a]?.rank || 9999) - (coinMetadata[b]?.rank || 9999);
    });

    // 4. Global stats + WebSocket + stats basalt
    await loadGlobalStats();
    startWebSocket();
    loadCoinStats();

    // 5. Sparkline 2dk sonra yukle - prices dolmus olsun
    setTimeout(() => {
      loadSparklines();
      setInterval(() => loadSparklines(), 1800000);
    }, 120000);

    // 6. CoinGecko'dan taze metadata cek ve Supabase'e kaydet
    // Cache varsa 5dk bekle, yoksa hemen basla
    const geckoDelay = hasCache ? 300000 : 60000;
    setTimeout(() => {
      fetchAndSaveCoinGeckoMetadata(symbols);
      // 6 saatte bir yenile
      setInterval(() => fetchAndSaveCoinGeckoMetadata(symbols), 21600000);
    }, geckoDelay);

    // 7. Periyodik yenilemeler
    setInterval(() => loadCoinStats(),   300000);
    setInterval(() => loadGlobalStats(), 300000);

    console.log(`Sunucu hazir, ${orderedSymbols.length} coin yuklendi`);
  } catch (e) {
    console.log('Initialize Error:', e.message);
    setTimeout(() => initialize(), 10000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /logo/:symbol
// ─────────────────────────────────────────────────────────────────────────────
const logoCache = {};

app.get('/logo/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    if (logoCache[symbol]) {
      res.set('Content-Type', logoCache[symbol].contentType);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(logoCache[symbol].data);
    }
    const logoUrl = coinMetadata[symbol]?.logo;
    if (!logoUrl) return res.status(404).send('Logo not found');

    const response = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 8000 });
    const contentType = response.headers['content-type'] || 'image/png';
    logoCache[symbol] = { data: response.data, contentType };

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (e) {
    res.status(500).send('Logo fetch failed');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /prices
// ─────────────────────────────────────────────────────────────────────────────
app.get('/prices', (req, res) => {
  const result = {};
  orderedSymbols.forEach((symbol) => {
    if (prices[symbol]) result[symbol] = prices[symbol];
  });
  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /chart/:symbol
// ─────────────────────────────────────────────────────────────────────────────
function getChartConfig(period) {
  switch (period) {
    case '1D': return { days: 1,    granularity: 3600  };
    case '1M': return { days: 30,   granularity: 86400 };
    case '3M': return { days: 90,   granularity: 86400 };
    case '6M': return { days: 180,  granularity: 86400 };
    case '1Y': return { days: 365,  granularity: 86400 };
    case '5Y': return { days: 1825, granularity: 86400 };
    default:   return { days: 1,    granularity: 3600  };
  }
}

async function fetchCandles(symbol, startMs, endMs, granularity) {
  const maxCandles = 300;
  const windowMs   = granularity * maxCandles * 1000;
  const chunks     = [];
  let chunkEnd     = endMs;

  while (chunkEnd > startMs) {
    const chunkStart = Math.max(chunkEnd - windowMs, startMs);
    chunks.push({ start: chunkStart, end: chunkEnd });
    chunkEnd = chunkStart;
  }

  let allCandles = [];
  for (const chunk of chunks) {
    try {
      const response = await axios.get(
        `https://api.exchange.coinbase.com/products/${symbol}-USD/candles`,
        {
          params: {
            start: new Date(chunk.start).toISOString(),
            end:   new Date(chunk.end).toISOString(),
            granularity,
          },
        }
      );
      allCandles = allCandles.concat(response.data);
    } catch (e) {
      console.log(`Candle chunk error (${symbol}):`, e.message);
    }
  }
  return allCandles;
}

app.get('/chart/:symbol', async (req, res) => {
  try {
    const symbol  = req.params.symbol.toUpperCase();
    const period  = req.query.period || '1D';
    const config  = getChartConfig(period);
    const endMs   = Date.now();
    const startMs = endMs - config.days * 24 * 60 * 60 * 1000;

    const candles = await fetchCandles(symbol, startMs, endMs, config.granularity);
    if (!candles || candles.length === 0) {
      return res.status(404).json({ error: 'No candle data found' });
    }

    const chartData = candles
      .map((c) => ({ time: c[0], price: c[4] }))
      .sort((a, b) => a.time - b.time)
      .filter((item, i, arr) => i === 0 || item.time !== arr[i - 1].time);

    res.json(chartData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /fng
// ─────────────────────────────────────────────────────────────────────────────
let fngCache = null;
let fngLastFetch = 0;

app.get('/fng', async (req, res) => {
  try {
    const now = Date.now();
    if (fngCache && now - fngLastFetch < 10 * 60 * 1000) return res.json(fngCache);

    const response = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5000 });
    const item = response.data.data[0];
    fngCache = {
      value: parseInt(item.value),
      classification: item.value_classification,
      timestamp: item.timestamp,
    };
    fngLastFetch = now;
    res.json(fngCache);
  } catch (e) {
    if (fngCache) return res.json(fngCache);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Basalt
// ─────────────────────────────────────────────────────────────────────────────
initialize();

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));