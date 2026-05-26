const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());

let prices = {};

async function loadPrices() {

  try {

    const response = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=100&page=1'
    );

    const data = await response.json();

    const filtered = {};

    data.forEach((coin) => {

      filtered[coin.symbol.toUpperCase()] = {
        price: coin.current_price,
        change: coin.price_change_percentage_24h,
        image: coin.image,
        name: coin.name,
      };
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