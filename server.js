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
  MANA: 'Decentraland',
  CRO: 'Cronos',
  VET: 'VeChain',
  HBAR: 'Hedera',
  QNT: 'Quant',
  IMX: 'Immutable',
  STX: 'Stacks',
  KAS: 'Kaspa',
  RUNE: 'THORChain',
  FTM: 'Fantom',
  NEO: 'NEO',
  KAVA: 'Kava',
  CAKE: 'PancakeSwap',
  CHZ: 'Chiliz',
  COMP: 'Compound',
  DASH: 'Dash',
  ZEC: 'Zcash',
  ENJ: 'Enjin Coin',
  BAT: 'Basic Attention Token',
  CRV: 'Curve DAO',
  LDO: 'Lido DAO',
  SNX: 'Synthetix',
  ONE: 'Harmony',
  ROSE: 'Oasis Network',
  MINA: 'Mina',
  CELO: 'Celo',
  KSM: 'Kusama',
  WAVES: 'Waves',
  HOT: 'Holo',
  ZIL: 'Zilliqa'

};

const orderedSymbols = [

  'BTC',
  'ETH',
  'SOL',
  'BNB',
  'XRP',
  'DOGE',
  'ADA',
  'AVAX',
  'LINK',
  'DOT',
  'LTC',
  'TRX',
  'MATIC',
  'ATOM',
  'UNI',
  'ETC',
  'XLM',
  'FIL',
  'AAVE',
  'EOS',
  'ICP',
  'APT',
  'ARB',
  'OP',
  'NEAR',
  'PEPE',
  'SHIB',
  'SUI',
  'INJ',
  'SEI',
  'BONK',
  'TIA',
  'RNDR',
  'GRT',
  'MKR',
  'ALGO',
  'FLOW',
  'XTZ',
  'EGLD',
  'THETA',
  'AXS',
  'SAND',
  'MANA',
  'CRO',
  'VET',
  'HBAR',
  'QNT',
  'IMX',
  'STX',
  'KAS',
  'RUNE',
  'FTM',
  'NEO',
  'KAVA',
  'CAKE',
  'CHZ',
  'COMP',
  'DASH',
  'ZEC',
  'ENJ',
  'BAT',
  'CRV',
  'LDO',
  'SNX',
  'ONE',
  'ROSE',
  'MINA',
  'CELO',
  'KSM',
  'WAVES',
  'HOT',
  'ZIL'

];

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

        product_ids: orderedSymbols.map(
          symbol => `${symbol}-USD`
        )
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

  const sortedPrices = {};

  orderedSymbols.forEach((symbol) => {

    if (prices[symbol]) {
      sortedPrices[symbol] = prices[symbol];
    }

  });

  res.json(sortedPrices);

});

app.listen(PORT, () => {

  console.log(
    `Server running on ${PORT}`
  );

});