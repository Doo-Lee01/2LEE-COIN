# 원화 마켓 시세판

업비트 실시간 시세 + 코인게코 시가총액 순위를 한 화면에 보여주는 대시보드입니다.
외부 패키지 없이 Node 내장 모듈과 순수 JS만 사용합니다.

## 실행

```bash
node server.js
# http://localhost:3000
```

코인게코 키가 있으면 (없어도 동작합니다):

```bash
COINGECKO_API_KEY=본인키 node server.js
```

## 폴더 구조

```
server.js          프록시 서버 + 캐시 (Node, 콜백 스타일)
public/index.html  화면 구조
public/style.css   스타일
public/app.js      클라이언트 로직 (XHR)
```

## 서버가 하는 일

| 라우트 | 외부 API | 캐시 |
|---|---|---|
| `GET /api/coins` | 업비트 `/v1/market/all` + `/v1/ticker/all` + 코인게코 `/coins/markets` | 4초 / 12시간 / 120초 |
| `GET /api/search?q=` | 위와 동일 (캐시된 결과를 서버에서 필터링) | – |
| `GET /api/candles?market=KRW-BTC` | 업비트 `/v1/candles/days` | 60초 |

**브라우저에서 업비트를 직접 부르지 않는 이유**: 업비트는 Origin 헤더가 붙은 요청(브라우저의
XHR/fetch가 자동으로 붙입니다)에 대해 시세 조회 API를 10초당 1회만 허용합니다.
서버에서 호출하면 초당 10회를 씁니다.

## 구현된 것

- 원화 마켓 전체 시세, 5초 폴링
- 상승/하락 종목 수 요약 바
- 검색: 디바운싱 250ms + 이전 요청 취소, 한글·영문·심볼 모두 매칭
- 정렬: 이름 / 시총순위 / 현재가 / 등락률 / 거래대금 (헤더 클릭)
- 관심코인 (localStorage), 관심코인만 보기
- 코인 상세: 30일 종가 스파크라인
- 가격이 바뀐 칸만 잠깐 물들이기
- 탭이 백그라운드면 폴링 중단
- 상승 빨강 / 하락 파랑 (국내 관례)

---

## Promise 리팩터링 가이드

리팩터링할 때 손대야 하는 곳은 **딱 두 군데**입니다.

### 1) 클라이언트 — `public/app.js` 맨 위 `requestJSON`

지금은 콜백 2개를 받습니다.

```js
requestJSON(url, onSuccess, onError);  // XMLHttpRequest 를 반환
```

이걸 이렇게 바꿉니다.

```js
function requestJSON(url, signal) {
  return fetch(url, { signal }).then(function (res) {
    if (!res.ok) {
      return res.json().then(function (body) {
        throw new Error(body.message || '응답 코드 ' + res.status);
      });
    }
    return res.json();
  });
}
```

호출하는 쪽(`loadList`)은 이렇게 바뀝니다.

```js
let controller = null;

function loadList() {
  if (controller) controller.abort();
  controller = new AbortController();

  const url = state.query ? '/api/search?q=' + encodeURIComponent(state.query) : '/api/coins';

  requestJSON(url, controller.signal)
    .then(function (data) {
      hideBanner();
      state.coins = data.coins;
      renderRows();
      renderPulse(data.updatedAt);
    })
    .catch(function (err) {
      if (err.name === 'AbortError') return;  // 우리가 취소한 건 무시
      showBanner('시세를 불러오지 못했습니다: ' + err.message);
    });
}
```

`xhr.abort()` → `AbortController` 로 바뀌는 것만 빼면 구조가 그대로라는 점을 눈여겨보세요.
2~8번 블록(상태 · 렌더링 · 이벤트)은 손댈 게 없습니다. **통신 코드를 한 곳에 모아둔 값이 여기서 나옵니다.**

`async/await`까지 가면:

```js
async function loadList() {
  if (controller) controller.abort();
  controller = new AbortController();
  try {
    const data = await requestJSON(url, controller.signal);
    ...
  } catch (err) {
    if (err.name !== 'AbortError') showBanner('...');
  }
}
```

### 2) 서버 — `server.js` 의 `loadCoins`

지금은 카운터로 콜백 3개가 끝나길 기다립니다 (`pending -= 1`). Promise로 바꾸면:

```js
const cachedP = (key, ttl, loader) =>
  new Promise((resolve, reject) =>
    cached(key, ttl, loader, (err, data) => (err ? reject(err) : resolve(data))));

async function loadCoins() {
  const [markets, tickers, rankings] = await Promise.all([
    cachedP('markets', 12 * 60 * 60 * 1000, loadMarkets),
    cachedP('tickers', 4 * 1000, loadTickers),
    cachedP('rankings', 120 * 1000, loadRankings).catch(() => []) // 순위는 없어도 진행
  ]);
  return mergeCoins(markets, tickers, rankings);
}
```

카운터, `fatal` 변수, `step` 함수가 통째로 사라집니다.
`getJSON`도 `util.promisify` 대신 위처럼 `new Promise`로 한 번 감싸면 끝입니다.

### 순서 추천

1. `requestJSON` 하나만 Promise 버전으로 교체 → `loadList`, `openDetail` 두 군데만 수정
2. 서버 `getJSON` → Promise 화
3. `loadCoins` → `Promise.all`
4. 마지막에 `async/await`로 정리

1번만 해도 절반은 끝납니다.

---

## 확인해볼 것

- 검색창에 빠르게 타이핑하고 개발자도구 Network 탭 보기 → 요청이 글자 수만큼이 아니라 몇 번만 나가는지
- 서버 콘솔의 `Remaining-Req` 헤더 → 잔여 요청 수가 얼마나 남는지
- 탭을 다른 창으로 옮겼다 돌아오기 → 폴링이 멈췄다 다시 도는지
- 서버를 끄고 화면 두기 → 에러 배너가 뜨고, 서버를 켜면 알아서 복구되는지

## 참고 문서

- 업비트 Rate Limits: https://docs.upbit.com/kr/reference/rate-limits
- 업비트 마켓 단위 현재가: https://docs.upbit.com/kr/reference/list-quote-tickers
- 코인게코 API: https://docs.coingecko.com/
