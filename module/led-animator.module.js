import { BaseModule } from '../../src/modules/base-module.js';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default class LedAnimatorModule extends BaseModule {
  constructor(context, config) {
    super(context, config);
    this.animations = {};
    this.panels = {};
    this.panelTimers = {};
  }

  async initialize() {
    // Load animations from animations/ directory (sibling to this module file)
    const animDir = join(__dirname, 'animations');
    try {
      const files = await readdir(animDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await readFile(join(animDir, file), 'utf-8');
          const anim = JSON.parse(content);
          if (anim && anim.id) {
            this.animations[anim.id] = anim;
          }
        } catch (err) {
          this.ctx.error(`Error reading animation file ${file}: ${err.message}`);
        }
      }
    } catch (err) {
      this.ctx.warn(`No animations directory found or cannot read: ${err.message}`);
    }

    // Restore panel state from persistent storage
    const savedState = await this.ctx.getState();
    if (savedState && savedState.panels) {
      this.panels = savedState.panels;
    }

    // Emit initial state so any connected clients get current data
    this.ctx.emitState({ type: 'animations', animations: this.animationSummaries() });
    this.ctx.emitState({ type: 'panels', panels: this.panelSummaries() });
    this.ctx.log(`Loaded ${Object.keys(this.animations).length} animations`);
  }

  async handleCommand(command, params) {
    switch (command) {
      case 'getState':
        return {
          animations: this.animationSummaries(),
          panels: this.panelSummaries()
        };

      case 'getAnimation': {
        const { id } = params;
        if (!id || !this.animations[id]) return { error: 'Animation not found' };
        return { animation: this.animations[id] };
      }

      case 'registerPanel': {
        const { id, name, width, height, parallel } = params;
        if (!id) return { error: 'Panel id required' };
        this.panels[id] = {
          id,
          name: name || id,
          width: width || 32,
          height: height || 32,
          parallel: parallel || 1,
          activeAnimationId: null,
          activeAnimation: null,
          ledCommand: 'stop',
          currentFrame: 0,
          totalFrames: 0,
          frameRate: 66,
          frameWidth: width || 32,
          frameHeight: height || 32,
          colorPallette: null,
          ledPixelIndexes: null
        };
        this.ctx.emitState({ type: 'panels', panels: this.panelSummaries() });
        return { success: true };
      }

      case 'setActiveAnimation': {
        const { panelId, animation } = params;
        if (!panelId || !this.panels[panelId]) return { error: 'Invalid panelId' };
        const panel = this.panels[panelId];
        panel.activeAnimation = animation;
        panel.activeAnimationId = animation.id;
        panel.frameRate = animation.speed || 66;
        panel.colorPallette = animation.pallette;
        panel.totalFrames = animation.frames ? animation.frames.length : 0;
        panel.currentFrame = 0;
        panel.frameWidth = animation.frameWidth || panel.frameWidth;
        panel.frameHeight = animation.frameHeight || panel.frameHeight;
        panel.ledCommand = 'play';
        this.startPanelTimer(panelId);
        this.ctx.emitState({
          type: 'panelState',
          panelId,
          panel: {
            activeAnimationId: panel.activeAnimationId,
            activeAnimation: panel.activeAnimation,
            ledCommand: panel.ledCommand,
            info: { id: panel.id, name: panel.name, width: panel.width, height: panel.height, parallel: panel.parallel }
          }
        });
        this.ctx.emitState({
          type: 'frame',
          panelId,
          currentFrame: panel.currentFrame
        });
        return { success: true };
      }

      case 'setLedCommand': {
        const { panelId, command: cmd } = params;
        if (!panelId || !this.panels[panelId]) return { error: 'Invalid panelId' };
        const panel = this.panels[panelId];
        panel.ledCommand = cmd;

        if (cmd === 'play') {
          if (panel.activeAnimation && panel.activeAnimation.pallette) {
            panel.colorPallette = panel.activeAnimation.pallette;
          }
          this.startPanelTimer(panelId);
        } else if (cmd === 'stop' || cmd === 'sync') {
          this.stopPanelTimer(panelId);
        }

        this.ctx.emitState({
          type: 'panelState',
          panelId,
          panel: {
            ledCommand: panel.ledCommand
          }
        });
        return { success: true };
      }

      case 'setLedPixelIndexes': {
        const { panelId, data } = params;
        if (!panelId || !this.panels[panelId]) return { error: 'Invalid panelId' };
        this.panels[panelId].ledPixelIndexes = data;
        this.ctx.emitState({
          type: 'syncPixels',
          panelId,
          data
        });
        return { success: true };
      }

      case 'setColorPallette': {
        const { panelId, pallette } = params;
        if (!panelId || !this.panels[panelId]) return { error: 'Invalid panelId' };
        this.panels[panelId].colorPallette = pallette;
        this.ctx.emitState({
          type: 'panelState',
          panelId,
          panel: { colorPallette: pallette }
        });
        return { success: true };
      }

      case 'setFrameSize': {
        const { panelId, width, height } = params;
        if (!panelId || !this.panels[panelId]) return { error: 'Invalid panelId' };
        this.panels[panelId].frameWidth = width;
        this.panels[panelId].frameHeight = height;
        this.ctx.emitState({
          type: 'panelState',
          panelId,
          panel: { frameWidth: width, frameHeight: height }
        });
        return { success: true };
      }

      case 'saveAnimation': {
        const { id, data } = params;
        if (!id || !data) return { error: 'id and data required' };
        this.animations[id] = data;
        // Write to disk
        const animDir = join(__dirname, 'animations');
        const filePath = join(animDir, `${id}.json`);
        try {
          await writeFile(filePath, JSON.stringify(data), 'utf-8');
        } catch (err) {
          console.error(`[LedAnimator] Error saving animation ${id}:`, err.message);
          return { error: 'Failed to save animation file' };
        }
        this.ctx.emitState({ type: 'animations', animations: this.animationSummaries() });
        return { success: true };
      }

      default:
        return { error: `Unknown command: ${command}` };
    }
  }

  async cleanup() {
    // Clear all timers
    for (const panelId of Object.keys(this.panelTimers)) {
      this.stopPanelTimer(panelId);
    }
    // Save panel state for restoration on next startup
    const panelsToSave = {};
    for (const [id, panel] of Object.entries(this.panels)) {
      panelsToSave[id] = { ...panel, activeAnimation: null };
    }
    await this.ctx.setState({ panels: panelsToSave });
  }

  /**
   * Returns a map of animation summaries (no frame data) for sending to clients.
   */
  animationSummaries() {
    const summaries = {};
    for (const [id, anim] of Object.entries(this.animations)) {
      summaries[id] = {
        id: anim.id,
        name: anim.name,
        frameCount: anim.frames ? anim.frames.length : 0,
        speed: anim.speed
      };
    }
    return summaries;
  }

  /**
   * Returns a map of panel info (no large animation data) for sending to clients.
   */
  panelSummaries() {
    const summaries = {};
    for (const [id, panel] of Object.entries(this.panels)) {
      summaries[id] = {
        id: panel.id,
        name: panel.name,
        width: panel.width,
        height: panel.height,
        parallel: panel.parallel,
        activeAnimationId: panel.activeAnimationId,
        ledCommand: panel.ledCommand,
        currentFrame: panel.currentFrame,
        frameWidth: panel.frameWidth,
        frameHeight: panel.frameHeight
      };
    }
    return summaries;
  }

  /**
   * Start frame advance timer for a panel. Clears existing timer first.
   */
  startPanelTimer(panelId) {
    this.stopPanelTimer(panelId);
    const panel = this.panels[panelId];
    if (!panel || !panel.frameRate || panel.totalFrames <= 0) return;

    this.panelTimers[panelId] = setInterval(() => {
      this.nextFrame(panelId);
    }, panel.frameRate);
  }

  /**
   * Stop the frame advance timer for a panel.
   */
  stopPanelTimer(panelId) {
    if (this.panelTimers[panelId]) {
      clearInterval(this.panelTimers[panelId]);
      delete this.panelTimers[panelId];
    }
  }

  /**
   * Advance the current frame for a panel, wrapping to 0 at the end.
   */
  nextFrame(panelId) {
    const panel = this.panels[panelId];
    if (!panel || panel.ledCommand !== 'play') return;

    let newFrame = panel.currentFrame + 1;
    if (newFrame >= panel.totalFrames) {
      newFrame = 0;
    }
    panel.currentFrame = newFrame;

    this.ctx.emitState({
      type: 'frame',
      panelId,
      currentFrame: newFrame
    });
  }
}
