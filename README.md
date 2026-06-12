# MakhzanXpert

MakhzanXpert is a warehouse automation project with a React/Firebase website, an ESP32 bridge, an Arduino Mega motion controller, and a Raspberry Pi OCR station.

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

The ESP32, Arduino Mega, and Raspberry Pi OCR source files are now included.

## Current Architecture

```text
Website -> Firebase Firestore -> ESP32 bridge -> Arduino Mega over UART
Raspberry Pi OCR -> ESP32 bridge HTTP label endpoint -> Firebase/Arduino Mega
```

Return path:

```text
Arduino Mega -> ESP32 -> Firebase -> Website
```

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

## Main Firestore Collections

- `commands`
- `locations`
- `settings/system`
- `sensorReadings`
- `devices`
- `systemActivity`
- `orders`
- `products`

More detail is documented in:

- `docs/system_architecture.md`
- `docs/communication_protocol.md`
- `docs/command_map.md`

## Current Command Direction

The desired unified movement language is `GO 1` through `GO 18`.

The physical warehouse has 9 storage locations. Each physical location has two movement points:

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

Website commands are represented in Firestore with:

```js
{
  type: "GO",
  position: 1,
  arduinoCommand: "GO 1",
  status: "pending",
  source: "website",
  deviceId: "esp-main-01",
  createdAt: serverTimestamp()
}
```

## Important Notes

- Movement points `1` through `18` are universal across Website, ESP32, and Arduino Mega.
- Firebase `locations/1` through `locations/9` represent physical storage locations, not movement points.
- The website currently creates `commands` documents from manual admin controls and order preparation.
- ESP32 and Arduino implementations are included and follow the `GO 1` through `GO 18` command path.
- Raspberry Pi no longer connects to Firebase directly and no longer chooses positions. It sends confirmed OCR labels to ESP32 with `POST /raspberry-label`; ESP32 reads Firebase locations/settings, selects a free position, then sends `GO X` to Arduino Mega.
- Prototype IR placement verification exists only for physical locations 7, 8, and 9. Locations 1 through 6 are treated as successful when Arduino returns `DONE:X`.
- The relay belt command is currently a hardware toggle. `BELT_START` and `BELT_STOP` should be treated as UI labels until deterministic relay state logic is designed and tested.
- ESP32 updates warehouse `locations`, but it does not currently increase product stock/quantity in the `products` collection after OCR placement.
