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
  // Gümüş
  xagusd: 0,
  gramSilverTry: 0,
  silverChange: 0,
  silverHigh24h: 0,
  silverLow24h: 0,
  // TL bazlı high/low
  high24hTry: 0,
  low24hTry: 0,
};

// TCMB'den USD/TRY kuru çek
// TCMB'den USD/TRY kuru çek (fallback)
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

// Sarrafiye verisi
let sarrafiyeData = {};

// Truncgil v3'ten tüm altın + gümüş verisi çek (dakika bazlı güncelleniyor)
async function fetchXauUsd() {
  try {
    const response = await axios.get(
      'https://finans.truncgil.com/v3/today.json',
      { timeout: 10000 }
    );
    const data = response.data;

    const parsePrice = (val) => {
      if (!val) return 0;
      return parseFloat(String(val).replace(/\./g, '').replace(',', '.').replace('$', '').trim()) || 0;
    };

    const parseChange = (val) => {
      if (!val) return 0;
      return parseFloat(String(val).replace('%', '').replace(',', '.').trim()) || 0;
    };

    // Gram altın
    const gramSell = parsePrice(data['gram-altin']?.Selling);
    const gramBuy  = parsePrice(data['gram-altin']?.Buying);
    const gramChange = parseChange(data['gram-altin']?.Change);
    if (gramSell > 0) {
      goldData.gramTry   = gramSell;
      goldData.change    = gramChange;
      goldData.high24hTry = Math.max(goldData.high24hTry || gramSell, gramSell);
      goldData.low24hTry  = goldData.low24hTry > 0 ? Math.min(goldData.low24hTry, gramSell) : gramSell;
      goldData.updatedAt  = new Date().toISOString();
      // ONS USD hesapla
      const onsSell = parsePrice(data['ons']?.Selling);
      if (onsSell > 0) goldData.xauusd = onsSell;
      // USDTRY hesapla
      if (goldData.xauusd > 0) {
        goldData.usdtry = Number(((gramSell * 31.1035) / goldData.xauusd).toFixed(4));
      }
      console.log('Altin (Truncgil v3): ' + gramSell + ' TL/gram | Degisim: ' + gramChange + '%');
    }

    // Gümüş
    const gumusSell   = parsePrice(data['gumus']?.Selling);
    const gumusChange = parseChange(data['gumus']?.Change);
    if (gumusSell > 0) {
      const prevSilver = goldData.gramSilverTry > 0 ? goldData.gramSilverTry : gumusSell;
      goldData.gramSilverTry = gumusSell;
      goldData.silverChange  = gumusChange;
      console.log('Gumus (Truncgil v3): ' + gumusSell + ' TL/gram | Degisim: ' + gumusChange + '%');
    }

    // Sarrafiye
    const sarrafiyeKeys = {
      'ceyrek-altin':      'CEYREK_YENI',
      'yarim-altin':       'YARIM_YENI',
      'tam-altin':         'TEK_YENI',
      'cumhuriyet-altini': 'CUM_ALTIN',
      'ata-altin':         'ATA_ALTIN',
      'resat-altin':       'RESAT_ALTIN',
      'gram-platin':       'PLATIN',
      'gram-paladyum':     'PALADYUM',
    };

    Object.entries(sarrafiyeKeys).forEach(([key, symbol]) => {
      const sell   = parsePrice(data[key]?.Selling);
      const buy    = parsePrice(data[key]?.Buying);
      const change = parseChange(data[key]?.Change);
      if (sell > 0) {
        sarrafiyeData[symbol] = { symbol, price: sell, bid: buy, change };
      }
    });

    console.log('Sarrafiye (Truncgil v3): Ceyrek=' + (sarrafiyeData.CEYREK_YENI?.price || 0) + ' Tam=' + (sarrafiyeData.TEK_YENI?.price || 0));

  } catch (e) {
    console.log('Truncgil v3 hata:', e.message, '— goldpricez fallback...');
    // Fallback: goldpricez.com
    try {
      const response = await axios.get(
        'https://goldpricez.com/api/rates/currency/usd/measure/all',
        { timeout: 10000, headers: { 'X-API-KEY': GOLD_API_KEY } }
      );
      let data = response.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch(_) {} }
      const xauusd = parseFloat(String(data.ounce_price_usd || '0').replace(/,/g, ''));
      if (xauusd > 0 && goldData.usdtry > 0) {
        goldData.xauusd  = xauusd;
        goldData.gramTry = Number(((xauusd * goldData.usdtry) / 31.1035).toFixed(2));
        goldData.updatedAt = new Date().toISOString();
        console.log('Altin (goldpricez fallback): $' + xauusd + ' | ' + goldData.gramTry + ' TL/gram');
      }
    } catch (e2) {
      console.log('goldpricez fallback hata:', e2.message);
    }
  }
}

// Altın geçmiş veri cache — periyot bazlı
// { '1D': [{time, price}], '1M': [...], ... }
const goldHistoryCache = {};
const silverHistoryCache = {};
const platinHistoryCache = {};
const paladyumHistoryCache = {};
let goldIntraday    = [];
let silverIntraday  = [];
let platinIntraday  = [];
let paladyumIntraday = [];

// Yahoo Finance'den altın + USDTRY geçmiş veri çek
async function fetchYahooData(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
  });
  const result = response.data?.chart?.result?.[0];
  if (!result) return [];
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  return timestamps
    .map((t, i) => ({ time: t, price: closes[i] }))
    .filter(item => item.price && !isNaN(item.price) && item.price > 0)
    .sort((a, b) => a.time - b.time);
}

// İki diziyi zaman damgasına göre eşleştir
function mergeByTime(goldData, usdtryData) {
  if (usdtryData.length === 0) return goldData;
  // USDTRY verisini map'e al (timestamp → rate)
  const usdtryMap = {};
  usdtryData.forEach(item => { usdtryMap[item.time] = item.price; });

  return goldData.map(item => {
    // En yakın USDTRY verisini bul
    let closestRate = goldData.usdtry || 45.99; // fallback
    let minDiff = Infinity;
    usdtryData.forEach(u => {
      const diff = Math.abs(u.time - item.time);
      if (diff < minDiff) { minDiff = diff; closestRate = u.price; }
    });
    return {
      time: item.time,
      priceUsd: item.price,
      usdtry: closestRate,
      price: Number(((item.price * closestRate) / 31.1035).toFixed(2)),
    };
  });
}

async function fetchGoldHistory() {
  const configs = [
    { period: '1M', range: '1mo',  interval: '1h'  },
    { period: '3M', range: '3mo',  interval: '1d'  },
    { period: '6M', range: '6mo',  interval: '1d'  },
    { period: '1Y', range: '1y',   interval: '1d'  },
    { period: '5Y', range: '5y',   interval: '1wk' },
  ];

  for (const cfg of configs) {
    try {
      // Altın USD verisi
      const goldRaw = await fetchYahooData('GC=F', cfg.range, cfg.interval);
      await new Promise(r => setTimeout(r, 1000));

      // USDTRY geçmiş verisi
      const usdtryData = await fetchYahooData('USDTRY=X', cfg.range, cfg.interval);
      await new Promise(r => setTimeout(r, 1000));

      if (goldRaw.length > 0) {
        const merged = mergeByTime(goldRaw, usdtryData);
        goldHistoryCache[cfg.period] = merged;
        console.log(`Altin gecmis ${cfg.period}: ${merged.length} kayit (USDTRY entegre)`);
      }

      // Gümüş USD verisi (SI=F)
      const silverRaw = await fetchYahooData('SI=F', cfg.range, cfg.interval);
      await new Promise(r => setTimeout(r, 1000));

      if (silverRaw.length > 0) {
        const silverMerged = mergeByTime(silverRaw, usdtryData).map(h => ({
          time:  h.time,
          price: Number(((h.priceUsd || h.price) * (h.usdtry || goldData.usdtry) / 31.1035).toFixed(4)),
        }));
        silverHistoryCache[cfg.period] = silverMerged;
        console.log(`Gumus gecmis ${cfg.period}: ${silverMerged.length} kayit`);
      }

      // Platin (PL=F)
      try {
        const platinRaw = await fetchYahooData('PL=F', cfg.range, cfg.interval);
        await new Promise(r => setTimeout(r, 1000));
        if (platinRaw.length > 0) {
          const platinMerged = mergeByTime(platinRaw, usdtryData).map(h => ({
            time:  h.time,
            price: Number(((h.priceUsd || h.price) * (h.usdtry || goldData.usdtry) / 31.1035).toFixed(2)),
          }));
          platinHistoryCache[cfg.period] = platinMerged;
          console.log(`Platin gecmis ${cfg.period}: ${platinMerged.length} kayit`);
        }
      } catch(e) { console.log(`Platin gecmis ${cfg.period} hata:`, e.message); }

      // Paladyum (PA=F)
      try {
        const paladyumRaw = await fetchYahooData('PA=F', cfg.range, cfg.interval);
        await new Promise(r => setTimeout(r, 1000));
        if (paladyumRaw.length > 0) {
          const paladyumMerged = mergeByTime(paladyumRaw, usdtryData).map(h => ({
            time:  h.time,
            price: Number(((h.priceUsd || h.price) * (h.usdtry || goldData.usdtry) / 31.1035).toFixed(2)),
          }));
          paladyumHistoryCache[cfg.period] = paladyumMerged;
          console.log(`Paladyum gecmis ${cfg.period}: ${paladyumMerged.length} kayit`);
        }
      } catch(e) { console.log(`Paladyum gecmis ${cfg.period} hata:`, e.message); }
    } catch (e) {
      console.log(`Gecmis veri ${cfg.period} hata:`, e.message);
    }
  }
}

// 1G için intraday veriyi biriktir (5dk'da bir çağrılır)
function appendGoldHistory() {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 24 * 60 * 60;

  // Gram altın
  if (goldData.gramTry > 0) {
    goldIntraday.push({ time: now, price: goldData.gramTry });
    goldIntraday = goldIntraday.filter(h => h.time >= cutoff);
  }

  // Gümüş
  if (goldData.gramSilverTry > 0) {
    silverIntraday.push({ time: now, price: goldData.gramSilverTry });
    silverIntraday = silverIntraday.filter(h => h.time >= cutoff);
  }

  // Platin
  if (sarrafiyeData.PLATIN?.price > 0) {
    platinIntraday.push({ time: now, price: sarrafiyeData.PLATIN.price });
    platinIntraday = platinIntraday.filter(h => h.time >= cutoff);
  }

  // Paladyum
  if (sarrafiyeData.PALADYUM?.price > 0) {
    paladyumIntraday.push({ time: now, price: sarrafiyeData.PALADYUM.price });
    paladyumIntraday = paladyumIntraday.filter(h => h.time >= cutoff);
  }
}

// Periyoda göre history döndür
function getGoldHistory(period) {
  if (period === '1D') {
    // 1G: birikmiş intraday veri
    if (goldIntraday.length > 0) return goldIntraday;
    // Yoksa son 24 saatlik dummy (başlangıç için)
    if (goldData.xauusd > 0) {
      const now = Math.floor(Date.now() / 1000);
      return Array.from({ length: 12 }, (_, i) => ({
        time: now - (11 - i) * 1800,
        price: goldData.xauusd,
      }));
    }
    return [];
  }
  return goldHistoryCache[period] || [];
}


// Tum altin/gumus verilerini guncelle (Truncgil v3 tek kaynak)
async function updateGoldData() {
  await fetchXauUsd();
}

// Sarrafiye katsayıları (gram altın bazlı chart hesabı için)
const GOLD_MULTIPLIERS = {
  CEYREK_YENI: 1.75,
  YARIM_YENI:  3.50,
  TEK_YENI:    7.00,
  CUM_ALTIN:   7.20,
  ATA_ALTIN:   7.20,
  RESAT_ALTIN: 7.20,
};

// GET /gold-prices — anlık altın fiyatı
app.get('/gold-prices', (req, res) => {
  const gramTry = goldData.gramTry;

  // Sarrafiye fiyatları: Truncgil varsa onu kullan, yoksa katsayıyla hesapla
  const getCeyrek = () => sarrafiyeData.CEYREK_YENI?.price || Number((gramTry * 1.75).toFixed(2));
  const getYarim  = () => sarrafiyeData.YARIM_YENI?.price  || Number((gramTry * 3.50).toFixed(2));
  const getTam    = () => sarrafiyeData.TEK_YENI?.price    || Number((gramTry * 7.00).toFixed(2));

  res.json({
    ALTIN: {
      symbol:    'ALTIN',
      name:      'Gram Altın',
      price:     gramTry,
      priceUsd:  goldData.xauusd,
      usdtry:    goldData.usdtry,
      change:    goldData.change,
      high24h:   goldData.high24hTry || gramTry,
      low24h:    goldData.low24hTry  || gramTry,
      updatedAt: goldData.updatedAt,
      sparkline: goldIntraday.slice(-24).map(h => h.price || gramTry),
    },
    XAUUSD: {
      symbol:    'XAUUSD',
      name:      'Ons Altın',
      price:     goldData.xauusd,
      change:    goldData.change,
      high24h:   goldData.xauusd,
      low24h:    goldData.xauusd,
      updatedAt: goldData.updatedAt,
      sparkline: goldIntraday.slice(-24).map(h =>
        h.price && goldData.usdtry > 0
          ? Number(((h.price * 31.1035) / goldData.usdtry).toFixed(2))
          : goldData.xauusd
      ),
    },
    CEYREK_YENI: {
      symbol:    'CEYREK_YENI',
      name:      'Çeyrek Altın',
      price:     getCeyrek(),
      change:    goldData.change,
      high24h:   Number((goldData.high24h ? (goldData.high24h * goldData.usdtry / 31.1035) * 1.75 : 0).toFixed(2)),
      low24h:    Number((goldData.low24h  ? (goldData.low24h  * goldData.usdtry / 31.1035) * 1.75 : 0).toFixed(2)),
      updatedAt: goldData.updatedAt,
      sparkline: goldIntraday.slice(-24).map((h) =>
        Number(((h.price * goldData.usdtry) / 31.1035 * 1.75).toFixed(2))
      ),
    },
    YARIM_YENI: {
      symbol:    'YARIM_YENI',
      name:      'Yarım Altın',
      price:     getYarim(),
      change:    goldData.change,
      high24h:   Number((goldData.high24h ? (goldData.high24h * goldData.usdtry / 31.1035) * 3.5 : 0).toFixed(2)),
      low24h:    Number((goldData.low24h  ? (goldData.low24h  * goldData.usdtry / 31.1035) * 3.5 : 0).toFixed(2)),
      updatedAt: goldData.updatedAt,
      sparkline: goldIntraday.slice(-24).map((h) =>
        Number(((h.price * goldData.usdtry) / 31.1035 * 3.5).toFixed(2))
      ),
    },
    TEK_YENI: {
      symbol:    'TEK_YENI',
      name:      'Tam Altın',
      price:     getTam(),
      change:    goldData.change,
      high24h:   Number((goldData.high24h ? (goldData.high24h * goldData.usdtry / 31.1035) * 7 : 0).toFixed(2)),
      low24h:    Number((goldData.low24h  ? (goldData.low24h  * goldData.usdtry / 31.1035) * 7 : 0).toFixed(2)),
      updatedAt: goldData.updatedAt,
      sparkline: goldIntraday.slice(-24).map((h) =>
        Number(((h.price * goldData.usdtry) / 31.1035 * 7).toFixed(2))
      ),
    },
    CUM_ALTIN: {
      symbol:    'CUM_ALTIN',
      name:      'Cumhuriyet Altını',
      price:     sarrafiyeData.CUM_ALTIN?.price || Number((gramTry * 7.2).toFixed(2)),
      change:    goldData.change,
      high24h:   0,
      low24h:    0,
      updatedAt: goldData.updatedAt,
      sparkline: goldIntraday.slice(-24).map((h) =>
        Number(((h.price * goldData.usdtry) / 31.1035 * 7.2).toFixed(2))
      ),
    },
    ATA_ALTIN: {
      symbol:    'ATA_ALTIN',
      name:      'Ata Altın',
      price:     sarrafiyeData.ATA_ALTIN?.price || Number((gramTry * 7.2).toFixed(2)),
      change:    goldData.change,
      high24h:   0,
      low24h:    0,
      updatedAt: goldData.updatedAt,
      sparkline: goldIntraday.slice(-24).map((h) =>
        Number(((h.price * goldData.usdtry) / 31.1035 * 7.2).toFixed(2))
      ),
    },
    RESAT_ALTIN: {
      symbol:    'RESAT_ALTIN',
      name:      'Reşat Altın',
      price:     sarrafiyeData.RESAT_ALTIN?.price || Number((gramTry * 7.2).toFixed(2)),
      change:    goldData.change,
      high24h:   0,
      low24h:    0,
      updatedAt: goldData.updatedAt,
      sparkline: goldIntraday.slice(-24).map((h) =>
        Number(((h.price * goldData.usdtry) / 31.1035 * 7.2).toFixed(2))
      ),
    },
    GUMUS: {
      symbol:    'GUMUS',
      name:      'Gram Gümüş',
      price:     sarrafiyeData.GUMUS?.price || goldData.gramSilverTry,
      change:    goldData.silverChange,
      high24h:   0,
      low24h:    0,
      updatedAt: goldData.updatedAt,
      sparkline: goldIntraday.slice(-24).map((h) => {
        const ratio = goldData.xauusd > 0 && sarrafiyeData.GUMUS?.price > 0
          ? sarrafiyeData.GUMUS.price / goldData.gramTry
          : 0.028;
        return Number(((h.price * goldData.usdtry) / 31.1035 * ratio).toFixed(4));
      }),
    },
    PLATIN: {
      symbol:    'PLATIN',
      name:      'Gram Platin',
      price:     sarrafiyeData.PLATIN?.price || 0,
      change:    sarrafiyeData.PLATIN?.change || 0,
      high24h:   0,
      low24h:    0,
      updatedAt: goldData.updatedAt,
      sparkline: platinIntraday.slice(-24).map(h => h.price),
    },
    PALADYUM: {
      symbol:    'PALADYUM',
      name:      'Gram Paladyum',
      price:     sarrafiyeData.PALADYUM?.price || 0,
      change:    sarrafiyeData.PALADYUM?.change || 0,
      high24h:   0,
      low24h:    0,
      updatedAt: goldData.updatedAt,
      sparkline: paladyumIntraday.slice(-24).map(h => h.price),
    },
  });
});

// GET /chart/gold/:symbol — altın chart verisi
app.get('/chart/gold/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const backendPeriod = req.query.period || '1D';

  // Flutter'dan gelen periyot map: 1D→1D, 1M→1M, 3M→3M, 6M→6M, 1Y→1Y, 5Y→5Y
  const history = getGoldHistory(backendPeriod);

  if (history.length === 0) {
    // Veri yok — 1D için mevcut fiyatla tek nokta döndür
    if (goldData.xauusd > 0 && goldData.usdtry > 0) {
      const now = Math.floor(Date.now() / 1000);
      const gramTry = Number(((goldData.xauusd * goldData.usdtry) / 31.1035).toFixed(2));
      return res.json([
        { time: now - 3600, price: gramTry },
        { time: now,        price: gramTry },
      ]);
    }
    return res.status(404).json({ error: 'Veri henüz yuklenmedi' });
  }

  const multiplier = GOLD_MULTIPLIERS[symbol] || 1.0;
  const isTry = symbol !== 'XAUUSD';

  // Platin chart
  if (symbol === 'PLATIN') {
    const history = platinHistoryCache[backendPeriod] || [];
    if (history.length === 0) {
      const now = Math.floor(Date.now() / 1000);
      const price = sarrafiyeData.PLATIN?.price || 0;
      return res.json(price > 0 ? [{ time: now - 3600, price }, { time: now, price }] : []);
    }
    const data = [...history];
    if (data.length > 0 && sarrafiyeData.PLATIN?.price > 0) {
      data[data.length - 1] = { time: Math.floor(Date.now() / 1000), price: sarrafiyeData.PLATIN.price };
    }
    return res.json(data);
  }

  // Paladyum chart
  if (symbol === 'PALADYUM') {
    const history = paladyumHistoryCache[backendPeriod] || [];
    if (history.length === 0) {
      const now = Math.floor(Date.now() / 1000);
      const price = sarrafiyeData.PALADYUM?.price || 0;
      return res.json(price > 0 ? [{ time: now - 3600, price }, { time: now, price }] : []);
    }
    const data = [...history];
    if (data.length > 0 && sarrafiyeData.PALADYUM?.price > 0) {
      data[data.length - 1] = { time: Math.floor(Date.now() / 1000), price: sarrafiyeData.PALADYUM.price };
    }
    return res.json(data);
  }

  // Gümüş chart — silverHistoryCache kullan
  if (symbol === 'GUMUS') {
    const silverHistory = silverHistoryCache[backendPeriod] || [];
    if (silverHistory.length === 0 && goldData.gramSilverTry > 0) {
      const now = Math.floor(Date.now() / 1000);
      return res.json([
        { time: now - 3600, price: goldData.gramSilverTry },
        { time: now,        price: goldData.gramSilverTry },
      ]);
    }
    const silverData = [...silverHistory];
    if (silverData.length > 0 && goldData.gramSilverTry > 0) {
      silverData[silverData.length - 1] = {
        time:  Math.floor(Date.now() / 1000),
        price: goldData.gramSilverTry,
      };
    }
    return res.json(silverData);
  }

  const data = history.map(h => {
    if (symbol === 'XAUUSD') {
      return { time: h.time, price: Number((h.priceUsd || h.price).toFixed(2)) };
    }
    const usdtry = h.usdtry || goldData.usdtry;
    const usdPrice = h.priceUsd || h.price;
    return {
      time:  h.time,
      price: Number(((usdPrice * usdtry) / 31.1035 * multiplier).toFixed(2)),
    };
  });

  // Son noktayı anlık fiyatla override et
  if (data.length > 0 && goldData.gramTry > 0) {
    const now = Math.floor(Date.now() / 1000);
    let lastPrice = goldData.gramTry * multiplier;
    if (symbol === 'XAUUSD') lastPrice = goldData.xauusd;
    if (symbol === 'GUMUS') lastPrice = goldData.gramSilverTry;
    data[data.length - 1] = { time: now, price: Number(lastPrice.toFixed(2)) };
  }

  res.json(data);
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
    appendGoldHistory(); // İlk noktayı ekle

    // Geçmiş veriyi arka planda yükle
    fetchGoldHistory().then(() => {
      console.log('Altin gecmis veri tamamlandi');
    });

    // 2 dakikada bir altın fiyatını güncelle (Truncgil dakika bazlı)
    setInterval(async () => {
      await updateGoldData();
      appendGoldHistory();
    }, 2 * 60 * 1000);

    // Geçmiş veriyi saatte bir güncelle
    setInterval(() => fetchGoldHistory(), 60 * 60 * 1000);



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

// Altın sembolleri — Coinbase'de yok
const GOLD_SYMBOLS = new Set([
  'ALTIN','XAUUSD','CEYREK_YENI','YARIM_YENI','TEK_YENI',
  'CUM_ALTIN','ATA_ALTIN','RESAT_ALTIN','GUMUS'
]);

app.get('/chart/:symbol', async (req, res) => {
  try {
    const symbol  = req.params.symbol.toUpperCase();

    // Altın sembolü ise /chart/gold/ endpoint'ini kullan
    if (GOLD_SYMBOLS.has(symbol)) {
      return res.redirect(`/chart/gold/${symbol}?${new URLSearchParams(req.query).toString()}`);
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// BES FONLARI — TEFAS
// ─────────────────────────────────────────────────────────────────────────────

// Tarih formatı: YYYY-MM-DD
function formatTefasDate(date) {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// TEFAS API - POST JSON
async function fetchTefas(endpoint, params) {
  const response = await axios.post(
    `https://www.tefas.gov.tr/api/funds/${endpoint}`,
    params,
    {
      timeout: 15000,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'tr-TR,tr;q=0.9',
        'Content-Type': 'application/json',
        'Origin': 'https://www.tefas.gov.tr',
        'Referer': 'https://www.tefas.gov.tr/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }
  );
  return response.data;
}

// GET /fund/price/:code — Fon anlık fiyat + temel bilgiler
app.get('/fund/price/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const data = await fetchTefas('fonFiyatBilgiGetir', { fonKodu: code, dil: 'TR', periyod: 1 });
    if (!data || data.faultCode) return res.status(404).json({ error: 'Fon bulunamadı', raw: data });

    console.log(`TEFAS price ${code}:`, JSON.stringify(data).slice(0, 300));

    const items = data?.resultList || data?.data || data?.fiyatlar || (Array.isArray(data) ? data : null);
    if (!items?.length) return res.status(404).json({ error: 'Fiyat yok', raw: data });

    const latest = items[items.length - 1];
    const prev   = items.length > 1 ? items[items.length - 2] : null;
    const price  = parseFloat(String(latest.fiyat || latest.FIYAT || latest.birimPayDegeri || 0).replace(',', '.'));
    const prevP  = prev ? parseFloat(String(prev.fiyat || prev.FIYAT || prev.birimPayDegeri || price).replace(',', '.')) : price;
    const change = prevP > 0 ? ((price - prevP) / prevP) * 100 : 0;

    res.json({
      code,
      name:          latest.fonUnvan || data.fonUnvani || latest.FONUNVAN || code,
      price,
      change:        Number(change.toFixed(4)),
      date:          latest.tarih || latest.TARIH || latest.date,
      totalValue:    parseFloat(String(latest.portfoyBuyuklugu || latest.PORTFOYBUYUKLUGU || 0).replace(',', '.')),
      investorCount: parseInt(latest.kisiSayisi || latest.KISISAYISI || 0),
      kategoriDerece: latest.kategoriDerece || null,
      kategoriFonSay: latest.kategoriFonSay || null,
    });
  } catch (e) {
    console.log(`/fund/price/${req.params.code} hata:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /fund/chart/:code?period=1M — Fon geçmiş fiyat serisi
app.get('/fund/chart/:code', async (req, res) => {
  try {
    const code   = req.params.code.toUpperCase();
    const period = req.query.period || '1M';
    const periyodMap = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '3Y': 36, '5Y': 60 };
    const periyod = periyodMap[period] || 1;

    const data = await fetchTefas('fonFiyatBilgiGetir', { fonKodu: code, dil: 'TR', periyod });
    if (!data || data.faultCode) return res.status(404).json({ error: 'Veri yok', raw: data });

    const items = data?.resultList || data?.data || data?.fiyatlar || (Array.isArray(data) ? data : []);
    if (!items.length) return res.status(404).json({ error: 'Fiyat yok' });

    const chartData = items.map(item => ({
      date:  item.tarih || item.TARIH || item.date,
      price: parseFloat(String(item.fiyat || item.FIYAT || item.birimPayDegeri || 0).replace(',', '.')),
    })).filter(item => item.price > 0);

    res.json(chartData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /fund/comparison/:code?periyod=12 — Fon vs rakipler getiri karşılaştırması
app.get('/fund/comparison/:code', async (req, res) => {
  try {
    const code    = req.params.code.toUpperCase();
    const periyod = req.query.periyod || '12';
    const data    = await fetchTefas('fonProfilDtyGetir', { fonKodu: code, dil: 'TR', periyod });
    if (!data || data.faultCode) return res.status(404).json({ error: 'Veri yok', raw: data });

    const items = data?.resultList || [];

    // Fonun kendi verisi
    const fund = items.find(i => i.fonKodu === code);

    // Karşılaştırma araçları (BIST100, Altın, USD, TÜFE, Mevduat)
    const labelMap = {
      'BIST100':       'BIST 100',
      'BIST30':        'BIST 30',
      'ALTIN':         'Altın',
      'USD':           'USD/TL',
      'EUR':           'EUR/TL',
      'TUFE':          'TÜFE',
      'MEVDUAT FAIZI': 'Mevduat',
    };

    const benchmarks = items
      .filter(i => i.fonKodu !== code)
      .map(i => ({
        code:   i.fonKodu,
        name:   labelMap[i.fonKodu] || i.fonUnvan || i.fonKodu,
        return: Number((i.fonTurGetiri * 100).toFixed(2)),
      }))
      .sort((a, b) => b.return - a.return);

    res.json({
      code,
      name:       fund?.fonUnvan || code,
      fundType:   fund?.fonTuru  || '',
      fundReturn: fund ? Number((fund.fonTurGetiri * 100).toFixed(2)) : null,
      period:     parseInt(periyod),
      benchmarks,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /fund/returns/:code — Getiri hesabı
app.get('/fund/returns/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    // 5 yıllık veri çek
    const data = await fetchTefas('fonFiyatBilgiGetir', { fonKodu: code, dil: 'TR', periyod: 60 });
    if (!data || data.faultCode) return res.status(404).json({ error: 'Veri yok' });

    const items = data?.resultList || data?.data || data?.fiyatlar || (Array.isArray(data) ? data : []);
    if (!items.length) return res.status(404).json({ error: 'Fiyat yok' });

    const prices = items
      .map(d => ({
        date:  new Date(d.tarih || d.TARIH || d.date),
        price: parseFloat(String(d.fiyat || d.FIYAT || d.birimPayDegeri || 0).replace(',', '.')),
      }))
      .filter(d => d.price > 0)
      .sort((a, b) => a.date - b.date);

    const current = prices[prices.length - 1].price;
    const today = new Date();

    function getReturn(months) {
      const target = new Date(today);
      target.setMonth(target.getMonth() - months);
      const found = prices.find(p => p.date >= target);
      if (!found) return null;
      return Number((((current - found.price) / found.price) * 100).toFixed(2));
    }

    res.json({
      code, currentPrice: current,
      returns: { '1M': getReturn(1), '3M': getReturn(3), '6M': getReturn(6), '1Y': getReturn(12), '3Y': getReturn(36), '5Y': getReturn(60) }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /fund/sync — Takasbank'tan fon listesi çekip Supabase'e kaydet
app.get('/fund/sync', async (req, res) => {
  res.json({ status: 'started - check logs' });

  try {
    // Takasbank Excel'den fon listesi (public)
    const response = await axios.get(
      'https://www.takasbank.com.tr/plugins/ExcelExportTefasFundsTradingInvestmentPlatform?language=tr',
      { timeout: 30000, responseType: 'arraybuffer' }
    );

    // Excel parse için xlsx paketi gerekli - olmadığı için CSV yaklaşımı dene
    console.log('Takasbank response size:', response.data.byteLength);

    // Alternatif: TEFAS getFplFonList'i farklı header ile dene
    const tefasData = await axios.post(
      'https://www.tefas.gov.tr/api/funds/getFplFonList',
      {},
      {
        timeout: 15000,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Origin': 'https://www.tefas.gov.tr',
          'Referer': 'https://www.tefas.gov.tr/BESSorgu.aspx',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
        }
      }
    );

    const items = tefasData.data?.resultList || tefasData.data?.data || (Array.isArray(tefasData.data) ? tefasData.data : []);
    console.log(`getFplFonList: ${items.length} fon`);

    if (items.length > 0) {
      console.log('Sample:', JSON.stringify(items[0]));

      let added = 0;
      for (const item of items) {
        const code = item.fonKodu || item.FONKODU;
        const name = item.fonUnvan || item.FONUNVAN || item.fonAdi || code;
        if (!code) continue;

        try {
          await axios.post(
            `${SUPABASE_URL}/rest/v1/assets`,
            {
              symbol: code,
              name,
              type: 'fund',
              provider: 'tefas',
              currency: 'TRY',
              search_keywords: `${code.toLowerCase()} ${name.toLowerCase()} bes fon emeklilik`,
              is_active: true,
            },
            {
              headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                Prefer: 'resolution=ignore-duplicates',
              },
            }
          );
          added++;
        } catch(_) {}

        await new Promise(r => setTimeout(r, 50));
      }
      console.log(`Fund sync tamamlandi: ${added} fon eklendi`);
    }
  } catch (e) {
    console.log('Fund sync hata:', e.message);
  }
});

// GET /fund/search?q=GAR — Fon arama (getFplFonList endpoint)
app.get('/fund/search', async (req, res) => {
  try {
    const q    = (req.query.q || '').toUpperCase();
    // Birkaç endpoint dene
    let data = null;
    for (const ep of ['getFplFonList', 'fonBilgiGetir', 'fonListeGetir']) {
      try {
        const r = await fetchTefas(ep, {});
        if (r && !r.faultCode) { data = r; break; }
      } catch(_) {}
    }
    if (!data) return res.status(404).json({ error: 'Search endpoint bulunamadi' });

    console.log('getFplFonList response:', JSON.stringify(data).slice(0, 300));
    const items = data?.resultList || data?.data || data?.fonList || (Array.isArray(data) ? data : []);
    if (!items.length) return res.json([]);

    const funds = items
      .filter(d => {
        if (!q) return true;
        const code = (d.fonKodu || d.FONKODU || '').toUpperCase();
        const name = (d.fonUnvan || d.FONUNVAN || d.fonAdi || '').toUpperCase();
        return code.includes(q) || name.includes(q);
      })
      .map(d => ({
        code:  d.fonKodu || d.FONKODU,
        name:  d.fonUnvan || d.FONUNVAN || d.fonAdi || d.fonKodu,
        type:  d.fonTuru || d.FONTURU || '',
      }));

    res.json(funds.slice(0, 50));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});