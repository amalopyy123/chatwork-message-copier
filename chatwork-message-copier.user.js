// ==UserScript==
// @name         Chatwork Message Copier
// @namespace    https://www.chatwork.com/
// @version      0.4.0
// @description  批量复制 Chatwork 消息（含发言人、时间、引用/回复内容）
// @match        https://www.chatwork.com/*
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const REPLY_MAX_CHARS = 300; // 回复时附带的原消息最多字数
  const SEPARATOR = '═'.repeat(32); // 不同对话之间的分隔线（避开正文中常见的 ━ ─ -）
  const GROUP_GAP_SEC = 5 * 60; // 同一人连续发言间隔不超过此秒数视为同一段对话

  // ---------- 数据读取 ----------

  const timeline = () => W.RM && W.RM.timeline;
  const getChat = (mid) => timeline()?.chat_id2chat_dat?.[mid];
  const loadedChats = () =>
    Object.values(timeline()?.chat_id2chat_dat || {}).sort((a, b) => a.index - b.index);

  function getName(aid) {
    try {
      return W.AC.getName(aid) || `user${aid}`;
    } catch (e) {
      return `user${aid}`;
    }
  }

  function fmtTime(tm) {
    if (!tm) return '';
    const d = new Date(tm * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- Chatwork 标记 -> 纯文本 ----------

  const quoteLines = (text) => text.replace(/\n+$/, '').split('\n').map((l) => '> ' + l).join('\n');

  function convert(msg, nested) {
    let s = String(msg || '');

    // 引用 [qt]...[/qt]，从最内层开始替换以支持嵌套
    const qtRe = /\[qt\](?:\[qtmeta aid=(\d+)(?: time=(\d+))?\])?((?:(?!\[qt\])[\s\S])*?)\[\/qt\]/;
    for (let m; (m = s.match(qtRe)); ) {
      const head = m[1] ? `${getName(m[1])}${m[2] ? ' ' + fmtTime(+m[2]) : ''}:\n` : '';
      s = s.replace(m[0], '\n' + quoteLines(head + m[3].replace(/^\n+/, '')) + '\n');
    }

    // 回复 [rp aid=X to=RID-MID]名字さん：替换为回复头 + 原消息摘录
    // 被引用的原消息里的回复头直接去掉，避免层层嵌套
    s = s.replace(/\[rp aid=(\d+) to=\d+-(\d+)\]([^\n]{0,50}\n?)?/g, (all, aid, mid) => {
      if (nested) return '';
      const orig = getChat(mid);
      let out = `┌── ↩ 回复 ${getName(aid)}`;
      if (orig) {
        let body = convert(orig.msg, true).trim();
        if (body.length > REPLY_MAX_CHARS) body = body.slice(0, REPLY_MAX_CHARS) + '…';
        out += ` ${fmtTime(orig.tm)}\n` + body.split('\n').map((l) => (l ? '│ ' + l : '│')).join('\n') + '\n';
      } else {
        out += '（原消息未加载）\n';
      }
      return out + '└──\n';
    });

    return s
      .replace(/\[To:(\d+)\]/g, '@')
      .replace(/\[toall\]/g, '@all')
      .replace(/\[pi?con(?:name)?:(\d+)\]/g, (a, aid) => getName(aid))
      .replace(/\[dtext:file_uploaded\]/g, '文件上传')
      .replace(/\[dtext:[^\]]*\]/g, '')
      .replace(/\[preview [^\]]*\]/g, '')
      .replace(/\[download:(\d+)\]([\s\S]*?)\[\/download\]/g, (a, id, name) =>
        `[文件] ${name}\n${location.origin}/gateway/download_file.php?bin=1&file_id=${id}&preview=0`)
      .replace(/\[title\]([\s\S]*?)\[\/title\]/g, '【$1】\n')
      .replace(/\[\/?info\]/g, '\n')
      .replace(/\[code\]\n?/g, '```\n')
      .replace(/\n?\[\/code\]/g, '\n```')
      .replace(/\[hr\]/g, '----------')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function formatChat(c) {
    return `【${getName(c.aid)}】${fmtTime(c.tm)}\n${convert(c.msg)}`;
  }

  // ---------- 选择模式 UI ----------

  const selected = new Set();
  let active = false;
  let lastClickedIndex = null;

  const style = document.createElement('style');
  style.textContent = `
    #cwmc-bar{position:fixed;right:16px;bottom:80px;z-index:99999;display:flex;gap:6px;align-items:center;
      background:#fff;border:1px solid #ccc;border-radius:8px;padding:6px 8px;box-shadow:0 2px 8px rgba(0,0,0,.2);font-size:13px}
    #cwmc-bar button{border:1px solid #bbb;background:#f6f6f6;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:12px}
    #cwmc-bar button.primary{background:#2a7ae2;color:#fff;border-color:#2a7ae2}
    #cwmc-bar .cwmc-extra{display:none;gap:6px;align-items:center}
    body.cwmc-on #cwmc-bar .cwmc-extra{display:flex}
    body.cwmc-on ._message[data-mid]{position:relative;padding-left:28px !important}
    .cwmc-check{display:none;position:absolute;left:6px;top:10px;width:16px;height:16px;cursor:pointer;z-index:10}
    body.cwmc-on .cwmc-check{display:block}
    body.cwmc-on ._message.cwmc-selected{background:rgba(42,122,226,.10) !important}
  `;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'cwmc-bar';
  bar.innerHTML = `
    <button data-act="toggle">📋 批量复制</button>
    <span class="cwmc-extra">
      <span>已选 <b class="cwmc-count">0</b></span>
      <button data-act="all" title="选中已加载的全部消息（向上滚动可加载更早消息）">全选已加载</button>
      <button data-act="clear">清空</button>
      <button data-act="copy" class="primary">复制</button>
    </span>`;
  document.body.appendChild(bar);

  function toast(text) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:fixed;right:16px;bottom:130px;z-index:99999;background:#333;color:#fff;padding:6px 12px;border-radius:4px;font-size:13px';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  function refresh() {
    bar.querySelector('.cwmc-count').textContent = selected.size;
    bar.querySelector('[data-act=toggle]').textContent = active ? '✕ 退出' : '📋 批量复制';
    document.querySelectorAll('._message[data-mid]').forEach((el) => {
      let cb = el.querySelector(':scope > .cwmc-check');
      if (!cb) {
        cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'cwmc-check';
        el.prepend(cb);
      }
      const on = selected.has(el.dataset.mid);
      cb.checked = on;
      el.classList.toggle('cwmc-selected', on);
    });
  }

  function copySelected() {
    const chats = [...selected].map(getChat).filter(Boolean).sort((a, b) => a.index - b.index);
    if (!chats.length) return toast('没有选中消息');
    // 同一人间隔不超过 GROUP_GAP_SEC 的连续消息合为一段，段与段之间用分隔线
    const blocks = [];
    chats.forEach((c, i) => {
      const prev = chats[i - 1];
      if (prev && prev.aid === c.aid && c.tm - prev.tm <= GROUP_GAP_SEC) {
        blocks[blocks.length - 1] += '\n\n' + convert(c.msg);
      } else {
        blocks.push(formatChat(c));
      }
    });
    const text = blocks.join(`\n${SEPARATOR}\n`);
    if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
    else navigator.clipboard.writeText(text);
    toast(`已复制 ${chats.length} 条消息`);
  }

  bar.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'toggle') {
      active = !active;
      document.body.classList.toggle('cwmc-on', active);
    } else if (act === 'all') {
      loadedChats().forEach((c) => selected.add(String(c.id)));
    } else if (act === 'clear') {
      selected.clear();
    } else if (act === 'copy') {
      copySelected();
    }
    refresh();
  });

  // 点击复选框；按住 Shift 可范围选择
  document.addEventListener('click', (e) => {
    const cb = e.target.closest?.('.cwmc-check');
    if (!cb) return;
    e.stopPropagation();
    const mid = cb.parentElement.dataset.mid;
    const chat = getChat(mid);
    const checked = cb.checked;
    if (e.shiftKey && lastClickedIndex != null && chat) {
      const [lo, hi] = [Math.min(lastClickedIndex, chat.index), Math.max(lastClickedIndex, chat.index)];
      loadedChats()
        .filter((c) => c.index >= lo && c.index <= hi)
        .forEach((c) => (checked ? selected.add(String(c.id)) : selected.delete(String(c.id))));
    } else {
      checked ? selected.add(mid) : selected.delete(mid);
    }
    if (chat) lastClickedIndex = chat.index;
    refresh();
  }, true);

  // 时间线是虚拟滚动，DOM 会不断重建，需要重新挂复选框
  let pending = false;
  new MutationObserver(() => {
    if (!active || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      refresh();
    });
  }).observe(document.body, { childList: true, subtree: true });

  // 切换房间时清空选择
  W.addEventListener('hashchange', () => {
    selected.clear();
    lastClickedIndex = null;
    refresh();
  });
})();
