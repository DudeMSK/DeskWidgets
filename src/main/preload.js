// Мост между страницей виджета и приложением. Страница видит только window.deskwidgets.
const { contextBridge, ipcRenderer } = require('electron');

const MAX_THUMBS = 16;
const thumbs = new Map();
const mediaListeners = new Set();
let lastState = null;

function notifyMedia() {
  if (!lastState) return;
  const sessions = lastState.sessions.map((s) => ({ ...s, thumb: thumbs.get(s.thumbKey) || null }));
  for (const cb of mediaListeners) {
    try {
      cb({ current: lastState.current, sessions });
    } catch (err) {
      console.error(err);
    }
  }
}

ipcRenderer.on('media:state', (_event, state) => {
  lastState = state;
  notifyMedia();
});

ipcRenderer.on('media:thumb', (_event, { key, data }) => {
  thumbs.set(key, data);
  while (thumbs.size > MAX_THUMBS) thumbs.delete(thumbs.keys().next().value);
  notifyMedia();
});

// Режим перемещения: когда виджеты разблокированы, окно можно таскать за любое место.
// Двигает окно приложение, а не Windows (-webkit-app-region), потому что на слое desktop окно дочернее.
let unlocked = false;
let drag = null; // { x, y } — экранные координаты курсора в начале жеста

function setUnlocked(locked) {
  unlocked = !locked;
  document.documentElement.dataset.unlocked = unlocked ? 'true' : 'false';
}

ipcRenderer.on('widget:lock', (_event, locked) => setUnlocked(locked));

window.addEventListener(
  'pointerdown',
  (event) => {
    if (!unlocked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag = { x: event.screenX, y: event.screenY };
    document.documentElement.setPointerCapture(event.pointerId);
    ipcRenderer.send('widget:drag', 'start');
  },
  true
);

window.addEventListener(
  'pointermove',
  (event) => {
    if (drag) ipcRenderer.send('widget:drag', 'move', event.screenX - drag.x, event.screenY - drag.y);
  },
  true
);

function endDrag() {
  if (!drag) return;
  drag = null;
  ipcRenderer.send('widget:drag', 'end');
}
window.addEventListener('pointerup', endDrag, true);
window.addEventListener('pointercancel', endDrag, true);

// В режиме перемещения кнопки виджета не должны срабатывать
window.addEventListener(
  'click',
  (event) => {
    if (unlocked) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  true
);

document.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style');
  style.textContent = `
    html, body { margin: 0; background: transparent; overflow: hidden; user-select: none; }
    html[data-unlocked="true"] * { cursor: move !important; }
    html[data-unlocked="true"] body::after {
      content: ''; position: fixed; inset: 2px; border: 2px dashed rgba(255, 255, 255, .75);
      border-radius: 18px; pointer-events: none;
    }`;
  document.head.appendChild(style);
  ipcRenderer.invoke('widget:get-info').then((info) => info && setUnlocked(info.locked));
});

contextBridge.exposeInMainWorld('deskwidgets', {
  getInfo: () => ipcRenderer.invoke('widget:get-info'),

  media: {
    // callback({ current, sessions: [{ id, app, status, title, artist, album, pos, dur, thumb, canPrev, canNext, canPlayPause }] })
    subscribe(callback) {
      mediaListeners.add(callback);
      ipcRenderer.send('media:subscribe');
      if (lastState) notifyMedia();
      return () => mediaListeners.delete(callback);
    },
    // cmd: 'playpause' | 'play' | 'pause' | 'next' | 'prev'
    control: (cmd, sessionId) => ipcRenderer.send('media:control', cmd, sessionId),
  },
});
