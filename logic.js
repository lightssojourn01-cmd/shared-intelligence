// Pure logic for the dashboard: no DOM, no network. Everything here is unit-tested (test/logic.test.mjs).
import { validateEnvelope } from './crypto.js';

export const STATUS = { new: 'New', needs_input: 'Needs my input', in_progress: 'In progress', done: 'Done' };
export const CLAIM = { fact: 'Reported by source', pending_verification: 'Needs verification', inference: 'Inference', source_failure: 'Source check failed' };
export const OWNER = 'owner-ui';
const OWNER_IDS = new Set(['owner', 'owner-ui', 'lee', 'user', 'human', 'me']);
export const isOwner = id => OWNER_IDS.has(String(id || '').toLowerCase());
const isSampleAgent = id => /-sample$/.test(String(id || '')) || id === 'bootstrap' || id === 'fixture';
export const realAgents = model => model.agents.filter(a => !isOwner(a.id) && !isSampleAgent(a.id));
const list = v => (Array.isArray(v) ? v : []);
/** A time as a number, so records stamped with different time-zone offsets still order correctly. */
export const ts = t => { const n = Date.parse(t); return isNaN(n) ? 0 : n; };
const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
/** Every item carries the same fields, whatever kind of record it came from. */
const fill = it => {
  it.title = str(it.title); it.body = str(it.body); it.actions ||= []; it.pid ||= it.id; it.note = !!it.note; it.color ||= '';
  if (it.encrypted) { it.note = true; it.locked = true; it.title = 'Locked note'; it.body = ''; it.baseTags = []; it.color = ''; it.origin = ''; it.actions = []; it.refs = []; it.evidence = []; it.nextAction = ''; it.whyShown = ''; it.stats = []; }
  it.t = ts(it.note ? it.sourceUpdatedAt || it.at : it.at); return it;
};

const arr = o => (Array.isArray(o) ? o : Object.values(o || {}));
export const WORK_STATUS = { queued: 'Queued', running: 'In progress', waiting: 'Waiting', blocked: 'Blocked', paused: 'Paused', completed: 'Completed as reported', cancelled: 'Cancelled' };
export const WORK_VERIFICATION = { unverified: 'Not verified', reported: 'Verification reported', verified: 'Verification recorded' };
const terminalWork = w => ['completed', 'cancelled'].includes(w.status);
const workText = v => typeof v==='string'?v:'';
/** Work snapshots retain their native revision and evidence rather than inferring progress from activity. */
export function normalizeWork(raw) {
  return arr(raw).filter(w => w && typeof w === 'object' && typeof w.id === 'string' && w.id.startsWith('work:')).map(w => ({
    id:w.id, revision:workText(w.revision), title:workText(w.title) || w.id, request:workText(w.request), project:workText(w.project),
    status:typeof w.status==='string' && Object.hasOwn(WORK_STATUS,w.status)?w.status:'queued', stage:workText(w.stage), responsible:workText(w.responsible),
    next_action:workText(w.next_action), waiting:workText(w.waiting), waiting_on:['owner','external','agent'].includes(w.waiting_on)?w.waiting_on:'',
    dependencies:list(w.dependencies).filter(d=>d && typeof d==='object').map(d=>({...d,id:workText(d.id),title:workText(d.title) || workText(d.id),state:d.state==='resolved'?'resolved':'open',owner:workText(d.owner)})),
    evidence:list(w.evidence).filter(e=>e && typeof e.uri==='string'),
    sessions:list(w.sessions).filter(s=>s && typeof s.vendor==='string' && typeof s.session_id==='string'),
    verification:{state:['unverified','reported','verified'].includes(w.verification?.state)?w.verification.state:'unverified',detail:workText(w.verification?.detail),by:workText(w.verification?.by)},
    acceptance:{state:['unreviewed','partial','accepted','not_accepted'].includes(w.acceptance?.state)?w.acceptance.state:'unreviewed',scope:workText(w.acceptance?.scope),detail:workText(w.acceptance?.detail),by:workText(w.acceptance?.by),reviewed_revision:workText(w.acceptance?.reviewed_revision),evidence:list(w.acceptance?.evidence).filter(e=>e&&typeof e.uri==='string')},
    updated_at:workText(w.updated_at),producer:workText(w.producer),visibility:workText(w.visibility),synthetic:!!w.synthetic,
    history:list(w.history).filter(h=>h && typeof h==='object').map(h=>({...h,event_id:workText(h.event_id),summary:workText(h.summary),correction:workText(h.correction),kind:workText(h.kind),at:workText(h.at),occurred_at:workText(h.occurred_at),producer:workText(h.producer)})),
    conflicts:list(w.conflicts).filter(c=>c && typeof c==='object').map(c=>({...c,event_id:workText(c.event_id),resolved_by:workText(c.resolved_by)})),resolved_conflicts:list(w.resolved_conflicts).filter(v=>typeof v==='string'),
  }));
}
export const workConflict = (p, model) => {
  if(p.record.kind!=='work.upserted')return false;
  const current=model.work?.find(w=>w.id===p.record.subject_id);if(!current)return false;
  if(current.revision===p.record.event_id || current.history.some(h=>h.event_id===p.record.event_id) || current.resolved_conflicts.includes(p.record.event_id))return false;
  return current.conflicts.find(c=>c.event_id===p.record.event_id && !c.resolved_by) ||
    (['sent','unsent','refused','conflict'].includes(p.state) && p.record.payload.base_revision!==current.revision ? {event_id:p.record.event_id,reason:'stale_revision'} : false);
};
export function workRows(model, opts={}) {
  return (model.work || []).filter(w=>opts.samples || !w.synthetic).sort((a,b)=>ts(b.updated_at)-ts(a.updated_at)||a.id.localeCompare(b.id));
}
export function workReview(model, opts={}) {
  const all=workRows(model,opts), active=all.filter(w=>!terminalWork(w));
  const unresolved=w=>w.dependencies.filter(d=>d.state!=='resolved');
  const verified=w=>w.verification.state==='verified' && !!w.verification.detail && !!w.verification.by && w.evidence.length>0;
  const ownerAttention=active.filter(w=>w.waiting_on==='owner' || unresolved(w).some(d=>isOwner(d.owner)));
  return {all,active,ownerAttention,uncertainActions:all.filter(w=>(model.workActions||[]).some(a=>a.work_id===w.id&&a.state==='uncertain')),waiting:active.filter(w=>['waiting','blocked','paused'].includes(w.status)||unresolved(w).length),
    unassigned:active.filter(w=>!w.responsible),needsVerification:all.filter(w=>w.status==='completed' && !verified(w)),
    needsAcceptance:all.filter(w=>w.status==='completed'&&w.acceptance.state!=='accepted'),
    accepted:all.filter(w=>w.acceptance.state==='accepted'),
    verified:all.filter(verified),completed:all.filter(w=>w.status==='completed'),completionDependencies:all.filter(w=>w.status==='completed' && unresolved(w).length),
    conflicts:all.filter(w=>w.conflicts.some(c=>!c.resolved_by)),recent:all.slice(0,6)};
}
/** A session may have moved on to another job; retain the checkpoints for this work. */
export function workSessions(work, sessions=[]) {
  const refs=new Map(work.sessions.map(s=>[s.vendor+':'+s.session_id,{...s,id:s.vendor+':'+s.session_id,checkpoints:[]}]));
  for(const s of sessions) {
    const checkpoints=list(s.checkpoints).filter(c=>c.work_id===work.id);
    if(s.work_id===work.id || checkpoints.length || refs.has(s.id)) refs.set(s.id,{...s,checkpoints});
  }
  return [...refs.values()].sort((a,b)=>ts(b.updated_at)-ts(a.updated_at));
}
export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'x';
// "docs" → "Docs", "ui" → "UI"; anything the writer capitalised is kept as written
const cap = s => (!s || s !== s.toLowerCase() ? s : s.length <= 3 ? s.toUpperCase() : s[0].toUpperCase() + s.slice(1));

/** Leading [Bracket] prefixes become tags: "[Finance][Insurance] Review renewal" → title + 2 tags. */
export function parseTitle(title) {
  const t = String(title || '');
  const m = /^((?:\s*\[[^\][]{1,80}\])+)\s*(.*)$/.exec(t);
  if (!m || !m[2].trim()) return { title: t, tags: [] };
  const tags = [...m[1].matchAll(/\[([^\]]+)\]/g)].flatMap(x => x[1].split(',')).map(x => x.trim()).filter(Boolean);
  return { title: m[2].trim(), tags };
}

function dedupe(list, keepCase = false) {
  const seen = new Map();
  for (const t of list) { if (typeof t !== 'string' && typeof t !== 'number') continue; const k = String(t).trim().toLowerCase(); if (k && !seen.has(k)) seen.set(k, keepCase ? String(t).trim() : cap(String(t).trim())); }
  return [...seen.values()];
}

/**
 * Turn the contract's state (exports/state.json or the local /api/state) into one flat list of
 * items the UI can show, plus lookup tables. Does not apply the owner's preferences yet.
 */
export function normalize(raw) {
  const receipts = raw.receipts || {};
  const agents = arr(raw.agents).filter(a => a && a.id).map(a => ({ ...a, id: str(a.id), label: typeof a.label === 'string' && a.label.trim() ? a.label : str(a.id) }));
  const items = [];
  // Agents write these records, so every field is treated as possibly missing or the wrong shape,
  // and one bad record is skipped rather than stopping the page.
  const skipped = [];
  const each = (src, fn) => { for (const x of src) { try { if (x && typeof x === 'object') fn(x); } catch (e) { skipped.push(String(x?.id || x?.event_id || '?')); } } };
  each(list(raw.feed), f => {
    const x = (f.extra && typeof f.extra === 'object') ? f.extra : {}, rf = (x.report_fields && typeof x.report_fields === 'object') ? x.report_fields : {};
    const pt = parseTitle(f.title || f.summary);
    const note = str(f.category).toLowerCase() === 'note';
    const encrypted = note && Object.hasOwn(x, 'encrypted') ? (x.encrypted && typeof x.encrypted === 'object' && !Array.isArray(x.encrypted) ? x.encrypted : { v: 0 }) : null;
    items.push({
      note, encrypted, locked: !!encrypted, sourceUpdatedAt: typeof x.source_updated_at === 'string' ? x.source_updated_at : null, color: typeof x.color === 'string' ? x.color : '', origin: typeof x.source === 'string' ? x.source : '',
      // a note keeps one identity through its edits, so its pin and tags follow it
      pid: note && /^note:/.test(str(f.subject_id)) ? f.subject_id : f.id,
      id: f.id, type: 'story', kind: f.kind, title: pt.title, body: f.body_md || '', kicker: f.kicker || '', producer: f.producer,
      at: f.occurred_at, topic: f.category ? cap(String(f.category)) : '', claim: f.claim || 'fact',
      baseTags: dedupe([...pt.tags, ...list(x.tags), ...(typeof x.project === 'string' ? [x.project] : [])]),
      nextAction: rf.nextAction || '', dueAt: rf.dueAt || null, sourceReadAt: x.source_observed_at || null,
      whyShown: typeof x.why_shown === 'string' ? x.why_shown : '', stats: list(f.stats).filter(s => s && typeof s === 'object'), refs: list(f.source_refs).filter(r => r && typeof r === 'object'),
      evidence: list(x.evidence).filter(e => e && typeof e === 'object'),
      actions: list(x.actions).filter(a => a && typeof a.label === 'string' && a.label.trim()).slice(0, 4).map(a => ({ label: String(a.label).slice(0, 40), reply: typeof a.reply === 'string' && a.reply.trim() ? a.reply.slice(0, 500) : String(a.label), id: typeof a.id === 'string' ? a.id.slice(0, 60) : '' })),
      brief: String(f.category || '').toLowerCase() === 'brief',
      subject: f.subject_id || '', session: typeof x.session === 'string' ? x.session : '', sessionId: typeof x.session_id === 'string' ? x.session_id : '',
      superseded: !!f.superseded, synthetic: !!f.synthetic, sensitive: f.visibility === 'sensitive',
      saved: !!f.saved, hidden: !!f.hidden,
    });
  });
  each(arr(raw.goals), g => {
    if (!g.title || g.title === g.id) return;         // a bare subject that only collected progress is not a goal
    const rf = g.report_fields || {};
    items.push({
      id: g.id, type: 'goal', kind: 'goal', title: parseTitle(g.title).title, body: g.description || g.body_md || '', kicker: 'Goal',
      producer: g.updated_by || '', at: g.updated_at || '', topic: g.category ? cap(String(g.category)) : '', claim: 'fact',
      baseTags: dedupe(parseTitle(g.title).tags), nextAction: rf.nextAction || '', dueAt: rf.dueAt || null,
      currentState: g.current_state || '', desiredOutcome: rf.desiredOutcome || '', lifecycle: g.lifecycle || 'active',
      progress: list(g.progress).map(p => ({ title: p.title, at: p.effective_at, by: p.producer })),
      nativeSync: g.native_sync || {}, stats: [], refs: [], evidence: [], subject: g.id,
      superseded: !!g.reclassified_as, synthetic: !!g.synthetic, sensitive: g.visibility === 'sensitive', saved: false, hidden: false,
    });
  });
  each(arr(raw.ideas), i => {
    items.push({
      id: i.id, type: 'idea', kind: 'idea', title: parseTitle(i.title || i.id).title, body: i.summary || '', kicker: 'Idea',
      producer: i.updated_by || '', at: i.updated_at || '', topic: i.domain ? cap(String(i.domain).replace(/_/g, ' ')) : '', claim: 'fact',
      baseTags: dedupe(parseTitle(i.title || '').tags), nextAction: '', dueAt: null, stage: i.stage || '', whyShown: i.why_it_fits || '',
      stats: [], refs: [], evidence: [], subject: i.id,
      superseded: false, synthetic: !!i.synthetic, sensitive: i.visibility === 'sensitive', saved: false, hidden: false,
    });
  });
  const threads = [];
  each(arr(raw.threads).filter(t => t && t.id), t0 => {
    const t = { id: str(t0.id), title: str(t0.title || t0.id), messages: list(t0.messages).filter(m => m && m.event_id).map(m => ({ ...m, from: str(m.from), to: str(m.to), body: str(m.body) })).sort((a, b) => ts(a.at) - ts(b.at)) };
    threads.push(t);
    t.messages.forEach((m, k) => {
      const later = t.messages.slice(k + 1);
      items.push({
        id: m.event_id, type: 'message', kind: 'message', title: t.title, body: m.body || '', kicker: `${m.from} → ${m.to}`,
        producer: m.from, to: m.to, at: m.at, topic: 'Messages', claim: 'fact', baseTags: [], nextAction: '', dueAt: null,
        threadId: t.id, messageState: m.state || 'new', queued: !!m.queued,
        // answered = the person it was addressed to wrote in the thread afterwards (anyone, for a message to all)
        answered: later.some(x => x.from !== m.from && (String(m.to).toLowerCase() === 'all' || x.from === m.to || (isOwner(m.to) && isOwner(x.from)))),
        stats: [], refs: m.source_refs || [], evidence: [], subject: `thread:${t.id}`,
        superseded: false, synthetic: !!m.synthetic, sensitive: m.visibility === 'sensitive', saved: false, hidden: false,
      });
    });
  });
  const projects = arr(raw.projects).filter(p => p && p.id).map(p => ({ id: str(p.id), name: str(p.name || p.id), status: str(p.status), description: str(p.description), activity: list(p.activity) }));
  const work=normalizeWork(raw.work);
  for(const w of workReview({work}).ownerAttention) items.push({
    id:w.id,pid:w.id,type:'story',kind:'work.upserted',attentionOnly:true,workId:w.id,
    title:w.title,body:w.request,nextAction:w.waiting || w.dependencies.filter(d=>d.state!=='resolved' && isOwner(d.owner)).map(d=>d.title).join('; ') || 'Owner input requested; detail not recorded.',
    producer:w.producer,at:w.updated_at,topic:'Work needs you',claim:'fact',kicker:w.project || 'Work',subject:w.id,
    refs:w.evidence,evidence:w.evidence,stats:[],baseTags:[],actions:[],saved:false,hidden:false,superseded:false,synthetic:w.synthetic,sensitive:w.visibility==='sensitive',
  });
  // A current checkpoint's owner-input request belongs in Needs you even when
  // the checkpoint was not selected as a Feed story. Resolved requests vanish.
  for (const s of arr(raw.sessions)) {
    if (!s || typeof s.waiting !== 'string' || !s.waiting.trim() || !s.event_id || items.some(i=>i.id===s.event_id) || work.some(w=>w.id===s.work_id)) continue;
    items.push({id:s.event_id,pid:s.event_id,type:'story',kind:'activity.checkpoint',attentionOnly:true,
      title:str(s.goal?.title || 'Session needs input'),body:str(s.did),nextAction:s.waiting,
      producer:str(s.producer),at:str(s.updated_at),topic:'Owner input',claim:'fact',kicker:str(s.title),
      subject:str(s.work_id),session:str(s.title),sessionId:str(s.session_id),
      refs:list(s.evidence),evidence:list(s.evidence),stats:[],baseTags:[],actions:[],
      saved:false,hidden:false,superseded:false,synthetic:false,sensitive:s.visibility==='sensitive'});
  }
  for (const it of items) { fill(it); if (isSampleAgent(it.producer)) it.synthetic = true; }
  return {
    contract: raw.contract || '', revision: raw.revision || '', eventCount: raw.event_count || 0,
    newestRecordAt: raw.newest_record_at || (raw.activity && raw.activity[0] && raw.activity[0].occurred_at) || null,
    work, workActions:arr(raw.work_actions), resources: arr(raw.resources), preferences: arr(raw.preferences),
    sessions: arr(raw.sessions).filter(s => s && s.id && s.goal && s.mission),
    items, threads, projects, agents, receipts, prefs: { ...(raw.prefs || {}) }, skipped,
    sources: arr(raw.sources), activityIds: new Set((raw.activity || []).map(a => a.event_id)),
  };
}

// ---------- the owner's writes ----------

const prefWords = f => {
  const out = [];
  if ('pinned' in f) out.push(f.pinned ? 'Pinned' : 'Unpinned');
  if ('read' in f) out.push(f.read ? 'Marked read' : 'Marked unread');
  if ('snoozed_until' in f) out.push(f.snoozed_until ? 'Snoozed' : 'Woke');
  if ('status' in f) out.push(`Set status to ${STATUS[f.status] || f.status} on`);
  if ('priority' in f) out.push(`Set priority to ${f.priority} on`);
  if ('tags' in f) out.push(f.tags ? 'Changed tags on' : 'Reset tags on');
  return out.join(', ') || 'Changed';
};

/** Lines like "- [ ] milk" in a note are a checklist. → [{ line, text, done }] */
export const checklist = body => String(body || '').split('\n').map((l, line) => { const m = /^\s*[-*]\s*\[( |x|X)\]\s?(.*)$/.exec(l); return m ? { line, text: m[2], done: m[1] !== ' ' } : null; }).filter(Boolean);
/** Tick or untick one checklist line. */
export function toggleCheck(body, line) {
  const lines = String(body || '').split('\n');
  const m = /^(\s*[-*]\s*\[)( |x|X)(\].*)$/.exec(lines[line] || '');
  if (!m) return String(body || '');
  lines[line] = m[1] + (m[2] === ' ' ? 'x' : ' ') + m[3];
  return lines.join('\n');
}

let seq = 0;
export function newId(now = Date.now()) {
  seq = (seq + 1) % 1296;
  return `own-${now.toString(36)}-${seq.toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 6)}`;
}
const iso = now => new Date(now).toISOString();
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…'; };

export const records = {
  work({prev,changes}, now=Date.now()) {
    const id=newId(now), subject=prev?.id || 'work:'+id;
    const payload={base_revision:prev?.revision || null,title:prev?.title || '',request:prev?.request || '',project:prev?.project || '',
      status:prev?.status || 'queued',stage:prev?.stage || '',responsible:prev?.responsible || '',next_action:prev?.next_action || '',waiting:prev?.waiting || '',waiting_on:prev?.waiting_on || '',
      dependencies:prev?.dependencies || [],evidence:prev?.evidence || [],sessions:prev?.sessions || [],verification:prev?.verification || {state:'unverified',detail:'',by:''},acceptance:prev?.acceptance?.state==='accepted'?{state:'unreviewed',detail:'Work edited after consumer acceptance; review the current revision.'}:(prev?.acceptance || {state:'unreviewed'}),resolved_conflicts:prev?.resolved_conflicts || [],correction:'',...changes};
    return {event_id:id,kind:'work.upserted',subject_id:subject,occurred_at:iso(now),summary:clip(payload.title,480),...(prev?.visibility==='sensitive'?{visibility:'sensitive'}:{}),payload};
  },
  pref(item, fields, now = Date.now()) {
    if (item.encrypted && Object.hasOwn(fields, 'tags')) throw Object.assign(new Error('Encrypted-note tags must be changed inside the encrypted editor.'), { code: 'ENCRYPTED_METADATA' });
    const id = item.pid || item.id;
    return { event_id: newId(now), kind: 'owner.pref', subject_id: clip(`pref:${id}`, 200), occurred_at: iso(now),
      summary: clip(`${prefWords(fields)} “${item.encrypted ? 'Locked note' : item.title}”`, 480), ...(item.sensitive ? { visibility: 'sensitive' } : {}), payload: { target_id: id, ...fields } };
  },
  feedFlag(item, verb, now = Date.now()) {       // verb: saved | unsaved | hidden | unhidden
    return { event_id: newId(now), kind: `feed.${verb}`, subject_id: 'feed', occurred_at: iso(now),
      summary: clip(`${{ saved: 'Saved', unsaved: 'Unsaved', hidden: 'Removed', unhidden: 'Restored' }[verb]} “${item.encrypted ? 'Locked note' : item.title}”`, 480), ...(item.sensitive ? { visibility: 'sensitive' } : {}), payload: { target_event_id: item.id } };
  },
  message({ to, body, threadId, threadTitle, about, actionId }, now = Date.now()) {
    const id = newId(now), tid = threadId || `thread-${id}`;
    return { event_id: id, kind: 'message.posted', subject_id: `thread:${tid}`, occurred_at: iso(now), correlation_id: tid,
      summary: clip(body, 200), payload: { thread_id: tid, to, body, ...(threadTitle ? { thread_title: clip(threadTitle, 140) } : {}), ...(about ? { about } : {}), ...(actionId ? { action_id: actionId } : {}) } };
  },
  idea({ title, summary }, now = Date.now()) {
    const id = newId(now);      // a new idea gets its own subject, so two ideas never overwrite each other
    return { event_id: id, kind: 'idea.upserted', subject_id: `idea:${slug(title).slice(0, 40)}-${id.slice(4)}`, occurred_at: iso(now),
      summary: clip(`Idea: ${title}`, 480), payload: { title: clip(title, 140), ...(summary ? { summary } : {}), origin: 'local', stage: 'spark' } };
  },
  /**
   * A note, or a new version of one. Pass `prev` (the note item being edited) to replace it: the new
   * record keeps the note's identity and supersedes the old version, which stays in History.
   */
  note({ title, body, color, source, sensitive, prev }, now = Date.now()) {
    if (prev?.encrypted) throw Object.assign(new Error('Use the encrypted editor to save this note.'), { code: 'ENCRYPTION_REQUIRED' });
    const id = newId(now), text = String(body || ''), name = String(title || '').trim() || clip(text.split('\n').find(l => l.trim()) || 'Note', 80);
    const subject = prev && /^note:/.test(prev.pid || '') ? prev.pid : `note:${id}`;
    const keepPrivate = sensitive ?? (prev ? prev.sensitive : false);
    return { event_id: id, kind: 'feed.item', subject_id: subject, occurred_at: iso(now), ...(prev ? { supersedes: [prev.id] } : {}), ...(keepPrivate ? { visibility: 'sensitive' } : {}),
      summary: clip(name, 480), payload: { kicker: 'Note', title: clip(name, 140), ...(text ? { body_md: text.slice(0, 19000) } : {}), category: 'Note',
        ...((color ?? prev?.color) ? { color: color ?? prev.color } : {}), ...(prev?.baseTags?.length ? { tags: prev.baseTags } : {}), ...((source ?? prev?.origin) ? { source: source ?? prev.origin } : {}) } };
  },
  encryptedNote({ envelope, subjectId, prev }, now = Date.now()) {
    if (validateEnvelope(envelope).length) throw Object.assign(new Error('The encrypted note format is invalid.'), { code: 'INVALID_ENVELOPE' });
    const subject = prev && /^note:/.test(prev.pid || '') ? prev.pid : subjectId;
    if (subjectId && subjectId !== subject) throw Object.assign(new Error('Encrypt the note using its existing identity.'), { code: 'INVALID_SUBJECT' });
    if (typeof subject !== 'string' || !/^note:[A-Za-z0-9][A-Za-z0-9._:-]{0,194}$/.test(subject))
      throw Object.assign(new Error('The encrypted note identity is invalid.'), { code: 'INVALID_SUBJECT' });
    return { event_id: newId(now), kind: 'feed.item', subject_id: subject, occurred_at: iso(now), visibility: 'private',
      ...(prev ? { supersedes: [prev.id] } : {}), summary: 'Locked note',
      payload: { kicker: 'Encrypted note', title: 'Locked note', category: 'Note', encrypted: structuredClone(envelope) } };
  },
};

/**
 * Show queued writes at once. `pending` = [{record, state}] not yet seen in the ledger.
 * Returns a new model; items touched by a queued write get `queued: true`.
 */
export function applyPending(model, pending) {
  if (!pending.length) return model;
  const items = model.items.map(i => ({ ...i })), byId = new Map(items.map(i => [i.id, i])), byPid = new Map(items.filter(i => !i.superseded).map(i => [i.pid, i]));
  const prefs = { ...model.prefs };
  const threads = model.threads.map(t => ({ ...t, messages: [...t.messages] }));
  for (const p of [...pending].sort((a, b) => ts(a.record.occurred_at) - ts(b.record.occurred_at))) {
    const r = p.record, pl = r.payload || {};
    if (isFiled(p, model)) continue;
    if (r.kind === 'owner.pref') {
      const { target_id, ...fields } = pl;
      // a newer choice already in the ledger (made on another device) wins over an older queued one
      if (prefs[target_id]?.updated_at && ts(prefs[target_id].updated_at) > ts(r.occurred_at)) continue;
      prefs[target_id] = { ...(prefs[target_id] || { target_id }), ...fields, updated_at: r.occurred_at };
      const it = byPid.get(target_id) || byId.get(target_id); if (it) it.queued = true;
    } else if (/^feed\.(saved|unsaved|hidden|unhidden)$/.test(r.kind)) {
      const it = byId.get(pl.target_event_id);
      if (it) { const verb = r.kind.split('.')[1]; it[verb.endsWith('saved') ? 'saved' : 'hidden'] = !verb.startsWith('un'); it.queued = true; }
    } else if (r.kind === 'message.posted') {
      let t = threads.find(x => x.id === pl.thread_id);
      if (!t) { t = { id: pl.thread_id, title: pl.thread_title || r.summary, messages: [] }; threads.push(t); }
      t.messages.push({ event_id: r.event_id, from: OWNER, to: pl.to, body: pl.body, state: 'new', at: r.occurred_at, queued: true });
      items.push({ id: r.event_id, type: 'message', kind: 'message', title: t.title, body: pl.body, kicker: `${OWNER} → ${pl.to}`, producer: OWNER, to: pl.to,
        at: r.occurred_at, topic: 'Messages', claim: 'fact', baseTags: [], nextAction: '', dueAt: null, threadId: t.id, messageState: 'new', answered: false,
        stats: [], refs: [], evidence: [], subject: `thread:${t.id}`, superseded: false, synthetic: false, sensitive: false, saved: false, hidden: false, queued: true });
      // the owner replying answers earlier messages in that thread
      for (const it of items) if (it.type === 'message' && it.threadId === t.id && it.producer !== OWNER && isOwner(it.to) && ts(it.at) <= ts(r.occurred_at)) it.answered = true;
    } else if (r.kind === 'idea.upserted') {
      items.push({ id: r.subject_id, type: 'idea', kind: 'idea', title: pl.title, body: pl.summary || '', kicker: 'Idea', producer: OWNER, at: r.occurred_at, topic: '',
        claim: 'fact', baseTags: [], nextAction: '', dueAt: null, stage: pl.stage || '', whyShown: '', stats: [], refs: [], evidence: [], subject: r.subject_id,
        superseded: false, synthetic: false, sensitive: false, saved: false, hidden: false, queued: true });
    } else if (r.kind === 'feed.item') {
      const isNote = String(pl.category || '').toLowerCase() === 'note';
      for (const old of r.supersedes || []) { const o = byId.get(old); if (o) o.superseded = true; }
      items.push({ note: isNote, encrypted: isNote && Object.hasOwn(pl, 'encrypted') ? (pl.encrypted && typeof pl.encrypted === 'object' ? pl.encrypted : { v: 0 }) : null, color: pl.color || '', origin: pl.source || '', pid: isNote && /^note:/.test(r.subject_id) ? r.subject_id : r.event_id, sensitive: r.visibility === 'sensitive', id: r.event_id, type: 'story', kind: r.kind, title: pl.title || r.summary, body: pl.body_md || '', kicker: pl.kicker || '', producer: OWNER, at: r.occurred_at,
        topic: pl.category || '', claim: 'fact', baseTags: [], nextAction: '', dueAt: null, sourceReadAt: null, whyShown: '', stats: [], refs: [], evidence: [],
        subject: r.subject_id, session: '', superseded: false, synthetic: false, saved: false, hidden: false, queued: true });
    }
  }
  for (const it of items) fill(it);
  return { ...model, items, prefs, threads };
}

/** Is this queued write already in the ledger? Judged by its effect, not only by the recent-activity list. */
export function isFiled(p, model) {
  const r = p.record, pl = r.payload || {};
  if(r.kind==='work.upserted') {
    if(workConflict(p,model)) return false;
    const w=model.work?.find(w=>w.id===r.subject_id);
    return !!w && (w.revision===r.event_id || w.history.some(h=>h.event_id===r.event_id) || w.conflicts.some(c=>c.event_id===r.event_id && c.resolved_by));
  }
  if (model.activityIds.has(r.event_id)) return true;
  if (r.kind === 'owner.pref') {
    const cur = model.prefs[pl.target_id];
    if (!cur) return false;
    const { target_id, ...fields } = pl;
    if (Object.entries(fields).every(([k, v]) => JSON.stringify(cur[k] ?? null) === JSON.stringify(v ?? null)) && ts(cur.updated_at) >= ts(r.occurred_at) - 1000) return true;
    return p.state === 'sent' && ts(cur.updated_at) > ts(r.occurred_at);       // sent, and a newer choice has replaced it
  }
  if (r.kind === 'message.posted' || r.kind === 'feed.item') return model.items.some(i => i.id === r.event_id);
  if (r.kind === 'idea.upserted') return model.items.some(i => i.id === r.subject_id);
  return false;
}

/** Which queued writes the ledger has now filed (seen in recent activity, or its effect is already in the ledger). */
export const settled = (pending, model) => pending.filter(p => isFiled(p, model));

/**
 * What to tell the owner about a queued write. `drops` = { inbox:Set, rejected:Set } of event ids seen on
 * GitHub (or null when not checked); `syncedAt` = last PC sync.
 */
export function pendingStatus(p, { drops = null, syncedAt = null, now = Date.now() } = {}) {
  if(p.workConflict) return {key:'conflict',label:p.workUnfiled?'Work changed: review your saved edit':'Filed but not applied: review the newer work revision',level:'bad'};
  const id = p.record.event_id, key = p.file || id, within = coll => [...(coll || [])].some(n => String(n).includes(key) || String(n).includes(id));
  if (p.state === 'refused') return { key: 'rejected', label: 'Not accepted', level: 'bad' };
  if (p.state === 'sending') return { key: 'sending', label: 'Sending…', level: 'wait' };
  if (p.state === 'unsent') return { key: 'unsent', label: 'Not sent yet', level: 'warn' };
  if (drops && within(drops.rejected)) return { key: 'rejected', label: 'The PC could not file this', level: 'bad' };
  const sentAt = Date.parse(p.sentAt || p.at || 0);
  if (drops && syncedAt && Date.parse(syncedAt) > sentAt + 60000 && !(drops && within(drops.inbox))) return { key: 'missing', label: 'Not filed. Send again?', level: 'bad' };
  if (now - sentAt > 60 * 60000) return { key: 'late', label: 'Still waiting after an hour. Is the PC on?', level: 'warn' };
  return { key: 'waiting', label: 'Waiting for the PC', level: 'wait' };
}

// ---------- derived facts about an item ----------

export function view(item, model, now = Date.now()) {
  const p = model.prefs[item.pid || item.id] || {};
  const tags = item.encrypted ? (item.locked ? [] : item.baseTags) : Array.isArray(p.tags) ? dedupe(p.tags, true) : item.baseTags;
  const status = p.status || 'new';
  const snoozed = !!p.snoozed_until && Date.parse(p.snoozed_until) > now;
  const fromOwner = isOwner(item.producer);
  let reason = '';
  if (status === 'needs_input') reason = 'You flagged this';
  else if (status !== 'done') {
    if (item.type === 'message' && !fromOwner && (isOwner(item.to) || String(item.to).toLowerCase() === 'all') && !item.answered && item.messageState !== 'completed') reason = 'Message for you';
    else if (item.nextAction && status !== 'in_progress') reason = 'Next step suggested';
  }
  const rc = Object.entries(model.receipts[item.id] || {});
  const others = realAgents(model).filter(a => a.id !== item.producer);
  return {
    tags, status, priority: p.priority || 'normal', pinned: p.pinned === true, read: p.read === true, snoozed, snoozedUntil: p.snoozed_until || null,
    ownTags: Array.isArray(p.tags), needsYou: !!reason, reason,
    due: item.dueAt ? { at: item.dueAt, overdue: Date.parse(item.dueAt) < now, soon: Date.parse(item.dueAt) <= now + 7 * 864e5 } : null,
    receipts: { fetched: rc.filter(([, s]) => s === 'fetched' || s === 'applied').length, applied: rc.filter(([, s]) => s === 'applied').length,
      failed: rc.filter(([, s]) => s === 'failed' || s === 'declined').length, of: others.length,
      rows: others.map(a => ({ id: a.id, label: a.label || a.id, state: (model.receipts[item.id] || {})[a.id] || 'not fetched' })) },
  };
}

export const VIEWS = {
  today: { title: 'Needs you', types: null },
  feed: { title: 'Feed', types: ['story'] },
  notes: { title: 'Notes', types: ['story'] },
  goals: { title: 'Goals', types: ['goal'] },
  ideas: { title: 'Ideas', types: ['idea'] },
  messages: { title: 'Messages', types: ['message'] },
  saved: { title: 'Saved', types: null },
  snoozed: { title: 'Snoozed', types: null },
  hidden: { title: 'Hidden', types: null },
  history: { title: 'History', types: null },
};

/** Does `item` belong in `viewId`? Hidden, snoozed, replaced and sample records leave the ordinary views. */
export function inView(viewId, item, v, opts = {}) {
  if (item.synthetic && !opts.samples) return false;
  if (viewId === 'hidden') return item.hidden;
  if (item.hidden) return false;
  if (viewId === 'history') return item.superseded || (item.type === 'goal' && item.lifecycle === 'completed');
  if (viewId === 'snoozed') return v.snoozed;
  if (viewId === 'saved') return item.saved;
  if (item.superseded || v.snoozed) return false;
  if (viewId === 'today') return v.needsYou;
  if (viewId === 'notes') return item.note;
  if (viewId === 'feed' && item.note) return false;
  if (viewId === 'feed' && item.attentionOnly) return false;
  const def = VIEWS[viewId];
  return !def || !def.types || def.types.includes(item.type);
}

export function matches(item, v, f) {
  if (f.producer && item.producer !== f.producer) return false;
  if (f.topic && item.topic !== f.topic) return false;
  if (f.tag && !v.tags.some(t => t.toLowerCase() === f.tag.toLowerCase())) return false;
  if (f.claim && item.claim !== f.claim) return false;
  if (f.status && v.status !== f.status) return false;
  if (f.unread && v.read) return false;
  if (f.q) {
    const hay = [item.title, item.body, item.kicker, item.topic, item.producer, item.nextAction, item.whyShown, ...v.tags,
      ...(item.evidence || []).flatMap(e => [e.title, e.summary])].join(' ').toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w))) return false;
  }
  return true;
}

const PRI = { high: 0, normal: 1, low: 2 };
export function sortItems(list, sort = 'new') {
  const cmp = sort === 'title' ? (a, b) => a.item.title.localeCompare(b.item.title)
    : sort === 'old' ? (a, b) => a.item.t - b.item.t
    : (a, b) => b.item.t - a.item.t;
  return list.sort((a, b) => (b.v.pinned - a.v.pinned) || (sort === 'priority' ? PRI[a.v.priority] - PRI[b.v.priority] : 0) || cmp(a, b));
}

/** The rows for a view: [{item, v}], filtered and sorted. */
export function rowsFor(model, viewId, filters = {}, opts = {}, now = Date.now()) {
  const out = [];
  for (const item of model.items) {
    const v = view(item, model, now);
    if (inView(viewId, item, v, opts) && matches(item, v, filters)) out.push({ item, v });
  }
  return sortItems(out, filters.sort);
}

export function counts(model, opts = {}, now = Date.now()) {
  const c = Object.fromEntries(Object.keys(VIEWS).map(k => [k, 0]));
  let unread = 0;
  for (const item of model.items) {
    const v = view(item, model, now);
    for (const k of Object.keys(VIEWS)) if (inView(k, item, v, opts)) c[k]++;
    if (inView('feed', item, v, opts) && !v.read && !isOwner(item.producer)) unread++;
  }
  return { ...c, unread };
}

/** Facets for the filter menus, counted over the rows the current view would show without filters. */
export function facets(rows) {
  const tally = key => { const m = new Map(); for (const r of rows) for (const k of key(r)) if (k) m.set(k, (m.get(k) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])); };
  return { producers: tally(r => [r.item.producer]), topics: tally(r => [r.item.topic]), tags: tally(r => r.v.tags) };
}

// ---------- freshness ----------

/** How old the data is. `syncedAt` = when the PC last pushed (remote) or null when reading live from the PC. */
export function freshness(syncedAt, live, now = Date.now()) {
  if (live) return { level: 'ok', text: 'Live from this PC' };
  if (!syncedAt) return { level: 'warn', text: 'Sync time unknown' };
  const mins = Math.max(0, Math.round((now - Date.parse(syncedAt)) / 60000));
  const text = mins < 2 ? 'Synced just now' : mins < 90 ? `Synced ${mins} min ago` : mins < 48 * 60 ? `Synced ${Math.round(mins / 60)} h ago` : `Synced ${Math.round(mins / 1440)} days ago`;
  return { level: mins > 24 * 60 ? 'bad' : mins > 120 ? 'warn' : 'ok', text };
}

export function ago(isoTime, now = Date.now()) {
  if (!isoTime) return '';
  const d = (now - Date.parse(isoTime)) / 1000;
  if (isNaN(d)) return '';
  if (d < 90) return 'now';
  if (d < 3600) return Math.round(d / 60) + 'm';
  if (d < 86400) return Math.round(d / 3600) + 'h';
  if (d < 86400 * 30) return Math.round(d / 86400) + 'd';
  return new Date(isoTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Per-agent summary for the Agents view. */
export function agentRows(model, opts = {}) {
  const given = {};
  for (const [, per] of Object.entries(model.receipts)) for (const [c, st] of Object.entries(per)) { const g = given[c] ||= { fetched: 0, applied: 0, failed: 0 }; g[st === 'applied' ? 'applied' : st === 'fetched' ? 'fetched' : 'failed']++; }
  return model.agents.filter(a => !isOwner(a.id) && a.id !== 'bootstrap' && a.id !== 'fixture' && (opts.samples || !/-sample$/.test(a.id)))
    .map(a => ({ id: a.id, label: a.label || a.id, records: a.events || 0, last: a.last_event_at || null, ...(given[a.id] || { fetched: 0, applied: 0, failed: 0 }) }))
    .sort((a, b) => b.records - a.records || a.label.localeCompare(b.label));
}

/** Who a message about `item` should go to by default: the other party of a thread, else the item's author. */
export function defaultRecipient(item, model) {
  const real = realAgents(model).map(a => a.id);
  if (item.type === 'message') {
    if (!isOwner(item.producer)) return item.producer;                                   // reply to whoever wrote it
    if (!isOwner(item.to) && String(item.to).toLowerCase() !== 'all') return item.to;       // my own message: the person I wrote to
    const t = model.threads.find(x => x.id === item.threadId);
    const other = [...(t ? t.messages : [])].reverse().map(m => (isOwner(m.from) ? m.to : m.from)).find(id => !isOwner(id) && String(id).toLowerCase() !== 'all');
    if (other) return other;
  }
  return real.includes(item.producer) ? item.producer : '';
}

/** Everything the Overview page shows, as plain data. Each number says what it counts. */
export function overview(model, opts = {}, now = Date.now()) {
  const rows = model.items.map(item => ({ item, v: view(item, model, now) })).filter(r => !r.item.hidden && !r.item.superseded && !r.v.snoozed && (opts.samples || !r.item.synthetic));
  const byNew = (a, b) => b.item.t - a.item.t;
  const needs = rows.filter(r => r.v.needsYou).sort((a, b) => (b.v.pinned - a.v.pinned) || byNew(a, b));
  const week = now - 7 * 864e5;
  const agents = agentRows(model, opts).map(a => {
    const recent = rows.filter(r => r.item.producer === a.id && Date.parse(r.item.at) >= week).length;
    const hours = a.last ? (now - Date.parse(a.last)) / 3600e3 : null;
    return { ...a, recent, state: a.records === 0 ? 'silent' : hours > 72 ? 'quiet' : 'active' };
  });
  const sessions = new Map();
  for (const r of rows) if (r.item.sessionId) { const s = sessions.get(r.item.sessionId) || { id: r.item.sessionId, name: r.item.session || 'Session', agent: r.item.producer, stories: 0, last: '' }; s.stories++; if (r.item.at > s.last) s.last = r.item.at; sessions.set(r.item.sessionId, s); }
  return {
    needs: { count: needs.length, top: needs.slice(0, 5) },
    unread: rows.filter(r => r.item.type === 'story' && !r.item.note && !r.v.read && !isOwner(r.item.producer)).length,
    brief: rows.filter(r => r.item.brief).sort(byNew)[0] || null,
    due: rows.filter(r => r.v.due && r.v.due.soon && r.v.status !== 'done' && ts(r.item.dueAt) > now - 30 * 864e5).sort((a, b) => String(a.item.dueAt).localeCompare(String(b.item.dueAt))).slice(0, 5),
    unverified: rows.filter(r => r.item.claim !== 'fact' && r.v.status !== 'done').length,
    goals: rows.filter(r => r.item.type === 'goal' && r.item.lifecycle !== 'completed').sort(byNew).slice(0, 6),
    agents,
    failed: rows.filter(r => r.v.receipts.failed > 0).slice(0, 5),
    sessions: [...sessions.values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, 5),
    latest: rows.filter(r => r.item.type === 'story' && !r.item.brief && !r.item.note).sort(byNew).slice(0, 5),
    notes: rows.filter(r => r.item.note).sort((a, b) => (b.v.pinned - a.v.pinned) || byNew(a, b)).slice(0, 4),
  };
}

/** Which date section a row falls under, the way a phone notes app groups its list. */
export function dateGroup(at, now = Date.now()) {
  const d = new Date(ts(at)), n = new Date(now), day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(n) - day(d)) / 864e5);
  return !ts(at) ? 'Earlier' : days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days <= 7 ? 'Previous 7 days' : days <= 30 ? 'Previous 30 days' : 'Earlier';
}

/** The board: the owner's four statuses as columns of cards. Messages and notes stay in their own views. */
export function board(model, opts = {}, now = Date.now()) {
  const cols = Object.fromEntries(Object.keys(STATUS).map(k => [k, []]));
  for (const item of model.items) {
    if (item.type === 'message' || item.note || item.hidden || item.superseded || (item.synthetic && !opts.samples)) continue;
    const v = view(item, model, now);
    if (v.snoozed) continue;
    cols[v.status].push({ item, v });
  }
  for (const k of Object.keys(cols)) sortItems(cols[k], 'priority');
  return cols;
}
