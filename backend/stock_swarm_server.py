"""Standalone Flask server for the stock-swarm wave-field viz.

Lives beside the MiroFish backend but does NOT import any of its LLM /
Zep / camel-oasis stack. Install surface: Flask + flask-cors +
yfinance (optional). Serves:

  GET /api/stock-swarm/prices?period=2y  — historical closes (yfinance,
                                           6h disk cache, falls back
                                           to the shipped stub)
  GET /healthz                           — liveness
  GET /*                                 — static files from the frontend
                                           build output (SPA fallback to
                                           index.html)

Intended for Railway / Fly / Render: reads $PORT, binds 0.0.0.0.
"""

import json
import os
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

TICKERS = [
    ('SPY', 1, 'S&P 500 ETF'), ('QQQ', 1, 'Nasdaq 100 ETF'),
    ('XLF', 1, 'Financials ETF'), ('TLT', 1, '20+yr Treasury ETF'),
    ('AAPL', 2, 'Apple'), ('MSFT', 2, 'Microsoft'), ('GOOGL', 2, 'Alphabet'),
    ('AMZN', 2, 'Amazon'), ('META', 2, 'Meta Platforms'),
    ('NVDA', 2, 'NVIDIA'), ('TSLA', 2, 'Tesla'),
    ('TSM', 3, 'TSMC'), ('AVGO', 3, 'Broadcom'), ('AMD', 3, 'AMD'),
    ('INTC', 3, 'Intel'), ('MU', 3, 'Micron'), ('QCOM', 3, 'Qualcomm'),
    ('ASML', 3, 'ASML'),
    ('CRM', 4, 'Salesforce'), ('ORCL', 4, 'Oracle'),
    ('ADBE', 4, 'Adobe'), ('NOW', 4, 'ServiceNow'),
    ('JPM', 5, 'JPMorgan Chase'), ('BAC', 5, 'Bank of America'),
    ('WFC', 5, 'Wells Fargo'), ('GS', 5, 'Goldman Sachs'),
    ('MS', 5, 'Morgan Stanley'), ('C', 5, 'Citigroup'),
    ('XOM', 6, 'Exxon Mobil'), ('CVX', 6, 'Chevron'),
    ('COP', 6, 'ConocoPhillips'), ('SLB', 6, 'Schlumberger'),
    ('UPS', 7, 'UPS'), ('FDX', 7, 'FedEx'),
    ('DAL', 7, 'Delta Air Lines'), ('UAL', 7, 'United Airlines'),
    ('UNH', 8, 'UnitedHealth'), ('JNJ', 8, 'Johnson & Johnson'),
    ('LLY', 8, 'Eli Lilly'), ('PFE', 8, 'Pfizer'),
    ('WMT', 9, 'Walmart'), ('COST', 9, 'Costco'),
    ('HD', 9, 'Home Depot'), ('TGT', 9, 'Target'),
    ('V', 10, 'Visa'), ('MA', 10, 'Mastercard'), ('PYPL', 10, 'PayPal'),
    ('GLD', 11, 'Gold ETF'), ('NEM', 11, 'Newmont'), ('GOLD', 11, 'Barrick Gold'),
]

PARENTS = {
    'QQQ':   [('SPY', 0.6)], 'XLF':   [('SPY', 0.5)],
    'AAPL':  [('QQQ', 0.55), ('SPY', 0.2)],  'MSFT':  [('QQQ', 0.55), ('SPY', 0.2)],
    'GOOGL': [('QQQ', 0.55), ('SPY', 0.15)], 'AMZN':  [('QQQ', 0.55), ('SPY', 0.15)],
    'META':  [('QQQ', 0.55), ('SPY', 0.1)],  'NVDA':  [('QQQ', 0.5),  ('SPY', 0.1)],
    'TSLA':  [('QQQ', 0.4),  ('SPY', 0.1)],
    'TSM':   [('NVDA', 0.35), ('AAPL', 0.25), ('QQQ', 0.2)],
    'AVGO':  [('NVDA', 0.35), ('AAPL', 0.2),  ('QQQ', 0.2)],
    'AMD':   [('NVDA', 0.55), ('QQQ', 0.2)],  'INTC':  [('NVDA', 0.25), ('QQQ', 0.25)],
    'MU':    [('NVDA', 0.35), ('QQQ', 0.25)], 'QCOM':  [('AAPL', 0.35), ('QQQ', 0.25)],
    'ASML':  [('NVDA', 0.3),  ('TSM', 0.3), ('QQQ', 0.2)],
    'CRM':   [('MSFT', 0.35), ('QQQ', 0.25)], 'ORCL':  [('MSFT', 0.3),  ('QQQ', 0.25)],
    'ADBE':  [('MSFT', 0.3),  ('GOOGL', 0.2), ('QQQ', 0.2)],
    'NOW':   [('MSFT', 0.35), ('QQQ', 0.25)],
    'JPM':   [('XLF', 0.55), ('SPY', 0.15), ('TLT', -0.15)],
    'BAC':   [('XLF', 0.6),  ('JPM', 0.2),  ('TLT', -0.15)],
    'WFC':   [('XLF', 0.55), ('JPM', 0.2),  ('TLT', -0.15)],
    'GS':    [('XLF', 0.45), ('SPY', 0.2)],  'MS':    [('XLF', 0.45), ('GS', 0.25)],
    'C':     [('XLF', 0.55), ('JPM', 0.2),  ('TLT', -0.1)],
    'XOM':   [('SPY', 0.25)], 'CVX':   [('SPY', 0.2),  ('XOM', 0.5)],
    'COP':   [('XOM', 0.5),  ('SPY', 0.2)],  'SLB':   [('XOM', 0.4),  ('CVX', 0.3)],
    'UPS':   [('SPY', 0.3),  ('XOM', -0.25)],
    'FDX':   [('SPY', 0.3),  ('XOM', -0.25), ('UPS', 0.25)],
    'DAL':   [('SPY', 0.25), ('XOM', -0.45)],
    'UAL':   [('SPY', 0.25), ('XOM', -0.45), ('DAL', 0.35)],
    'UNH':   [('SPY', 0.35)], 'JNJ':   [('SPY', 0.3)], 'LLY':   [('SPY', 0.25)],
    'PFE':   [('SPY', 0.3),  ('JNJ', 0.2)],
    'WMT':   [('SPY', 0.35)], 'COST':  [('SPY', 0.3),  ('WMT', 0.25)],
    'HD':    [('SPY', 0.3),  ('TLT', 0.15)], 'TGT':   [('SPY', 0.3),  ('WMT', 0.35)],
    'V':     [('SPY', 0.3),  ('QQQ', 0.2)],  'MA':    [('V', 0.7),    ('SPY', 0.15)],
    'PYPL':  [('V', 0.25),   ('QQQ', 0.3)],
    'GLD':   [('SPY', -0.25), ('TLT', 0.2)], 'NEM':   [('GLD', 0.65), ('SPY', -0.1)],
    'GOLD':  [('GLD', 0.65), ('NEM', 0.2)],
}

CACHE_DIR = Path(os.environ.get('STOCK_SWARM_CACHE', '/tmp/stock_swarm_cache'))
CACHE_TTL_SEC = 60 * 60 * 6
STATIC_DIR = Path(os.environ.get(
    'STOCK_SWARM_STATIC',
    Path(__file__).resolve().parent.parent / 'frontend' / 'dist'
))


def _meta():
    return [
        {
            'symbol': sym, 'name': name, 'tier': tier,
            'parents': [{'symbol': p, 'weight': w} for p, w in PARENTS.get(sym, [])],
        }
        for sym, tier, name in TICKERS
    ]


def _cache_path(period):
    return CACHE_DIR / f'prices_{period}.json'


def _load_cache(period):
    p = _cache_path(period)
    if not p.exists() or time.time() - p.stat().st_mtime > CACHE_TTL_SEC:
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def _save_cache(period, payload):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _cache_path(period).write_text(json.dumps(payload))


def _fetch_yf(period):
    try:
        import yfinance as yf
    except ImportError:
        return None
    try:
        symbols = [s for s, _, _ in TICKERS]
        df = yf.download(
            tickers=' '.join(symbols), period=period, interval='1d',
            auto_adjust=True, progress=False, group_by='ticker', threads=True,
        )
        if df is None or df.empty:
            return None
        prices, dates = {}, None
        for sym in symbols:
            try:
                s = df[sym]['Close']
            except (KeyError, TypeError):
                continue
            s = s.dropna()
            if s.empty:
                continue
            if dates is None:
                dates = [d.strftime('%Y-%m-%d') for d in s.index]
            prices[sym] = [float(round(v, 4)) for v in s.values]
        if not prices or dates is None:
            return None
        return {
            'source': 'yfinance',
            'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'period': period, 'days': len(dates), 'dates': dates,
            'tickers': _meta(), 'prices': prices,
        }
    except Exception as exc:
        print(f'[stock-swarm] yfinance fetch failed: {exc}', flush=True)
        return None


def create_app():
    app = Flask(__name__, static_folder=None)
    CORS(app, resources={r'/api/*': {'origins': '*'}})

    @app.route('/healthz')
    def healthz():
        return {'status': 'ok', 'service': 'stock-swarm'}

    @app.route('/api/stock-swarm/prices')
    def prices():
        period = request.args.get('period', '2y')
        if period not in {'1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max'}:
            period = '2y'
        cached = _load_cache(period)
        if cached is not None:
            return jsonify(cached)
        payload = _fetch_yf(period)
        if payload is not None:
            _save_cache(period, payload)
            return jsonify(payload)
        return jsonify({
            'source': 'stub',
            'fallback_reason': 'yfinance_unavailable_or_failed',
            'stub_url': '/stock-swarm/stub.json',
            'tickers': _meta(),
        })

    # SPA static serving: exact files first, index.html fallback for client routes.
    @app.route('/', defaults={'path': ''})
    @app.route('/<path:path>')
    def spa(path):
        if not STATIC_DIR.exists():
            return jsonify({'error': 'static dist not built', 'expected': str(STATIC_DIR)}), 500
        target = STATIC_DIR / path
        if path and target.is_file():
            return send_from_directory(STATIC_DIR, path)
        return send_from_directory(STATIC_DIR, 'index.html')

    return app


app = create_app()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(host='0.0.0.0', port=port)
