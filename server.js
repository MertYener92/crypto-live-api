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
let totalMarketCap = 0;
let ws = null;
const sparklineCache = {};

// ─────────────────────────────────────────────────────────────────────────────
// ADIM 1: Binance'deki tüm USDT çiftlerini çek
// ─────────────────────────────────────────────────────────────────────────────
async function loadBinanceSymbols() {
  const response = await axios.get(
    'https://api.binance.com/api/v3/exchangeInfo',
    { timeout: 10000 }
  );

  const usdtPairs = response.data.symbols.filter(
    (s) => s.quoteAsset === 'USDT' && s.status === 'TRADING'
  );

  const symbols = usdtPairs.map((s) => s.baseAsset.toUpperCase());
  console.log(`Binance'de ${symbols.length} aktif USDT coini bulundu`);
  return symbols;
}

// ─────────────────────────────────────────────────────────────────────────────
// ADIM 2: CoinGecko'dan metadata çek (logo, marketcap, rank)
// ─────────────────────────────────────────────────────────────────────────────
async function loadCoinGeckoMetadata(binanceSymbols) {
  const symbolSet = new Set(binanceSymbols);
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

  console.log(`CoinGecko'dan ${matched} coin eslesti`);

  // Eslesmeyenler icin basit metadata
  binanceSymbols.forEach((symbol) => {
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
// ADIM 3: Binance 24s ticker — fiyat, değişim, hacim, high, low
// ─────────────────────────────────────────────────────────────────────────────
async function loadBinanceTickers() {
  try {
    const response = await axios.get(
      'https://api.binance.com/api/v3/ticker/24hr',
      { timeout: 10000 }
    );

    response.data.forEach((ticker) => {
      if (!ticker.symbol.endsWith('USDT')) return;
      const symbol = ticker.symbol.replace('USDT', '');
      if (!coinMetadata[symbol]) return;

      const price = parseFloat(ticker.lastPrice);
      const change = parseFloat(ticker.priceChangePercent);
      const dominance = totalMarketCap > 0
        ? Number(((coinMetadata[symbol].marketCap / totalMarketCap) * 100).toFixed(2))
        : 0;

      prices[symbol] = {
        rank:      coinMetadata[symbol].rank,
        symbol,
        name:      coinMetadata[symbol].name,
        marketCap: coinMetadata[symbol].marketCap,
        dominance,
        high24h:   parseFloat(ticker.highPrice),
        low24h:    parseFloat(ticker.lowPrice),
        volume24h: parseFloat(ticker.quoteVolume),
        logo:      `https://crypto-live-api.onrender.com/logo/${symbol}`,
        price,
        change:    Number(change.toFixed(2)),
        sparkline: sparklineCache[symbol] || [],
      };
    });

    console.log(`Binance ticker yuklendi: ${Object.keys(prices).length} coin`);
  } catch (e) {
    console.log('Binance Ticker Error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Binance WebSocket — canlı fiyat güncellemeleri
// ─────────────────────────────────────────────────────────────────────────────
function startWebSocket() {
  if (ws) ws.close();

  // Binance mini ticker stream — tüm USDT çiftleri
  ws = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');

  ws.on('open', () => {
    console.log('Binance WebSocket connected');
  });

  ws.on('message', (msg) => {
    try {
      const tickers = JSON.parse(msg.toString());
      if (!Array.isArray(tickers)) return;

      tickers.forEach((ticker) => {
        if (!ticker.s.endsWith('USDT')) return;
        const symbol = ticker.s.replace('USDT', '');
        if (!coinMetadata[symbol] || !prices[symbol]) return;

        const price = parseFloat(ticker.c);
        const open  = parseFloat(ticker.o);
        const change = open > 0 ? Number((((price - open) / open) * 100).toFixed(2)) : 0;

        prices[symbol] = {
          ...prices[symbol],
          price,
          change,
          high24h:   parseFloat(ticker.h),
          low24h:    parseFloat(ticker.l),
          volume24h: parseFloat(ticker.q),
          sparkline: sparklineCache[symbol] || prices[symbol].sparkline || [],
        };
      });
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
// Sparkline — Binance kline (1s, 1 saatlik mum)
// ─────────────────────────────────────────────────────────────────────────────
async function loadSparklines() {
  const promises = orderedSymbols.map(async (symbol) => {
    try {
      const response = await axios.get(
        'https://api.binance.com/api/v3/klines',
        {
          params: {
            symbol: `${symbol}USDT`,
            interval: '1h',
            limit: 24,
          },
          timeout: 5000,
        }
      );
      if (response.data && response.data.length > 0) {
        sparklineCache[symbol] = response.data.map((c) => parseFloat(c[4]));
        if (prices[symbol]) prices[symbol].sparkline = sparklineCache[symbol];
      }
    } catch (_) {}
  });

  await Promise.allSettled(promises);
  console.log('Sparklines loaded from Binance');
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
// Metadata yenile (6 saatte bir)
// ─────────────────────────────────────────────────────────────────────────────
async function refreshMetadata() {
  try {
    for (let page = 1; page <= 4; page++) {
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
          if (coinMetadata[symbol]) {
            coinMetadata[symbol].marketCap = Number(coin.market_cap || 0);
            coinMetadata[symbol].rank = coin.market_cap_rank || coinMetadata[symbol].rank;
            if (coin.image) coinMetadata[symbol].logo = coin.image;
          }
        });
      } catch (_) {}
      if (page < 4) await new Promise((r) => setTimeout(r, 15000));
    }
    console.log('Metadata refreshed');
  } catch (e) {
    console.log('Metadata Refresh Error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ana başlatma
// ─────────────────────────────────────────────────────────────────────────────
async function initialize() {
  try {
    // 1. Binance sembollerini al
    const binanceSymbols = await loadBinanceSymbols();
    orderedSymbols = binanceSymbols;

    // 2. Binance 24s ticker ile fiyatları başlat
    await loadGlobalStats();
    await loadBinanceTickers();

    // 3. Sırala: market cap rank'e göre (önce bilinen coinler)
    orderedSymbols.sort((a, b) => {
      const ra = coinMetadata[a]?.rank || 9999;
      const rb = coinMetadata[b]?.rank || 9999;
      return ra - rb;
    });

    // 4. WebSocket başlat
    startWebSocket();

    // 5. CoinGecko metadata — 15sn sonra başla (rate limit önlemi)
    setTimeout(async () => {
      await loadCoinGeckoMetadata(binanceSymbols);
      // Metadata geldikten sonra tekrar sırala
      orderedSymbols.sort((a, b) => {
        const ra = coinMetadata[a]?.rank || 9999;
        const rb = coinMetadata[b]?.rank || 9999;
        return ra - rb;
      });
      console.log(`Toplam ${orderedSymbols.length} coin hazir`);
    }, 15000);

    // 6. Sparkline 60sn sonra yükle
    setTimeout(() => {
      loadSparklines();
      setInterval(() => loadSparklines(), 1800000);
    }, 60000);

    // 7. Periyodik yenileme
    setInterval(() => loadBinanceTickers(), 60000);
    setInterval(() => loadGlobalStats(), 300000);
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

    const response = await axios.get(logoUrl, {
      responseType: 'arraybuffer',
      timeout: 8000,
    });

    const contentType = response.headers['content-type'] || 'image/png';
    logoCache[symbol] = { data: response.data, contentType };

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
// GET /chart/:symbol?period=1D|1M|3M|6M|1Y|5Y
// ─────────────────────────────────────────────────────────────────────────────
function getChartConfig(period) {
  switch (period) {
    case '1D': return { interval: '1h',  limit: 24  };
    case '1M': return { interval: '1d',  limit: 30  };
    case '3M': return { interval: '1d',  limit: 90  };
    case '6M': return { interval: '1d',  limit: 180 };
    case '1Y': return { interval: '1w',  limit: 52  };
    case '5Y': return { interval: '1M',  limit: 60  };
    default:   return { interval: '1h',  limit: 24  };
  }
}

app.get('/chart/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const period = req.query.period || '1D';
    const config = getChartConfig(period);

    const response = await axios.get(
      'https://api.binance.com/api/v3/klines',
      {
        params: {
          symbol: `${symbol}USDT`,
          interval: config.interval,
          limit: config.limit,
        },
        timeout: 10000,
      }
    );

    if (!response.data || response.data.length === 0) {
      return res.status(404).json({ error: 'No candle data found' });
    }

    const chartData = response.data.map((c) => ({
      time: Math.floor(c[0] / 1000),
      price: parseFloat(c[4]),
    }));

    res.json(chartData);
  } catch (e) {
    console.log('Chart Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /fng
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
initialize();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});