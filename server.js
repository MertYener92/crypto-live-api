const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();

app.use(cors());

const PORT = process.env.PORT || 10000;

let prices = {};

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

  ATOM: 'Cosmos',
  UNI: 'Uniswap',
  ETC: 'Ethereum Classic',
  XLM: 'Stellar',
  FIL: 'Filecoin',
  AAVE: 'Aave',
  EOS: 'EOS',
  ICP: 'Internet Computer',
  APT: 'Aptos',
  ARB: 'Arbitrum',
  OP: 'Optimism',
  NEAR: 'NEAR Protocol',
  PEPE: 'Pepe',
  SHIB: 'Shiba Inu',
  SUI: 'Sui',
  INJ: 'Injective',
  SEI: 'Sei',
  BONK: 'Bonk',
  TIA: 'Celestia',
  RNDR: 'Render',
  GRT: 'The Graph',
  MKR: 'Maker',
  ALGO: 'Algorand',
  FLOW: 'Flow',
  XTZ: 'Tezos',
  EGLD: 'MultiversX',
  THETA: 'Theta Network',
  AXS: 'Axie Infinity',
  SAND: 'The Sandbox',
  MANA: 'Decentraland'

};

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

          'ATOM-USD',
          'UNI-USD',
          'ETC-USD',
          'XLM-USD',
          'FIL-USD',
          'AAVE-USD',
          'EOS-USD',
          'ICP-USD',
          'APT-USD',
          'ARB-USD',
          'OP-USD',
          'NEAR-USD',
          'PEPE-USD',
          'SHIB-USD',
          'SUI-USD',
          'INJ-USD',
          'SEI-USD',
          'BONK-USD',
          'TIA-USD',
          'RNDR-USD',
          'GRT-USD',
          'MKR-USD',
          'ALGO-USD',
          'FLOW-USD',
          'XTZ-USD',
          'EGLD-USD',
          'THETA-USD',
          'AXS-USD',
          'SAND-USD',
          'MANA-USD'

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

    prices[symbol] = {

      symbol: symbol,

      name:
        coinNames[symbol] ??
        symbol,

      price:
        parseFloat(data.price),

      change:
        parseFloat(data.open_24h)
          ? Number(
              (
                ((parseFloat(data.price) -
                parseFloat(data.open_24h)) /
                parseFloat(data.open_24h)) *
                100
              ).toFixed(2)
            )
          : 0,

      logo:
  `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${symbol.toLowerCase()}.png`

    };
  }
});

ws.on('error', (err) => {

  console.log(
    'WebSocket Error:',
    err
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