const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();

app.use(cors());

const PORT = process.env.PORT || 10000;

let prices = {};

const ws = new WebSocket(
  'wss://ws-feed.exchange.coinbase.com'
);

ws.on('open', () => {

  console.log(
    'Coinbase websocket connected'
  );

  ws.send(JSON.stringify({

    type: 'subscribe',

    channels: [
      {
        name: 'ticker',
        product_ids: [
          'BTC-USD',
          'ETH-USD',
          'SOL-USD',
          'BNB-USD',
          'XRP-USD'
        ]
      }
    ]
  }));
});

ws.on('message', (msg) => {

  const data = JSON.parse(msg);

  if (
    data.type === 'ticker'
  ) {

    const symbol =
        data.product_id
            .replace('-USD', '');

    prices[symbol] = {

  symbol: symbol,

  price: parseFloat(data.price),

  change: 0,

logo:
`https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${symbol.toLowerCase()}.png`
};
  }
});

ws.on('error', (err) => {

  console.log(err);

});

app.get('/prices', (req, res) => {

  res.json(prices);

});

app.listen(PORT, () => {

  console.log(
    `Server running on ${PORT}`
  );

});