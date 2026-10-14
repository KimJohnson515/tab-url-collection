/*
 * lib.js — 탭 정리기 공용 로직
 *  - 우선순위 점수 계산 (열람 횟수 + 체류 시간 + 최근 접근 + 가산점)
 *  - 문서(Markdown / HTML / 텍스트), CSV·TSV(스프레드시트), 이메일 본문 생성
 *
 * 서비스 워커(importScripts), 팝업(<script>), Node 테스트에서 모두 사용합니다.
 */
(function (root) {
  "use strict";

  /* ───────── 조정 가능한 설정 ───────── */

  // 한 번에 체류 시간으로 인정하는 최대 간격 (절전·종료로 인한 과다 집계 방지)
  const MAX_GAP_MS = 90 * 1000;

  // 열람 1회로 인정하는 최소 체류 시간 (탭을 스치듯 지나가는 것은 세지 않는다)
  const MIN_VIEW_MS = 5 * 1000;

  const CONFIG = {
    viewPoints: 3,           // 열람 1회당 점수
    viewCap: 10,             // 열람 횟수는 10회까지만 반영 (최대 30점)
    dwellMaxPoints: 40,      // 체류 시간 최대 점수
    dwellFullMinutes: 30,    // 이 시간(분) 이상 머물렀으면 체류 점수 만점
    recencyMaxPoints: 30,    // 방금 본 탭이 받는 '최근 접근' 점수
    recencyHalfLifeHours: 6, // 이 시간이 지날 때마다 최근 접근 점수가 절반으로
    pinnedBonus: 15,         // 고정 탭
    audibleBonus: 10,        // 소리 재생 중인 탭
    activeBonus: 10,         // 지금 보고 있는 탭
    highThreshold: 35,       // 이 점수 이상 = 높음
    mediumThreshold: 12,     // 이 점수 이상 = 보통, 미만 = 정리 후보
  };

  const TIERS = [
    { key: "high", label: "높음" },
    { key: "medium", label: "보통" },
    { key: "low", label: "정리 후보" },
  ];

  const MAILTO_BODY_LIMIT = 1800; // 메일 앱(mailto) 본문 인코딩 길이 한도 (보수적 값)
  const GMAIL_BODY_LIMIT = 6000;  // Gmail 작성 창 URL 본문 인코딩 길이 한도 (보수적 값)
  const EMAIL_FOOTER = "… 이하 생략 (전체 목록은 클립보드에 복사해 두었으니 이 아래에 붙여넣기 하세요)";

  /* ───────── 기본 유틸 ───────── */

  const pad = (n) => String(n).padStart(2, "0");

  function formatDateTime(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fileStamp(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  function formatAgo(ts, now) {
    if (!ts) return "알 수 없음";
    const sec = Math.max(0, Math.round((now - ts) / 1000));
    if (sec < 60) return "방금 전";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}분 전`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour}시간 전`;
    const day = Math.floor(hour / 24);
    if (day < 7) return `${day}일 전`;
    return `${Math.floor(day / 7)}주 전`;
  }

  function formatDuration(ms) {
    if (ms == null) return "-";
    if (ms < 1000) return "0분";
    if (ms < 60000) return "1분 미만";
    const min = Math.floor(ms / 60000);
    if (min < 60) return `${min}분`;
    const h = Math.floor(min / 60);
    const r = min % 60;
    return r ? `${h}시간 ${r}분` : `${h}시간`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const cleanText = (s) => String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").trim();
  const displayTitle = (it) => cleanText(it.title) || it.url || "(제목 없음)";

  function isInternalUrl(url) {
    if (!url) return true;
    try {
      const p = new URL(url).protocol;
      return !(p === "http:" || p === "https:" || p === "file:" || p === "ftp:");
    } catch (e) {
      return true;
    }
  }

  function getDomain(url) {
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") return u.hostname.replace(/^www\./, "") || "기타";
      if (u.protocol === "file:") return "로컬 파일";
      return u.protocol.replace(":", "") + " (내부)";
    } catch (e) {
      return "기타";
    }
  }

  /* ───────── 점수 계산 ───────── */

  function recencyPoints(lastAccessed, now) {
    if (!lastAccessed) return 0;
    const hours = Math.max(0, now - lastAccessed) / 3600000;
    return CONFIG.recencyMaxPoints * Math.pow(0.5, hours / CONFIG.recencyHalfLifeHours);
  }

  // 저장된 누적 체류 시간 + (지금 보고 있는 탭이면) 아직 저장되지 않은 경과 시간
  function effectiveDwellMs(stat, tracker, tabId, now) {
    if (!stat) return null;
    let ms = stat.dwellMs || 0;
    if (tracker && tracker.tabId === tabId && tracker.since != null) {
      ms += Math.max(0, Math.min(now - tracker.since, MAX_GAP_MS));
    }
    return ms;
  }

  // 저장된 열람 횟수 + (지금 보는 탭이 막 5초를 넘겼지만 아직 저장 전이면) +1
  function effectiveViews(stat, tracker, tabId, now) {
    if (!stat) return null;
    let n = stat.opens || 0;
    if (tracker && tracker.tabId === tabId && tracker.pendingView && tracker.since != null) {
      const elapsed = Math.max(0, Math.min(now - tracker.since, MAX_GAP_MS));
      if ((tracker.viewMs || 0) + elapsed >= MIN_VIEW_MS) n += 1;
    }
    return n;
  }

  function scoreTab(info, now) {
    const views = Math.min(info.views || 0, CONFIG.viewCap) * CONFIG.viewPoints;
    const dwell = Math.min((info.dwellMs || 0) / 60000 / CONFIG.dwellFullMinutes, 1) * CONFIG.dwellMaxPoints;
    const recency = recencyPoints(info.lastAccessed, now);
    const bonus =
      (info.pinned ? CONFIG.pinnedBonus : 0) +
      (info.audible ? CONFIG.audibleBonus : 0) +
      (info.active ? CONFIG.activeBonus : 0);
    return { total: views + dwell + recency + bonus, views, dwell, recency, bonus };
  }

  function tierOf(score) {
    if (score >= CONFIG.highThreshold) return "high";
    if (score >= CONFIG.mediumThreshold) return "medium";
    return "low";
  }

  /**
   * chrome.tabs.query 결과 + 저장된 기록 → 점수가 매겨진 항목 목록(점수 내림차순)
   * stats[tabId] 가 없으면 '기록 없음'(설치 전부터 열려 있던 탭)으로 보고 최근 접근 시각만으로 점수를 낸다.
   */
  function buildItems(tabs, stats, tracker, now, opts) {
    const includeInternal = !!(opts && opts.includeInternal);
    const items = [];
    for (const tab of tabs) {
      const url = tab.url || tab.pendingUrl || "";
      if (!includeInternal && isInternalUrl(url)) continue;

      const stat = stats && stats[tab.id] ? stats[tab.id] : null;
      const lastAccessed = tab.lastAccessed || (stat && stat.lastActivated) || null;
      const views = effectiveViews(stat, tracker, tab.id, now);
      const dwellMs = effectiveDwellMs(stat, tracker, tab.id, now);
      const pinned = !!tab.pinned;
      const audible = !!tab.audible;
      const active = !!(tracker && tracker.tabId === tab.id);

      const s = scoreTab({ views, dwellMs, lastAccessed, pinned, audible, active }, now);
      items.push({
        id: tab.id,
        windowId: tab.windowId,
        title: cleanText(tab.title),
        url,
        domain: getDomain(url),
        score: Math.round(s.total * 10) / 10,
        tier: tierOf(s.total),
        views,
        dwellMs,
        lastAccessed,
        pinned,
        audible,
        active,
        tracked: !!stat,
      });
    }
    items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return items;
  }

  /* ───────── 문서 공통 ───────── */

  // 우선순위 단계 → (선택) 도메인 묶음 → 항목. items 는 점수 내림차순이어야 한다.
  function groupForDoc(items, groupByDomain) {
    const out = [];
    for (const t of TIERS) {
      const list = items.filter((i) => i.tier === t.key);
      if (!list.length) continue;
      let groups;
      if (groupByDomain) {
        const map = new Map(); // 삽입 순서 = 그 도메인의 최고 점수 순서
        for (const it of list) {
          if (!map.has(it.domain)) map.set(it.domain, []);
          map.get(it.domain).push(it);
        }
        groups = Array.from(map, ([domain, its]) => ({ domain, items: its }));
      } else {
        groups = [{ domain: null, items: list }];
      }
      out.push({ tier: t.key, label: t.label, count: list.length, groups });
    }
    return out;
  }

  function summaryCounts(items) {
    return TIERS.map((t) => `${t.label} ${items.filter((i) => i.tier === t.key).length}`).join(" · ");
  }

  function flagList(it) {
    const f = [];
    if (it.pinned) f.push("고정");
    if (it.audible) f.push("재생 중");
    if (it.active) f.push("보는 중");
    return f;
  }

  function describeMeta(it, now) {
    const parts = [];
    if (it.tracked) {
      parts.push(`열람 ${it.views}회`);
      parts.push(`체류 ${formatDuration(it.dwellMs)}`);
    } else {
      parts.push("기록 없음");
    }
    parts.push(it.lastAccessed ? `접근 ${formatAgo(it.lastAccessed, now)}` : "접근 시각 모름");
    return parts.concat(flagList(it)).join(" · ");
  }

  const SCORE_NOTE = "점수 = 열람 횟수 + 체류 시간 + 최근 접근 + 고정·재생·현재 탭 가산점";

  /* ───────── Markdown ───────── */

  const mdEscape = (s) => cleanText(s).replace(/([\\`*_\[\]<>])/g, "\\$1");
  const mdUrl = (u) =>
    u.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/</g, "%3C").replace(/>/g, "%3E");

  function toMarkdown(items, opts) {
    const now = (opts && opts.now) || Date.now();
    const lines = [];
    lines.push(`# 탭 정리 · ${formatDateTime(now)}`, "");
    lines.push(`총 ${items.length}개 탭 — ${summaryCounts(items)}`, "");
    lines.push(`> ${SCORE_NOTE}`, "");
    for (const sec of groupForDoc(items, opts && opts.groupByDomain)) {
      lines.push(`## ${sec.label} (${sec.count})`, "");
      for (const g of sec.groups) {
        if (g.domain != null) lines.push(`### ${mdEscape(g.domain)} (${g.items.length})`, "");
        for (const it of g.items) {
          lines.push(`- [${mdEscape(displayTitle(it))}](${mdUrl(it.url)}) — **${Math.round(it.score)}점** · ${describeMeta(it, now)}`);
        }
        lines.push("");
      }
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  /* ───────── HTML (스타일 포함 단일 파일) ───────── */

  const HTML_CSS = `
body{font:15px/1.55 system-ui,"Malgun Gothic","Apple SD Gothic Neo",sans-serif;max-width:900px;margin:32px auto;padding:0 20px;color:#1f2328}
h1{font-size:24px;margin:0 0 4px}h1 small{font-size:14px;font-weight:400;color:#6b7280}
h2{font-size:18px;margin:28px 0 8px;padding-left:10px;border-left:4px solid #9ca3af}
h2 small{font-weight:400;color:#6b7280}
h2.tier-high{border-color:#dc2626}h2.tier-medium{border-color:#d97706}
.summary{margin:4px 0}.note{color:#6b7280;font-size:13px;margin:0 0 8px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top}
th{font-size:12px;color:#6b7280;font-weight:600}
td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr.domain td{background:#f3f4f6;font-weight:600;font-size:13px}
.url{color:#6b7280;font-size:12px}a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
@media print{body{margin:0}a{color:inherit}}`;

  // http(s) 링크만 클릭 가능하게 만든다 (그 외는 일반 텍스트)
  const safeHref = (url) => (/^https?:\/\//i.test(url) ? escapeHtml(url) : null);

  function toHtml(items, opts) {
    const now = (opts && opts.now) || Date.now();
    const out = [];
    out.push(`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>탭 정리 · ${escapeHtml(formatDateTime(now))}</title>
<style>${HTML_CSS}</style>
</head>
<body>
<h1>탭 정리 <small>${escapeHtml(formatDateTime(now))}</small></h1>
<p class="summary">총 ${items.length}개 탭 — ${escapeHtml(summaryCounts(items))}</p>
<p class="note">${escapeHtml(SCORE_NOTE)}</p>`);
    for (const sec of groupForDoc(items, opts && opts.groupByDomain)) {
      out.push(`<h2 class="tier-${sec.tier}">${escapeHtml(sec.label)} <small>(${sec.count})</small></h2>`);
      out.push("<table><thead><tr><th>점수</th><th>제목</th><th>열람</th><th>체류</th><th>마지막 접근</th><th>비고</th></tr></thead><tbody>");
      for (const g of sec.groups) {
        if (g.domain != null) out.push(`<tr class="domain"><td colspan="6">${escapeHtml(g.domain)} (${g.items.length})</td></tr>`);
        for (const it of g.items) {
          const href = safeHref(it.url);
          const title = escapeHtml(displayTitle(it));
          const link = href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>` : title;
          out.push(
            `<tr><td class="num">${Math.round(it.score)}</td>` +
              `<td>${link}<div class="url">${escapeHtml(it.domain)}</div></td>` +
              `<td class="num">${it.tracked ? it.views + "회" : "-"}</td>` +
              `<td class="num">${it.tracked ? escapeHtml(formatDuration(it.dwellMs)) : "-"}</td>` +
              `<td>${escapeHtml(it.lastAccessed ? formatAgo(it.lastAccessed, now) : "-")}</td>` +
              `<td>${escapeHtml(flagList(it).join(", "))}</td></tr>`
          );
        }
      }
      out.push("</tbody></table>");
    }
    out.push("</body>\n</html>");
    return out.join("\n") + "\n";
  }

  /* ───────── CSV / TSV (스프레드시트) ─────────
   * 웹 페이지 제목은 임의의 문자열이므로 '=', '+', '-', '@' 로 시작하면
   * 스프레드시트가 수식으로 해석하지 않도록 앞에 ' 를 붙인다. */

  const CSV_HEADER = ["우선순위", "점수", "제목", "URL", "도메인", "열람 횟수", "체류 시간(분)", "마지막 접근", "고정", "소리 재생", "창 번호"];
  const TIER_LABEL = { high: "높음", medium: "보통", low: "정리 후보" };

  function tableRows(items) {
    return items.map((it) => [
      TIER_LABEL[it.tier],
      Math.round(it.score * 10) / 10,
      displayTitle(it),
      it.url,
      it.domain,
      it.tracked ? it.views : "",
      it.tracked ? Math.round(it.dwellMs / 6000) / 10 : "",
      it.lastAccessed ? formatDateTime(it.lastAccessed) : "",
      it.pinned ? "예" : "",
      it.audible ? "예" : "",
      it.windowId == null ? "" : it.windowId,
    ]);
  }

  const guard = (s) => (/^[=+\-@\t\r]/.test(s) ? "'" + s : s);

  function csvCell(v) {
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "number") return String(v);
    const s = guard(String(v));
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function tsvCell(v) {
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "number") return String(v);
    const s = guard(String(v).replace(/[\t\r\n]+/g, " "));
    return s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(items) {
    return [CSV_HEADER].concat(tableRows(items)).map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  function toTsv(items) {
    return [CSV_HEADER].concat(tableRows(items)).map((r) => r.map(tsvCell).join("\t")).join("\n") + "\n";
  }

  /* ───────── 이메일 ───────── */

  function toPlainChunks(items, opts) {
    const now = (opts && opts.now) || Date.now();
    const chunks = [];
    const add = (t, isHeader) => chunks.push({ t, h: !!isHeader });
    add(`탭 정리 (${formatDateTime(now)})`, true);
    add(`총 ${items.length}개 — ${summaryCounts(items)}`, true);
    for (const sec of groupForDoc(items, opts && opts.groupByDomain)) {
      add("", true);
      add(`■ ${sec.label} (${sec.count})`, true);
      for (const g of sec.groups) {
        if (g.domain != null) add(`[${g.domain}]`, true);
        for (const it of g.items) {
          add(`- ${displayTitle(it)} (${Math.round(it.score)}점 · ${describeMeta(it, now)})\n  ${it.url}`, false);
        }
      }
    }
    return chunks;
  }

  function toPlainText(items, opts) {
    return toPlainChunks(items, opts).map((c) => c.t).join("\n") + "\n";
  }

  // URL 길이 한도 안에 들어가도록 뒤쪽(= 점수가 낮은 쪽) 항목부터 잘라낸다.
  function fitChunks(chunks, maxEncoded, footer) {
    const enc = (s) => encodeURIComponent(s.replace(/\n/g, "\r\n")).length;
    const full = chunks.map((c) => c.t).join("\n");
    if (enc(full) <= maxEncoded) return { text: full, truncated: false };
    const budget = maxEncoded - enc("\n" + footer);
    let used = 0;
    const kept = [];
    for (const c of chunks) {
      const cost = enc(c.t + "\n");
      if (used + cost > budget) break;
      used += cost;
      kept.push(c);
    }
    while (kept.length && kept[kept.length - 1].h) kept.pop(); // 항목 없이 남은 제목줄 제거
    return { text: kept.map((c) => c.t).join("\n") + "\n" + footer, truncated: true };
  }

  const splitAddresses = (to) => String(to || "").split(/[,;\s]+/).filter(Boolean);

  function mailtoUrl(to, subject, body) {
    const addrs = splitAddresses(to).map((a) => encodeURIComponent(a).replace(/%40/g, "@")).join(",");
    return `mailto:${addrs}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\n/g, "\r\n"))}`;
  }

  function gmailComposeUrl(to, subject, body) {
    const p = ["view=cm", "fs=1"];
    const addrs = splitAddresses(to);
    if (addrs.length) p.push("to=" + encodeURIComponent(addrs.join(",")));
    p.push("su=" + encodeURIComponent(subject), "body=" + encodeURIComponent(body));
    return "https://mail.google.com/mail/?" + p.join("&");
  }

  /**
   * opts: { now, groupByDomain, to, target: "gmail" | "mailto" }
   * 반환: { url, subject, truncated, fullText }  (fullText 는 잘리지 않은 전체 본문)
   */
  function buildEmail(items, opts) {
    const now = opts.now || Date.now();
    const chunks = toPlainChunks(items, opts);
    const fullText = chunks.map((c) => c.t).join("\n") + "\n";
    const gmail = opts.target === "gmail";
    const fit = fitChunks(chunks, gmail ? GMAIL_BODY_LIMIT : MAILTO_BODY_LIMIT, EMAIL_FOOTER);
    const subject = `탭 정리 (${formatDateTime(now)}) · ${items.length}개`;
    const url = gmail ? gmailComposeUrl(opts.to, subject, fit.text) : mailtoUrl(opts.to, subject, fit.text);
    return { url, subject, truncated: fit.truncated, fullText };
  }

  /* ───────── 즐겨찾기(북마크) ───────── */

  const BOOKMARK_TITLE_MAX = 120;

  /**
   * 우선순위 순서대로 "1. 제목", "2. 제목" … 이름의 즐겨찾기 목록을 만든다.
   * items 는 점수 내림차순이어야 한다. 같은 URL 은 가장 높은 순위 하나만 남기고,
   * 즐겨찾기로 쓸 수 없는 주소(javascript: 등)는 건너뛴다.
   */
  function buildBookmarkPlan(items, opts) {
    const now = (opts && opts.now) || Date.now();
    const seen = new Set();
    const picked = [];
    let duplicates = 0;
    let skipped = 0;
    for (const it of items) {
      const url = it.url || "";
      if (!url || /^(javascript|data|blob):/i.test(url)) { skipped++; continue; }
      if (seen.has(url)) { duplicates++; continue; }
      seen.add(url);
      picked.push(it);
    }
    const width = String(picked.length).length; // 10개 이상이면 01, 02 … 로 자릿수를 맞춘다
    const entries = picked.map((it, i) => {
      const chars = Array.from(displayTitle(it));
      const name = chars.length > BOOKMARK_TITLE_MAX ? chars.slice(0, BOOKMARK_TITLE_MAX - 1).join("") + "…" : chars.join("");
      return { title: `${String(i + 1).padStart(width, "0")}. ${name}`, url: it.url };
    });
    return { folderName: `탭 정리 ${formatDateTime(now)}`, entries, duplicates, skipped };
  }

  /* ───────── 공개 ───────── */

  const api = {
    CONFIG, MAX_GAP_MS, MIN_VIEW_MS, TIERS,
    isInternalUrl, getDomain, recencyPoints, effectiveDwellMs, effectiveViews, scoreTab, tierOf, buildItems,
    groupForDoc, summaryCounts, describeMeta,
    formatDateTime, fileStamp, formatAgo, formatDuration, escapeHtml,
    toMarkdown, toHtml, toPlainText, toCsv, toTsv, fitChunks, buildEmail, buildBookmarkPlan,
  };
  root.TabLib = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
