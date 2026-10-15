// Менеджер виджетов: находит манифесты, создаёт окна, хранит позиции и слои, раздаёт данные медиа.
const { BrowserWindow, ipcMain, screen, shell } = require('electron');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { applyLayer, place } = require('./layer');

const LAYERS = ['desktop', 'normal', 'top'];
const SCREEN_MARGIN = 24;
const STACK_GAP = 16;

class WidgetManager extends EventEmitter {
  // dirs — папки с виджетами (встроенные и пользовательские); у каждого виджета своя подпапка с manifest.json
  constructor({ settings, media, dirs, preload }) {
    super();
    this.settings = settings;
    this.media = media;
    this.dirs = dirs;
    this.preload = preload;
    this.manifests = new Map();
    this.windows = new Map();
    this.pos = new Map(); // id -> { x, y } в DIP; окно на слое desktop само позицию не хранит
    this.drag = null; // { id, origin: { x, y } } пока виджет перетаскивают
    this.mediaSubs = new Map(); // webContents.id -> webContents

    this.registerIpc();
    media.on('state', (state) => this.broadcastMedia('media:state', state));
    media.on('thumb', (thumb) => this.broadcastMedia('media:thumb', thumb));
  }

  // ---------- манифесты ----------

  discover() {
    this.manifests.clear();
    for (const dir of this.dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const widgetDir = path.join(dir, entry.name);
        try {
          const manifest = this.readManifest(widgetDir);
          this.manifests.set(manifest.id, manifest);
        } catch (err) {
          console.error(`[widgets] ${widgetDir}: ${err.message}`);
        }
      }
    }
  }

  readManifest(dir) {
    const file = path.join(dir, 'manifest.json');
    if (!fs.existsSync(file)) throw new Error('нет manifest.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

    if (!/^[a-z0-9][a-z0-9_-]*$/.test(raw.id || '')) throw new Error('некорректный id');
    const win = raw.window || {};
    if (!(win.width > 0 && win.height > 0)) throw new Error('window.width и window.height обязательны');
    const entry = raw.entry || 'index.html';
    const entryPath = path.resolve(dir, entry);
    if (!entryPath.startsWith(path.resolve(dir) + path.sep)) throw new Error('entry выходит за папку виджета');
    if (!fs.existsSync(entryPath)) throw new Error(`нет файла ${entry}`);

    return {
      id: raw.id,
      name: raw.name || raw.id,
      description: raw.description || '',
      entryPath,
      dir,
      permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
      enabledByDefault: !!raw.enabledByDefault,
      config: raw.config || {},
      window: {
        width: win.width,
        height: win.height,
        layer: LAYERS.includes(win.layer) ? win.layer : 'desktop',
        anchor: win.anchor || 'top-right',
        focusable: !!win.focusable,
      },
    };
  }

  // ---------- состояние виджета ----------

  isEnabled(id) {
    const saved = this.settings.widget(id).enabled;
    return saved === undefined ? this.manifests.get(id).enabledByDefault : saved;
  }

  layerOf(id) {
    const saved = this.settings.widget(id).layer;
    return LAYERS.includes(saved) ? saved : this.manifests.get(id).window.layer;
  }

  list() {
    return [...this.manifests.values()].map((m) => ({
      id: m.id,
      name: m.name,
      enabled: this.isEnabled(m.id),
      layer: this.layerOf(m.id),
    }));
  }

  // ---------- жизненный цикл ----------

  reload() {
    for (const id of [...this.windows.keys()]) this.close(id);
    this.discover();
    for (const id of this.manifests.keys()) if (this.isEnabled(id)) this.open(id);
    this.syncMedia();
    this.emit('changed');
  }

  open(id) {
    const m = this.manifests.get(id);
    if (!m || this.windows.has(id)) return;

    const start = this.positionFor(m);
    this.pos.set(id, start);
    const win = new BrowserWindow({
      x: start.x,
      y: start.y,
      width: m.window.width,
      height: m.window.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: m.window.focusable,
      show: false,
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    // Ошибки и console.* из виджета попадают в лог приложения
    win.webContents.on('console-message', (event) => {
      const { level, message, sourceId, lineNumber } = event;
      if (level === 'warning' || level === 'error') console.error(`[${id}] ${message} (${path.basename(sourceId || '')}:${lineNumber})`);
      else console.log(`[${id}] ${message}`);
    });
    win.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error(`[${id}] ошибка preload ${preloadPath}: ${error.stack || error}`);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[${id}] рендерер упал: ${details.reason}`);
    });

    win.once('ready-to-show', () => {
      applyLayer(win, this.layerOf(id), this.rectOf(id)); // слой применяем до показа, чтобы окно не мелькало
      win.showInactive();
    });
    win.on('closed', () => this.windows.delete(id));

    this.windows.set(id, win);
    win.loadFile(m.entryPath);
  }

  close(id) {
    const win = this.windows.get(id);
    this.windows.delete(id);
    if (win && !win.isDestroyed()) win.destroy();
  }

  closeAll() {
    for (const id of [...this.windows.keys()]) this.close(id);
  }

  setEnabled(id, enabled) {
    this.settings.patchWidget(id, { enabled });
    if (enabled) this.open(id);
    else this.close(id);
    this.syncMedia();
    this.emit('changed');
  }

  setLayer(id, layer) {
    if (!LAYERS.includes(layer)) return;
    this.settings.patchWidget(id, { layer });
    const win = this.windows.get(id);
    if (win) applyLayer(win, layer, this.rectOf(id));
    this.emit('changed');
  }

  setLocked(locked) {
    this.settings.locked = locked;
    for (const win of this.windows.values()) win.webContents.send('widget:lock', !!locked);
    this.emit('changed');
  }

  resetPosition(id) {
    this.settings.clearWidgetPosition(id);
    const win = this.windows.get(id);
    const m = this.manifests.get(id);
    if (win && m) {
      this.pos.set(id, this.defaultPosition(m));
      place(win, this.rectOf(id));
    }
  }

  // ---------- позиции ----------

  rectOf(id) {
    const { width, height } = this.manifests.get(id).window;
    return { ...this.pos.get(id), width, height };
  }

  // Перетаскивание делаем сами: у дочернего окна рабочего стола нет заголовка, за который его мог бы тянуть Windows.
  // Страница шлёт смещение курсора от начала жеста, мы двигаем окно от исходной позиции.
  dragWidget(id, phase, dx, dy) {
    const win = this.windows.get(id);
    if (!win) return;
    if (phase === 'start') {
      this.drag = { id, origin: { ...this.pos.get(id) } };
    } else if (this.drag && this.drag.id === id) {
      if (phase === 'move' && Number.isFinite(dx) && Number.isFinite(dy)) {
        this.pos.set(id, { x: Math.round(this.drag.origin.x + dx), y: Math.round(this.drag.origin.y + dy) });
        place(win, this.rectOf(id));
      } else if (phase === 'end') {
        this.drag = null;
        this.settings.patchWidget(id, this.pos.get(id));
      }
    }
  }

  positionFor(m) {
    const { x, y } = this.settings.widget(m.id);
    const { width, height } = m.window;
    if (Number.isFinite(x) && Number.isFinite(y) && this.isOnScreen(x, y, width, height)) return { x, y };
    return this.defaultPosition(m);
  }

  isOnScreen(x, y, width, height) {
    const need = 40; // сколько пикселей окна должно оставаться на каком-нибудь мониторе
    return screen.getAllDisplays().some(({ workArea: a }) =>
      x < a.x + a.width - need && x + width > a.x + need && y < a.y + a.height - need && y + height > a.y + need
    );
  }

  // Новые виджеты выстраиваются столбиком у угла экрана, чтобы не лечь друг на друга
  defaultPosition(m) {
    const area = screen.getPrimaryDisplay().workArea;
    const [vertical, horizontal] = m.window.anchor.split('-');
    const earlier = [...this.manifests.values()]
      .filter((o) => o.window.anchor === m.window.anchor && this.isEnabled(o.id))
      .map((o) => o.id);
    const index = Math.max(0, earlier.indexOf(m.id));
    let offset = 0;
    for (const id of earlier.slice(0, index)) offset += this.manifests.get(id).window.height + STACK_GAP;

    const x = horizontal === 'left' ? area.x + SCREEN_MARGIN : area.x + area.width - m.window.width - SCREEN_MARGIN;
    const y =
      vertical === 'top'
        ? area.y + SCREEN_MARGIN + offset
        : area.y + area.height - m.window.height - SCREEN_MARGIN - offset;
    return { x, y };
  }

  // ---------- медиа ----------

  syncMedia() {
    const needed = [...this.windows.keys()].some((id) => this.manifests.get(id).permissions.includes('media'));
    if (needed) this.media.start();
    else this.media.stop();
  }

  broadcastMedia(channel, payload) {
    for (const [id, contents] of this.mediaSubs) {
      if (contents.isDestroyed()) this.mediaSubs.delete(id);
      else contents.send(channel, payload);
    }
  }

  // ---------- IPC ----------

  widgetOf(webContents) {
    for (const [id, win] of this.windows) if (win.webContents === webContents) return this.manifests.get(id);
    return null;
  }

  registerIpc() {
    ipcMain.handle('widget:get-info', (event) => {
      const m = this.widgetOf(event.sender);
      if (!m) return null;
      const overrides = this.settings.widget(m.id).config || {};
      return {
        id: m.id,
        name: m.name,
        layer: this.layerOf(m.id),
        locked: this.settings.locked,
        config: { ...m.config, ...overrides },
      };
    });

    ipcMain.on('widget:drag', (event, phase, dx, dy) => {
      const m = this.widgetOf(event.sender);
      if (m && !this.settings.locked) this.dragWidget(m.id, String(phase), Number(dx), Number(dy));
    });

    ipcMain.on('media:subscribe', (event) => {
      const m = this.widgetOf(event.sender);
      if (!m || !m.permissions.includes('media')) return;
      this.mediaSubs.set(event.sender.id, event.sender);
      const { state, thumbs } = this.media.snapshot();
      for (const thumb of thumbs) event.sender.send('media:thumb', thumb);
      event.sender.send('media:state', state);
    });

    ipcMain.on('media:control', (event, cmd, session) => {
      const m = this.widgetOf(event.sender);
      if (!m || !m.permissions.includes('media')) return;
      this.media.control(String(cmd), typeof session === 'string' ? session : undefined);
    });
  }
}

module.exports = { WidgetManager, LAYERS };
