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
// CoinLore — Top 100 coin yükle
// ─────────────────────────────────────────────────────────────────────────────
async function loadTopCoins() {
  try {
    const response = await axios.get('https://api.coinlore.net/api/tickers/');
    const topCoins = response.data.data.slice(0, 300);
 
    orderedSymbols = [];
 
    topCoins.forEach((coin, index) => {
      const symbol = coin.symbol;
      orderedSymbols.push(symbol);
      coinMetadata[symbol] = {
        rank: index + 1,
        symbol,
        name: coin.name,
        marketCap: Number(coin.market_cap_usd),
        logo: `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${symbol.toLowerCase()}.png`,
      };
    });
 
    console.log('Top 100 coins loaded');
 
    startWebSocket();
    await loadCoinStats();
    await loadGlobalStats();
 
    // Her 5 dakikada istatistikleri yenile
    setInterval(() => loadCoinStats(), 300000);
    setInterval(() => loadGlobalStats(), 300000);
  } catch (e) {
    console.log('CoinLore Error:', e.message);
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
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        channels: [{ name: 'ticker', product_ids: productIds }],
      })
    );
  });
 
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type !== 'ticker') return;
 
      const symbol = data.product_id.replace('-USD', '');
      if (!coinMetadata[symbol]) return;
 
      const price = parseFloat(data.price);
      const open = parseFloat(data.open_24h);
      const change = open
        ? Number((((price - open) / open) * 100).toFixed(2))
        : 0;
 
      const dominance =
        totalMarketCap > 0
          ? Number(
              ((coinMetadata[symbol].marketCap / totalMarketCap) * 100).toFixed(2)
            )
          : 0;
 
      prices[symbol] = {
        rank: coinMetadata[symbol].rank,
        symbol,
        name: coinMetadata[symbol].name,
        marketCap: coinMetadata[symbol].marketCap,
        dominance,
        high24h: coinStats[symbol]?.high24h || 0,
        low24h: coinStats[symbol]?.low24h || 0,
        volume24h: coinStats[symbol]?.volume24h || 0,
        logo: coinMetadata[symbol].logo,
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
// GET /prices  — tüm canlı fiyatlar
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
//
// Flutter widget'ından gelen "period" değerleri: 1D 1M 3M 6M 1Y 5Y
//
// Coinbase Exchange /candles endpoint'i granularity olarak saniye cinsinden
// tam sayı kabul eder. İzin verilen değerler:
//   60, 300, 900, 3600, 21600, 86400
// 5Y için haftalık veri yok; 3 günlük (259200 s) mümkün değil —
// bu yüzden 5Y'yi 3 ayrı istek (300'er günlük) ile alıp birleştiriyoruz.
// ─────────────────────────────────────────────────────────────────────────────
function getChartConfig(period) {
  switch (period) {
    case '1D':  return { days: 1,    granularity: 3600  }; // 24 mum  (saatlik)
    case '1M':  return { days: 30,   granularity: 86400 }; // 30 mum  (günlük)
    case '3M':  return { days: 90,   granularity: 86400 }; // 90 mum  (günlük)
    case '6M':  return { days: 180,  granularity: 86400 }; // 180 mum (günlük)
    case '1Y':  return { days: 365,  granularity: 86400 }; // 365 mum (günlük)
    case '5Y':  return { days: 1825, granularity: 86400 }; // ~5 yıl  (günlük, parçalı istek)
    default:    return { days: 1,    granularity: 3600  };
  }
}
 
// Coinbase /candles endpoint'i tek seferde max 300 mum döndürür.
// 300'den fazla mum gereken periyotlar için istekleri böl ve birleştir.
async function fetchCandles(symbol, startMs, endMs, granularity) {
  const maxCandles = 300;
  const windowMs = granularity * maxCandles * 1000; // her isteğin kapsadığı ms
 
  const chunks = [];
  let chunkEnd = endMs;
 
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
            end: new Date(chunk.end).toISOString(),
            granularity: chunk.granularity || granularity,
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
// Yanıt: [{ time: <unix_saniye>, price: <close_fiyatı> }, ...]
// ─────────────────────────────────────────────────────────────────────────────
app.get('/chart/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
 
    // Flutter widget "period" parametresi gönderiyor (1D, 1M, 3M, 6M, 1Y, 5Y)
    // Eski "range" parametresine de geriye dönük destek ver
    const period = req.query.period || req.query.range || '1D';
 
    const config = getChartConfig(period);
 
    const endMs = Date.now();
    const startMs = endMs - config.days * 24 * 60 * 60 * 1000;
 
    const candles = await fetchCandles(symbol, startMs, endMs, config.granularity);
 
    if (!candles || candles.length === 0) {
      return res.status(404).json({ error: 'No candle data found' });
    }
 
    // Coinbase candle formatı: [time, low, high, open, close, volume]
    const chartData = candles
      .map((c) => ({
        time: c[0],      // unix saniye
        price: c[4],     // close fiyatı
      }))
      .sort((a, b) => a.time - b.time)  // eskiden yeniye sırala
      .filter(                           // olası duplikasyonları temizle
        (item, i, arr) => i === 0 || item.time !== arr[i - 1].time
      );
 
    res.json(chartData);
  } catch (e) {
    console.log('Chart Error:', e.message);
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