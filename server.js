const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());

let prices = {};

async function loadPrices() {

  try {

    const response = await fetch(
      'https://api.binance.com/api/v3/ticker/24hr'
    );

    const data = await response.json();

    const filtered = {};

    data.forEach((coin) => {

      if (coin.symbol.endsWith('USDT')) {

        filtered[coin.symbol] = {
          price: coin.lastPrice,
          change: coin.priceChangePercent,
        };
      }
    });

    prices = filtered;

    console.log('prices updated');

  } catch (e) {

    console.log(e);

  }
}

loadPrices();

setInterval(loadPrices, 1000);

app.get('/prices', (req, res) => {

  res.json(prices);

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(`Server running on ${PORT}`);

});