# LED Animator

LED panel animation editor and playback engine, built as a [LatticeSpark](https://github.com/sclarke27/latticeSpark) module.

Create pixel animations in a browser-based editor and play them back on physical LED panels (RGB matrix, SenseHAT, Matrix Creator) connected via Raspberry Pi.

## Architecture

```
Browser UI ←→ Socket.IO ←→ LatticeSpark Module ←→ Socket.IO ←→ Node.js Hardware Client (RPi)
```

The project has two parts:

- **`module/`** — LatticeSpark module with server logic, web UI, and animation storage. Deployed to a latticeSpark instance.
- **`node/`** — Hardware client that runs on each Raspberry Pi with an LED panel. Receives pixel data from the module via Socket.IO.

## Module Deployment

### Deploy script

```bash
./deploy.sh /path/to/latticeSpark
```

Or set the `LATTICESPARK_HOME` environment variable:

```bash
export LATTICESPARK_HOME=/path/to/latticeSpark
./deploy.sh
```

### Manual deployment

```bash
cp -r module/ /path/to/latticeSpark/modules/led-animator/
```

### Live reload (if latticeSpark is already running)

```bash
curl -X POST http://localhost:3002/api/modules/rescan
```

### Remote deployment via hub

ZIP the `module/` directory and POST to the fleet API:

```bash
cd module && zip -r ../led-animator.zip . && cd ..
# Upload via fleet API
```

## Hardware Client Setup

The hardware client runs on each Raspberry Pi connected to an LED panel.

### Install

```bash
cd node
npm install
```

### Configure

Edit `config/panel1.json` (or create a new config file):

```json
{
    "name": "My Panel",
    "id": "mypanel",
    "width": 32,
    "height": 32,
    "moduleServiceUrl": "http://192.168.1.71:3002",
    "panelType": "rpi-rgb-led-matrix",
    "chained": 1,
    "parallel": 1,
    "brightness": 100,
    "hardwareMapping": "adafruit-hat-pwm",
    "rgbSequence": "RGB"
}
```

Set `moduleServiceUrl` to point to your latticeSpark instance's module-service (port 3002).

#### Panel Types

| `panelType` | Hardware | Extra Config |
|---|---|---|
| `rpi-rgb-led-matrix` | RGB LED matrix via GPIO hat | `chained`, `parallel`, `brightness`, `hardwareMapping`, `rgbSequence`, `cmdLineArgs` |
| `sensehat` | Raspberry Pi Sense HAT (8x8) | `rotation` |
| `matrixCreator` | Matrix Creator (35x1) | — |
| `none` | No hardware (testing only) | — |

### Run with PM2

```bash
pm2 start main.js --name led-panel -- config=panel1
pm2 save
pm2 startup  # auto-start on boot
```

#### Multiple panels

```bash
pm2 start main.js --name led-panel-1 -- config=panel1
pm2 start main.js --name led-panel-2 -- config=panel2
pm2 save
```

#### Management

```bash
pm2 logs led-panel        # view logs
pm2 restart led-panel     # restart
pm2 stop led-panel        # stop
```

### Run directly (development)

```bash
node main.js config=panel1
```

## UI Features

The web UI is served by latticeSpark at `/module-ui/led-animator/` and provides:

- Canvas-based pixel editor for creating animations
- Frame management (add, copy, delete frames)
- Color palette with HSL picker
- GIF import
- Animation save/load
- Multi-panel management
- Play/stop/sync modes for live preview on hardware
- Resize animations

## Project Structure

```
led-animator/
├── module/                    # LatticeSpark module (deploy this)
│   ├── module.json
│   ├── led-animator.module.js
│   ├── ui/                    # Web UI
│   │   ├── index.html
│   │   └── assets/
│   └── animations/            # Saved animation JSON files
├── node/                      # Hardware client (runs on RPi)
│   ├── main.js
│   ├── package.json
│   └── config/
├── deploy.sh
└── README.md
```

## License

ISC
