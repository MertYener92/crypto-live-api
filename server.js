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

// ─────────────────────────────────────────────────────────────────────────────
// CoinGecko — Top 100 coin + logolar + market cap
// ─────────────────────────────────────────────────────────────────────────────
async function loadTopCoins() {
  try {
    // 429 durumunda 60 saniye bekle ve tekrar dene
    let response;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        response = await axios.get(
          'https://api.coingecko.com/api/v3/coins/markets',
          {
            params: {
              vs_currency: 'usd',
              order: 'market_cap_desc',
              per_page: 100,
              page: 1,
              sparkline: false,
            },
            timeout: 10000,
          }
        );
        break; // Başarılıysa döngüden çık
      } catch (err) {
        if (err.response && err.response.status === 429) {
          const wait = attempt * 60000; // 1dk, 2dk, 3dk...
          console.log(`CoinGecko rate limit, ${wait/1000}s sonra tekrar deneniyor...`);
          await new Promise((r) => setTimeout(r, wait));
        } else {
          throw err;
        }
      }
    }
    if (!response) throw new Error('CoinGecko max retry aşıldı');

    orderedSymbols = [];

    response.data.forEach((coin, index) => {
      const symbol = coin.symbol.toUpperCase();
      orderedSymbols.push(symbol);
      coinMetadata[symbol] = {
        rank: index + 1,
        symbol,
        name: coin.name,
        marketCap: Number(coin.market_cap || 0),
        logo: coin.image || '',
        geckoId: coin.id,
      };
    });

    // Önemli coinler için sabit CoinGecko URL'leri — hızlı yükleme
    const staticLogos = {
      'BTC':  'https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png',
      'ETH':  'https://coin-images.coingecko.com/coins/images/279/large/ethereum.png',
      'USDT': 'https://coin-images.coingecko.com/coins/images/325/large/Tether.png',
      'BNB':  'https://coin-images.coingecko.com/coins/images/825/large/bnb-icon2_2x.png',
      'SOL':  'https://coin-images.coingecko.com/coins/images/4128/large/solana.png',
      'XRP':  'https://coin-images.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png',
      'USDC': 'https://coin-images.coingecko.com/coins/images/6319/large/usdc.png',
      'DOGE': 'https://coin-images.coingecko.com/coins/images/5/large/dogecoin.png',
      'ADA':  'https://coin-images.coingecko.com/coins/images/975/large/cardano.png',
      'TRX':  'https://coin-images.coingecko.com/coins/images/1094/large/tron-logo.png',
      'AVAX': 'https://coin-images.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedWhite_Trans.png',
      'LINK': 'https://coin-images.coingecko.com/coins/images/877/large/chainlink-new-logo.png',
      'DOT':  'https://coin-images.coingecko.com/coins/images/12171/large/polkadot.png',
      'MATIC':'https://coin-images.coingecko.com/coins/images/4713/large/matic-token-icon.png',
      'LTC':  'https://coin-images.coingecko.com/coins/images/2/large/litecoin.png',
      'UNI':  'https://coin-images.coingecko.com/coins/images/12504/large/uni.jpg',
      'ATOM': 'https://coin-images.coingecko.com/coins/images/1481/large/cosmos_hub.png',
      'XLM':  'https://coin-images.coingecko.com/coins/images/100/large/Stellar_symbol_black_RGB.png',
      'BCH':  'https://coin-images.coingecko.com/coins/images/780/large/bitcoin-cash-circle.png',
      'ETC':  'https://coin-images.coingecko.com/coins/images/453/large/ethereum-classic-logo.png',
    };
    Object.entries(staticLogos).forEach(([symbol, url]) => {
      if (coinMetadata[symbol]) {
        coinMetadata[symbol].logo = url;
      }
    });

    console.log('Top 100 coins loaded from CoinGecko');

    startWebSocket();
    await loadCoinStats();
    await loadGlobalStats();

    // Her 5 dakikada stats yenile
    setInterval(() => loadCoinStats(), 300000);
    setInterval(() => loadGlobalStats(), 300000);
    // Her 6 saatte coin listesini yenile (logo + marketcap güncellenir)
    setInterval(() => refreshCoinList(), 21600000);
  } catch (e) {
    console.log('CoinGecko Error:', e.message);
    // CoinGecko hata verirse tekrar dene
    setTimeout(() => loadTopCoins(), 10000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CoinGecko — Coin listesini yenile (6 saatte bir)
// ─────────────────────────────────────────────────────────────────────────────
async function refreshCoinList() {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/coins/markets',
      {
        params: {
          vs_currency: 'usd',
          order: 'market_cap_desc',
          per_page: 100,
          page: 1,
          sparkline: false,
        },
        timeout: 10000,
      }
    );

    response.data.forEach((coin, index) => {
      const symbol = coin.symbol.toUpperCase();
      if (coinMetadata[symbol]) {
        coinMetadata[symbol].marketCap = Number(coin.market_cap || 0);
        coinMetadata[symbol].logo = coin.image || coinMetadata[symbol].logo;
        coinMetadata[symbol].rank = index + 1;
      }
    });

    console.log('Coin list refreshed from CoinGecko');
  } catch (e) {
    console.log('CoinGecko Refresh Error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coinbase REST — 24s istatistikler (high / low / volume)
// ─────────────────────────────────────────────────────────────────────────────
async function loadCoinStats() {
  try {
    for (const symbol of orderedSymbols) {
      try {
        const response = await axios.get(
          `https://api.exchange.coinbase.com/products/${symbol}-USD/stats`
        );
        coinStats[symbol] = {
          high24h: Number(response.data.high),
          low24h: Number(response.data.low),
          volume24h: Number(response.data.volume),
        };
      } catch (_) {
        // Coinbase'de listelenmeyen coin — geç
      }
    }
    console.log('Coin stats loaded');
  } catch (e) {
    console.log('Stats Error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CoinLore — Global market cap
// ─────────────────────────────────────────────────────────────────────────────
async function loadGlobalStats() {
  try {
    const response = await axios.get('https://api.coinlore.net/api/global/');
    totalMarketCap = Number(response.data[0].total_mcap);
    console.log('Global market cap loaded');
  } catch (e) {
    console.log('Global Stats Error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coinbase WebSocket — canlı fiyatlar
// ─────────────────────────────────────────────────────────────────────────────
function startWebSocket() {
  if (ws) ws.close();

  ws = new WebSocket('wss://ws-feed.exchange.coinbase.com', {
    perMessageDeflate: false,
  });

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
      if (!coinMetadata[symbol]) return;

      const price  = parseFloat(data.price);
      const open   = parseFloat(data.open_24h);
      const change = open ? Number((((price - open) / open) * 100).toFixed(2)) : 0;
      const dominance = totalMarketCap > 0
        ? Number(((coinMetadata[symbol].marketCap / totalMarketCap) * 100).toFixed(2))
        : 0;

      prices[symbol] = {
        rank:      coinMetadata[symbol].rank,
        symbol,
        name:      coinMetadata[symbol].name,
        marketCap: coinMetadata[symbol].marketCap,
        dominance,
        high24h:   coinStats[symbol]?.high24h  || 0,
        low24h:    coinStats[symbol]?.low24h   || 0,
        volume24h: (coinStats[symbol]?.volume24h || 0) * price,
        logo:      `https://crypto-live-api.onrender.com/logo/${symbol}`,
        price,
        change,
      };
    } catch (e) {
      console.log('Parse Error:', e.message);
    }
  });

  ws.on('error', (err) => console.log('WebSocket Error:', err.message));

  ws.on('close', () => {
    console.log('WebSocket closed. Reconnecting in 3s...');
    setTimeout(() => startWebSocket(), 3000);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /logo/:symbol — CoinGecko logosunu proxy'leyerek döndür
// ─────────────────────────────────────────────────────────────────────────────
const logoCache = {};

app.get('/logo/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    // Cache'de varsa direkt döndür
    if (logoCache[symbol]) {
      res.set('Content-Type', logoCache[symbol].contentType);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(logoCache[symbol].data);
    }

    const logoUrl = coinMetadata[symbol]?.logo;
    if (!logoUrl) {
      return res.status(404).send('Logo not found');
    }

    const response = await axios.get(logoUrl, {
      responseType: 'arraybuffer',
      timeout: 8000,
    });

    const contentType = response.headers['content-type'] || 'image/png';
    logoCache[symbol] = {
      data: response.data,
      contentType,
    };

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (e) {
    console.log('Logo proxy error:', e.message);
    res.status(500).send('Logo fetch failed');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /prices
// ─────────────────────────────────────────────────────────────────────────────
app.get('/prices', (req, res) => {
  const sortedPrices = {};
  orderedSymbols.forEach((symbol) => {
    if (prices[symbol]) sortedPrices[symbol] = prices[symbol];
  });
  res.json(sortedPrices);
});

// ─────────────────────────────────────────────────────────────────────────────
// Chart periyot konfigürasyonu
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /chart/:symbol?period=1D|1M|3M|6M|1Y|5Y
// ─────────────────────────────────────────────────────────────────────────────
app.get('/chart/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const period = req.query.period || req.query.range || '1D';
    const config = getChartConfig(period);
    const endMs  = Date.now();
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
    console.log('Chart Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /fng — Korku & Açgözlülük (10 dakika cache)
// ─────────────────────────────────────────────────────────────────────────────
let fngCache     = null;
let fngLastFetch = 0;

app.get('/fng', async (req, res) => {
  try {
    const now = Date.now();
    if (fngCache && now - fngLastFetch < 10 * 60 * 1000) {
      return res.json(fngCache);
    }
    const response = await axios.get(
      'https://api.alternative.me/fng/?limit=1',
      { timeout: 5000 }
    );
    const item = response.data.data[0];
    fngCache = {
      value: parseInt(item.value),
      classification: item.value_classification,
      timestamp: item.timestamp,
    };
    fngLastFetch = now;
    res.json(fngCache);
  } catch (e) {
    console.log('FNG Error:', e.message);
    if (fngCache) return res.json(fngCache);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Başlat
// ─────────────────────────────────────────────────────────────────────────────
loadTopCoins();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});