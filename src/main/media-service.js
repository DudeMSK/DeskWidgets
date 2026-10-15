// Сервис медиа: запускает native/smtc.ps1 и превращает его stdout в события.
// События: 'state' ({ current, sessions }) и 'thumb' ({ key, data }).
const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');

const RESTART_DELAY_MS = 3000;
const MAX_THUMBS = 16;
const COMMANDS = new Set(['playpause', 'play', 'pause', 'next', 'prev']);

class MediaService extends EventEmitter {
  constructor(scriptPath) {
    super();
    this.scriptPath = scriptPath;
    this.proc = null;
    this.wanted = false;
    this.restartTimer = null;
    this.state = { current: null, sessions: [] };
    this.thumbs = new Map();
  }

  start() {
    this.wanted = true;
    if (!this.proc) this.spawnHelper();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    if (this.proc) this.proc.kill();
  }

  // Текущее состояние + миниатюры только для актуальных треков
  snapshot() {
    const thumbs = [];
    for (const s of this.state.sessions) {
      const data = this.thumbs.get(s.thumbKey);
      if (data) thumbs.push({ key: s.thumbKey, data });
    }
    return { state: this.state, thumbs };
  }

  control(cmd, session) {
    if (!COMMANDS.has(cmd) || !this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify({ cmd, session }) + '\n');
  }

  spawnHelper() {
    const proc = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    this.proc = proc;

    proc.stdout.setEncoding('utf8');
    readline.createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => this.onLine(line));
    proc.stderr.on('data', (chunk) => console.error('[smtc]', String(chunk).trim()));
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => console.error('[smtc] не удалось запустить:', err.message));

    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      this.state = { current: null, sessions: [] };
      this.emit('state', this.state);
      if (this.wanted) {
        console.error(`[smtc] завершился (код ${code}), перезапуск через ${RESTART_DELAY_MS} мс`);
        this.restartTimer = setTimeout(() => this.wanted && !this.proc && this.spawnHelper(), RESTART_DELAY_MS);
      }
    });
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'thumb') {
      this.thumbs.set(msg.key, msg.data);
      while (this.thumbs.size > MAX_THUMBS) this.thumbs.delete(this.thumbs.keys().next().value);
      this.emit('thumb', { key: msg.key, data: msg.data });
    } else if (msg.type === 'state') {
      this.state = { current: msg.current, sessions: msg.sessions || [] };
      this.emit('state', this.state);
    }
  }
}

module.exports = { MediaService };
