/**
 * Migrate animation data from old stringified format to native arrays.
 * Old format: frames as JSON strings, pallette as JSON string.
 * New format: frames as arrays of numbers, pallette as array of strings.
 */
function migrateAnimationFormat(animData) {
  if (animData.frames?.length > 0 && typeof animData.frames[0] === 'string') {
    animData.frames = animData.frames.map(f => JSON.parse(f));
  }
  if (typeof animData.pallette === 'string') {
    animData.pallette = JSON.parse(animData.pallette);
  }
  return animData;
}

/**
 * LedMatrixPage class drives the LED Animation page
 * in this code a 'panel' is any LED panel, matrix, array, etx that can be animated
 * It is assumed that every panel has an array of individually addressable RGB LEDs.
 * This class handles the page only. The actual driving and updating of LED panels is handled
 * with Node in /node/main.js of this project.
 */
class LedMatrixPage {

  client = null;
  dialog = null;
  importUtil = null;
  ledPixels = [];
  selectedFrame = 0;
  currentPanelId = null;
  pixelGrid = null;
  gridOffsetX = null;
  gridOffsetY = null;
  pixelDivCache = [];
  pixelCanvas = null;
  pixelCanvasCxt = null;

  selectedColor = null;
  selectedAnimation = "default";
  selectedColorChip = null;
  activeTool = "brush";
  isFgColorActive = true;
  foregroundColor = null;
  backgroundColor = Color.rgb(0, 0, 0);

  activeAnimation = null;
  animationListSynced = false;
  animationsList = {};
  serverAnimationSummaries = {};
  animationTimer = null;

  panelList = [];
  panelInfo = null;
  panelWidth = 32;
  panelHeight = 32;

  framesDiv = null;
  frameDivCache = [];
  syncPreview = false;
  ledCommand = "stop";
  zoomLevel = 1;

  constructor(client) {
    this.client = client;
  }

  /**
   * class init. setup client state handlers and default objects/variables
   * and then call start()
   */
  initialize() {

    // Listen for animations state updates from server (summaries only, no frame data)
    this.client.onState('animations', (state) => {
      if (state.animations) {
        this.serverAnimationSummaries = state.animations;
        this.updateAnimationList();
      }
    });

    // Listen for panels state updates from server
    this.client.onState('panels', (state) => {
      if (state.panels) {
        this.refreshPanelList(state.panels);
      }
    });

    // Listen for panel state changes (active animation, led command, info)
    this.client.onState('panelState', (state) => {
      if (state.panelId !== this.currentPanelId) return;
      const panel = state.panel;
      if (panel.activeAnimationId) this.activeAnimationId = panel.activeAnimationId;
      if (panel.activeAnimation) {
        this.activeAnimation = panel.activeAnimation;
        document.getElementById("panelAnimName").innerHTML = panel.activeAnimation.name || "None";
      }
      if (panel.ledCommand !== undefined) {
        this.ledCommand = panel.ledCommand;
        this.updatePlayStopButton();
      }
      if (panel.info) {
        this.panelInfo = panel.info;
        this.panelName = panel.info.name;
        this.panelWidth = panel.info.width * (panel.info.parallel || 1);
        this.panelHeight = panel.info.height;
        document.getElementById('panelSize').innerHTML = `W: ${this.panelWidth} H: ${this.panelHeight}`;
        document.getElementById('panelNameDiv').innerHTML = this.panelName;
        this.handleResize();
      }
    });

    // Listen for frame updates
    this.client.onState('frame', (state) => {
      if (state.panelId !== this.currentPanelId) return;
      // Frame update from server (for panel playback tracking)
    });

    // Listen for sync pixel data
    this.client.onState('syncPixels', (state) => {
      if (state.panelId !== this.currentPanelId) return;
      // Handle sync pixel data from server
    });

    // Request full state on connect
    this.client.onConnect(() => {
      this.client.command('getState').then((result) => {
        if (result.animations) {
          this.serverAnimationSummaries = result.animations;
          this.updateAnimationList();
        }
        if (result.panels) {
          this.refreshPanelList(result.panels);
        }
      });
    });

    // create dialog manager to use later
    this.dialog = new Dialog("overlayBg", "overlayContent", "overlayTitle");
    this.importUtil = new ImportUtil();

    // setup some default values
    this.pixelGrid = document.getElementById("pixelGrid");
    this.framesDiv = document.getElementById("framesContainer");
    this.pixelCanvas = document.getElementById("pixelCanvas");
    this.pixelCanvas.addEventListener('mousedown', this.handleGridEvent.bind(this));
    this.pixelCanvas.addEventListener('mousemove', this.handleGridEvent.bind(this));
    this.pixelCanvasCxt = this.pixelCanvas.getContext("2d");
    this.gridOffsetX = this.pixelGrid.offsetLeft;
    this.gridOffsetY = this.pixelGrid.offsetTop;

    // start page on next render frame
    window.requestAnimationFrame(() => {
      this.start();
    })
  }

  /**
   * Refresh panel list from server data
   */
  refreshPanelList(panels) {
    this.panelList = panels;
    if (this.currentPanelId === null) {
      const panelKeys = Object.keys(panels);
      if (panelKeys.length > 0) {
        this.selectPanel(panelKeys[0]);
      }
    }
    this.updatePanelList();
  }

  /**
   * Update play/stop/sync button UI based on current ledCommand
   */
  updatePlayStopButton() {
    document.getElementById("panelCommand").innerHTML = this.ledCommand;
    const syncButton = document.getElementById("syncButton");
    const playButton = document.getElementById("animPlayButton");
    if (this.ledCommand === "play") {
      playButton.innerText = "stop";
      playButton.className = "material-icons on";
      syncButton.className = "material-icons";
      syncButton.innerText = "sync";
    }
    if (this.ledCommand === "stop") {
      playButton.innerText = "play_arrow";
      playButton.className = "material-icons";
      syncButton.className = "material-icons";
      syncButton.innerText = "sync";
    }
    if (this.ledCommand === "sync") {
      this.syncPreview = true;
      playButton.innerText = "play_arrow";
      playButton.className = "material-icons";
      syncButton.className = "material-icons on";
      syncButton.innerText = "sync_disabled";
    }
  }

  /**
   * Start up the LED Animator page
   */
  start() {

    // draw color pallettes and setup page default state
    this.drawFullColorPallette();
    this.newAnimation();
    this.selectColor(Color.rgb(255, 255, 255));

    // prevent right click on canvas so we can use that as erase pixel
    document.getElementById("pixelCanvas").addEventListener("contextmenu", function (e) {
      e.preventDefault();
    }, false);

    // event listener for import button in import dialog
    document.getElementById('gifImportButton').addEventListener('change', this.importAnimation.bind(this), false)

    // start key event listener for keyboard shortcuts
    this.keyPressHandler();

    document.body.onresize = () => {
      this.handleResize();
    };

    // start render loop
    window.requestAnimationFrame(() => {
      this.render();
    });

  }

  /**
   * main render loop
   */
  render() {

    // update canvas in pixelGrid
    this.drawPixels();

    // start render loop timer
    window.requestAnimationFrame(() => {
      this.render();
    })
  }

  /**
   * Select which LED panel/matrix the UI is managing
   * @param {*} panelId
   */
  selectPanel(panelId = null) {
    // make sure there is a value
    if (panelId == null) {
      console.info("no panel id")
      return false;
    }

    // set new panel id
    this.currentPanelId = panelId;

    // Request panel state from server
    this.client.command('getState').then((result) => {
      if (result.panels && result.panels[panelId]) {
        const panel = result.panels[panelId];
        if (panel.activeAnimationId) {
          this.activeAnimationId = panel.activeAnimationId;
        }
        if (panel.ledCommand !== undefined) {
          this.ledCommand = panel.ledCommand;
          this.updatePlayStopButton();
        }
      }
    });

    // refresh panel list state
    this.updatePanelList();

  }

  /**
   * draw current frame to pixel grid canvas
   * this is called on render loop and does not need to be called outside of that
   */
  drawPixels() {
    // make sure we have what we need to work with
    if (!this.ledPixels || this.panelWidth == 0 || this.panelHeight == 0 || Object.keys(this.animationsList).length === 0) {
      return false;
    }

    // get selected animation data from animation list
    const animData = this.animationsList[this.selectedAnimation];
    if (!animData || !animData.frames) return false;
    // get frames data for animation
    const framesList = animData.frames;
    // set led pixel data for selected frame
    this.ledPixels = framesList[this.selectedFrame];

    // if there are not pixels, create a new animation to fill things in properly
    if (this.ledPixels.length === 0) {
      this.newAnimation();
    }

    // grab current animation pallette
    const pallette = animData.pallette;

    // create image data on pixel canvas context
    const frameImageData = this.pixelCanvasCxt.createImageData(animData.frameWidth, animData.frameHeight);

    // draw pixels to frameImageData
    let dataIndex = 0;
    for (const pixelIndex in this.ledPixels) {
      const pixel = this.ledPixels[pixelIndex];
      const color = pallette[pixel].split(",");
      frameImageData.data[dataIndex] = parseInt(color[0]);
      frameImageData.data[dataIndex + 1] = parseInt(color[1]);
      frameImageData.data[dataIndex + 2] = parseInt(color[2]);
      frameImageData.data[dataIndex + 3] = 255;
      dataIndex = dataIndex + 4;
    }

    // draw new frame to canvas
    this.pixelCanvasCxt.putImageData(frameImageData, 0, 0);

  }

  handleResize() {
    const maxDisplaySize = 416; // 13px * 32 — default canvas display size
    const baseCellSize = Math.floor(maxDisplaySize / Math.max(this.panelWidth, this.panelHeight));
    const cellSize = Math.max(1, Math.round(baseCellSize * this.zoomLevel));
    const displayWidth = cellSize * this.panelWidth;
    const displayHeight = cellSize * this.panelHeight;

    this.pixelGrid.style.width = `${displayWidth}px`;
    this.pixelGrid.style.height = `${displayHeight}px`;
    this.pixelCanvas.style.width = `${displayWidth}px`;
    this.pixelCanvas.style.height = `${displayHeight}px`;
    this.pixelCanvas.width = this.panelWidth;
    this.pixelCanvas.height = this.panelHeight;

    this.gridOffsetX = this.pixelGrid.offsetLeft;
    this.gridOffsetY = this.pixelGrid.offsetTop;
  }

  zoomIn() {
    this.zoomLevel = Math.min(this.zoomLevel + 0.25, 4);
    this.handleResize();
  }

  zoomOut() {
    this.zoomLevel = Math.max(this.zoomLevel - 0.25, 0.25);
    this.handleResize();
  }

  zoomReset() {
    this.zoomLevel = 1;
    this.handleResize();
  }

  /**
   * Event handler to catch and handle mouse move and mouse down events on pixel canvas
   * @param {event} evt
   */
  handleGridEvent(evt) {
    const animData = this.animationsList[this.selectedAnimation];
    if (!animData || !animData.pallette) return;
    // grab active color pallette
    const pallette = animData.pallette;
    //find size of pixels being drawn based on size of pixel canvas
    const gridPixelWidth = this.pixelGrid.offsetWidth / this.panelWidth;
    const gridPixelHeight = this.pixelGrid.offsetHeight / this.panelHeight;
    // determine pixel X,Y of cursor based on pixel size in canvas
    const pixelX = Math.floor((evt.clientX - this.gridOffsetX) / gridPixelWidth);
    const pixelY = Math.floor((evt.clientY - this.gridOffsetY) / gridPixelHeight);
    // find color of pixel under cursor
    const pixelIndex = (pixelY * this.panelWidth) + pixelX;
    const pixelColorIndex = this.ledPixels[pixelIndex];
    // update info panel
    document.getElementById("cursorXPos").innerText = pixelX;
    document.getElementById("cursorYPos").innerText = pixelY;
    document.getElementById("rgbAtCursor").innerText = pallette[pixelColorIndex];
    // handle left/right mouse clicks
    if (evt.buttons === 1 || evt.buttons === 2) {
      this.selectPixel(evt, pixelIndex, pallette);
    }

  }

  selectTool(toolName) {
    this.activeTool = toolName;
    const toolButtons = document.getElementById("brushTools").children;

    for (let i = 0; i < toolButtons.length; i++) {
      const currButton = toolButtons[i];
      currButton.className = "material-icons";
      if (currButton.id.indexOf(this.activeTool) >= 0) {
        currButton.className += " on";
      }
    }
  }

  /**
   *
   * @param {mouseEvent} evt
   * @param {pixelIndex} index
   * @param {colorPallette} pallette
   */
  selectPixel(evt, index, pallette) {

    const currPixelColor = pallette[this.ledPixels[index]];
    // switch/case is for adding more tools later such as a color picker
    switch (this.activeTool) {
      case "dropper":
        if (evt.buttons === 1) {
          const colorArr = currPixelColor.split(",");
          this.selectColor(Color.rgb(colorArr[0], colorArr[1], colorArr[2]));
        }
        break;
      case "eraser":
        // update pixel color in led pixel array for current frame
        const colorArr = `${this.backgroundColor.r},${this.backgroundColor.g},${this.backgroundColor.b}`;
        const colorIndex = pallette.indexOf(colorArr);
        this.ledPixels[index] = colorIndex;

        // if sync enabled, update panel with changes
        if (this.ledCommand === "sync") {
          this.showLedPixels();
        }

        break;

      case "fill":
        if (evt.buttons === 1 || evt.buttons === 2) {
          let currColorArr = null;
          // pick what the new color will be based on which mouse button was clicked
          if (evt.buttons === 1) {
            currColorArr = `${this.foregroundColor.r},${this.foregroundColor.g},${this.foregroundColor.b}`;
          } else if (evt.buttons === 2) {
            currColorArr = `${this.backgroundColor.r},${this.backgroundColor.g},${this.backgroundColor.b}`;
          }
          // find color index of new color in active color pallette
          let palletteIndex = pallette.indexOf(currColorArr);
          // if color index now found add new color
          if (palletteIndex < 0) {
            pallette.push(currColorArr)
            palletteIndex = pallette.length - 1;
            this.drawActiveColorPallette();
          }

          // update pixel color in led pixel array for current frame
          const fillColorIndex = pallette.indexOf(currColorArr);

          // update frame with an area fill using 'fillColorIndex' and starting from where the canvas was clicked
          this.fillFromPixel(index, fillColorIndex);

          // if sync enabled, update panel with changes
          if (this.ledCommand === "sync") {
            this.showLedPixels();
          }

        }
        break;

      case "brush":
      default:
        let currColorArr = null;
        // pick what the new color will be based on which mouse button was clicked
        if (evt.buttons === 1) {
          currColorArr = `${this.foregroundColor.r},${this.foregroundColor.g},${this.foregroundColor.b}`;
        } else if (evt.buttons === 2) {
          currColorArr = `${this.backgroundColor.r},${this.backgroundColor.g},${this.backgroundColor.b}`;
        }
        // find color index of new color in active color pallette
        let palletteIndex = pallette.indexOf(currColorArr);
        // if color index now found add new color
        if (palletteIndex < 0) {
          pallette.push(currColorArr)
          palletteIndex = pallette.length - 1;
          this.drawActiveColorPallette();
        }
        // update pixel color in led pixel array for current frame
        this.ledPixels[index] = palletteIndex;

        // if sync enabled, update panel with changes
        if (this.ledCommand === "sync") {
          this.showLedPixels();
        }

        break;


    }
  }

  /**
   * fill bucket tool. will fill a target area starting from pixel that was clicked.
   * this will call itself recursively in order to fill an area.
   * @param {*} pixelIndex - index of clicked pixel
   * @param {*} colorIndex - color to fill area to
   */
  fillFromPixel(pixelIndex, colorIndex) {
    // console.info('fill', pixelIndex, colorIndex);
    //set current pixel
    if (this.ledPixels[pixelIndex] === colorIndex) {
      return;
    }
    // set some color values
    const previousColorIndex = this.ledPixels[pixelIndex];
    this.ledPixels[pixelIndex] = colorIndex;

    // find neighbor pixels
    const leftPixel = this.ledPixels[pixelIndex - 1];
    const rightPixel = this.ledPixels[pixelIndex + 1];
    const topPixel = this.ledPixels[pixelIndex - this.panelWidth];
    const bottomPixel = this.ledPixels[pixelIndex + this.panelWidth];

    // find edge pixels to limit fill to
    const minHorizontalIndex = Math.floor(pixelIndex / this.panelWidth) * this.panelWidth;
    const maxHorizontalIndex = Math.ceil(pixelIndex / this.panelWidth) * this.panelWidth;
    const minVerticalIndex = pixelIndex - minHorizontalIndex;
    const maxVerticalIndex = (this.panelWidth * this.panelHeight) - (this.panelWidth - (pixelIndex - Math.floor(pixelIndex / this.panelWidth) * this.panelWidth) - 1);

    // fill to left from current pixel
    if (pixelIndex - 1 >= 0 && (pixelIndex - 1 >= minHorizontalIndex)) {
      if (leftPixel === previousColorIndex) {
        this.fillFromPixel(pixelIndex - 1, colorIndex);
      }
    }

    // fill to right
    if (pixelIndex + 1 < this.ledPixels.length && (pixelIndex + 1 < maxHorizontalIndex)) {
      if (rightPixel === previousColorIndex) {
        this.fillFromPixel(pixelIndex + 1, colorIndex);
      }
    }

    // fill up from current pixel
    if (pixelIndex - this.panelWidth >= 0 && (pixelIndex - this.panelWidth >= minVerticalIndex)) {
      if (topPixel === previousColorIndex) {
        // this.ledPixels[pixelIndex-this.panelWidth] = colorIndex;
        this.fillFromPixel(pixelIndex - this.panelWidth, colorIndex);
      }
    }

    // fill down from current pixel
    if (pixelIndex + this.panelWidth < this.ledPixels.length && (pixelIndex + this.panelWidth < maxVerticalIndex)) {
      if (bottomPixel === previousColorIndex) {
        // this.ledPixels[pixelIndex+this.panelWidth] = colorIndex;
        this.fillFromPixel(pixelIndex + this.panelWidth, colorIndex);
      }
    }

  }


  /**
   * update what is shown on LED panel. Used when sync enabled.
   * Node listens on this lane to know what to draw on the panels themselves
   */
  showLedPixels() {
    const animData = this.animationsList[this.selectedAnimation];
    const framesList = animData.frames;
    this.ledPixels = framesList[this.selectedFrame];

    this.client.command('setLedPixelIndexes', { panelId: this.currentPanelId, data: this.ledPixels.toString() });
  }

  /**
   * turn on ability to sync LED panel with what is shown on animation preview
   */
  syncPanelToPreview() {
    if (!this.syncPreview) {
      if (this.ledCommand === "play") {
        this.stopAnimationOnPanel();
      }
      this.syncPreview = true;
      this.client.command('setLedCommand', { panelId: this.currentPanelId, command: 'sync' });
      this.pushFrameSizeToPanel();
      this.pushPalletteToPanel();
      this.showLedPixels();

    } else {
      this.syncPreview = false;
      this.client.command('setLedCommand', { panelId: this.currentPanelId, command: 'stop' });

    }
  }

  /**
   * handle when the RGB sliders change
   */
  updateColorFromSlider() {
    const newR = document.getElementById("redInputRange").value;
    const newB = document.getElementById("blueInputRange").value;
    const newG = document.getElementById("greenInputRange").value;
    this.selectColor(Color.rgb(newR, newG, newB));
  }

  /**
   * handle when the RGB input fields change
   */
  updateSelectedColor() {
    const newR = document.getElementById("redInput").value;
    const newB = document.getElementById("blueInput").value;
    const newG = document.getElementById("greenInput").value;
    this.selectColor(Color.rgb(newR, newG, newB));
  }

  /**
   * Utility method to set all the pixels of the current frame to a specific color. defaults to black.
   * @param {*} color
   */
  clearLedPixels(color = "0,0,0") {
    let newArr = Array.apply(null, Array(this.panelWidth * this.panelHeight));
    if (color === "selected") {
      color = `${this.foregroundColor.r},${this.foregroundColor.g},${this.foregroundColor.b}`
    }
    const pallette = this.animationsList[this.selectedAnimation].pallette;
    let palletteIndex = pallette.indexOf(color);
    if (palletteIndex < 0) {
      pallette.push(color)
      palletteIndex = pallette.length - 1;
      this.drawActiveColorPallette();
    }

    this.ledPixels = newArr.map(() => palletteIndex);
    this.animationsList[this.selectedAnimation].frames[this.selectedFrame] = this.ledPixels;

    // if sync enabled, update panel with changes
    if (this.ledCommand === "sync") {
      this.showLedPixels();
    }

  }

  /**
   * Draw the elements which make up the frames list row in the preview
   */
  drawFramesListElements() {
    const animData = this.animationsList[this.selectedAnimation];
    const framesList = animData.frames;

    for (let i = 0; i < framesList.length; i++) {

      if (!this.frameDivCache[i]) {
        const tempDiv = document.createElement("div");
        tempDiv.addEventListener('click', (evt) => {
          this.selectFrame(i);
        });
        this.framesDiv.appendChild(tempDiv);

        this.frameDivCache[i] = tempDiv;
        if (i % 5 === (5 - 1) || i === 0 || i === (framesList.length - 1)) {
          tempDiv.innerHTML = (i + 1);
        } else {
          tempDiv.innerHTML = "&nbsp;";
        }
        tempDiv.innerHTML += "<div class='marker'>|</div><div class='frameBox'></div>";

      }

      const frameDiv = this.frameDivCache[i];

      if (this.selectedFrame === i) {
        frameDiv.className = "frame selected";
      } else {
        frameDiv.className = "frame";
      }

    }

    while (this.framesDiv.children.length > framesList.length) {
      delete this.frameDivCache[this.framesDiv.children.length - 1];
      this.framesDiv.removeChild(this.framesDiv.children[this.framesDiv.children.length - 1]);
    }


  }

  /**
   * handle selecting a new frame in the animation preview
   * @param {number} frameIndex
   */
  selectFrame(frameIndex) {
    if (frameIndex < 0) {
      frameIndex = 0;
    }
    if (frameIndex >= this.animationsList[this.selectedAnimation].frames.length) {
      frameIndex = this.animationsList[this.selectedAnimation].frames.length - 1;
    }
    this.selectedFrame = frameIndex;
    if (this.syncPreview) {
      this.showLedPixels();
    }

    this.drawFramesListElements();

  }

  /**
   * delete selected frame from current animation
   */
  deleteFrame() {
    const animData = this.animationsList[this.selectedAnimation];
    const framesList = animData.frames;
    if (this.selectedFrame != 0 || (this.selectedFrame == 0 && framesList.length > 1)) {
      const newFrameList = framesList.slice(0, (this.selectedFrame)).concat(framesList.slice(this.selectedFrame + 1, framesList.length));
      this.animationsList[this.selectedAnimation].frames = newFrameList
      this.selectFrame(this.selectedFrame - 1);
      this.drawFramesListElements();
    }
  }

  /**
   * add a new frame to current animation preview
   */
  addFrame() {
    let newArr = Array.apply(null, Array(this.panelWidth * this.panelHeight));
    let newFramePixels = newArr.map(() => 0);
    this.animationsList[this.selectedAnimation].frames.push(newFramePixels);
    this.selectFrame(this.animationsList[this.selectedAnimation].frames.length - 1);
    this.drawFramesListElements();

  }

  /**
   * duplicate current frame. This will append the duplicated frame to the end of the animation
   */
  duplicateFrame() {
    const newFrame = this.animationsList[this.selectedAnimation].frames[this.selectedFrame].slice()
    this.animationsList[this.selectedAnimation].frames.push(newFrame);
    this.selectFrame(this.animationsList[this.selectedAnimation].frames.length - 1);
    this.drawFramesListElements();

  }

  /**
   * Select an animation to display in the animation preview
   * @param {id} animKey
   */
  selectAnimation(animKey) {
    this.selectedAnimation = animKey

    document.getElementById("animName").value = this.animationsList[this.selectedAnimation].name;
    document.getElementById("nameIdValue").innerHTML = this.animationsList[this.selectedAnimation].id;

    document.getElementById("animSpeed").value = Math.round(1000 / this.animationsList[this.selectedAnimation].speed);
    this.selectFrame(0);
    for (let tempDiv of this.frameDivCache) {
      if (tempDiv) {
        this.framesDiv.removeChild(tempDiv);
        delete this.frameDivCache[tempDiv];

      }
    }
    this.frameDivCache = [];
    this.drawFramesListElements();
    this.framesDiv.scrollTo(0, 0)
    // this.drawPixels();
    this.drawActiveColorPallette();
    if (this.syncPreview) {
      this.showLedPixels();
    }

  }

  /**
   * util to push current active pallette to selected panel
   */
  pushPalletteToPanel() {
    this.client.command('setColorPallette', { panelId: this.currentPanelId, pallette: this.animationsList[this.selectedAnimation].pallette });
  }

  pushFrameSizeToPanel() {
    const animData = this.animationsList[this.selectedAnimation];
    this.client.command('setFrameSize', { panelId: this.currentPanelId, width: animData.frameWidth, height: animData.frameHeight });
  }

  /**
   * util to push current animation preview to panel
   */
  pushAnimationToPanel() {
    this.client.command('setActiveAnimation', { panelId: this.currentPanelId, animation: this.animationsList[this.selectedAnimation] });
  }

  /**
   * change panel command state to play. This should make it play whatever the active animation on the panel is.
   */
  playAnimationOnPanel() {
    this.client.command('setLedCommand', { panelId: this.currentPanelId, command: 'play' });
  }

  /**
   * change panel state to stop. stops animations or sync.
   */
  stopAnimationOnPanel() {
    this.client.command('setLedCommand', { panelId: this.currentPanelId, command: 'stop' });
  }

  /**
   * method called by button in ui to toggle panel animation state
   */
  togglePanelAnimationState() {
    if (this.syncPreview) {
      this.syncPanelToPreview(); // this will stop sync if active
    }

    if (this.ledCommand === "stop") {
      this.playAnimationOnPanel();
      // document.getElementById("animPlayButton").value = "Stop";
    } else {
      this.stopAnimationOnPanel();
      // document.getElementById("animPlayButton").value = "Play";
    }

  }

  /**
   * play the current active action in the preview panel
   * this mostly just ticks forward the current frame number
   * actual rendering is done in the main animation loop
   */
  playAnimationPreview() {
    this.stopAnimationPreview();
    const playButton = document.getElementById("playButton");
    playButton.innerText = "stop";
    playButton.className = "material-icons on"

    let nextFrame = this.selectedFrame + 1;
    let totalFrames = this.animationsList[this.selectedAnimation].frames.length;
    if (nextFrame >= totalFrames) {
      nextFrame = 0;
    }
    this.selectFrame(nextFrame);

    this.animationTimer = setTimeout(this.playAnimationPreview.bind(this), this.animationsList[this.selectedAnimation].speed);

  }

  /**
   * stop animation playing in preview panel
   */
  stopAnimationPreview() {
    clearInterval(this.animationTimer);
    this.animationTimer = null;
    const playButton = document.getElementById("playButton");
    playButton.innerText = "play_arrow";
    playButton.className = "material-icons";

  }

  /**
   * called by button in ui to toggle preview animation state
   */
  toggleAnimationPreview() {
    if (this.animationsList[this.selectedAnimation].frames.length <= 1) {
      return false;
    }
    if (this.animationTimer === null) {
      this.playAnimationPreview();

    } else {
      this.stopAnimationPreview();

    }
  }

  /**
   * Called when clicking on a color chip in either pallette
   * this will update selectedColor to be the color clicked
   * @param {*} color
   */
  selectColor(color = Color.rgb(255, 255, 255)) {
    // this.selectedColor = Color.rgb(newR, newG, newB);
    if (this.isFgColorActive) {
      this.foregroundColor = color;
      document.getElementById("foregroundColorChip").style.backgroundColor = `rgb(${this.foregroundColor.r},${this.foregroundColor.g},${this.foregroundColor.b})`
      document.getElementById('redInput').value = Math.round(this.foregroundColor.r);
      document.getElementById('redInputRange').value = Math.round(this.foregroundColor.r);
      document.getElementById('greenInput').value = Math.round(this.foregroundColor.g);
      document.getElementById('greenInputRange').value = Math.round(this.foregroundColor.g);
      document.getElementById('blueInput').value = Math.round(this.foregroundColor.b);
      document.getElementById('blueInputRange').value = Math.round(this.foregroundColor.b);
    } else {
      this.backgroundColor = color;
      document.getElementById("backgroundColorChip").style.backgroundColor = `rgb(${this.backgroundColor.r},${this.backgroundColor.g},${this.backgroundColor.b})`
      document.getElementById('redInput').value = Math.round(this.backgroundColor.r);
      document.getElementById('redInputRange').value = Math.round(this.backgroundColor.r);
      document.getElementById('greenInput').value = Math.round(this.backgroundColor.g);
      document.getElementById('greenInputRange').value = Math.round(this.backgroundColor.g);
      document.getElementById('blueInput').value = Math.round(this.backgroundColor.b);
      document.getElementById('blueInputRange').value = Math.round(this.backgroundColor.b);

    }
  }

  toggleFgColorActive() {
    this.isFgColorActive = !this.isFgColorActive;
    document.getElementById("backgroundColorChip").style.zIndex = this.isFgColorActive ? 0 : 1;
    this.selectColor(this.isFgColorActive ? this.foregroundColor : this.backgroundColor);
  }

  /**
   * draw the 'full' rainbow color pallette
   * adjusting the totalColors value will change the total number of color chips rendered
   * into the full color pallette. The code will do its best to provide a full range of colors and shades
   * which fit into that total number. There will always be an additional greyscale row.
   * Values less then 32 or greater then 462 are a bit useless.
   * examples:
   *    32 chips = 6 colors w/ 5 shades each
   *    132 chips = 12 colors w/ 11 shades each
   *    256 chips = 16 colors w/ 16 shades each
   *    462 chip = 22 colors w/ 21 shades each
   */
  drawFullColorPallette() {
    const totalColors = 462;
    const palletteDiv = document.getElementById("colorPallette");
    const totalShades = Math.floor(Math.sqrt(totalColors));
    const palletteWidth = palletteDiv.offsetWidth;
    const colorChipSize = Math.floor(palletteWidth / totalShades);
    let currHue = null;
    let currShade = null;
    let totalChips = 0;
    palletteDiv.innerHTML = ""; // lazy clear the parent div

    // render greys
    for (let i = 0; i < totalShades; i++) {
      const currGrey = Math.round(Utils.interpolate(255, 0, i, totalShades - 1));
      const newColor = Color.rgb(currGrey, currGrey, currGrey);
      const newColorChip = document.createElement("div");
      newColorChip.id = `colorChip-${totalChips}`;
      newColorChip.style.backgroundColor = `rgb(${newColor.r}, ${newColor.g}, ${newColor.b})`
      newColorChip.style.height = newColorChip.style.width = `${colorChipSize}px`;
      newColorChip.addEventListener('mousedown', (evt) => {
        page.selectColor(newColor);
      });
      palletteDiv.appendChild(newColorChip);
      totalChips++;
    }

    //render colors
    for (let i = 0; i < totalColors; i++) {

      if (i % totalShades === 0) {
        currHue = Utils.interpolate(0, 360, i, totalColors);
      }
      currShade = Utils.interpolate(.9, 0, i % totalShades, totalShades);
      const newColor = Color.hsl(currHue, 1, currShade).rgb();
      newColor.r = Math.round(newColor.r);
      newColor.g = Math.round(newColor.g);
      newColor.b = Math.round(newColor.b);
      const newColorChip = document.createElement("div");
      newColorChip.id = `colorChip-${totalChips}`;
      newColorChip.style.backgroundColor = `rgb(${newColor.r}, ${newColor.g}, ${newColor.b})`
      newColorChip.style.height = newColorChip.style.width = `${colorChipSize}px`;
      newColorChip.addEventListener('mouseup', (evt) => {
        page.selectColor(newColor);
      });

      palletteDiv.appendChild(newColorChip);
      totalChips++;
    }
  }

  /**
   * draw the active color pallette. This should be every unique color in the selected animation.
   */
  drawActiveColorPallette() {
    const pallette = this.animationsList[this.selectedAnimation].pallette;
    const palletteDiv = document.getElementById("activePallette");
    const palletteWidth = palletteDiv.offsetWidth;
    const colorChipSize = 12;
    let totalChips = 0;

    palletteDiv.innerHTML = "";
    for (let i = 0; i < pallette.length; i++) {
      const colorArr = pallette[i].split(",");
      const currColor = Color.rgb(colorArr[0], colorArr[1], colorArr[2]);
      const newColorChip = document.createElement("div");
      // newColorChip.className = (this.selectedColor && this.selectedColor.equals(currColor)) ? "selectedColor" : "";
      newColorChip.id = `colorChip2-${totalChips}`;
      newColorChip.style.backgroundColor = `rgb(${currColor.r}, ${currColor.g}, ${currColor.b})`
      newColorChip.style.height = newColorChip.style.width = `${colorChipSize}px`;
      newColorChip.addEventListener('mouseup', (evt) => {
        page.selectColor(currColor);
      });

      palletteDiv.appendChild(newColorChip);
      totalChips++;
    }
    if (this.ledCommand === "sync") {
      this.pushPalletteToPanel();
      this.pushFrameSizeToPanel();
    }

  }

  /**
   * refresh the animation list dropdown in the load dialog
   * this happens in the background so the dialog is always update to date when shown
   */
  updateAnimationList() {
    const selectBox = document.getElementById("animationList")
    selectBox.innerHTML = "";
    // Show local animations (full data, currently loaded/editing)
    for (let animKey in this.animationsList) {
      const newOpt = document.createElement("option");
      const currAnim = this.animationsList[animKey];
      newOpt.innerText = currAnim.name;
      newOpt.value = currAnim.id;
      if (this.selectedAnimation == currAnim.id) {
        newOpt.selected = true;
      }
      selectBox.appendChild(newOpt);
    }
    // Show server-saved animations not already loaded locally
    for (let animKey in this.serverAnimationSummaries) {
      if (this.animationsList[animKey]) continue;
      const newOpt = document.createElement("option");
      const currAnim = this.serverAnimationSummaries[animKey];
      newOpt.innerText = currAnim.name;
      newOpt.value = currAnim.id;
      if (this.selectedAnimation == currAnim.id) {
        newOpt.selected = true;
      }
      selectBox.appendChild(newOpt);
    }
  }

  /**
   * Update the list of panels sent from the server
   * this will render the panel listing the panel section of the page
   */
  updatePanelList() {
    const mainDiv = document.getElementById("mainPanelList");

    mainDiv.innerHTML = "";

    for (let panelKey in this.panelList) {
      const currPanel = this.panelList[panelKey];
      const newRow = document.createElement("div");
      newRow.onmousedown = () => {
        this.selectPanel(panelKey);
      }
      newRow.className = "panelRow";
      if (this.currentPanelId == currPanel.id) {
        newRow.className += " selectedPanel";
      }

      const nameDiv = document.createElement("div");
      nameDiv.innerHTML = `${currPanel.name}`;
      newRow.appendChild(nameDiv);

      const sizeDiv = document.createElement("div");
      const width = currPanel.width * (currPanel.parallel || 1);
      sizeDiv.innerHTML = `${width}px x ${currPanel.height}px`;
      newRow.appendChild(sizeDiv);

      const commandDiv = document.createElement("div");
      commandDiv.innerText = `Command: ${currPanel.ledCommand || 'stop'}`;
      newRow.appendChild(commandDiv);

      mainDiv.appendChild(newRow);

    }

  }

  /**
   * create a new empty animation and set it as active
   */
  newAnimation() {
    const animForm = document.getElementById("newAnimationForm");
    if (animForm) {
      this.panelWidth = parseInt(animForm.elements.animWidth.value) || 32;
      this.panelHeight = parseInt(animForm.elements.animHeight.value) || 32;
    }
    this.zoomLevel = 1;

    const newAnimId = Utils.newGuid();
    const newArr = Array.apply(null, Array(this.panelWidth * this.panelHeight));

    const newAnimData = {
      id: newAnimId,
      name: "New Animation",
      speed: 66,
      loop: true,
      frameWidth: this.panelWidth,
      frameHeight: this.panelHeight,
      frames: [newArr.map(() => 0)],
      pallette: ["0,0,0"]
    }
    this.animationsList[newAnimId] = newAnimData;
    this.selectAnimation(newAnimId);
    this.handleResize();
    this.closeDialog();
  }

  /**
   * load selected animation into preview
   */
  loadAnimation() {
    const dropdown = document.getElementById("animationList");
    const selectedAnim = dropdown[dropdown.selectedIndex].value;

    // If animation is already loaded locally, select it directly
    if (this.animationsList[selectedAnim]) {
      this.selectAnimation(selectedAnim);
      this.stopAnimationPreview();
      this.dialog.close();
      return;
    }

    // Fetch full animation data from server
    this.client.command('getAnimation', { id: selectedAnim }).then((result) => {
      if (result.animation) {
        migrateAnimationFormat(result.animation);
        this.animationsList[selectedAnim] = result.animation;
        this.selectAnimation(selectedAnim);
        this.stopAnimationPreview();
        this.dialog.close();
      } else {
        console.error('[loadAnimation] Failed to load animation:', result.error);
      }
    });
  }

  /**
   * save current preview animation to server
   */
  saveAnimation() {
    if (this.animationsList[this.selectedAnimation].name !== "New Animation") {
      this.client.command('saveAnimation', {
        id: this.selectedAnimation,
        data: this.animationsList[this.selectedAnimation]
      });
    } else {
      console.error("new animation")
    }
  }

  /**
   * save current animation to local filesystem as a .js module file
   */
  async saveAnimationToFile() {
    const animData = this.animationsList[this.selectedAnimation];
    const animName = animData.name.replace(/\s+/g, "");
    const fileContent = `const ${animName} = ${JSON.stringify(animData)}; module.exports = ${animName};`;
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: `${animName}.js`,
        types: [{ description: "JavaScript file", accept: { "text/javascript": [".js"] } }],
      });
      const stream = await handle.createWritable();
      await stream.write(fileContent);
      await stream.close();
    } catch (err) {
      if (err.name !== 'AbortError') console.error('[saveAnimationToFile]', err);
    }
  }

  /**
   * load animation from local filesystem (.js module file)
   */
  async loadAnimationFromFile() {
    this.stopAnimationPreview();
    try {
      const [fileHandle] = await window.showOpenFilePicker();
      const file = await fileHandle.getFile();
      const contents = await file.text();
      const data = contents.substring(contents.indexOf("{"), contents.lastIndexOf("}") + 1);
      const animData = JSON.parse(data);
      migrateAnimationFormat(animData);
      this.animationsList[animData.id] = animData;
      this.panelWidth = animData.frameWidth;
      this.panelHeight = animData.frameHeight;
      this.zoomLevel = 1;
      this.selectAnimation(animData.id);
      this.updateAnimationList();
      this.handleResize();
    } catch (err) {
      if (err.name !== 'AbortError') console.error('[loadAnimationFromFile]', err);
    }
  }

  /**
   * update current animation name from name input field
   */
  updateName() {
    const newName = document.getElementById("animName").value;
    this.animationsList[this.selectedAnimation].name = newName;
  }

  /**
   * update current animation speed from speed input field
   */
  updateSpeed() {
    const newSpeed = Math.ceil(1000 / document.getElementById("animSpeed").value);
    this.animationsList[this.selectedAnimation].speed = newSpeed;
    if (this.animationTimer !== null) {
      this.playAnimationPreview();
    }
  }

  /**
   * show overlay dialog
   * @param {*} dialogId
   */
  showDialog(dialogId) {
    this.dialog.open(dialogId);
  }

  /**
   * hide overlay dialog
   */
  closeDialog() {
    this.dialog.close();
  }


  /**
   * start keypress listener to handle keyboard shortcuts
   */
  keyPressHandler() {
    document.onkeydown = (key) => {
      // console.info(key.code)
      const ctrlDown = key.ctrlKey;
      switch (key.code) {
        case "KeyB":
          if (key.target.id == "") {
            this.selectTool('brush');
            key.preventDefault();
            key.stopPropagation();

          }
          break;

        case "KeyE":
          if (key.target.id == "") {
            this.selectTool('eraser');
            key.preventDefault();
            key.stopPropagation();

          }
          break;

        case "KeyI":
          if (key.target.id == "") {
            this.selectTool('dropper');
            key.preventDefault();
            key.stopPropagation();

          }
          break;

        case "KeyG":
        case "KeyF":
          if (key.target.id == "") {
            this.selectTool('fill');
            key.preventDefault();
            key.stopPropagation();

          }
          break;

        case "KeyP":
        case "Space":
          if (key.target.id == "") {
            this.toggleAnimationPreview();
            key.preventDefault();
            key.stopPropagation();

          }
          break;

        case "Comma":
          if (key.target.id == "") {
            this.selectFrame(this.selectedFrame - 1)
            key.preventDefault();
            key.stopPropagation();

          }
          break;

        case "Period":
          if (key.target.id == "") {
            this.selectFrame(this.selectedFrame + 1)
            key.preventDefault();
            key.stopPropagation();

          }
          break;

        case "Enter":
          if (key.target.id != "") {
            key.target.blur();
            if (key.target.id === "animationList") {
              this.loadAnimation();
            }
          }
          break;

        case "KeyS":
          if (ctrlDown && key.shiftKey) {
            this.saveAnimationToFile();
            key.preventDefault();
            key.stopPropagation();
          } else if (ctrlDown) {
            this.saveAnimation();
            key.preventDefault();
            key.stopPropagation();
          }
          break;
        case "KeyL":
          if (ctrlDown) {
            this.showDialog('loadFileDialog');
            document.getElementById("animationList").focus();
            key.preventDefault();
            key.stopPropagation();

          }
          break;

          // case "KeyN":
          //     if (ctrlDown) {
          //       key.preventDefault();
          //       key.stopPropagation();
          //       this.newAnimation();
          //       document.getElementById("animationList").focus();

          //     }
          //     break;

        case "Equal":
        case "NumpadAdd":
          if (key.target.id == "") {
            this.zoomIn();
            key.preventDefault();
            key.stopPropagation();
          }
          break;

        case "Minus":
        case "NumpadSubtract":
          if (key.target.id == "") {
            this.zoomOut();
            key.preventDefault();
            key.stopPropagation();
          }
          break;

        case "Digit0":
          if (key.target.id == "") {
            this.zoomReset();
            key.preventDefault();
            key.stopPropagation();
          }
          break;

      }
    }
  }

  /**
   * Import animation button handler
   * @param {*} evt
   */
  importAnimation(evt) {
    // const localFilePath = document.getElementById("gifImportButton").value;
    this.dialog.setTitle("Import Animation");
    const fileBlob = evt.target.files[0];
    const onImport = (newAnim) => {
      console.info('[index]', newAnim);
      this.animationsList[newAnim.id] = newAnim;
      this.updateAnimationList();
      this.dialog.close();
      this.selectAnimation(newAnim.id);

    }
    const onUpdate = (updateStr) => {
      this.dialog.setTitle(updateStr);
    }

    this.importUtil.readFile(fileBlob, onImport, onUpdate);

  }
}

/**
 * utility class to handle importing animations from gifs and piskels
 */
class ImportUtil {

  constructor() {

  }

  readFile(fileBlob, onImport, onUpdate) {

    const fileName = fileBlob.name;
    const fileNameArr = fileName.split(".")
    const fileType = fileNameArr[fileNameArr.length-1];
    const reader = new FileReader();

    if(onUpdate) {
      onUpdate(`Running .${fileType} import`);
    }

    reader.onload = ((fileBlob) => {
      return (fileData) => {
        switch(fileType) {
          case "gif":
            this.importGif(fileName, fileData, onImport, onUpdate);
            break;
          case "piskel":
            this.importPiskel(fileName, fileData, onImport, onUpdate);
            break;

        }

      };
    })(fileBlob);

    if(fileType === "piskel") {
      reader.readAsText(fileBlob);
    } else {
      reader.readAsDataURL(fileBlob);
    }
    //

  }

  importGif(fileName, fileData, onImport, onUpdate) {

    const img = new Image();
    img.src = fileData.target.result;
    document.getElementById("offscreenCanvas").appendChild(img);

    const newId = Utils.newGuid();
    const frameWidth = img.width;
    const frameHeight = img.height;
    const newAnim = {
      "id": newId,
      "name": fileName,
      "speed": 40,
      "loop": true,
      "frameWidth": frameWidth,
      "frameHeight": frameHeight,
      "frames": [],
    }
    const pallette = [];

    const sgif = window.SuperGif({
      gif: img
    }, false, false);

    sgif.load(() => {
      const canvasContext = sgif.get_canvas().getContext("2d");
      // foreach frame in gif
      for(let z=0; z<sgif.get_length(); z++) {
        sgif.move_to(z);

        // console.info(`Read frame #${z}`);
        if(onUpdate) {
          onUpdate(`Read frame #${z}`);
        }

        const newFrame = [];
        const canvasWidth = img.width;
        const canvasHeight = img.height;
        newAnim.frameWidth = canvasWidth;
        newAnim.frameHeight = canvasHeight;
        const totalPixels = canvasWidth * canvasHeight;
        let row = -1;
        let rowIndex = 0;

        // foreach pixel in frame
        for (let i = 0; i < totalPixels; i++) {
          if (i % canvasWidth == 0) {
            row++;
            rowIndex = 0;
          }
          let x = rowIndex;
          let y = row;

          let pixelData = canvasContext.getImageData(x, y, 1, 1).data;

          const currColorStr = [pixelData[0], pixelData[1], pixelData[2]].toString();
          if (pallette.indexOf(currColorStr) === -1) {
            pallette.push(currColorStr);
          }
          const colorIndex = pallette.indexOf(currColorStr);
          newFrame.push(colorIndex);
          // console.info(x, y, frame, row);
          rowIndex++;
        }
        // newAnim.frames.push(JSON.stringify(newFrame));
        newAnim.frames.push(newFrame);

      }
      if(onUpdate) {
        onUpdate(`Finalize Import`);
      }

      newAnim.pallette = pallette;
      if(onImport) {
        if(onUpdate) {
          onUpdate(`Import Complete`);
        }
        onImport(newAnim);
      }
    });
  }

  importPiskel(fileName, fileData, onImport, onUpdate) {
    const newId = Utils.newGuid();
    const piskelData = JSON.parse(fileData.target.result).piskel;
    const frameWidth = piskelData.width;
    const frameHeight = piskelData.height;

    const newAnim = {
      "id": newId,
      "name": piskelData.name,
      "speed": 1000 / piskelData.fps,
      "loop": true,
      "frameWidth": frameWidth,
      "frameHeight": frameHeight,
      "frames": [],
    }
    const debugArea = document.getElementById("offscreenCanvas");
    const newCanvas = document.createElement("canvas");
    // for(let layerId in piskelData.layers) {
    const currLayer = JSON.parse(piskelData.layers[0]);
    const frameCount = currLayer.frameCount;
    const canvasWidth = frameWidth * frameCount;
    const canvasHeight = frameHeight;
    const tempImg = new Image();
    const pallette = [];

    tempImg.onload = (() => {
      newCanvas.width = canvasWidth;
      newCanvas.height = canvasHeight;
      debugArea.appendChild(newCanvas);
      const canvasContext = newCanvas.getContext("2d");
      canvasContext.drawImage(tempImg, 0, 0, canvasWidth, canvasHeight);

      const totalPixels = canvasWidth * canvasHeight;
      let frame = 0
      let row = -1;
      let rowIndex = 0;
      let newFrames = [];
      let newFramesByIndex = [];
      for (let i = 0; i < totalPixels; i++) {
        if (i % frameWidth === 0) {
          frame++;
        }
        if (i % canvasWidth == 0) {
          row++;
          frame = 0;
          rowIndex = 0;
        }
        let x = rowIndex;
        let y = row;
        let pixelData = canvasContext.getImageData(x, y, 1, 1).data;

        if (!newFrames[frame]) {
          newFrames[frame] = [];
        }
        if (!newFramesByIndex[frame]) {
          newFramesByIndex[frame] = [];
        }

        const currColorStr = [pixelData[0], pixelData[1], pixelData[2]].toString();
        if (pallette.indexOf(currColorStr) === -1) {
          pallette.push(currColorStr);
        }
        const colorIndex = pallette.indexOf(currColorStr);
        newFramesByIndex[frame].push(colorIndex);
        rowIndex++;
        // console.info(x, y, frame, row);
      }
      newAnim.frames = newFramesByIndex;
      newAnim.pallette = pallette;
      if(onImport) {
        onImport(newAnim);
      }

      // this.animationsList[newId] = newAnim;
      // this.updateAnimationList();
    })
    tempImg.src = currLayer.chunks[0].base64PNG;
  }
}

/**
 * Helper class to manage the overlay dialog
 */
class Dialog {

  bgDiv = null;
  contentDiv = null;
  titleDiv = null;


  constructor(bgId, contentId, titleId) {
    this.bgDiv = document.getElementById(bgId);
    this.contentDiv = document.getElementById(contentId);
    this.titleDiv = document.getElementById(titleId);
    this.bgDiv.style.opacity = 0;
    this.bgDiv.style.display = "none";
  }

  open(dialogId) {
    this.bgDiv.style.display = "block";
    this.bgDiv.style.opacity = 1;
    switch (dialogId) {
      case "load":
        this.titleDiv.innerText = "Load Animation";
        break;
    }
    for (let i = 0; i < this.contentDiv.children.length; i++) {
      const currChild = this.contentDiv.children[i];
      if (currChild.id === dialogId) {
        currChild.style.display = "block";
      } else {
        currChild.style.display = "none";
      }
    }

  }

  close() {
    this.bgDiv.style.opacity = 0;
    setTimeout(() => {
      this.bgDiv.style.display = "none";
    }, 100);


  }

  setTitle(newStr) {
    this.titleDiv.innerText = newStr;
  }

}

/**
 * random helpful utilities used on the page
 */
Utils = {
  newGuid: () => {
    return 'xxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0;
      const v = (c === 'x') ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  },

  interpolate(startValue, endValue, stepNumber, lastStepNumber) {
    return (endValue - startValue) * stepNumber / lastStepNumber + startValue;
  },

  setCookie: (cookieName, cookieValue, expireDays) => {
    var newDate = new Date();
    newDate.setTime(newDate.getTime() + (expireDays * 24 * 60 * 60 * 1000));
    var expires = "expires=" + newDate.toUTCString();
    document.cookie = cookieName + "=" + cookieValue + ";" + expires + ";path=/";
  },

  getCookie: (cookieName) => {
    var name = cookieName + "=";
    var decodedCookie = decodeURIComponent(document.cookie);
    var cookieValues = decodedCookie.split('=');
    if (cookieValues.length === 2) {
      return cookieValues[1];
    }
    return "";
  }
}
