const express = require('express');
const WebSocket = require('ws').WebSocket;
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = 'https://xzfrrskovooqiyiqqidy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh6ZnJyc2tvdm9vcWl5aXFxaWR5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODE2MTU3MCwiZXhwIjoyMDkzNzM3NTcwfQ.XI1AYOZpTM6i01JRGl_Dl9qyoMSOdWXeng50Z1UwzNE';

// Render dashboard > Environment > ANTHROPIC_API_KEY olarak ekle
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

let prices = {};
let orderedSymbols = [];
let coinMetadata = {};
let coinStats = {};
let totalMarketCap = 0;
let ws = null;
const sparklineCache = {};

// ─────────────────────────────────────────────────────────────────────────────
// Supabase — assets tablosundan metadata oku
// ─────────────────────────────────────────────────────────────────────────────
async function loadMetadataFromSupabase() {
  try {
    console.log('Supabase assets yukleniyor...');
    const response = await axios.get(
`${SUPABASE_URL}/rest/v1/assets?select=symbol,name,logo_url,gecko_id`,      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        timeout: 10000,
      }
    );

    if (response.data && response.data.length > 0) {
      response.data.forEach((row) => {
        coinMetadata[row.symbol] = {
          symbol: row.symbol,
          name: row.name || row.symbol,
          logo: row.logo_url || '',
          geckoId: row.gecko_id || '',
          rank: 9999,
          marketCap: 0,
        };
      });
      console.log(`Supabase assets: ${response.data.length} coin yuklendi`);
      return true;
    }
    console.log('Supabase assets bos dondu');
    return false;
  } catch (e) {
    console.log('Supabase okuma hatasi:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase — assets tablosunu guncelle (logo, gecko_id, rank)
// ─────────────────────────────────────────────────────────────────────────────
async function saveMetadataToSupabase(data) {
  try {
    for (let i = 0; i < data.length; i += 100) {
      const batch = data.slice(i, i + 100);
      for (const coin of batch) {
        await axios.patch(
          `${SUPABASE_URL}/rest/v1/assets?symbol=eq.${coin.symbol}`,
          {
            logo_url: coin.logo || '',
            gecko_id: coin.geckoId || '',
            updated_at: new Date().toISOString(),
          },
          {
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            timeout: 5000,
          }
        );
      }
    }
    console.log(`${data.length} coin assets tablosunda guncellendi`);
  } catch (e) {
    console.log('Supabase guncelleme hatasi:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CoinGecko — metadata cek ve assets tablosuna kaydet
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
    await saveMetadataToSupabase(collected);

    collected.forEach((coin) => {
      if (coinMetadata[coin.symbol]) {
        coinMetadata[coin.symbol].rank = coin.rank;
        coinMetadata[coin.symbol].marketCap = coin.marketCap;
        coinMetadata[coin.symbol].logo = coin.logo;
        coinMetadata[coin.symbol].geckoId = coin.geckoId;
      } else {
        coinMetadata[coin.symbol] = coin;
      }
    });

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
  let loaded = 0;
  for (const symbol of orderedSymbols) {
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
        loaded++;
      }
      await new Promise((r) => setTimeout(r, 100));
    } catch (_) {}
  }
  console.log(`Sparklines yuklendi: ${loaded}/${orderedSymbols.length}`);
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

      const symbol    = data.product_id.replace('-USD', '');
      const price     = parseFloat(data.price);
      const open      = parseFloat(data.open_24h);
      const change    = open > 0 ? Number((((price - open) / open) * 100).toFixed(2)) : 0;
      const meta      = coinMetadata[symbol] || { rank: 9999, name: symbol, marketCap: 0 };
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
// Claude ile Türkçe çeviri
// ─────────────────────────────────────────────────────────────────────────────
async function translateWithClaude(englishText, coinName) {
  if (!ANTHROPIC_API_KEY) {
    console.log('ANTHROPIC_API_KEY eksik');
    return null;
  }

  const cleanText = englishText.replace(/<[^>]*>/g, '').trim();
  if (!cleanText || cleanText.length < 20) return null;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `Aşağıdaki kripto para açıklamasını Türkçe'ye çevir.
Kurallar:
- Teknik terimler (blockchain, token, smart contract, DeFi, staking vb.) Türkçe'ye çevrilmez
- Coin/proje isimleri değiştirilmez
- Sadece çeviriyi yaz, başka hiçbir şey ekleme
- Doğal ve akıcı Türkçe kullan

${coinName} açıklaması:
${cleanText.slice(0, 1500)}`,
          },
        ],
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    return response.data.content[0]?.text?.trim() || null;
  } catch (e) {
    console.log('Claude çeviri hatası:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /coin-info/:symbol
// Önce assets.description_tr'ye bakar, yoksa CoinGecko + Claude ile üretir
// ─────────────────────────────────────────────────────────────────────────────
app.get('/coin-info/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  // 1. assets tablosunda description_tr var mı?
  try {
    const cached = await axios.get(
      `${SUPABASE_URL}/rest/v1/assets?symbol=eq.${symbol}&select=description_tr,gecko_id,name`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        timeout: 5000,
      }
    );

    const row = cached.data?.[0];

    if (row?.description_tr) {
      return res.json({ symbol, description_tr: row.description_tr, source: 'cache' });
    }

    // 2. gecko_id yoksa eşleşme yok
    const geckoId = row?.gecko_id || coinMetadata[symbol]?.geckoId;
    if (!geckoId) {
      return res.json({ symbol, description_tr: null, source: 'no_match' });
    }

    // 3. CoinGecko'dan İngilizce açıklama çek
    let englishDescription = null;
    try {
      const geckoResponse = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${geckoId}`,
        {
          params: {
            localization: false,
            tickers: false,
            market_data: false,
            community_data: false,
            developer_data: false,
          },
          timeout: 10000,
        }
      );
      englishDescription = geckoResponse.data?.description?.en || null;
    } catch (e) {
      console.log(`CoinGecko ${symbol} hatası:`, e.message);
      return res.status(503).json({ symbol, description_tr: null, source: 'gecko_error' });
    }

    if (!englishDescription || englishDescription.length < 20) {
      return res.json({ symbol, description_tr: null, source: 'no_description' });
    }

    // 4. Claude ile Türkçe'ye çevir
    const coinName = row?.name || coinMetadata[symbol]?.name || symbol;
    const translatedText = await translateWithClaude(englishDescription, coinName);

    if (!translatedText) {
      return res.json({ symbol, description_tr: null, source: 'translation_failed' });
    }

    // 5. assets tablosuna description_tr olarak kaydet
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/assets?symbol=eq.${symbol}`,
      { description_tr: translatedText },
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        timeout: 5000,
      }
    );

    console.log(`${symbol} açıklaması çevrildi ve kaydedildi`);
    res.json({ symbol, description_tr: translatedText, source: 'translated' });

  } catch (e) {
    console.log(`/coin-info/${symbol} hatası:`, e.message);
    res.status(500).json({ symbol, description_tr: null, source: 'error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Ana baslama
// ─────────────────────────────────────────────────────────────────────────────
async function initialize() {
  try {
    const symbols = await loadCoinbaseSymbols();
    orderedSymbols = symbols;

    const hasCache = await loadMetadataFromSupabase();

    orderedSymbols.sort((a, b) => {
      return (coinMetadata[a]?.rank || 9999) - (coinMetadata[b]?.rank || 9999);
    });

    await loadGlobalStats();
    startWebSocket();
    loadCoinStats();

    setTimeout(() => {
      loadSparklines();
      setInterval(() => loadSparklines(), 1800000);
    }, 120000);

    const geckoDelay = hasCache ? 300000 : 60000;
    setTimeout(() => {
      fetchAndSaveCoinGeckoMetadata(symbols);
      setInterval(() => fetchAndSaveCoinGeckoMetadata(symbols), 21600000);
    }, geckoDelay);

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
    if (prices[symbol]) {
      result[symbol] = {
        ...prices[symbol],
        sparkline: sparklineCache[symbol] || prices[symbol].sparkline || [],
      };
    }
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