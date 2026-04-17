"""Stock-swarm visualization: serve historical OHLC-ish prices for the
hard-coded 50-ticker universe. Uses yfinance when available; falls back
to the shipped stub payload so the viz is never broken by a missing
dependency or network outage."""

import json
import os
import time
from pathlib import Path

from flask import jsonify, request

from . import stock_swarm_bp
from ..utils.logger import get_logger

logger = get_logger('mirofish.stock_swarm')

# 11-tier hierarchy matching frontend/scripts/generate-stub-data.js.
TICKERS = [
    # Tier 1 — macro anchors
    ('SPY', 1, 'S&P 500 ETF'),
    ('QQQ', 1, 'Nasdaq 100 ETF'),
    ('XLF', 1, 'Financials ETF'),
    ('TLT', 1, '20+yr Treasury ETF'),
    # Tier 2 — mega-cap leaders
    ('AAPL', 2, 'Apple'), ('MSFT', 2, 'Microsoft'), ('GOOGL', 2, 'Alphabet'),
    ('AMZN', 2, 'Amazon'), ('META', 2, 'Meta Platforms'),
    ('NVDA', 2, 'NVIDIA'), ('TSLA', 2, 'Tesla'),
    # Tier 3 — semis
    ('TSM', 3, 'TSMC'), ('AVGO', 3, 'Broadcom'), ('AMD', 3, 'AMD'),
    ('INTC', 3, 'Intel'), ('MU', 3, 'Micron'), ('QCOM', 3, 'Qualcomm'),
    ('ASML', 3, 'ASML'),
    # Tier 4 — enterprise software
    ('CRM', 4, 'Salesforce'), ('ORCL', 4, 'Oracle'),
    ('ADBE', 4, 'Adobe'), ('NOW', 4, 'ServiceNow'),
    # Tier 5 — financials
    ('JPM', 5, 'JPMorgan Chase'), ('BAC', 5, 'Bank of America'),
    ('WFC', 5, 'Wells Fargo'), ('GS', 5, 'Goldman Sachs'),
    ('MS', 5, 'Morgan Stanley'), ('C', 5, 'Citigroup'),
    # Tier 6 — energy
    ('XOM', 6, 'Exxon Mobil'), ('CVX', 6, 'Chevron'),
    ('COP', 6, 'ConocoPhillips'), ('SLB', 6, 'Schlumberger'),
    # Tier 7 — transport
    ('UPS', 7, 'UPS'), ('FDX', 7, 'FedEx'),
    ('DAL', 7, 'Delta Air Lines'), ('UAL', 7, 'United Airlines'),
    # Tier 8 — healthcare
    ('UNH', 8, 'UnitedHealth'), ('JNJ', 8, 'Johnson & Johnson'),
    ('LLY', 8, 'Eli Lilly'), ('PFE', 8, 'Pfizer'),
    # Tier 9 — consumer
    ('WMT', 9, 'Walmart'), ('COST', 9, 'Costco'),
    ('HD', 9, 'Home Depot'), ('TGT', 9, 'Target'),
    # Tier 10 — payments
    ('V', 10, 'Visa'), ('MA', 10, 'Mastercard'), ('PYPL', 10, 'PayPal'),
    # Tier 11 — gold
    ('GLD', 11, 'Gold ETF'), ('NEM', 11, 'Newmont'), ('GOLD', 11, 'Barrick Gold'),
]

# Parent links (for display + future influence overlay). Kept in sync with
# generate-stub-data.js. Real-data loader doesn't need these to function,
# but we echo them back so the frontend can reuse the same schema.
PARENTS = {
    'QQQ':   [('SPY', 0.6)],
    'XLF':   [('SPY', 0.5)],
    'AAPL':  [('QQQ', 0.55), ('SPY', 0.2)],
    'MSFT':  [('QQQ', 0.55), ('SPY', 0.2)],
    'GOOGL': [('QQQ', 0.55), ('SPY', 0.15)],
    'AMZN':  [('QQQ', 0.55), ('SPY', 0.15)],
    'META':  [('QQQ', 0.55), ('SPY', 0.1)],
    'NVDA':  [('QQQ', 0.5),  ('SPY', 0.1)],
    'TSLA':  [('QQQ', 0.4),  ('SPY', 0.1)],
    'TSM':   [('NVDA', 0.35), ('AAPL', 0.25), ('QQQ', 0.2)],
    'AVGO':  [('NVDA', 0.35), ('AAPL', 0.2),  ('QQQ', 0.2)],
    'AMD':   [('NVDA', 0.55), ('QQQ', 0.2)],
    'INTC':  [('NVDA', 0.25), ('QQQ', 0.25)],
    'MU':    [('NVDA', 0.35), ('QQQ', 0.25)],
    'QCOM':  [('AAPL', 0.35), ('QQQ', 0.25)],
    'ASML':  [('NVDA', 0.3),  ('TSM', 0.3), ('QQQ', 0.2)],
    'CRM':   [('MSFT', 0.35), ('QQQ', 0.25)],
    'ORCL':  [('MSFT', 0.3),  ('QQQ', 0.25)],
    'ADBE':  [('MSFT', 0.3),  ('GOOGL', 0.2), ('QQQ', 0.2)],
    'NOW':   [('MSFT', 0.35), ('QQQ', 0.25)],
    'JPM':   [('XLF', 0.55), ('SPY', 0.15), ('TLT', -0.15)],
    'BAC':   [('XLF', 0.6),  ('JPM', 0.2),  ('TLT', -0.15)],
    'WFC':   [('XLF', 0.55), ('JPM', 0.2),  ('TLT', -0.15)],
    'GS':    [('XLF', 0.45), ('SPY', 0.2)],
    'MS':    [('XLF', 0.45), ('GS', 0.25)],
    'C':     [('XLF', 0.55), ('JPM', 0.2),  ('TLT', -0.1)],
    'XOM':   [('SPY', 0.25)],
    'CVX':   [('SPY', 0.2),  ('XOM', 0.5)],
    'COP':   [('XOM', 0.5),  ('SPY', 0.2)],
    'SLB':   [('XOM', 0.4),  ('CVX', 0.3)],
    'UPS':   [('SPY', 0.3),  ('XOM', -0.25)],
    'FDX':   [('SPY', 0.3),  ('XOM', -0.25), ('UPS', 0.25)],
    'DAL':   [('SPY', 0.25), ('XOM', -0.45)],
    'UAL':   [('SPY', 0.25), ('XOM', -0.45), ('DAL', 0.35)],
    'UNH':   [('SPY', 0.35)],
    'JNJ':   [('SPY', 0.3)],
    'LLY':   [('SPY', 0.25)],
    'PFE':   [('SPY', 0.3),  ('JNJ', 0.2)],
    'WMT':   [('SPY', 0.35)],
    'COST':  [('SPY', 0.3),  ('WMT', 0.25)],
    'HD':    [('SPY', 0.3),  ('TLT', 0.15)],
    'TGT':   [('SPY', 0.3),  ('WMT', 0.35)],
    'V':     [('SPY', 0.3),  ('QQQ', 0.2)],
    'MA':    [('V', 0.7),    ('SPY', 0.15)],
    'PYPL':  [('V', 0.25),   ('QQQ', 0.3)],
    'GLD':   [('SPY', -0.25), ('TLT', 0.2)],
    'NEM':   [('GLD', 0.65), ('SPY', -0.1)],
    'GOLD':  [('GLD', 0.65), ('NEM', 0.2)],
}

CACHE_DIR = Path(os.environ.get('STOCK_SWARM_CACHE', '/tmp/stock_swarm_cache'))
CACHE_TTL_SEC = 60 * 60 * 6  # 6h — intraday re-fetch not needed for this viz


def _cache_path(period: str) -> Path:
    return CACHE_DIR / f'prices_{period}.json'


def _load_cache(period: str):
    path = _cache_path(period)
    if not path.exists():
        return None
    if time.time() - path.stat().st_mtime > CACHE_TTL_SEC:
        return None
    try:
        with path.open() as f:
            return json.load(f)
    except Exception:
        return None


def _save_cache(period: str, payload: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with _cache_path(period).open('w') as f:
        json.dump(payload, f)


def _build_meta():
    return [
        {
            'symbol': sym,
            'name': name,
            'tier': tier,
            'parents': [{'symbol': p, 'weight': w} for p, w in PARENTS.get(sym, [])],
        }
        for sym, tier, name in TICKERS
    ]


def _fetch_with_yfinance(period: str):
    """Attempt to pull prices. Returns payload on success, None on failure."""
    try:
        import yfinance as yf  # noqa: WPS433 — optional dep
    except ImportError:
        return None
    try:
        symbols = [s for s, _, _ in TICKERS]
        df = yf.download(
            tickers=' '.join(symbols),
            period=period,
            interval='1d',
            auto_adjust=True,
            progress=False,
            group_by='ticker',
            threads=True,
        )
        if df is None or df.empty:
            return None

        prices = {}
        dates = None
        for sym in symbols:
            try:
                series = df[sym]['Close']
            except (KeyError, TypeError):
                continue
            series = series.dropna()
            if series.empty:
                continue
            if dates is None:
                dates = [d.strftime('%Y-%m-%d') for d in series.index]
            prices[sym] = [float(round(v, 4)) for v in series.values]

        if not prices or dates is None:
            return None

        return {
            'source': 'yfinance',
            'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'period': period,
            'days': len(dates),
            'dates': dates,
            'tickers': _build_meta(),
            'prices': prices,
        }
    except Exception as exc:  # noqa: BLE001 — we intentionally fall back
        logger.warning('yfinance fetch failed: %s', exc)
        return None


@stock_swarm_bp.route('/prices', methods=['GET'])
def get_prices():
    period = request.args.get('period', '2y')
    if period not in {'1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max'}:
        period = '2y'

    cached = _load_cache(period)
    if cached is not None:
        return jsonify(cached)

    payload = _fetch_with_yfinance(period)
    if payload is not None:
        _save_cache(period, payload)
        return jsonify(payload)

    # Fallback: tell the client to use the shipped stub.
    return jsonify({
        'source': 'stub',
        'fallback_reason': 'yfinance_unavailable_or_failed',
        'stub_url': '/stock-swarm/stub.json',
        'tickers': _build_meta(),
    }), 200
