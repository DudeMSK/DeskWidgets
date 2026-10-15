// Слои окон через Win32 (user32.dll): Electron сам не умеет «на рабочий стол».
//
//   desktop — окно верхнего уровня, у которого владелец (owner) — Progman, окно рабочего стола.
//             Окно с владельцем всегда лежит над ним и скрывается/показывается вместе с ним,
//             а «Показать рабочий стол» (Win+D) Progman не скрывает — виджет остаётся на месте.
//             Прозрачность при этом сохраняется (в отличие от SetParent: дочернее окно
//             Progman не смешивает альфа-канал с рабочим столом).
//   normal  — обычное окно
//   top     — поверх всех окон
//
// Если Progman найти не удалось, desktop деградирует до «окно на дне Z-порядка».
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const FindWindowW = user32.func('intptr_t __stdcall FindWindowW(str16 cls, str16 name)');
const SetWindowLongPtrW = user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hWnd, int index, intptr_t value)');
const SetWindowPos = user32.func(
  'bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)'
);

const GWLP_HWNDPARENT = -8; // для окон верхнего уровня это владелец, а не родитель

const HWND_BOTTOM = 1n;
const HWND_NOTOPMOST = -2n;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOOWNERZORDER = 0x0200;
const KEEP_RECT = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;

const big = (v) => BigInt(v);

function hwndOf(win) {
  return win.getNativeWindowHandle().readBigInt64LE(0);
}

function progmanHwnd() {
  const h = FindWindowW('Progman', null);
  return h ? big(h) : 0n;
}

function setOwner(hwnd, owner) {
  SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner);
}

// Ставит окно в экранные координаты rect ({ x, y, width, height } в DIP).
// setBounds, а не setPosition: на смешанном DPI setPosition меняет размер окна.
function place(win, rect) {
  if (!win.isDestroyed()) win.setBounds(rect);
}

function applyLayer(win, layer, rect) {
  if (win.isDestroyed()) return;
  const hwnd = hwndOf(win);
  const progman = progmanHwnd();

  win.setBounds(rect);
  if (layer === 'top') {
    setOwner(hwnd, 0n);
    win.setAlwaysOnTop(true, 'floating');
    return;
  }

  win.setAlwaysOnTop(false);
  if (layer === 'desktop' && progman) {
    setOwner(hwnd, progman);
    SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, KEEP_RECT);
    return;
  }

  setOwner(hwnd, 0n);
  SetWindowPos(hwnd, layer === 'desktop' ? HWND_BOTTOM : HWND_NOTOPMOST, 0, 0, 0, 0, KEEP_RECT);
}

module.exports = { applyLayer, place };
