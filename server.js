const express = require('express');
const WebSocket = require('ws').WebSocket;
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;

let prices = {};
let orderedSymbols = [];
let coinMetadata = {};
let coinStats = {};
let totalMarketCap = 0;
let ws = null;
const sparklineCache = {};

// ─────────────────────────────────────────────────────────────────────────────
// ADIM 1: Coinbase aktif USD coinleri
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
// ADIM 2: CoinGecko metadata (logo, rank, marketcap)
// ─────────────────────────────────────────────────────────────────────────────
async function loadCoinGeckoMetadata(symbols) {
  const symbolSet = new Set(symbols);
  let matched = 0;

  for (let page = 1; page <= 4; page++) {
    let success = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
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
          if (symbolSet.has(symbol) && !coinMetadata[symbol]) {
            coinMetadata[symbol] = {
              rank: coin.market_cap_rank || 9999,
              symbol,
              name: coin.name,
              marketCap: Number(coin.market_cap || 0),
              logo: coin.image || '',
              geckoId: coin.id,
            };
            matched++;
          }
        });
        console.log(`CoinGecko sayfa ${page} yuklendi`);
        success = true;
        break;
      } catch (e) {
        const wait = attempt * 30000;
        console.log(`CoinGecko sayfa ${page} hata (deneme ${attempt}), ${wait / 1000}sn bekleniyor...`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (!success) console.log(`CoinGecko sayfa ${page} atlandi`);
    if (page < 4) await new Promise((r) => setTimeout(r, 15000));
  }

  console.log(`CoinGecko: ${matched} coin eslesti`);

  // Eslesmeyenler icin basit metadata
  symbols.forEach((symbol) => {
    if (!coinMetadata[symbol]) {
      coinMetadata[symbol] = {
        rank: 9999,
        symbol,
        name: symbol,
        marketCap: 0,
        logo: '',
        geckoId: '',
      };
    }
  });

  // Sabit logolar
  const staticLogos = {
    BTC:  'https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png',
    ETH:  'https://coin-images.coingecko.com/coins/images/279/large/ethereum.png',
    USDT: 'https://coin-images.coingecko.com/coins/images/325/large/Tether.png',
    BNB:  'https://coin-images.coingecko.com/coins/images/825/large/bnb-icon2_2x.png',
    SOL:  'https://coin-images.coingecko.com/coins/images/4128/large/solana.png',
    XRP:  'https://coin-images.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png',
    USDC: 'https://coin-images.coingecko.com/coins/images/6319/large/usdc.png',
    DOGE: 'https://coin-images.coingecko.com/coins/images/5/large/dogecoin.png',
    ADA:  'https://coin-images.coingecko.com/coins/images/975/large/cardano.png',
    AVAX: 'https://coin-images.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedWhite_Trans.png',
    LINK: 'https://coin-images.coingecko.com/coins/images/877/large/chainlink-new-logo.png',
    DOT:  'https://coin-images.coingecko.com/coins/images/12171/large/polkadot.png',
    LTC:  'https://coin-images.coingecko.com/coins/images/2/large/litecoin.png',
    UNI:  'https://coin-images.coingecko.com/coins/images/12504/large/uni.jpg',
    ATOM: 'https://coin-images.coingecko.com/coins/images/1481/large/cosmos_hub.png',
    XLM:  'https://coin-images.coingecko.com/coins/images/100/large/Stellar_symbol_black_RGB.png',
    BCH:  'https://coin-images.coingecko.com/coins/images/780/large/bitcoin-cash-circle.png',
    ETC:  'https://coin-images.coingecko.com/coins/images/453/large/ethereum-classic-logo.png',
  };
  Object.entries(staticLogos).forEach(([symbol, url]) => {
    if (coinMetadata[symbol]) coinMetadata[symbol].logo = url;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Coinbase 24s stats (high, low, volume)
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
// Sparkline — Coinbase candles (1 saatlik, 24 mum)
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
        if (prices[symbol]) prices[symbol].sparkline = sparklineCache[symbol];
      }
    } catch (_) {}
  });
  await Promise.allSettled(promises);
  console.log('Sparklines yuklendi');
}

// ─────────────────────────────────────────────────────────────────────────────
// CoinLore — Global market cap
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
// Coinbase WebSocket — canlı fiyatlar
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

      const symbol = data.product_id.replace('-USD', '');
      const price  = parseFloat(data.price);
      const open   = parseFloat(data.open_24h);
      const change = open > 0 ? Number((((price - open) / open) * 100).toFixed(2)) : 0;
      const meta   = coinMetadata[symbol] || { rank: 9999, name: symbol, marketCap: 0, geckoId: '' };
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
// Metadata yenile (6 saatte bir)
// ─────────────────────────────────────────────────────────────────────────────
async function refreshMetadata() {
  for (let page = 1; page <= 4; page++) {
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
        if (coinMetadata[symbol]) {
          coinMetadata[symbol].marketCap = Number(coin.market_cap || 0);
          coinMetadata[symbol].rank = coin.market_cap_rank || coinMetadata[symbol].rank;
          if (coin.image) coinMetadata[symbol].logo = coin.image;
        }
      });
    } catch (_) {}
    if (page < 4) await new Promise((r) => setTimeout(r, 15000));
  }
  console.log('Metadata yenilendi');
}

// ─────────────────────────────────────────────────────────────────────────────
// Ana başlatma
// ─────────────────────────────────────────────────────────────────────────────
async function initialize() {
  try {
    // 1. Coinbase sembollerini al
    const symbols = await loadCoinbaseSymbols();
    orderedSymbols = symbols;

    // 2. Global stats + WebSocket hemen başlat
    await loadGlobalStats();
    startWebSocket();

    // 3. Stats arka planda yükle
    loadCoinStats();

    // 4. CoinGecko metadata — 15sn bekle (rate limit)
    setTimeout(async () => {
      await loadCoinGeckoMetadata(symbols);
      // Rank'e göre sırala
      orderedSymbols.sort((a, b) => {
        return (coinMetadata[a]?.rank || 9999) - (coinMetadata[b]?.rank || 9999);
      });
      console.log(`Toplam ${orderedSymbols.length} coin hazir`);
    }, 15000);

    // 5. Sparkline 60sn sonra
    setTimeout(() => {
      loadSparklines();
      setInterval(() => loadSparklines(), 1800000);
    }, 60000);

    // 6. Periyodik yenilemeler
    setInterval(() => loadCoinStats(),    300000);
    setInterval(() => loadGlobalStats(),  300000);
    setInterval(() => refreshMetadata(), 21600000);

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
// GET /chart/:symbol?period=1D|1M|3M|6M|1Y|5Y
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
// Başlat
// ─────────────────────────────────────────────────────────────────────────────
initialize();

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));