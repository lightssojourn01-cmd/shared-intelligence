// The one data module (CONTRACT.md sections 4 and 5): two doors behind the same two functions.
//   local  — the PC app's API (http://127.0.0.1:4317/api/...), live
//   github — the private mirror branch through the GitHub API, works with the PC off
// Nothing else in the build talks to the network.

const GH = 'https://api.github.com';
export const DEFAULTS = { door: 'auto', repo: '', branch: 'main', base: 'shared-intelligence/ledger', token: '' };
export function validateSettings(settings) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(settings.repo) || settings.repo.split('/').some(p => p === '.' || p === '..')) throw Object.assign(new Error('Enter the owner/name of your private data-only repository in Settings.'), { code: 'NEED_REPO' });
  if (!settings.branch || /[\s?#\\]/.test(settings.branch)) throw Object.assign(new Error('Enter a valid mirror branch in Settings.'), { code: 'SETTINGS' });
  if (!settings.base || settings.base.startsWith('/') || /[\\?#]/.test(settings.base) || settings.base.split('/').some(p => !p || p === '.' || p === '..')) throw Object.assign(new Error('The ledger base path must be relative, without empty or parent folders.'), { code: 'SETTINGS' });
}

const rateLimited = r => r.status === 429 || (r.status === 403 && (r.headers?.get?.('retry-after') || r.headers?.get?.('x-ratelimit-remaining') === '0'));
const b64 = text => { const bytes = new TextEncoder().encode(text); let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };

export function makeStore(storage) {
  const get = (k, d) => { try { const v = storage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const set = (k, v) => { try { storage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
  const del = k => { try { storage.removeItem(k); } catch {} };
  return { get, set, del };
}

export class Doors {
  /** @param {{fetch: typeof fetch, store: ReturnType<typeof makeStore>, origin?: string}} deps */
  constructor({ fetch, store, origin = '' }) {
    this.fetch = fetch; this.store = store; this.origin = origin;
    this.settings = { ...DEFAULTS, ...store.get('si.settings', {}) };
    this.door = null;           // resolved door: 'local' | 'github'
  }
  saveSettings(patch) {
    const next = { ...this.settings, ...patch };
    if (next.door !== 'local') validateSettings(next);
    if (!this.store.set('si.settings', next)) throw Object.assign(new Error('This browser could not save the connection settings. Check storage permissions or free space.'), { code: 'STORAGE' });
    this.settings = next; this.door = null;
  }

  ghHeaders(extra = {}) {
    return { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${this.settings.token}`, ...extra };
  }
  ghUrl(path) { return `${GH}/repos/${this.settings.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`; }
  async privateRepository() {
    validateSettings(this.settings);
    if (!this.settings.token) throw Object.assign(new Error('Connect a token limited to your private data repository.'), { code: 'NEED_TOKEN' });
    let r;
    try { r = await this.fetch(`${GH}/repos/${this.settings.repo}`, { headers: this.ghHeaders(), cache: 'no-store' }); }
    catch { throw Object.assign(new Error('GitHub is not reachable. The private repository could not be checked.'), { code: 'OFFLINE' }); }
    if (rateLimited(r)) throw Object.assign(new Error('GitHub is asking this device to slow down. Try again later.'), { code: 'SLOW_DOWN' });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('GitHub refused this token. Check its repository access in Settings.'), { code: 'AUTH' });
    if (r.status === 404) throw Object.assign(new Error('The private data repository was not found. Check Settings and token access.'), { code: 'NOT_FOUND' });
    if (!r.ok) throw Object.assign(new Error('GitHub could not verify the private data repository.'), { code: 'HTTP' });
    const meta = await r.json().catch(() => null);
    if (meta?.private !== true) throw Object.assign(new Error('This must be a private data-only repository. No change was sent by this attempt.'), { code: 'PUBLIC_REPO' });
  }

  /** Which door to use. 'auto' = the PC app when this page is served by it, otherwise GitHub. */
  async resolve() {
    if (this.door) return this.door;
    const want = this.settings.door;
    if (want === 'github') return (this.door = 'github');
    if (/^https:\/\/[^/]+\.github\.io(?::\d+)?$/.test(this.origin)) return (this.door = 'github');
    try {
      const r = await this.fetch(`${this.origin}/api/builds`, { cache: 'no-store' });
      // a real answer from the PC app, not a web host's fallback page
      if (r.ok && Array.isArray((await r.json()).builds)) return (this.door = 'local');
    } catch {}
    // On the PC itself the app may just be starting: say so, and try again on the next load.
    if (want === 'local' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(this.origin))
      throw Object.assign(new Error('The app on this PC is not answering. It may be starting or stopped.'), { code: 'NO_LOCAL' });
    return (this.door = 'github');
  }

  /** → { raw, door, syncedAt, live } . Throws {code:'NEED_TOKEN'|'AUTH'|'NOT_FOUND'|'OFFLINE'|'HTTP'}. */
  async load() {
    const door = await this.resolve();
    if (door === 'local') {
      let r;
      try { r = await this.fetch(`${this.origin}/api/state`, { cache: 'no-store' }); }
      catch { throw Object.assign(new Error('The app on this PC is not reachable.'), { code: 'OFFLINE' }); }
      if (!r.ok) throw Object.assign(new Error(`The PC app answered ${r.status}.`), { code: 'HTTP' });
      const raw = await r.json();
      if (!Array.isArray(raw?.feed)) throw Object.assign(new Error('The PC returned an unreadable ledger.'), { code: 'HTTP' });
      return { raw, door, syncedAt: null, live: true };
    }
    validateSettings(this.settings);
    if (!this.settings.token) throw Object.assign(new Error('A GitHub token is needed to read the private mirror.'), { code: 'NEED_TOKEN' });
    await this.privateRepository();
    let r;
    try {
      r = await this.fetch(`${this.ghUrl(`${this.settings.base}/exports/state.json`)}?ref=${encodeURIComponent(this.settings.branch)}`,
        { headers: this.ghHeaders({ Accept: 'application/vnd.github.raw+json' }), cache: 'no-store' });
    } catch (e) { throw Object.assign(new Error('GitHub is not reachable. You may be offline.'), { code: 'OFFLINE' }); }
    if (rateLimited(r)) throw Object.assign(new Error('GitHub is asking this device to slow down. Try again in a few minutes.'), { code: 'RETRY' });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('GitHub refused the token. It may have expired or lack access to this repository.'), { code: 'AUTH' });
    if (r.status === 404) throw Object.assign(new Error('The data file was not found. Check the repository and branch, and that the token can read it.'), { code: 'NOT_FOUND' });
    if (!r.ok) throw Object.assign(new Error(`GitHub answered ${r.status}.`), { code: 'HTTP' });
    const raw = await r.json();
    if (!Array.isArray(raw?.feed)) throw Object.assign(new Error('The mirror did not return a ledger. Check Settings.'), { code: 'NOT_FOUND' });
    // The sync time is when the PC last rewrote the data file, not the newest commit on the branch:
    // the owner's own queued writes are commits too and would make old data look fresh.
    let syncedAt = null;
    try {
      const c = await this.fetch(`${GH}/repos/${this.settings.repo}/commits?sha=${encodeURIComponent(this.settings.branch)}&path=${encodeURIComponent(`${this.settings.base}/exports/`)}&per_page=1`, { headers: this.ghHeaders(), cache: 'no-store' });
      if (c.ok) syncedAt = (await c.json())[0]?.commit?.committer?.date || null;
    } catch {}
    return { raw, door, syncedAt, live: false };
  }

  /**
   * Send one record. → { filed: true } when the ledger has it now (local door),
   * or { filed: false } when it is waiting for the PC's next sync (github door).
   */
  async write(recordOrList) {
    const records = Array.isArray(recordOrList) ? recordOrList : [recordOrList];
    const door = await this.resolve();
    if (door === 'local') {
      const outcomes = [];
      for (const record of records) {
        let r;
        try { r = await this.fetch(`${this.origin}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record) }); }
        catch { throw Object.assign(new Error('The app on this PC is not answering. Unsent changes are kept for retry.'), { code: 'OFFLINE', outcomes }); }
        const j = await r.json().catch(() => ({}));
        if (r.status >= 500) throw Object.assign(new Error(`The PC app answered ${r.status}. Unsent changes are kept for retry.`), { code: 'RETRY', outcomes });
        // Identical retries return 200/duplicate. A 409 means different content used this id.
        if (!r.ok) { outcomes.push({ event_id: record.event_id, filed: false, rejected: true, error: j.error || `The PC app answered ${r.status}.` }); continue; }
        outcomes.push({ event_id: record.event_id, filed: true });
      }
      return { filed: outcomes.every(o => o.filed), outcomes };
    }
    if (records.some(r => r.visibility === 'sensitive')) throw Object.assign(new Error('Sensitive notes can only be saved through the PC connection.'), { code: 'REJECTED' });
    validateSettings(this.settings);
    if (!this.settings.token) throw Object.assign(new Error('A GitHub token is needed to send changes.'), { code: 'NEED_TOKEN' });
    await this.privateRepository();
    // several changes made together travel as one drop file: one commit, not one per change
    const drop = JSON.stringify(records.length === 1 ? { producer: 'owner-ui', ...records[0] } : records.map(r => ({ producer: 'owner-ui', ...r })), null, 1) + '\n';
    const name = records.length === 1 ? records[0].event_id : `${records[0].event_id}-x${records.length}`;
    let r;
    try {
      r = await this.fetch(this.ghUrl(`${this.settings.base}/inbox/${name}.json`), { method: 'PUT', headers: this.ghHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ message: `owner: ${records.length === 1 ? records[0].kind : records.length + ' changes'}`, content: b64(drop), branch: this.settings.branch }) });
    } catch (e) { throw Object.assign(new Error('GitHub is not reachable. The change is kept and will be sent again.'), { code: 'OFFLINE' }); }
    if (r.ok) return { filed: false, file: name + '.json' };
    if (r.status === 422) {                                    // usually: this drop file already exists, an earlier attempt got through
      const j = await r.json().catch(() => ({}));
      if (/sha|exist/i.test(String(j.message || ''))) return { filed: false, file: name + '.json' };
      throw Object.assign(new Error(`GitHub did not accept the change: ${j.message || 422}.`), { code: 'REJECTED' });
    }
    if (rateLimited(r)) throw Object.assign(new Error('GitHub is asking this device to slow down. Try again in a few minutes.'), { code: 'SLOW_DOWN' });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('GitHub refused the token for writing. It needs Contents: Read and write. The change is kept.'), { code: 'AUTH' });
    if (r.status === 404) throw Object.assign(new Error('Check Settings: repository, branch, and token access. The change has not been sent.'), { code: 'NOT_FOUND' });
    // 409 = the PC pushed at the same moment; 5xx = GitHub trouble. Both are worth another try.
    throw Object.assign(new Error(`GitHub answered ${r.status}. The change is kept and will be sent again.`), { code: 'RETRY' });
  }

  /** Which of our queued drops are still on GitHub, and which the PC set aside. → { inbox:Set, rejected:Set } of event ids, or null. */
  async dropStatus(ids) {
    if (this.door !== 'github' || !this.settings.token || !ids.length) return null;
    const names = async dir => {
      const r = await this.fetch(`${this.ghUrl(`${this.settings.base}/${dir}`)}?ref=${encodeURIComponent(this.settings.branch)}`, { headers: this.ghHeaders(), cache: 'no-store' });
      if (!r.ok) throw new Error('Listing unavailable');
      const files = await r.json();
      if (!Array.isArray(files)) throw new Error('Unreadable listing');
      return files.map(f => String(f.name));
    };
    try {
      const [inbox, rejected] = await Promise.all([names('inbox'), names('inbox/rejected')]);
      return { inbox: new Set(inbox), rejected: new Set(rejected) };
    } catch { return null; }
  }

  /** Live updates from the PC app; returns a stop function. No-op on the GitHub door. */
  watch(onChange) {
    if (this.door !== 'local' || typeof EventSource === 'undefined') return () => {};
    const es = new EventSource(`${this.origin}/api/stream`);
    es.addEventListener('revision', () => onChange());
    let first = true;      // after a dropped connection the server greets again: catch up on what was missed
    es.addEventListener('hello', () => { if (first) first = false; else onChange(); });
    return () => es.close();
  }
}
