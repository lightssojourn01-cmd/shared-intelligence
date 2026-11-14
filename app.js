// Dashboard UI. All data goes through data.js; all rules live in logic.js.
import { Doors, makeStore } from './data.js';
import * as L from './logic.js';
import { encryptNote, decryptNote } from './crypto.js';

const store = makeStore(window.localStorage);
const doors = new Doors({ fetch: window.fetch.bind(window), store, origin: location.origin });
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE = 100;
const APP_NAME = 'Shared Intelligence'; // Rename the build here.
const NAV = [['home', 'Overview'], ['work', 'Work'], ['today', 'Needs you'], ['reports', 'Review'], ['feed', 'Feed'], ['activity', 'Activity'], ['notes', 'Notes'], ['board', 'Board'], ['goals', 'Goals'], ['ideas', 'Ideas'], ['messages', 'Messages'], null,
  ['saved', 'Saved'], ['snoozed', 'Snoozed'], ['hidden', 'Hidden'], ['history', 'History'], null, ['agents', 'Agents'], ['projects', 'Projects'], ['resources', 'Resources'], ['settings', 'Settings']];
const TITLES = Object.fromEntries(NAV.filter(Boolean));
const isList = v => !!L.VIEWS[v];
const noFilters = () => ({ q: '', producer: '', topic: '', tag: '', claim: '', status: '', unread: false, sort: 'new' });

const S = {
  view: 'home', filters: noFilters(), expanded: new Set(), selected: new Set(), page: 1, drafts: new Map(), openDetails: new Set(),
  filtersOpen: false, compose: false, sent: new Map(), samples: store.get('si.samples', false),
  base: null, model: null, info: null, error: null, loading: true, usingCache: false,
  pending: store.get('si.pending', []).map(p => p.state === 'sending' ? { ...p, state: 'unsent' } : p), drops: null, stopWatch: null, undo: null,
};
Object.assign(S, { inFlight: 0, reloadLater: false, layout: store.get('si.notesLayout', 'gallery'), editing: null, menu: null, mobileItem: null, decrypted: new Map(), unlock: null, storageError: false, cryptoEpoch: 0, secretDrafts: new Set(), loadGeneration: 0, workId:'', workEditing:null, workOriginal:null, workPendingId:null, workSaving:false });
let now = Date.now();

// ---------- data flow ----------

function rebuild() {
  S.model = S.base ? L.applyPending(S.base, S.pending.filter(p => pStatus(p).key !== 'rejected')) : null;
  if (S.model) S.model = { ...S.model, items: S.model.items.map(it => {
    const value = it.encrypted && S.decrypted.get(it.id);
    return value ? { ...it, title: value.title, body: value.body, color: value.color, baseTags: [...value.tags], locked: false } : it;
  }) };
}
function savePending() { const ok = store.set('si.pending', S.pending); S.storageError = !ok; return ok; }
function lockNotes({ renderNow = true } = {}) {
  S.cryptoEpoch++; S.secretDrafts.clear(); S.decrypted.clear(); S.unlock = null; S.editing = null; S.drafts.clear(); S.filters = noFilters(); S.filtersOpen = false; S.menu = null; S.expanded.clear(); S.selected.clear(); S.undo = null;
  if ($('toast')) $('toast').hidden = true;
  rebuild(); if (renderNow) render();
}
function hasEncryptedDrafts() {
  return S.secretDrafts.size > 0 || [...S.drafts].some(([k,v]) => k.startsWith('edit:') && (k.endsWith(':protection') && v === 'encrypted' || S.model?.items.some(it => it.encrypted && k.startsWith(`edit:${it.id}:`))));
}
function cancelNoteEditor({ renderNow = true } = {}) {
  const id=S.editing, prefix=`edit:${id}:`;
  if (id && (S.secretDrafts.has(id) || S.model?.items.some(it => it.id === id && it.encrypted) || draft(prefix+'protection') === 'encrypted')) {
    S.cryptoEpoch++;
    for (const k of [...S.drafts.keys()]) if (k.startsWith(prefix)) S.drafts.delete(k);
    S.secretDrafts.delete(id);
  }
  S.editing=null;
  if (renderNow) render();
}
let unlockTimer;
function touchUnlock() { clearTimeout(unlockTimer); if (S.decrypted.size) unlockTimer = setTimeout(() => lockNotes(), 5 * 60000); }

const connectionScope = () => JSON.stringify([doors.settings.door, doors.settings.repo, doors.settings.branch, doors.settings.base]);
const pStatus = p => L.pendingStatus(p, { drops: S.drops, syncedAt: S.info?.syncedAt, now });

async function reload({ quiet = false } = {}) {
  if (S.inFlight) { S.reloadLater = true; return; }
  const generation = ++S.loadGeneration, scope = connectionScope();
  const current = () => generation === S.loadGeneration && scope === connectionScope();
  if (!quiet) { S.loading = true; render(); }
  try {
    const res = await doors.load();
    if (!current()) return;
    S.base = L.normalize(res.raw); S.info = res; S.error = null; S.usingCache = false;
    for(const p of S.pending) {
      const conflict=L.workConflict(p,S.base);
      if(conflict) {p.workConflict=true;p.workUnfiled=conflict.reason==='stale_revision';p.state='conflict';}
      else if(p.workConflict && p.record.kind==='work.upserted') {delete p.workConflict;p.state='sent';}
    }
    const text = JSON.stringify(res.raw);
    if (text.length < 3e6 && !text.includes('"visibility":"sensitive"')) store.set('si.cache', { raw: res.raw, syncedAt: res.syncedAt, door: res.door, scope, at: new Date().toISOString() });
    else store.del('si.cache');                       // too large to keep on this device: better none than an old one
    const done = new Set(L.settled(S.pending, S.base).map(p => p.record.event_id));
    if (done.size) { S.pending = S.pending.filter(p => !done.has(p.record.event_id)); savePending(); }
    const waiting = S.pending.filter(p => p.state === 'sent').map(p => p.record.event_id);
    const drops = waiting.length ? await doors.dropStatus(waiting) : null;
    if (!current()) return;
    S.drops = drops;
    if (!S.stopWatch) S.stopWatch = doors.watch(() => reload({ quiet: true }));
  } catch (e) {
    if (!current()) return;
    S.error = e;
    const c = store.get('si.cache', null);
    if (c && !S.base && (c.scope === connectionScope() || (!c.scope && c.door === 'local'))) { S.base = L.normalize(c.raw); S.info = { door: c.door, syncedAt: c.syncedAt || c.at, live: false }; }
    S.usingCache = !!S.base;
  }
  if (!current()) return;
  S.loading = false; rebuild(); render();
  retryUnsent();
}

/**
 * Send one or more records. → { ok, kept, message }
 *   ok   — the change is in the ledger, or safely queued to get there
 *   kept — queued on this device because it could not be sent yet
 */
async function send(recordOrList) {
  const records = Array.isArray(recordOrList) ? recordOrList : [recordOrList];
  if (!records.length) return { ok: true };
  const entries = records.map(record => ({ record, state: 'sending', at: new Date().toISOString() }));
  S.pending.push(...entries);
  if (!savePending()) {
    S.pending = S.pending.filter(p => !entries.includes(p)); rebuild(); render();
    return { ok: false, message: 'Not saved: this browser could not keep the change safely. Nothing was sent. Free storage or allow site storage, then try again.' };
  }
  S.inFlight++; rebuild(); render();
  let out;
  try {
    const r = await doors.write(records);
    for (const e of entries) {
      const o = r.outcomes?.find(o => o.event_id === e.record.event_id);
      e.file = r.file; e.state = o?.rejected ? 'refused' : r.filed || o?.filed ? 'filed' : 'sent';
      e.error = o?.error; e.sentAt = new Date().toISOString();
    }
    const refused = entries.filter(e => e.state === 'refused').length;
    S.pending = S.pending.filter(p => p.state !== 'filed'); S.reloadLater = true;
    out = refused ? { ok: false, message: `${refused} change(s) not accepted. Other changes were saved; see Settings.` } : { ok: true, queued: !r.filed };
  } catch (e) {
    for (const p of entries) { const o = e.outcomes?.find(x => x.event_id === p.record.event_id); p.state = o?.filed ? 'filed' : o?.rejected || e.code === 'REJECTED' ? 'refused' : 'unsent'; p.error = o?.error || e.message; p.code = e.code; }
    if (entries.some(p => p.state === 'filed')) { S.pending = S.pending.filter(p => p.state !== 'filed'); S.reloadLater = true; }
    out = e.code === 'REJECTED' ? { ok: false, message: `Not saved: ${e.message}` } : { ok: true, kept: true, message: e.message };
  } finally { S.inFlight--; }
  savePending(); rebuild(); render();
  if (!S.inFlight && S.reloadLater) { S.reloadLater = false; await reload({ quiet: true }); }
  return out;
}

let retrying = false;
async function retryUnsent(force = false) {
  if (retrying || S.inFlight) return;
  retrying = true; S.inFlight++;
  const list = S.pending.filter(p => (p.state === 'unsent' && (force || !['SLOW_DOWN', 'AUTH', 'NOT_FOUND', 'NEED_TOKEN', 'NEED_REPO', 'SETTINGS', 'PUBLIC_REPO'].includes(p.code))) || (force && ['missing', 'late'].includes(pStatus(p).key)));
  let filed = false;
  try {
    for (const p of list) {
      try {
        const r = await doors.write(p.record), o = r.outcomes?.[0];
        p.file = r.file; p.state = o?.rejected ? 'refused' : r.filed ? 'filed' : 'sent';
        p.error = o?.error; delete p.code; p.sentAt = new Date().toISOString(); filed ||= p.state === 'filed';
      } catch (e) {
        p.error = e.message; p.code = e.code; p.state = e.code === 'REJECTED' ? 'refused' : 'unsent';
        if (['OFFLINE', 'NEED_TOKEN', 'AUTH', 'SLOW_DOWN', 'NOT_FOUND', 'NEED_REPO', 'SETTINGS', 'PUBLIC_REPO'].includes(e.code)) break;
      }
    }
    S.pending = S.pending.filter(p => p.state !== 'filed'); savePending();
  } finally { retrying = false; S.inFlight--; }
  if (filed || S.reloadLater) { S.reloadLater = false; reload({ quiet: true }); } else if (list.length) { rebuild(); render(); }
}

// ---------- small render helpers ----------

function toast(msg, undo = null) {
  S.undo = undo;
  const t = $('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button" class="btn" id="undo-x" data-a="undo" data-id="x">Undo</button>' : ''}`;
  t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; S.undo = null; }, undo ? 20000 : 4500);
}
const stamp = t => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const key = s => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
const draft = (k, d = '') => (S.drafts.has(k) ? S.drafts.get(k) : d);
const agentName = id => (L.isOwner(id) ? 'You' : (S.model?.agents.find(a => a.id === id)?.label) || id);
const said = (r, done, queued) => (!r.ok ? r.message : r.kept ? r.message : r.queued ? queued : done);

function md(src) {
  const inline = t => esc(t)
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, (_, a, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${a}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = []; let list = [];
  const flush = () => { if (list.length) { out.push('<ul>' + list.map(l => `<li>${inline(l)}</li>`).join('') + '</ul>'); list = []; } };
  for (const line of String(src || '').split('\n')) {
    if (/^\s*[-*]\s+/.test(line)) list.push(line.replace(/^\s*[-*]\s+/, ''));
    else { flush(); if (line.trim()) out.push(`<p>${inline(line)}</p>`); }
  }
  flush();
  return out.join('');
}
/** A source reference as { label, url? }. Only real https links become links: these come from agents. */
export function refLabel(r) {
  const raw = String(r?.uri || r?.url || '');
  let u = null; try { u = new URL(raw); } catch {}
  if (u && u.protocol === 'file:') return { label: /\/sessions\/.*\.jsonl$|\/\.claude\/projects\/.*\.jsonl$/i.test(u.pathname)
    ? 'Local session transcript' : decodeURIComponent(u.pathname).replace(/^\/(?=[A-Za-z]:)/,'') };
  if (u && u.protocol === 'https:') {
    const host = u.hostname.replace(/^www\./, '');
    return { label: /(^|\.)outlook\.(live|office)\.com$/i.test(u.hostname) ? 'Outlook message' : host, url: u.href };
  }
  return { label: raw.slice(0, 80) || 'Source' };
}
const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
const btn = (a, id, label, { cls = '', pressed, extra = '' } = {}) =>
  `<button type="button" class="btn ${cls}" id="${a}-${key(id)}" data-a="${a}" data-id="${esc(id)}" ${pressed === undefined ? '' : `aria-pressed="${pressed}"`} ${extra}>${label}</button>`;
const det = (id, summary, body, cls = '') => `<details class="${cls}" data-d="${esc(id)}" ${S.openDetails.has(id) ? 'open' : ''}><summary>${summary}</summary>${body}</details>`;
function agentOptions(cur) {
  const real = L.realAgents(S.model);
  const extra = cur && !real.some(a => a.id === cur) ? [{ id: cur, label: agentName(cur) }] : [];
  return `${cur ? '' : opt('', 'Choose agent…', '')}${[...extra, ...real].map(a => opt(a.id, a.label || a.id, cur)).join('')}`;
}

// ---------- header + nav ----------

function fresh() { return S.info ? L.freshness(S.info.syncedAt, S.info.live && !S.usingCache, now) : { level: 'warn', text: S.loading ? 'Loading…' : 'Not connected' }; }
function renderHeader() {
  const f = fresh();
  $('fresh').className = `pill ${f.level}`;
  $('fresh').textContent = (S.usingCache ? 'Saved copy · ' : '') + f.text;
  $('fresh').title = S.info?.syncedAt ? `The PC last updated the data ${stamp(S.info.syncedAt)}` : '';
  const st = S.pending.map(pStatus), bad = st.filter(s => s.level === 'bad').length;
  const q = $('queue');
  q.hidden = !S.pending.length;
  q.textContent = bad ? `${bad} need attention` : `${S.pending.length} pending`;
  q.className = `pill linkish ${bad ? 'bad' : 'warn'}`;
}

function renderNav() {
  const c = S.model ? L.counts(S.model, { samples: S.samples }, now) : {};
  if(S.model) c.work=L.workReview(S.model,{samples:S.samples}).active.length;
  $('nav').innerHTML = NAV.map(n => (n ? `<button type="button" class="nav-item" id="nav-${n[0]}" data-a="view" data-id="${n[0]}" aria-current="${S.view === n[0] ? 'page' : 'false'}"><span>${esc(n[1])}</span>${(n[0] === 'settings' ? S.pending.length : c[n[0]]) ? `<span class="n">${n[0] === 'settings' ? S.pending.length : c[n[0]]}</span>` : ''}</button>` : '<span class="nav-sep" aria-hidden="true"></span>')).join('');
  $('nav').querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------- rows ----------

function safeRow(row) {
  try { return rowHTML(row); }
  catch { return `<article class="row row-error" role="listitem"><p>Could not display ${esc(row.item?.title || 'this item')}. Other items are still available.</p></article>`; }
}
function rowHTML({ item, v }) {
  const open = S.expanded.has(item.id), sel = S.selected.has(item.id), k = key(item.id), displayAt = item.note ? item.sourceUpdatedAt || item.at : item.at;
  const chips = [
    v.reason ? `<span class="chip need">${esc(v.reason)}</span>` : '',
    v.pinned ? '<span class="chip pinned">Pinned</span>' : '',
    item.encrypted ? `<span class="chip">${item.locked ? 'Encrypted · locked' : 'Encrypted · unlocked'}</span>` : '',
    item.queued ? '<span class="chip wait" title="Changed on this device; the PC has not filed it yet">Waiting for PC</span>' : '',
    item.superseded ? '<span class="chip">Replaced</span>' : '',
    item.synthetic ? '<span class="chip">Sample</span>' : '',
    item.sensitive ? '<span class="chip warn" title="Stays on the PC">Sensitive</span>' : '',
    item.claim !== 'fact' ? `<span class="chip warn">${esc(L.CLAIM[item.claim] || item.claim)}</span>` : '',
    v.status !== 'new' ? `<span class="chip status">${esc(L.STATUS[v.status])}</span>` : '',
    v.due ? `<span class="chip ${v.due.overdue ? 'warn' : ''}">Due ${esc(stamp(v.due.at))}</span>` : '',
    ...v.tags.slice(0, 2).map(t => `<button type="button" class="chip tag" id="tag-${k}-${key(t)}" data-a="tag" data-id="${esc(t)}">${esc(t)}</button>`),
    v.tags.length > 2 ? `<span class="chip">+${v.tags.length - 2}</span>` : '',
    `<span class="chip who">${esc(agentName(item.producer))}</span>`,
  ].join('');
  return `<article class="row${open ? ' open' : ''}${sel ? ' sel' : ''}${v.read ? ' read' : ''}" role="listitem" style="--note-color:${noteColor(item.color)}" data-priority="${esc(v.priority)}" data-note="${!!item.note}" data-row="${esc(item.id)}">
    <div class="row-main">
      <label class="tick"><input type="checkbox" id="sel-${k}" data-a="select" data-id="${esc(item.id)}" ${sel ? 'checked' : ''}><span class="sr">Select ${esc(item.title)}</span></label>
      <button type="button" class="title" id="open-${k}" data-a="open" data-id="${esc(item.id)}" aria-expanded="${open}">
        <span class="chev" aria-hidden="true">›</span>${v.read ? '' : '<span class="dot" aria-hidden="true"></span><span class="sr">Unread. </span>'}<span class="t">${esc(item.title)}</span>
      </button>
      <time class="when" datetime="${esc(displayAt)}" title="${esc(stamp(displayAt))}">${esc(L.ago(displayAt, now))}</time>${btn('item-menu', item.id, 'Actions', { cls: 'row-menu' })}
      <span class="chips">${chips}</span>
    </div>${item.note && !open ? `<p class="note-preview">${esc(item.body.slice(0, 220))}</p>` : ''}${open ? detailHTML(item, v) : ''}
  </article>`;
}

function detailHTML(item, v) {
  const k = key(item.id), m = S.model, mine = L.isOwner(item.producer);
  item.actions ||= [];
  const evid = item.evidence.map(e => `<li><span class="chip ${e.verification === 'direct_check' ? 'ok' : 'warn'}">${e.verification === 'direct_check' ? 'Checked directly' : e.verification === 'inference' ? 'Inference' : 'Source report'}</span> <b>${esc(e.title || e.sourceType || 'Evidence')}</b>${e.summary ? `<p>${esc(e.summary)}</p>` : ''}<p class="small">Source updated ${esc(stamp(e.sourceUpdatedAt))} · read ${esc(stamp(e.observedAt))}</p></li>`).join('');
  const refs = item.refs.map(refLabel).map(r => `<li>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.label)}</a>` : esc(r.label)}</li>`).join('');
  const rc = v.receipts;
  const receipts = !rc.of ? '' : det(`rc:${item.id}`, mine
    ? (rc.fetched ? `Read by ${rc.fetched} of ${rc.of} agents · acted on by ${rc.applied}` : 'No agent has read this yet')
    : `Fetched by ${rc.fetched} of ${rc.of} agents · applied by ${rc.applied}${rc.failed ? ` · ${rc.failed} failed or declined` : ''}`,
    `<ul>${rc.rows.map(r => `<li><span>${esc(r.label)}</span><span class="${r.state === 'applied' ? 'ok-t' : ''}">${esc(r.state)}</span></li>`).join('')}</ul>`, 'rc');
  const thread = item.type === 'message' ? m.threads.find(t => t.id === item.threadId) : null;
  const threadHTML = thread ? `<div class="sec"><h3>Conversation</h3><ol class="thread">${thread.messages.map(x => `<li class="${L.isOwner(x.from) ? 'mine' : ''}"><div class="small">${esc(agentName(x.from))} → ${esc(agentName(x.to))} · ${esc(stamp(x.at))}${x.queued ? ' · waiting for the PC' : x.state && x.state !== 'new' ? ` · ${esc(x.state)}` : ''}</div>${md(x.body)}</li>`).join('')}</ol></div>` : '';
  const toKey = `to:${item.id}`, msgKey = `msg:${item.id}`, to = draft(toKey, L.defaultRecipient(item, m));
  const sent = S.sent.get(item.id);
  const suggestion = item.nextAction ? `About “${item.title}”: ${item.nextAction}` : '';
  const actions = item.actions.length && !mine ? `<div class="sec"><h3>${esc(agentName(item.producer))} offers</h3><div class="acts">${item.actions.map((a, n) => btn('agent-action', `${item.id}|${n}`, esc(a.label))).join('')}</div><p class="small">Review the full reply before sending.</p></div>` : '';
  const ask = `<div class="sec ask"><h3>${item.type === 'message' ? 'Reply' : 'Ask an agent about this'}</h3>
      <div class="ask-row"><label for="to-${k}">To</label><select id="to-${k}" data-draft="${esc(toKey)}">${agentOptions(to)}</select>
        ${suggestion && !draft(msgKey) ? btn('suggest', item.id, 'Use suggested text', { cls: 'link' }) : ''}</div>
      <label for="msg-${k}" class="lbl">Message</label><textarea id="msg-${k}" data-draft="${esc(msgKey)}" rows="3" maxlength="4000">${esc(draft(msgKey))}</textarea>
      <div class="ask-row">${btn('ask', item.id, 'Send', { cls: 'primary' })}${sent ? `<span class="small ok-t">Sent to ${esc(agentName(sent.to))} · ${esc(stamp(sent.at))}${sent.queued ? ' · waiting for the PC' : ''}</span>` : '<span class="small">Goes into the shared record. The agent sees it when it next reads its inbox.</span>'}</div></div>`;
  const tagKey = `tags:${item.id}`, story = item.type === 'story';
  return `<div class="detail">
    <div class="quick" role="group" aria-label="Actions for this item">
      ${btn('close-item', item.id, 'Back to list', { cls: 'mobile-back' })}
      ${item.note && !item.encrypted ? btn('note-edit', item.id, 'Edit note', { cls: 'primary' }) : ''}

      ${btn('done', item.id, v.status === 'done' ? 'Reopen' : 'Mark done')}
      ${btn('read', item.id, v.read ? 'Mark unread' : 'Mark read')}
      ${btn('pin', item.id, v.pinned ? 'Unpin' : 'Pin', { pressed: v.pinned })}
      ${btn('snooze', item.id, v.snoozed ? 'Wake now' : 'Snooze 1 day')}
      ${story ? btn('save', item.id, item.saved ? 'Unsave' : 'Save', { pressed: item.saved }) : ''}
      ${story ? btn('hide', item.id, item.hidden ? 'Restore' : item.note ? 'Remove note' : 'Remove from Feed') : ''}
      <label for="st-${k}" class="inline">Status<select id="st-${k}" data-a="status" data-id="${esc(item.id)}">${Object.entries(L.STATUS).map(([s, l]) => opt(s, l, v.status)).join('')}</select></label>
      ${v.snoozed ? `<span class="small">Snoozed until ${esc(stamp(v.snoozedUntil))}</span>` : ''}
    </div>
    <div class="read">
      ${item.kicker ? `<div class="kicker">${esc(item.kicker)}</div>` : ''}
      <div class="prose">${(item.note ? noteBody(item) : md(item.body)) || `<p class="muted">${esc(item.title)}</p>`}</div>
      ${item.superseded ? '<p class="callout"><b>Replaced.</b> A newer record supersedes this one.</p>' : ''}
      ${item.currentState ? `<p class="callout"><b>Current state:</b> ${esc(item.currentState)}</p>` : ''}
      ${item.desiredOutcome ? `<p class="callout"><b>Desired outcome:</b> ${esc(item.desiredOutcome)}</p>` : ''}
      ${item.nextAction ? `<p class="callout"><b>Suggested next step:</b> ${esc(item.nextAction)}</p>` : ''}
      ${item.whyShown ? `<p class="callout"><b>Why this is here:</b> ${esc(item.whyShown)}</p>` : ''}
      ${item.stats.length ? `<div class="stats">${item.stats.map(s => `<span>${esc(s.label)} <b>${esc(s.value)}</b></span>`).join('')}</div>` : ''}
      ${(item.progress || []).length ? `<div class="sec"><h3>Progress</h3><ul class="timeline">${item.progress.map(p => `<li>${esc(p.title)} <span class="small">· ${esc(stamp(p.at))} · ${esc(agentName(p.by))}</span></li>`).join('')}</ul></div>` : ''}
      ${item.sensitive || item.note ? '' : actions + threadHTML + ask}
      ${evid ? `<div class="sec"><h3>Evidence</h3><ul class="ev">${evid}</ul></div>` : ''}
      ${refs ? `<div class="sec"><h3>Sources</h3><ul class="refs">${refs}</ul></div>` : ''}
    </div>
    <aside class="side">
      <dl>
        <dt>Recorded</dt><dd>${esc(stamp(item.at))}</dd>
        ${item.sourceUpdatedAt ? `<dt>Source updated</dt><dd>${esc(stamp(item.sourceUpdatedAt))}</dd>` : ''}
        ${item.origin ? `<dt>Source</dt><dd>${esc(item.origin)}</dd>` : ''}
        ${item.sourceReadAt ? `<dt>Source read</dt><dd>${esc(stamp(item.sourceReadAt))}</dd>` : ''}
        <dt>Due</dt><dd>${item.dueAt ? esc(stamp(item.dueAt)) : 'No date recorded'}</dd>
        <dt>Confidence</dt><dd>${esc(L.CLAIM[item.claim] || item.claim)}</dd>
        <dt>From</dt><dd>${esc(agentName(item.producer))}</dd>
        ${item.topic ? `<dt>Topic</dt><dd>${esc(item.topic)}</dd>` : ''}
      </dl>
      ${receipts}
      <div class="organize">
        <h3>Organize</h3>
        <label for="pr-${k}">Priority<select id="pr-${k}" data-a="priority" data-id="${esc(item.id)}">${['low', 'normal', 'high'].map(p => opt(p, p[0].toUpperCase() + p.slice(1), v.priority)).join('')}</select></label>
        ${item.encrypted ? '<p class="small">Encrypted content is retained for compatibility.</p>' : `<label for="tg-${k}">Tags, comma separated ${v.ownTags ? '(yours)' : '(from the record)'}<input type="text" id="tg-${k}" data-draft="${esc(tagKey)}" value="${esc(draft(tagKey, v.tags.join(', ')))}" maxlength="400" autocomplete="off"></label>
        <div class="acts">${btn('savetags', item.id, 'Save tags')}${v.ownTags ? btn('inherit', item.id, 'Use the record’s tags', { cls: 'link' }) : ''}</div>`}
      </div>
    </aside>
  </div>`;
}

// ---------- compose + lists ----------

function composeHTML() {
  if (!S.compose) return '';
  const type = draft('c:type', 'message');
  return `<section class="compose" aria-label="New entry">
    <div class="ask-row"><label for="c-type">New</label><select id="c-type" data-draft="c:type" data-rerender="1">${opt('message', 'Message to an agent', type)}${opt('idea', 'Idea', type)}${opt('note', 'Note', type)}</select>
      ${type === 'message' ? `<label for="c-to">To</label><select id="c-to" data-draft="c:to">${agentOptions(draft('c:to', ''))}</select>` : ''}</div>
    <label for="c-title" class="lbl">${type === 'message' ? 'Subject' : 'Title'}</label><input type="text" id="c-title" data-draft="c:title" value="${esc(draft('c:title'))}" maxlength="140" autocomplete="off">
    <label for="c-body" class="lbl">${type === 'message' ? 'Message' : 'Details (optional)'}</label><textarea id="c-body" data-draft="c:body" rows="3" maxlength="${type === 'message' ? 4000 : 19000}">${esc(draft('c:body'))}</textarea>
    <div class="ask-row">${btn('compose-send', 'x', type === 'message' ? 'Send' : 'Add', { cls: 'primary' })}${btn('compose-close', 'x', 'Cancel')}</div>
  </section>`;
}

const EMPTY = {
  today: ['Nothing needs you right now', 'Messages addressed to you, items you flag, and suggested next steps show up here.'],
  saved: ['Nothing saved', 'Save a Feed story from its row.'], snoozed: ['Nothing snoozed', ''], hidden: ['Nothing removed from the Feed', ''],
  history: ['No history yet', 'Records replaced by a newer one, and completed goals, appear here.'],
  ideas: ['No ideas yet', 'Add one with New, or an agent can file one.'], goals: ['No goals yet', ''], messages: ['No messages yet', 'Start one with New.'], feed: ['The Feed is empty', ''],
};
const shownRows = () => listRows().slice(0, S.page * PAGE);

function bulkHTML() {
  if (!S.selected.size) return '';
  const items = [...S.selected].map(itemById).filter(Boolean), vs = items.map(viewOf);
  const any = fn => items.some((it, i) => fn(it, vs[i]));
  const b = (id, label, on) => (on ? btn('bulk', id, label) : '');
  return `<div class="bulk" role="region" aria-label="Actions for selected items"><b>${items.length} selected</b>
    ${b('read', 'Mark read', any((i, v) => !v.read))}${b('unread', 'Mark unread', any((i, v) => v.read))}
    ${b('pin', 'Pin', any((i, v) => !v.pinned))}${b('unpin', 'Unpin', any((i, v) => v.pinned))}
    ${b('snooze', 'Snooze 1 day', any((i, v) => !v.snoozed))}${b('wake', 'Wake now', any((i, v) => v.snoozed))}
    ${b('done', 'Mark done', any((i, v) => v.status !== 'done'))}
    ${b('save', 'Save', any(i => i.type === 'story' && !i.saved))}${b('unsave', 'Unsave', any(i => i.type === 'story' && i.saved))}
    ${b('hide', 'Remove from Feed', any(i => i.type === 'story' && !i.hidden))}${b('restore', 'Restore to Feed', any(i => i.type === 'story' && i.hidden))}
    ${btn('bulk', 'clear', 'Clear selection', { cls: 'link' })}</div>`;
}

function listHTML() {
  const m = S.model, opts = { samples: S.samples }, f = S.filters;
  const all = L.rowsFor(m, S.view, {}, opts, now), rows = listRows(), fc = L.facets(all);
  const active = ['producer', 'topic', 'tag', 'claim', 'status'].filter(x => f[x]).length + (f.unread ? 1 : 0);
  const shown = rows.slice(0, S.page * PAGE);
  const allSel = shown.length > 0 && shown.every(r => S.selected.has(r.item.id));
  const withCur = (list, cur) => (cur && !list.some(([p]) => p === cur) ? [[cur, 0], ...list] : list);
  const empty = EMPTY[S.view] || ['Nothing here', ''];
  return `${S.view === 'notes' ? notesTopHTML() : composeHTML()}
    <div class="controls">
      <div class="search"><label class="sr" for="q">Search this view</label><input type="search" id="q" data-filter="q" value="${esc(f.q)}" placeholder="Search" autocomplete="off"></div>
      <button type="button" class="btn" id="filters-toggle" data-a="filters" data-id="x" aria-expanded="${S.filtersOpen}">Filters${active ? ` (${active})` : ''}</button>
      <label class="sr" for="sort">Sort</label><select id="sort" data-filter="sort">${opt('new', 'Newest', f.sort)}${opt('old', 'Oldest', f.sort)}${opt('priority', 'Priority', f.sort)}${opt('title', 'Title', f.sort)}</select>
    </div>
    ${S.filtersOpen ? `<div class="filters">
      <label for="f-producer">From<select id="f-producer" data-filter="producer">${opt('', 'Anyone', f.producer)}${withCur(fc.producers, f.producer).map(([p, n]) => opt(p, `${agentName(p)} (${n})`, f.producer)).join('')}</select></label>
      <label for="f-topic">Topic<select id="f-topic" data-filter="topic">${opt('', 'Any topic', f.topic)}${withCur(fc.topics, f.topic).map(([p, n]) => opt(p, `${p} (${n})`, f.topic)).join('')}</select></label>
      <label for="f-tag">Tag<select id="f-tag" data-filter="tag">${opt('', 'Any tag', f.tag)}${withCur(fc.tags, f.tag).map(([p, n]) => opt(p, `${p} (${n})`, f.tag)).join('')}</select></label>
      <label for="f-claim">Confidence<select id="f-claim" data-filter="claim">${opt('', 'Any', f.claim)}${Object.entries(L.CLAIM).map(([c, l]) => opt(c, l, f.claim)).join('')}</select></label>
      <label for="f-status">My status<select id="f-status" data-filter="status">${opt('', 'Any', f.status)}${Object.entries(L.STATUS).map(([c, l]) => opt(c, l, f.status)).join('')}</select></label>
      <label class="check" for="f-unread"><input type="checkbox" id="f-unread" data-filter="unread" ${f.unread ? 'checked' : ''}> Unread only</label>
      ${btn('clear-filters', 'x', 'Clear filters')}
    </div>` : ''}
    <div class="selbar">
      <span>${rows.length} ${rows.length === 1 ? 'item' : 'items'}${f.q || active ? ` of ${all.length}` : ''}</span>
      ${shown.length ? btn('select-all', 'x', allSel ? 'Unselect these' : `Select these ${shown.length}`, { cls: 'link' }) : ''}
      ${S.expanded.size ? btn('collapse', 'x', 'Collapse all', { cls: 'link' }) : ''}
    </div>
    ${bulkHTML()}
    <div class="list ${S.view === 'notes' ? S.layout : ''}" role="list">${shown.length ? groupedRows(shown) : `<div class="empty" role="listitem"><b>${esc(f.q || active ? 'Nothing matches' : empty[0])}</b>${esc(f.q || active ? 'Try a different search or clear the filters.' : empty[1])}</div>`}</div>
    ${rows.length > shown.length ? `<div class="more">${btn('more', 'x', `Show ${Math.min(PAGE, rows.length - shown.length)} more`)}<span class="small">${shown.length} of ${rows.length} shown</span></div>` : ''}
    `;
}

// ---------- notes, phone navigation, board ----------
const NOTE_COLORS = { '': '#393b40', yellow: '#66562d', green: '#2d5c4a', blue: '#314f70', pink: '#6a3c58', purple: '#554373' };
function noteColor(color) { return NOTE_COLORS[color] || NOTE_COLORS['']; }
function noteBody(it) {
  if (it.encrypted && it.locked) return '<p>This older encrypted note is retained for compatibility.</p>';
  const checks = new Map(L.checklist(it.body).map(c => [c.line, c]));
  return it.body.split('\n').map((line, n) => checks.has(n)
    ? `<label class="note-check"><input type="checkbox" data-a="note-check" data-id="${esc(it.id)}|${n}" ${checks.get(n).done ? 'checked' : ''} ${it.queued || it.encrypted ? 'disabled' : ''}><span>${esc(checks.get(n).text)}</span></label>`
    : md(line)).join('');
}
function listRows() {
  const rows = L.rowsFor(S.model, S.view, S.filters, { samples: S.samples }, now);
  // A pinned row can move in the ordering, while render() anchors the open row's screen position.
  return rows;
}
function groupedRows(rows) {
  if (S.view !== 'notes') return rows.map(safeRow).join('');
  if (S.layout === 'gallery') { const pinned = rows.filter(r => r.v.pinned), other = rows.filter(r => !r.v.pinned); return (pinned.length ? '<h2 class="date-group" role="presentation">Pinned</h2>' + pinned.map(safeRow).join('') + (other.length ? '<h2 class="date-group" role="presentation">Notes</h2>' : '') : '') + other.map(safeRow).join(''); }
  let prev = '';
  return rows.map(r => {
    const group = r.v.pinned ? 'Pinned' : L.dateGroup(r.item.sourceUpdatedAt || r.item.at, now);
    const heading = group !== prev ? `<h2 class="date-group" role="presentation">${esc(group)}</h2>` : '';
    prev = group; return heading + safeRow(r);
  }).join('');
}
function notesTopHTML() {
  return `<div class="notes-head"><p class="lead">Your notes, together. Changes are saved as new versions.</p><div class="acts">${btn('note-layout', 'x', S.layout === 'gallery' ? 'List view' : 'Gallery view')}</div></div>

    <section class="compose note-quick" aria-label="Quick note"><label for="quick-note">Take a note</label><textarea id="quick-note" data-draft="n:quick" rows="2" maxlength="19000" placeholder="A thought, or - [ ] a checklist item">${esc(draft('n:quick'))}</textarea><div class="acts">${btn('note-save', 'quick', 'Add note', { cls: 'primary' })}${btn('note-edit', 'new', 'Full editor')}</div></section>`;
}
function noteEditorHTML() {
  const it = S.editing !== 'new' ? itemById(S.editing) : null, prefix = `edit:${S.editing}:`;
  const value = (k, fallback = '') => draft(prefix + k, fallback);
  const encrypted = !!it?.encrypted || value('protection', 'plain') === 'encrypted';
  return `<section class="modal note-editor" role="dialog" aria-modal="true" aria-label="${it ? 'Edit note' : 'New note'}"><h2>${it ? 'Edit note' : 'New note'}</h2>
    <label for="n-title">Title<input id="n-title" type="text" data-draft="${esc(prefix)}title" maxlength="140" value="${esc(value('title', it?.title))}"></label>
    <label for="n-body">Note<textarea id="n-body" data-draft="${esc(prefix)}body" rows="10" maxlength="19000" placeholder="Use - [ ] for checklists">${esc(value('body', it?.body))}</textarea></label>
    <div class="two"><label for="n-color">Colour<select id="n-color" data-draft="${esc(prefix)}color">${Object.keys(NOTE_COLORS).map(c => opt(c, c || 'Default', value('color', it?.color || ''))).join('')}</select></label>
    <label for="n-tags">Tags<input id="n-tags" type="text" data-draft="${esc(prefix)}tags" maxlength="400" value="${esc(value('tags', it ? viewOf(it).tags.join(', ') : ''))}"></label></div>
    ${encrypted ? `<p class="callout">Title, text, tags and colour are encrypted before leaving this device. Remember the passphrase: it cannot be recovered here. Encryption does not protect an unlocked note from compromised app code or browser access.</p>
    ${it && !it.encrypted ? '<p class="callout">Earlier plaintext versions remain in ledger and repository history. Encrypting a new version does not erase them.</p>' : ''}
    <label for="n-passphrase">Passphrase (at least 12 characters)<input id="n-passphrase" type="password" minlength="12" maxlength="1024" autocomplete="new-password" spellcheck="false"></label>
    <label for="n-confirm">Confirm passphrase<input id="n-confirm" type="password" maxlength="1024" autocomplete="new-password" spellcheck="false"></label>` : `<label for="n-private">Where to keep it<select id="n-private" data-draft="${esc(prefix)}sensitive" ${it?.sensitive ? 'disabled' : ''}>${opt('false', 'Sync with my private mirror', value('sensitive', String(!!it?.sensitive)))}${opt('true', 'Sensitive: PC and Drive only', value('sensitive', String(!!it?.sensitive)))}</select></label>`}
    <p class="small">Sensitive plaintext notes stay off the remote mirror.</p>
    <div class="acts">${btn('note-save', 'editor', S.noteSaving ? 'Saving…' : 'Save note', { cls: 'primary', extra: S.noteSaving ? 'disabled' : '' })}${btn('note-cancel', 'x', 'Cancel')}</div></section>`;
}
function unlockHTML() {
  return `<section class="modal" role="dialog" aria-modal="true" aria-label="Unlock encrypted note"><h2>Unlock encrypted note</h2><label for="unlock-passphrase">Passphrase<input id="unlock-passphrase" type="password" maxlength="1024" autocomplete="current-password" spellcheck="false"></label><p class="small">Read only in this tab's memory. Lock notes when finished; backgrounding the app also locks them.</p><div class="acts">${btn('note-unlock-confirm',S.unlock,'Unlock',{cls:'primary'})}${btn('note-unlock-cancel','x','Cancel')}</div></section>`;
}
async function saveNote() {
  if (S.noteSaving) return;
  const epoch = S.cryptoEpoch;
  const quick = !S.editing, editing = S.editing, it = !quick && editing !== 'new' ? itemById(editing) : null;
  if (it?.queued) return toast('Wait for this note to finish saving.');
  if (it?.encrypted && it.locked) return toast('Unlock this note before editing.');
  const prefix = `edit:${editing}:`, get = (k, fallback = '') => draft(prefix + k, fallback);
  const body = String(quick ? draft('n:quick') : get('body', it?.body)).trim();
  const title = quick ? '' : String(get('title', it?.title)).trim();
  if (!body && !title) return toast('Write a note first.');
  const tags = quick ? [] : parseTags(get('tags', it ? viewOf(it).tags.join(', ') : ''));
  const color = quick ? '' : get('color', it?.color || '');
  const encrypted = !!it?.encrypted || (!quick && get('protection', 'plain') === 'encrypted');
  let rec, content;
  S.noteSaving = true;
  try {
    if (encrypted) {
      const passphrase = $('n-passphrase')?.value || '', confirm = $('n-confirm')?.value || '';
      if (passphrase !== confirm) return toast('Passphrases do not match.');
      const subjectId = it?.pid || `note:${L.newId()}`;
      content = { title: title || body.split('\n').find(x=>x.trim())?.slice(0,140) || 'Note', body, tags, color };
      const envelope = await encryptNote(content, passphrase, subjectId);
      if (epoch !== S.cryptoEpoch) return;
      if ($('n-passphrase')) $('n-passphrase').value = '';
      if ($('n-confirm')) $('n-confirm').value = '';
      rec = L.records.encryptedNote({ envelope, subjectId, prev: it });
    } else rec = L.records.note({ title, body, color, sensitive: quick ? false : it?.sensitive || get('sensitive', 'false') === 'true', prev: it });
    const records = [rec];
    if (!encrypted && !quick && tags.join('|') !== (it ? viewOf(it).tags.join('|') : '')) records.push(L.records.pref({ id: rec.event_id, pid: rec.subject_id, title: rec.payload.title, sensitive: rec.visibility === 'sensitive' }, { tags }));
    const r = await send(records);
    if (encrypted && epoch !== S.cryptoEpoch) return;
    if (!r.ok) return toast(r.message);
    if (encrypted && epoch === S.cryptoEpoch) { if (it) S.decrypted.delete(it.id); S.decrypted.set(rec.event_id, content); touchUnlock(); }
    if (quick) S.drafts.delete('n:quick'); else for (const k of ['title','body','color','tags','sensitive','protection']) S.drafts.delete(prefix + k);
    S.secretDrafts.delete(editing); S.editing = null; S.expanded.clear(); S.mobileItem = null; document.body.classList.remove('item-focus'); rebuild(); render();
    toast(said(r, 'Note filed.', 'Note uploaded. Waiting for PC to file it.'));
  } catch (e) { toast(e.code ? e.message : 'Could not encrypt or save this note. Your text is still in the editor.'); }
  finally { S.noteSaving = false; if (S.editing && !$('overlay').hidden) render(); }
}
function boardHTML() {
  const cols = L.board(S.model, { samples: S.samples }, now);
  return `<p class="lead">Move work forward with the status menu on each card. Scroll sideways for all four columns.</p><div class="board">${Object.entries(cols).map(([status, rows]) => `<section class="board-col"><h2>${esc(L.STATUS[status])} <span class="count">${rows.length}</span></h2><div class="list" role="list">${rows.map(safeRow).join('') || '<p class="muted">Nothing here</p>'}</div></section>`).join('')}</div>`;
}
function renderMobile() {
  $('mobile-tabs').innerHTML = [['home','Overview'],['today','Needs you'],['feed','Feed'],['notes','Notes'],['more-menu','More']].map(([id,label]) => btn(id === 'more-menu' ? 'more-menu' : 'view', id, label, { pressed: S.view === id })).join('');
}
function renderOverlay() {
  const x = S.menu;
  $('overlay').hidden = !x && !S.editing && !S.unlock && !S.workEditing;
  $('overlay').innerHTML = S.workEditing ? workEditorHTML() : S.unlock ? unlockHTML() : S.editing ? noteEditorHTML() : !x ? '' : x.type === 'reply'
    ? `<section class="modal" role="dialog" aria-modal="true" aria-label="Review reply"><h2>Send to ${esc(agentName(x.to))}?</h2><p class="small">This exact text will be recorded as your reply.</p><pre class="reply-preview">${esc(x.body)}</pre><div class="acts">${btn('confirm-reply','x','Confirm and send',{cls:'primary'})}${btn('cancel-menu','x','Cancel')}</div></section>`
    : x.type === 'actions' ? `<section class="modal" role="dialog" aria-modal="true" aria-label="Item actions"><h2>${esc(itemById(x.id)?.title)}</h2><div class="acts">${['pin','done','snooze','hide'].filter(a => a !== 'hide' || itemById(x.id)?.type === 'story').map(a => btn('menu-'+a,x.id,{pin:'Toggle pin',done:'Toggle done',snooze:'Toggle snooze',hide:'Remove / restore'}[a])).join('')}${btn('cancel-menu','x','Cancel')}</div></section>`
    : `<section class="modal" role="dialog" aria-modal="true" aria-label="More views"><h2>More</h2><div class="more-views">${NAV.filter(n => n && !['home','today','feed','notes'].includes(n[0])).map(([id,label]) => btn('view',id,label)).join('')}</div>${btn('cancel-menu','x','Close')}</section>`;
  document.body.classList.toggle('has-modal', !$('overlay').hidden);
}
function openItem(id) {
  if (S.expanded.has(id)) { S.expanded.delete(id); if (S.mobileItem === id) closeItem(); else render(); return; }
  S.expanded.add(id);
  if (matchMedia('(max-width:740px)').matches) {
    S.expanded.clear(); S.expanded.add(id); S.mobileItem = id; document.body.classList.add('item-focus');
    history.pushState({ item: id, view: S.view }, '', '#' + S.view);
  }
  render();
  if (S.mobileItem) $(`open-${key(id)}`)?.scrollIntoView({ block: 'start' });
}
function closeItem() {
  if (S.mobileItem && history.state?.item) { history.back(); return; }
  S.expanded.clear(); S.mobileItem = null; document.body.classList.remove('item-focus'); render();
}
function replyRecords(it, to, body, actionId) {
  const tid = it.type === 'message' ? it.threadId : `about-${it.pid || it.id}`;
  const out = [L.records.message({ to, body, threadId: tid, threadTitle: `About: ${it.title}`, about: it.id, actionId })];
  // Completing the prompt removes it from Needs you while leaving the reply thread open.
  out.push(L.records.pref(it, { status: 'in_progress', read: true }));
  if (it.type === 'message') out.push({ event_id: L.newId(), kind:'message.state', subject_id:`thread:${tid}`, summary:'Owner replied', payload:{ message_event_id:it.id, state:'completed' } });
  return out;
}
window.addEventListener('popstate', () => { S.expanded.clear(); S.mobileItem = null; document.body.classList.remove('item-focus'); render(); });
let gesture = null, holdTimer, suppressRowClickUntil = 0;
document.addEventListener('pointerdown', e => {
  const row = e.target.closest('[data-row]');
  if (!row || e.target.closest('input,textarea,select,a,.detail') || (e.target.closest('button') && !e.target.closest('[data-a="open"]'))) return;
  gesture = { id:row.dataset.row, x:e.clientX, y:e.clientY };
  holdTimer = setTimeout(() => { if (gesture) { S.menu = { type:'actions', id:gesture.id }; gesture = null; suppressRowClickUntil = Date.now()+500; render(); } }, 600);
});
document.addEventListener('pointermove', e => { if (gesture && Math.hypot(e.clientX-gesture.x,e.clientY-gesture.y)>12) clearTimeout(holdTimer); });
document.addEventListener('pointerup', e => {
  clearTimeout(holdTimer); if (!gesture) return;
  const g=gesture; gesture=null; const dx=e.clientX-g.x, dy=e.clientY-g.y;
  if (Math.abs(dx)>85 && Math.abs(dy)<45) { suppressRowClickUntil = Date.now()+500; if (dx>0) onAction(itemById(g.id)?.note ? 'pin' : 'done', g.id); else { S.menu = { type:'actions', id:g.id }; render(); } }
});
document.addEventListener('pointercancel', () => { clearTimeout(holdTimer); gesture=null; });
let pullY = null;
document.addEventListener('touchstart', e => { pullY = window.scrollY <= 0 && !e.target.closest('input,textarea,.modal,.row') ? e.touches[0]?.clientY : null; }, {passive:true});
document.addEventListener('touchend', e => { if (pullY != null && e.changedTouches[0]?.clientY-pullY>110) reload(); pullY=null; }, {passive:true});

// ---------- overview ----------

function homeHTML() {
  const o = L.overview(S.model, { samples: S.samples }, now), f = fresh();
  const link = r => `<li><button type="button" class="linkrow" id="go-${key(r.item.id)}" data-a="goto" data-id="${esc(r.item.id)}"><span class="t">${esc(r.item.title)}</span><span class="small">${esc(r.v.reason || agentName(r.item.producer))} · ${esc(L.ago(r.item.at, now))}</span></button></li>`;
  const card = (title, body, more) => `<section class="card"><div class="card-top"><h2>${title}</h2>${more || ''}</div>${body}</section>`;
  const go = (view, label) => `<button type="button" class="btn link" id="more-${view}" data-a="view" data-id="${view}">${label}</button>`;
  const bad = S.pending.map(pStatus).filter(s => s.level === 'bad').length;
  return `${workHubHTML()}${composeHTML()}<div class="home">
    ${o.brief ? `<section class="card brief"><div class="card-top"><h2>${esc(o.brief.item.title)}</h2><span class="small">${esc(agentName(o.brief.item.producer))} · ${esc(stamp(o.brief.item.at))}</span></div><div class="prose">${md(o.brief.item.body)}</div>${(o.brief.item.actions || []).length ? `<div class="acts">${(o.brief.item.actions || []).map((a, n) => btn('agent-action', `${o.brief.item.id}|${n}`, esc(a.label))).join('')}</div>` : ''}</section>` : ''}
    ${card(`Needs you <span class="count ${o.needs.count ? 'hot' : ''}">${o.needs.count}</span>`, o.needs.count ? `<ul class="links">${o.needs.top.map(link).join('')}</ul>` : '<p class="muted">Nothing is waiting on you.</p>', o.needs.count > o.needs.top.length ? go('today', `All ${o.needs.count}`) : '')}
    ${card('Status', `<dl class="facts">
        <dt>Data</dt><dd><span class="chip ${f.level === 'ok' ? 'ok' : 'warn'}">${esc(f.text)}</span></dd>
        <dt>Your changes</dt><dd>${S.pending.length ? `${S.pending.length - bad} pending${bad ? `, ${bad} not accepted or need attention` : ''}` : 'All filed'}</dd>
        <dt>Unread stories</dt><dd>${o.unread}</dd>
        <dt>Not yet verified</dt><dd>${o.unverified}</dd>
        ${S.model.skipped.length ? `<dt>Unreadable records</dt><dd>${S.model.skipped.length} skipped</dd>` : ''}
      </dl>`, S.pending.length ? go('settings', 'See changes') : '')}
    ${card('Agents', `<ul class="agents">${o.agents.map(a => `<li><span class="t">${esc(a.label)}</span><span class="chip ${a.state === 'active' ? 'ok' : 'warn'}">${a.state === 'active' ? 'Active' : a.state === 'quiet' ? 'Quiet 3+ days' : 'No records yet'}</span><span class="small">${a.records ? `${a.recent} in 7 days · last ${esc(L.ago(a.last, now))} ago` : ''}</span></li>`).join('')}</ul>`, go('agents', 'Details'))}
    ${o.due.length ? card('Due in the next 7 days', `<ul class="links">${o.due.map(r => `<li><button type="button" class="linkrow" id="due-${key(r.item.id)}" data-a="goto" data-id="${esc(r.item.id)}"><span class="t">${esc(r.item.title)}</span><span class="small ${r.v.due.overdue ? 'warn-t' : ''}">${r.v.due.overdue ? 'Overdue · ' : ''}${esc(stamp(r.item.dueAt))}</span></button></li>`).join('')}</ul>`) : ''}
    ${o.goals.length ? card('Goals', `<ul class="links">${o.goals.map(r => `<li><button type="button" class="linkrow" id="goal-${key(r.item.id)}" data-a="goto" data-id="${esc(r.item.id)}"><span class="t">${esc(r.item.title)}</span><span class="small">${esc(r.item.currentState || L.STATUS[r.v.status])}</span></button></li>`).join('')}</ul>`, go('goals', 'All goals')) : ''}
    ${o.notes.length ? card('Notes', `<ul class="links">${o.notes.map(link).join('')}</ul>`, go('notes', 'All notes')) : ''}
    ${card('Latest', o.latest.length ? `<ul class="links">${o.latest.map(link).join('')}</ul>` : '<p class="muted">No stories yet.</p>', go('feed', 'Open the Feed'))}
    ${o.sessions.length ? card('Recent work sessions', `<ul class="agents">${o.sessions.map(s => `<li><span class="t">${esc(s.name)}</span><span class="small">${esc(agentName(s.agent))} · ${s.stories} ${s.stories === 1 ? 'story' : 'stories'} · ${esc(L.ago(s.last, now))} ago</span></li>`).join('')}</ul>`) : ''}
    ${o.failed.length ? card('Could not be delivered', `<ul class="links">${o.failed.map(link).join('')}</ul>`) : ''}
  </div>`;
}

function workLink(w) {
  return `<button type="button" class="work-link" data-a="open-work" data-id="${esc(w.id)}"><span>${esc(w.title)}</span><span class="small">${esc(L.WORK_STATUS[w.status])} · ${esc(w.stage || 'Stage not recorded')}</span></button>`;
}
function workHubHTML() {
  const r=L.workReview(S.model,{samples:S.samples});
  return `<section class="work-hub" aria-label="Current work"><div class="work-heading"><div><h2>Work that carries forward</h2><p class="small">Requests, next actions and evidence stay together across sessions.</p></div><div class="acts">${btn('work-new','x','New work',{cls:'primary'})}${btn('view','work','All work')}${btn('view','reports','Review')}</div></div>
    <dl class="work-metrics"><div><dt>Open requests</dt><dd>${r.active.length}</dd></div><div><dt>Waiting or blocked</dt><dd>${r.waiting.length}</dd></div><div><dt>Needs you</dt><dd>${r.ownerAttention.length}</dd></div><div><dt>Completion needs verification</dt><dd>${r.needsVerification.length}</dd></div></dl>
    ${r.active.length ? `<ul class="work-brief">${r.active.slice(0,4).map(w=>`<li>${workLink(w)}<p><b>Next:</b> ${esc(w.next_action || 'Next action not recorded.')}</p><p class="small">Responsible: ${esc(w.responsible || 'Unassigned')} · Last reported ${esc(stamp(w.updated_at))}</p></li>`).join('')}</ul>` : '<p class="muted">No open work is recorded. Start with a request you want carried into the next session.</p>'}</section>`;
}
function workEvidenceHTML(evidence) {
  return evidence.length ? `<ul class="work-evidence">${evidence.map(e=>{const r=refLabel(e);return `<li>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.label)}</a>` : esc(r.label)}</li>`;}).join('')}</ul>` : '<p class="small">No evidence references recorded.</p>';
}
function workCardHTML(w) {
  const unresolved=w.dependencies.filter(d=>d.state!=='resolved'), conflicts=w.conflicts.filter(c=>!c.resolved_by);
  return `<section class="card work-card"><div class="card-top">${workLink(w)}<span class="chip ${['waiting','blocked'].includes(w.status)?'warn':''}">${esc(L.WORK_STATUS[w.status])}</span></div>
    <p>${esc(w.request)}</p><dl class="work-facts"><dt>Responsible</dt><dd>${esc(w.responsible || 'Unassigned')}</dd><dt>Next</dt><dd>${esc(w.next_action || 'Not recorded')}</dd><dt>Verification</dt><dd>${esc(L.WORK_VERIFICATION[w.verification.state])}</dd></dl>
    ${w.waiting ? `<p class="callout"><b>Waiting${w.waiting_on ? ' on '+esc(w.waiting_on) : ''}:</b> ${esc(w.waiting)}</p>` : ''}
    <p class="small">${unresolved.length} open ${unresolved.length===1?'dependency':'dependencies'} · ${conflicts.length} unresolved ${conflicts.length===1?'conflict':'conflicts'} · Last reported ${esc(stamp(w.updated_at))}</p></section>`;
}
function workQueueHTML(id=null) {
  const pending=S.pending.filter(p=>p.record.kind==='work.upserted' && (!id || p.record.subject_id===id));
  if(!pending.length) return '';
  return `<section class="callout work-card"><h3>Work changes on this device</h3><ul class="work-review-list">${pending.map(p=>`<li><b>${esc(p.record.payload.title || p.record.subject_id)}</b><p>${esc(pStatus(p).label)}</p>${p.workConflict?btn('work-review-conflict',p.record.event_id,'Review my change'):btn('open-work',p.record.subject_id,'View work')}</li>`).join('')}</ul></section>`;
}
function workHTML() {
  const all=L.workRows(S.model,{samples:S.samples});
  if(S.workId) {
    const w=all.find(w=>w.id===S.workId);
    if(!w) return `${workQueueHTML(S.workId)}<div class="empty"><b>This work is not in the current snapshot</b><p>Refresh to check the latest filed state. Device changes remain listed separately until the canonical result arrives.</p>${btn('view','work','All work')}${btn('view','settings','Device queue')}</div>`;
    const sessions=L.workSessions(w,S.model.sessions);
    return `<div class="work-heading"><div><h2>${esc(w.title)}</h2><p class="small">${esc(w.project || 'No project')} · Last reported ${esc(stamp(w.updated_at))}</p></div><div class="acts">${btn('view','work','All work')}${btn('work-edit',w.id,'Update work',{cls:'primary'})}</div></div>
      ${workQueueHTML(w.id)}
      <div class="work-detail-grid"><section class="card work-card"><h3>Requested outcome</h3><p>${esc(w.request)}</p><dl class="work-facts"><dt>Status reported</dt><dd>${esc(L.WORK_STATUS[w.status])}</dd><dt>Stage</dt><dd>${esc(w.stage || 'Not recorded')}</dd><dt>Responsible</dt><dd>${esc(w.responsible || 'Unassigned')}</dd><dt>Next action</dt><dd>${esc(w.next_action || 'Not recorded')}</dd></dl>${w.waiting ? `<p class="callout"><b>Waiting${w.waiting_on?' on '+esc(w.waiting_on):''}:</b> ${esc(w.waiting)}</p>` : ''}
      <h3>Dependencies</h3>${w.dependencies.length ? `<ul>${w.dependencies.map(d=>`<li><b>${esc(d.title)}</b> — ${esc(d.state)}${d.owner?' · '+esc(d.owner):''}</li>`).join('')}</ul>` : '<p class="small">No dependencies recorded.</p>'}</section>
      <section class="card work-card"><h3>${esc(L.WORK_VERIFICATION[w.verification.state])}</h3><p>${esc(w.verification.detail || 'No verification detail recorded.')}</p>${w.verification.by?`<p class="small">Recorded by ${esc(w.verification.by)}</p>`:''}${workEvidenceHTML(w.evidence)}<p class="small">Reported work status, producer verification and consumer acceptance are separate observations. Consumer acceptance: ${esc(w.acceptance.state)}${w.acceptance.scope?' · '+esc(w.acceptance.scope):''}.</p></section></div>
      <section class="card work-card"><h3>Session continuity</h3>${sessions.length ? sessions.map(s=>`<details><summary>${esc(s.title || s.id)} · ${esc(s.vendor)}</summary><p class="small">${esc(s.id)}</p>${s.checkpoints.length?`<ol class="work-history">${[...s.checkpoints].reverse().map(c=>`<li><b>${esc(c.mission?.title || 'Checkpoint')}</b><p>${esc(c.did)}</p><p><b>Next:</b> ${esc(c.next || 'Not recorded')}</p><p class="small">${esc(stamp(c.at))} · ${esc(c.claim || 'reported')}</p></li>`).join('')}</ol>`:'<p>No checkpoint for this work has been recorded in this snapshot.</p>'}</details>`).join(''):'<p class="small">No session references or linked checkpoints recorded.</p>'}</section>
      <details class="card work-card"><summary>Revision and correction history</summary><p class="small">Work ${esc(w.id)} · Revision ${esc(w.revision)}</p><ol class="work-history">${[...w.history].reverse().map(h=>`<li>${esc(h.summary || h.correction || h.kind || 'Work update')} <span class="small">${esc(stamp(h.at || h.occurred_at))} · ${esc(h.producer || '')}</span></li>`).join('') || '<li>No revision details in this snapshot.</li>'}</ol>${w.conflicts.length?`<h3>Conflicting updates</h3><ul>${w.conflicts.map(c=>`<li>${esc(c.event_id)} — ${c.resolved_by?'Resolution recorded':'Filed but not applied'}${c.resolved_by?` <span class="small">${esc(c.resolved_by)}</span>`:''}</li>`).join('')}</ul>`:''}</details>`;
  }
  return `<div class="work-heading"><p class="lead">One request can span several sessions. Open it to see the next action, evidence and handoffs.</p>${btn('work-new','x','New work',{cls:'primary'})}</div>${workQueueHTML()}${all.length?`<div class="cards wide">${all.map(workCardHTML).join('')}</div>`:'<div class="empty"><b>No work recorded yet</b><p>Create a request or have an agent register existing unfinished work.</p></div>'}`;
}
function reportsHTML() {
  const r=L.workReview(S.model,{samples:S.samples});
  const section=(title,items,empty)=>`<section class="card work-card"><h2>${esc(title)} <span class="count">${items.length}</span></h2>${items.length?`<ul class="work-review-list">${items.map(w=>`<li>${workLink(w)}<p>${esc(w.next_action || w.waiting || 'Next action not recorded.')}</p></li>`).join('')}</ul>`:`<p class="muted">${esc(empty)}</p>`}</section>`;
  return `<p class="lead">An operational review of the current work records. Last-reported status, recorded verification and unresolved effects remain distinct.</p><div class="work-heading">${btn('view','work','Open work')}${btn('work-new','x','New work')}</div><div class="cards wide">
    ${section('Needs your input',r.ownerAttention,'No current work explicitly asks for owner input.')}
    ${section('Waiting, paused or dependent',r.waiting,'No open work is waiting, paused or dependent.')}
    ${section('Responsibility unassigned',r.unassigned,'Open work has a responsible party recorded.')}
    ${section('Actions awaiting target readback',r.uncertainActions,'No native actions are awaiting target readback.')}
    ${section('Completion awaits consumer acceptance',r.needsAcceptance,'Completed outcomes have consumer acceptance recorded.')}
    ${section('Completion needs verification',r.needsVerification,'No reported completion is awaiting recorded verification.')}
    ${section('Completed with open dependencies',r.completionDependencies,'Reported completions have no open dependency records.')}
    ${section('Unresolved conflicting updates',r.conflicts,'No unresolved revision conflicts recorded.')}
    ${section('Recent work updates',r.recent,'No work updates yet.')}</div><p class="small">${r.completed.length} completed as reported · ${r.verified.length} with verification recorded · ${r.accepted.length} accepted by a consumer. Counts describe records, not live process health or independent certification.</p>`;
}
function workEditorHTML() {
  const w=S.workOriginal, d=(k,fallback='')=>draft('w:'+k,w?.[k]??fallback), v=draft('w:verification',w?.verification?.state || 'unverified');
  const input=(id,label,value,area=false)=>`<label for="w-${id}">${label}${area?`<textarea id="w-${id}" data-draft="w:${id}" rows="3">${esc(value)}</textarea>`:`<input id="w-${id}" data-draft="w:${id}" value="${esc(value)}">`}</label>`;
  return `<section class="modal work-editor" role="dialog" aria-modal="true" aria-label="${w?'Update work':'New work'}"><h2>${w?'Update work':'New work'}</h2>
    ${S.workPendingId?'<p class="callout">Review your earlier change against the latest work. Saving records an explicit correction.</p>':''}
    ${input('title','Title',d('title'))}${input('request','Requested outcome',d('request'),true)}<div class="work-form-grid">${input('project','Project',d('project'))}${input('responsible','Responsible person or agent',d('responsible'))}
    <label for="w-status">Status reported<select id="w-status" data-draft="w:status">${Object.entries(L.WORK_STATUS).map(([id,label])=>opt(id,label,d('status','queued'))).join('')}</select></label>${input('stage','Current stage',d('stage'))}</div>
    ${input('next_action','Next useful action',d('next_action'),true)}${input('waiting','Waiting detail',d('waiting'),true)}<label for="w-waiting_on">Waiting on<select id="w-waiting_on" data-draft="w:waiting_on">${[['','Not specified'],['owner','Owner input'],['external','External dependency'],['agent','Agent action']].map(([id,label])=>opt(id,label,d('waiting_on',''))).join('')}</select></label>
    <details data-d="work-editor-evidence" ${S.openDetails.has('work-editor-evidence')?'open':''}><summary>Evidence, verification and correction</summary>${input('evidence','Evidence locations, one per line',draft('w:evidence',(w?.evidence || []).map(e=>e.uri).join('\n')),true)}<label for="w-verification">Verification recorded<select id="w-verification" data-draft="w:verification">${Object.entries(L.WORK_VERIFICATION).map(([id,label])=>opt(id,label,v)).join('')}</select></label>
    ${input('verification_detail','What was checked',draft('w:verification_detail',w?.verification?.detail || ''),true)}${input('verification_by','Who checked it',draft('w:verification_by',w?.verification?.by || 'owner-ui'))}${input('correction','Correction or decision',draft('w:correction',''),true)}</details>
    <p class="small">Saving a completed status does not change the verification selection. Existing dependencies and session references are retained.</p><div class="acts">${btn('work-save','x',S.workSaving?'Saving…':'Save work',{cls:'primary',extra:S.workSaving?'disabled':''})}${w?btn('work-rebase','x','Load latest, keep edits'):''}${btn('work-cancel','x','Cancel')}</div></section>`;
}
function startWorkEditor(w=null,pending=null) {
  for(const k of [...S.drafts.keys()]) if(k.startsWith('w:')) S.drafts.delete(k);
  S.workOriginal=w?structuredClone(w):null;S.workEditing=w?.id || 'new';S.workPendingId=pending?.record.event_id || null;
  if(pending) {for(const [k,v] of Object.entries(pending.record.payload)) if(['title','request','project','status','stage','responsible','next_action','waiting','waiting_on'].includes(k)) S.drafts.set('w:'+k,v);
    const p=pending.record.payload;S.drafts.set('w:evidence',(p.evidence || []).map(e=>e.uri).join('\n'));S.drafts.set('w:verification',p.verification?.state || 'unverified');S.drafts.set('w:verification_detail',p.verification?.detail || '');S.drafts.set('w:verification_by',p.verification?.by || 'owner-ui');S.drafts.set('w:correction','Reviewed conflicting change '+pending.record.event_id);}
  render();$('w-title')?.focus();
}
async function saveWork() {
  if(S.workSaving) return;
  const w=S.workOriginal,get=(k,def='')=>String(draft('w:'+k,w?.[k]??def)).trim();
  const title=get('title'),request=get('request');
  if(!title || !request) {toast('Give the work a title and requested outcome.');return $(title?'w-request':'w-title')?.focus();}
  const uris=String(draft('w:evidence',(w?.evidence || []).map(e=>e.uri).join('\n'))).split('\n').map(s=>s.trim()).filter(Boolean);
  const evidence=uris.map(uri=>(w?.evidence || []).find(e=>e.uri===uri) || {uri});
  const verification={state:String(draft('w:verification',w?.verification?.state || 'unverified')),detail:String(draft('w:verification_detail',w?.verification?.detail || '')).trim(),by:String(draft('w:verification_by',w?.verification?.by || 'owner-ui')).trim()};
  if(verification.state==='verified' && (!verification.detail || !verification.by || !evidence.length)) return toast('Recorded verification needs what was checked, who checked it and an evidence location.');
  const pendingId=S.workPendingId,rec=L.records.work({prev:w,changes:{title,request,project:get('project'),status:get('status','queued'),stage:get('stage'),responsible:get('responsible'),next_action:get('next_action'),waiting:get('waiting'),waiting_on:get('waiting_on'),evidence,verification,correction:String(draft('w:correction','')).trim(),resolved_conflicts:[...(w?.resolved_conflicts || []),...(pendingId?[pendingId]:[])]}});
  S.workSaving=true;render();const r=await send(rec);S.workSaving=false;
  if(!r.ok) {if(S.pending.some(p=>p.record.event_id===rec.event_id)) S.workPendingId=rec.event_id;render();return toast(r.message);}
  const current=S.model.work.find(w=>w.id===rec.subject_id),applied=current && (current.revision===rec.event_id || current.history.some(h=>h.event_id===rec.event_id));
  if(!r.queued && !r.kept && !applied) {if(!S.pending.some(p=>p.record.event_id===rec.event_id)) S.pending.push({record:rec,state:'conflict',workConflict:true,at:new Date().toISOString()});savePending();render();return toast('The update was filed but was not applied. Review the current work revision.');}
  if(pendingId) {S.pending=S.pending.filter(p=>p.record.event_id!==pendingId);savePending();}
  S.workEditing=null;S.workOriginal=null;S.workPendingId=null;setView('work',{workId:rec.subject_id});
  toast(r.kept?'Work change is saved on this device and awaits upload.':r.queued?'Work change uploaded; waiting for canonical filing.':'Work update applied.');
}

function resourcesHTML() {
  const resources=S.model.resources || [], preferences=S.model.preferences || [];
  return '<h2>Standing preferences</h2><ul>' + preferences.map(p=>`<li>${esc(p.text)} <span class="small">${esc(p.authority || 'reported')}</span></li>`).join('') + '</ul><h2>Native sources and workflows</h2>' +
    (resources.map(r=>`<section class="card continuity-card" style="padding:16px;margin-bottom:12px"><h3>${esc(r.title)}</h3><p>${esc(r.purpose)}</p><p>${esc(r.uri)}</p><p class="small">${esc(r.status)} · ${esc(r.checked_at || 'Not checked')} · ${esc(r.detail || '')}</p></section>`).join('') || '<p>No resources registered yet.</p>');
}

function activityHTML() {
  const sessions = [...(S.model.sessions || [])].sort((a,b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  if (!sessions.length) return '<div class="empty"><b>No activity checkpoints yet</b><p>Meaningful results, decisions and handoffs will appear here. Routine tool calls stay in local session history.</p></div>';
  return '<p class="small">Session → Goal → Mission. Agent reports and evidence preserve handoff context. A finished reply does not mean a finished goal.</p>' + sessions.map(s => `<section class="card continuity-card" style="margin-bottom:16px;padding:16px">
    <h2>${esc(s.title || s.id)}</h2><p class="small">${esc(s.project)} · ${esc(s.vendor)} · ${esc(stamp(s.updated_at))}</p>
    <h3>Goal: ${esc(s.goal.title)} <span class="small">${esc(s.goal.state)}</span></h3>
    <h3>Mission: ${esc(s.mission.title)} <span class="small">${esc(s.mission.state)}</span></h3>
    <p>${esc(s.did)}</p><p><b>Next:</b> ${esc(s.next || 'No next action recorded.')}</p>
    ${s.waiting ? `<p class="callout"><b>Waiting:</b> ${esc(s.waiting)}</p>` : ''}
    <details><summary>Handoff and checkpoint history</summary><p><b>Verification reported:</b> ${esc(s.verification || 'No verification reported.')}</p>
    <p class="small">Session: ${esc(s.id)} · Work: ${esc(s.work_id || 'unspecified')}</p>
    <ul>${(s.evidence || []).map(e => `<li>${esc(e.uri)}</li>`).join('')}</ul>
    <ol>${[...(s.checkpoints || [])].reverse().map(c => `<li><b>${esc(c.mission.title)} · ${esc(c.reason)}</b><p>${esc(c.did)}</p><span class="small">${esc(stamp(c.at))} · ${esc(c.claim)}</span></li>`).join('')}</ol></details></section>`).join('');
}

// ---------- other views ----------

function agentsHTML() {
  const rows = L.agentRows(S.model, { samples: S.samples }), quiet = rows.filter(r => !r.records);
  const src = S.model.sources.filter(s => S.samples || !/sample/.test(String(s.id)));
  return `<p class="lead">Every record is published by one agent. The others leave a receipt when they fetch it, and another when they have applied it in their own interface.</p>
    <div class="cards">${rows.map(r => `<div class="card"><div class="card-top"><b>${esc(r.label)}</b><span class="chip ${r.records ? 'ok' : 'warn'}">${r.records ? 'Publishing' : 'No records yet'}</span></div>
      <dl><dt>Records</dt><dd>${r.records}</dd><dt>Last record</dt><dd>${r.last ? esc(stamp(r.last)) : '—'}</dd><dt>Fetched</dt><dd>${r.fetched + r.applied}</dd><dt>Applied</dt><dd>${r.applied}</dd></dl></div>`).join('')}</div>
    ${quiet.length ? `<p class="lead">${quiet.length} registered ${quiet.length === 1 ? 'agent has' : 'agents have'} published nothing yet: ${quiet.map(q => esc(q.label)).join(', ')}. That is a gap in coverage, not “no news”.</p>` : ''}
    ${src.length ? `<h2>Sources</h2><div class="cards">${src.map(s => `<div class="card"><div class="card-top"><b>${esc(s.label || s.id)}</b><span class="chip ${s.error ? 'warn' : 'ok'}">${s.error ? 'Check failed' : 'OK'}</span></div><dl><dt>Last success</dt><dd>${esc(stamp(s.last_success))}</dd>${s.error ? `<dt>Error</dt><dd>${esc(s.error)}</dd>` : ''}</dl></div>`).join('')}</div>` : ''}`;
}

function projectsHTML() {
  const ps = S.model.projects.filter(p => S.samples || !/sample/.test(String(p.id)));
  if (!ps.length) return '<div class="empty"><b>No projects yet</b>A project appears when an agent records work under it.</div>';
  return `<div class="cards wide">${ps.map(p => `<div class="card"><div class="card-top"><b>${esc(p.name)}</b>${p.status ? `<span class="chip">${esc(p.status)}</span>` : ''}</div>
    ${p.description ? `<p>${esc(p.description)}</p>` : ''}
    <ul class="timeline">${(Array.isArray(p.activity) ? p.activity : []).slice(-6).reverse().map(a => `<li>${esc(a.summary)} <span class="small">· ${esc(stamp(a.at))} · ${esc(agentName(a.producer))}</span></li>`).join('') || '<li class="small">No activity recorded.</li>'}</ul></div>`).join('')}</div>`;
}

function githubFields() {
  const s = doors.settings, d = (k, def) => draft(`s:${k}`, def);
  return `<ol class="steps"><li>Use the separate <b>private data-only repository</b> prepared by the PC mirror setup. The public Pages repository contains only the app files.</li><li>Create a fine-grained GitHub token limited to that private data repository, with Contents: Read and write.</li><li>Enter its owner/name, branch, ledger path and token below. Save and connect verifies the repository is private.</li></ol>
    <label for="s-token">GitHub token ${s.token ? '(one is stored on this device)' : ''}<input type="password" id="s-token" data-draft="s:token" value="${esc(d('token', ''))}" placeholder="${s.token ? 'Leave empty to keep it' : 'Paste the token'}" autocomplete="off" spellcheck="false"></label>
    <p class="small">The token stays in this browser on this device and is sent only to api.github.com.</p>
    <label for="s-repo">Private data repository (owner/name)<input type="text" id="s-repo" placeholder="your-name/shared-intelligence-data" data-draft="s:repo" value="${esc(d('repo', s.repo))}" autocomplete="off" spellcheck="false"></label>
    <label for="s-branch">Branch<input type="text" id="s-branch" data-draft="s:branch" value="${esc(d('branch', s.branch))}" autocomplete="off" spellcheck="false"></label>
    <label for="s-base">Ledger base path<input type="text" id="s-base" data-draft="s:base" value="${esc(d('base', s.base))}" autocomplete="off" spellcheck="false"></label>
    <p class="small">A phone save uploads a drop to the private inbox. The PC files it on its next sync; the screen keeps that difference visible. Never enter a KeePass master password as a GitHub token.</p>
    <label for="s-door">Read from<select id="s-door" data-draft="s:door">${opt('auto', 'Automatic (this PC when available, otherwise GitHub)', d('door', s.door))}${opt('local', 'This PC only', d('door', s.door))}${opt('github', 'GitHub copy only', d('door', s.door))}</select></label>
    <div class="ask-row">${btn('settings-save', 'x', 'Save and connect', { cls: 'primary' })}${s.token ? btn('settings-forget', 'x', 'Forget the token') : ''}</div>`;
}

function settingsHTML() {
  const door = doors.door, local = door === 'local';
  if (!local) S.openDetails.add('gh');
  return `<section class="panel"><h2>Connection</h2>
      <p class="lead"><span class="chip ${S.error ? 'warn' : 'ok'}">${S.error ? 'Problem' : 'Connected'}</span> ${S.error ? esc(S.error.message) : local ? 'This page reads live from the app on this PC. Nothing to set up.' : door === 'github' ? 'This page reads the private GitHub copy, which the PC updates every five minutes.' : 'Not connected yet.'}</p>
      ${det('gh', 'Use away from the PC (GitHub copy)', githubFields(), 'fold')}
    </section>
    <section class="panel"><h2>Your changes</h2>
      ${S.pending.length ? `<p class="lead">Changes made away from the PC are filed by the PC on its next sync, usually within five minutes.</p><ul class="queue">${S.pending.map(p => { const st = pStatus(p); return `<li><span>${esc(p.record.summary)}${p.error ? `<span class="small"> · ${esc(p.error)}</span>` : ''}</span><span class="chip ${st.level === 'bad' ? 'bad' : st.level === 'warn' ? 'warn' : 'wait'}">${esc(st.label)}</span>${p.workConflict?btn('work-review-conflict',p.record.event_id,'Review my change'):''}${btn('discard', p.record.event_id, p.state === 'sent' ? 'Stop tracking' : 'Discard', { cls: 'link' })}</li>`; }).join('')}</ul><div class="ask-row">${btn('retry', 'x', 'Send again now')}</div><p class="small">“Stop tracking” only removes it from this list. A change already on GitHub will still be filed.</p>` : '<p class="lead">Everything you changed is filed.</p>'}
    </section>
    <section class="panel"><h2>Display</h2>
      <label class="check" for="s-samples"><input type="checkbox" id="s-samples" data-a="samples" data-id="x" ${S.samples ? 'checked' : ''}> Show sample records (marked “Sample”)</label>
      ${det('tech', 'Technical details', `<p class="small">Ledger revision ${esc(S.model?.revision || '—')} · ${S.model?.eventCount || 0} records · contract ${esc(S.model?.contract || '—')} · reading through ${esc(door || '—')}${S.model?.skipped.length ? ` · skipped unreadable records: ${esc(S.model.skipped.join(', '))}` : ''}</p>`, 'fold')}
    </section>`;
}

function setupHTML() {
  const local = S.error?.code === 'NO_LOCAL';
  S.openDetails.add('gh');
  return `<section class="panel"><h2>${local ? 'The app on this PC is not answering' : 'Connect to your ledger'}</h2>
    <p class="lead">${esc(S.error?.message || '')}</p>
    ${local ? `<p class="lead">It may still be starting. ${btn('refresh', 'x2', 'Try again', { cls: 'primary' })}</p>` : '<p class="lead">On your PC this page connects by itself. Away from the PC it reads your private GitHub copy, after a one-time connection:</p>' + githubFields()}</section>`;
}

// ---------- render ----------

function captureFocus() {
  const a = document.activeElement;
  if (!a || a === document.body || !a.id) return null;
  return { id: a.id, start: a.selectionStart, end: a.selectionEnd, row: a.closest?.('[data-row]')?.dataset.row };
}
function restoreFocus(f, rowOrder) {
  if (!f) return;
  let el = $(f.id);
  if (!el) {
    if (f.row) { const rows = [...document.querySelectorAll('[data-row] .title')]; el = rows[Math.min(Math.max(rowOrder.indexOf(f.row), 0), rows.length - 1)]; }
    el ||= $('view-title');                   // whatever was focused is gone: go to the page heading, never nowhere
  }
  el.focus({ preventScroll: true });
  if (f.start != null && (el.tagName === 'TEXTAREA' || /^(text|search)$/.test(el.type || ''))) { try { el.setSelectionRange(f.start, f.end); } catch {} }
}

function render() {
  const f = captureFocus();
  const modalFocus = document.activeElement?.closest('.modal') ? f : null;
  const anchor = [...document.querySelectorAll('[data-row]')].find(e => S.expanded.has(e.dataset.row));
  const anchorTop = anchor?.getBoundingClientRect().top, anchorId = anchor?.dataset.row;
  const rowOrder = [...document.querySelectorAll('[data-row]')].map(r => r.dataset.row);
  const sizes = Object.fromEntries([...document.querySelectorAll('textarea[id]')].filter(t => t.style.height).map(t => [t.id, t.style.height]));
  renderHeader(); renderNav();
  $('view-title').textContent = TITLES[S.view];
  document.title = `${TITLES[S.view]} · ${APP_NAME}`;
  document.querySelector('.brand b').textContent = APP_NAME;
  renderMobile();
  const fr = S.info ? fresh() : null, msgs = [];
  if (S.storageError) msgs.push('Device storage could not be updated. New changes will not be sent unless they can first be kept safely. Keep this tab open and free storage or allow site storage.');
  if (S.error && S.base) msgs.push(`Could not refresh: ${S.error.message} Showing the copy saved on this device.`);
  else if (fr?.level === 'bad') msgs.push('This data is more than a day old. The PC has not synced since then.');
  else if (fr?.level === 'warn' && S.info?.syncedAt) msgs.push('This data is more than 2 hours old. The PC may be off or asleep.');
  const banner = $('banner');
  banner.hidden = !msgs.length; banner.textContent = msgs.join(' ');
  banner.className = `banner ${S.error || fr?.level === 'bad' ? 'bad' : 'warn'}`;
  const main = $('main');
  if (!S.model) main.innerHTML = S.loading ? '<div class="empty"><b>Loading…</b></div>' : setupHTML();
  else if (S.view === 'home') main.innerHTML = homeHTML();
  else if (S.view === 'work') main.innerHTML = workHTML();
  else if (S.view === 'reports') main.innerHTML = reportsHTML();
  else if (S.view === 'resources') main.innerHTML = resourcesHTML();
  else if (S.view === 'activity') main.innerHTML = activityHTML();
  else if (S.view === 'board') main.innerHTML = boardHTML();
  else if (S.view === 'agents') main.innerHTML = agentsHTML();
  else if (S.view === 'projects') main.innerHTML = projectsHTML();
  else if (S.view === 'settings') main.innerHTML = settingsHTML();
  else main.innerHTML = listHTML();
  $('new').hidden = !S.model;
  $('new').setAttribute('aria-expanded', String(S.compose));
  for (const [id, h] of Object.entries(sizes)) if ($(id)) $(id).style.height = h;
  restoreFocus(f, rowOrder);
  if (anchorId) { const el = [...document.querySelectorAll('[data-row]')].find(e => e.dataset.row === anchorId); if (el) window.scrollBy(0, el.getBoundingClientRect().top - anchorTop); }
  renderOverlay();
  if (modalFocus) restoreFocus(modalFocus, rowOrder);
}

// ---------- actions ----------

const itemById = id => S.model.items.find(i => i.id === id);
const viewOf = item => L.view(item, S.model, now);
function setView(v, { keep = false, workId = '' } = {}) {
  S.workId=v==='work'?workId:'';
  S.view = v; S.page = 1; S.selected.clear(); S.menu = null; S.mobileItem = null; document.body.classList.remove('item-focus');
  if (!keep) { S.filters = noFilters(); S.filtersOpen = false; }
  try { history.replaceState(null, '', v === 'home' ? location.pathname : '#'+v+(v==='work' && S.workId?'/'+encodeURIComponent(S.workId):'')); } catch {}
  render(); $('view-title').focus({ preventScroll: true }); window.scrollTo({ top: 0 });
}
const parseTags = text => { const seen = new Map(); for (const t of String(text).split(',').map(x => x.trim().slice(0, 80)).filter(Boolean)) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); return [...seen.values()].slice(0, 20); };
const DAY = () => new Date(Date.now() + 864e5).toISOString();

/** One change to one item, with what would undo it. */
function change(action, item) {
  const v = viewOf(item), P = (f, back) => ({ rec: L.records.pref(item, f), undo: () => L.records.pref(item, back) });
  switch (action) {
    case 'read': return { ...P({ read: !v.read }, { read: v.read }), text: v.read ? 'Marked unread' : 'Marked read' };
    case 'pin': return { ...P({ pinned: !v.pinned }, { pinned: v.pinned }), text: v.pinned ? 'Unpinned' : 'Pinned' };
    case 'snooze': return { ...P({ snoozed_until: v.snoozed ? null : DAY() }, { snoozed_until: v.snoozedUntil }), text: v.snoozed ? 'Woken' : 'Snoozed until tomorrow' };
    case 'save': return { rec: L.records.feedFlag(item, item.saved ? 'unsaved' : 'saved'), undo: () => L.records.feedFlag(item, item.saved ? 'saved' : 'unsaved'), text: item.saved ? 'Unsaved' : 'Saved' };
    case 'hide': return { rec: L.records.feedFlag(item, item.hidden ? 'unhidden' : 'hidden'), undo: () => L.records.feedFlag(item, item.hidden ? 'hidden' : 'unhidden'), text: item.hidden ? 'Restored to the Feed' : 'Removed from the Feed' };
  }
}
async function apply(changes, label) {
  if (!changes.length) return toast('Nothing to change.');
  const undo = changes.map(c => c.undo);
  toast(`${label}. Saving…`, undo);
  const r = await send(changes.map(c => c.rec));
  if (!r.ok) return toast(r.message, undo);
  // Keep Undo visible while a slow batch settles.
  toast(r.kept ? `${label}. ${r.message}` : r.queued ? `${label}. Waiting for the PC to file it.` : `${label}.`, undo);
}

async function onAction(a, id, el) {
  const m = S.model;
  if (a.startsWith('menu-')) { S.menu = null; a = a.slice(5); if (a === 'hide' && itemById(id)?.type !== 'story') return; }
  switch (a) {
    case 'view': return setView(id);
    case 'open-work': return setView('work',{workId:id});
    case 'work-new': return startWorkEditor();
    case 'work-edit': return startWorkEditor(m.work.find(w=>w.id===id));
    case 'work-cancel': S.workEditing=null;S.workOriginal=null;S.workPendingId=null;render();return $('view-title').focus();
    case 'work-save': return saveWork();
    case 'work-rebase': {const latest=m.work.find(w=>w.id===S.workOriginal?.id);if(!latest)return toast('The current work is not in this snapshot. Refresh and review it.');S.workOriginal=structuredClone(latest);if(S.workPendingId)S.drafts.set('w:correction',`Reviewed work change ${S.workPendingId} against ${latest.revision}`);render();return toast('Latest work loaded; your edited fields are retained.');}
    case 'work-review-conflict': {const p=S.pending.find(p=>p.record.event_id===id),w=p && m.work.find(w=>w.id===p.record.subject_id);if(!p || !w)return toast('Refresh to load the current work before reviewing this change.');return startWorkEditor(w,p);}
    case 'goto': { const it = itemById(id); if (!it) return; if(it.workId) return setView('work',{workId:it.workId});const v = it.note ? 'notes' : it.type === 'story' ? 'feed' : it.type === 'goal' ? 'goals' : it.type === 'idea' ? 'ideas' : 'messages'; S.expanded.add(id); setView(viewOf(it).needsYou ? 'today' : v); return $(`open-${key(id)}`)?.focus(); }
    case 'open': {const item=itemById(id);return item?.workId?setView('work',{workId:item.workId}):openItem(id);}
    case 'select': el.checked ? S.selected.add(id) : S.selected.delete(id); return render();
    case 'tag': S.filters.tag = id; S.filtersOpen = true; S.page = 1; S.selected.clear(); return render();
    case 'filters': S.filtersOpen = !S.filtersOpen; return render();
    case 'clear-filters': S.filters = { ...noFilters(), sort: S.filters.sort }; S.selected.clear(); return render();
    case 'collapse': S.expanded.clear(); S.mobileItem = null; document.body.classList.remove('item-focus'); return render();
    case 'more': S.page++; return render();
    case 'select-all': { const ids = shownRows().map(r => r.item.id), all = ids.every(x => S.selected.has(x)); ids.forEach(x => (all ? S.selected.delete(x) : S.selected.add(x))); return render(); }
    case 'read': case 'pin': case 'snooze': case 'save': case 'hide': { const c = change(a, itemById(id)); return apply([c], c.text); }
    case 'status': { const it = itemById(id), prev = viewOf(it).status; return apply([{ rec: L.records.pref(it, { status: el.value }), undo: () => L.records.pref(it, { status: prev }) }], `Status: ${L.STATUS[el.value]}`); }
    case 'priority': { const it = itemById(id), prev = viewOf(it).priority; return apply([{ rec: L.records.pref(it, { priority: el.value }), undo: () => L.records.pref(it, { priority: prev }) }], `Priority: ${el.value}`); }
    case 'savetags': {
      if (itemById(id)?.encrypted) return toast('Edit tags inside the encrypted note.');
      const it = itemById(id), v = viewOf(it), k = `tags:${id}`, tags = parseTags(draft(k, v.tags.join(', ')));
      if (tags.join('|') === v.tags.join('|')) { S.drafts.delete(k); return toast('The tags are unchanged.'); }
      const r = await send(L.records.pref(it, { tags }));
      if (r.ok) { S.drafts.delete(k); render(); }
      return toast(said(r, 'Tags saved.', 'Tags saved. Waiting for the PC to file it.'));
    }
    case 'inherit': { const it = itemById(id); if (it.encrypted) return; const r = await send(L.records.pref(it, { tags: null })); if (r.ok) { S.drafts.delete(`tags:${id}`); render(); } return toast(said(r, 'Using the record’s own tags.', 'Queued.')); }
    case 'suggest': { const it = itemById(id); S.drafts.set(`msg:${id}`, `About “${it.title}”: ${it.nextAction}`); render(); return $(`msg-${key(id)}`)?.focus(); }
    case 'ask': {
      const it = itemById(id), body = String(draft(`msg:${id}`)).trim(), to = $(`to-${key(id)}`)?.value || '';
      if (!to) { toast('Choose who to send it to.'); return $(`to-${key(id)}`)?.focus(); }
      if (!body) { toast('Write a message first.'); return $(`msg-${key(id)}`)?.focus(); }
      const r = await send(replyRecords(it, to, body));
      if (r.ok) { S.drafts.set(`msg:${id}`, ''); S.sent.set(id, { to, at: new Date().toISOString(), queued: !!(r.queued || r.kept) }); render(); }
      return toast(said(r, `Sent to ${agentName(to)}.`, `Queued for ${agentName(to)}. The PC files it on its next sync.`));
    }
    case 'agent-action': {
      const split = id.lastIndexOf('|'), it = itemById(id.slice(0, split)), act = it?.actions[Number(id.slice(split + 1))];
      if (!act || it.sensitive) return;
      S.menu = { type: 'reply', id: it.id, to: it.producer, body: act.reply, actionId: act.id || act.label, label: act.label };
      render(); return $('confirm-reply-x')?.focus();
    }
    case 'confirm-reply': {
      const x = S.menu; if (x?.type !== 'reply') return;
      S.menu = null;
      const r = await send(replyRecords(itemById(x.id), x.to, x.body, x.actionId));
      return toast(said(r, 'Reply sent.', 'Reply queued for the PC.'));
    }
    case 'item-menu': S.menu = { type: 'actions', id }; render(); return $('overlay').querySelector('button')?.focus();
    case 'cancel-menu': S.menu = null; return render();
    case 'more-menu': S.menu = { type: 'more' }; render(); return $('overlay').querySelector('button')?.focus();
    case 'close-item': return closeItem();
    case 'done': {
      const it = itemById(id), v = viewOf(it);
      return apply([{ rec: L.records.pref(it, { status: v.status === 'done' ? 'new' : 'done' }), undo: () => L.records.pref(it, { status: v.status }) }], v.status === 'done' ? 'Reopened' : 'Marked done');
    }
    case 'note-layout': S.layout = S.layout === 'gallery' ? 'grouped' : 'gallery'; store.set('si.notesLayout', S.layout); return render();
    case 'note-edit-encrypted': S.secretDrafts.add('new'); S.drafts.set('edit:new:protection','encrypted'); S.editing = 'new'; render(); return $('n-title')?.focus();
    case 'note-edit': if (itemById(id)?.encrypted) S.secretDrafts.add(id); if (itemById(id)?.encrypted && itemById(id).locked) { S.unlock = id; render(); return $('unlock-passphrase')?.focus(); } S.editing = id; render(); return $('n-title')?.focus();
    case 'note-unlock': S.unlock = id; render(); return $('unlock-passphrase')?.focus();
    case 'note-unlock-cancel': S.unlock = null; return render();
    case 'notes-lock': return lockNotes();
    case 'note-unlock-confirm': {
      const it=itemById(id), epoch=S.cryptoEpoch, passphrase=$('unlock-passphrase')?.value || '';
      if ($('unlock-passphrase')) $('unlock-passphrase').value='';
      try { const content=await decryptNote(it.encrypted,passphrase,it.pid); if (epoch !== S.cryptoEpoch || S.unlock !== id) return; S.decrypted.set(it.id,content); S.unlock=null; touchUnlock(); rebuild(); render(); toast('Unlocked in this tab.'); }
      catch { toast('Could not unlock this note. Check the passphrase; damaged notes cannot be opened.'); }
      return;
    }
    case 'note-cancel': return cancelNoteEditor();
    case 'note-save': return saveNote();
    case 'note-check': {
      const split = id.lastIndexOf('|'), it = itemById(id.slice(0, split));
      if (it.queued) return toast('Wait for this note to finish saving.');
      if (it.encrypted) { S.editing = it.id; render(); return toast('Edit the checklist and save it encrypted.'); }
      const rec = L.records.note({ title: it.title, body: L.toggleCheck(it.body, Number(id.slice(split + 1))), prev: it });
      S.expanded.delete(it.id); S.expanded.add(rec.event_id);
      if (S.mobileItem === it.id) S.mobileItem = rec.event_id;
      const r = await send(rec);
      return toast(said(r, 'Checklist saved.', 'Checklist change queued.'));
    }
    case 'bulk': {
      if (id === 'clear') { S.selected.clear(); render(); return $('view-title').focus(); }
      const items = [...S.selected].map(itemById).filter(Boolean), cs = [];
      for (const it of items) {
        const v = viewOf(it), story = it.type === 'story';
        const want = { read: !v.read && 'read', unread: v.read && 'read', pin: !v.pinned && 'pin', unpin: v.pinned && 'pin', snooze: !v.snoozed && 'snooze', wake: v.snoozed && 'snooze',
          save: story && !it.saved && 'save', unsave: story && it.saved && 'save', hide: story && !it.hidden && 'hide', restore: story && it.hidden && 'hide' }[id];
        if (want) cs.push(change(want, it));
        if (id === 'done' && v.status !== 'done') { const prev = v.status; cs.push({ rec: L.records.pref(it, { status: 'done' }), undo: () => L.records.pref(it, { status: prev }) }); }
      }
      S.selected.clear();
      await apply(cs, `Changed ${cs.length} of ${items.length} selected`);
      return $('view-title').focus();
    }
    case 'undo': { const u = S.undo; if (!u) return; S.undo = null; $('toast').hidden = true; const r = await send(u.map(fn => fn())); return toast(said(r, 'Undone.', 'Undo queued.')); }
    case 'new': if(['work','reports'].includes(S.view))return startWorkEditor();if (S.view === 'notes') { S.editing = 'new'; render(); return $('n-title')?.focus(); } S.compose = !S.compose; if (!isList(S.view) && S.view !== 'home') setView('home'); render(); return S.compose ? $('c-title')?.focus() : $('new').focus();
    case 'compose-close': S.compose = false; render(); return $('new').focus();
    case 'compose-send': {
      const type = draft('c:type', 'message'), title = String(draft('c:title')).trim(), body = String(draft('c:body')).trim(), to = $('c-to')?.value || '';
      if (type === 'message' && !to) { toast('Choose who to send it to.'); return $('c-to')?.focus(); }
      if (!title && !(type === 'message' && body)) { toast(type === 'message' ? 'Write a message first.' : 'Give it a title first.'); return $('c-title')?.focus(); }
      const rec = type === 'message' ? L.records.message({ to, body: body || title, threadTitle: title || body.slice(0, 60) }) : type === 'idea' ? L.records.idea({ title, summary: body }) : L.records.note({ title, body });
      const r = await send(rec);
      if (!r.ok) return toast(r.message);                       // the form stays open with everything typed
      for (const k of ['c:title', 'c:body']) S.drafts.delete(k);
      S.compose = false;
      const where = type === 'message' ? 'messages' : type === 'idea' ? 'ideas' : 'notes';
      setView(where);
      return toast(said(r, type === 'message' ? `Sent to ${agentName(to)}. It is in Messages.` : `Added to ${TITLES[where]}.`, `Queued. It shows in ${TITLES[where]} as “Waiting for PC” until the PC files it.`));
    }
    case 'refresh': return reload();
    case 'queue': return setView('settings');
    case 'samples': S.samples = el.checked; store.set('si.samples', S.samples); return render();
    case 'settings-save': {
      const patch = { door: draft('s:door', doors.settings.door), repo: String(draft('s:repo', doors.settings.repo)).trim(), branch: String(draft('s:branch', doors.settings.branch)).trim(), base: String(draft('s:base', doors.settings.base)).trim() };
      const tok = String(draft('s:token', '')).trim(); if (tok) patch.token = tok;
      if (S.pending.length && ['repo','branch','base'].some(k => patch[k] !== doors.settings[k])) return toast('File or discard pending changes before switching data repositories. Token updates are allowed.');
      doors.saveSettings(patch); S.loadGeneration++; lockNotes({ renderNow: false }); for (const p of S.pending) delete p.code; for (const k of ['s:door', 's:repo', 's:branch', 's:base', 's:token']) S.drafts.delete(k);
      S.stopWatch?.(); S.stopWatch = null; S.base = null; store.del('si.cache');
      await reload(); return toast(S.error ? S.error.message : 'Connected.');
    }
    case 'settings-forget': store.del('si.cache'); doors.saveSettings({ token: '' }); S.loadGeneration++; S.loading=false; lockNotes({ renderNow: false }); S.stopWatch?.(); S.stopWatch=null; S.base=null; S.model=null; S.info=null; S.error={code:'NEED_TOKEN',message:'Reconnect a token to read your private mirror.'}; render(); return toast('Token and saved data copy removed from this device.');
    case 'retry': await retryUnsent(true); await reload({ quiet: true }); return toast('Tried again.');
    case 'discard': S.pending = S.pending.filter(p => p.record.event_id !== id); savePending(); rebuild(); return render();
  }
}

document.addEventListener('click', e => {
  if (Date.now() < suppressRowClickUntil && e.target.closest('[data-row]')) { e.preventDefault(); return; }
  const el = e.target.closest('[data-a]');
  if (!el || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;      // selects and checkboxes act on change
  onAction(el.dataset.a, el.dataset.id, el).catch(e => toast(`Could not complete the action: ${e.message}`));
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.a) return onAction(el.dataset.a, el.dataset.id, el);
  if (el.dataset.filter && el.type !== 'search') { S.filters[el.dataset.filter] = el.type === 'checkbox' ? el.checked : el.value; S.page = 1; S.selected.clear(); return render(); }
  if (el.dataset.draft && el.tagName === 'SELECT') { S.drafts.set(el.dataset.draft, el.value); if (el.dataset.draft.endsWith(':protection') && el.value === 'encrypted') S.secretDrafts.add(S.editing); if (el.dataset.rerender) render(); }
});
let searchTimer;
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.draft && el.tagName !== 'SELECT') S.drafts.set(el.dataset.draft, el.value);
  if (el.dataset.filter === 'q') { S.filters.q = el.value; S.page = 1; S.selected.clear(); clearTimeout(searchTimer); searchTimer = setTimeout(render, 120); }
});
document.addEventListener('toggle', e => { const d = e.target; if (d.dataset?.d) (d.open ? S.openDetails.add(d.dataset.d) : S.openDetails.delete(d.dataset.d)); }, true);
document.addEventListener('keydown', e => {
  if (!$('overlay').hidden) {
    if (e.key === 'Escape') { S.workEditing=null;S.workOriginal=null;S.workPendingId=null;cancelNoteEditor({ renderNow: false }); S.menu = null; S.unlock = null; render(); $('new')?.focus(); return; }
    if (e.key === 'Tab') {
      const els = [...$('overlay').querySelectorAll('button,input,select,textarea,a')].filter(x => !x.disabled), first=els[0], last=els.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === 'Escape' && typing) return e.target.blur();
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const rows = [...document.querySelectorAll('[data-row] .title')], i = rows.indexOf(document.activeElement);
  if (e.key === '/' && $('q')) { e.preventDefault(); $('q').focus(); }
  else if (e.key === 'j' && rows.length) rows[Math.min(rows.length - 1, i + 1)].focus();
  else if (e.key === 'k' && rows.length) rows[Math.max(0, i - 1)].focus();
});
window.addEventListener('hashchange', () => { const h=location.hash.slice(1),v=h.split('/')[0];let workId='';try{if(v==='work' && h.includes('/'))workId=decodeURIComponent(h.slice(5));}catch{}if(TITLES[v] && (v!==S.view || workId!==S.workId))setView(v,{workId}); });
window.addEventListener('online', () => reload({ quiet: true }));
document.addEventListener('visibilitychange', () => { if (document.hidden && (S.decrypted.size || S.unlock || hasEncryptedDrafts() || S.editing && itemById(S.editing)?.encrypted)) lockNotes(); if (!document.hidden && doors.door !== 'local') reload({ quiet: true }); });

// The clock: refresh the "x min ago" text every minute; redraw only when a snooze ran out.
const snoozedNow = () => (S.model ? S.model.items.filter(i => L.view(i, S.model, now).snoozed).map(i => i.id).join('|') : '');
let snoozedIds = '', lastPoll = Date.now();
setInterval(() => {
  now = Date.now();
  renderHeader();
  const cur = snoozedNow();
  if (cur !== snoozedIds) { snoozedIds = cur; render(); }
  if (doors.door !== 'local' && !document.hidden && now - lastPoll > 5 * 60000) { lastPoll = now; reload({ quiet: true }); }
}, 60000);

const h = location.hash.slice(1);
if (TITLES[h.split('/')[0]]) {S.view=h.split('/')[0];try{if(S.view==='work' && h.includes('/'))S.workId=decodeURIComponent(h.slice(5));}catch{}}
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
reload().then(() => { snoozedIds = snoozedNow(); });
