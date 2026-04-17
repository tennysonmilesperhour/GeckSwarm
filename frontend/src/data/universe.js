// Primary universe — 100 most-traded / most-influential US-listed tickers
// plus four macro anchors (SPY, QQQ, GLD, TLT). `group` places each into
// a sector / theme used for initial radial clustering; `tier` indicates
// hierarchy depth (1 = primary). Children are declared in
// src/data/children.js so this file stays focused on identity.
//
// List curation rationale: S&P 100 core + key ETFs + sector bellwethers.
// Edit freely — the generator, backend, and viz all key off the symbols
// declared here.

export const ANCHORS = [
  { symbol: 'SPY',  name: 'S&P 500 ETF',         group: 'anchor' },
  { symbol: 'QQQ',  name: 'Nasdaq 100 ETF',      group: 'anchor' },
  { symbol: 'GLD',  name: 'Gold ETF',            group: 'anchor' },
  { symbol: 'TLT',  name: '20+yr Treasury ETF',  group: 'anchor' },
]

export const PRIMARIES = [
  // --- Mega-cap tech / platform (10)
  { symbol: 'AAPL',  name: 'Apple',                group: 'tech-mega' },
  { symbol: 'MSFT',  name: 'Microsoft',            group: 'tech-mega' },
  { symbol: 'GOOGL', name: 'Alphabet',             group: 'tech-mega' },
  { symbol: 'AMZN',  name: 'Amazon',               group: 'tech-mega' },
  { symbol: 'META',  name: 'Meta Platforms',       group: 'tech-mega' },
  { symbol: 'NVDA',  name: 'NVIDIA',               group: 'tech-mega' },
  { symbol: 'TSLA',  name: 'Tesla',                group: 'tech-mega' },
  { symbol: 'AVGO',  name: 'Broadcom',             group: 'tech-mega' },
  { symbol: 'ORCL',  name: 'Oracle',               group: 'tech-mega' },
  { symbol: 'CRM',   name: 'Salesforce',           group: 'tech-mega' },

  // --- Semiconductors (6)
  { symbol: 'TSM',   name: 'TSMC',                 group: 'semis' },
  { symbol: 'AMD',   name: 'AMD',                  group: 'semis' },
  { symbol: 'QCOM',  name: 'Qualcomm',             group: 'semis' },
  { symbol: 'INTC',  name: 'Intel',                group: 'semis' },
  { symbol: 'MU',    name: 'Micron',               group: 'semis' },
  { symbol: 'ASML',  name: 'ASML',                 group: 'semis' },
  { symbol: 'AMAT',  name: 'Applied Materials',    group: 'semis' },

  // --- Enterprise software / networking (5)
  { symbol: 'ADBE',  name: 'Adobe',                group: 'software' },
  { symbol: 'NOW',   name: 'ServiceNow',           group: 'software' },
  { symbol: 'INTU',  name: 'Intuit',               group: 'software' },
  { symbol: 'IBM',   name: 'IBM',                  group: 'software' },
  { symbol: 'CSCO',  name: 'Cisco',                group: 'software' },

  // --- Media / consumer platforms (4)
  { symbol: 'NFLX',  name: 'Netflix',              group: 'media' },
  { symbol: 'DIS',   name: 'Disney',               group: 'media' },
  { symbol: 'UBER',  name: 'Uber',                 group: 'media' },
  { symbol: 'CMCSA', name: 'Comcast',              group: 'media' },

  // --- Banks (6)
  { symbol: 'JPM',   name: 'JPMorgan Chase',       group: 'banks' },
  { symbol: 'BAC',   name: 'Bank of America',      group: 'banks' },
  { symbol: 'WFC',   name: 'Wells Fargo',          group: 'banks' },
  { symbol: 'C',     name: 'Citigroup',            group: 'banks' },
  { symbol: 'GS',    name: 'Goldman Sachs',        group: 'banks' },
  { symbol: 'MS',    name: 'Morgan Stanley',       group: 'banks' },

  // --- Insurance / holdings (3)
  { symbol: 'BRK-B', name: 'Berkshire Hathaway',   group: 'insurance' },
  { symbol: 'PGR',   name: 'Progressive',          group: 'insurance' },
  { symbol: 'ALL',   name: 'Allstate',             group: 'insurance' },

  // --- Payments (4)
  { symbol: 'V',     name: 'Visa',                 group: 'payments' },
  { symbol: 'MA',    name: 'Mastercard',           group: 'payments' },
  { symbol: 'PYPL',  name: 'PayPal',               group: 'payments' },
  { symbol: 'AXP',   name: 'American Express',     group: 'payments' },

  // --- Asset managers / ratings (3)
  { symbol: 'BLK',   name: 'BlackRock',            group: 'assetmgr' },
  { symbol: 'SCHW',  name: 'Charles Schwab',       group: 'assetmgr' },
  { symbol: 'SPGI',  name: 'S&P Global',           group: 'assetmgr' },

  // --- Pharma (7)
  { symbol: 'JNJ',   name: 'Johnson & Johnson',    group: 'pharma' },
  { symbol: 'PFE',   name: 'Pfizer',               group: 'pharma' },
  { symbol: 'LLY',   name: 'Eli Lilly',            group: 'pharma' },
  { symbol: 'MRK',   name: 'Merck',                group: 'pharma' },
  { symbol: 'ABBV',  name: 'AbbVie',               group: 'pharma' },
  { symbol: 'BMY',   name: 'Bristol-Myers Squibb', group: 'pharma' },
  { symbol: 'AMGN',  name: 'Amgen',                group: 'pharma' },

  // --- Healthcare services / payers (5)
  { symbol: 'UNH',   name: 'UnitedHealth',         group: 'health-svc' },
  { symbol: 'CVS',   name: 'CVS Health',           group: 'health-svc' },
  { symbol: 'CI',    name: 'Cigna',                group: 'health-svc' },
  { symbol: 'HUM',   name: 'Humana',               group: 'health-svc' },
  { symbol: 'GILD',  name: 'Gilead Sciences',      group: 'health-svc' },

  // --- Medical devices & tools (5)
  { symbol: 'MDT',   name: 'Medtronic',            group: 'medtech' },
  { symbol: 'BSX',   name: 'Boston Scientific',    group: 'medtech' },
  { symbol: 'SYK',   name: 'Stryker',              group: 'medtech' },
  { symbol: 'TMO',   name: 'Thermo Fisher',        group: 'medtech' },
  { symbol: 'DHR',   name: 'Danaher',              group: 'medtech' },

  // --- Oil & gas (5)
  { symbol: 'XOM',   name: 'Exxon Mobil',          group: 'energy' },
  { symbol: 'CVX',   name: 'Chevron',              group: 'energy' },
  { symbol: 'COP',   name: 'ConocoPhillips',       group: 'energy' },
  { symbol: 'EOG',   name: 'EOG Resources',        group: 'energy' },
  { symbol: 'SLB',   name: 'Schlumberger',         group: 'energy' },

  // --- Consumer staples (6)
  { symbol: 'WMT',   name: 'Walmart',              group: 'staples' },
  { symbol: 'COST',  name: 'Costco',               group: 'staples' },
  { symbol: 'PG',    name: 'Procter & Gamble',     group: 'staples' },
  { symbol: 'KO',    name: 'Coca-Cola',            group: 'staples' },
  { symbol: 'PEP',   name: 'PepsiCo',              group: 'staples' },
  { symbol: 'MDLZ',  name: 'Mondelez',             group: 'staples' },

  // --- Consumer discretionary (6)
  { symbol: 'HD',    name: 'Home Depot',           group: 'discretionary' },
  { symbol: 'LOW',   name: 'Lowe\u2019s',          group: 'discretionary' },
  { symbol: 'MCD',   name: 'McDonald\u2019s',      group: 'discretionary' },
  { symbol: 'SBUX',  name: 'Starbucks',            group: 'discretionary' },
  { symbol: 'NKE',   name: 'Nike',                 group: 'discretionary' },
  { symbol: 'TJX',   name: 'TJX Companies',        group: 'discretionary' },

  // --- Transport / logistics (4)
  { symbol: 'UPS',   name: 'UPS',                  group: 'transport' },
  { symbol: 'FDX',   name: 'FedEx',                group: 'transport' },
  { symbol: 'UNP',   name: 'Union Pacific',        group: 'transport' },
  { symbol: 'DAL',   name: 'Delta Air Lines',      group: 'transport' },

  // --- Industrials (5)
  { symbol: 'BA',    name: 'Boeing',               group: 'industrials' },
  { symbol: 'CAT',   name: 'Caterpillar',          group: 'industrials' },
  { symbol: 'HON',   name: 'Honeywell',            group: 'industrials' },
  { symbol: 'GE',    name: 'General Electric',     group: 'industrials' },
  { symbol: 'LMT',   name: 'Lockheed Martin',      group: 'industrials' },

  // --- Materials (3)
  { symbol: 'LIN',   name: 'Linde',                group: 'materials' },
  { symbol: 'SHW',   name: 'Sherwin-Williams',     group: 'materials' },
  { symbol: 'FCX',   name: 'Freeport-McMoRan',     group: 'materials' },

  // --- Telecom (2)
  { symbol: 'VZ',    name: 'Verizon',              group: 'telecom' },
  { symbol: 'T',     name: 'AT&T',                 group: 'telecom' },

  // --- Utilities (2)
  { symbol: 'DUK',   name: 'Duke Energy',          group: 'utilities' },
  { symbol: 'NEE',   name: 'NextEra Energy',       group: 'utilities' },
  { symbol: 'SO',    name: 'Southern Company',     group: 'utilities' },

  // --- REITs (2)
  { symbol: 'PLD',   name: 'Prologis',             group: 'reits' },
  { symbol: 'AMT',   name: 'American Tower',       group: 'reits' },

  // --- Gold miners (2)
  { symbol: 'NEM',   name: 'Newmont',              group: 'gold' },
  { symbol: 'GOLD',  name: 'Barrick Gold',         group: 'gold' },

  // --- Tobacco (1)
  { symbol: 'PM',    name: 'Philip Morris',        group: 'tobacco' },

  // --- Retail / big-box (2)
  { symbol: 'TGT',   name: 'Target',               group: 'discretionary' },
  { symbol: 'LULU',  name: 'Lululemon',            group: 'discretionary' },
]

// Quick self-check: expected exactly 100 primaries + 4 anchors.
if (typeof process === 'undefined' || process.env.NODE_ENV !== 'production') {
  const total = PRIMARIES.length + ANCHORS.length
  if (PRIMARIES.length !== 100) {
    // Not throwing — some environments (Vite SSR lint) dislike top-level
    // conditionals. A console warn is enough for dev hygiene.

    console.warn(`[universe] PRIMARIES length = ${PRIMARIES.length}, expected 100`)
  }
  void total
}

export const UNIVERSE = [...ANCHORS, ...PRIMARIES]
export const UNIVERSE_SYMBOLS = UNIVERSE.map(t => t.symbol)
