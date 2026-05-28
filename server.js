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

let ws = null;

async function loadTopCoins() {

  try {

    const response = await axios.get(
      'https://api.coingecko.com/api/v3/coins/markets',
      {
        params: {
          vs_currency: 'usd',
          order: 'market_cap_desc',
          per_page: 100,
          page: 1,
          sparkline: false
        }
      }
    );

    const supportedCoins = [

      'BTC',
      'ETH',
      'SOL',
      'XRP',
      'DOGE'

    ];

    response.data.forEach((coin, index) => {

      const symbol =
        coin.symbol.toUpperCase();

      if (
        supportedCoins.includes(symbol)
      ) {

        orderedSymbols.push(symbol);

        coinMetadata[symbol] = {

          rank: index + 1,

          symbol: symbol,

          name: coin.name,

          marketCap: coin.market_cap,

          logo: coin.image

        };

      }

    });

    console.log(
      'Top coins loaded'
    );

    console.log(
      orderedSymbols
    );

    startWebSocket();

  } catch (e) {

    console.log(
      'CoinGecko Error:',
      e.message
    );

  }

}

function startWebSocket() {

  if (ws) {

    ws.close();

  }

  ws = new WebSocket(
    'wss://ws-feed.exchange.coinbase.com',
    {
      perMessageDeflate: false
    }
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
            'XRP-USD',
            'DOGE-USD'

          ]

        }
      ]

    }));

  });

  ws.on('message', (msg) => {

    try {

      const data = JSON.parse(
        msg.toString()
      );

      if (data.type === 'ticker') {

        const symbol =
          data.product_id.replace(
            '-USD',
            ''
          );

        if (
          !coinMetadata[symbol]
        ) {
          return;
        }

        const price =
          parseFloat(data.price);

        const open =
          parseFloat(data.open_24h);

        const change =
          open
            ? Number(
                (
                  (
                    (price - open) /
                    open
                  ) * 100
                ).toFixed(2)
              )
            : 0;

        prices[symbol] = {

          rank:
            coinMetadata[symbol]
              .rank,

          symbol: symbol,

          name:
            coinMetadata[symbol]
              .name,

          marketCap:
            coinMetadata[symbol]
              .marketCap,

          logo:
            coinMetadata[symbol]
              .logo,

          price: price,

          change: change

        };

      }

    } catch (e) {

      console.log(
        'Parse Error:',
        e.message
      );

    }

  });

  ws.on('error', (err) => {

    console.log(
      'WebSocket Error:',
      err.message
    );

  });

  ws.on('close', () => {

    console.log(
      'WebSocket closed. Reconnecting...'
    );

    setTimeout(() => {

      startWebSocket();

    }, 3000);

  });

}

app.get('/prices', (req, res) => {

  const sortedPrices = {};

  orderedSymbols.forEach((symbol) => {

    if (prices[symbol]) {

      sortedPrices[symbol] =
        prices[symbol];

    }

  });

  res.json(sortedPrices);

});

loadTopCoins();

app.listen(PORT, () => {

  console.log(
    `Server running on ${PORT}`
  );

});