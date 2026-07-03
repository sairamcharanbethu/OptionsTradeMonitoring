import ibPkg from '@stoqey/ib';

  const { IBApi, EventName, SecType } = ibPkg as any;

  const host = process.env.IBKR_HOST || 'ib_gateway';
  const port = Number(process.env.IBKR_PORT || 4003);
  const clientId = Number(process.env.IBKR_CLIENT_ID || 22);

  const ib = new IBApi({ host, port, clientId });

  const REQ_SPY_CONTRACT = 2001;
  const REQ_CHAIN = 2002;
  let nextTickerId = 3000;

  let spyConId: number | null = null;
  let spySpot: number | null = null;
  let selectedExpiry: string | null = null;
  const quotes: Record<number, any> = {};

  function validPrice(value: any) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function fieldName(field: number) {
    return ({
      1: 'bid',
      2: 'ask',
      4: 'last',
      6: 'high',
      7: 'low',
      9: 'close',
      14: 'open',
    } as Record<number, string>)[field] || `field_${field}`;
  }

  function todayYmd() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  function summarizeAndExit() {
    const rows = Object.values(quotes).map((q: any) => {
      const bid = validPrice(q.bid);
      const ask = validPrice(q.ask);
      const mid = bid && ask ? Number(((bid + ask) / 2).toFixed(2)) : null;
      const spreadPct = bid && ask && mid ? Number((((ask - bid) / mid) * 100).toFixed(2)) : null;
      return {
        localSymbol: q.localSymbol,
        right: q.right,
        strike: q.strike,
        bid,
        ask,
        last: validPrice(q.last),
        mid,
        spreadPct,
        volume: q.volume ?? null,
        openInterest: q.openInterest ?? null,
        delta: q.delta ?? null,
        gamma: q.gamma ?? null,
        theta: q.theta ?? null,
        impliedVolatility: q.impliedVolatility ?? null,
      };
    });

    console.log(JSON.stringify({
      connected: ib.isConnected,
      spy: { conId: spyConId, spot: spySpot },
      optionChain: { expiry: selectedExpiry, quotes: rows },
    }, null, 2));

    try {
      for (const id of Object.keys(quotes).map(Number)) ib.cancelMktData(id);
    } catch {}

    ib.disconnect();
    process.exit(0);
  }

  ib.on(EventName.error, (err: any, code: any, reqId: any) => {
    console.error('IBKR error:', { message: err?.message || String(err), code, reqId });
  });

  ib.once(EventName.nextValidId, () => {
    console.log(`Connected to IBKR at ${host}:${port}`);
    ib.reqMarketDataType(1);

    const spy = {
      symbol: 'SPY',
      secType: SecType.STK,
      exchange: 'SMART',
      currency: 'USD',
    };

    ib.reqContractDetails(REQ_SPY_CONTRACT, spy);
    ib.reqMktData(REQ_SPY_CONTRACT + 10, spy, '', false, false);
  });

  ib.on(EventName.contractDetails, (reqId: number, details: any) => {
    if (reqId !== REQ_SPY_CONTRACT) return;

    spyConId = details.contract.conId;
    console.log('SPY contract resolved:', {
      conId: spyConId,
      symbol: details.contract.symbol,
      exchange: details.contract.exchange,
    });

    ib.reqSecDefOptParams(REQ_CHAIN, 'SPY', '', 'STK', spyConId);
  });

  ib.on(EventName.tickPrice, (tickerId: number, field: number, price: number) => {
    const name = fieldName(field);

    if (tickerId === REQ_SPY_CONTRACT + 10) {
      if (['last', 'close', 'bid', 'ask'].includes(name)) {
        const p = validPrice(price);
        if (p && !spySpot) spySpot = p;
      }
      return;
    }

    if (!quotes[tickerId]) return;
    quotes[tickerId][name] = price;
  });

  ib.on(EventName.tickSize, (tickerId: number, field: number, size: number) => {
    if (!quotes[tickerId]) return;

    // IB tick sizes: 8 is volume. 27/28 are option call/put open interest in many feeds.
    if (field === 8) quotes[tickerId].volume = size;
    if (field === 27 || field === 28) quotes[tickerId].openInterest = size;
  });

  ib.on(EventName.tickGeneric, (tickerId: number, field: number, value: number) => {
    if (!quotes[tickerId]) return;
    quotes[tickerId][`generic_${field}`] = value;
  });

  ib.on(EventName.tickOptionComputation, (
    tickerId: number,
    tickType: number,
    tickAttrib: any,
    impliedVolatility: number,
    delta: number,
    optPrice: number,
    pvDividend: number,
    gamma: number,
    vega: number,
    theta: number,
    undPrice: number,
  ) => {
    if (!quotes[tickerId]) return;
    if (Number.isFinite(impliedVolatility) && impliedVolatility > 0) quotes[tickerId].impliedVolatility = impliedVolatility;
    if (Number.isFinite(delta) && Math.abs(delta) <= 1) quotes[tickerId].delta = delta;
    if (Number.isFinite(gamma)) quotes[tickerId].gamma = gamma;
    if (Number.isFinite(theta)) quotes[tickerId].theta = theta;
  });

  ib.on(EventName.securityDefinitionOptionParameter, (
    reqId: number,
    exchange: string,
    underlyingConId: number,
    tradingClass: string,
    multiplier: string,
    expirations: string[],
    strikes: number[],
  ) => {
    if (reqId !== REQ_CHAIN) return;
    if (tradingClass !== 'SPY') return;

    const expiry = [...expirations].sort().find((e) => e >= todayYmd()) || [...expirations].sort()[0];
    if (!expiry || selectedExpiry) return;
    selectedExpiry = expiry;

    const spot = spySpot || 746;
    const nearStrikes = [...strikes]
      .map(Number)
      .filter((s) => Number.isFinite(s) && Math.abs(s - spot) <= 3)
      .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))
      .slice(0, 3)
      .sort((a, b) => a - b);

    console.log('SPY option chain selected:', {
      exchange,
      tradingClass,
      multiplier,
      expiry,
      spot,
      nearStrikes,
    });

    for (const strike of nearStrikes) {
      for (const right of ['C', 'P']) {
        const tickerId = nextTickerId++;
        const optionContract = {
          symbol: 'SPY',
          secType: SecType.OPT,
          exchange: 'SMART',
          currency: 'USD',
          lastTradeDateOrContractMonth: expiry,
          strike,
          right,
          multiplier: '100',
          tradingClass: 'SPY',
        };

        quotes[tickerId] = {
          tickerId,
          localSymbol: `SPY ${expiry} ${right} ${strike}`,
          right,
          strike,
        };

        // 100/101 option volume/open interest, 106 implied volatility.
        ib.reqMktData(tickerId, optionContract, '100,101,106', false, false);
      }
    }

    setTimeout(summarizeAndExit, 15000);
  });

  ib.on(EventName.securityDefinitionOptionParameterEnd, (reqId: number) => {
    if (reqId === REQ_CHAIN) console.log('SPY option chain metadata complete');
  });

  ib.connect();
  ib.reqIds();

  setTimeout(() => {
    console.error('Timed out before option quotes completed');
    summarizeAndExit();
  }, 30000);
