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

async function loadTopCoins() {
  try {
    const response = await axios.get(
      'https://api.coinlore.net/api/tickers/'
    );

    const topCoins =
      response.data.data.slice(0, 100);

    orderedSymbols = [];

    topCoins.forEach((coin, index) => {
      const symbol = coin.symbol;

      orderedSymbols.push(symbol);

      coinMetadata[symbol] = {
        rank: index + 1,

        symbol: symbol,

        name: coin.name,

        marketCap: Number(
          coin.market_cap_usd
        ),

        logo:
          `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${symbol.toLowerCase()}.png`
      };
    });

    console.log(
      'Top 100 coins loaded'
    );

startWebSocket();

await loadCoinStats();

await loadGlobalStats();

    setInterval(() => {
      loadCoinStats();
    }, 300000);

    setInterval(() => {
  loadGlobalStats();
}, 300000);

  } catch (e) {

    console.log(
      'CoinLore Error:',
      e.message
    );

  }
}

async function loadCoinStats() {
  try {

    for (const symbol of orderedSymbols) {

      try {

        const response = await axios.get(
          `https://api.exchange.coinbase.com/products/${symbol}-USD/stats`
        );

        coinStats[symbol] = {

          high24h: Number(
            response.data.high
          ),

          low24h: Number(
            response.data.low
          ),

          volume24h: Number(
            response.data.volume
          )

        };

      } catch (e) {

        // Coinbase'de olmayan coinler olabilir

      }

    }

    console.log(
      'Coin stats loaded'
    );

  } catch (e) {

    console.log(
      'Stats Error:',
      e.message
    );

  }
}

async function loadGlobalStats() {

  try {

    const response = await axios.get(
      'https://api.coinlore.net/api/global/'
    );

    totalMarketCap = Number(
      response.data[0].total_mcap
    );

    console.log(
      'Global market cap loaded'
    );

  } catch (e) {

    console.log(
      'Global Stats Error:',
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

    const productIds =
      orderedSymbols.map(
        (symbol) =>
          `${symbol}-USD`
      );

    ws.send(
      JSON.stringify({

        type: 'subscribe',

        channels: [
          {
            name: 'ticker',

            product_ids:
              productIds
          }
        ]

      })
    );

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
          parseFloat(
            data.open_24h
          );

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
const dominance =
  totalMarketCap > 0
    ? Number(
        (
          coinMetadata[symbol]
            .marketCap /
          totalMarketCap *
          100
        ).toFixed(2)
      )
    : 0;
        prices[symbol] = {

          rank:
            coinMetadata[symbol]
              .rank,

          symbol:
            symbol,

          name:
            coinMetadata[symbol]
              .name,

          marketCap:
            coinMetadata[symbol]
              .marketCap,
              dominance:
  dominance,

          high24h:
            coinStats[symbol]
              ?.high24h || 0,

          low24h:
            coinStats[symbol]
              ?.low24h || 0,

          volume24h:
            coinStats[symbol]
              ?.volume24h || 0,

          logo:
            coinMetadata[symbol]
              .logo,

          price:
            price,

          change:
            change

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

  orderedSymbols.forEach(
    (symbol) => {

      if (
        prices[symbol]
      ) {

        sortedPrices[symbol] =
          prices[symbol];

      }

    }
  );

  res.json(
    sortedPrices
  );

});

function getChartConfig(range) {

  switch (range) {

    case '1D':
      return {
        days: 1,
        granularity: 3600
      };

    case '7D':
      return {
        days: 7,
        granularity: 21600
      };

    case '1M':
      return {
        days: 30,
        granularity: 86400
      };

    case '3M':
      return {
        days: 90,
        granularity: 86400
      };

    case '1Y':
      return {
        days: 365,
        granularity: 86400
      };

    default:
      return {
        days: 30,
        granularity: 86400
      };
  }

}

app.get('/chart/:symbol', async (req, res) => {

  try {

    const symbol =
      req.params.symbol.toUpperCase();

    const range =
      req.query.range || '1D';

    const config =
      getChartConfig(range);

    const end =
      new Date();

    const start =
      new Date(
        end.getTime() -
        config.days *
        24 *
        60 *
        60 *
        1000
      );

    const response =
      await axios.get(
        `https://api.exchange.coinbase.com/products/${symbol}-USD/candles`,
        {
          params: {
            start: start.toISOString(),
            end: end.toISOString(),
            granularity: config.granularity
          }
        }
      );

    const chartData =
      response.data
        .map((candle) => ({
          time: candle[0],
          price: candle[4]
        }))
        .reverse();

    res.json(chartData);

  } catch (e) {

    console.log(
      'Chart Error:',
      e.message
    );

    res.status(500).json({
      error: e.message
    });

  }

});

loadTopCoins();

app.listen(PORT, () => {

  console.log(
    `Server running on ${PORT}`
  );

});