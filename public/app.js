'use strict';

/* ==================================================================
 *  원화 마켓 시세판 — 브라우저 쪽 코드
 * ==================================================================
 *
 *  [읽는 순서]
 *   1. 통신      — 서버에 물어보는 함수 (XHR이 있는 유일한 곳)
 *   2. 상태      — 지금 화면이 어떤 모습이어야 하는지 담아둔 객체
 *   3. 표시 형식 — 숫자를 사람이 읽을 수 있게 바꾸는 함수들
 *   4. 그리기    — 상태를 보고 화면을 만든다
 *   5. 불러오기  — 서버에 물어보고 상태를 갱신한다
 *   6. 조작      — 사용자가 뭔가 했을 때
 *   7. 상세 패널
 *   8. 시작
 *
 *  [전체 흐름]
 *   무슨 일이 생기든 결국 loadList() 하나로 모인다.
 *
 *     검색 입력 ┐
 *     5초 타이머├→ loadList() → requestJSON() → 서버 → state.coins 갱신 → renderRows()
 *     첫 로딩   ┘
 *
 *   "상태를 바꾸고 → 다시 그린다" 만 반복한다.
 *   화면 요소를 직접 하나씩 고치지 않기 때문에 머릿속이 단순해진다.
 * ================================================================== */


/* ==================================================================
 * 1. 통신 — XHR은 전부 여기에만 있다
 * ==================================================================
 *
 *  나중에 Promise로 리팩터링할 때 이 함수 하나만 바꾸면 되고,
 *  아래 400줄은 한 줄도 안 건드려도 된다.
 *  통신 코드를 여기저기 흩어놓지 않는 이유가 이것이다.
 *
 *  @param {string}   url        물어볼 주소
 *  @param {Function} onSuccess  성공하면 부를 함수. 서버가 준 객체가 인자로 들어온다
 *  @param {Function} onError    실패하면 부를 함수
 *  @returns {XMLHttpRequest}    호출한 쪽에서 abort() 할 수 있게 그대로 돌려준다
 */
function requestJSON(url, onSuccess, onError) {
  const xhr = new XMLHttpRequest();

  xhr.open('GET', url, true);       // true = 비동기. 응답을 기다리는 동안 화면이 안 멈춘다
  xhr.responseType = 'json';        // 이걸 정하면 JSON.parse 를 안 해도 된다

  // 응답이 다 왔을 때
  xhr.onload = function () {
    // 200~299 는 성공, 그 외는 실패로 본다
    if (xhr.status >= 200 && xhr.status < 300) {
      onSuccess(xhr.response);
    } else {
      // 서버가 { message: '...' } 형태로 이유를 알려준다
      const message = (xhr.response && xhr.response.message) || ('응답 코드 ' + xhr.status);
      onError(new Error(message));
    }
  };

  xhr.onerror = function () { onError(new Error('네트워크에 연결할 수 없습니다.')); };
  xhr.ontimeout = function () { onError(new Error('응답이 너무 늦습니다.')); };

  // xhr.onabort 는 일부러 비워둔다.
  // 우리가 abort() 로 취소한 요청은 실패가 아니라 '이제 필요 없어진 요청'이다.
  // 여기서 에러 배너를 띄우면 검색할 때마다 빨간 줄이 뜬다.

  xhr.timeout = 8000;
  xhr.send();

  return xhr;
}


/* ==================================================================
 * 2. 상태 — 화면의 모든 것은 이 객체에서 나온다
 * ==================================================================
 *
 *  화면을 고치고 싶으면 state 를 바꾸고 renderRows() 를 부른다.
 *  <td> 를 직접 찾아서 글자를 바꾸는 방식은 쓰지 않는다.
 *  그래야 "지금 화면이 왜 이 모양이지?" 를 state 만 보면 알 수 있다.
 */
const state = {
  coins: [],                    // 서버에서 받은 코인 배열
  query: '',                    // 현재 검색어
  sortKey: 'tradeValue24h',     // 어떤 열로 정렬 중인지
  sortDir: 'desc',              // 'asc' 오름차순 / 'desc' 내림차순
  onlyWatched: false,           // 관심코인만 보기 켜짐 여부
  toneFilter: null,             // null=전체 / 'rise' / 'fall' / 'flat'
  watchlist: loadWatchlist(),   // 관심코인 목록 (브라우저에 저장해둔 것)
  openMarket: null,             // 상세 패널에 열려 있는 코인. 없으면 null
  chartUnit: 'day',             // hour / day / week / month
  lastPrices: {}                // 직전 가격. 값이 바뀐 칸만 깜빡이게 하려고 기억해둔다
};

// 진행 중인 요청들. 새 요청을 보내기 전에 이걸 취소한다.
let listRequest = null;    // 목록 요청
let candleRequest = null;  // 차트 요청

// 타이머 두 개
let searchTimer = null;    // 디바운싱용 (타이핑이 멈추길 기다리는 타이머)
let pollTimer = null;      // 5초마다 갱신하는 타이머

/*  화면 요소를 매번 document.getElementById 로 찾으면 느리고 지저분하다.
    시작할 때 한 번만 찾아서 el 에 모아둔다. */
const el = {
  rows: document.getElementById('rows'),
  search: document.getElementById('search'),
  searchForm: document.getElementById('searchForm'),
  searchBtn: document.getElementById('searchBtn'),
  searchStatus: document.getElementById('searchStatus'),
  onlyWatched: document.getElementById('onlyWatched'),
  toTop: document.getElementById('toTop'),
  banner: document.getElementById('banner'),
  pulse: document.getElementById('pulse'),
  pulseRise: document.getElementById('pulseRise'),
  pulseFall: document.getElementById('pulseFall'),
  pulseFilters: document.getElementById('pulseFilters'),
  pulseCount: document.getElementById('pulseCount'),
  pulseUp: document.getElementById('pulseUp'),
  pulseDown: document.getElementById('pulseDown'),
  pulseFlat: document.getElementById('pulseFlat'),
  updatedAt: document.getElementById('updatedAt'),
  volumeHelpBtn: document.getElementById('volumeHelpBtn'),
  volumeHelp: document.getElementById('volumeHelp'),
  detail: document.getElementById('detail'),
  detailName: document.getElementById('detailName'),
  detailPrice: document.getElementById('detailPrice'),
  detailChange: document.getElementById('detailChange'),
  chartUnits: document.getElementById('chartUnits'),
  detailChart: document.getElementById('detailChart'),
  detailChartMeta: document.getElementById('detailChartMeta'),
  detailHigh: document.getElementById('detailHigh'),
  detailLow: document.getElementById('detailLow'),
  detailCap: document.getElementById('detailCap'),
  detailClose: document.getElementById('detailClose')
};

/*  localStorage 는 브라우저에 문자열만 저장할 수 있다.
    배열을 넣을 땐 JSON.stringify, 꺼낼 땐 JSON.parse. */
function loadWatchlist() {
  try {
    return JSON.parse(localStorage.getItem('watchlist')) || [];
  } catch (e) {
    return [];   // 저장된 값이 깨졌으면 빈 목록으로 시작
  }
}

function saveWatchlist() {
  localStorage.setItem('watchlist', JSON.stringify(state.watchlist));
}


/* ==================================================================
 * 3. 표시 형식 — 숫자를 사람이 읽는 모양으로
 * ==================================================================
 *
 *  API가 주는 값은 100000000, 0.023 같은 날것이다.
 *  이걸 '100,000,000' '+2.30%' 로 바꾸는 일만 여기 모아둔다.
 */

/** 가격. 비트코인(1억)과 소수점 코인(0.3원)을 같은 규칙으로 못 쓴다. */
function formatPrice(value) {
  if (value === null || value === undefined) return '–';
  if (value >= 1000) return value.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
  if (value >= 1)    return value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  return value.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
}

/** 큰 금액. 거래대금 3,482,910,000,000 은 못 읽는다. '3.5조' 로 바꾼다. */
function formatWon(value) {
  if (!value) return '–';
  if (value >= 1e12) return (value / 1e12).toFixed(1) + '조';
  if (value >= 1e8)  return Math.round(value / 1e8).toLocaleString('ko-KR') + '억';
  return Math.round(value).toLocaleString('ko-KR');
}

/** 등락률. 0.023 → '+2.30%' */
function formatRate(rate) {
  const percent = rate * 100;
  const sign = percent > 0 ? '+' : '';   // 음수는 '-' 가 이미 붙어 있다
  return sign + percent.toFixed(2) + '%';
}

/** 상승/하락/보합 중 어느 색인지. CSS 클래스 이름으로 쓴다. */
function toneOf(rate) {
  if (rate > 0) return 'rise';   // 빨강 (국내 관례)
  if (rate < 0) return 'fall';   // 파랑
  return 'flat';
}

function formatClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString('ko-KR', { hour12: false });
}

/**
 * HTML 특수문자 막기.
 * 코인 이름을 그대로 innerHTML 에 넣는데, 만약 이름에 <script> 같은 게 들어있으면
 * 그게 코드로 실행된다(XSS). 그래서 <, >, & 등을 안전한 글자로 바꾼다.
 * 업비트 데이터는 안전하지만, 남이 준 값을 화면에 넣을 땐 항상 이렇게 하는 습관을 들이는 게 좋다.
 */
function escapeHTML(text) {
  return String(text).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}


/* ==================================================================
 * 4. 그리기 — state 를 보고 화면을 만든다
 * ================================================================== */

/**
 * 지금 상태 기준으로 '실제로 보여줄 코인들'을 계산한다.
 * 걸러내기(관심코인) → 정렬 순서.
 * 검색은 서버가 이미 걸러서 주기 때문에 여기서 안 한다.
 */
function visibleCoins() {
  let list = state.coins;

  if (state.onlyWatched) {
    list = list.filter(function (c) {
      return state.watchlist.indexOf(c.market) !== -1;
    });
  }

  if (state.toneFilter) {
    list = list.filter(function (c) {
      return toneOf(c.changeRate) === state.toneFilter;
    });
  }

  const key = state.sortKey;
  const dir = state.sortDir === 'asc' ? 1 : -1;   // 곱해서 방향을 뒤집는 트릭

  // slice() 로 복사한 뒤 정렬한다. sort() 는 원본을 바꿔버리기 때문에
  // state.coins 를 직접 정렬하면 원래 순서를 잃는다.
  const sorted = list.slice().sort(function (a, b) {
    const av = a[key];
    const bv = b[key];

    // 이름은 글자라서 뺄셈이 안 된다. 한글 정렬은 localeCompare 로.
    if (typeof av === 'string') return av.localeCompare(bv, 'ko') * dir;

    // 값이 없는 항목(시총 순위 미등재 등)은 방향과 상관없이 항상 뒤로 보낸다
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;

    return (av - bv) * dir;
  });

  // 관심코인은 정렬과 관계없이 목록 맨 위에 고정한다
  const pinned = [];
  const rest = [];
  sorted.forEach(function (c) {
    if (state.watchlist.indexOf(c.market) !== -1) pinned.push(c);
    else rest.push(c);
  });
  return pinned.concat(rest);
}

/**
 * 표 본문을 다시 그린다.
 * 행을 하나씩 고치는 대신 문자열로 전부 만들어서 한 번에 넣는다.
 * 초보 단계에서는 이 방식이 훨씬 이해하기 쉽고, 100줄 정도는 충분히 빠르다.
 */
function renderRows() {
  const list = visibleCoins();

  // 보여줄 게 없을 때. 상황에 따라 다른 안내를 준다.
  if (!list.length) {
    const toneMsg = {
      rise: '상승 중인 종목이 없습니다.',
      fall: '하락 중인 종목이 없습니다.',
      flat: '변동 없는 종목이 없습니다.'
    };
    const message = state.query
      ? '‘' + escapeHTML(state.query) + '’와(과) 일치하는 코인이 없습니다.'
      : state.onlyWatched
        ? '관심코인이 아직 없습니다. 목록에서 별을 눌러 추가하세요.'
        : (toneMsg[state.toneFilter] || '표시할 코인이 없습니다.');
    el.rows.innerHTML = '<tr class="placeholder"><td colspan="6">' + message + '</td></tr>';
    return;
  }

  el.rows.innerHTML = list.map(function (coin) {
    const tone = toneOf(coin.changeRate);
    const watched = state.watchlist.indexOf(coin.market) !== -1;

    // 직전 가격과 비교해서, 바뀐 칸에만 깜빡임 클래스를 붙인다.
    // 새로 만들어진 요소에 클래스가 붙어 있으면 CSS 애니메이션이 저절로 한 번 실행된다.
    const before = state.lastPrices[coin.market];
    let tick = '';
    if (before !== undefined && before !== coin.price) {
      tick = coin.price > before ? ' tick-up' : ' tick-down';
    }

    // data-market 을 심어두면 나중에 클릭했을 때 어느 코인인지 알 수 있다
    return '<tr data-market="' + coin.market + '"' +
             (state.openMarket === coin.market ? ' class="is-open"' : '') + '>' +
      '<td><button class="star" type="button" aria-pressed="' + watched + '"' +
        ' aria-label="관심코인 ' + (watched ? '해제' : '추가') + '">★</button></td>' +
      '<td class="col-name"><span class="name"><b>' + escapeHTML(coin.koreanName) + '</b>' +
        '<small>' + escapeHTML(coin.symbol) + '</small></span></td>' +
      '<td class="col-num">' + (coin.rank ? coin.rank : '–') + '</td>' +
      '<td class="col-num price ' + tone + tick + '">' + formatPrice(coin.price) + '</td>' +
      '<td class="col-num ' + tone + '">' + formatRate(coin.changeRate) + '</td>' +
      '<td class="col-num">' + formatWon(coin.tradeValue24h) + '</td>' +
    '</tr>';
  }).join('');

  // 다음 갱신 때 비교할 기준을 갱신해둔다
  list.forEach(function (coin) {
    state.lastPrices[coin.market] = coin.price;
  });
}

/**
 * 상단 요약. 상승 종목이 몇 개인지 막대 길이로 보여준다.
 * 숫자를 읽기 전에 '오늘 시장이 빨간지 파란지'가 먼저 보이게 하는 게 목적.
 */
function renderPulse(updatedAt) {
  const all = state.coins;
  if (!all.length) return;

  let up = 0;
  let down = 0;
  all.forEach(function (c) {
    if (c.changeRate > 0) up += 1;
    else if (c.changeRate < 0) down += 1;
  });
  const flat = all.length - up - down;

  el.pulse.hidden = false;
  el.pulseRise.style.width = (up / all.length * 100) + '%';
  el.pulseFall.style.width = (down / all.length * 100) + '%';
  el.pulseCount.textContent = all.length;
  el.pulseUp.textContent = up;
  el.pulseDown.textContent = down;
  el.pulseFlat.textContent = flat;
  el.updatedAt.textContent = formatClock(updatedAt);
  renderToneChips();
}

/** 정렬 중인 열 표시. aria-sort 는 화면에도 보이고 스크린리더도 읽는다. */
function renderSortHeaders() {
  document.querySelectorAll('.board th[data-sort]').forEach(function (th) {
    const arrow = th.querySelector('.sort-arrow');
    if (th.dataset.sort === state.sortKey) {
      th.setAttribute('aria-sort', state.sortDir === 'asc' ? 'ascending' : 'descending');
      if (arrow) arrow.textContent = state.sortDir === 'asc' ? '▲' : '▼';
    } else {
      th.removeAttribute('aria-sort');
      if (arrow) arrow.textContent = '';
    }
  });
}

function renderToneChips() {
  document.querySelectorAll('.pulse__chip').forEach(function (btn) {
    const tone = btn.getAttribute('data-tone') || '';
    const active = tone === '' ? !state.toneFilter : state.toneFilter === tone;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function showBanner(message) {
  el.banner.textContent = message;
  el.banner.hidden = false;
}

function hideBanner() {
  el.banner.hidden = true;
}


/* ==================================================================
 * 5. 불러오기 — 모든 갱신이 이 함수 하나로 모인다
 * ================================================================== */

function loadList() {
  /*  이전 요청이 아직 살아 있으면 취소한다.
      이게 없으면 이런 일이 생긴다.

        '비트' 입력 → 요청 A 출발
        '비트코인' 입력 → 요청 B 출발
        B 응답 도착 → 화면에 비트코인 표시  ✅
        A 응답 도착 → 화면이 '비트' 결과로 덮임  ❌

      먼저 보낸 요청이 늦게 도착할 수 있어서 생기는 문제다(경쟁 상태).
      Promise 로 바꾸면 이 줄이 AbortController 로 바뀐다. */
  if (listRequest) listRequest.abort();

  // 검색어가 있으면 검색 경로로, 없으면 전체 목록 경로로.
  // encodeURIComponent 는 한글이나 &, = 같은 글자를 주소에 안전하게 넣어준다.
  const url = state.query
    ? '/api/search?q=' + encodeURIComponent(state.query)
    : '/api/coins';

  listRequest = requestJSON(url, function (data) {
    listRequest = null;
    hideBanner();

    // 상태를 바꾸고 → 다시 그린다. 이 순서를 항상 지킨다.
    state.coins = data.coins;
    renderRows();
    renderPulse(data.updatedAt);

    el.searchStatus.textContent = state.query ? data.coins.length + '건' : '';

    // 상세 패널이 열려 있으면 그 안의 숫자도 같이 갱신
    if (state.openMarket) refreshDetailNumbers();

  }, function (err) {
    listRequest = null;
    // 실패해도 화면은 그대로 둔다. 마지막에 성공한 시세가 남아 있는 게
    // 빈 화면보다 낫고, 5초 뒤 타이머가 다시 시도한다.
    showBanner('시세를 불러오지 못했습니다: ' + err.message + ' 잠시 후 다시 시도합니다.');
  });
}

function startPolling() {
  stopPolling();                                  // 타이머가 두 개 겹치지 않게 먼저 정리
  pollTimer = setInterval(loadList, 5000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/*  사용자가 다른 탭을 보고 있는 동안에는 요청을 멈춘다.
    안 보는 화면을 갱신하려고 호출 한도를 쓸 이유가 없다.
    돌아오면 즉시 한 번 갱신하고 타이머를 다시 켠다. */
document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    stopPolling();
  } else {
    loadList();
    startPolling();
  }
});


/* ==================================================================
 * 6. 사용자 조작
 * ================================================================== */

/* --- 검색: 디바운싱 ------------------------------------------------
   '비트코인' 을 치면 input 이벤트가 4번 일어난다.
   그때마다 요청하면 4번 나간다.

   타이머를 걸어두고, 다음 글자가 들어오면 그 타이머를 지우고 새로 건다.
   → 타이핑이 250ms 동안 멈췄을 때만 마지막 한 번이 살아남는다. */
function runSearch() {
  clearTimeout(searchTimer);
  state.query = el.search.value.trim();
  loadList();
}

el.search.addEventListener('input', function (event) {
  const value = event.target.value;
  el.searchStatus.textContent = '입력 중…';

  clearTimeout(searchTimer);                 // 예약해둔 요청 취소
  searchTimer = setTimeout(function () {     // 새로 예약
    state.query = value.trim();
    loadList();
  }, 250);
});

el.searchForm.addEventListener('submit', function (event) {
  event.preventDefault();
  runSearch();
});

/* --- 정렬: 이벤트 위임 ---------------------------------------------
   th 6개에 각각 리스너를 붙이지 않고, 부모인 thead 에 하나만 붙인다.
   closest() 로 '클릭된 지점에서 가장 가까운 th' 를 찾는다.
   행이 계속 새로 그려지는 표에서 특히 유용한 패턴이다. */
document.querySelector('.board thead').addEventListener('click', function (event) {
  // ? 설명은 정렬이 아니라 도움말이다
  if (event.target.closest('.help-tip-wrap')) return;

  const th = event.target.closest('th[data-sort]');
  if (!th) return;                           // 정렬 안 되는 열이면 무시

  const key = th.dataset.sort;

  if (state.sortKey === key) {
    // 같은 열을 또 눌렀다 → 방향만 뒤집는다
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    // 다른 열을 눌렀다 → 그 열에 어울리는 기본 방향으로 시작
    state.sortKey = key;
    state.sortDir = (key === 'koreanName' || key === 'rank') ? 'asc' : 'desc';
  }

  renderSortHeaders();
  renderRows();
});

el.pulseFilters.addEventListener('click', function (event) {
  const btn = event.target.closest('.pulse__chip');
  if (!btn) return;

  const tone = btn.getAttribute('data-tone') || '';
  if (!tone) {
    state.toneFilter = null;                 // 종목: 전체
  } else if (state.toneFilter === tone) {
    state.toneFilter = null;                 // 같은 버튼을 다시 누르면 해제
  } else {
    state.toneFilter = tone;
  }

  renderToneChips();
  renderRows();
});

function closeAllHelps() {
  document.querySelectorAll('.help-tip').forEach(function (btn) {
    btn.setAttribute('aria-expanded', 'false');
  });
  document.querySelectorAll('.help-tip__pop').forEach(function (pop) {
    pop.hidden = true;
  });
}

function toggleHelp(btn) {
  const wrap = btn.closest('.help-tip-wrap');
  if (!wrap) return;
  const pop = wrap.querySelector('.help-tip__pop');
  const alreadyOpen = btn.getAttribute('aria-expanded') === 'true';
  closeAllHelps();
  if (!alreadyOpen && pop) {
    btn.setAttribute('aria-expanded', 'true');
    pop.hidden = false;
  }
}

document.addEventListener('click', function (event) {
  const btn = event.target.closest('.help-tip');
  if (btn) {
    event.preventDefault();
    toggleHelp(btn);
    return;
  }
  if (!event.target.closest('.help-tip-wrap')) closeAllHelps();
});

/* --- 행 클릭: 관심코인 토글 또는 상세 열기 --------------------------
   별을 눌렀는지, 행의 다른 곳을 눌렀는지 구분해야 한다.
   별은 행 안에 있으므로 별 클릭도 행 클릭으로 잡힌다. */
el.rows.addEventListener('click', function (event) {
  const row = event.target.closest('tr[data-market]');
  if (!row) return;

  const market = row.dataset.market;

  // 별을 눌렀다 → 관심코인 추가/해제만 하고 끝낸다 (상세는 안 연다)
  if (event.target.closest('.star')) {
    const at = state.watchlist.indexOf(market);
    if (at === -1) state.watchlist.push(market);   // 없으면 추가
    else state.watchlist.splice(at, 1);            // 있으면 제거
    saveWatchlist();
    renderRows();
    return;
  }

  openDetail(market);
});

el.onlyWatched.addEventListener('change', function (event) {
  state.onlyWatched = event.target.checked;
  renderRows();
});

el.detailClose.addEventListener('click', closeDetail);

// 떠 있는 패널은 Esc 로 닫히는 게 기본 동작이다
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape') return;
  if (document.querySelector('.help-tip[aria-expanded="true"]')) {
    closeAllHelps();
    return;
  }
  closeDetail();
});


/* ==================================================================
 * 7. 상세 패널
 * ================================================================== */

function findCoin(market) {
  return state.coins.filter(function (c) { return c.market === market; })[0];
}

function openDetail(market) {
  state.openMarket = market;
  renderRows();                 // 선택된 행에 표시가 들어가도록 다시 그린다

  el.detail.hidden = false;
  syncToTop();
  el.detailChart.textContent = '차트를 불러오는 중입니다.';
  refreshDetailNumbers();       // 숫자는 이미 있는 데이터라 즉시 보여준다

  // 차트만 따로 요청한다. 여기도 이전 요청을 취소한다.
  if (candleRequest) candleRequest.abort();

  candleRequest = requestJSON('/api/candles?market=' + market + '&count=30', function (candles) {
    candleRequest = null;

    // 응답을 기다리는 동안 사용자가 다른 코인을 열었을 수 있다.
    // 그럼 이 응답은 버려야 한다. abort 와 함께 쓰는 이중 안전장치.
    if (state.openMarket !== market) return;

    el.detailChart.innerHTML = sparkline(candles);
  }, function () {
    candleRequest = null;
    el.detailChart.textContent = '차트를 불러오지 못했습니다.';
  });
}

/** 패널의 숫자들만 갱신. 5초마다 목록이 갱신될 때도 불린다. */
function refreshDetailNumbers() {
  const coin = findCoin(state.openMarket);
  if (!coin) return;            // 검색으로 걸러져서 목록에서 사라졌을 수 있다

  el.detailName.textContent = coin.koreanName + ' (' + coin.symbol + ')';
  el.detailPrice.textContent = formatPrice(coin.price);
  el.detailChange.textContent = formatRate(coin.changeRate) + '  ' + formatPrice(coin.changePrice);
  el.detailChange.className = 'detail__change ' + toneOf(coin.changeRate);
  el.detailHigh.textContent = formatPrice(coin.high);
  el.detailLow.textContent = formatPrice(coin.low);
  el.detailCap.textContent = coin.marketCap ? formatWon(coin.marketCap) : '–';
}

function closeDetail() {
  state.openMarket = null;
  el.detail.hidden = true;
  if (candleRequest) candleRequest.abort();   // 안 볼 차트는 받을 필요 없다
  renderRows();
  syncToTop();
}

/**
 * 30일 종가를 선 하나로 그린다.
 *
 * 차트 라이브러리 없이 SVG 로 직접 그린다. 원리는 간단하다.
 *  1. 30개 값 중 최소·최대를 찾는다
 *  2. 각 값을 0~1 사이 비율로 바꾼다        (v - min) / (max - min)
 *  3. 그 비율을 그림의 높이에 대응시킨다
 *  4. 점들을 polyline 으로 잇는다
 *
 * 주의: SVG 는 y가 아래로 갈수록 커진다. 그래서 height 에서 빼야 위가 높은 값이 된다.
 */
function sparkline(points) {
  if (!points || points.length < 2) return '데이터가 없습니다.';

  const width = 260;
  const height = 72;

  const values = points.map(function (p) { return p.close; });
  const min = Math.min.apply(null, values);
  const max = Math.max.apply(null, values);
  const span = (max - min) || 1;    // 값이 전부 같으면 0으로 나누게 되므로 1로 막는다

  const coords = values.map(function (v, i) {
    const x = (i / (values.length - 1)) * width;               // 가로: 순서대로 균등하게
    const y = height - ((v - min) / span) * (height - 8) - 4;  // 세로: 위아래 4px씩 여백
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');

  // 30일 전보다 올랐으면 빨강, 내렸으면 파랑
  const rising = values[values.length - 1] >= values[0];
  const stroke = rising ? 'var(--rise)' : 'var(--fall)';

  return '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" role="img"' +
         ' aria-label="최근 30일 종가 추이">' +
         '<polyline points="' + coords + '" fill="none" stroke="' + stroke +
         '" stroke-width="1.5" stroke-linejoin="round" /></svg>';
}


/* ==================================================================
 * 8. 시작
 * ==================================================================
 *  이 세 줄이 전부다.
 *  정렬 표시를 맞추고, 한 번 불러오고, 5초 타이머를 켠다.
 */
function syncStickyHeaderOffset() {
  const toolbar = document.querySelector('.toolbar');
  if (!toolbar) return;
  document.documentElement.style.setProperty('--toolbar-sticky-top', toolbar.offsetHeight + 'px');
}

function syncToTop() {
  const pastOnePage = window.scrollY > window.innerHeight;
  el.toTop.classList.toggle('is-visible', pastOnePage);
  el.toTop.classList.toggle('is-shifted', !el.detail.hidden);
}

window.addEventListener('resize', function () {
  syncStickyHeaderOffset();
  syncToTop();
});
window.addEventListener('scroll', syncToTop, { passive: true });
el.toTop.addEventListener('click', function () {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

syncStickyHeaderOffset();
syncToTop();

renderSortHeaders();
loadList();
startPolling();
