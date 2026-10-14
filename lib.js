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

  /* ───────── GitHub (Contents API) ───────── */

  const GITHUB_API = "https://api.github.com";

  // "계정/저장소" 또는 "https://github.com/계정/저장소(.git)" 모두 허용
  function parseRepo(input) {
    const s = String(input || "")
      .trim()
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "");
    const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(s);
    if (!m || m[2] === "." || m[2] === "..") return null;
    return { owner: m[1], repo: m[2] };
  }

  // 폴더 이름 정리: 앞뒤 슬래시 제거, '..' 가 있으면 null (저장소 밖으로 나가는 경로 차단)
  function cleanFolder(folder) {
    const parts = String(folder == null ? "" : folder).split(/[\\/]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.some((p) => p === "." || p === "..")) return null;
    return parts.join("/");
  }

  // 예: tabs/20261015-081000.md  (폴더가 비어 있으면 저장소 최상위)
  function githubPath(folder, now) {
    const f = cleanFolder(folder);
    if (f === null) return null;
    const d = new Date(now);
    const name = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.md`;
    return f ? `${f}/${name}` : name;
  }

  function toBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  const ghHeaders = (token) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });

  function ghErrorMessage(status, apiMessage) {
    const detail = apiMessage ? ` (${apiMessage})` : "";
    switch (status) {
      case 401:
        return "토큰이 올바르지 않거나 만료되었습니다. GitHub 설정에서 토큰을 다시 확인하세요.";
      case 403:
        return "권한이 없거나 요청 한도를 넘었습니다. 토큰에 그 저장소의 'Contents: 읽기 및 쓰기' 권한이 있는지 확인하세요." + detail;
      case 404:
        return "저장소를 찾을 수 없습니다. 이름이 맞는지, 토큰이 그 저장소에 접근할 수 있는지 확인하세요. (권한이 없는 비공개 저장소도 '없음'으로 표시됩니다)";
      case 409:
      case 422:
        return "저장하지 못했습니다. 브랜치 이름이나 폴더 이름을 확인하세요." + detail;
      default:
        return `GitHub 오류 ${status}` + detail;
    }
  }

  // svc: { name, message(status, apiMessage) } — GitHub·노션 공용 요청 함수
  async function apiRequest(fetchFn, url, init, svc) {
    let res;
    try {
      res = await fetchFn(url, init);
    } catch (e) {
      throw new Error(`${svc.name}에 연결하지 못했습니다. 인터넷 연결을 확인하세요.`);
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* 본문 없음 */
    }
    if (!res.ok) {
      const err = new Error(svc.message(res.status, data && data.message));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const ghRequest = (fetchFn, url, init) => apiRequest(fetchFn, url, init, { name: "GitHub", message: ghErrorMessage });

  function ghPrepare(cfg, opts) {
    const r = parseRepo(cfg && cfg.repo);
    if (!r) throw new Error("저장소 이름은 '계정/저장소' 형식으로 입력하세요.");
    if (!cfg.token) throw new Error("GitHub 토큰을 입력하세요.");
    const fetchFn = (opts && opts.fetch) || root.fetch.bind(root);
    return { r, fetchFn };
  }

  // 저장소 조회: 토큰·저장소 이름을 미리 확인하고, 공개 저장소인지 알려 준다.
  async function githubRepoInfo(cfg, opts) {
    const { r, fetchFn } = ghPrepare(cfg, opts);
    const data = await ghRequest(fetchFn, `${GITHUB_API}/repos/${r.owner}/${r.repo}`, { headers: ghHeaders(cfg.token) });
    return { fullName: data.full_name || `${r.owner}/${r.repo}`, isPrivate: !!data.private, defaultBranch: data.default_branch };
  }

  // 새 파일 하나를 커밋한다. 같은 경로가 이미 있으면 덮어쓰지 않고 오류(422)가 난다.
  async function githubSaveFile(cfg, path, text, message, opts) {
    const { r, fetchFn } = ghPrepare(cfg, opts);
    const urlPath = String(path).split("/").map(encodeURIComponent).join("/");
    const body = { message, content: toBase64Utf8(text) };
    if (cfg.branch) body.branch = cfg.branch;
    const data = await ghRequest(fetchFn, `${GITHUB_API}/repos/${r.owner}/${r.repo}/contents/${urlPath}`, {
      method: "PUT",
      headers: { ...ghHeaders(cfg.token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { path, url: data && data.content ? data.content.html_url : null };
  }

  /* ───────── 노션 (Notion API) ───────── */

  const NOTION_API = "https://api.notion.com/v1";
  const NOTION_VERSION = "2022-06-28";
  const NOTION_CHUNK = 100;       // 한 번에 보낼 수 있는 블록 수 상한
  const NOTION_TEXT_MAX = 1900;   // 한 글 조각 2000자 제한보다 여유 있게

  const UUID_RE = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;
  const HEX32_RE = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;

  // 노션 페이지 주소(https://www.notion.so/제목-<32자리>?pvs=4) 또는 ID → 하이픈 있는 UUID. 못 찾으면 null.
  function parseNotionPageId(input) {
    const path = String(input || "").trim().split(/[?#]/)[0];
    const last = (re) => {
      const all = path.match(re);
      return all && all.length ? all[all.length - 1] : null;
    };
    const uuid = last(UUID_RE);
    if (uuid) return uuid.toLowerCase();
    const hex = last(HEX32_RE);
    if (!hex) return null;
    const h = hex.toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  const clipText = (s, max) => {
    const chars = Array.from(String(s));
    return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : chars.join("");
  };

  // http(s) 이고 2000자 이하인 주소만 링크로 쓴다 (노션이 그 외는 거부함)
  function notionLink(url) {
    try {
      const u = new URL(url);
      if ((u.protocol === "http:" || u.protocol === "https:") && u.href.length <= 2000) return u.href;
    } catch (e) {
      /* 잘못된 주소 */
    }
    return null;
  }

  function nText(content, opts) {
    const t = { type: "text", text: { content: clipText(content, NOTION_TEXT_MAX) } };
    if (opts && opts.url) t.text.link = { url: opts.url };
    if (opts && opts.gray) t.annotations = { color: "gray" };
    return t;
  }

  const nBlock = (type, rich) => ({ object: "block", type, [type]: { rich_text: rich } });

  /**
   * 우선순위 순서의 노션 블록 목록: 요약 → 단계 제목 → (도메인 제목) → "N. 제목(링크) — 점수·열람·체류…"
   * items 는 점수 내림차순이어야 하며, N 은 전체 순위이다.
   */
  function buildNotionBlocks(items, opts) {
    const now = (opts && opts.now) || Date.now();
    const rank = new Map(items.map((it, i) => [it, i + 1]));
    const blocks = [
      nBlock("paragraph", [nText(`총 ${items.length}개 탭 — ${summaryCounts(items)}`)]),
      nBlock("paragraph", [nText(SCORE_NOTE, { gray: true })]),
    ];
    for (const sec of groupForDoc(items, opts && opts.groupByDomain)) {
      blocks.push(nBlock("heading_2", [nText(`${sec.label} (${sec.count})`)]));
      for (const g of sec.groups) {
        if (g.domain != null) blocks.push(nBlock("heading_3", [nText(`${g.domain} (${g.items.length})`)]));
        for (const it of g.items) {
          blocks.push(
            nBlock("bulleted_list_item", [
              nText(`${rank.get(it)}. ${displayTitle(it)}`, { url: notionLink(it.url) }),
              nText(` — ${Math.round(it.score)}점 · ${describeMeta(it, now)}`, { gray: true }),
            ])
          );
        }
      }
    }
    return blocks;
  }

  function notionErrorMessage(status, apiMessage) {
    const detail = apiMessage ? ` (${apiMessage})` : "";
    switch (status) {
      case 401:
        return "노션 토큰이 올바르지 않습니다. 전송 설정에서 통합 토큰을 다시 확인하세요.";
      case 403:
        return "노션 통합에 이 페이지에 글을 쓸 권한이 없습니다. 통합의 '콘텐츠 삽입' 권한을 확인하세요." + detail;
      case 404:
        return "노션 페이지를 찾을 수 없습니다. 주소가 맞는지, 그 페이지의 연결(Connections)에 통합을 추가했는지 확인하세요.";
      case 400:
        return "노션이 요청을 받아들이지 않았습니다." + detail;
      case 429:
        return "노션 요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.";
      default:
        return `노션 오류 ${status}` + detail;
    }
  }

  const notionRequest = (fetchFn, url, init) => apiRequest(fetchFn, url, init, { name: "노션", message: notionErrorMessage });

  /** 지정한 부모 페이지 아래에 새 페이지를 만들고, 블록은 100개씩 나눠 채운다. */
  async function notionCreatePage(cfg, title, blocks, opts) {
    const pageId = parseNotionPageId(cfg && cfg.page);
    if (!pageId) throw new Error("노션 페이지 주소(또는 ID)를 입력하세요.");
    if (!cfg.token) throw new Error("노션 통합 토큰을 입력하세요.");
    const fetchFn = (opts && opts.fetch) || root.fetch.bind(root);
    const headers = {
      Authorization: `Bearer ${cfg.token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    };

    const first = blocks.slice(0, NOTION_CHUNK);
    const page = await notionRequest(fetchFn, `${NOTION_API}/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        parent: { page_id: pageId },
        properties: { title: { title: [{ type: "text", text: { content: clipText(title, NOTION_TEXT_MAX) } }] } },
        children: first,
      }),
    });

    let done = first.length;
    try {
      for (let i = NOTION_CHUNK; i < blocks.length; i += NOTION_CHUNK) {
        const chunk = blocks.slice(i, i + NOTION_CHUNK);
        await notionRequest(fetchFn, `${NOTION_API}/blocks/${page.id}/children`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ children: chunk }),
        });
        done += chunk.length;
      }
    } catch (e) {
      const err = new Error(`페이지는 만들어졌지만 ${done}/${blocks.length}개 항목만 저장되었습니다. ${e.message}`);
      err.status = e.status;
      err.url = page.url || null;
      throw err;
    }
    return { id: page.id, url: page.url || null };
  }

  /* ───────── 공개 ───────── */

  const api = {
    CONFIG, MAX_GAP_MS, MIN_VIEW_MS, TIERS,
    isInternalUrl, getDomain, recencyPoints, effectiveDwellMs, effectiveViews, scoreTab, tierOf, buildItems,
    groupForDoc, summaryCounts, describeMeta,
    formatDateTime, fileStamp, formatAgo, formatDuration, escapeHtml,
    toMarkdown, toHtml, toPlainText, toCsv, toTsv, fitChunks, buildEmail, buildBookmarkPlan,
    parseRepo, cleanFolder, githubPath, toBase64Utf8, githubRepoInfo, githubSaveFile,
    parseNotionPageId, buildNotionBlocks, notionCreatePage,
  };
  root.TabLib = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
