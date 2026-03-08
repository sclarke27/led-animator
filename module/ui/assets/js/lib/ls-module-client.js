/**
 * Standalone Socket.IO client for communicating with latticeSpark modules.
 * No framework dependency -- works in any vanilla HTML page.
 * Requires Socket.IO client loaded globally (e.g. via CDN script tag).
 */
class LSModuleClient {
  constructor(moduleId, { socketUrl, socketPath = '/modules-io' } = {}) {
    this.moduleId = moduleId;
    this._stateHandlers = new Map();
    this._anyStateHandlers = new Set();
    this._connectHandlers = new Set();
    this._disconnectHandlers = new Set();

    const url = socketUrl || window.location.origin;
    this.socket = io(url, {
      path: socketPath,
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000
    });

    this.socket.on('connect', () => {
      for (const cb of this._connectHandlers) cb();
    });

    this.socket.on('disconnect', () => {
      for (const cb of this._disconnectHandlers) cb();
    });

    this.socket.on('module:state', ({ moduleId: id, state }) => {
      if (id !== this.moduleId) return;
      for (const cb of this._anyStateHandlers) cb(state);
      if (state?.type) {
        const handlers = this._stateHandlers.get(state.type);
        if (handlers) {
          for (const cb of handlers) cb(state);
        }
      }
    });
  }

  onState(type, callback) {
    if (!this._stateHandlers.has(type)) {
      this._stateHandlers.set(type, new Set());
    }
    this._stateHandlers.get(type).add(callback);
    return () => {
      this._stateHandlers.get(type)?.delete(callback);
    };
  }

  onAnyState(callback) {
    this._anyStateHandlers.add(callback);
    return () => { this._anyStateHandlers.delete(callback); };
  }

  command(command, params = {}) {
    return new Promise((resolve) => {
      this.socket.emit('module:command', {
        moduleId: this.moduleId,
        command,
        params
      }, (result) => {
        resolve(result);
      });
    });
  }

  onConnect(callback) {
    this._connectHandlers.add(callback);
    if (this.socket.connected) callback();
    return () => { this._connectHandlers.delete(callback); };
  }

  onDisconnect(callback) {
    this._disconnectHandlers.add(callback);
    return () => { this._disconnectHandlers.delete(callback); };
  }

  get connected() {
    return this.socket?.connected ?? false;
  }

  disconnect() {
    this.socket?.disconnect();
  }
}
