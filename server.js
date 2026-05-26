const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();

app.use(cors());

const PORT = process.env.PORT || 10000;

let prices = {};

const symbols = [
  'btcusdt',
  'ethusdt',
  'solusdt',
  'bnbusdt',
  'xrpusdt'
];

const streams =
  symbols.map(s => `${s}@ticker`).join('/');

const ws = new WebSocket(
  `wss://stream.binance.com:9443/stream?streams=${streams}`
);

ws.on('open', () => {

  console.log(
    'Binance websocket connected'
  );

});

ws.on('message', (msg) => {

  const json = JSON.parse(msg);

  const data = json.data;

  const symbol =
      data.s.replace('USDT', '');

  prices[symbol] = {

    price: parseFloat(data.c),

    change: parseFloat(data.P),

  };
});

ws.on('close', () => {

  console.log(
    'WebSocket disconnected'
  );

});

app.get('/prices', (req, res) => {

  res.json(prices);

});

app.listen(PORT, () => {

  console.log(
    `Server running on ${PORT}`
  );

});