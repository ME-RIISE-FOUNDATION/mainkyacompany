'use strict';

// Initialize theme immediately
(function() {
  const theme = localStorage.getItem('tbi_theme') || 'ocean';
  document.documentElement.setAttribute('data-theme', theme);
})();

// ── Startup spinner ───────────────────────────────────────────
// Shown the instant this script runs so a slow first load shows progress
// instead of a blank screen; removed by renderShell on first paint.
function showBootLoader() {
  if (document.getElementById('tbiBootLoader')) return;
  const d = document.createElement('div');
  d.id = 'tbiBootLoader';
  d.setAttribute('style',
    'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:14px;background:#0a1929;color:#cfe3ff;' +
    'font-family:Inter,system-ui,sans-serif');
  d.innerHTML =
    '<div style="width:42px;height:42px;border:4px solid rgba(207,227,255,.25);border-top-color:#3b82f6;' +
    'border-radius:50%;animation:tbiSpin .8s linear infinite"></div>' +
    '<div style="font-size:.9rem;opacity:.8">Loading…</div>' +
    '<style>@keyframes tbiSpin{to{transform:rotate(360deg)}}</style>';
  (document.body || document.documentElement).appendChild(d);
}
function hideBootLoader() {
  document.getElementById('tbiBootLoader')?.remove();
}
// Only shell pages (admin/employee) start blank while awaiting data; the login
// page renders its own static markup, so leave it alone.
if (document.getElementById('pageContent')) showBootLoader();

// ── Config ────────────────────────────────────────────────────
// Only the CEO has admin access. The COO (Mohana) is a task recipient like any
// other staff member — she receives tasks but does not get the admin panel.
const ADMIN_ROLES   = ['CEO'];
const TASK_STATUSES = ['Pending', 'In Progress', 'Completed', 'Approved', 'Rejected'];
const PRIORITIES    = ['High', 'Medium', 'Low'];
const DESIGNATIONS  = ['CEO', 'COO', 'TBI Manager', 'Programme Associate/Outreach officer', 'Software Associate', 'Finance Associate', 'Innovation Associate', 'Support Staff'];

// ── Server sync ───────────────────────────────────────────────
// Served over http(s) => a PHP backend is present and is the shared source of
// truth. Opened from file:// => fall back to a pure-localStorage dev mode.
const SERVER_MODE = location.protocol === 'http:' || location.protocol === 'https:';
const ENTITIES    = ['employees', 'users', 'tasks', 'approvals', 'notifications', 'attendance'];

const API = {
  url() { return rootPath() + 'api/data_api.php'; },
  OUTBOX_KEY: 'tbi_outbox',
  _draining: null,

  OUTBOX_DEAD_KEY: 'tbi_outbox_dead',
  _readOutbox()  { try { return JSON.parse(localStorage.getItem(this.OUTBOX_KEY) || '[]'); } catch { return []; } },
  _writeOutbox(q){ localStorage.setItem(this.OUTBOX_KEY, JSON.stringify(q)); },
  // Number of writes that have not yet been confirmed by the server.
  pending()      { return this._readOutbox().length; },
  // Entities that still have an unconfirmed write queued — used so a background
  // refresh can adopt the shared server snapshot for everything EXCEPT the
  // entities this browser is mid-write on (which would otherwise get clobbered).
  pendingEntities() { return new Set(this._readOutbox().map(i => i.entity)); },
  // A write the server permanently rejected (HTTP 4xx) can never succeed on
  // retry, so it is moved here instead of blocking the queue forever.
  _deadLetter(item, reason) {
    try {
      const d = JSON.parse(localStorage.getItem(this.OUTBOX_DEAD_KEY) || '[]');
      d.push({ ...item, reason, at: new Date().toISOString() });
      localStorage.setItem(this.OUTBOX_DEAD_KEY, JSON.stringify(d.slice(-50)));
    } catch { /* dead-letter is best-effort */ }
  },

  // Durably record a mutation BEFORE returning, then kick off a send. Because the
  // queue lives in localStorage it survives reloads, navigation and cold starts,
  // so a write is never silently dropped just because the server was unreachable.
  push(action, entity, payload) {
    if (!SERVER_MODE) return;
    const q = this._readOutbox();
    q.push({ op: 'op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), action, entity, payload });
    this._writeOutbox(q);
    this.drain();
  },

  // Send queued writes in order. A 4xx (permanent, malformed) write is dropped
  // to a dead-letter and draining continues; a network error or 5xx (transient)
  // stops draining so ordering is preserved and the write is retried next time.
  // Without the 4xx drop a single bad write would wedge the queue forever and,
  // because _sync() won't adopt the server snapshot while writes are pending,
  // permanently island this browser on its own local cache.
  drain() {
    if (this._draining) return this._draining;
    this._draining = (async () => {
      while (true) {
        const q = this._readOutbox();
        if (!q.length) break;
        const item = q[0];
        try {
          const res = await fetch(this.url(), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: item.action, entity: item.entity, ...item.payload }),
            keepalive: true,
          });
          if (!res.ok) {
            if (res.status >= 400 && res.status < 500) {
              // Permanent: the server will reject this write on every retry.
              console.error('[TBI] dropping rejected write', item.action, item.entity, 'HTTP ' + res.status);
              this._deadLetter(item, 'HTTP ' + res.status);
              const qd = this._readOutbox(); qd.shift(); this._writeOutbox(qd);
              continue;             // keep draining the rest of the queue
            }
            throw new Error('HTTP ' + res.status);   // 5xx — transient, retry later
          }
        } catch (err) {
          console.error('[TBI] sync deferred, will retry on next load', item.action, item.entity, err);
          break; // transient — keep this item and everything after it for a later attempt
        }
        const q2 = this._readOutbox();
        q2.shift();                 // confirmed — drop the head
        this._writeOutbox(q2);
      }
    })().finally(() => { this._draining = null; });
    return this._draining;
  },

  // Resolves once a send attempt has finished (queue empty, or blocked on error).
  // Check pending() afterwards to know whether everything actually synced.
  flush() { return this.drain(); },

  // ── Credential calls — direct request/response, never queued or cached, so a
  // cleartext password is never written to localStorage. ──────────────────────
  async login(username, password) {
    const res = await fetch(this.url(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', username, password }),
    });
    return res.json();   // { ok, user } | { ok:false, error }
  },
  async setPassword(username, newPassword, currentPassword) {
    const payload = { action: 'set_password', username, newPassword };
    if (currentPassword !== undefined) payload.currentPassword = currentPassword;
    const res = await fetch(this.url(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();   // { ok } | { ok:false, error }
  },
};

// ── DB (localStorage cache, mirrored to the server) ───────────
const DB = {
  _get(key)            { try { return JSON.parse(localStorage.getItem('tbi_' + key) || '[]'); } catch { return []; } },
  _setLocal(key, data) { localStorage.setItem('tbi_' + key, JSON.stringify(data)); },
  _set(key, data)      { this._setLocal(key, data); API.push('replace', key, { data }); },
  getAll(entity)                           { return this._get(entity); },
  findOne(entity, field, value)            { return this._get(entity).find(r => r[field] === value) || null; },
  findMany(entity, field, value)           { return this._get(entity).filter(r => r[field] === value); },
  append(entity, record)                   {
    const d = this._get(entity); d.push(record); this._setLocal(entity, d);
    API.push('append', entity, { record });
  },
  updateById(entity, idField, idVal, upd)  {
    this._setLocal(entity, this._get(entity).map(r => r[idField] === idVal ? {...r, ...upd} : r));
    API.push('update', entity, { idField, idVal, upd });
  },
  deleteById(entity, idField, idVal)       {
    this._setLocal(entity, this._get(entity).filter(r => r[idField] !== idVal));
    API.push('delete', entity, { idField, idVal });
  },
};

// Pull the shared dataset from the server into the local cache. Runs once per
// page load; pages await TBI.ready() before rendering so they show live data.
const TBI = {
  _ready: null,
  _syncCbs: [],
  _timerStarted: false,
  ready() {
    if (!this._ready) this._ready = this._boot();
    return this._ready;
  },
  // Register a repaint callback re-invoked whenever a background sync brings in
  // changed shared data, so a dashboard left open converges without a manual
  // reload. Pages call this right after their initial render.
  onSync(cb) { if (typeof cb === 'function') this._syncCbs.push(cb); },
  // For pages that render inline (no reusable render fn): reload on a sync that
  // changed the shared data, but only when it won't disrupt the user — tab
  // visible, no open modal, no field focused, and no local write in flight.
  autoReloadOnSync() {
    this.onSync(() => {
      if (document.hidden) return;
      if (document.querySelector('.modal.show')) return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
      if (API.pending() > 0) return;
      location.reload();
    });
  },
  async _boot() {
    if (!SERVER_MODE) { seedIfNeeded(); return; }
    this._startAutoSync();
    // Stale-while-revalidate: if we already have a cached dataset, render from it
    // immediately and refresh from the server in the background. Only the very
    // first load (no cache) waits for the network — so a slow/cold backend never
    // leaves the user staring at a blank screen.
    if (localStorage.getItem('tbi_users')) {
      this._sync();                 // fire-and-forget refresh
      return;
    }
    await this._sync();
  },
  // Keep an open dashboard live: refresh periodically and when the tab regains
  // focus. Guarded so it is wired up only once per page.
  _startAutoSync() {
    if (this._timerStarted || !SERVER_MODE) return;
    this._timerStarted = true;
    setInterval(() => this._sync(), 45000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this._sync();
    });
  },
  async _sync() {
    // Replay unsynced writes first (bounded) so local changes reach the server
    // before we pull, then fetch a fresh snapshot — both capped so a cold start
    // can't hang startup indefinitely.
    await Promise.race([API.flush(), this._delay(3500)]);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 7000);
      let json;
      try {
        const res = await fetch(API.url() + '?action=bootstrap', { cache: 'no-store', signal: ctrl.signal });
        json = await res.json();
      } finally { clearTimeout(timer); }
      if (!json.ok) throw new Error(json.error || 'bootstrap failed');
      // Adopt the shared server snapshot per-entity: overwrite the local cache
      // for every entity that has no write still queued locally, and keep the
      // local copy only for entities with an in-flight write (so we don't
      // clobber an edit that hasn't reached the server yet). This guarantees a
      // browser always converges to shared data for everything except its own
      // pending writes — a single stuck write can no longer freeze the whole UI.
      const pendingEnts = API.pendingEntities();
      let changed = false;
      ENTITIES.forEach(e => {
        if (pendingEnts.has(e) || !Array.isArray(json.data[e])) return;
        const next = JSON.stringify(json.data[e]);
        if (next !== JSON.stringify(DB._get(e))) changed = true;
        DB._setLocal(e, json.data[e]);
      });
      if (pendingEnts.size) {
        console.warn('[TBI] kept local cache for pending entities:', [...pendingEnts].join(', '));
      }
      // Repaint open pages only when the shared data actually changed, so the
      // periodic refresh does not trigger needless re-renders (or render loops).
      if (changed) this._notifySynced();
    } catch (err) {
      console.error('[TBI] bootstrap slow/unreachable, using local cache/seed', err);
      seedIfNeeded(true);  // degrade gracefully to a local-only dataset
    }
  },
  _notifySynced() {
    this._syncCbs.forEach(cb => { try { cb(); } catch (e) { console.error('[TBI] onSync callback failed', e); } });
    try { window.dispatchEvent(new CustomEvent('tbi:synced')); } catch { /* older browsers */ }
  },
  _delay(ms) { return new Promise(r => setTimeout(r, ms)); },
};

// ── Seed ──────────────────────────────────────────────────────
// In server mode the backend is the source of truth, so this only runs as a
// local fallback (force=true) when the server is unreachable. Uses _setLocal so
// seed data is never pushed back to the server.
function seedIfNeeded(force) {
  if (SERVER_MODE && !force) return;
  if (localStorage.getItem('tbi_initialized')) return;

  DB._setLocal('employees', [
    {"Employee_ID":"EMP_001","Name":"Dr. Geetha Kiran A",  "Designation":"CEO",                 "Email":"ceomeriise@mcehassan.ac.in","Phone":"+91 98765 43210","Photo_URL":"","Status":"Active"},
    {"Employee_ID":"EMP_002","Name":"Dr. Mohana Lakshmi J","Designation":"COO",                 "Email":"coomeriise@mcehassan.ac.in","Phone":"+91 98765 43211","Photo_URL":"","Status":"Active"},
    {"Employee_ID":"EMP_008","Name":"Mr. Stapley V S",     "Designation":"TBI Manager",         "Email":"imtbimeriise@mcehassan.ac.in","Phone":"+91 9844293678","Photo_URL":"","Status":"Active"},
    {"Employee_ID":"EMP_007","Name":"Ms. Megha H M",       "Designation":"Programme Associate/Outreach officer","Email":"patbimeriise@mcehassan.ac.in","Phone":"","Photo_URL":"","Status":"Active"},
    {"Employee_ID":"EMP_003","Name":"Mr. Darshan H D",     "Designation":"Software Associate",  "Email":"satbimeriise@mcehassan.ac.in", "Phone":"+91 98765 43212","Photo_URL":"","Status":"Active"},
    {"Employee_ID":"EMP_004","Name":"Miss. Ramya K V",     "Designation":"Finance Associate",   "Email":"fatbimeriise@mcehassan.ac.in", "Phone":"+91 98765 43213","Photo_URL":"","Status":"Active"},
    {"Employee_ID":"EMP_005","Name":"Ms. Madhurya H V",    "Designation":"Innovation Associate","Email":"iatbimeriise@mcehassan.ac.in", "Phone":"+91 98765 43214","Photo_URL":"","Status":"Active"},
    {"Employee_ID":"EMP_006","Name":"Ms. Deeksha M S",     "Designation":"Support Staff",    "Email":"sstbimeriise@mcehassan.ac.in", "Phone":"+91 98765 43215","Photo_URL":"","Status":"Active"}
  ]);

  // DEV/OFFLINE SEED ONLY (file:// fallback). Real auth runs server-side against
  // bcrypt hashes in data/users.json — never put real passwords here. The
  // placeholder below only lets the app open when there is no backend.
  DB._setLocal('users', [
    {"User_ID":"USR_001","Username":"geetha",  "Password":"changeme123","Designation":"CEO",                 "Employee_ID":"EMP_001","Email":"ceomeriise@mcehassan.ac.in","Name":"Dr. Geetha Kiran A"},
    {"User_ID":"USR_002","Username":"mohana",  "Password":"changeme123","Designation":"COO",                 "Employee_ID":"EMP_002","Email":"coomeriise@mcehassan.ac.in","Name":"Dr. Mohana Lakshmi J"},
    {"User_ID":"USR_008","Username":"stapley", "Password":"changeme123","Designation":"TBI Manager",         "Employee_ID":"EMP_008","Email":"imtbimeriise@mcehassan.ac.in","Name":"Mr. Stapley V S"},
    {"User_ID":"USR_007","Username":"megha",   "Password":"changeme123","Designation":"Programme Associate/Outreach officer","Employee_ID":"EMP_007","Email":"patbimeriise@mcehassan.ac.in","Name":"Ms. Megha H M"},
    {"User_ID":"USR_003","Username":"darsha",  "Password":"changeme123","Designation":"Software Associate",  "Employee_ID":"EMP_003","Email":"satbimeriise@mcehassan.ac.in","Name":"Mr. Darshan H D"},
    {"User_ID":"USR_004","Username":"ramya",   "Password":"changeme123","Designation":"Finance Associate",   "Employee_ID":"EMP_004","Email":"fatbimeriise@mcehassan.ac.in","Name":"Miss. Ramya K V"},
    {"User_ID":"USR_005","Username":"madhurya","Password":"changeme123","Designation":"Innovation Associate","Employee_ID":"EMP_005","Email":"iatbimeriise@mcehassan.ac.in","Name":"Ms. Madhurya H V"},
    {"User_ID":"USR_006","Username":"deeksha", "Password":"changeme123","Designation":"Support Staff",    "Employee_ID":"EMP_006","Email":"sstbimeriise@mcehassan.ac.in","Name":"Ms. Deeksha M S"}
  ]);

  DB._setLocal('tasks', [
    {"Task_ID":"TSK_20260604_367924","Employee_ID":"EMP_003","Task_Title":"Registration Form","Description":"Design a Professional Events Registration form for all programs ( NAIN 2.0, TBI-MCE, MRF, UBA ,RGEP , IIC )","Priority":"High","Assigned_Date":"2026-05-21","Deadline":"2026-06-04","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_850917","Employee_ID":"EMP_003","Task_Title":"Certificate Generate - Achal to give access to certify files. Schedule meeting with Achal + CEO","Description":"Achal to give a access to certify files. Schedule meeting with Achal + CEO to plan and complete updates","Priority":"High","Assigned_Date":"2026-05-21","Deadline":"2026-06-04","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_353294","Employee_ID":"EMP_003","Task_Title":"Prepare a Task Scheduler with admin access to ceomeriise@mcehassan.ac.in","Description":"It must go live from June 1. It can be a separate web page. Later we can integrate with meriise.org","Priority":"High","Assigned_Date":"2026-06-04","Deadline":"2026-06-04","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_640267","Employee_ID":"EMP_003","Task_Title":"Get a tab meriise.org exclusive for courses","Description":"1. Fundamentals of MATLAB - Under Microengineering. 2. Web Designing, Power BI & Elevate from concept to create through Innovation DTP - Under MSME. 3. Excel Essentials - General. 4.DSA - Under MicroEngineering","Priority":"High","Assigned_Date":"2026-06-04","Deadline":"2026-06-04","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_149014","Employee_ID":"EMP_004","Task_Title":"Complete the verification and updation of ME-RIISE FOUNDATION Event file","Description":"","Priority":"High","Assigned_Date":"2026-06-04","Deadline":"2026-06-04","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_850189","Employee_ID":"EMP_004","Task_Title":"Talk to Mona and prepare a Budget for office supplies under TBI","Description":"A list is prepared by Deeksha, get it from her","Priority":"High","Assigned_Date":"2026-06-04","Deadline":"2026-06-04","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_829081","Employee_ID":"EMP_004","Task_Title":"Take the bill file of NAIN 2.0 and update the UC annextures","Description":"Also front page of UC is to be done. Take guidance from Mona and complete it.","Priority":"High","Assigned_Date":"2026-06-04","Deadline":"2026-06-04","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_392279","Employee_ID":"EMP_005","Task_Title":"Updating website with event details (regular). End-to-end documentation for all events.","Description":"Update Ignite Idea to Proto 4.0","Priority":"High","Assigned_Date":"2026-06-04","Deadline":"2026-06-04","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_942678","Employee_ID":"EMP_005","Task_Title":"Show scanned folder of all events (Apr 2025–Apr 2026) and update TBI file","Description":"Show scanned folder of all events for ME-RIISE, NAIN 2.0, RGEP. TBI file: Update complete recruitment details.","Priority":"High","Assigned_Date":"2026-06-04","Deadline":"2026-06-04","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_786349","Employee_ID":"EMP_005","Task_Title":"Prepare event report of Innovation Catalyst.","Description":"","Priority":"High","Assigned_Date":"2026-06-04","Deadline":"2026-06-04","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_785897","Employee_ID":"EMP_005","Task_Title":"Update the 2nd session of DSA course documents. Ignite Idea to Proto 4.0.","Description":"","Priority":"High","Assigned_Date":"2026-06-04","Deadline":"2026-06-04","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_330988","Employee_ID":"EMP_005","Task_Title":"Prepare report and filing of documents as per checklist by 3:00 pm.","Description":"Get filing done by Deeksha. Needs to be completed and reviewed by Mona by 11 am.","Priority":"High","Assigned_Date":"2026-06-04","Deadline":"2026-06-04","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_049742","Employee_ID":"EMP_006","Task_Title":"Keep log book outside immediately after coming.","Description":"Daily Task","Priority":"Medium","Assigned_Date":"2026-06-04","Deadline":"2026-06-30","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_754978","Employee_ID":"EMP_006","Task_Title":"Keep movement register immediately after coming.","Description":"Daily Tasks","Priority":"Medium","Assigned_Date":"2026-06-04","Deadline":"2026-06-30","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_692604","Employee_ID":"EMP_006","Task_Title":"Scan official documents/letters; update in Drive and mail.","Description":"Daily Tasks","Priority":"Medium","Assigned_Date":"2026-06-04","Deadline":"2026-06-30","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_211322","Employee_ID":"EMP_006","Task_Title":"Write from-and-to register for all documents and letters.","Description":"Daily Tasks","Priority":"Medium","Assigned_Date":"2026-06-04","Deadline":"2026-06-30","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_452394","Employee_ID":"EMP_006","Task_Title":"Check for charge in all laptops.","Description":"Daily Tasks","Priority":"Medium","Assigned_Date":"2026-06-04","Deadline":"2026-06-30","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_677348","Employee_ID":"EMP_006","Task_Title":"Complete scanning and updation of events.","Description":"Complete scanning and updation of events. Ensure all prepared documents are uploaded to Drive.","Priority":"Medium","Assigned_Date":"2026-06-04","Deadline":"2026-06-04","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""},
    {"Task_ID":"TSK_20260604_018465","Employee_ID":"EMP_006","Task_Title":"DSA – Microengineering file to be prepared.","Description":"Add flyer, registration details, curriculum, week 1 details. Take details from Darshan. Get reviewed by Mona.","Priority":"Medium","Assigned_Date":"2026-06-04","Deadline":"2026-06-04","Status":"Pending","Days_Pending":0,"Assigned_By":"Dr. Geetha Kiran A","File_URL":"","Notes":""}
  ]);

  DB._setLocal('approvals', []);
  DB._setLocal('notifications', []);
  DB._setLocal('attendance', []);
  localStorage.setItem('tbi_initialized', '1');
}

// ── Auth ──────────────────────────────────────────────────────
const Auth = {
  SESSION_KEY: 'tbi_session',
  getSession()    { try { return JSON.parse(sessionStorage.getItem(this.SESSION_KEY) || 'null'); } catch { return null; } },
  setSession(u)   { sessionStorage.setItem(this.SESSION_KEY, JSON.stringify({user_id:u.User_ID, username:u.Username, name:u.Name, designation:u.Designation, employee_id:u.Employee_ID, email:u.Email})); },
  isLoggedIn()    { return !!this.getSession(); },
  isAdmin()       { const s = this.getSession(); return s && ADMIN_ROLES.includes(s.designation); },
  // Server verifies the bcrypt hash and returns a user record with no password.
  // Falls back to a local compare only in offline/file:// dev mode.
  async login(username, password) {
    if (SERVER_MODE) {
      try {
        const r = await API.login(username, password);
        if (r && r.ok && r.user) {
          this.setSession(r.user);
          Attendance.recordLogin(r.user.Employee_ID);
          return true;
        }
        return false;
      } catch (err) {
        console.error('[TBI] login request failed', err);
        return false;
      }
    }
    // Dev fallback (file://): seed stores a placeholder Password.
    const user = DB.findOne('users', 'Username', username);
    if (user && user.Password === password) {
      this.setSession(user);
      Attendance.recordLogin(user.Employee_ID);
      return true;
    }
    return false;
  },
  logout() { sessionStorage.removeItem(this.SESSION_KEY); window.location.href = rootPath() + 'index.html'; },
  require() {
    if (!this.isLoggedIn()) { window.location.href = rootPath() + 'index.html'; return false; }
    return true;
  },
  requireAdmin() {
    if (!this.require()) return false;
    if (!this.isAdmin()) { window.location.href = rootPath() + 'employee/dashboard.html'; return false; }
    return true;
  },
};

// ── Attendance (check-in / check-out) ─────────────────────────
const Attendance = {
  _dateStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); },
  _stamp()   { const d = new Date(); return this._dateStr() + ' ' + d.toTimeString().slice(0,8); },
  getToday(empId) {
    const date = this._dateStr();
    return DB.getAll('attendance').find(a => a.Employee_ID === empId && a.Date === date) || null;
  },
  _ensure(empId) {
    let rec = this.getToday(empId);
    if (!rec) {
      rec = { Attendance_ID: Utils.generateId('ATT'), Employee_ID: empId, Date: this._dateStr(), Login_Time: '', Check_In: '', Check_Out: '' };
      DB.append('attendance', rec);
    }
    return rec;
  },
  recordLogin(empId) {
    if (!empId) return;
    const rec = this._ensure(empId);
    if (!rec.Login_Time) DB.updateById('attendance', 'Attendance_ID', rec.Attendance_ID, { Login_Time: this._stamp() });
  },
  checkIn(empId) {
    const rec = this._ensure(empId);
    if (!rec.Check_In) DB.updateById('attendance', 'Attendance_ID', rec.Attendance_ID, { Check_In: this._stamp() });
    return this.getToday(empId);
  },
  checkOut(empId) {
    const rec = this._ensure(empId);
    DB.updateById('attendance', 'Attendance_ID', rec.Attendance_ID, { Check_Out: this._stamp() });
    return this.getToday(empId);
  },
  // Returns "Xh Ym" worked between check-in and check-out, or '—'
  workedHours(rec) {
    if (!rec || !rec.Check_In || !rec.Check_Out) return '—';
    const ms = new Date(rec.Check_Out.replace(' ', 'T')) - new Date(rec.Check_In.replace(' ', 'T'));
    if (ms <= 0) return '—';
    return `${Math.floor(ms/3600000)}h ${Math.floor(ms%3600000/60000)}m`;
  },
};

// ── Theme Management ─────────────────────────────────────────
const Theme = {
  THEMES: ['ocean', 'forest', 'sunset', 'purple', 'rose', 'black', 'white'],
  STORAGE_KEY: 'tbi_theme',
  getTheme() { return localStorage.getItem(this.STORAGE_KEY) || 'ocean'; },
  setTheme(theme) {
    if (!this.THEMES.includes(theme)) theme = 'ocean';
    localStorage.setItem(this.STORAGE_KEY, theme);
    document.documentElement.setAttribute('data-theme', theme);
  },
  initTheme() { this.setTheme(this.getTheme()); },
};

// ── Utilities ─────────────────────────────────────────────────
const Utils = {
  esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  },
  formatDate(date) {
    if (!date) return '—';
    // Space-separated "YYYY-MM-DD HH:MM:SS" stamps need the T for Safari.
    try { return new Date(String(date).replace(' ', 'T')).toLocaleDateString('en-GB', {day:'2-digit', month:'short', year:'numeric'}); }
    catch { return date; }
  },
  // "2026-07-06 14:35:00" → "06 Jul 2026, 2:35 PM"; date-only values show just the date.
  formatDateTime(dt) {
    if (!dt) return '—';
    const s = String(dt);
    const hasTime = /\d{2}:\d{2}/.test(s.slice(10));
    if (!hasTime) return this.formatDate(s);
    try {
      const d = new Date(s.replace(' ', 'T'));
      return d.toLocaleDateString('en-GB', {day:'2-digit', month:'short', year:'numeric'}) + ', ' +
             d.toLocaleTimeString('en-IN', {hour:'numeric', minute:'2-digit', hour12:true});
    } catch { return s; }
  },
  // Local "YYYY-MM-DD HH:MM:SS" timestamp (toISOString would shift to UTC).
  nowStamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },
  today() { return new Date().toISOString().split('T')[0]; },
  daysPending(deadline) {
    if (!deadline) return 0;
    const now = new Date(); now.setHours(0,0,0,0);
    const dl  = new Date(deadline); dl.setHours(0,0,0,0);
    return now > dl ? Math.floor((now - dl) / 86400000) : 0;
  },
  isOverdue(deadline, status) {
    if (['Approved','Completed','Rejected'].includes(status)) return false;
    return this.daysPending(deadline) > 0;
  },
  daysBetween(from, to) {
    if (!from || !to) return null;
    const a = new Date(String(from).replace(' ', 'T')); a.setHours(0,0,0,0);
    const b = new Date(String(to).replace(' ', 'T'));   b.setHours(0,0,0,0);
    if (isNaN(a) || isNaN(b)) return null;
    return Math.max(0, Math.round((b - a) / 86400000));
  },
  priorityBadge(p) {
    const map = {High:'danger', Medium:'warning', Low:'success'};
    return `<span class="badge bg-${map[p]||'secondary'}">${this.esc(p)}</span>`;
  },
  statusBadge(s) {
    const map = {'Pending':'secondary','In Progress':'primary','Completed':'info','Approved':'success','Rejected':'danger'};
    return `<span class="badge bg-${map[s]||'secondary'}">${this.esc(s)}</span>`;
  },
  generateId(prefix) {
    const d = new Date();
    const date = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const rand = Math.random().toString(36).substr(2,6).toUpperCase();
    return `${prefix.toUpperCase()}_${date}_${rand}`;
  },
  initials(name) { return (name||'U').split(' ').map(w=>w[0]?.toUpperCase()||'').join('').slice(0,2) || 'U'; },
  // Read a picked image file and return a small, compressed JPEG data URL. Done
  // entirely client-side (canvas) so no upload server is needed — the result is
  // stored in Photo_URL and syncs like any other field. Capped in size so the
  // dataset stays small.
  readImageResized(file, maxDim = 320, quality = 0.82) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('No file selected.'));
      if (!file.type || !file.type.startsWith('image/')) return reject(new Error('Please choose an image file.'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('That file is not a valid image.'));
        img.onload = () => {
          let { width, height } = img;
          if (width >= height && width > maxDim)      { height = Math.round(height * maxDim / width);  width = maxDim; }
          else if (height > width && height > maxDim) { width  = Math.round(width  * maxDim / height); height = maxDim; }
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          try { resolve(canvas.toDataURL('image/jpeg', quality)); }
          catch (e) { reject(new Error('Could not process the image.')); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  },
  employeeStats(tasks, employeeId) {
    const mine      = tasks.filter(t => t.Employee_ID === employeeId);
    const total     = mine.length;
    const completed = mine.filter(t => ['Completed','Approved'].includes(t.Status)).length;
    const approved  = mine.filter(t => t.Status === 'Approved').length;
    const pending   = mine.filter(t => ['Pending','In Progress'].includes(t.Status)).length;
    const rejected  = mine.filter(t => t.Status === 'Rejected').length;
    const overdue   = mine.filter(t => this.isOverdue(t.Deadline, t.Status)).length;
    const approvalPct   = total > 0 ? Math.round((approved / total) * 100) : 0;
    const completionPct = total > 0 ? Math.round((completed / total) * 100) : 0;
    return {total, completed, approved, pending, rejected, overdue, approvalPct, completionPct};
  },
  pctColor(pct) { return pct >= 70 ? 'success' : pct >= 40 ? 'warning' : 'danger'; },
  desigIcon(d) {
    return {'CEO':'bi-person-badge-fill','COO':'bi-person-workspace','TBI Manager':'bi-briefcase-fill','Software Associate':'bi-code-slash',
            'Finance Associate':'bi-currency-rupee','Innovation Associate':'bi-lightbulb'}[d] || 'bi-person';
  },
  // "On Leave" pill for an employee record (empty string when active)
  leaveBadge(emp) {
    return emp && emp.Status === 'On Leave'
      ? '<span class="badge bg-warning text-dark"><i class="bi bi-umbrella me-1"></i>On Leave</span>' : '';
  },
};

// Dr. Geetha Kiran A (CEO) is the head of the organisation and the admin —
// she is not listed alongside staff in employee views, rankings or analytics.
function staffOnly(employees) {
  return (employees || []).filter(e => e.Designation !== 'CEO');
}

// ── Root path ─────────────────────────────────────────────────
function rootPath() {
  const p = window.location.pathname;
  return (p.includes('/admin/') || p.includes('/employee/')) ? '../' : '';
}

// ── Flash ─────────────────────────────────────────────────────
function setFlash(type, msg) { sessionStorage.setItem('tbi_flash', JSON.stringify({type, msg})); }
function getFlash() {
  const f = sessionStorage.getItem('tbi_flash');
  if (f) { sessionStorage.removeItem('tbi_flash'); return JSON.parse(f); }
  return null;
}
function showFlash(type, msg) {
  const area = document.getElementById('flashArea');
  if (!area) return;
  const t = type === 'error' ? 'danger' : type;
  area.innerHTML = `<div class="alert alert-${t} alert-dismissible fade show mb-0">${Utils.esc(msg)}<button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>`;
  setTimeout(() => area.querySelector('.btn-close')?.click(), 5000);
}

// ── Completion-date backfill ──────────────────────────────────
// Tasks completed before completion-date tracking existed have no
// Completed_Date. Derive it once from the matching approval submission date
// (when the task was actually submitted); fall back to the deadline so
// month-wise and "Completed Days" views are never blank. Idempotent.
function backfillCompletedDates() {
  const submittedBy = {};
  DB.getAll('approvals').forEach(a => {
    const d = (a.Submission_Date || a.Approval_Date || '').slice(0, 10);
    if (!d) return;
    if (!submittedBy[a.Task_ID] || d < submittedBy[a.Task_ID]) submittedBy[a.Task_ID] = d;
  });
  DB.getAll('tasks').forEach(t => {
    if (!['Completed','Approved'].includes(t.Status)) return;
    if (t.Completed_Date) return;
    const date = submittedBy[t.Task_ID] || (t.Deadline || '').slice(0, 10);
    if (date) DB.updateById('tasks', 'Task_ID', t.Task_ID, { Completed_Date: date });
  });
}

// ── Sidebar & Topbar rendering ────────────────────────────────
function renderShell(title, requireAdmin = false) {
  hideBootLoader();   // first paint is happening — drop the startup spinner
  seedIfNeeded();
  if (requireAdmin ? !Auth.requireAdmin() : !Auth.require()) return false;

  const session = Auth.getSession();
  const root    = rootPath();
  const isAdm   = Auth.isAdmin();
  const curPage = window.location.pathname.split('/').pop();
  const curDir  = window.location.pathname.includes('/admin/') ? 'admin' : window.location.pathname.includes('/employee/') ? 'employee' : '';
  const act = (dir, page) => curDir === dir && curPage === page ? 'active' : '';

  const pendingApprovals = DB.getAll('approvals').filter(a => a.Status === 'Pending').length;
  const aprBadge = pendingApprovals > 0 ? `<span class="nav-badge">${pendingApprovals}</span>` : '';

  const taskActive = (curDir === 'admin' && (curPage === 'tasks.html' || curPage === 'create_task.html')) ? 'active' : '';

  const nav = isAdm ? `
    <div class="sidebar-section">Main</div>
    <a href="${root}admin/dashboard.html" class="${act('admin','dashboard.html')}"><i class="bi bi-grid-fill"></i> Dashboard</a>
    <a href="${root}admin/tasks.html" class="${taskActive}"><i class="bi bi-list-task"></i> Task Management</a>
    <a href="${root}admin/employees.html" class="${act('admin','employees.html')}"><i class="bi bi-people-fill"></i> Employees</a>
    <a href="${root}admin/approvals.html" class="${act('admin','approvals.html')}"><i class="bi bi-check2-circle"></i> Approvals ${aprBadge}</a>
    <a href="${root}admin/attendance.html" class="${act('admin','attendance.html')}"><i class="bi bi-clock-history"></i> Attendance</a>
    <div class="sidebar-section">Reports</div>
    <a href="${root}admin/monthly.html" class="${act('admin','monthly.html')}"><i class="bi bi-calendar3"></i> Monthly View</a>
    <a href="${root}admin/analytics.html" class="${act('admin','analytics.html')}"><i class="bi bi-bar-chart-fill"></i> Analytics</a>
    <a href="${root}admin/reports.html" class="${act('admin','reports.html')}"><i class="bi bi-file-earmark-bar-graph-fill"></i> Reports</a>
  ` : `
    <div class="sidebar-section">My Workspace</div>
    <a href="${root}employee/dashboard.html" class="${act('employee','dashboard.html')}"><i class="bi bi-grid-fill"></i> Dashboard</a>
    <a href="${root}employee/tasks.html" class="${act('employee','tasks.html')}"><i class="bi bi-list-task"></i> My Tasks</a>
    <a href="${root}employee/profile.html" class="${act('employee','profile.html')}"><i class="bi bi-person-fill"></i> Profile</a>
  `;

  document.getElementById('sidebarContainer').innerHTML = `
    <aside class="tbi-sidebar" id="sidebar">
      <a class="sidebar-brand" href="${root}${isAdm?'admin':'employee'}/dashboard.html">
        <img src="${root}assets/images/logo.svg" alt="ME-RIISE FOUNDATION" onerror="this.style.display='none'">
        <div><div class="sb-title">ME-RIISE FOUNDATION</div><div class="sb-sub">ME-RIISE FOUNDATION Tasks</div></div>
      </a>
      <nav class="sidebar-nav">${nav}</nav>
      <div class="sidebar-user">
        <div class="su-avatar">${(session.name||'U')[0].toUpperCase()}</div>
        <div class="su-info">
          <div class="su-name">${Utils.esc(session.name)}</div>
          <div class="su-role">${Utils.esc(session.designation)}</div>
        </div>
        <a href="#" class="su-logout" title="Change Password" onclick="openChangePassword();return false;"><i class="bi bi-key"></i></a>
        <a href="#" class="su-logout" title="Logout" onclick="Auth.logout();return false;"><i class="bi bi-box-arrow-right"></i></a>
      </div>
    </aside>
    <div class="sidebar-overlay" id="sidebarOverlay"></div>
  `;

  ensureChangePasswordModal();

  document.getElementById('topbarContainer').innerHTML = `
    <header class="tbi-topbar">
      <button class="topbar-toggle" id="sidebarToggle"><i class="bi bi-list"></i></button>
      <div class="topbar-title">${Utils.esc(title)}</div>
      <div class="topbar-actions">
        <div class="dropdown">
          <a class="notif-btn" href="#" data-bs-toggle="dropdown" title="Theme">
            <i class="bi bi-palette"></i>
          </a>
          <ul class="dropdown-menu dropdown-menu-end p-2" style="min-width:160px">
            <li><div class="dropdown-header small">Select Theme</div></li>
            <li><button class="dropdown-item small" onclick="setTheme('ocean')"><span class="theme-dot" style="background:#00d4ff"></span> Ocean</button></li>
            <li><button class="dropdown-item small" onclick="setTheme('forest')"><span class="theme-dot" style="background:#10b981"></span> Forest</button></li>
            <li><button class="dropdown-item small" onclick="setTheme('sunset')"><span class="theme-dot" style="background:#f97316"></span> Sunset</button></li>
            <li><button class="dropdown-item small" onclick="setTheme('purple')"><span class="theme-dot" style="background:#a78bfa"></span> Purple</button></li>
            <li><button class="dropdown-item small" onclick="setTheme('rose')"><span class="theme-dot" style="background:#ec4899"></span> Rose</button></li>
            <li><hr class="dropdown-divider my-1"></li>
            <li><button class="dropdown-item small" onclick="setTheme('black')"><span class="theme-dot" style="background:#000000;border:1px solid #666"></span> Black</button></li>
            <li><button class="dropdown-item small" onclick="setTheme('white')"><span class="theme-dot" style="background:#ffffff;border:1px solid #999"></span> White</button></li>
          </ul>
        </div>
        <div class="dropdown">
          <a class="notif-btn" href="#" data-bs-toggle="dropdown" id="notifBell" aria-label="Notifications">
            <i class="bi bi-bell"></i>
            <span class="notif-count d-none" id="notifBadge">0</span>
          </a>
          <ul class="dropdown-menu dropdown-menu-end notif-dropdown p-1" style="min-width:310px">
            <li><div class="dropdown-header">Notifications</div></li>
            <li id="notifList"><div class="dropdown-item-text text-center py-2">Loading…</div></li>
          </ul>
        </div>
      </div>
    </header>
    <div class="flash-area" id="flashArea"></div>
  `;

  // Sidebar toggle
  document.getElementById('sidebarToggle')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('open');
    document.getElementById('sidebarOverlay')?.classList.toggle('active');
  });
  document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebarOverlay')?.classList.remove('active');
  });

  // Flash
  const flash = getFlash();
  if (flash) showFlash(flash.type, flash.msg);

  // Notifications
  loadNotifications();
  setInterval(loadNotifications, 60000);

  // Chart defaults
  if (typeof Chart !== 'undefined') {
    Chart.defaults.color = 'rgba(180,220,255,0.80)';
    Chart.defaults.borderColor = 'rgba(255,255,255,0.08)';
    Chart.defaults.font.family = "'Inter', -apple-system, sans-serif";
    Chart.defaults.font.size = 12;
    if (Chart.defaults.plugins?.legend) Chart.defaults.plugins.legend.labels = {color:'rgba(180,220,255,0.80)',boxWidth:12,padding:10};
    if (Chart.defaults.plugins?.tooltip) Object.assign(Chart.defaults.plugins.tooltip, {backgroundColor:'rgba(5,16,40,0.95)',titleColor:'#e8f4ff',bodyColor:'rgba(180,220,255,0.80)',borderColor:'rgba(255,255,255,0.10)',borderWidth:1,padding:10,cornerRadius:10});
    if (Chart.defaults.scale) { Chart.defaults.scale.grid = {color:'rgba(255,255,255,0.06)'}; Chart.defaults.scale.ticks = {color:'rgba(180,220,255,0.65)'}; }
  }

  return true;
}

// ── Change Password (self-service, any logged-in user) ────────
// Injected once into the shell so the logged-in user — including admins like the
// CEO who have no Profile page — can change their own password. The current
// password is verified server-side against the bcrypt hash.
function ensureChangePasswordModal() {
  if (document.getElementById('changePwdModal')) return;
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="modal fade" id="changePwdModal" tabindex="-1" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title"><i class="bi bi-shield-lock me-2"></i>Change Password</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <div id="cpwdAlert"></div>
            <div class="mb-3">
              <label class="form-label small">Current Password</label>
              <input type="password" class="form-control" id="cpwdCurrent" autocomplete="current-password" required>
            </div>
            <div class="mb-3">
              <label class="form-label small">New Password</label>
              <input type="password" class="form-control" id="cpwdNew" minlength="8" autocomplete="new-password" required>
            </div>
            <div class="mb-1">
              <label class="form-label small">Confirm New Password</label>
              <input type="password" class="form-control" id="cpwdConfirm" minlength="8" autocomplete="new-password" required>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
            <button type="button" class="btn btn-primary" onclick="submitChangePassword()">Update Password</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el.firstElementChild);
}

function openChangePassword() {
  ensureChangePasswordModal();
  const ids = ['cpwdAlert','cpwdCurrent','cpwdNew','cpwdConfirm'];
  ids.forEach(id => { const n = document.getElementById(id); if (n) n[id==='cpwdAlert'?'innerHTML':'value'] = ''; });
  bootstrap.Modal.getOrCreateInstance(document.getElementById('changePwdModal')).show();
}

async function submitChangePassword() {
  const session = Auth.getSession();
  const alertEl = document.getElementById('cpwdAlert');
  const current = document.getElementById('cpwdCurrent').value;
  const newPwd  = document.getElementById('cpwdNew').value;
  const confirm = document.getElementById('cpwdConfirm').value;
  const err = m => alertEl.innerHTML = `<div class="alert alert-danger py-2 small mb-3">${m}</div>`;

  if (!session || !session.username) return err('Your session has expired. Please log in again.');
  if (!current)                       return err('Enter your current password.');
  if (newPwd.length < 8)              return err('New password must be at least 8 characters.');
  if (newPwd !== confirm)             return err('New passwords do not match.');

  const r = await API.setPassword(session.username, newPwd, current);
  if (!r || !r.ok) return err((r && r.error) || 'Could not change password (server offline).');
  alertEl.innerHTML = `<div class="alert alert-success py-2 small mb-3">Password changed successfully.</div>`;
  document.getElementById('cpwdCurrent').value = '';
  document.getElementById('cpwdNew').value = '';
  document.getElementById('cpwdConfirm').value = '';
}

// ── Profile picture upload (shared) ───────────────────────────
// Resize the picked file to a small JPEG data URL, preview it, stash it in the
// hidden data field, and clear any pasted URL (an uploaded image wins). Stored
// in Photo_URL and synced like any other field — no upload server needed.
async function pickPhoto(fileId, previewId, dataId, urlId) {
  const fileEl = document.getElementById(fileId);
  const file   = fileEl && fileEl.files && fileEl.files[0];
  if (!file) return;
  try {
    const dataUrl = await Utils.readImageResized(file, 320, 0.82);
    const dataEl = document.getElementById(dataId);
    if (dataEl) dataEl.value = dataUrl;
    const prev = document.getElementById(previewId);
    if (prev) { prev.src = dataUrl; prev.style.display = ''; }
    if (urlId) { const u = document.getElementById(urlId); if (u) u.value = ''; }
  } catch (err) {
    alert(err.message || 'Could not load that image.');
    fileEl.value = '';
  }
}

// ── Notifications ─────────────────────────────────────────────
function loadNotifications() {
  const session = Auth.getSession();
  if (!session) return;
  const badge  = document.getElementById('notifBadge');
  const list   = document.getElementById('notifList');
  if (!badge || !list) return;

  const notifs = DB.findMany('notifications', 'User_ID', session.employee_id);
  const unread = notifs.filter(n => n.Read_Status === 'unread');

  if (unread.length > 0) { badge.textContent = unread.length > 9 ? '9+' : unread.length; badge.classList.remove('d-none'); }
  else { badge.classList.add('d-none'); }

  const recent = notifs.slice(-10).reverse();
  if (!recent.length) {
    list.innerHTML = '<div class="dropdown-item-text text-center py-2">No new notifications</div>';
  } else {
    list.innerHTML = recent.map(n => `
      <li><a class="dropdown-item small py-2 ${n.Read_Status==='unread'?'fw-600':''}" href="#" onclick="markNotifRead('${n.Notif_ID}',this);return false;">
        <div class="mb-1">${Utils.esc(n.Message)}</div>
        <div style="font-size:.68rem;opacity:.6">${Utils.esc(Utils.formatDate(n.Created_At))}</div>
      </a></li>
    `).join('<li><hr class="dropdown-divider my-1"></li>');
  }
}
function markNotifRead(id, el) {
  DB.updateById('notifications', 'Notif_ID', id, {Read_Status:'read'});
  el?.classList.remove('fw-600');
  loadNotifications();
}

// ── Delete task ───────────────────────────────────────────────
async function confirmDelete(taskId) {
  if (!confirm('Delete this task? This cannot be undone.')) return;
  DB.deleteById('tasks', 'Task_ID', taskId);
  DB.getAll('approvals').filter(a => a.Task_ID === taskId).forEach(a => DB.deleteById('approvals', 'Approval_ID', a.Approval_ID));
  setFlash('success', 'Task deleted.');
  await API.flush();
  location.reload();
}

// ── Export Excel ──────────────────────────────────────────────
function exportTableExcel(tableId, filename) {
  const table = document.getElementById(tableId);
  if (!table) { alert('Table not found'); return; }
  if (typeof XLSX === 'undefined') { alert('Excel library not loaded'); return; }

  const clonedTable = table.cloneNode(true);
  const includeActions = document.getElementById('exportActionsToggle')?.checked ?? true;

  if (!includeActions) {
    const rows = clonedTable.querySelectorAll('thead tr, tbody tr');
    rows.forEach(row => {
      const cells = row.querySelectorAll('th, td');
      if (cells.length > 0) cells[cells.length - 1].remove();
    });
  }

  // Convert the table to rows, then prepend the branded heading
  const tableWs  = XLSX.utils.table_to_sheet(clonedTable);
  const tableAoa = XLSX.utils.sheet_to_json(tableWs, {header:1});
  const headRows = excelHeaderRows(filename.replace(/_/g,' '));
  const ws = XLSX.utils.aoa_to_sheet([...headRows, ...tableAoa]);

  const ncols = Math.max(1, ...tableAoa.map(r => r.length));
  const hdrRow = headRows.length;            // first table row = column header (the <thead>)

  xlStyleBrandHeader(ws, ncols);
  xlStyleRow(ws, hdrRow, ncols, xlBordered(XL.colHdr));
  for (let r = hdrRow + 1; r < headRows.length + tableAoa.length; r++) {
    const odd = (r - hdrRow) % 2 === 0;       // zebra striping
    xlStyleRow(ws, r, ncols, xlBordered(odd ? XL.cellAlt : XL.cell));
  }
  ws['!cols'] = ws['!cols'] || Array.from({length: ncols}, (_, i) => ({ wch: i === 1 ? 34 : 16 }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  XLSX.writeFile(wb, filename + '_' + Utils.today() + '.xlsx');
}

// ── Export PDF ────────────────────────────────────────────────
function exportTablePDF(tableId, title) {
  const table = document.getElementById(tableId);
  if (!table || typeof jspdf === 'undefined') { alert('PDF library not loaded'); return; }

  const clonedTable = table.cloneNode(true);
  const includeActions = document.getElementById('exportActionsToggle')?.checked ?? true;

  if (!includeActions) {
    const rows = clonedTable.querySelectorAll('thead tr, tbody tr');
    rows.forEach(row => {
      const cells = row.querySelectorAll('th, td');
      if (cells.length > 0) cells[cells.length - 1].remove();
    });
  }

  const {jsPDF} = jspdf;
  const doc = new jsPDF({orientation:'landscape', unit:'mm', format:'a4'});
  const startY = pdfHeader(doc, title);
  doc.autoTable({html:clonedTable, startY, styles:{fontSize:8,cellPadding:2}, headStyles:{fillColor:[10,50,100],textColor:255,fontStyle:'bold'}, alternateRowStyles:{fillColor:[235,244,255]}});
  doc.save(title.replace(/\s+/g,'_') + '_' + Utils.today() + '.pdf');
}

// ── Shared PDF/Excel branding header ──────────────────────────
const ORG_TITLE    = 'ME-RIISE FOUNDATION';
const ORG_SUBTITLE = '(A Section 8 Company)  ·  Elevating Ideas, Incubating Success';

// Draws the branded heading on a jsPDF doc and returns the Y to start the table at
function pdfHeader(doc, title) {
  const w = doc.internal.pageSize.getWidth();
  doc.setFontSize(14); doc.setTextColor(0,100,180);
  doc.text(ORG_TITLE, w/2, 14, {align:'center'});
  doc.setFontSize(9); doc.setTextColor(90,120,150);
  doc.text(ORG_SUBTITLE, w/2, 20, {align:'center'});
  doc.setDrawColor(0,150,200); doc.setLineWidth(0.4); doc.line(15, 23, w-15, 23);
  doc.setFontSize(11); doc.setTextColor(50,100,150); doc.text(title, 15, 30);
  doc.setFontSize(8); doc.setTextColor(120); doc.text('Generated: ' + new Date().toLocaleString('en-IN'), 15, 35);
  return 39;
}

// Returns the org heading rows for an Excel AOA (array-of-arrays)
function excelHeaderRows(title) {
  return [[ORG_TITLE], [ORG_SUBTITLE], [title], ['Generated: ' + new Date().toLocaleString('en-IN')], []];
}

// ── Excel styling palette (requires xlsx-js-style) ────────────
const XL = {
  border: { top:{style:'thin',color:{rgb:'D6E2EE'}}, bottom:{style:'thin',color:{rgb:'D6E2EE'}}, left:{style:'thin',color:{rgb:'D6E2EE'}}, right:{style:'thin',color:{rgb:'D6E2EE'}} },
  orgTitle:  { font:{bold:true, sz:16, color:{rgb:'0A3260'}}, alignment:{horizontal:'center', vertical:'center'} },
  orgSub:    { font:{italic:true, sz:10, color:{rgb:'5A7896'}}, alignment:{horizontal:'center'} },
  reportTtl: { font:{bold:true, sz:12, color:{rgb:'1F6FB2'}}, alignment:{horizontal:'center'} },
  generated: { font:{italic:true, sz:9, color:{rgb:'8A8A8A'}}, alignment:{horizontal:'center'} },
  groupHdr:  { font:{bold:true, sz:11, color:{rgb:'FFFFFF'}}, fill:{fgColor:{rgb:'0E7C66'}}, alignment:{vertical:'center'} },
  colHdr:    { font:{bold:true, sz:10, color:{rgb:'FFFFFF'}}, fill:{fgColor:{rgb:'0A3260'}}, alignment:{horizontal:'center', vertical:'center', wrapText:true} },
  cell:      { font:{sz:10, color:{rgb:'21303F'}}, alignment:{vertical:'top', wrapText:true} },
  cellAlt:   { font:{sz:10, color:{rgb:'21303F'}}, fill:{fgColor:{rgb:'EAF3FB'}}, alignment:{vertical:'top', wrapText:true} },
};
// Add borders to a base style object
function xlBordered(base) { return { ...base, border: XL.border }; }
// Apply a style to a whole row of `ncols` cells at row index r
function xlStyleRow(ws, r, ncols, style) {
  for (let c = 0; c < ncols; c++) {
    const addr = XLSX.utils.encode_cell({ r, c });
    if (!ws[addr]) ws[addr] = { t: 's', v: '' };
    ws[addr].s = style;
  }
}
// Style the 4 branded heading rows (org title, subtitle, report title, generated) + merge them across ncols
function xlStyleBrandHeader(ws, ncols) {
  const last = ncols - 1;
  ws['!merges'] = ws['!merges'] || [];
  [0,1,2,3].forEach(r => ws['!merges'].push({ s:{r,c:0}, e:{r,c:last} }));
  if (ws['A1']) ws['A1'].s = XL.orgTitle;
  if (ws['A2']) ws['A2'].s = XL.orgSub;
  if (ws['A3']) ws['A3'].s = XL.reportTtl;
  if (ws['A4']) ws['A4'].s = XL.generated;
  ws['!rows'] = ws['!rows'] || [];
  ws['!rows'][0] = { hpt: 24 };
}

// ── Theme setter ──────────────────────────────────────────────
function setTheme(theme) {
  Theme.setTheme(theme);
  showFlash('success', 'Theme changed to ' + theme.charAt(0).toUpperCase() + theme.slice(1) + '.');
}

// ── URL params helper ─────────────────────────────────────────
function getParams() { return new URLSearchParams(window.location.search); }
