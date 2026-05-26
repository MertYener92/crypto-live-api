const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');

const app = express();

app.use(cors());

let prices = {};

const ws = new WebSocket(
  'wss://stream.binance.com:9443/ws/!ticker@arr'
);

ws.on('message', (data) => {

  const tickers = JSON.parse(data);

  tickers.forEach((ticker) => {

    const symbol = ticker.s;

    if (symbol.endsWith('USDT')) {

      prices[symbol] = {
        price: ticker.c,
        change: ticker.P,
      };
    }
  });
});

app.get('/prices', (req, res) => {
  res.json(prices);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});