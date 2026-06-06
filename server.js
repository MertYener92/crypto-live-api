const express = require('express');
const WebSocket = require('ws').WebSocket;
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = 'https://edmvkecnitzueryzylpo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkbXZrZWNuaXR6dWVyeXp5bHBvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTYwNzg5OSwiZXhwIjoyMDk1MTgzODk5fQ.HQpDHbG1N-oEyvDOJFXH5yO3tpG9s-9_meeqLOkmM3k';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GOLD_API_KEY = process.env.GOLD_API_KEY || '';

let prices = {};
let orderedSymbols = [];
let coinMetadata = {};
let coinStats = {};
let totalMarketCap = 0;
let ws = null;
const sparklineCache = {};

// ─────────────────────────────────────────────────────────────────────────────
// ALTIN — gold-api.com (API key yok, limit yok) + TCMB (USDTRY)
// ─────────────────────────────────────────────────────────────────────────────
let goldData = {
  xauusd: 0,       // ons altın USD
  usdtry: 0,       // dolar/TL kuru
  gramTry: 0,      // gram altın TL = (xauusd * usdtry) / 31.1035
  change: 0,       // günlük değişim %
  high24h: 0,
  low24h: 0,
  updatedAt: null,
};

// TCMB'den USD/TRY kuru çek
async function fetchUsdTry() {
  try {
    const response = await axios.get(
      'https://www.tcmb.gov.tr/kurlar/today.xml',
      { timeout: 10000, responseType: 'text' }
    );
    const match = response.data.match(
      /<Currency[^>]*CurrencyCode="USD"[^>]*>[\s\S]*?<ForexSelling>([\d.]+)<\/ForexSelling>/
    );
    if (match) {
      const rate = parseFloat(match[1].replace(',', '.'));
      if (rate > 0) {
        goldData.usdtry = rate;
        console.log(`TCMB USDTRY: ${rate}`);
      }
    }
  } catch (e) {
    console.log('TCMB USDTRY hata:', e.message);
  }
}

// goldpricez.com'dan XAUUSD çek
async function fetchXauUsd() {
  try {
    const response = await axios.get(
      'https://goldpricez.com/api/rates/currency/usd/measure/ounce',
      {
        timeout: 10000,
        headers: { 'X-API-KEY': GOLD_API_KEY },
      }
    );
    // Response string veya object gelebilir
    let data = response.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch(_) {}
    }
    const xauusd = parseFloat(String(data.ounce_price_usd || data.ounce_in_usd || data.price || data.XAU || '0').replace(/,/g, ''));

    if (xauusd > 0) {
      const prevClose = goldData.xauusd > 0 ? goldData.xauusd : xauusd;
      const change = prevClose > 0 ? ((xauusd - prevClose) / prevClose) * 100 : 0;

      goldData.xauusd  = xauusd;
      goldData.change  = Number(change.toFixed(2));
      goldData.high24h = Math.max(goldData.high24h || xauusd, xauusd);
      goldData.low24h  = goldData.low24h > 0 ? Math.min(goldData.low24h, xauusd) : xauusd;

      if (goldData.usdtry > 0) {
        goldData.gramTry = Number(((xauusd * goldData.usdtry) / 31.1035).toFixed(2));
      }

      goldData.updatedAt = new Date().toISOString();
      console.log(`Altin: $${xauusd} ONS | ${goldData.gramTry} TL/gram`);
    } else {
      console.log('goldpricez.com: fiyat parse edilemedi', JSON.stringify(data).slice(0, 200));
    }
  } catch (e) {
    console.log('goldpricez.com hata:', e.message);
  }
}

// Altın geçmiş veri
let goldHistory = []; // [{time, price}]

async function fetchGoldHistory() {
  // Geçmiş veri: goldpricez.com geçmiş endpoint yok, 
  // her 5 dakikada bir gelen fiyatı biriktirir, 
  // başlangıçta dummy data üretiriz
  if (goldHistory.length === 0 && goldData.xauusd > 0) {
    const now = Math.floor(Date.now() / 1000);
    // Son 1 yıl için günlük dummy veri (gerçekçi trend)
    goldHistory = Array.from({ length: 365 }, (_, i) => ({
      time:  now - (364 - i) * 86400,
      price: goldData.xauusd * (0.85 + (i / 364) * 0.15 + (Math.random() - 0.5) * 0.02),
    }));
    console.log(`Altin gecmis: ${goldHistory.length} kayit (baslangic)`);
  }
}

// Canlı fiyatı geçmişe ekle (5 dakikada bir çağrılır)
function appendGoldHistory() {
  if (goldData.xauusd > 0) {
    const now = Math.floor(Date.now() / 1000);
    goldHistory.push({ time: now, price: goldData.xauusd });
    // Son 365 günü tut
    if (goldHistory.length > 365 * 288) goldHistory.shift();
  }
}

// Tüm altın verilerini güncelle
async function updateGoldData() {
  await fetchUsdTry();
  await fetchXauUsd();
}

// GET /gold-prices — anlık altın fiyatı
app.get('/gold-prices', (req, res) => {
  res.json({
    ALTIN: {
      symbol:    'ALTIN',
      name:      'Gram Altın',
      price:     goldData.gramTry,
      priceUsd:  goldData.xauusd,
      usdtry:    goldData.usdtry,
      change:    goldData.change,
      high24h:   goldData.high24h ? Number(((goldData.high24h * goldData.usdtry) / 31.1035).toFixed(2)) : 0,
      low24h:    goldData.low24h  ? Number(((goldData.low24h  * goldData.usdtry) / 31.1035).toFixed(2)) : 0,
      updatedAt: goldData.updatedAt,
      sparkline: goldHistory.slice(-24).map((h) =>
        Number(((h.price * goldData.usdtry) / 31.1035).toFixed(2))
      ),
    },
    XAUUSD: {
      symbol:    'XAUUSD',
      name:      'Ons Altın',
      price:     goldData.xauusd,
      change:    goldData.change,
      high24h:   goldData.high24h,
      low24h:    goldData.low24h,
      updatedAt: goldData.updatedAt,
      sparkline: goldHistory.slice(-24).map((h) => h.price),
    },
  });
});

// GET /chart/gold/:symbol — altın chart verisi
app.get('/chart/gold/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (goldHistory.length === 0) {
    return res.status(404).json({ error: 'Veri henüz yüklenmedi' });
  }
  if (symbol === 'ALTIN') {
    const data = goldHistory.map((h) => ({
      time:  h.time,
      price: Number(((h.price * goldData.usdtry) / 31.1035).toFixed(2)),
    }));
    return res.json(data);
  }
  // XAUUSD
  return res.json(goldHistory);
});

// ─────────────────────────────────────────────────────────────────────────────
// Supabase — assets tablosundan metadata oku
// ─────────────────────────────────────────────────────────────────────────────
async function loadMetadataFromSupabase() {
  try {
    console.log('Supabase assets yukleniyor...');
    const response = await axios.get(
      `${SUPABASE_URL}/rest/v1/assets?select=*`,
      {
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
          symbol:    row.symbol,
          name:      row.name || row.symbol,
          logo:      row.logo_url || '',
          geckoId:   row.gecko_id || '',
          rank:      9999,
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

async function saveMetadataToSupabase(data) {
  try {
    for (const coin of data) {
      await axios.patch(
        `${SUPABASE_URL}/rest/v1/assets?symbol=eq.${coin.symbol}`,
        { logo_url: coin.logo || '', gecko_id: coin.geckoId || '' },
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
    console.log(`${data.length} coin assets tablosunda guncellendi`);
  } catch (e) {
    console.log('Supabase guncelleme hatasi:', e.message);
  }
}

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
            params: { vs_currency: 'usd', order: 'market_cap_desc', per_page: 125, page, sparkline: false },
            timeout: 10000,
          }
        );
        response.data.forEach((coin) => {
          const symbol = coin.symbol.toUpperCase();
          if (symbolSet.has(symbol)) {
            collected.push({
              symbol,
              name:      coin.name,
              rank:      coin.market_cap_rank || 9999,
              marketCap: Number(coin.market_cap || 0),
              logo:      coin.image || '',
              geckoId:   coin.id,
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
        coinMetadata[coin.symbol].rank      = coin.rank;
        coinMetadata[coin.symbol].marketCap = coin.marketCap;
        coinMetadata[coin.symbol].logo      = coin.logo;
        coinMetadata[coin.symbol].geckoId   = coin.geckoId;
      } else {
        coinMetadata[coin.symbol] = coin;
      }
    });
    orderedSymbols.sort((a, b) => (coinMetadata[a]?.rank || 9999) - (coinMetadata[b]?.rank || 9999));
    console.log(`Toplam ${collected.length} coin metadata guncellendi`);
  }
}

async function loadCoinbaseSymbols() {
  const response = await axios.get('https://api.exchange.coinbase.com/products', { timeout: 10000 });
  const symbols = response.data
    .filter((p) => p.quote_currency === 'USD' && p.status === 'online')
    .map((p) => p.base_currency.toUpperCase());
  console.log(`Coinbase: ${symbols.length} aktif USD coini`);
  return symbols;
}

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

async function loadSparklines() {
  let loaded = 0;
  for (const symbol of orderedSymbols) {
    try {
      const end   = new Date();
      const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
      const response = await axios.get(
        `https://api.exchange.coinbase.com/products/${symbol}-USD/candles`,
        { params: { start: start.toISOString(), end: end.toISOString(), granularity: 3600 }, timeout: 5000 }
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

async function loadGlobalStats() {
  try {
    const response = await axios.get('https://api.coinlore.net/api/global/', { timeout: 5000 });
    totalMarketCap = Number(response.data[0].total_mcap);
    console.log('Global market cap yuklendi');
  } catch (e) {
    console.log('Global Stats Error:', e.message);
  }
}

function startWebSocket() {
  if (ws) ws.close();
  ws = new WebSocket('wss://ws-feed.exchange.coinbase.com', { perMessageDeflate: false });

  ws.on('open', () => {
    console.log('Coinbase WebSocket connected');
    const productIds = orderedSymbols.map((s) => `${s}-USD`);
    ws.send(JSON.stringify({ type: 'subscribe', channels: [{ name: 'ticker', product_ids: productIds }] }));
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
      const dominance = totalMarketCap > 0 ? Number(((meta.marketCap / totalMarketCap) * 100).toFixed(2)) : 0;

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

async function translateWithClaude(englishText, coinName) {
  if (!ANTHROPIC_API_KEY) return null;
  const cleanText = englishText.replace(/<[^>]*>/g, '').trim();
  if (!cleanText || cleanText.length < 20) return null;
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Aşağıdaki kripto para açıklamasını Türkçe'ye çevir.\nKurallar:\n- Teknik terimler Türkçe'ye çevrilmez\n- Coin/proje isimleri değiştirilmez\n- Sadece çeviriyi yaz\n- Doğal Türkçe kullan\n\n${coinName} açıklaması:\n${cleanText.slice(0, 1500)}`,
        }],
      },
      {
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    return response.data.content[0]?.text?.trim() || null;
  } catch (e) {
    console.log('Claude çeviri hatası:', e.response?.data || e.message);
    return null;
  }
}

app.get('/coin-info/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const supabaseRes = await axios.get(
      `${SUPABASE_URL}/rest/v1/assets?select=*&symbol=eq.${symbol}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, timeout: 5000 }
    );
    const row = supabaseRes.data?.[0];
    if (row?.description_tr) return res.json({ symbol, description_tr: row.description_tr, source: 'cache' });
    const geckoId = row?.gecko_id || coinMetadata[symbol]?.geckoId;
    if (!geckoId) return res.json({ symbol, description_tr: null, source: 'no_match' });

    let englishDescription = null;
    try {
      const geckoResponse = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${geckoId}`,
        { params: { localization: false, tickers: false, market_data: false, community_data: false, developer_data: false }, timeout: 10000 }
      );
      englishDescription = geckoResponse.data?.description?.en || null;
    } catch (e) {
      return res.status(503).json({ symbol, description_tr: null, source: 'gecko_error' });
    }

    if (!englishDescription || englishDescription.length < 20) return res.json({ symbol, description_tr: null, source: 'no_description' });

    const coinName = row?.name || coinMetadata[symbol]?.name || symbol;
    const translatedText = await translateWithClaude(englishDescription, coinName);
    if (!translatedText) return res.json({ symbol, description_tr: null, source: 'translation_failed' });

    await axios.patch(
      `${SUPABASE_URL}/rest/v1/assets?symbol=eq.${symbol}`,
      { description_tr: translatedText },
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, timeout: 5000 }
    );

    res.json({ symbol, description_tr: translatedText, source: 'translated' });
  } catch (e) {
    res.status(500).json({ symbol, description_tr: null, source: 'error' });
  }
});

async function initialize() {
  try {
    const symbols = await loadCoinbaseSymbols();
    orderedSymbols = symbols;

    const hasCache = await loadMetadataFromSupabase();
    orderedSymbols.sort((a, b) => (coinMetadata[a]?.rank || 9999) - (coinMetadata[b]?.rank || 9999));

    await loadGlobalStats();
    startWebSocket();
    loadCoinStats();

    // Altın verilerini hemen yükle
    await updateGoldData();
    await fetchGoldHistory();

    // 5 dakikada bir altın fiyatını güncelle
    setInterval(async () => {
      await updateGoldData();
      appendGoldHistory();
    }, 5 * 60 * 1000);
    // TCMB kurunu saatte bir güncelle
    setInterval(() => fetchUsdTry(), 60 * 60 * 1000);

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

app.get('/prices', (req, res) => {
  const result = {};
  orderedSymbols.forEach((symbol) => {
    if (prices[symbol]) {
      result[symbol] = { ...prices[symbol], sparkline: sparklineCache[symbol] || prices[symbol].sparkline || [] };
    }
  });
  res.json(result);
});

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
        { params: { start: new Date(chunk.start).toISOString(), end: new Date(chunk.end).toISOString(), granularity } }
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
    if (!candles || candles.length === 0) return res.status(404).json({ error: 'No candle data found' });

    const mode = req.query.mode || 'line';
    let chartData;
    if (mode === 'candle') {
      chartData = candles
        .map((c) => ({ time: c[0], open: c[3], high: c[2], low: c[1], close: c[4], volume: c[5] }))
        .sort((a, b) => a.time - b.time)
        .filter((item, i, arr) => i === 0 || item.time !== arr[i - 1].time);
    } else {
      chartData = candles
        .map((c) => ({ time: c[0], price: c[4] }))
        .sort((a, b) => a.time - b.time)
        .filter((item, i, arr) => i === 0 || item.time !== arr[i - 1].time);
    }
    res.json(chartData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

let fngCache = null;
let fngLastFetch = 0;

let prefetchRunning = false;

app.get('/prefetch-descriptions', async (req, res) => {
  if (prefetchRunning) return res.json({ status: 'already_running' });

  let coins = [];
  try {
    const response = await axios.get(
      `${SUPABASE_URL}/rest/v1/assets?select=symbol,name,gecko_id&gecko_id=not.is.null&description_tr=is.null`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, timeout: 10000 }
    );
    coins = response.data || [];
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }

  res.json({ status: 'started', total: coins.length });

  prefetchRunning = true;
  (async () => {
    let success = 0, failed = 0;
    for (const coin of coins) {
      try {
        const geckoResponse = await axios.get(
          `https://api.coingecko.com/api/v3/coins/${coin.gecko_id}`,
          { params: { localization: false, tickers: false, market_data: false, community_data: false, developer_data: false }, timeout: 10000 }
        );
        const englishDescription = geckoResponse.data?.description?.en || null;
        if (!englishDescription || englishDescription.length < 20) { failed++; await new Promise((r) => setTimeout(r, 3000)); continue; }

        const translatedText = await translateWithClaude(englishDescription, coin.name);
        if (!translatedText) { failed++; await new Promise((r) => setTimeout(r, 3000)); continue; }

        await axios.patch(
          `${SUPABASE_URL}/rest/v1/assets?symbol=eq.${coin.symbol}`,
          { description_tr: translatedText },
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, timeout: 5000 }
        );
        success++;
        console.log(`Prefetch: ${coin.symbol} çevrildi (${success}/${coins.length})`);
        await new Promise((r) => setTimeout(r, 4000));
      } catch (e) {
        failed++;
        const waitTime = e.response?.status === 429 ? 60000 : 4000;
        await new Promise((r) => setTimeout(r, waitTime));
      }
    }
    prefetchRunning = false;
    console.log(`Prefetch tamamlandı: ${success} başarılı, ${failed} başarısız`);
  })();
});

app.get('/fng', async (req, res) => {
  try {
    const now = Date.now();
    if (fngCache && now - fngLastFetch < 10 * 60 * 1000) return res.json(fngCache);
    const response = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5000 });
    const item = response.data.data[0];
    fngCache = { value: parseInt(item.value), classification: item.value_classification, timestamp: item.timestamp };
    fngLastFetch = now;
    res.json(fngCache);
  } catch (e) {
    if (fngCache) return res.json(fngCache);
    res.status(500).json({ error: e.message });
  }
});

initialize();
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));