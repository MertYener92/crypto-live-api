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
          'XRP-USD',
          'DOGE-USD',
          'ADA-USD',
          'AVAX-USD',
          'LINK-USD',
          'DOT-USD',
          'LTC-USD',
          'TRX-USD',
          'MATIC-USD',
          'SHIB-USD'

        ]
      }
    ]
  }));
});

ws.on('message', (msg) => {

  const data = JSON.parse(msg);

  if (data.type === 'ticker') {

    const symbol =
      data.product_id
        .replace('-USD', '');

    const coinNames = {

      BTC: 'Bitcoin',
      ETH: 'Ethereum',
      SOL: 'Solana',
      BNB: 'BNB',
      XRP: 'XRP',
      DOGE: 'Dogecoin',
      ADA: 'Cardano',
      AVAX: 'Avalanche',
      LINK: 'Chainlink',
      DOT: 'Polkadot',
      LTC: 'Litecoin',
      TRX: 'TRON',
      MATIC: 'Polygon',
      SHIB: 'Shiba Inu'

    };

    prices[symbol] = {

      symbol: symbol,

      name:
        coinNames[symbol] ??
        symbol,

      price:
        parseFloat(data.price),

      change:
        parseFloat(data.open_24h)
          ? (
              ((parseFloat(data.price) -
              parseFloat(data.open_24h)) /
              parseFloat(data.open_24h)) *
              100
            ).toFixed(2)
          : 0,

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