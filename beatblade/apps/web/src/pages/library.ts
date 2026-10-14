// 2D-Seite (mobil zuerst): Upload mit Fortschritt, Bibliothek mit Live-Status, Bearbeiten, Credits.
import '../style.css';
import { DIFFICULTY_LABEL, type Song } from '@beatblade/core';
import { api, subscribe, STATUS_LABEL, playable, fmtTime, BASE } from '../api';
import { BUILD_INFO } from '../version';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

let songs = new Map<string, Song>();
const dlg = $<HTMLDialogElement>('dlg');
$('build').textContent = BUILD_INFO;

// ---------- Start / Login ----------
async function boot() {
  const info = await api.info().catch(() => null);
  if (info) $('maxmb').textContent = String(info.maxUploadMb);
  if (info?.authMode === 'password' && !info.loggedIn) { $('login').hidden = false; return; }
  showTab(location.hash === '#credits' ? 'credits' : 'lib');
  await load();
  subscribe({ song: upsert, deleted: (id) => { songs.delete(id); render(); }, open: () => load() });
}
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api.login($<HTMLInputElement>('pw').value); $('login').hidden = true; boot(); }
  catch (err) { $('login-err').textContent = (err as Error).message; }
});

function showTab(t: 'lib' | 'credits') {
  $('lib').hidden = t !== 'lib'; $('credits').hidden = t !== 'credits';
  document.querySelectorAll<HTMLAnchorElement>('nav.tabs a[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === t));
  if (t === 'credits') loadCredits();
}
document.querySelectorAll<HTMLAnchorElement>('nav.tabs a[data-tab]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); history.replaceState(null, '', a.dataset.tab === 'credits' ? '#credits' : '#'); showTab(a.dataset.tab as 'lib' | 'credits'); }));

async function load() {
  try { songs = new Map((await api.songs()).map((s) => [s.id, s])); render(); }
  catch (e) { if ((e as { status?: number }).status === 401) location.reload(); }
}
function upsert(s: Song) { songs.set(s.id, s); render(); }

// ---------- Upload ----------
const drop = $('drop'), input = $<HTMLInputElement>('file');
$('pick').addEventListener('click', () => input.click());
input.addEventListener('change', () => { uploadAll([...(input.files ?? [])]); input.value = ''; });
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', (e) => uploadAll([...((e as DragEvent).dataTransfer?.files ?? [])]));

async function uploadAll(files: File[]) {
  // 2 parallel, Rest wartet
  const queue = files.slice();
  const worker = async () => { for (let f = queue.shift(); f; f = queue.shift()) await uploadOne(f); };
  await Promise.all([worker(), worker()]);
}

async function uploadOne(file: File) {
  const row = document.createElement('div'); row.className = 'up';
  row.innerHTML = `<div class="name">${esc(file.name)}</div><div class="st hint">Hochladen …</div><div class="bar"><i></i></div>`;
  $('uploads').prepend(row);
  const bar = row.querySelector<HTMLElement>('.bar i')!, st = row.querySelector<HTMLElement>('.st')!;
  try {
    const r = await api.upload(file, (p) => { bar.style.width = `${Math.round(p * 100)}%`; });
    const res = r.results[0];
    if (res?.error) throw new Error(res.error);
    bar.style.width = '100%';
    if (res?.song) {
      upsert(res.song);
      st.textContent = res.duplicate ? 'Schon vorhanden' : 'Hochgeladen – wird verarbeitet';
      row.dataset.song = res.song.id;
      // Status der Verarbeitung in der Zeile mitlaufen lassen
      const tick = () => {
        const s = songs.get(res.song!.id); if (!s) return;
        st.textContent = s.status === 'ready' ? 'Fertig ✓' : s.status === 'error' ? `Fehler: ${s.error}` : `${STATUS_LABEL[s.status]} ${Math.round(s.progress * 100)} %`;
        st.style.color = s.status === 'ready' ? 'var(--ok)' : s.status === 'error' ? 'var(--err)' : '';
        if (s.status !== 'ready' && s.status !== 'error') setTimeout(tick, 500); else setTimeout(() => row.remove(), s.status === 'ready' ? 8000 : 30000);
      };
      tick();
    }
  } catch (e) {
    st.textContent = (e as Error).message; st.style.color = 'var(--err)'; bar.style.background = 'var(--err)';
  }
}

// ---------- Bibliothek ----------
for (const id of ['q', 'sort', 'filter']) $(id).addEventListener('input', render);

function render() {
  const q = $<HTMLInputElement>('q').value.trim().toLowerCase();
  const sort = $<HTMLSelectElement>('sort').value, filter = $<HTMLSelectElement>('filter').value;
  let list = [...songs.values()].filter((s) =>
    filter === 'hidden' ? s.hidden : filter === 'bundled' ? s.bundled && !s.hidden : filter === 'uploaded' ? !s.bundled : !s.hidden);
  if (q) list = list.filter((s) => `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(q));
  const cmp: Record<string, (a: Song, b: Song) => number> = {
    new: (a, b) => b.createdAt - a.createdAt, title: (a, b) => a.title.localeCompare(b.title, 'de'),
    artist: (a, b) => a.artist.localeCompare(b.artist, 'de') || a.title.localeCompare(b.title, 'de'), bpm: (a, b) => (a.bpm ?? 999) - (b.bpm ?? 999),
  };
  list.sort(cmp[sort]);
  const box = $('songs');
  if (!list.length) { box.innerHTML = `<div class="empty">${songs.size ? 'Nichts gefunden.' : 'Noch keine Songs – lade oben welche hoch.'}</div>`; return; }
  box.innerHTML = list.map(card).join('');
}

function card(s: Song): string {
  const cover = api.coverUrl(s);
  const busy = !['ready', 'error', 'outdated'].includes(s.status);
  const st = s.status === 'ready' ? '' : `<span class="pill ${s.status === 'error' ? 'err' : 'run'}">${STATUS_LABEL[s.status]}${busy ? ` ${Math.round(s.progress * 100)} %` : ''}</span>`;
  return `<div class="song" data-id="${s.id}">
    ${cover ? `<img class="cover" src="${cover}" alt="" loading="lazy" />` : '<div class="cover">♪</div>'}
    <div style="min-width:0">
      <div class="t">${esc(s.title)}</div>
      <div class="m"><span>${esc(s.artist || 'Unbekannt')}</span><span>${fmtTime(s.duration)}</span>${s.bpm ? `<span>${Math.round(s.bpm)} BPM</span>` : ''}
        ${s.bundled ? '<span class="pill bundled">Mitgeliefert</span>' : ''}${s.hidden ? '<span class="pill">Ausgeblendet</span>' : ''}${st}</div>
      ${s.difficulties.length ? `<div class="diffs">${s.difficulties.map((d) => `<span>${DIFFICULTY_LABEL[d]}</span>`).join('')}</div>` : ''}
      ${busy ? `<div class="prog"><i style="width:${Math.round(s.progress * 100)}%"></i></div>` : ''}
      ${s.status === 'error' ? `<div class="hint" style="color:var(--err)">${esc(s.error ?? '')}</div>` : ''}
    </div>
    <div class="actions">
      ${playable(s) ? `<a href="${BASE}/play.html?song=${s.id}"><button class="primary">Spielen</button></a>` : ''}
      ${s.status === 'error' ? `<button data-a="retry">Erneut versuchen</button>` : ''}
      <button data-a="edit">Bearbeiten</button>
      <button data-a="more">⋯</button>
    </div>
  </div>`;
}

$('songs').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button'); if (!b?.dataset.a) return;
  const id = b.closest<HTMLElement>('.song')!.dataset.id!, s = songs.get(id)!;
  if (b.dataset.a === 'edit') editDialog(s);
  else if (b.dataset.a === 'more') moreDialog(s);
  else if (b.dataset.a === 'retry') api.regenerate(id, { reanalyze: true, seed: s.seed }).then(upsert);
});

function editDialog(s: Song) {
  dlg.innerHTML = `<h3>Bearbeiten</h3><form class="form" method="dialog">
    <label>Titel <input name="title" value="${esc(s.title)}" maxlength="200" required /></label>
    <label>Artist <input name="artist" value="${esc(s.artist)}" maxlength="200" /></label>
    <label>Album <input name="album" value="${esc(s.album)}" maxlength="200" /></label>
    <label>Cover (JPG/PNG/WebP) <input name="cover" type="file" accept="image/jpeg,image/png,image/webp" /></label>
    <div class="row"><button value="cancel" formnovalidate>Abbrechen</button><button class="primary" value="save">Speichern</button></div></form>`;
  dlg.showModal();
  dlg.querySelector('form')!.addEventListener('submit', async (e) => {
    const sub = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    if (sub?.value !== 'save') return;
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    try {
      let n = await api.patch(s.id, { title: String(f.get('title')), artist: String(f.get('artist')), album: String(f.get('album')) });
      const c = f.get('cover') as File | null;
      if (c && c.size) n = await api.setCover(s.id, c);
      upsert(n); dlg.close();
    } catch (err) { alert((err as Error).message); }
  });
}

async function moreDialog(s: Song) {
  dlg.innerHTML = `<h3>${esc(s.title)}</h3>
    <p class="hint">Seed ${s.seed} · ${s.bpm ? `${s.bpm} BPM` : 'BPM unbekannt'} · ${s.fileName ? esc(s.fileName) : ''}</p>
    ${s.license ? `<p class="hint">Lizenz: ${esc(s.license)}${s.source ? ` · <a href="${esc(s.source)}" target="_blank" rel="noopener">Quelle</a>` : ''}</p>` : ''}
    <div class="row" style="justify-content:flex-start">
      <button data-a="regen">Neu generieren (neuer Seed)</button>
      <button data-a="reanalyze">Neu analysieren</button>
      <a href="${BASE}/debug.html?song=${s.id}"><button>Debug-Ansicht</button></a>
      <button data-a="hide">${s.hidden ? 'Einblenden' : 'Ausblenden'}</button>
      ${s.bundled ? '' : '<button data-a="delete" class="danger">Löschen</button>'}
    </div>
    <h4>Job-Log</h4><pre class="log" id="joblog">Lade …</pre>
    <div class="row"><button data-a="close">Schließen</button></div>`;
  dlg.showModal();
  api.log(s.id).then((l) => { const el = dlg.querySelector('#joblog'); if (el) el.textContent = l.map((x) => `${new Date(x.at).toLocaleTimeString('de-DE')} ${x.level === 'info' ? '' : x.level.toUpperCase() + ' '}${x.msg}`).join('\n') || '–'; });
  dlg.onclick = async (e) => {
    const b = (e.target as HTMLElement).closest('button'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'close') dlg.close();
    else if (a === 'regen') { upsert(await api.regenerate(s.id)); dlg.close(); }
    else if (a === 'reanalyze') { upsert(await api.regenerate(s.id, { reanalyze: true, seed: s.seed })); dlg.close(); }
    else if (a === 'hide') { upsert(await api.patch(s.id, { hidden: !s.hidden })); dlg.close(); }
    else if (a === 'delete') {
      if (!confirm(`„${s.title}“ wirklich löschen? Audio, Levels und Highscores werden entfernt.`)) return;
      await api.remove(s.id); songs.delete(s.id); render(); dlg.close();
    }
  };
}

async function loadCredits() {
  const list = await api.credits().catch(() => []);
  $('credit-list').innerHTML = list.length ? list.map((c) => `<li><strong>${esc(c.title)}</strong> – ${esc(c.artist)}${c.genre ? ` <span class="hint">(${esc(c.genre)})</span>` : ''}<br>
    <span class="hint">${esc(c.attribution)}</span><br><a href="${esc(c.licenseUrl)}" target="_blank" rel="noopener">${esc(c.license)}</a> · <a href="${esc(c.source)}" target="_blank" rel="noopener">Quelle</a></li>`).join('')
    : '<li class="hint">Keine mitgelieferten Songs.</li>';
}

boot();
