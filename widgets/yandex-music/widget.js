const $ = (id) => document.getElementById(id);
const card = $('card');
const coverBox = document.querySelector('.cover');

let filter = /yandex/i;
let fallbackToAny = false;
let session = null;                 // выбранная медиа-сессия
let base = { pos: 0, at: 0 };       // позиция, сообщённая помощником, и момент получения
let shownThumb = null;

const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

// Берём сессию Яндекс Музыки; если играет несколько — ту, что сейчас играет
function pickSession({ current, sessions }) {
  const matched = sessions.filter((s) => filter.test(s.app));
  const pool = matched.length ? matched : fallbackToAny ? sessions : [];
  return pool.find((s) => s.status === 'Playing') || pool.find((s) => s.id === current) || pool[0] || null;
}

// Средний насыщенный цвет обложки для акцента (кнопка, прогресс)
function accentFrom(img) {
  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  let r = 0, g = 0, b = 0, weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    const w = (max - min) / 255 * (max / 255) + 0.01; // насыщенные и яркие пиксели важнее
    r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; weight += w;
  }
  return readableAccent(r / weight, g / weight, b / weight);
}

// Оттенок берём из обложки, а яркость и насыщенность ограничиваем: акцент должен читаться
// на тёмной карточке, а тёмный значок на кнопке — на самом акценте (иначе на тёмной обложке кнопка «пропадает»)
function readableAccent(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = Math.round(((h * 60) + 360) % 360);
  const l = (max + min) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return `hsl(${h}, ${Math.round(clamp(s, 0.35, 0.85) * 100)}%, ${Math.round(clamp(l, 0.6, 0.74) * 100)}%)`;
}

function setCover(thumb) {
  if (thumb === shownThumb) return;
  shownThumb = thumb;
  const img = $('cover');
  if (!thumb) {
    coverBox.classList.remove('has-image');
    $('backdrop').style.backgroundImage = '';
    document.documentElement.style.removeProperty('--accent');
    return;
  }
  img.onload = () => {
    coverBox.classList.add('has-image');
    document.documentElement.style.setProperty('--accent', accentFrom(img));
  };
  img.src = thumb;
  $('backdrop').style.backgroundImage = `url("${thumb}")`;
}

function render(s) {
  session = s;
  const state = !s ? 'idle' : s.status === 'Playing' ? 'playing' : 'paused';
  card.dataset.state = state;

  $('title').textContent = s ? s.title || 'Без названия' : 'Ничего не играет';
  $('artist').textContent = s ? s.artist || s.album || '' : 'Запустите Яндекс Музыку';
  $('dur').textContent = fmt(s && s.dur);
  setCover(s && s.thumb);

  base = { pos: s ? s.pos : 0, at: performance.now() };
  $('prev').disabled = !s || !s.canPrev;
  $('next').disabled = !s || !s.canNext;
  $('toggle').disabled = !s || !s.canPlayPause;
  tick();
}

// Между сообщениями помощника (раз в секунду) двигаем прогресс сами
function tick() {
  if (!session) {
    $('pos').textContent = fmt(0);
    $('fill').style.width = '0%';
    return;
  }
  const elapsed = session.status === 'Playing' ? (performance.now() - base.at) / 1000 : 0;
  const pos = Math.min(base.pos + elapsed, session.dur || Infinity);
  $('pos').textContent = fmt(pos);
  $('fill').style.width = session.dur > 0 ? `${(pos / session.dur) * 100}%` : '0%';
}

function control(cmd) {
  if (!session) return;
  deskwidgets.media.control(cmd, session.id);
  // Мгновенный отклик, не дожидаясь следующего опроса
  if (cmd === 'playpause') {
    session = { ...session, status: session.status === 'Playing' ? 'Paused' : 'Playing' };
    base = { pos: base.pos + (card.dataset.state === 'playing' ? (performance.now() - base.at) / 1000 : 0), at: performance.now() };
    card.dataset.state = session.status === 'Playing' ? 'playing' : 'paused';
  }
}

$('prev').addEventListener('click', () => control('prev'));
$('next').addEventListener('click', () => control('next'));
$('toggle').addEventListener('click', () => control('playpause'));

(async () => {
  const info = await deskwidgets.getInfo();
  if (info) {
    if (info.config.sourceFilter) filter = new RegExp(info.config.sourceFilter, 'i');
    fallbackToAny = !!info.config.fallbackToAny;
  }
  deskwidgets.media.subscribe((state) => render(pickSession(state)));
  setInterval(tick, 250);
})();
