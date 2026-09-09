/**
 * The panel, as one self-contained page.
 *
 * No build step, no framework, no CDN: the page is served by the same loopback process that
 * holds the token, and pulling in a third-party script would hand a remote party a page that can
 * edit connection files. The page reads the token out of the URL once and rewrites the address
 * bar immediately, so it does not sit in history or in a screenshot.
 */
export const PAGE = /* html */ `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SAP Fiori MCP — Conexiones</title>
<style>
  :root {
    --bg:#12141a; --panel:#1a1d26; --line:#2a2f3d; --ink:#e6e8ef; --dim:#949bb0;
    --accent:#6ea8fe; --ok:#4ec9a4; --bad:#ff7b72; --warn:#e3b341;
  }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui,Segoe UI,sans-serif }
  header { padding:18px 24px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:16px; flex-wrap:wrap }
  h1 { font-size:17px; margin:0; font-weight:600 }
  header .path { color:var(--dim); font-size:12px; font-family:ui-monospace,Consolas,monospace }
  main { padding:24px; max-width:1100px; margin:0 auto; display:grid; gap:24px }
  section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px }
  h2 { font-size:14px; margin:0 0 14px; font-weight:600; letter-spacing:.02em }
  table { width:100%; border-collapse:collapse }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top }
  th { color:var(--dim); font-weight:500; font-size:12px; text-transform:uppercase; letter-spacing:.05em }
  tr:last-child td { border-bottom:none }
  code, .mono { font-family:ui-monospace,Consolas,monospace; font-size:12.5px }
  .pill { display:inline-block; padding:1px 8px; border-radius:20px; font-size:11.5px; border:1px solid var(--line) }
  .ok { color:var(--ok); border-color:#25604f } .bad { color:var(--bad); border-color:#6b2d2a }
  .warn { color:var(--warn); border-color:#6b5620 } .dim { color:var(--dim) }
  button { font:inherit; background:#232734; color:var(--ink); border:1px solid var(--line); border-radius:7px; padding:5px 11px; cursor:pointer }
  button:hover { border-color:var(--accent) }
  button.primary { background:var(--accent); color:#0b1020; border-color:var(--accent); font-weight:600 }
  button.danger:hover { border-color:var(--bad); color:var(--bad) }
  input, select { font:inherit; background:#0f1219; color:var(--ink); border:1px solid var(--line); border-radius:7px; padding:6px 9px; width:100% }
  label { display:block; font-size:12px; color:var(--dim); margin-bottom:4px }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap }
  .hint { color:var(--dim); font-size:12px; margin-top:10px }
  .notice { border-left:3px solid var(--warn); background:#221d10; padding:10px 12px; border-radius:0 7px 7px 0; margin-bottom:14px; font-size:13px }
  .result { background:#0f1219; border:1px solid var(--line); border-radius:8px; padding:12px; margin-top:12px }
  .step { display:flex; gap:10px; align-items:baseline; padding:3px 0 }
  .verdict { margin-top:10px; padding-top:10px; border-top:1px solid var(--line) }
  dialog { background:var(--panel); color:var(--ink); border:1px solid var(--line); border-radius:12px; padding:20px; width:min(560px,92vw) }
  dialog::backdrop { background:rgba(0,0,0,.6) }
  .err { color:var(--bad); font-size:13px; min-height:18px; margin-top:8px }
</style>
</head>
<body>
<header>
  <h1>SAP Fiori MCP · Conexiones</h1>
  <span class="path" id="dataDir"></span>
</header>
<main>
  <section>
    <h2>Sistemas SAP</h2>
    <div id="sysWarn"></div>
    <table><thead><tr><th>Nombre</th><th>URL</th><th>Cliente</th><th>Usuario</th><th>Contraseña</th><th></th></tr></thead>
    <tbody id="systems"></tbody></table>
    <div class="row" style="margin-top:14px"><button class="primary" onclick="editSystem()">Añadir sistema</button></div>
    <p class="hint" id="sysFile"></p>
  </section>

  <section>
    <h2>Destinations BTP</h2>
    <table><thead><tr><th>Nombre</th><th>URL</th><th>Autenticación</th><th>Proxy</th><th>Secretos</th><th></th></tr></thead>
    <tbody id="destinations"></tbody></table>
    <div class="row" style="margin-top:14px"><button class="primary" onclick="editDest()">Añadir destination</button></div>
    <p class="hint" id="destDir"></p>
  </section>

  <section>
    <h2>Destination Service (nube)</h2>
    <div id="dsvc"></div>
    <p class="hint">Se configura con <code>BTP_SERVICE_KEY_FILE</code> apuntando al fichero de service key
      descargado del cockpit. No hace falta repartir sus campos en variables sueltas.</p>
  </section>

  <section>
    <h2>Probar una conexión</h2>
    <div class="grid">
      <div><label>Sistema</label><select id="testName"></select></div>
      <div style="grid-column:span 2"><label>Ruta de servicio (opcional)</label>
        <input id="testPath" class="mono" placeholder="/sap/opu/odata4/sap/zsb_x/srvd/sap/zsd_x/0001"></div>
    </div>
    <div class="row" style="margin-top:12px"><button class="primary" onclick="runTest()">Probar</button><span id="testing" class="dim"></span></div>
    <div id="testResult"></div>
  </section>
</main>

<dialog id="dlg"><form method="dialog" id="form">
  <h2 id="dlgTitle"></h2>
  <div class="grid">
    <div><label>Nombre</label><input id="f_name" required></div>
    <div style="grid-column:span 2"><label>URL</label><input id="f_url" class="mono" placeholder="https://host:44300" required></div>
    <div><label>Cliente</label><input id="f_client" placeholder="100"></div>
    <div><label>Usuario</label><input id="f_user"></div>
    <div id="wrap_auth" hidden><label>Autenticación</label><select id="f_auth">
      <option>NoAuthentication</option><option>BasicAuthentication</option>
      <option>OAuth2ClientCredentials</option><option>OAuth2UserTokenExchange</option><option>OAuth2JWTBearer</option>
    </select></div>
    <div id="wrap_proxy" hidden><label>ProxyType</label><select id="f_proxy"><option>Internet</option><option>OnPremise</option></select></div>
    <div style="grid-column:1/-1" id="wrap_key" hidden>
      <label>Service key (ruta al fichero JSON descargado del cockpit)</label>
      <div class="row"><input id="f_key" class="mono" placeholder="C:/Users/tu-usuario/Downloads/destination-key.json" style="flex:1">
      <button type="button" onclick="inspectKey()">Analizar</button></div>
      <div id="keyInfo" class="hint"></div>
    </div>
    <div style="grid-column:1/-1"><label>Contraseña — solo referencia a variable de entorno</label>
      <input id="f_pw" class="mono" placeholder="\${env:SAP_A4H_PASSWORD}"></div>
  </div>
  <p class="hint">Este panel nunca guarda ni transporta un secreto. Para Basic, escribe <code>\${env:NOMBRE}</code>.
  Para OAuth, indica la ruta de la <strong>service key</strong>: el fichero se queda donde está y solo se guarda su ruta,
  así el <code>clientsecret</code> no acaba en este destination.</p>
  <div class="err" id="formErr"></div>
  <div class="row" style="margin-top:14px; justify-content:flex-end">
    <button value="cancel">Cancelar</button><button class="primary" id="saveBtn" value="save">Guardar</button>
  </div>
</form></dialog>

<script>
const TOKEN = new URLSearchParams(location.search).get('token') || '';
history.replaceState(null, '', location.pathname);   // fuera de la barra, del historial y de las capturas

async function call(path, body) {
  const r = await fetch(path, { method:'POST', headers:{ 'content-type':'application/json', 'x-admin-token':TOKEN }, body:JSON.stringify(body||{}) });
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j.data;
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function pwCell(p) {
  if (p.kind === 'none') return '<span class="pill warn">sin definir</span>';
  if (p.kind === 'literal') return '<span class="pill bad">literal en el fichero</span>';
  return p.envRefs.map(r => '<span class="pill ' + (r.resolved ? 'ok' : 'bad') + '">\${env:' + esc(r.name) + (r.resolved ? '} ✓' : '} no definida') + '</span>').join(' ');
}

let STATE = { systems:{systems:[]}, destinations:{destinations:[]} };

async function refresh() {
  const r = await fetch('/api/state', { headers:{ 'x-admin-token':TOKEN } });
  STATE = (await r.json()).data;
  document.getElementById('dataDir').textContent = STATE.dataDir;
  document.getElementById('sysFile').textContent = 'Fichero: ' + STATE.systems.file;
  document.getElementById('destDir').textContent = 'Carpeta: ' + STATE.destinations.dir;

  const ds = STATE.destinationService || { configured:false, source:'', detail:'' };
  document.getElementById('dsvc').innerHTML =
    '<div class="step"><span class="pill ' + (ds.configured ? 'ok' : 'warn') + '">' +
    (ds.configured ? 'configurado' : 'sin configurar') + '</span><span>' + esc(ds.source) +
    (ds.detail ? '<br><span class="dim">' + esc(ds.detail) + '</span>' : '') + '</span></div>';

  document.getElementById('sysWarn').innerHTML = (STATE.warnings || [])
    .map(w => '<div class="notice">' + esc(w) + '</div>').join('');

  document.getElementById('systems').innerHTML = STATE.systems.systems.map((s, i) =>
    '<tr><td><strong>' + esc(s.name) + '</strong></td><td class="mono">' + esc(s.url) + '</td><td>' + esc(s.client || '—') +
    '</td><td>' + esc(s.user || '—') + '</td><td>' + pwCell(s.password) + '</td>' +
    '<td class="row"><button onclick="editSystem(' + i + ')">Editar</button>' +
    '<button class="danger" onclick="delSystem(\\'' + esc(s.name) + '\\')">Borrar</button></td></tr>').join('') ||
    '<tr><td colspan="6" class="dim">Ningún sistema configurado.</td></tr>';

  document.getElementById('destinations').innerHTML = STATE.destinations.destinations.map((d, i) => {
    const creds = d.serviceKey
      ? '<span class="pill ' + (d.serviceKey.ok ? 'ok' : 'bad') + '">service key</span>' +
        '<span class="sub">' + esc(d.serviceKey.detail) + '</span>'
      : (d.secrets.length
          ? d.secrets.map(x => '<span class="pill ' + (x.kind === 'literal' ? 'bad' : (x.envRefs.every(r => r.resolved) ? 'ok' : 'bad')) + '">' +
              esc(x.field) + (x.kind === 'literal' ? ' literal' : '') + '</span>').join(' ')
          : '<span class="dim">ninguna</span>');
    return '<tr><td><strong>' + esc(d.name) + '</strong>' +
      (d.proxyType && d.proxyType !== 'Internet' ? '<span class="sub">' + esc(d.proxyType) + '</span>' : '') +
      '</td><td class="url mono">' + esc(d.url) + '</td><td>' + esc(d.authType) + '</td><td>' + creds +
      '</td><td class="actions"><button onclick="editDest(' + i + ')">Editar</button>' +
      '<button class="danger" onclick="delDest(&quot;' + esc(d.name) + '&quot;)">Borrar</button></td></tr>';
  }).join('') || '<tr><td colspan="5" class="dim">Ningún destination configurado.</td></tr>';

  document.getElementById('testName').innerHTML = STATE.systems.systems.map(s => '<option>' + esc(s.name) + '</option>').join('');
}

let mode = 'system', previousName = null;
const $ = id => document.getElementById(id);

function openDlg(kind, item) {
  mode = kind; previousName = item ? item.name : null;
  $('dlgTitle').textContent = (item ? 'Editar ' : 'Añadir ') + (kind === 'system' ? 'sistema' : 'destination');
  $('f_name').value = item ? item.name : '';
  $('f_url').value = item ? item.url : '';
  $('f_client').value = item ? (item.client || '') : '';
  $('f_user').value = item ? (item.user || '') : '';
  $('f_pw').value = '';
  $('wrap_auth').hidden = kind === 'system';
  $('wrap_proxy').hidden = kind === 'system';
  $('wrap_key').hidden = kind === 'system';
  $('f_key').value = item && item.serviceKey ? item.serviceKey.path : '';
  $('keyInfo').innerHTML = '';
  if (kind === 'destination' && item) { $('f_auth').value = item.authType; $('f_proxy').value = item.proxyType || 'Internet'; }
  $('formErr').textContent = '';
  $('dlg').showModal();
}
const editSystem = i => openDlg('system', i === undefined ? null : STATE.systems.systems[i]);
const editDest = i => openDlg('destination', i === undefined ? null : STATE.destinations.destinations[i]);

$('form').addEventListener('submit', async (ev) => {
  if (ev.submitter && ev.submitter.value === 'cancel') return;
  ev.preventDefault();
  const body = { name:$('f_name').value.trim(), url:$('f_url').value.trim(), client:$('f_client').value.trim(),
                 user:$('f_user').value.trim(), password:$('f_pw').value.trim(), previousName:previousName || undefined };
  if (mode === 'destination') { body.authType = $('f_auth').value; body.proxyType = $('f_proxy').value; body.serviceKeyPath = $('f_key').value.trim(); }
  try {
    await call(mode === 'system' ? '/api/systems/save' : '/api/destinations/save', body);
    $('dlg').close(); await refresh();
  } catch (e) { $('formErr').textContent = e.message; }
});

async function inspectKey() {
  const path = $('f_key').value.trim();
  if (!path) return;
  $('keyInfo').textContent = 'leyendo…';
  try {
    const k = await call('/api/service-key/inspect', { path });
    const rows = [['tipo', k.kind], ['client id', k.clientId], ['secreto', k.clientSecret],
                  ['UAA (token)', k.tokenUrl], ['API destinations', k.apiUrl || '—'], ['endpoint', k.endpointUrl || '—'], ['system id', k.systemId || '—']];
    $('keyInfo').innerHTML = '<div class="result">' + rows.map(r =>
      '<div class="step"><span class="pill">' + r[0] + '</span><span class="mono">' + esc(r[1]) + '</span></div>').join('') +
      (k.kind === 'abap-environment' && !$('f_url').value ? '<div class="verdict">Se rellenará la URL con el endpoint de la key.</div>' : '') +
      '</div>';
    if (!$('f_url').value && k.endpointUrl) $('f_url').value = k.endpointUrl;
    if (k.kind !== 'xsuaa') $('f_auth').value = 'OAuth2ClientCredentials';
  } catch (e) { $('keyInfo').innerHTML = '<div class="err">' + esc(e.message) + '</div>'; }
}

async function delSystem(name) {
  if (!confirm('¿Borrar el sistema ' + name + '? Solo se borra la entrada de configuración.')) return;
  try { await call('/api/systems/delete', { name }); await refresh(); } catch (e) { alert(e.message); }
}
async function delDest(name) {
  if (!confirm('¿Borrar el destination ' + name + '? Se elimina su fichero.')) return;
  try { await call('/api/destinations/delete', { name }); await refresh(); } catch (e) { alert(e.message); }
}

async function runTest() {
  const name = $('testName').value;
  if (!name) return;
  $('testing').textContent = 'probando…'; $('testResult').innerHTML = '';
  try {
    const r = await call('/api/validate', { name, servicePath: $('testPath').value.trim() || undefined });
    const tls = r.tls.subject
      ? '<div class="step"><span class="pill ' + (r.tls.trusted ? 'ok' : 'warn') + '">TLS</span><span>' +
        (r.tls.trusted ? 'certificado de confianza' : 'certificado no verificable') +
        ' · CN=' + esc(r.tls.subject) + (r.tls.issuer ? ' · emisor ' + esc(r.tls.issuer) : '') + '</span></div>'
      : '';
    $('testResult').innerHTML = '<div class="result">' +
      (r.sapSystem ? '<div class="step"><span class="pill">sistema</span><span>' + esc(r.sapSystem) + (r.realm ? ' · ' + esc(r.realm) : '') + '</span></div>' : '') +
      tls +
      r.steps.map(s => '<div class="step"><span class="pill ' + (s.ok ? 'ok' : 'bad') + '">' + (s.status === null ? 'sin respuesta' : s.status) + '</span>' +
        '<span>' + esc(s.label) + ' <span class="dim mono">' + esc(s.path) + '</span>' +
        (s.detail ? '<br><span class="dim">' + esc(s.detail) + '</span>' : '') + '</span></div>').join('') +
      '<div class="verdict">' + esc(r.verdict) + '</div></div>';
  } catch (e) { $('testResult').innerHTML = '<div class="result bad">' + esc(e.message) + '</div>'; }
  $('testing').textContent = '';
}

refresh();
</script>
</body>
</html>`;
