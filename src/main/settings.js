// Настройки в %APPDATA%\deskwidgets\settings.json (запись с задержкой, чтобы не писать при каждом движении мыши)
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = { locked: true, widgets: {} };

class Settings {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = this.load();
    this.timer = null;
  }

  load() {
    try {
      // Блокнот и PowerShell 5.1 дописывают в начало UTF-8 файла BOM, а JSON.parse на нём падает
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, ''));
      return { ...DEFAULTS, ...saved, widgets: { ...saved.widgets } };
    } catch {
      return { ...DEFAULTS, widgets: {} };
    }
  }

  get locked() {
    return this.data.locked;
  }

  set locked(value) {
    this.data.locked = !!value;
    this.scheduleSave();
  }

  widget(id) {
    return this.data.widgets[id] || {};
  }

  patchWidget(id, patch) {
    this.data.widgets[id] = { ...this.widget(id), ...patch };
    this.scheduleSave();
  }

  clearWidgetPosition(id) {
    const { x, y, ...rest } = this.widget(id);
    this.data.widgets[id] = rest;
    this.scheduleSave();
  }

  scheduleSave() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('[settings] не удалось сохранить:', err.message);
    }
  }
}

module.exports = { Settings };
