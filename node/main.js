const { io } = require('socket.io-client');

const commandLineArgs = process.argv;

/**
 * Main class used to drive an individual LED RGB panel
 * based on state from a latticeSpark led-animator module.
 */
class Main {
    constructor() {
        this.showDebug = false;
        this.mainLoopInterval = 30;
        this.args = {};
        this.config = {};

        this.ledPixels = null;
        this.ledPixelIndexes = null;
        this.pallette = [];
        this.pixelsDirty = false;
        this.matrixDirty = false;
        this.ledMessage = "";
        this.ledCommand = null;
        this.currentFrame = 0;
        this.lastFrame = -1;

        this.activeAnimation = null;
        this.activeAnimationId = -1;

        this.socket = null;

        this.processCommandLineArgs();
        this.loadConfig(this.args.config || 'panel1');

        this.moduleServiceUrl = this.config.moduleServiceUrl || 'http://localhost:3002';
        this.panelData = {
            id: this.config.id,
            name: this.config.name,
            width: this.config.width,
            height: this.config.height
        };
        this.frameWidth = this.config.width;
        this.frameHeight = this.config.height;

        this.mainLoopTimeout = null;
        this.tempPixel = null;
        this.tempPixelColor = null;
    }

    /**
     * Main startup method. Connect to module-service and set up hardware.
     */
    start() {
        console.info(`[main] starting panel: ${this.config.name}`);

        // Connect to latticeSpark module-service via Socket.IO
        this.socket = io(this.moduleServiceUrl, {
            path: '/modules-io',
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 30000
        });

        this.socket.on('connect', () => {
            console.info('[main] Connected to module-service');
            this.registerPanel();
        });

        this.socket.on('disconnect', () => {
            console.info('[main] Disconnected from module-service');
        });

        // Listen for module state updates
        this.socket.on('module:state', ({ moduleId, state }) => {
            if (moduleId !== 'led-animator') return;
            if (!state || !state.type) return;

            // Only process updates for this panel
            if (state.panelId && state.panelId !== this.panelData.id) return;

            switch (state.type) {
                case 'frame':
                    this.currentFrame = state.currentFrame;
                    if (state.ledCommand) this.ledCommand = state.ledCommand;
                    if (this.activeAnimation && this.activeAnimation.frames) {
                        const frameData = this.activeAnimation.frames[this.currentFrame];
                        if (frameData) {
                            this.ledPixelIndexes = typeof frameData === 'string'
                                ? frameData.replace('[', '').replace(']', '').split(',')
                                : frameData;
                            this.pixelsDirty = true;
                        }
                    }
                    break;

                case 'panelState':
                    if (state.panel) {
                        const panel = state.panel;
                        if (panel.ledCommand !== undefined) {
                            this.ledCommand = panel.ledCommand;
                        }
                        if (panel.activeAnimation) {
                            this.activeAnimation = panel.activeAnimation;
                            this.activeAnimationId = panel.activeAnimationId || -1;
                        }
                        if (panel.frameWidth !== undefined) {
                            this.frameWidth = panel.frameWidth;
                        }
                        if (panel.frameHeight !== undefined) {
                            this.frameHeight = panel.frameHeight;
                        }
                        if (panel.colorPallette) {
                            this.parsePallette(panel.colorPallette);
                        }
                    }
                    break;

                case 'syncPixels':
                    if (state.ledPixelIndexes) {
                        const data = state.ledPixelIndexes;
                        this.ledPixelIndexes = typeof data === 'string'
                            ? data.split(',')
                            : data;
                        this.pixelsDirty = true;
                    }
                    break;
            }
        });

        // ** now setup our hardware **

        // if we are using the rgb matrix hat, initialize it
        if (this.config.panelType === "rpi-rgb-led-matrix") {
            const LedMatrix = require("easybotics-rpi-rgb-led-matrix");
            this.matrix = new LedMatrix(this.panelData.width, this.panelData.height, this.config.chained, this.config.parallel, this.config.brightness, this.config.hardwareMapping, this.config.rgbSequence, this.config.cmdLineArgs);
            this.config.width = this.config.width * this.config.parallel;
        }

        // if we are using sensehat, init and set
        if (this.config.panelType === "sensehat") {
            this.matrix = require("sense-hat-led");
            if (this.config.rotation) {
                this.matrix.setRotation(this.config.rotation);
            }
        }

        // init matrix creator
        if (this.config.panelType === "matrixCreator") {
            this.matrix = require("@matrix-io/matrix-lite");
        }

        // kick off main loop
        this.mainLoop();

        console.info(`[main] Panel Started: ${this.config.name}`);
    }

    /**
     * Register this panel with the led-animator module
     */
    registerPanel() {
        this.socket.emit('module:command', {
            moduleId: 'led-animator',
            command: 'registerPanel',
            params: this.config
        }, (result) => {
            if (result?.error) {
                console.error('[main] Failed to register panel:', result.error);
            } else {
                console.info('[main] Panel registered successfully');
            }
        });
    }

    /**
     * Parse palette data from module state.
     * The palette can be an array of "r,g,b" strings or an array of [r,g,b] arrays.
     */
    parsePallette(palletteData) {
        if (!palletteData) return;
        this.pallette = [];

        if (typeof palletteData === 'string') {
            // Legacy format: string of quoted rgb values
            const rawArray = palletteData.substr(2, palletteData.length - 2).split('","');
            for (let i = 0; i < rawArray.length; i++) {
                const tempColor = rawArray[i].split(',');
                this.pallette.push([parseInt(tempColor[0]), parseInt(tempColor[1]), parseInt(tempColor[2])]);
            }
        } else if (Array.isArray(palletteData)) {
            for (let i = 0; i < palletteData.length; i++) {
                const item = palletteData[i];
                if (Array.isArray(item)) {
                    this.pallette.push(item);
                } else if (typeof item === 'string') {
                    const tempColor = item.split(',');
                    this.pallette.push([parseInt(tempColor[0]), parseInt(tempColor[1]), parseInt(tempColor[2])]);
                }
            }
        }
    }

    /**
     * Update LED pixels based on data in ledPixelIndexes.
     * Managing the pixels happens differently for different hardware.
     */
    drawCurrentPixelIndexes() {
        let currX = 0;
        let currY = 0;
        let everloop = null;

        if (this.config.panelType === "matrixCreator") {
            everloop = new Array(this.matrix.led.length);
        }

        if (this.ledPixelIndexes) {
            for (let i = 0; i < this.ledPixelIndexes.length; i++) {
                this.tempPixel = this.ledPixelIndexes[i];
                this.tempPixelColor = this.pallette[this.tempPixel];

                if (this.tempPixelColor && this.matrix) {
                    if (this.config.panelType === "matrixCreator") {
                        if (i < this.matrix.led.length) {
                            everloop[i] = `rgb(${this.tempPixelColor})`;
                        }
                    } else {
                        this.matrix.setPixel(currX, currY, this.tempPixelColor[0], this.tempPixelColor[1], this.tempPixelColor[2]);
                    }
                }

                if (i % this.frameWidth === (this.frameWidth - 1)) {
                    currY++;
                    currX = 0;
                } else {
                    currX++;
                }
            }

            if (this.config.panelType === "matrixCreator") {
                this.matrix.led.set(everloop);
            }

            this.matrixDirty = true;
        }
    }

    /**
     * Load up configuration values from config file
     */
    loadConfig(configName) {
        if (this.showDebug) {
            console.info('[main] load config');
        }
        this.config = require('./config/' + configName + '.json');
        if (this.showDebug) {
            console.info('[main] config loaded');
        }
    }

    /**
     * Utility method to handle processing arguments from the command line
     */
    processCommandLineArgs() {
        commandLineArgs.forEach((val, index, arr) => {
            if (val.indexOf('=') > 0) {
                const rowValue = val.split('=');
                this.args[rowValue[0]] = rowValue[1];
            }
        });
    }

    /**
     * Main app loop. This is where the LED panel will actually get updated.
     */
    mainLoop() {
        if (this.lastFrame != this.currentFrame || this.ledCommand === "sync") {
            if (this.pixelsDirty) {
                this.drawCurrentPixelIndexes();
                this.pixelsDirty = false;
            }
            if (this.matrixDirty) {
                if (this.matrix && this.config.panelType === "rpi-rgb-led-matrix") {
                    this.matrix.update();
                }
                this.matrixDirty = false;
            }
            this.lastFrame = this.currentFrame;
        }
        clearTimeout(this.mainLoopTimeout);
        this.mainLoopTimeout = setTimeout(this.mainLoop.bind(this), 5);
    }
}

// create Main and start everything up.
const app = new Main();
app.start();
