// ===================================================
//  dbDraw — simulador visual de MongoDB (mongosh)
// ===================================================

// ---------- Estado simulado del servidor ----------
const SYSTEM_DBS = { admin: 40, config: 60, local: 72 }; // tamaños en KiB

const state = {
  current: 'test',
  dbs: {} // { nombreDb: { coleccion: [documentos] } }
};

// ---------- Utilidades ----------
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class ObjectId {
  constructor() {
    const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
    let rand = '';
    for (let i = 0; i < 16; i++) rand += Math.floor(Math.random() * 16).toString(16);
    this.hex = ts + rand;
  }
}

const getDb = (name = state.current) => state.dbs[name];
const getCollection = (coll) => getDb()?.[coll];

function ensureCollection(coll) {
  if (!state.dbs[state.current]) state.dbs[state.current] = {};
  if (!state.dbs[state.current][coll]) state.dbs[state.current][coll] = [];
  return state.dbs[state.current][coll];
}

// Literal JS para el comando que se muestra en la terminal
const literal = (v) => (typeof v === 'number' ? String(v) : JSON.stringify(v));

// Convierte un valor a texto con el formato que usa mongosh
function formatValue(value, indent = 0) {
  const inline = formatInline(value);
  if (inline.length + indent <= 72 || typeof value !== 'object' || value === null || value instanceof ObjectId) {
    return inline;
  }
  const pad = ' '.repeat(indent + 2);
  const end = ' '.repeat(indent);
  if (Array.isArray(value)) {
    return '[\n' + value.map((v) => pad + formatValue(v, indent + 2)).join(',\n') + '\n' + end + ']';
  }
  return (
    '{\n' +
    Object.entries(value)
      .map(([k, v]) => `${pad}${formatKey(k)}: ${formatValue(v, indent + 2)}`)
      .join(',\n') +
    '\n' + end + '}'
  );
}

function formatInline(value) {
  if (value instanceof ObjectId) return `ObjectId('${value.hex}')`;
  if (value === null) return 'null';
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (Array.isArray(value)) return value.length ? `[ ${value.map(formatInline).join(', ')} ]` : '[]';
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    return `{ ${entries.map(([k, v]) => `${formatKey(k)}: ${formatInline(v)}`).join(', ')} }`;
  }
  return String(value);
}

const formatKey = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`);

// ---------- Resaltado de sintaxis ----------
const TOKEN_RE =
  /(\/\/.*$)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)|(\$\w+)|(\b\d+(?:\.\d+)?\b)|(\b(?:use|show|db|true|false|null|ObjectId)\b)|(\.\w+(?=\())|(\b[A-Za-z_]\w*(?=\s*:))/gm;

function highlight(code) {
  let html = '';
  let last = 0;
  code.replace(TOKEN_RE, (match, comment, str, op, num, kw, method, key, offset) => {
    html += escapeHtml(code.slice(last, offset));
    const cls = comment ? 'comment' : str ? 'string' : op ? 'op' : num ? 'number'
      : kw ? 'kw' : method ? 'method' : 'key';
    html += `<span class="tok-${cls}">${escapeHtml(match)}</span>`;
    last = offset + match.length;
    return match;
  });
  return html + escapeHtml(code.slice(last));
}

// ---------- Definición de acciones ----------
const NAME = { pattern: '[A-Za-z0-9_\\-]+', title: 'Solo letras, números, guiones y _' };
const COLL = { pattern: '[A-Za-z_][A-Za-z0-9_]*', title: 'Empieza por letra o _, sin espacios', list: 'collectionList' };
const out = (text, type = 'out') => ({ text, type });

const groups = [
  {
    title: 'Base de datos',
    items: [
      {
        id: 'useDb', icon: '🗄️', label: 'Crear / usar DB',
        desc: 'En MongoDB no existe un "CREATE DATABASE": se usa "use" y la base se crea al guardar el primer dato.',
        fields: [{ name: 'db', label: 'Nombre de la base de datos', value: 'tienda', ...NAME }],
        run({ db }) {
          state.current = db;
          return {
            comments: ['// Cambia (o crea) la base de datos', '// Se guardará en disco al crear la primera colección'],
            cmd: `use ${db}`,
            output: [out(`switched to db ${db}`)]
          };
        }
      },
      {
        id: 'showDbs', icon: '📋', label: 'Ver bases de datos',
        run() {
          const rows = Object.entries(SYSTEM_DBS).map(([n, kb]) => [n, kb]);
          for (const [name, colls] of Object.entries(state.dbs)) {
            if (SYSTEM_DBS[name] || !Object.keys(colls).length) continue;
            const docs = Object.values(colls).reduce((s, c) => s + c.length, 0);
            rows.push([name, 8 + Object.keys(colls).length * 4 + docs * 0.25]);
          }
          rows.sort((a, b) => a[0].localeCompare(b[0]));
          const w = Math.max(...rows.map((r) => r[0].length)) + 2;
          return {
            comments: ['// Lista las bases de datos (las vacías no aparecen)'],
            cmd: 'show dbs',
            output: rows.map(([n, kb]) => out(n.padEnd(w) + kb.toFixed(2).padStart(6) + ' KiB'))
          };
        }
      },
      {
        id: 'dropDb', icon: '💣', label: 'Eliminar DB actual', danger: true,
        run() {
          const name = state.current;
          if (SYSTEM_DBS[name]) {
            return { cmd: 'db.dropDatabase()', output: [out(`MongoServerError: Cannot drop '${name}' database`, 'error')] };
          }
          const existed = !!state.dbs[name];
          delete state.dbs[name];
          return {
            comments: [`// Elimina la base de datos actual (${name}) y todas sus colecciones`],
            cmd: 'db.dropDatabase()',
            output: [out(formatValue(existed ? { ok: 1, dropped: name } : { ok: 1 }))]
          };
        }
      }
    ]
  },
  {
    title: 'Colecciones',
    items: [
      {
        id: 'createCollection', icon: '📁', label: 'Crear colección',
        desc: 'Una colección es el equivalente a una "tabla": agrupa documentos.',
        fields: [{ name: 'coll', label: 'Nombre de la colección', value: 'usuarios', ...COLL }],
        run({ coll }) {
          const cmd = `db.createCollection(${literal(coll)})`;
          if (getCollection(coll)) {
            return { cmd, output: [out(`MongoServerError: Collection ${state.current}.${coll} already exists.`, 'error')] };
          }
          ensureCollection(coll);
          return { comments: [`// Crea la colección "${coll}" en la DB "${state.current}"`], cmd, output: [out('{ ok: 1 }')] };
        }
      },
      {
        id: 'showCollections', icon: '📂', label: 'Ver colecciones',
        run() {
          const names = Object.keys(getDb() || {});
          return {
            comments: [`// Lista las colecciones de "${state.current}"`],
            cmd: 'show collections',
            output: names.length ? names.map((n) => out(n)) : [out('(no hay colecciones)', 'note')]
          };
        }
      },
      {
        id: 'dropCollection', icon: '🗑️', label: 'Eliminar colección', danger: true,
        fields: [{ name: 'coll', label: 'Colección a eliminar', value: 'usuarios', ...COLL }],
        run({ coll }) {
          const existed = !!getCollection(coll);
          if (existed) delete state.dbs[state.current][coll];
          return {
            comments: [`// Elimina la colección "${coll}" con todos sus documentos`],
            cmd: `db.${coll}.drop()`,
            output: [out(String(existed))]
          };
        }
      }
    ]
  },
  {
    title: 'Usuarios (documentos)',
    items: [
      {
        id: 'insertOne', icon: '➕', label: 'Crear usuario',
        desc: 'Inserta un documento. Si la colección no existe, MongoDB la crea automáticamente.',
        fields: [
          { name: 'coll', label: 'Colección', value: 'usuarios', ...COLL },
          { name: 'nombre', label: 'Nombre', value: 'Ana' },
          { name: 'email', label: 'Email', value: 'ana@mail.com', type: 'email' },
          { name: 'edad', label: 'Edad', value: '25', type: 'number', min: 0 }
        ],
        run({ coll, nombre, email, edad }) {
          const comments = ['// Inserta un documento (MongoDB genera el _id)'];
          if (!getCollection(coll)) comments.push(`// La colección "${coll}" no existía: se crea automáticamente`);
          const doc = { nombre, email, edad: Number(edad) };
          const _id = new ObjectId();
          ensureCollection(coll).push({ _id, ...doc });
          return {
            comments,
            cmd: `db.${coll}.insertOne(${formatCmdObj(doc)})`,
            output: [out(formatValue({ acknowledged: true, insertedId: _id }))]
          };
        }
      },
      {
        id: 'find', icon: '👥', label: 'Ver usuarios',
        fields: [{ name: 'coll', label: 'Colección', value: 'usuarios', ...COLL }],
        run({ coll }) {
          const docs = getCollection(coll) || [];
          return {
            comments: [`// Devuelve todos los documentos de "${coll}"`],
            cmd: `db.${coll}.find()`,
            output: [docs.length ? out(formatValue(docs)) : out('(sin resultados)', 'note')]
          };
        }
      },
      {
        id: 'findByName', icon: '🔍', label: 'Buscar usuario',
        fields: [
          { name: 'coll', label: 'Colección', value: 'usuarios', ...COLL },
          { name: 'nombre', label: 'Nombre a buscar', value: 'Ana' }
        ],
        run({ coll, nombre }) {
          const docs = (getCollection(coll) || []).filter((d) => d.nombre === nombre);
          return {
            comments: ['// Filtra documentos que cumplan la condición'],
            cmd: `db.${coll}.find(${formatCmdObj({ nombre })})`,
            output: [docs.length ? out(formatValue(docs)) : out('(sin resultados)', 'note')]
          };
        }
      },
      {
        id: 'updateOne', icon: '✏️', label: 'Actualizar usuario',
        fields: [
          { name: 'coll', label: 'Colección', value: 'usuarios', ...COLL },
          { name: 'nombre', label: 'Usuario a actualizar (nombre)', value: 'Ana' },
          { name: 'campo', label: 'Campo a modificar', options: ['nombre', 'email', 'edad'], value: 'edad' },
          { name: 'valor', label: 'Nuevo valor', value: '26' }
        ],
        run({ coll, nombre, campo, valor }) {
          const value = campo === 'edad' && valor.trim() !== '' && !isNaN(valor) ? Number(valor) : valor;
          const doc = (getCollection(coll) || []).find((d) => d.nombre === nombre);
          const modified = doc && doc[campo] !== value ? 1 : 0;
          if (doc) doc[campo] = value;
          return {
            comments: ['// Modifica el primer documento que coincida usando $set'],
            cmd: `db.${coll}.updateOne(${formatCmdObj({ nombre })}, { $set: ${formatCmdObj({ [campo]: value })} })`,
            output: [out(formatValue({
              acknowledged: true, insertedId: null,
              matchedCount: doc ? 1 : 0, modifiedCount: modified, upsertedCount: 0
            }))]
          };
        }
      },
      {
        id: 'deleteOne', icon: '❌', label: 'Eliminar usuario', danger: true,
        fields: [
          { name: 'coll', label: 'Colección', value: 'usuarios', ...COLL },
          { name: 'nombre', label: 'Usuario a eliminar (nombre)', value: 'Ana' }
        ],
        run({ coll, nombre }) {
          const docs = getCollection(coll) || [];
          const i = docs.findIndex((d) => d.nombre === nombre);
          if (i >= 0) docs.splice(i, 1);
          return {
            comments: ['// Elimina el primer documento que coincida'],
            cmd: `db.${coll}.deleteOne(${formatCmdObj({ nombre })})`,
            output: [out(formatValue({ acknowledged: true, deletedCount: i >= 0 ? 1 : 0 }))]
          };
        }
      },
      {
        id: 'count', icon: '🔢', label: 'Contar usuarios',
        fields: [{ name: 'coll', label: 'Colección', value: 'usuarios', ...COLL }],
        run({ coll }) {
          return {
            comments: [`// Cuenta los documentos de "${coll}"`],
            cmd: `db.${coll}.countDocuments()`,
            output: [out(String((getCollection(coll) || []).length))]
          };
        }
      }
    ]
  }
];

// Objeto tal como lo escribiría una persona en mongosh: { nombre: "Ana", edad: 25 }
function formatCmdObj(obj) {
  return `{ ${Object.entries(obj).map(([k, v]) => `${formatKey(k)}: ${literal(v)}`).join(', ')} }`;
}

// ---------- Terminal ----------
const term = $('#terminal');
let idleLine = null;
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch(console.error));

const scrollBottom = () => (term.scrollTop = term.scrollHeight);

function addLine(text, type, before = idleLine) {
  const div = document.createElement('div');
  div.className = `line ${type}`;
  div.innerHTML = type === 'note' || type === 'error' || type === 'banner' ? escapeHtml(text) : highlight(text);
  term.insertBefore(div, before);
  return div;
}

function newPrompt() {
  idleLine = document.createElement('div');
  idleLine.className = 'line cmd';
  idleLine.innerHTML = `<span class="prompt">${escapeHtml(state.current)}&gt; </span><span class="input"></span><span class="cursor"></span>`;
  term.appendChild(idleLine);
  scrollBottom();
}

function showBanner() {
  term.innerHTML = '';
  idleLine = null;
  addLine('Connecting to: mongodb://127.0.0.1:27017/?directConnection=true', 'banner', null);
  addLine('Using MongoDB: 7.0.12', 'banner', null);
  addLine('Using Mongosh: 2.2.10', 'banner', null);
  addLine('', 'banner', null);
  addLine('// Elige una opción a la izquierda para ver aquí su código MongoDB', 'out', null);
  addLine('', 'banner', null);
  newPrompt();
}

async function typeCommand(cmd) {
  const input = idleLine.querySelector('.input');
  const delay = Math.max(8, Math.min(30, 900 / cmd.length));
  for (let i = 1; i <= cmd.length; i++) {
    input.innerHTML = highlight(cmd.slice(0, i));
    if (i % 2 === 0) scrollBottom();
    await sleep(delay);
  }
}

function execute(action, values = {}) {
  enqueue(async () => {
    const result = action.run(values);
    for (const c of result.comments || []) addLine(c, 'out');
    scrollBottom();
    await typeCommand(result.cmd);
    await sleep(150);
    idleLine.querySelector('.cursor').remove();
    for (const o of result.output) addLine(o.text, o.type, null);
    addLine('', 'banner', null);
    renderSidebarState();
    newPrompt();
  });
}

// ---------- Interfaz gráfica ----------
const form = $('#actionForm');
const lastValues = {};
let currentAction = null;

function renderActions() {
  const container = $('#actions');
  for (const group of groups) {
    const g = document.createElement('div');
    g.className = 'group';
    g.innerHTML = `<h3>${group.title}</h3><div class="group-buttons"></div>`;
    for (const action of group.items) {
      const btn = document.createElement('button');
      btn.className = 'action-btn' + (action.danger ? ' danger' : '');
      btn.dataset.id = action.id;
      btn.innerHTML = `<span class="icon">${action.icon}</span><span>${action.label}</span>`;
      btn.addEventListener('click', () => selectAction(action));
      g.querySelector('.group-buttons').appendChild(btn);
    }
    container.appendChild(g);
  }
}

function selectAction(action) {
  document.querySelectorAll('.action-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === action.id));

  // Acciones sin parámetros se ejecutan directamente
  if (!action.fields) {
    closeForm();
    execute(action);
    return;
  }

  currentAction = action;
  $('#formTitle').textContent = `${action.icon} ${action.label}`;
  $('#formDesc').textContent = action.desc || '';
  $('#formDesc').hidden = !action.desc;

  const fields = $('#formFields');
  fields.innerHTML = '';
  for (const f of action.fields) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const id = `f-${f.name}`;
    const value = lastValues[f.name] ?? f.value ?? '';
    let control;
    if (f.options) {
      control = document.createElement('select');
      control.innerHTML = f.options.map((o) => `<option ${o === value ? 'selected' : ''}>${o}</option>`).join('');
    } else {
      control = document.createElement('input');
      control.type = f.type || 'text';
      control.value = value;
      if (f.pattern) control.pattern = f.pattern;
      if (f.title) control.title = f.title;
      if (f.list) control.setAttribute('list', f.list);
      if (f.min !== undefined) control.min = f.min;
    }
    control.id = id;
    control.name = f.name;
    control.required = true;
    control.autocomplete = 'off';
    wrap.innerHTML = `<label for="${id}">${f.label}</label>`;
    wrap.appendChild(control);
    fields.appendChild(wrap);
  }
  form.hidden = false;
  fields.querySelector('input, select')?.focus();
}

function closeForm() {
  form.hidden = true;
  currentAction = null;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!currentAction) return;
  const values = Object.fromEntries(new FormData(form));
  for (const [k, v] of Object.entries(values)) values[k] = v.trim();
  Object.assign(lastValues, values);
  execute(currentAction, values);
});

$('#formClose').addEventListener('click', () => {
  closeForm();
  document.querySelectorAll('.action-btn').forEach((b) => b.classList.remove('active'));
});

$('#clearTerminal').addEventListener('click', () => enqueue(showBanner));

// Explorador + DB actual + autocompletado de colecciones
function renderSidebarState() {
  $('#currentDb').textContent = state.current;

  const names = new Set(Object.keys(state.dbs).filter((n) => Object.keys(state.dbs[n]).length));
  names.add(state.current);

  const tree = $('#explorer');
  tree.innerHTML = '';
  for (const name of [...names].sort()) {
    const colls = state.dbs[name] || {};
    const li = document.createElement('li');
    const isCurrent = name === state.current;
    const collNames = Object.keys(colls);
    li.innerHTML =
      `<span class="db-name ${isCurrent ? 'current' : ''}">🗄️ ${escapeHtml(name)}</span>` +
      (collNames.length
        ? `<ul>${collNames.map((c) =>
            `<li>📁 ${escapeHtml(c)} <span class="count">(${colls[c].length} docs)</span></li>`).join('')}</ul>`
        : `<ul><li class="empty">${isCurrent ? 'vacía: aún no existe en disco' : 'vacía'}</li></ul>`);
    tree.appendChild(li);
  }

  $('#collectionList').innerHTML = Object.keys(getDb() || {})
    .map((c) => `<option value="${escapeHtml(c)}">`).join('');
}

// ---------- Inicio ----------
renderActions();
renderSidebarState();
showBanner();
