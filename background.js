/*
 * background.js — 열려 있는 탭의 "열람 횟수"와 "체류 시간"을 기록하는 MV3 서비스 워커
 *
 * 기록 규칙
 *  - 열람 횟수: 탭을 선택해서 보게 될 때마다 +1 (백그라운드로만 열린 탭은 0회)
 *  - 체류 시간: 그 탭이 보이고, 브라우저 창이 포커스 상태이며, 사용자가 활동 중일 때만 누적
 *  - 탭이 닫히면 그 탭의 기록은 삭제 (= "지금 열려 있는 탭" 기준)
 *
 * 서비스 워커는 수시로 종료되므로 메모리 변수 대신 chrome.storage.local에
 * "타임스탬프"를 저장하고, 이벤트가 올 때마다 경과 시간을 계산해 누적합니다.
 */
importScripts("lib.js");

const MAX_GAP_MS = TabLib.MAX_GAP_MS; // 절전·종료 등으로 한 번에 과다 집계되는 것을 막는 상한
const MIN_VIEW_MS = TabLib.MIN_VIEW_MS; // 이 시간 이상 머물러야 '열람 1회'로 인정 (탭 훑어보기는 제외)
const IDLE_SECONDS = 60;              // 이 시간 동안 입력이 없으면 '자리 비움'으로 보고 집계 중지
const TICK_ALARM = "tick";            // 1분마다 체류 시간을 저장하고 닫힌 탭 기록을 정리

// pendingView: 탭을 막 선택했고 아직 5초를 채우지 못해 열람으로 인정되기 전인 상태 / viewMs: 그동안 머문 시간
const freshTracker = () => ({ tabId: null, since: null, focused: true, userActive: true, pendingView: false, viewMs: 0 });

/* ── 저장소 접근: 이벤트를 한 줄로 세워 읽기-수정-쓰기 충돌을 막는다 ── */
let queue = Promise.resolve();

function mutate(fn) {
  const at = Date.now(); // 큐에서 기다리는 동안에도 '이벤트가 일어난 시각'을 유지
  queue = queue
    .then(async () => {
      const data = await chrome.storage.local.get({ stats: {}, tracker: null });
      const s = { stats: data.stats, tracker: data.tracker || freshTracker() };
      await fn(s, at);
      await chrome.storage.local.set({ stats: s.stats, tracker: s.tracker });
    })
    .catch((e) => console.error("[tab-organizer]", e));
  return queue;
}

/* ── 상태 전이 ── */
function getStat(stats, tabId) {
  return stats[tabId] || (stats[tabId] = { opens: 0, dwellMs: 0, lastActivated: null });
}

// 지금까지의 경과 시간을 현재 탭에 더하고, 시계를 now로 되돌린다.
function flush(s, now) {
  const t = s.tracker;
  if (t.tabId != null && t.since != null) {
    const delta = Math.max(0, Math.min(now - t.since, MAX_GAP_MS));
    const st = getStat(s.stats, t.tabId);
    st.dwellMs += delta;
    if (t.pendingView) {
      t.viewMs = (t.viewMs || 0) + delta;
      if (t.viewMs >= MIN_VIEW_MS) {
        st.opens += 1; // 5초 이상 머물렀으므로 열람 1회로 인정
        st.lastActivated = now;
        t.pendingView = false;
        t.viewMs = 0;
      }
    }
    t.since = now;
  }
}

function pause(s, now) {
  flush(s, now);
  s.tracker.since = null;
}

// 보고 있고(포커스) 활동 중일 때만 시계를 돌린다.
function sync(s, now) {
  const t = s.tracker;
  if (t.tabId != null && t.focused && t.userActive) {
    if (t.since == null) t.since = now;
  } else {
    pause(s, now);
  }
}

function activate(s, tabId, now, countView) {
  flush(s, now); // 이전 탭이 5초를 못 채웠다면 열람으로 세지 않고 버린다
  const t = s.tracker;
  t.tabId = tabId;
  t.since = null;
  t.pendingView = !!countView; // 5초 이상 머물면 flush 에서 열람 1회로 확정
  t.viewMs = 0;
  getStat(s.stats, tabId); // 이 탭은 이제부터 기록 대상
  sync(s, now);
}

/* ── 이벤트 ── */
chrome.tabs.onActivated.addListener(({ tabId }) => {
  mutate((s, now) => activate(s, tabId, now, true));
});

chrome.tabs.onCreated.addListener((tab) => {
  // 설치 이후에 만들어진 탭은 0회부터 기록 시작 (설치 전부터 열려 있던 탭은 '기록 없음')
  mutate((s) => {
    if (tab.id != null) getStat(s.stats, tab.id);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  mutate((s) => {
    delete s.stats[tabId];
    if (s.tracker.tabId === tabId) {
      s.tracker.tabId = null;
      s.tracker.since = null;
      s.tracker.pendingView = false;
      s.tracker.viewMs = 0;
    }
  });
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  mutate((s) => {
    if (s.stats[removedTabId]) {
      s.stats[addedTabId] = s.stats[removedTabId];
      delete s.stats[removedTabId];
    }
    if (s.tracker.tabId === removedTabId) s.tracker.tabId = addedTabId;
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  mutate(async (s, now) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      s.tracker.focused = false;
      pause(s, now);
      return;
    }
    s.tracker.focused = true;
    let tab = null;
    try {
      [tab] = await chrome.tabs.query({ active: true, windowId });
    } catch (e) {
      /* 개발자 도구 창 등 탭이 없는 창 */
    }
    if (tab && tab.id !== s.tracker.tabId) activate(s, tab.id, now, true);
    else sync(s, now);
  });
});

chrome.idle.setDetectionInterval(IDLE_SECONDS);
chrome.idle.onStateChanged.addListener((state) => {
  mutate((s, now) => {
    s.tracker.userActive = state === "active";
    sync(s, now);
  });
});

chrome.alarms.get(TICK_ALARM).then((alarm) => {
  if (!alarm) chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TICK_ALARM) return;
  mutate(async (s, now) => {
    flush(s, now);
    // 놓친 이벤트가 있더라도 닫힌 탭의 기록이 남지 않도록 정리
    const tabs = await chrome.tabs.query({});
    const alive = new Set(tabs.map((t) => String(t.id)));
    for (const id of Object.keys(s.stats)) {
      if (!alive.has(id)) delete s.stats[id];
    }
  });
});

/* ── 설치 / 브라우저 시작 ── */
function initialize(resetStats) {
  return mutate(async (s, now) => {
    if (resetStats) {
      s.stats = {};
      s.tracker = freshTracker();
    }
    s.tracker.userActive = (await chrome.idle.queryState(IDLE_SECONDS)) === "active";

    let win = null;
    try {
      win = await chrome.windows.getLastFocused();
    } catch (e) {
      /* 열린 창 없음 */
    }
    s.tracker.focused = !!(win && win.focused);

    let tab = null;
    if (win) [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (tab && tab.id !== s.tracker.tabId) activate(s, tab.id, now, true);
    else sync(s, now);
  });
}

// 탭 ID는 브라우저를 다시 시작하면 바뀌므로 시작할 때 기록을 초기화한다.
chrome.runtime.onStartup.addListener(() => initialize(true));
chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  // 업데이트 때는 기록을 유지하되, 열람 집계 기준이 바뀌기 전(1.0.0)의 기록은 의미가 달라 초기화한다.
  initialize(details.reason === "install" || details.previousVersion === "1.0.0");
});

// 팝업의 '기록 초기화' 버튼
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "resetStats") {
    initialize(true).then(() => sendResponse({ ok: true }));
    return true; // 비동기 응답
  }
});
