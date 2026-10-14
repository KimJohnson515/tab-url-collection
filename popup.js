/* popup.js — 목록 표시, 선택, 문서/시트/이메일 내보내기 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const DEFAULT_PREFS = { scope: "all", groupDomain: true, includeInternal: false, email: "" };
  const DEFAULT_GH = { repo: "", token: "", folder: "tabs", branch: "" };

  const state = {
    prefs: { ...DEFAULT_PREFS },
    gh: { ...DEFAULT_GH },
    items: [],
    deselected: new Set(), // 사용자가 체크 해제한 탭 id
  };
  let toastTimer = null;

  /* ───────── 작은 도우미 ───────── */

  // 웹 페이지 제목은 신뢰할 수 없는 문자열이므로 항상 textContent 로만 넣는다 (innerHTML 사용 금지)
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") node.className = v;
      else if (k === "checked" || k === "indeterminate") node[k] = v;
      else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  }

  function toast(message, isError) {
    const box = $("toast");
    box.textContent = message;
    box.className = "toast" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.textContent = ""; }, 6000);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        const ta = el("textarea", {});
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (e2) {
        return false;
      }
    }
  }

  function download(name, text, mime, withBom) {
    const blob = new Blob(withBom ? ["﻿", text] : [text], { type: mime + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /* ───────── 설정 ───────── */

  async function loadPrefs() {
    const { prefs, github } = await chrome.storage.local.get({ prefs: DEFAULT_PREFS, github: DEFAULT_GH });
    state.prefs = { ...DEFAULT_PREFS, ...prefs };
    state.gh = { ...DEFAULT_GH, ...github };
    $("ghRepo").value = state.gh.repo;
    $("ghToken").value = state.gh.token;
    $("ghFolder").value = state.gh.folder;
    $("ghBranch").value = state.gh.branch;
    $("scope").value = state.prefs.scope;
    $("groupDomain").checked = state.prefs.groupDomain;
    $("includeInternal").checked = state.prefs.includeInternal;
    $("email").value = state.prefs.email;
  }

  const savePrefs = () => chrome.storage.local.set({ prefs: state.prefs });

  /* ───────── 목록 ───────── */

  async function refresh() {
    const now = Date.now();
    const query = state.prefs.scope === "current" ? { currentWindow: true } : {};
    const [tabs, data] = await Promise.all([
      chrome.tabs.query(query),
      chrome.storage.local.get({ stats: {}, tracker: null }),
    ]);
    state.items = TabLib.buildItems(tabs, data.stats, data.tracker, now, {
      includeInternal: state.prefs.includeInternal,
    });
    const ids = new Set(state.items.map((i) => i.id));
    for (const id of [...state.deselected]) if (!ids.has(id)) state.deselected.delete(id);
    render();
  }

  async function focusTab(it) {
    try {
      await chrome.tabs.update(it.id, { active: true });
      await chrome.windows.update(it.windowId, { focused: true });
      window.close();
    } catch (e) {
      toast("탭으로 이동하지 못했습니다. 이미 닫힌 탭일 수 있어요.", true);
    }
  }

  function render() {
    const list = $("list");
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    const now = Date.now();

    const sel = state.items.filter((i) => !state.deselected.has(i.id)).length;
    $("summary").textContent = state.items.length
      ? `${state.items.length}개 탭 · ${TabLib.summaryCounts(state.items)}`
      : "";
    $("selCount").textContent = `${sel} / ${state.items.length}개 선택`;

    if (!state.items.length) {
      list.append(el("p", { class: "empty" }, "정리할 탭이 없습니다."));
      return;
    }

    for (const sec of TabLib.groupForDoc(state.items, state.prefs.groupDomain)) {
      const ids = sec.groups.flatMap((g) => g.items.map((i) => i.id));
      const checkedCount = ids.filter((id) => !state.deselected.has(id)).length;

      const tierBox = el("input", {
        type: "checkbox",
        "aria-label": `${sec.label} 전체 선택`,
        checked: checkedCount === ids.length,
        indeterminate: checkedCount > 0 && checkedCount < ids.length,
      });
      tierBox.addEventListener("change", () => {
        for (const id of ids) tierBox.checked ? state.deselected.delete(id) : state.deselected.add(id);
        render();
      });

      const section = el("section", { class: `tier tier-${sec.tier}` });
      section.append(
        el("div", { class: "tier-head" }, tierBox, el("span", {}, sec.label), el("span", { class: "count" }, `${sec.count}개`))
      );

      for (const g of sec.groups) {
        if (g.domain != null) section.append(el("div", { class: "domain" }, `${g.domain} (${g.items.length})`));
        const ul = el("ul", {});
        for (const it of g.items) {
          const box = el("input", { type: "checkbox", "aria-label": "내보내기에 포함", checked: !state.deselected.has(it.id) });
          box.addEventListener("change", () => {
            box.checked ? state.deselected.delete(it.id) : state.deselected.add(it.id);
            render();
          });
          const title = el("button", { type: "button", class: "link", title: it.url }, it.title || it.url || "(제목 없음)");
          title.addEventListener("click", () => focusTab(it));
          ul.append(
            el(
              "li",
              { class: "row" },
              box,
              el("span", { class: "score", title: "우선순위 점수" }, String(Math.round(it.score))),
              el("div", { class: "text" }, title, el("div", { class: "meta" }, TabLib.describeMeta(it, now)))
            )
          );
        }
        section.append(ul);
      }
      list.append(section);
    }
    list.scrollTop = scrollTop;
  }

  /* ───────── 내보내기 ───────── */

  function getSelection() {
    const sel = state.items.filter((i) => !state.deselected.has(i.id));
    if (!sel.length) {
      toast("선택된 탭이 없습니다.", true);
      return null;
    }
    return sel;
  }

  const docOpts = () => ({ now: Date.now(), groupByDomain: state.prefs.groupDomain });

  function onClick(id, handler) {
    $(id).addEventListener("click", async () => {
      try {
        await handler();
      } catch (e) {
        console.error(e);
        toast("오류가 발생했습니다: " + (e && e.message ? e.message : e), true);
      }
    });
  }

  onClick("mdSave", () => {
    const sel = getSelection(); if (!sel) return;
    const o = docOpts();
    download(`tabs-${TabLib.fileStamp(o.now)}.md`, TabLib.toMarkdown(sel, o), "text/markdown");
    toast(`${sel.length}개 탭을 Markdown 파일로 저장했습니다.`);
  });

  onClick("htmlSave", () => {
    const sel = getSelection(); if (!sel) return;
    const o = docOpts();
    download(`tabs-${TabLib.fileStamp(o.now)}.html`, TabLib.toHtml(sel, o), "text/html");
    toast(`${sel.length}개 탭을 HTML 문서로 저장했습니다.`);
  });

  onClick("mdCopy", async () => {
    const sel = getSelection(); if (!sel) return;
    const ok = await copy(TabLib.toMarkdown(sel, docOpts()));
    ok ? toast(`${sel.length}개 탭을 Markdown으로 복사했습니다.`) : toast("클립보드 복사에 실패했습니다.", true);
  });

  onClick("csvSave", () => {
    const sel = getSelection(); if (!sel) return;
    const o = docOpts();
    download(`tabs-${TabLib.fileStamp(o.now)}.csv`, TabLib.toCsv(sel), "text/csv", true);
    toast(`${sel.length}개 탭을 CSV로 저장했습니다. (엑셀·구글 시트에서 열기)`);
  });

  onClick("sheets", async () => {
    const sel = getSelection(); if (!sel) return;
    const ok = await copy(TabLib.toTsv(sel));
    if (!ok) return toast("클립보드 복사에 실패했습니다.", true);
    await chrome.tabs.create({ url: "https://sheets.new" });
    toast("표를 복사했습니다. 새 시트의 A1 셀을 선택하고 Ctrl+V(Mac은 ⌘V)로 붙여넣으세요.");
  });

  onClick("bookmarks", async () => {
    const sel = getSelection(); if (!sel) return;
    if (!chrome.bookmarks) {
      return toast("즐겨찾기 권한이 없습니다. chrome://extensions 에서 이 확장 프로그램을 새로고침해 주세요.", true);
    }
    const plan = TabLib.buildBookmarkPlan(sel, { now: Date.now() });
    if (!plan.entries.length) return toast("즐겨찾기로 만들 수 있는 탭이 없습니다.", true);

    // 부모를 지정하지 않으면 '기타 즐겨찾기' 안에 만들어진다 (즐겨찾기 모음줄을 어지럽히지 않음)
    const folder = await chrome.bookmarks.create({ title: plan.folderName });
    let made = 0;
    let failed = 0;
    for (const e of plan.entries) { // 순서가 번호와 일치하도록 하나씩 차례로 만든다
      try {
        await chrome.bookmarks.create({ parentId: folder.id, title: e.title, url: e.url });
        made++;
      } catch (err) {
        failed++;
      }
    }
    const notes = [];
    if (plan.duplicates) notes.push(`같은 주소 ${plan.duplicates}개는 한 번만 저장`);
    if (failed) notes.push(`${failed}개는 저장하지 못함`);
    toast(
      `즐겨찾기 > 기타 즐겨찾기 > '${plan.folderName}' 폴더에 ${made}개를 저장했습니다.` +
        (notes.length ? ` (${notes.join(", ")})` : ""),
      failed > 0 && made === 0
    );
  });

  /* ── GitHub: 체크한 탭을 Markdown 파일 하나로 커밋 ── */

  for (const [id, key] of [["ghRepo", "repo"], ["ghToken", "token"], ["ghFolder", "folder"], ["ghBranch", "branch"]]) {
    $(id).addEventListener("input", (e) => {
      state.gh[key] = e.target.value.trim();
      chrome.storage.local.set({ github: state.gh });
    });
  }

  onClick("github", async () => {
    const sel = getSelection(); if (!sel) return;
    const cfg = state.gh;
    if (!cfg.repo || !cfg.token) {
      $("ghSettings").open = true;
      return toast("먼저 'GitHub 설정'에 저장소와 토큰을 입력하세요.", true);
    }
    const o = docOpts();
    const path = TabLib.githubPath(cfg.folder, o.now);
    if (path === null) return toast("폴더 이름에 '..' 은 사용할 수 없습니다.", true);

    toast("GitHub에 연결하는 중…");
    const info = await TabLib.githubRepoInfo(cfg); // 토큰·저장소 확인 + 공개 여부 파악
    if (!info.isPrivate) {
      const ok = window.confirm(`'${info.fullName}' 은(는) 공개 저장소입니다.\n올린 탭 주소가 누구에게나 보입니다. 그래도 올릴까요?`);
      if (!ok) return toast("취소했습니다.");
    }
    const result = await TabLib.githubSaveFile(
      cfg,
      path,
      TabLib.toMarkdown(sel, o),
      `탭 정리 ${TabLib.formatDateTime(o.now)} · ${sel.length}개`
    );
    toast(`${info.fullName} 에 ${sel.length}개 탭을 저장했습니다: ${result.path}`);
  });

  async function sendEmail(target) {
    const sel = getSelection(); if (!sel) return;
    const mail = TabLib.buildEmail(sel, { ...docOpts(), to: state.prefs.email, target });
    const copied = await copy(mail.fullText); // 본문이 잘려도 전체 목록은 클립보드에 남긴다
    if (target === "gmail") {
      await chrome.tabs.create({ url: mail.url });
    } else {
      const a = el("a", { href: mail.url });
      document.body.append(a);
      a.click();
      a.remove();
    }
    if (mail.truncated) {
      copied
        ? toast("본문이 길어 일부만 담았습니다. 전체 목록은 클립보드에 있으니 붙여넣기 하세요.")
        : toast("본문이 길어 일부만 담았고, 클립보드 복사도 실패했습니다. 'Markdown 저장'을 이용하세요.", true);
    } else {
      toast("메일 작성 창을 열었습니다.");
    }
  }
  onClick("gmail", () => sendEmail("gmail"));
  onClick("mailto", () => sendEmail("mailto"));

  onClick("resetStats", async () => {
    if (!window.confirm("지금까지 쌓인 열람 횟수와 체류 시간 기록을 모두 지울까요?")) return;
    const res = await chrome.runtime.sendMessage({ type: "resetStats" });
    if (!res || !res.ok) throw new Error("백그라운드 응답이 없습니다.");
    await refresh();
    toast("기록을 초기화했습니다. 지금부터 다시 쌓입니다.");
  });

  /* ───────── 이벤트 연결 ───────── */

  $("scope").addEventListener("change", (e) => {
    state.prefs.scope = e.target.value;
    savePrefs();
    refresh();
  });
  $("groupDomain").addEventListener("change", (e) => {
    state.prefs.groupDomain = e.target.checked;
    savePrefs();
    render();
  });
  $("includeInternal").addEventListener("change", (e) => {
    state.prefs.includeInternal = e.target.checked;
    savePrefs();
    refresh();
  });
  $("email").addEventListener("input", (e) => {
    state.prefs.email = e.target.value.trim();
    savePrefs();
  });
  $("refresh").addEventListener("click", () => refresh());
  $("selAll").addEventListener("click", () => { state.deselected.clear(); render(); });
  $("selNone").addEventListener("click", () => { state.items.forEach((i) => state.deselected.add(i.id)); render(); });

  loadPrefs().then(refresh).catch((e) => {
    console.error(e);
    toast("초기화 오류: " + (e && e.message ? e.message : e), true);
  });
})();
