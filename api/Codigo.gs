/**
 * API Producción — Groppe Imprenta
 *
 * Puente entre HubSpot/Zapier y la app de producción (Firebase).
 *   POST  accion=etapa      Zapier avisa que un negocio cambió de etapa en HubSpot.
 *   GET   accion=orden      Estado de producción de una orden (por idDm o item).
 *   GET   accion=ordenes    Todas las órdenes, o solo las que cambiaron desde una fecha.
 *   GET   accion=propiedades  Lista de propiedades que maneja la integración.
 *   GET   accion=ping       Prueba de conexión.
 *
 * Autenticación: parámetro `key` (en el link o en el body JSON). Apps Script no puede leer
 * headers HTTP, por eso la key no va en un header.
 *
 * Las API keys viven en Propiedades del script (API_KEYS), nunca en este código.
 * Para crearlas, ejecuta crearClaves() una vez desde el editor.
 *
 * Acceso a Firebase: con la cuenta de quien publica el script (debe ser dueño o editor del
 * proyecto imprenta-10c73), sin secretos guardados.
 */
const FB = 'https://imprenta-10c73-default-rtdb.firebaseio.com';

function doGet(e) { return responder_(e, 'GET'); }
function doPost(e) { return responder_(e, 'POST'); }

function responder_(e, metodo) {
  try {
    const p = parametros_(e);
    const quien = autenticar_(p.key);
    if (!quien) return json_({ ok: false, error: 'API key inválida o faltante', codigo: 401 });
    delete p.key;
    const accion = String(p.accion || p.action || (metodo === 'POST' ? 'etapa' : 'ping')).toLowerCase();

    if (accion === 'ping') return json_({ ok: true, mensaje: 'API Producción funcionando', cliente: quien, hora: new Date().toISOString() });
    if (accion === 'propiedades') return json_({ ok: true, propiedades: PROPIEDADES });
    if (accion === 'etapa') {
      if (metodo !== 'POST') return json_({ ok: false, error: 'accion=etapa se manda por POST', codigo: 405 });
      return json_(recibirEtapa_(p, quien));
    }
    if (accion === 'orden') return json_(consultarOrden_(p));
    if (accion === 'ordenes') return json_(consultarOrdenes_(p));
    return json_({ ok: false, error: 'accion desconocida: ' + accion, codigo: 400 });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: String(err.message || err), codigo: 500 });
  }
}

// ── Recibir cambio de etapa (HubSpot → Zapier → aquí) ──────────────────────────
function recibirEtapa_(p, quien) {
  const idDm = texto_(p.idDm || p.id_dm || p.ID_DM);
  const item = texto_(p.item || p.folio);
  const etapa = texto_(p.etapa || p.dealstage || p.stage);
  if (!idDm && !item) return { ok: false, error: 'Falta idDm (o item) para identificar la orden', codigo: 400 };
  if (!etapa) return { ok: false, error: 'Falta etapa', codigo: 400 };

  // Todo lo demás que mande Zapier se guarda tal cual en "propiedades".
  const propiedades = {};
  Object.keys(p).forEach(k => {
    if (['accion', 'action', 'idDm', 'id_dm', 'ID_DM', 'item', 'folio', 'etapa', 'dealstage', 'stage', 'dealId', 'deal_id', 'pipeline'].indexOf(k) >= 0) return;
    propiedades[llave_(k)] = p[k];
  });
  const registro = {
    idDm: idDm, item: item, etapa: etapa,
    dealId: texto_(p.dealId || p.deal_id), pipeline: texto_(p.pipeline),
    propiedades: propiedades, recibido: new Date().toISOString(), fuente: quien
  };
  const k = llave_(idDm || item);
  fb_('/api/hubspot/' + k, 'put', registro);
  fb_('/api/hubspotLog', 'post', registro);
  const enProduccion = buscar_(idDm, item);
  return { ok: true, guardado: registro, ordenEncontrada: enProduccion.length > 0, orden: enProduccion.length ? resumir_(enProduccion) : null };
}

// ── Consultas (nuestro sistema → HubSpot) ─────────────────────────────────────
function consultarOrden_(p) {
  const idDm = texto_(p.idDm || p.id_dm), item = texto_(p.item || p.folio);
  if (!idDm && !item) return { ok: false, error: 'Manda idDm o item', codigo: 400 };
  const partes = buscar_(idDm, item);
  const hs = fb_('/api/hubspot/' + llave_(idDm || item), 'get');
  if (!partes.length) return { ok: false, error: 'Orden no encontrada en producción', codigo: 404, hubspot: hs };
  return { ok: true, orden: resumir_(partes), hubspot: hs };
}

function consultarOrdenes_(p) {
  const todo = fb_('/api/estado', 'get') || {};
  let desde = p.desde ? (isNaN(+p.desde) ? Date.parse(p.desde) : +p.desde) : 0;
  if (isNaN(desde)) return { ok: false, error: 'desde inválido (usa fecha ISO o milisegundos)', codigo: 400 };
  const soloActivas = String(p.soloActivas || p.activas || '') === 'true';
  // Agrupa las tarjetas (interior/portada/etc.) del mismo pedido.
  const grupos = {};
  Object.keys(todo).forEach(k => {
    const t = todo[k];
    if (!t) return;
    const g = t.idDm || t.grupo || t.id;
    (grupos[g] = grupos[g] || []).push(t);
  });
  let lista = Object.keys(grupos).map(g => resumir_(grupos[g]))
    .filter(o => !desde || o.actualizado >= desde)
    .filter(o => !soloActivas || !o.listo);
  lista.sort((a, b) => b.actualizado - a.actualizado);
  const limite = Math.min(+p.limite || 500, 2000);
  return { ok: true, total: lista.length, ordenes: lista.slice(0, limite), hora: Date.now() };
}

function buscar_(idDm, item) {
  const todo = fb_('/api/estado', 'get') || {};
  return Object.keys(todo).map(k => todo[k]).filter(t => t &&
    ((idDm && String(t.idDm).toLowerCase() === idDm.toLowerCase()) ||
     (item && (String(t.grupo) === item || String(t.id) === item))));
}

const ORDEN_FASE = { impresion: 0, acabados: 1, empaque: 2, listo: 3 };

// Un pedido puede tener varias tarjetas (interior y portada). El estado del pedido es el de
// la parte más atrasada, y su fecha estimada la de la que termina al último.
function resumir_(partes) {
  const atras = partes.slice().sort((a, b) => (ORDEN_FASE[a.fase] ?? 9) - (ORDEN_FASE[b.fase] ?? 9))[0];
  const etas = partes.map(t => t.etaEstimada).filter(Boolean).sort();
  const listo = partes.every(t => t.listo);
  const enTiempo = partes.some(t => t.enTiempo === false) ? false : partes.every(t => t.enTiempo === true) ? true : null;
  return {
    idDm: atras.idDm || '', item: atras.grupo, titulo: atras.titulo, cliente: atras.cliente, cantidad: atras.cantidad,
    urgente: partes.some(t => t.urgente),
    fase: listo ? 'listo' : atras.fase, etapa: listo ? 'listo' : atras.etapa, etapaLabel: listo ? 'Listo' : atras.etapaLabel,
    fechaEntrega: atras.fechaEntrega, fechaCompromiso: atras.fechaCompromiso,
    etaEstimada: listo ? '' : (etas[etas.length - 1] || ''), enTiempo: enTiempo, listo: listo,
    actualizado: Math.max.apply(null, partes.map(t => t.actualizado || 0)),
    partes: partes.map(t => ({ id: t.id, fase: t.fase, etapa: t.etapa, etapaLabel: t.etapaLabel, etaEstimada: t.etaEstimada, listo: t.listo }))
  };
}

// ── Propiedades de la integración ─────────────────────────────────────────────
const PROPIEDADES = {
  entrada_desde_hubspot: {
    idDm: 'ID de Docket Manager del pedido (llave principal para emparejar)',
    item: 'Número de item/folio de producción (alternativa si no hay idDm)',
    etapa: 'Etapa del negocio en HubSpot (nombre o ID de la etapa)',
    dealId: 'ID del negocio en HubSpot (opcional)',
    pipeline: 'Pipeline de HubSpot (opcional)',
    '(otras)': 'Cualquier otro campo que mande Zapier se guarda en "propiedades"'
  },
  salida_hacia_hubspot: {
    idDm: 'ID de Docket Manager', item: 'Número de item/folio',
    titulo: 'Título del trabajo', cliente: 'Cliente', cantidad: 'Cantidad',
    urgente: 'true si es urgente',
    fase: 'impresion | acabados | empaque | listo',
    etapa: 'Etapa interna exacta (ej. acab_pg)', etapaLabel: 'Etapa legible (ej. Hotmelt)',
    fechaEntrega: 'Fecha de entrega pedida (AAAA-MM-DD)',
    fechaCompromiso: 'Fecha límite real: entrega + 3 días hábiles si no es urgente',
    etaEstimada: 'Fecha estimada en que queda lista según el motor (AAAA-MM-DD)',
    enTiempo: 'true si llega antes de la fecha compromiso, false si no, null si no hay estimado',
    listo: 'true cuando todas sus partes están listas',
    actualizado: 'Última vez que cambió (milisegundos desde 1970)'
  }
};

// ── Utilidades ────────────────────────────────────────────────────────────────
function parametros_(e) {
  const p = Object.assign({}, (e && e.parameter) || {});
  if (e && e.postData && e.postData.contents) {
    try { Object.assign(p, JSON.parse(e.postData.contents)); } catch (_) { /* era formulario, ya viene en e.parameter */ }
  }
  return p;
}
function autenticar_(key) {
  if (!key) return null;
  const claves = JSON.parse(PropertiesService.getScriptProperties().getProperty('API_KEYS') || '{}');
  return Object.keys(claves).find(n => claves[n] === String(key)) || null;
}
function fb_(ruta, metodo, cuerpo) {
  const opts = { method: metodo, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };
  if (cuerpo !== undefined) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(cuerpo); }
  const r = UrlFetchApp.fetch(FB + ruta + '.json', opts);
  if (r.getResponseCode() >= 300) throw new Error('Firebase ' + r.getResponseCode() + ': ' + r.getContentText());
  return JSON.parse(r.getContentText() || 'null');
}
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
const texto_ = v => (v === undefined || v === null) ? '' : String(v).trim();
const llave_ = s => String(s || '').trim().replace(/[.#$\[\]\/]/g, '_');

// ── Ejecutar a mano desde el editor ───────────────────────────────────────────
/** Crea (o reemplaza) las API keys de "hubspot" y "zapier" y las muestra en el registro. */
function crearClaves() {
  const nueva = () => (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const claves = { hubspot: nueva(), zapier: nueva() };
  PropertiesService.getScriptProperties().setProperty('API_KEYS', JSON.stringify(claves));
  console.log('Key para el equipo de HubSpot: ' + claves.hubspot);
  console.log('Key para Zapier: ' + claves.zapier);
}
/** Prueba que el script puede leer Firebase con tu cuenta. */
function probarFirebase() {
  const est = fb_('/api/estado', 'get') || {};
  console.log('OK — órdenes publicadas por la app: ' + Object.keys(est).length);
}
