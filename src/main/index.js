// Точка входа: фоновое приложение с иконкой в трее, которое показывает виджеты на рабочем столе.
const { app, Menu, Tray, nativeImage, session, shell } = require('electron');
const path = require('path');
const { MediaService } = require('./media-service');
const { Settings } = require('./settings');
const { WidgetManager, LAYERS } = require('./widget-manager');

const LAYER_LABELS = {
  desktop: 'На рабочем столе (под окнами)',
  normal: 'Как обычное окно',
  top: 'Поверх всех окон',
};

// В собранном приложении PowerShell не умеет читать из asar-архива, поэтому native/ распаковывается рядом
const unpacked = (p) => p.replace('app.asar', 'app.asar.unpacked');

let tray = null;
let manager = null;
let settings = null;

function autostartEnabled() {
  return app.getLoginItemSettings().openAtLogin;
}

function setAutostart(enabled) {
  // В режиме разработки нужно передать путь к проекту, иначе запустится «голый» electron.exe
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: app.isPackaged ? [] : [app.getAppPath()],
  });
}

function buildMenu() {
  const widgetItems = manager.list().map((w) => ({
    label: w.name,
    submenu: [
      { label: 'Показывать', type: 'checkbox', checked: w.enabled, click: (item) => manager.setEnabled(w.id, item.checked) },
      {
        label: 'Положение',
        submenu: LAYERS.map((layer) => ({
          label: LAYER_LABELS[layer],
          type: 'radio',
          checked: w.layer === layer,
          click: () => manager.setLayer(w.id, layer),
        })),
      },
      { label: 'Сбросить позицию', enabled: w.enabled, click: () => manager.resetPosition(w.id) },
    ],
  }));

  return Menu.buildFromTemplate([
    { label: 'DeskWidgets', enabled: false },
    { type: 'separator' },
    ...widgetItems,
    { type: 'separator' },
    {
      label: 'Переместить виджеты',
      type: 'checkbox',
      checked: !settings.locked,
      click: (item) => manager.setLocked(!item.checked),
    },
    {
      label: 'Запускать вместе с Windows',
      type: 'checkbox',
      checked: autostartEnabled(),
      click: (item) => setAutostart(item.checked),
    },
    { type: 'separator' },
    { label: 'Папка с виджетами', click: () => shell.openPath(userWidgetsDir()) },
    { label: 'Перечитать виджеты', click: () => manager.reload() },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() },
  ]);
}

function userWidgetsDir() {
  return path.join(app.getPath('userData'), 'widgets');
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../../assets/tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('DeskWidgets');
  const refresh = () => tray.setContextMenu(buildMenu());
  manager.on('changed', refresh);
  tray.on('click', () => tray.popUpContextMenu());
  refresh();
}

function main() {
  // Виджеты — локальные страницы, им не нужны камера, геолокация и т. п.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  settings = new Settings();
  const media = new MediaService(unpacked(path.join(__dirname, '../../native/smtc.ps1')));
  manager = new WidgetManager({
    settings,
    media,
    dirs: [path.join(app.getAppPath(), 'widgets'), userWidgetsDir()], // встроенные читаются прямо из asar
    preload: path.join(__dirname, 'preload.js'),
  });

  createTray();
  manager.reload();

  app.on('before-quit', () => {
    manager.closeAll();
    media.stop();
    settings.flush();
  });
}

app.setAppUserModelId('local.deskwidgets');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Приложение живёт в трее: закрытие последнего окна не должно его завершать
  app.on('window-all-closed', () => {});
  app.whenReady().then(main);
}
