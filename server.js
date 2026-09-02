'use strict';

/* ==================================================================
 *  원화 마켓 시세판 — 프록시 서버
 * ==================================================================
 *
 *  [이 파일이 하는 일 세 가지]
 *
 *   (1) public 폴더의 파일(html, css, js)을 브라우저에 내려준다
 *   (2) /api/... 로 들어온 요청을 대신 받아 외부 API에 물어본다
 *   (3) 받아온 답을 잠깐 보관(캐시)해서 같은 질문에 다시 안 나가게 한다
 *
 *  [왜 브라우저가 업비트를 직접 안 부르나?]
 *
 *   업비트는 Origin 헤더가 붙은 요청에 시세 조회를 10초당 1회만 허용한다.
 *   브라우저의 XHR/fetch 는 Origin 을 자동으로 붙이기 때문에 직접 부르면 바로 막힌다.
 *   반면 서버(Node)에서 부르면 Origin 이 없어서 초당 10회를 쓸 수 있다.
 *   → 그래서 서버가 '중간에서 대신 물어봐 주는 심부름꾼(프록시)' 역할을 한다.
 *
 *  [코드 스타일]
 *
 *   학원에서 배운 콜백 스타일 그대로 썼다.
 *   "일이 끝나면 이 함수를 불러줘" 하고 함수를 넘기는 방식.
 *   Promise 로 바꾸는 방법은 README.md 참고.
 * ================================================================== */

const http = require('http');    // 내 서버를 여는 모듈
const https = require('https');  // 외부 API(https 주소)를 부르는 모듈
const fs = require('fs');        // 파일 읽기
const path = require('path');    // 파일 경로 다루기

const PORT = process.env.PORT || 3000;

// 코인게코 키는 없어도 동작한다. 있으면 호출 한도가 넉넉해질 뿐.
// 실행: COINGECKO_API_KEY=내키 node server.js
const COINGECKO_KEY = process.env.COINGECKO_API_KEY || '';

// public 폴더의 절대 경로. __dirname 은 '이 파일이 있는 폴더'.
const PUBLIC_DIR = path.join(__dirname, 'public');


/* ==================================================================
 * 1단계. 외부 주소에서 JSON 하나 받아오기
 * ==================================================================
 *
 *  https.get 은 답이 한 번에 오지 않는다.
 *  데이터가 조각(chunk)으로 나눠서 도착하기 때문에,
 *  'data' 이벤트로 조각을 모으고 'end' 이벤트에서 합친 걸 사용한다.
 *
 *  @param {string}   url      부를 주소
 *  @param {Object}   headers  추가 헤더 (코인게코 키 같은 것)
 *  @param {Function} callback 끝나면 부를 함수. callback(에러, 결과)
 */
function getJSON(url, headers, callback) {
  const options = {
    headers: Object.assign({
      Accept: 'application/json',
      // 코인게코는 User-Agent 없는 요청을 403 으로 거절한다.
      // Node https.get 은 브라우저와 달리 이 헤더를 안 붙인다.
      'User-Agent': 'woori-krw-dashboard/1.0 (educational; local Node proxy)'
    }, headers)
  };
  // ※ 여기에 Origin 헤더를 넣으면 업비트 제한(10초당 1회)에 걸린다. 절대 넣지 말 것.

  const req = https.get(url, options, function (res) {
    let body = '';                 // 도착한 조각을 모아둘 문자열
    res.setEncoding('utf8');       // 한글이 깨지지 않게

    // 조각이 하나 도착할 때마다 뒤에 이어붙인다
    res.on('data', function (chunk) {
      body += chunk;
    });

    // 다 도착했다
    res.on('end', function () {

      // 429 = 너무 많이 불렀음, 418 = 429가 쌓여서 잠시 차단됨
      if (res.statusCode === 429 || res.statusCode === 418) {
        return callback(new Error('요청 한도 초과 (' + res.statusCode + ')'));
      }

      if (res.statusCode !== 200) {
        return callback(new Error('응답 코드 ' + res.statusCode + ' / ' + body.slice(0, 120)));
      }

      // 받은 건 그냥 긴 문자열이다. 객체로 바꿔야 쓸 수 있다.
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        return callback(new Error('JSON 파싱 실패'));
      }

      // 업비트는 '앞으로 몇 번 더 부를 수 있는지'를 헤더로 알려준다.
      // 개발 중에 터미널에서 이 숫자를 보면 캐시가 잘 도는지 확인할 수 있다.
      if (res.headers['remaining-req']) {
        console.log('  ↳ Remaining-Req:', res.headers['remaining-req']);
      }

      callback(null, parsed);   // 에러 없음 + 결과
    });
  });

  // 8초 안에 답이 없으면 포기한다. 안 걸어두면 요청이 영원히 매달려 있을 수 있다.
  req.setTimeout(7000, function () {
    req.destroy(new Error('요청 시간 초과'));
  });

  // 인터넷이 끊겼거나 주소가 틀렸을 때
  req.on('error', function (err) {
    callback(err);
  });
}


/* ==================================================================
 * 2단계. 캐시 — 방금 물어본 건 다시 안 물어보기
 * ==================================================================
 *
 *  이게 없으면 어떻게 되나?
 *   - 사용자가 10명이면 5초마다 업비트에 10번 나간다
 *   - 코인게코 무료 플랜(월 10,000콜)은 반나절이면 소진된다
 *
 *  세 가지 장치를 넣었다.
 *   ① 유효기간(TTL) 안이면 저장해둔 값을 그대로 준다
 *   ② 같은 걸 동시에 여러 명이 물으면 외부 호출은 1번만 하고 나머지는 줄 세운다
 *   ③ 외부 API가 실패하면 유효기간이 지난 값이라도 준다 (화면이 죽지 않게)
 */

const cache = new Map();     // 키 → { data: 저장된 값, at: 저장한 시각 }
const inflight = new Map();  // 키 → [기다리는 콜백들]  ("지금 물어보러 간 중")

/**
 * @param {string}   key      캐시 이름표. 예: 'tickers'
 * @param {number}   ttlMs    유효기간(밀리초). 4000이면 4초
 * @param {Function} loader   실제로 외부에 물어보는 함수. loader(callback)
 * @param {Function} callback 결과를 받을 함수
 */
function cached(key, ttlMs, loader, callback) {
  const hit = cache.get(key);

  // ① 유효기간 안 → 저장된 값을 바로 준다. 외부 호출 없음.
  if (hit && Date.now() - hit.at < ttlMs) {
    return callback(null, hit.data);
  }

  // ② 이미 누가 물어보러 갔다 → 같이 기다린다 (중복 호출 방지)
  const queue = inflight.get(key);
  if (queue) {
    return queue.push(callback);
  }

  // 내가 첫 번째다 → 물어보러 간다고 표시하고 출발
  inflight.set(key, [callback]);

  loader(function (err, data) {
    // 내가 다녀오는 동안 줄 선 사람들을 모두 챙긴다
    const waiters = inflight.get(key) || [];
    inflight.delete(key);

    if (!err) {
      cache.set(key, { data: data, at: Date.now() });   // 성공 → 저장
    }

    waiters.forEach(function (cb) {
      // ③ 실패했지만 예전 값이 남아 있으면 그거라도 준다
      if (err && hit) return cb(null, hit.data);
      cb(err, data);
    });
  });
}


/* ==================================================================
 * 3단계. 외부 API 세 곳
 * ================================================================== */

const UPBIT = 'https://api.upbit.com/v1';
const COINGECKO = 'https://api.coingecko.com/api/v3';

/**
 * 페어(거래쌍) 목록.
 * 'KRW-BTC' 같은 코드와 함께 한글명·영문명이 들어있다.
 * → 검색 기능의 재료. 거의 안 바뀌니까 12시간 캐시.
 */
function loadMarkets(callback) {
  console.log('[호출] 업비트 페어 목록');
  getJSON(UPBIT + '/market/all?is_details=false', {}, callback);
}

/**
 * 원화 마켓 전체의 현재가.
 * quote_currencies=KRW 하나로 원화 마켓 전 종목이 한 번에 온다.
 * 코인마다 따로 부르면 100번 부를 걸 1번에 끝낸다.
 */
function loadTickers(callback) {
  console.log('[호출] 업비트 원화 마켓 현재가');
  getJSON(UPBIT + '/ticker/all?quote_currencies=KRW', {}, callback);
}

/**
 * 시가총액 순위.
 * 업비트에는 없는 데이터라 코인게코에서 따로 가져와 붙인다.
 * 순위는 자주 안 바뀌므로 2분 캐시.
 */
function loadRankings(callback) {
  console.log('[호출] 코인게코 시총 순위');
  const headers = COINGECKO_KEY ? { 'x-cg-demo-api-key': COINGECKO_KEY } : {};
  const url = COINGECKO + '/coins/markets?vs_currency=krw&order=market_cap_desc'
            + '&per_page=250&page=1&sparkline=false';
  getJSON(url, headers, callback);
}


/* ==================================================================
 * 4단계. 세 응답을 하나로 합치기
 * ==================================================================
 *
 *  세 곳에 동시에 물어보고, 셋 다 돌아오면 합친다.
 *  콜백에는 "셋 다 끝났는지" 알려주는 장치가 없어서
 *  pending 이라는 숫자를 3에서 하나씩 깎는 방식으로 직접 센다.
 *
 *  → Promise.all([a, b, c]) 로 바꾸면 이 카운터가 통째로 사라진다.
 *    지금 이 불편함을 겪어두면 Promise가 왜 필요한지 몸으로 알게 된다.
 */
function loadCoins(callback) {
  const box = { markets: null, tickers: null, rankings: [] };  // 받은 걸 담아둘 상자
  let pending = 3;      // 아직 안 돌아온 개수
  let fatal = null;     // 치명적 에러 (이게 있으면 화면을 못 그린다)

  // 하나가 돌아올 때마다 호출되는 함수
  function step(name, err, data) {
    if (err) {
      // 시총 순위는 없어도 시세판은 뜬다 → 실패해도 넘어간다
      if (name !== 'rankings') fatal = err;
      console.warn('[경고] ' + name + ' 실패:', err.message);
    } else {
      box[name] = data;
    }

    pending -= 1;
    if (pending > 0) return;        // 아직 남았다 → 더 기다린다

    // 여기까지 왔으면 셋 다 끝났다
    if (fatal) return callback(fatal);
    callback(null, mergeCoins(box.markets, box.tickers, box.rankings));
  }

  // 세 개를 동시에 출발시킨다 (순서대로 기다리지 않는다)
  cached('markets',  12 * 60 * 60 * 1000, loadMarkets,  function (e, d) { step('markets', e, d); });
  cached('tickers',   4 * 1000,           loadTickers,  function (e, d) { step('tickers', e, d); });
  cached('rankings', 120 * 1000,          loadRankings, function (e, d) { step('rankings', e, d); });
}

/**
 * 서로 다른 세 응답을 화면이 쓰기 좋은 모양 하나로 만든다.
 *
 *  업비트 시세  : { market: 'KRW-BTC', trade_price: 100000000, ... }
 *  업비트 목록  : { market: 'KRW-BTC', korean_name: '비트코인', ... }
 *  코인게코    : { symbol: 'btc', market_cap_rank: 1, ... }
 *
 *  → { market, symbol, koreanName, price, changeRate, rank, ... }
 *
 *  붙이는 기준은 'KRW-BTC' 의 뒷부분인 심볼(BTC).
 */
function mergeCoins(markets, tickers, rankings) {

  // 'KRW-BTC' → 그 페어의 이름 정보. 매번 배열을 뒤지지 않으려고 미리 표를 만든다.
  const metaByMarket = {};
  markets.forEach(function (m) {
    metaByMarket[m.market] = m;
  });

  // 'BTC' → 코인게코 순위 정보
  const rankBySymbol = {};
  rankings.forEach(function (r) {
    const key = String(r.symbol).toUpperCase();
    // 심볼이 겹치는 코인이 있으면 시총이 큰 쪽(먼저 오는 쪽)만 쓴다
    if (!rankBySymbol[key]) rankBySymbol[key] = r;
  });

  return tickers.map(function (t) {
    const symbol = t.market.split('-')[1];       // 'KRW-BTC' → 'BTC'
    const meta = metaByMarket[t.market] || {};
    const rank = rankBySymbol[symbol] || {};

    return {
      market: t.market,
      symbol: symbol,
      koreanName: meta.korean_name || symbol,
      englishName: meta.english_name || symbol,
      price: t.trade_price,                     // 현재가
      changeRate: t.signed_change_rate,         // 전일 종가 대비 비율 (0.023 = +2.3%)
      changePrice: t.signed_change_price,       // 전일 종가 대비 금액
      tradeValue24h: t.acc_trade_price_24h,     // 24시간 거래대금
      high: t.high_price,
      low: t.low_price,
      rank: rank.market_cap_rank || null,       // 코인게코에 없으면 null
      marketCap: rank.market_cap || null,
      image: rank.image || null
    };
  });
}

/**
 * 검색어로 걸러내기.
 * 한글명·영문명·심볼 셋 다 확인하므로
 * '비트코인' / 'bitcoin' / 'BTC' 아무거나 쳐도 걸린다.
 */
function filterCoins(coins, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return coins;              // 검색어가 없으면 전부

  return coins.filter(function (c) {
    return c.koreanName.toLowerCase().indexOf(needle) !== -1
        || c.englishName.toLowerCase().indexOf(needle) !== -1
        || c.symbol.toLowerCase().indexOf(needle) !== -1;
  });
}


/* ==================================================================
 * 5단계. 요청 받아서 나눠주기 (라우팅)
 * ================================================================== */

/** JSON 으로 응답하기 */
function sendJSON(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'          // 시세는 브라우저가 저장하면 안 된다
  });
  res.end(JSON.stringify(payload));
}

// 확장자 → 브라우저에게 알려줄 파일 종류.
// 이걸 안 알려주면 css 를 그냥 글자로 보여준다.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/** public 폴더의 파일을 읽어서 내려주기 */
function sendFile(res, filePath) {
  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('파일을 찾을 수 없습니다.');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
}

const server = http.createServer(function (req, res) {
  // req.url 은 '/api/search?q=비트' 처럼 경로와 물음표 뒤가 섞여 있다.
  // URL 로 감싸면 pathname 과 searchParams 로 깔끔하게 나뉜다.
  const parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const route = parsed.pathname;

  /* --- 코인 목록 / 검색 -------------------------------------------
     둘이 같은 처리다. 검색어가 있으면 거르고, 없으면 전부 준다.
     검색이 서버로 오지만 캐시 덕분에 외부 호출은 거의 안 일어난다. */
  if (route === '/api/coins' || route === '/api/search') {
    const q = parsed.searchParams.get('q');

    return loadCoins(function (err, coins) {
      if (err) {
        return sendJSON(res, 502, { message: '시세를 불러오지 못했습니다. ' + err.message });
      }
      sendJSON(res, 200, {
        updatedAt: Date.now(),
        query: q || '',
        coins: filterCoins(coins, q)
      });
    });
  }

  /* --- 캔들 차트 ---------------------------------------------------
     unit: hour(1시간봉) / day(일봉) / week(주봉) / month(월봉)
     업비트가 이 네 가지를 지원한다. */
  if (route === '/api/candles') {
    const market = parsed.searchParams.get('market') || '';
    const UNITS = {
      hour:  { path: '/candles/minutes/60', count: 48 },
      day:   { path: '/candles/days',       count: 30 },
      week:  { path: '/candles/weeks',      count: 24 },
      month: { path: '/candles/months',     count: 12 }
    };
    const unit = parsed.searchParams.get('unit') || 'day';
    const spec = UNITS[unit];

    if (!spec) {
      return sendJSON(res, 400, { message: 'unit 은 hour, day, week, month 중 하나여야 합니다.' });
    }

    // 사용자가 준 값을 그대로 외부 주소에 붙이면 위험하다. 형식부터 검사.
    if (!/^[A-Z]+-[A-Z0-9]+$/.test(market)) {
      return sendJSON(res, 400, { message: 'market 파라미터가 필요합니다. 예: KRW-BTC' });
    }

    const count = Math.min(Number(parsed.searchParams.get('count')) || spec.count, 200);
    const key = 'candles:' + unit + ':' + market + ':' + count;

    return cached(key, 60 * 1000, function (cb) {
      console.log('[호출] 업비트 캔들', unit, market);
      getJSON(UPBIT + spec.path + '?market=' + market + '&count=' + count, {}, cb);
    }, function (err, candles) {
      if (err) return sendJSON(res, 502, { message: '차트를 불러오지 못했습니다.' });

      // 업비트는 최신 → 과거 순으로 준다. 그래프는 왼쪽이 과거라 뒤집는다.
      sendJSON(res, 200, {
        unit: unit,
        candles: candles.slice().reverse().map(function (c) {
          return { time: c.candle_date_time_kst, close: c.trade_price };
        })
      });
    });
  }

  /* --- 없는 API 경로 ----------------------------------------------- */
  if (route.indexOf('/api/') === 0) {
    return sendJSON(res, 404, { message: '없는 API 경로입니다.' });
  }

  /* --- 그 외에는 public 폴더의 파일 ---------------------------------
     '/' 로 들어오면 index.html 을 준다.
     '../../etc/passwd' 같은 경로로 서버 밖 파일을 훔쳐보지 못하게 정리한다. */
  const safe = path
    .normalize(route === '/' ? '/index.html' : route)
    .replace(/^(\.\.[/\\])+/, '');

  sendFile(res, path.join(PUBLIC_DIR, safe));
});

server.listen(PORT, function () {
  console.log('서버 실행 중 → http://localhost:' + PORT);
  if (!COINGECKO_KEY) {
    console.log('알림: COINGECKO_API_KEY 없이 실행 중입니다. 시총 순위 호출 한도가 낮습니다.');
  }
});
