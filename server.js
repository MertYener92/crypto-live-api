const express = require('express');
const WebSocket = require('ws').WebSocket;
const WebSocketServer = require('ws').WebSocketServer;
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = 'https://edmvkecnitzueryzylpo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkbXZrZWNuaXR6dWVyeXp5bHBvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTYwNzg5OSwiZXhwIjoyMDk1MTgzODk5fQ.HQpDHbG1N-oEyvDOJFXH5yO3tpG9s-9_meeqLOkmM3k';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GOLD_API_KEY = process.env.GOLD_API_KEY || '';
const METALS_API_KEY = process.env.METALS_API_KEY || '';

let prices = {};
let orderedSymbols = [];
let coinMetadata = {};
let coinStats = {};
let totalMarketCap = 0;
let ws = null;
const sparklineCache = {};

let goldData = {
  xauusd: 0, usdtry: 0, gramTry: 0, change: 0, high24h: 0, low24h: 0,
  updatedAt: null, xagusd: 0, gramSilverTry: 0, silverChange: 0,
  silverHigh24h: 0, silverLow24h: 0, high24hTry: 0, low24hTry: 0,
};

async function fetchUsdTry() {
  try {
    const response = await axios.get('https://www.tcmb.gov.tr/kurlar/today.xml', { timeout: 10000, responseType: 'text' });
    const match = response.data.match(/<Currency[^>]*CurrencyCode="USD"[^>]*>[\s\S]*?<ForexSelling>([\d.]+)<\/ForexSelling>/);
    if (match) {
      const rate = parseFloat(match[1].replace(',', '.'));
      if (rate > 0) { goldData.usdtry = rate; console.log(`TCMB USDTRY: ${rate}`); }
    }
  } catch (e) { console.log('TCMB USDTRY hata:', e.message); }
}

let sarrafiyeData = {};

async function fetchXauUsd() {
  try {
    const response = await axios.get('https://finans.truncgil.com/v3/today.json', { timeout: 10000 });
    const data = response.data;
    const parsePrice = (val) => { if (!val) return 0; return parseFloat(String(val).replace(/\./g, '').replace(',', '.').replace('$', '').trim()) || 0; };
    const parseChange = (val) => { if (!val) return 0; return parseFloat(String(val).replace('%', '').replace(',', '.').trim()) || 0; };
    const gramSell = parsePrice(data['gram-altin']?.Selling);
    const gramChange = parseChange(data['gram-altin']?.Change);
    if (gramSell > 0) {
      goldData.gramTry = gramSell; goldData.change = gramChange;
      goldData.high24hTry = Math.max(goldData.high24hTry || gramSell, gramSell);
      goldData.low24hTry = goldData.low24hTry > 0 ? Math.min(goldData.low24hTry, gramSell) : gramSell;
      goldData.updatedAt = new Date().toISOString();
      const onsSell = parsePrice(data['ons']?.Selling);
      if (onsSell > 0) goldData.xauusd = onsSell;
      if (goldData.xauusd > 0) goldData.usdtry = Number(((gramSell * 31.1035) / goldData.xauusd).toFixed(4));
      console.log('Altin (Truncgil v3): ' + gramSell + ' TL/gram | Degisim: ' + gramChange + '%');
    }
    const gumusSell = parsePrice(data['gumus']?.Selling);
    const gumusChange = parseChange(data['gumus']?.Change);
    if (gumusSell > 0) { goldData.gramSilverTry = gumusSell; goldData.silverChange = gumusChange; console.log('Gumus (Truncgil v3): ' + gumusSell + ' TL/gram'); }
    const sarrafiyeKeys = {
      'ceyrek-altin': 'CEYREK_YENI', 'yarim-altin': 'YARIM_YENI', 'tam-altin': 'TEK_YENI',
      'cumhuriyet-altini': 'CUM_ALTIN', 'ata-altin': 'ATA_ALTIN', 'resat-altin': 'RESAT_ALTIN',
      'gram-platin': 'PLATIN', 'gram-paladyum': 'PALADYUM',
    };
    Object.entries(sarrafiyeKeys).forEach(([key, symbol]) => {
      const sell = parsePrice(data[key]?.Selling); const buy = parsePrice(data[key]?.Buying); const change = parseChange(data[key]?.Change);
      if (sell > 0) sarrafiyeData[symbol] = { symbol, price: sell, bid: buy, change };
    });
    console.log('Sarrafiye: Ceyrek=' + (sarrafiyeData.CEYREK_YENI?.price || 0) + ' Tam=' + (sarrafiyeData.TEK_YENI?.price || 0));
  } catch (e) {
    console.log('Truncgil v3 hata:', e.message, '— fallback...');
    try {
      const response = await axios.get('https://goldpricez.com/api/rates/currency/usd/measure/all', { timeout: 10000, headers: { 'X-API-KEY': GOLD_API_KEY } });
      let data = response.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch(_) {} }
      const xauusd = parseFloat(String(data.ounce_price_usd || '0').replace(/,/g, ''));
      if (xauusd > 0 && goldData.usdtry > 0) {
        goldData.xauusd = xauusd; goldData.gramTry = Number(((xauusd * goldData.usdtry) / 31.1035).toFixed(2));
        goldData.updatedAt = new Date().toISOString();
        console.log('Altin (goldpricez fallback): $' + xauusd + ' | ' + goldData.gramTry + ' TL/gram');
      }
    } catch (e2) { console.log('goldpricez fallback hata:', e2.message); }
  }
}

const goldHistoryCache = {}; const silverHistoryCache = {}; const platinHistoryCache = {}; const paladyumHistoryCache = {};
let goldIntraday = []; let silverIntraday = []; let platinIntraday = []; let paladyumIntraday = [];
const METALPRICE_API_KEY = process.env.METALPRICE_API_KEY || '';

function fmtDate(d) { return d.toISOString().split('T')[0]; }

async function fetchMetalpriceRange(symbol, startDate, endDate) {
  const response = await axios.get('https://api.metalpriceapi.com/v1/timeframe', {
    params: { api_key: METALPRICE_API_KEY, start_date: startDate, end_date: endDate, base: 'TRY', currencies: symbol },
    timeout: 20000,
  });
  if (!response.data?.success) throw new Error(`metalpriceapi (${symbol}): ${JSON.stringify(response.data?.error)}`);
  const rates = response.data.rates; const result = [];
  Object.entries(rates).sort(([a], [b]) => a.localeCompare(b)).forEach(([dateStr, vals]) => {
    const ts = Math.floor(new Date(dateStr).getTime() / 1000); const rate = vals[symbol];
    if (rate && rate > 0) { const gramTry = Number((1 / rate / 31.1035).toFixed(symbol === 'XAG' ? 4 : 2)); result.push({ date: dateStr, time: ts, price: gramTry }); }
  });
  return result;
}

async function saveToSupabase(rows) {
  if (!rows.length) return;
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    try {
      await axios.post(`${SUPABASE_URL}/rest/v1/gold_price_history`, chunk, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
        timeout: 15000,
      });
      console.log(`Supabase: ${chunk.length} kayıt eklendi`);
    } catch (e) { console.log('Supabase kayıt hata:', e.response?.status, e.response?.data || e.message); }
  }
}

async function loadFromSupabase(symbol) {
  try {
    const response = await axios.get(`${SUPABASE_URL}/rest/v1/gold_price_history?select=date,price_try&symbol=eq.${symbol}&order=date.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, timeout: 10000 });
    return (response.data || []).map(row => ({ date: row.date, time: Math.floor(new Date(row.date).getTime() / 1000), price: parseFloat(row.price_try) }));
  } catch (e) { console.log(`Supabase okuma hata (${symbol}):`, e.message); return []; }
}

async function getLastSupabaseDate(symbol) {
  try {
    const response = await axios.get(`${SUPABASE_URL}/rest/v1/gold_price_history?select=date&symbol=eq.${symbol}&order=date.desc&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, timeout: 5000 });
    return response.data?.[0]?.date || null;
  } catch (e) { return null; }
}

function buildCacheFromData(data, cacheObj) {
  const now = Math.floor(Date.now() / 1000);
  [{ period: '1M', days: 30 }, { period: '3M', days: 90 }, { period: '6M', days: 180 }, { period: '1Y', days: 365 }, { period: '5Y', days: 1825 }].forEach(({ period, days }) => {
    const cutoff = now - days * 24 * 60 * 60;
    cacheObj[period] = data.filter(p => p.time >= cutoff);
  });
}

async function fetchGoldHistory() {
  const symbols = [{ api: 'XAU', cache: goldHistoryCache }, { api: 'XAG', cache: silverHistoryCache }, { api: 'XPT', cache: platinHistoryCache }, { api: 'XPD', cache: paladyumHistoryCache }];
  for (const sym of symbols) {
    try {
      const existing = await loadFromSupabase(sym.api);
      if (existing.length > 0) { buildCacheFromData(existing, sym.cache); console.log(`Supabase ${sym.api}: ${existing.length} kayıt cache'e yüklendi`); }
      const lastDate = await getLastSupabaseDate(sym.api);
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = fmtDate(yesterday);
      if (!lastDate) {
        console.log(`metalpriceapi: ${sym.api} 5 yıllık çekiliyor...`);
        const allData = []; const todayMs = new Date().setHours(0, 0, 0, 0);
        for (let i = 4; i >= 0; i--) {
          const endMs = todayMs - i * 365 * 24 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000;
          const startMs = endMs - 364 * 24 * 60 * 60 * 1000;
          const endStr = i === 0 ? fmtDate(new Date(todayMs - 24 * 60 * 60 * 1000)) : fmtDate(new Date(endMs));
          const startStr = fmtDate(new Date(startMs));
          try { const chunk = await fetchMetalpriceRange(sym.api, startStr, endStr); allData.push(...chunk); console.log(`  ${sym.api} ${startStr}→${endStr}: ${chunk.length} gün`); await new Promise(r => setTimeout(r, 1500)); } catch (e) { console.log(`  ${sym.api} chunk hata:`, e.message); }
        }
        await saveToSupabase(allData.map(d => ({ date: d.date, symbol: sym.api, price_try: d.price })));
        buildCacheFromData(allData, sym.cache);
      } else if (lastDate < yesterdayStr) {
        const startD = new Date(lastDate); startD.setDate(startD.getDate() + 1);
        const fetchStart = fmtDate(startD);
        console.log(`metalpriceapi: ${sym.api} eksik ${fetchStart}→${yesterdayStr}`);
        const newData = await fetchMetalpriceRange(sym.api, fetchStart, yesterdayStr);
        if (newData.length > 0) {
          await saveToSupabase(newData.map(d => ({ date: d.date, symbol: sym.api, price_try: d.price })));
          const all = await loadFromSupabase(sym.api); buildCacheFromData(all, sym.cache);
          console.log(`${sym.api}: ${newData.length} yeni gün eklendi`);
        }
        await new Promise(r => setTimeout(r, 1500));
      } else { console.log(`${sym.api}: güncel (${lastDate})`); }
    } catch (e) { console.log(`fetchGoldHistory ${sym.api} hata:`, e.message); }
  }
  console.log('Altın geçmiş veri tamamlandı');
}

function scheduleMidnightMetals() {
  const now = new Date(); const next = new Date(); next.setHours(0, 5, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now; console.log(`Gece güncellemesi ${Math.round(msUntil / 60000)} dk sonra`);
  setTimeout(() => { fetchGoldHistory(); setInterval(() => fetchGoldHistory(), 24 * 60 * 60 * 1000); }, msUntil);
}

async function appendGoldHistory() {
  const now = Math.floor(Date.now() / 1000); const cutoff = now - 24 * 60 * 60; const recordedAt = new Date().toISOString();
  if (goldData.gramTry > 0) {
    goldIntraday.push({ time: now, price: goldData.gramTry }); goldIntraday = goldIntraday.filter(h => h.time >= cutoff);
    try { await axios.post(`${SUPABASE_URL}/rest/v1/gold_intraday`, { symbol: 'XAU', price_try: goldData.gramTry, recorded_at: recordedAt }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, timeout: 5000 }); } catch (e) { console.log('gold_intraday kayıt hata (XAU):', e.message); }
  }
  if (goldData.gramSilverTry > 0) {
    silverIntraday.push({ time: now, price: goldData.gramSilverTry }); silverIntraday = silverIntraday.filter(h => h.time >= cutoff);
    try { await axios.post(`${SUPABASE_URL}/rest/v1/gold_intraday`, { symbol: 'XAG', price_try: goldData.gramSilverTry, recorded_at: recordedAt }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, timeout: 5000 }); } catch (e) { console.log('gold_intraday kayıt hata (XAG):', e.message); }
  }
  if (sarrafiyeData.PLATIN?.price > 0) {
    platinIntraday.push({ time: now, price: sarrafiyeData.PLATIN.price }); platinIntraday = platinIntraday.filter(h => h.time >= cutoff);
    try { await axios.post(`${SUPABASE_URL}/rest/v1/gold_intraday`, { symbol: 'XPT', price_try: sarrafiyeData.PLATIN.price, recorded_at: recordedAt }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, timeout: 5000 }); } catch (e) { console.log('gold_intraday kayıt hata (XPT):', e.message); }
  }
  if (sarrafiyeData.PALADYUM?.price > 0) {
    paladyumIntraday.push({ time: now, price: sarrafiyeData.PALADYUM.price }); paladyumIntraday = paladyumIntraday.filter(h => h.time >= cutoff);
    try { await axios.post(`${SUPABASE_URL}/rest/v1/gold_intraday`, { symbol: 'XPD', price_try: sarrafiyeData.PALADYUM.price, recorded_at: recordedAt }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, timeout: 5000 }); } catch (e) { console.log('gold_intraday kayıt hata (XPD):', e.message); }
  }
  const hour = new Date().getHours(); const minute = new Date().getMinutes();
  if (hour === 0 && minute < 4) {
    try {
      await axios.delete(`${SUPABASE_URL}/rest/v1/gold_intraday?recorded_at=lt.${new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()}`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, timeout: 5000 });
      console.log('Eski gold_intraday kayıtları temizlendi');
    } catch (e) { console.log('gold_intraday temizleme hata:', e.message); }
  }
}

function getGoldHistory(period) {
  if (period === '1D') {
    if (goldIntraday.length > 0) return goldIntraday;
    if (goldData.gramTry > 0) { const now = Math.floor(Date.now() / 1000); return Array.from({ length: 12 }, (_, i) => ({ time: now - (11 - i) * 1800, price: goldData.gramTry })); }
    return [];
  }
  return goldHistoryCache[period] || [];
}

async function updateGoldData() { await fetchXauUsd(); }

const GOLD_MULTIPLIERS = { CEYREK_YENI: 1.75, YARIM_YENI: 3.50, TEK_YENI: 7.00, CUM_ALTIN: 7.20, ATA_ALTIN: 7.20, RESAT_ALTIN: 7.20 };

app.get('/gold-prices', (req, res) => {
  const gramTry = goldData.gramTry;
  const getCeyrek = () => sarrafiyeData.CEYREK_YENI?.price || Number((gramTry * 1.75).toFixed(2));
  const getYarim = () => sarrafiyeData.YARIM_YENI?.price || Number((gramTry * 3.50).toFixed(2));
  const getTam = () => sarrafiyeData.TEK_YENI?.price || Number((gramTry * 7.00).toFixed(2));
  res.json({
    ALTIN: { symbol: 'ALTIN', name: 'Gram Altın', price: gramTry, priceUsd: goldData.xauusd, usdtry: goldData.usdtry, change: goldData.change, high24h: goldData.high24hTry || gramTry, low24h: goldData.low24hTry || gramTry, updatedAt: goldData.updatedAt, sparkline: goldIntraday.slice(-24).map(h => h.price || gramTry) },
    XAUUSD: { symbol: 'XAUUSD', name: 'Ons Altın', price: goldData.xauusd, change: goldData.change, high24h: goldData.xauusd, low24h: goldData.xauusd, updatedAt: goldData.updatedAt, sparkline: goldIntraday.slice(-24).map(h => h.price && goldData.usdtry > 0 ? Number(((h.price * 31.1035) / goldData.usdtry).toFixed(2)) : goldData.xauusd) },
    CEYREK_YENI: { symbol: 'CEYREK_YENI', name: 'Çeyrek Altın', price: getCeyrek(), change: goldData.change, high24h: 0, low24h: 0, updatedAt: goldData.updatedAt, sparkline: goldIntraday.slice(-24).map(h => Number(((h.price * goldData.usdtry) / 31.1035 * 1.75).toFixed(2))) },
    YARIM_YENI: { symbol: 'YARIM_YENI', name: 'Yarım Altın', price: getYarim(), change: goldData.change, high24h: 0, low24h: 0, updatedAt: goldData.updatedAt, sparkline: goldIntraday.slice(-24).map(h => Number(((h.price * goldData.usdtry) / 31.1035 * 3.5).toFixed(2))) },
    TEK_YENI: { symbol: 'TEK_YENI', name: 'Tam Altın', price: getTam(), change: goldData.change, high24h: 0, low24h: 0, updatedAt: goldData.updatedAt, sparkline: goldIntraday.slice(-24).map(h => Number(((h.price * goldData.usdtry) / 31.1035 * 7).toFixed(2))) },
    CUM_ALTIN: { symbol: 'CUM_ALTIN', name: 'Cumhuriyet Altını', price: sarrafiyeData.CUM_ALTIN?.price || Number((gramTry * 7.2).toFixed(2)), change: goldData.change, high24h: 0, low24h: 0, updatedAt: goldData.updatedAt, sparkline: goldIntraday.slice(-24).map(h => Number(((h.price * goldData.usdtry) / 31.1035 * 7.2).toFixed(2))) },
    ATA_ALTIN: { symbol: 'ATA_ALTIN', name: 'Ata Altın', price: sarrafiyeData.ATA_ALTIN?.price || Number((gramTry * 7.2).toFixed(2)), change: goldData.change, high24h: 0, low24h: 0, updatedAt: goldData.updatedAt, sparkline: goldIntraday.slice(-24).map(h => Number(((h.price * goldData.usdtry) / 31.1035 * 7.2).toFixed(2))) },
    RESAT_ALTIN: { symbol: 'RESAT_ALTIN', name: 'Reşat Altın', price: sarrafiyeData.RESAT_ALTIN?.price || Number((gramTry * 7.2).toFixed(2)), change: goldData.change, high24h: 0, low24h: 0, updatedAt: goldData.updatedAt, sparkline: goldIntraday.slice(-24).map(h => Number(((h.price * goldData.usdtry) / 31.1035 * 7.2).toFixed(2))) },
    GUMUS: { symbol: 'GUMUS', name: 'Gram Gümüş', price: sarrafiyeData.GUMUS?.price || goldData.gramSilverTry, change: goldData.silverChange, high24h: 0, low24h: 0, updatedAt: goldData.updatedAt, sparkline: silverIntraday.slice(-24).map(h => h.price) },
    PLATIN: { symbol: 'PLATIN', name: 'Gram Platin', price: sarrafiyeData.PLATIN?.price || 0, change: sarrafiyeData.PLATIN?.change || 0, high24h: 0, low24h: 0, updatedAt: goldData.updatedAt, sparkline: platinIntraday.slice(-24).map(h => h.price) },
    PALADYUM: { symbol: 'PALADYUM', name: 'Gram Paladyum', price: sarrafiyeData.PALADYUM?.price || 0, change: sarrafiyeData.PALADYUM?.change || 0, high24h: 0, low24h: 0, updatedAt: goldData.updatedAt, sparkline: paladyumIntraday.slice(-24).map(h => h.price) },
  });
});

app.get('/chart/gold/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase(); const backendPeriod = req.query.period || '1D';
  if (symbol === 'PLATIN') {
    const h = backendPeriod === '1D' ? platinIntraday : (platinHistoryCache[backendPeriod] || []);
    if (h.length === 0) { const price = sarrafiyeData.PLATIN?.price || 0; const now = Math.floor(Date.now() / 1000); return res.json(price > 0 ? [{ time: now - 3600, price }, { time: now, price }] : []); }
    const data = [...h]; if (data.length > 0 && sarrafiyeData.PLATIN?.price > 0) data[data.length - 1] = { time: Math.floor(Date.now() / 1000), price: sarrafiyeData.PLATIN.price }; return res.json(data);
  }
  if (symbol === 'PALADYUM') {
    const h = backendPeriod === '1D' ? paladyumIntraday : (paladyumHistoryCache[backendPeriod] || []);
    if (h.length === 0) { const price = sarrafiyeData.PALADYUM?.price || 0; const now = Math.floor(Date.now() / 1000); return res.json(price > 0 ? [{ time: now - 3600, price }, { time: now, price }] : []); }
    const data = [...h]; if (data.length > 0 && sarrafiyeData.PALADYUM?.price > 0) data[data.length - 1] = { time: Math.floor(Date.now() / 1000), price: sarrafiyeData.PALADYUM.price }; return res.json(data);
  }
  if (symbol === 'GUMUS') {
    const h = backendPeriod === '1D' ? silverIntraday : (silverHistoryCache[backendPeriod] || []);
    if (h.length === 0 && goldData.gramSilverTry > 0) { const now = Math.floor(Date.now() / 1000); return res.json([{ time: now - 3600, price: goldData.gramSilverTry }, { time: now, price: goldData.gramSilverTry }]); }
    const data = [...h]; if (data.length > 0 && goldData.gramSilverTry > 0) data[data.length - 1] = { time: Math.floor(Date.now() / 1000), price: goldData.gramSilverTry }; return res.json(data);
  }
  const history = getGoldHistory(backendPeriod); const multiplier = GOLD_MULTIPLIERS[symbol] || 1.0;
  if (history.length === 0) { if (goldData.gramTry > 0) { const now = Math.floor(Date.now() / 1000); return res.json([{ time: now - 3600, price: goldData.gramTry }, { time: now, price: goldData.gramTry }]); } return res.status(404).json({ error: 'Veri henüz yüklenmedi' }); }
  const data = history.map(h => { if (symbol === 'XAUUSD') return { time: h.time, price: Number((h.priceUsd || h.price).toFixed(2)) }; return { time: h.time, price: Number((h.price * multiplier).toFixed(2)) }; });
  if (data.length > 0 && goldData.gramTry > 0) { const now = Math.floor(Date.now() / 1000); const lastPrice = symbol === 'XAUUSD' ? goldData.xauusd : goldData.gramTry * multiplier; data[data.length - 1] = { time: now, price: Number(lastPrice.toFixed(2)) }; }
  res.json(data);
});

async function loadMetadataFromSupabase() {
  try {
    console.log('Supabase assets yukleniyor...');
    const response = await axios.get(`${SUPABASE_URL}/rest/v1/assets?select=*`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, timeout: 10000 });
    if (response.data && response.data.length > 0) {
      response.data.forEach(row => { coinMetadata[row.symbol] = { symbol: row.symbol, name: row.name || row.symbol, logo: row.logo_url || '', geckoId: row.gecko_id || '', rank: 9999, marketCap: 0 }; });
      console.log(`Supabase assets: ${response.data.length} coin yuklendi`); return true;
    }
    return false;
  } catch (e) { console.log('Supabase okuma hatasi:', e.message); return false; }
}

async function saveMetadataToSupabase(data) {
  try {
    for (const coin of data) {
      await axios.patch(`${SUPABASE_URL}/rest/v1/assets?symbol=eq.${coin.symbol}`, { logo_url: coin.logo || '', gecko_id: coin.geckoId || '' },
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, timeout: 5000 });
    }
    console.log(`${data.length} coin assets tablosunda guncellendi`);
  } catch (e) { console.log('Supabase guncelleme hatasi:', e.message); }
}

async function fetchAndSaveCoinGeckoMetadata(symbols) {
  const symbolSet = new Set(symbols); const collected = [];
  for (let page = 1; page <= 4; page++) {
    let success = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets', { params: { vs_currency: 'usd', order: 'market_cap_desc', per_page: 125, page, sparkline: false }, timeout: 10000 });
        response.data.forEach(coin => {
          const symbol = coin.symbol.toUpperCase();
          if (symbolSet.has(symbol)) collected.push({ symbol, name: coin.name, rank: coin.market_cap_rank || 9999, marketCap: Number(coin.market_cap || 0), logo: coin.image || '', geckoId: coin.id });
        });
        console.log(`CoinGecko sayfa ${page} yuklendi (${collected.length} coin)`); success = true; break;
      } catch (e) { const wait = attempt * 60000; console.log(`CoinGecko sayfa ${page} hata, ${wait / 1000}sn bekleniyor...`); await new Promise(r => setTimeout(r, wait)); }
    }
    if (!success) console.log(`CoinGecko sayfa ${page} atlandi`);
    if (page < 4) await new Promise(r => setTimeout(r, 30000));
  }
  if (collected.length > 0) {
    await saveMetadataToSupabase(collected);
    collected.forEach(coin => {
      if (coinMetadata[coin.symbol]) { coinMetadata[coin.symbol].rank = coin.rank; coinMetadata[coin.symbol].marketCap = coin.marketCap; coinMetadata[coin.symbol].logo = coin.logo; coinMetadata[coin.symbol].geckoId = coin.geckoId; }
      else coinMetadata[coin.symbol] = coin;
    });
    orderedSymbols.sort((a, b) => (coinMetadata[a]?.rank || 9999) - (coinMetadata[b]?.rank || 9999));
    console.log(`Toplam ${collected.length} coin metadata guncellendi`);
  }
}

async function loadCoinbaseSymbols() {
  const response = await axios.get('https://api.exchange.coinbase.com/products', { timeout: 10000 });
  const symbols = response.data.filter(p => p.quote_currency === 'USD' && p.status === 'online').map(p => p.base_currency.toUpperCase());
  console.log(`Coinbase: ${symbols.length} aktif USD coini`); return symbols;
}

async function loadCoinStats() {
  for (const symbol of orderedSymbols) {
    try {
      const response = await axios.get(`https://api.exchange.coinbase.com/products/${symbol}-USD/stats`, { timeout: 5000 });
      coinStats[symbol] = { high24h: Number(response.data.high), low24h: Number(response.data.low), volume24h: Number(response.data.volume) };
    } catch (_) {}
  }
  console.log('Coin stats yuklendi');
}

async function loadSparklines() {
  let loaded = 0;
  for (const symbol of orderedSymbols) {
    try {
      const end = new Date(); const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
      const response = await axios.get(`https://api.exchange.coinbase.com/products/${symbol}-USD/candles`, { params: { start: start.toISOString(), end: end.toISOString(), granularity: 3600 }, timeout: 5000 });
      if (response.data && response.data.length > 0) { sparklineCache[symbol] = response.data.map(c => c[4]).reverse().slice(-24); loaded++; }
      await new Promise(r => setTimeout(r, 100));
    } catch (_) {}
  }
  console.log(`Sparklines yuklendi: ${loaded}/${orderedSymbols.length}`);
}

async function loadGlobalStats() {
  try {
    const response = await axios.get('https://api.coinlore.net/api/global/', { timeout: 5000 });
    totalMarketCap = Number(response.data[0].total_mcap); console.log('Global market cap yuklendi');
  } catch (e) { console.log('Global Stats Error:', e.message); }
}

function startWebSocket() {
  if (ws) ws.close();
  ws = new WebSocket('wss://ws-feed.exchange.coinbase.com', { perMessageDeflate: false });
  ws.on('open', () => {
    console.log('Coinbase WebSocket connected');
    const productIds = orderedSymbols.map(s => `${s}-USD`);
    ws.send(JSON.stringify({ type: 'subscribe', channels: [{ name: 'ticker', product_ids: productIds }] }));
  });
  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type !== 'ticker') return;
      const symbol = data.product_id.replace('-USD', '');
      const price = parseFloat(data.price); const open = parseFloat(data.open_24h);
      const change = open > 0 ? Number((((price - open) / open) * 100).toFixed(2)) : 0;
      const meta = coinMetadata[symbol] || { rank: 9999, name: symbol, marketCap: 0 };
      const dominance = totalMarketCap > 0 ? Number(((meta.marketCap / totalMarketCap) * 100).toFixed(2)) : 0;
      prices[symbol] = {
        rank: meta.rank, symbol, name: meta.name || symbol,
        marketCap: meta.marketCap || 0,
        dominance,
        high24h: coinStats[symbol]?.high24h || parseFloat(data.high_24h) || 0,
        low24h: coinStats[symbol]?.low24h || parseFloat(data.low_24h) || 0,
        volume24h: coinStats[symbol]?.volume24h ? coinStats[symbol].volume24h * price : 0,
        logo: `https://crypto-live-api.onrender.com/logo/${symbol}`,
        price, change,
        sparkline: sparklineCache[symbol] || [],
      };
    } catch (e) { console.log('WS Parse Error:', e.message); }
  });
  ws.on('error', err => console.log('WebSocket Error:', err.message));
  ws.on('close', () => { console.log('WebSocket closed. Reconnecting in 3s...'); setTimeout(() => startWebSocket(), 3000); });
}

async function translateWithClaude(englishText, coinName) {
  if (!ANTHROPIC_API_KEY) return null;
  const cleanText = englishText.replace(/<[^>]*>/g, '').trim();
  if (!cleanText || cleanText.length < 20) return null;
  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: `Aşağıdaki kripto para açıklamasını Türkçe'ye çevir.\nKurallar:\n- Teknik terimler Türkçe'ye çevrilmez\n- Coin/proje isimleri değiştirilmez\n- Sadece çeviriyi yaz\n- Doğal Türkçe kullan\n\n${coinName} açıklaması:\n${cleanText.slice(0, 1500)}` }] },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 30000 });
    return response.data.content[0]?.text?.trim() || null;
  } catch (e) { console.log('Claude çeviri hatası:', e.response?.data || e.message); return null; }
}

app.get('/coin-info/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const supabaseRes = await axios.get(`${SUPABASE_URL}/rest/v1/assets?select=*&symbol=eq.${symbol}`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, timeout: 5000 });
    const row = supabaseRes.data?.[0];
    if (row?.description_tr) return res.json({ symbol, description_tr: row.description_tr, source: 'cache' });
    const geckoId = row?.gecko_id || coinMetadata[symbol]?.geckoId;
    if (!geckoId) return res.json({ symbol, description_tr: null, source: 'no_match' });
    let englishDescription = null;
    try {
      const geckoResponse = await axios.get(`https://api.coingecko.com/api/v3/coins/${geckoId}`, { params: { localization: false, tickers: false, market_data: false, community_data: false, developer_data: false }, timeout: 10000 });
      englishDescription = geckoResponse.data?.description?.en || null;
    } catch (e) { return res.status(503).json({ symbol, description_tr: null, source: 'gecko_error' }); }
    if (!englishDescription || englishDescription.length < 20) return res.json({ symbol, description_tr: null, source: 'no_description' });
    const coinName = row?.name || coinMetadata[symbol]?.name || symbol;
    const translatedText = await translateWithClaude(englishDescription, coinName);
    if (!translatedText) return res.json({ symbol, description_tr: null, source: 'translation_failed' });
    await axios.patch(`${SUPABASE_URL}/rest/v1/assets?symbol=eq.${symbol}`, { description_tr: translatedText }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, timeout: 5000 });
    res.json({ symbol, description_tr: translatedText, source: 'translated' });
  } catch (e) { res.status(500).json({ symbol, description_tr: null, source: 'error' }); }
});

const logoCache = {};
app.get('/logo/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    if (logoCache[symbol]) { res.set('Content-Type', logoCache[symbol].contentType); res.set('Cache-Control', 'public, max-age=604800'); return res.send(logoCache[symbol].data); }
    const logoUrl = coinMetadata[symbol]?.logo;
    if (!logoUrl) return res.status(404).send('Logo not found');
    const response = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 8000 });
    const contentType = response.headers['content-type'] || 'image/png';
    logoCache[symbol] = { data: response.data, contentType };
    res.set('Content-Type', contentType); res.set('Cache-Control', 'public, max-age=604800'); res.send(response.data);
  } catch (e) { res.status(500).send('Logo fetch failed'); }
});

app.get('/prices', (req, res) => {
  const result = {};
  orderedSymbols.forEach(symbol => { if (prices[symbol]) result[symbol] = { ...prices[symbol], sparkline: sparklineCache[symbol] || prices[symbol].sparkline || [] }; });
  res.json(result);
});

function getChartConfig(period) {
  switch (period) {
    case '1D': return { days: 1, granularity: 3600 }; case '1M': return { days: 30, granularity: 86400 };
    case '3M': return { days: 90, granularity: 86400 }; case '6M': return { days: 180, granularity: 86400 };
    case '1Y': return { days: 365, granularity: 86400 }; case '5Y': return { days: 1825, granularity: 86400 };
    default: return { days: 1, granularity: 3600 };
  }
}

async function fetchCandles(symbol, startMs, endMs, granularity) {
  const maxCandles = 300; const windowMs = granularity * maxCandles * 1000; const chunks = []; let chunkEnd = endMs;
  while (chunkEnd > startMs) { const chunkStart = Math.max(chunkEnd - windowMs, startMs); chunks.push({ start: chunkStart, end: chunkEnd }); chunkEnd = chunkStart; }
  let allCandles = [];
  for (const chunk of chunks) {
    try {
      const response = await axios.get(`https://api.exchange.coinbase.com/products/${symbol}-USD/candles`, { params: { start: new Date(chunk.start).toISOString(), end: new Date(chunk.end).toISOString(), granularity } });
      allCandles = allCandles.concat(response.data);
    } catch (e) { console.log(`Candle chunk error (${symbol}):`, e.message); }
  }
  return allCandles;
}

const GOLD_SYMBOLS = new Set(['ALTIN', 'XAUUSD', 'CEYREK_YENI', 'YARIM_YENI', 'TEK_YENI', 'CUM_ALTIN', 'ATA_ALTIN', 'RESAT_ALTIN', 'GUMUS', 'PLATIN', 'PALADYUM']);

app.get('/chart/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    if (GOLD_SYMBOLS.has(symbol)) return res.redirect(`/chart/gold/${symbol}?${new URLSearchParams(req.query).toString()}`);
    const period = req.query.period || '1D'; const config = getChartConfig(period);
    const endMs = Date.now(); const startMs = endMs - config.days * 24 * 60 * 60 * 1000;
    const candles = await fetchCandles(symbol, startMs, endMs, config.granularity);
    if (!candles || candles.length === 0) return res.status(404).json({ error: 'No candle data found' });
    const mode = req.query.mode || 'line'; let chartData;
    if (mode === 'candle') { chartData = candles.map(c => ({ time: c[0], open: c[3], high: c[2], low: c[1], close: c[4], volume: c[5] })).sort((a, b) => a.time - b.time).filter((item, i, arr) => i === 0 || item.time !== arr[i - 1].time); }
    else { chartData = candles.map(c => ({ time: c[0], price: c[4] })).sort((a, b) => a.time - b.time).filter((item, i, arr) => i === 0 || item.time !== arr[i - 1].time); }
    res.json(chartData);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

let fngCache = null; let fngLastFetch = 0;
app.get('/fng', async (req, res) => {
  try {
    const now = Date.now();
    if (fngCache && now - fngLastFetch < 10 * 60 * 1000) return res.json(fngCache);
    const response = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5000 });
    const item = response.data.data[0];
    fngCache = { value: parseInt(item.value), classification: item.value_classification, timestamp: item.timestamp }; fngLastFetch = now; res.json(fngCache);
  } catch (e) { if (fngCache) return res.json(fngCache); res.status(500).json({ error: e.message }); }
});

let prefetchRunning = false;
app.get('/prefetch-descriptions', async (req, res) => {
  if (prefetchRunning) return res.json({ status: 'already_running' });
  let coins = [];
  try {
    const response = await axios.get(`${SUPABASE_URL}/rest/v1/assets?select=symbol,name,gecko_id&gecko_id=not.is.null&description_tr=is.null`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, timeout: 10000 });
    coins = response.data || [];
  } catch (e) { return res.status(500).json({ status: 'error', message: e.message }); }
  res.json({ status: 'started', total: coins.length });
  prefetchRunning = true;
  (async () => {
    let success = 0, failed = 0;
    for (const coin of coins) {
      try {
        const geckoResponse = await axios.get(`https://api.coingecko.com/api/v3/coins/${coin.gecko_id}`, { params: { localization: false, tickers: false, market_data: false, community_data: false, developer_data: false }, timeout: 10000 });
        const englishDescription = geckoResponse.data?.description?.en || null;
        if (!englishDescription || englishDescription.length < 20) { failed++; await new Promise(r => setTimeout(r, 3000)); continue; }
        const translatedText = await translateWithClaude(englishDescription, coin.name);
        if (!translatedText) { failed++; await new Promise(r => setTimeout(r, 3000)); continue; }
        await axios.patch(`${SUPABASE_URL}/rest/v1/assets?symbol=eq.${coin.symbol}`, { description_tr: translatedText }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, timeout: 5000 });
        success++; console.log(`Prefetch: ${coin.symbol} çevrildi (${success}/${coins.length})`);
        await new Promise(r => setTimeout(r, 4000));
      } catch (e) { failed++; const waitTime = e.response?.status === 429 ? 60000 : 4000; await new Promise(r => setTimeout(r, waitTime)); }
    }
    prefetchRunning = false; console.log(`Prefetch tamamlandı: ${success} başarılı, ${failed} başarısız`);
  })();
});

function formatTefasDate(date) { const y = date.getFullYear(); const m = (date.getMonth() + 1).toString().padStart(2, '0'); const d = date.getDate().toString().padStart(2, '0'); return `${y}-${m}-${d}`; }

async function fetchTefas(endpoint, params) {
  const response = await axios.post(`https://www.tefas.gov.tr/api/funds/${endpoint}`, params, { timeout: 15000, headers: { 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'tr-TR,tr;q=0.9', 'Content-Type': 'application/json', 'Origin': 'https://www.tefas.gov.tr', 'Referer': 'https://www.tefas.gov.tr/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
  return response.data;
}

app.get('/fund/price/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const priceData = await fetchTefas('fonFiyatBilgiGetir', { fonKodu: code, dil: 'TR', periyod: 1 });
    if (!priceData || priceData.faultCode) return res.status(404).json({ error: 'Fon bulunamadı', raw: priceData });
    const items = priceData?.resultList || priceData?.data || priceData?.fiyatlar || (Array.isArray(priceData) ? priceData : null);
    if (!items?.length) return res.status(404).json({ error: 'Fiyat yok', raw: priceData });
    const latest = items[items.length - 1]; const prev = items.length > 1 ? items[items.length - 2] : null;
    const price = parseFloat(String(latest.fiyat || latest.FIYAT || latest.birimPayDegeri || 0).replace(',', '.'));
    const prevP = prev ? parseFloat(String(prev.fiyat || prev.FIYAT || prev.birimPayDegeri || price).replace(',', '.')) : price;
    const change = prevP > 0 ? ((price - prevP) / prevP) * 100 : 0;
    let totalValue = 0, investorCount = 0, kategoriDerece = 0, kategoriFonSay = 0, fonKategori = '';
    try {
      const detayData = await fetchTefas('fonBilgiGetir', { fonKodu: code, dil: 'TR' });
      const detay = detayData?.resultList?.[0] || detayData?.data?.[0] || detayData?.[0] || detayData || {};
      console.log(`[fund/price] ${code} detay keys:`, Object.keys(detay).join(', '));
      totalValue = parseFloat(String(detay.portBuyukluk || detay.portfoyBuyuklugu || detay.PORTFOYBUYUKLUGU || 0).replace(',', '.')) || 0;
      investorCount = parseInt(detay.yatirimciSayi || detay.kisiSayisi || detay.KISISAYISI || 0) || 0;
      kategoriDerece = parseInt(detay.kategoriDerece || 0) || 0; kategoriFonSay = parseInt(detay.kategoriFonSay || 0) || 0; fonKategori = detay.fonKategori || '';
    } catch (e2) { console.log(`[fund/price] ${code} detay hata:`, e2.message); }
    res.json({ code, name: latest.fonUnvan || priceData.fonUnvani || latest.FONUNVAN || code, price, change: Number(change.toFixed(4)), date: latest.tarih || latest.TARIH || latest.date, totalValue, investorCount, kategoriDerece, kategoriFonSay, fonKategori });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/fund/debug/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase(); const endpoints = ['fonBilgiGetir', 'getFplFonList', 'fonDetayGetir']; const results = {};
    for (const ep of endpoints) {
      try { const d = await fetchTefas(ep, { fonKodu: code, dil: 'TR' }); const item = d?.resultList?.[0] || d?.data?.[0] || d?.[0] || d || {}; results[ep] = { keys: Object.keys(item), sample: item }; }
      catch (e) { results[ep] = { error: e.message }; }
    }
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/fund/chart/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase(); const period = req.query.period || '1M';
    const periyodMap = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '3Y': 36, '5Y': 60 }; const periyod = periyodMap[period] || 1;
    const data = await fetchTefas('fonFiyatBilgiGetir', { fonKodu: code, dil: 'TR', periyod });
    if (!data || data.faultCode) return res.status(404).json({ error: 'Veri yok' });
    const items = data?.resultList || data?.data || data?.fiyatlar || (Array.isArray(data) ? data : []);
    if (!items.length) return res.status(404).json({ error: 'Fiyat yok' });
    const chartData = items.map(item => ({ date: item.tarih || item.TARIH || item.date, price: parseFloat(String(item.fiyat || item.FIYAT || item.birimPayDegeri || 0).replace(',', '.')) })).filter(item => item.price > 0);
    res.json(chartData);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/fund/comparison/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase(); const periyod = req.query.periyod || '12';
    const data = await fetchTefas('fonProfilDtyGetir', { fonKodu: code, dil: 'TR', periyod });
    if (!data || data.faultCode) return res.status(404).json({ error: 'Veri yok' });
    const items = data?.resultList || []; const fund = items.find(i => i.fonKodu === code);
    const labelMap = { 'BIST100': 'BIST 100', 'BIST30': 'BIST 30', 'ALTIN': 'Altın', 'USD': 'USD/TL', 'EUR': 'EUR/TL', 'TUFE': 'TÜFE', 'MEVDUAT FAIZI': 'Mevduat' };
    const benchmarks = items.filter(i => i.fonKodu !== code).map(i => ({ code: i.fonKodu, name: labelMap[i.fonKodu] || i.fonUnvan || i.fonKodu, return: Number((i.fonTurGetiri * 100).toFixed(2)) })).sort((a, b) => b.return - a.return);
    res.json({ code, name: fund?.fonUnvan || code, fundType: fund?.fonTuru || '', fundReturn: fund ? Number((fund.fonTurGetiri * 100).toFixed(2)) : null, period: parseInt(periyod), benchmarks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/fund/returns/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const data = await fetchTefas('fonFiyatBilgiGetir', { fonKodu: code, dil: 'TR', periyod: 60 });
    if (!data || data.faultCode) return res.status(404).json({ error: 'Veri yok' });
    const items = data?.resultList || data?.data || data?.fiyatlar || (Array.isArray(data) ? data : []);
    if (!items.length) return res.status(404).json({ error: 'Fiyat yok' });
    const pricesList = items.map(d => ({ date: new Date(d.tarih || d.TARIH || d.date), price: parseFloat(String(d.fiyat || d.FIYAT || d.birimPayDegeri || 0).replace(',', '.')) })).filter(d => d.price > 0).sort((a, b) => a.date - b.date);
    const current = pricesList[pricesList.length - 1].price; const today = new Date();
    function getReturn(months) { const target = new Date(today); target.setMonth(target.getMonth() - months); const found = pricesList.find(p => p.date >= target); if (!found) return null; return Number((((current - found.price) / found.price) * 100).toFixed(2)); }
    res.json({ code, currentPrice: current, returns: { '1M': getReturn(1), '3M': getReturn(3), '6M': getReturn(6), '1Y': getReturn(12), '3Y': getReturn(36), '5Y': getReturn(60) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/fund/sync', async (req, res) => {
  res.json({ status: 'started - check logs' });
  try {
    const tefasData = await axios.post('https://www.tefas.gov.tr/api/funds/getFplFonList', {}, { timeout: 15000, headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Origin': 'https://www.tefas.gov.tr', 'Referer': 'https://www.tefas.gov.tr/BESSorgu.aspx', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' } });
    const items = tefasData.data?.resultList || tefasData.data?.data || (Array.isArray(tefasData.data) ? tefasData.data : []);
    console.log(`getFplFonList: ${items.length} fon`);
    if (items.length > 0) {
      let added = 0;
      for (const item of items) {
        const code = item.fonKodu || item.FONKODU; const name = item.fonUnvan || item.FONUNVAN || item.fonAdi || code;
        if (!code) continue;
        try { await axios.post(`${SUPABASE_URL}/rest/v1/assets`, { symbol: code, name, type: 'fund', provider: 'tefas', currency: 'TRY', search_keywords: `${code.toLowerCase()} ${name.toLowerCase()} bes fon emeklilik`, is_active: true }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates' } }); added++; } catch(_) {}
        await new Promise(r => setTimeout(r, 50));
      }
      console.log(`Fund sync tamamlandi: ${added} fon eklendi`);
    }
  } catch (e) { console.log('Fund sync hata:', e.message); }
});

app.get('/fund/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toUpperCase(); let data = null;
    for (const ep of ['getFplFonList', 'fonBilgiGetir', 'fonListeGetir']) { try { const r = await fetchTefas(ep, {}); if (r && !r.faultCode) { data = r; break; } } catch(_) {} }
    if (!data) return res.status(404).json({ error: 'Search endpoint bulunamadi' });
    const items = data?.resultList || data?.data || data?.fonList || (Array.isArray(data) ? data : []);
    if (!items.length) return res.json([]);
    const funds = items.filter(d => { if (!q) return true; const code = (d.fonKodu || d.FONKODU || '').toUpperCase(); const name = (d.fonUnvan || d.FONUNVAN || d.fonAdi || '').toUpperCase(); return code.includes(q) || name.includes(q); }).map(d => ({ code: d.fonKodu || d.FONKODU, name: d.fonUnvan || d.FONUNVAN || d.fonAdi || d.fonKodu, type: d.fonTuru || d.FONTURU || '' }));
    res.json(funds.slice(0, 50));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/fund/allocation/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const response = await axios.get(`https://www.besfongetirileri.com/FonDetayliAnaliz/getPieChartData?FundCode=${code}`, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://www.besfongetirileri.com/', 'Accept': 'application/json, text/plain, */*' } });
    res.json(response.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function loadGoldIntradayFromSupabase() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const symbolMap = { 'XAU': 'gold', 'XAG': 'silver', 'XPT': 'platin', 'XPD': 'paladyum' };
    for (const [sym, type] of Object.entries(symbolMap)) {
      const response = await axios.get(`${SUPABASE_URL}/rest/v1/gold_intraday?select=price_try,recorded_at&symbol=eq.${sym}&recorded_at=gte.${cutoff}&order=recorded_at.asc&limit=1000`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, timeout: 10000 });
      const rows = response.data || [];
      const data = rows.map(r => ({ time: Math.floor(new Date(r.recorded_at).getTime() / 1000), price: parseFloat(r.price_try) })).filter(r => r.price > 0);
      if (type === 'gold')     { goldIntraday     = data; console.log(`gold_intraday yüklendi: ${data.length} kayıt (XAU)`); }
      if (type === 'silver')   { silverIntraday   = data; console.log(`gold_intraday yüklendi: ${data.length} kayıt (XAG)`); }
      if (type === 'platin')   { platinIntraday   = data; console.log(`gold_intraday yüklendi: ${data.length} kayıt (XPT)`); }
      if (type === 'paladyum') { paladyumIntraday = data; console.log(`gold_intraday yüklendi: ${data.length} kayıt (XPD)`); }
    }
  } catch (e) { console.log('loadGoldIntradayFromSupabase hata:', e.message); }
}

async function fetchAndSaveAllBesPrices() {
  console.log('BES fiyat güncelleme başladı...');
  try {
    const response = await axios.get(`${SUPABASE_URL}/rest/v1/assets?select=symbol,name&type=eq.fund&is_active=eq.true`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, timeout: 10000 });
    const funds = response.data || []; console.log(`BES: ${funds.length} fon bulundu`);
    let success = 0, failed = 0; const today = new Date().toISOString().split('T')[0];
    for (const fund of funds) {
      try {
        const tefasResponse = await axios.post('https://www.tefas.gov.tr/api/funds/fonFiyatBilgiGetir', { fonKodu: fund.symbol, dil: 'TR', periyod: 1 }, { timeout: 15000, headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Origin': 'https://www.tefas.gov.tr', 'Referer': 'https://www.tefas.gov.tr/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
        const items = tefasResponse.data?.resultList || tefasResponse.data?.data || [];
        if (!items.length) { failed++; continue; }
        const latest = items[items.length - 1]; const prev = items.length > 1 ? items[items.length - 2] : null;
        const price = parseFloat(String(latest.fiyat || latest.FIYAT || latest.birimPayDegeri || 0).replace(',', '.'));
        const prevP = prev ? parseFloat(String(prev.fiyat || prev.FIYAT || prev.birimPayDegeri || price).replace(',', '.')) : price;
        const change = prevP > 0 ? ((price - prevP) / prevP) * 100 : 0;
        const date = latest.tarih || latest.TARIH || today;
        if (price <= 0) { failed++; continue; }
        await axios.post(`${SUPABASE_URL}/rest/v1/fund_prices`, { symbol: fund.symbol, price, change: Number(change.toFixed(4)), date }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, timeout: 5000 });
        success++; await new Promise(r => setTimeout(r, 200));
      } catch (e) { failed++; await new Promise(r => setTimeout(r, 500)); }
    }
    console.log(`BES güncelleme tamamlandı: ${success} başarılı, ${failed} başarısız`);
  } catch (e) { console.log('fetchAndSaveAllBesPrices hata:', e.message); }
}

function scheduleBesMidnightUpdate() {
  const now = new Date(); const next = new Date(); next.setUTCHours(23, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now; console.log(`BES gece güncellemesi ${Math.round(msUntil / 60000)} dk sonra (02:00 TR)`);
  setTimeout(() => { fetchAndSaveAllBesPrices(); setInterval(() => fetchAndSaveAllBesPrices(), 24 * 60 * 60 * 1000); }, msUntil);
}

async function initialize() {
  try {
    const symbols = await loadCoinbaseSymbols(); orderedSymbols = symbols;
    const hasCache = await loadMetadataFromSupabase();
    orderedSymbols.sort((a, b) => (coinMetadata[a]?.rank || 9999) - (coinMetadata[b]?.rank || 9999));
    await loadGlobalStats(); startWebSocket(); loadCoinStats();
    await updateGoldData(); await loadGoldIntradayFromSupabase(); appendGoldHistory();
    fetchGoldHistory().then(() => { console.log('Altın geçmiş veri tamamlandı'); });
    scheduleMidnightMetals(); scheduleBesMidnightUpdate();
    setInterval(async () => { await updateGoldData(); appendGoldHistory(); }, 2 * 60 * 1000);
    setTimeout(() => { loadSparklines(); setInterval(() => loadSparklines(), 1800000); }, 120000);
    const geckoDelay = hasCache ? 300000 : 60000;
    setTimeout(() => { fetchAndSaveCoinGeckoMetadata(symbols); setInterval(() => fetchAndSaveCoinGeckoMetadata(symbols), 21600000); }, geckoDelay);
    setInterval(() => loadCoinStats(), 300000); setInterval(() => loadGlobalStats(), 300000);
    console.log(`Sunucu hazir, ${orderedSymbols.length} coin yuklendi`);
  } catch (e) { console.log('Initialize Error:', e.message); setTimeout(() => initialize(), 10000); }
}

initialize();

const FOREX_PAIRS = {
  'USD': { key: 'USD', name: 'Amerikan Dolari', flag: '🇺🇸' }, 'EUR': { key: 'EUR', name: 'Euro', flag: '🇪🇺' },
  'GBP': { key: 'GBP', name: 'Ingiliz Sterlini', flag: '🇬🇧' }, 'CHF': { key: 'CHF', name: 'Isvicre Frangi', flag: '🇨🇭' },
  'JPY': { key: 'JPY', name: 'Japon Yeni', flag: '🇯🇵' }, 'CNY': { key: 'CNY', name: 'Cin Yuani', flag: '🇨🇳' },
  'SAR': { key: 'SAR', name: 'Suudi Riyali', flag: '🇸🇦' }, 'AED': { key: 'AED', name: 'BAE Dirhemi', flag: '🇦🇪' },
  'RUB': { key: 'RUB', name: 'Rus Rublesi', flag: '🇷🇺' }, 'CAD': { key: 'CAD', name: 'Kanada Dolari', flag: '🇨🇦' },
  'AUD': { key: 'AUD', name: 'Avustralya Dolari', flag: '🇦🇺' }, 'NOK': { key: 'NOK', name: 'Norvec Kronu', flag: '🇳🇴' },
  'SEK': { key: 'SEK', name: 'Isvec Kronu', flag: '🇸🇪' }, 'DKK': { key: 'DKK', name: 'Danimarka Kronu', flag: '🇩🇰' },
  'KWD': { key: 'KWD', name: 'Kuveyt Dinari', flag: '🇰🇼' },
};

let forexData = {};

async function fetchForexPrices() {
  try {
    const response = await axios.get('https://finans.truncgil.com/v3/today.json', { timeout: 10000 });
    const data = response.data;
    const parsePrice = (val) => { if (!val) return 0; return parseFloat(String(val).replace(/\./g, '').replace(',', '.').replace('$', '').trim()) || 0; };
    const parseChange = (val) => { if (!val) return 0; return parseFloat(String(val).replace('%', '').replace(',', '.').trim()) || 0; };
    Object.entries(FOREX_PAIRS).forEach(([symbol, info]) => {
      const sell = parsePrice(data[info.key]?.Selling); const change = parseChange(data[info.key]?.Change);
      if (sell > 0) forexData[symbol] = { symbol, name: info.name, flag: info.flag, price: sell, change, type: 'forex', updatedAt: new Date().toISOString() };
    });
    console.log('Döviz güncellendi:', Object.keys(forexData).join(', '));
  } catch (e) { console.log('Döviz hata:', e.message); }
}

app.get('/forex-prices', (req, res) => res.json(forexData));
fetchForexPrices();
setInterval(() => fetchForexPrices(), 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// Flutter WebSocket — /ws  ← volume24h ve dominance EKLENDİ
// ─────────────────────────────────────────────────────────────────────────────
const clients = new Set();
const wss = new WebSocketServer({ noServer: true });

function buildPricePayload() {
  const result = {};

  orderedSymbols.forEach(symbol => {
    if (prices[symbol]) {
      result[symbol] = {
        rank:      prices[symbol].rank,
        symbol:    prices[symbol].symbol,
        name:      prices[symbol].name,
        price:     prices[symbol].price,
        change:    prices[symbol].change,
        marketCap: prices[symbol].marketCap,
        dominance: prices[symbol].dominance,   // ✅ EKLENDİ
        volume24h: prices[symbol].volume24h,   // ✅ EKLENDİ
        high24h:   prices[symbol].high24h,
        low24h:    prices[symbol].low24h,
        logo:      prices[symbol].logo,
        sparkline: sparklineCache[symbol] || [],
      };
    }
  });

  Object.entries(forexData).forEach(([symbol, data]) => {
    result[symbol] = data;
  });

  return JSON.stringify(result);
}

wss.on('connection', (socket) => {
  clients.add(socket);
  console.log(`Flutter WS bağlandı. Toplam: ${clients.size}`);
  socket.send(buildPricePayload());
  socket.on('close', () => { clients.delete(socket); console.log(`Flutter WS ayrıldı. Toplam: ${clients.size}`); });
  socket.on('error', () => { clients.delete(socket); });
});

setInterval(() => {
  if (clients.size === 0) return;
  const msg = buildPricePayload();
  clients.forEach(client => { if (client.readyState === 1) client.send(msg); });
}, 3000);

const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws') { wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request); }); }
  else { socket.destroy(); }
});