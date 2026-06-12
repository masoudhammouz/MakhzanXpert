# MakhzanXpert

MakhzanXpert is a warehouse automation project with a React/Firebase website, a Raspberry Pi OCR and queue controller, an ESP32 HTTP bridge, and an Arduino Mega mechanical controller.

## Repository Layout

```text
MakhzanXpert/
├── arduino/
│   └── mega_controller.ino
├── esp32/
│   └── esp32_firebase_bridge.ino
├── raspberry/
│   └── raspberry_ocr_firebase.py
├── website/
│   └── React + Firebase website
└── docs/
    ├── system_architecture.md
    ├── communication_protocol.md
    └── command_map.md
```

## Final Architecture

```text
Website / Firebase -> Raspberry Pi -> ESP32 /go -> Arduino Mega
```

The Raspberry Pi is the main brain:

- Runs camera OCR.
- Uses SQLite as local source of truth.
- Selects and reserves storage locations.
- Manages store and pick queues.
- Sends `GO 1` through `GO 18` to ESP32 over HTTP.
- Syncs status, queues, scans, and inventory state to Firebase.

The ESP32 is a bridge:

- Receives `GET /go?position=X&source=raspberry&queueId=Y`.
- Sends `GO X` to Arduino Mega over Serial2.
- Waits for Arduino `DONE`, `DONE:X`, or `ERROR:message`.
- Returns JSON to the Raspberry Pi.

The Arduino Mega is mechanical only.

## Website

The website lives in `website/`.

Run locally:

```bash
cd website
npm run dev
```

Build:

```bash
cd website
npm run build
```

## Firebase Collections

- `settings/system`
- `locations`
- `scans`
- `storeQueue`
- `pickQueue`
- `pickRequests`
- `commands`
- `inventory/boxes`
- `sensorReadings`
- `devices`
- `activityLog`
- `systemActivity`
- `orders`
- `products`

## Movement Model

There are 9 real storage locations and 18 movement positions.

```text
Location 1: IN = GO 1,  OUT = GO 2
Location 2: IN = GO 3,  OUT = GO 4
Location 3: IN = GO 5,  OUT = GO 6
Location 4: IN = GO 7,  OUT = GO 8
Location 5: IN = GO 9,  OUT = GO 10
Location 6: IN = GO 11, OUT = GO 12
Location 7: IN = GO 13, OUT = GO 14
Location 8: IN = GO 15, OUT = GO 16
Location 9: IN = GO 17, OUT = GO 18
```

Do not treat `GO 1` through `GO 18` as warehouse locations. Warehouse locations are only `1` through `9`.

More detail is in:

- `docs/system_architecture.md`
- `docs/communication_protocol.md`
- `docs/command_map.md`
