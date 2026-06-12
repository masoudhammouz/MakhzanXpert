# Communication Protocol

## Universal Movement Rule

Movement points `1` through `18` are the universal Arduino movement commands.

The physical warehouse has 9 storage locations. Each physical location has an IN movement and an OUT movement:

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

Do not use:

- `P 1`
- `P1 IN`
- `SITE 1`
- `location` as the command target

Use only:

```text
GO 1
GO 2
...
GO 18
```

## Command Flow

```text
Website -> Firestore commands -> ESP32 -> Arduino Mega
Raspberry Pi OCR -> ESP32 HTTP -> Firebase/Arduino Mega
```

## Firestore Command Document

Collection:

```text
commands
```

Document shape:

```js
{
  type: "GO",
  position: 1,
  arduinoCommand: "GO 1",
  status: "pending",
  source: "website",
  deviceId: "esp-main-01",
  brand: "optional string",
  model: "optional string",
  color: "optional string",
  size: "optional string",
  createdAt: serverTimestamp()
}
```

Allowed Firestore `source` values:

```text
website
raspberry
```

`raspberry` is not written to Firestore by the Raspberry Pi script directly. Raspberry sends label data to ESP32, then ESP32 creates/updates Firebase command/activity records with `source: "raspberry"`.

## Raspberry Direct ESP32 Request

Endpoint:

```text
POST http://<esp32-ip>/raspberry-label
```

Request body:

```json
{
  "brand": "NIKE",
  "model": "AIR MAX",
  "color": "WHITE",
  "size": "42",
  "source": "raspberry"
}
```

ESP32 behavior:

```text
Validate label fields
Read settings/system
Read physical locations/1..9
Choose a free physical location
Return HTTP 409 if no free position exists
Create/update Firebase command/activity status
Build GO X from selected physical location's IN movement point
Send GO X to Arduino Mega over Serial2
Wait for DONE or DONE:X
Update locations/<physicalLocation> in Firestore after success
Return JSON status to Raspberry
```

Success response:

```json
{
  "status": "done",
  "position": 1,
  "arduinoCommand": "GO 1"
}
```

Error response:

```json
{
  "status": "error",
  "position": 1,
  "arduinoCommand": "GO 1",
  "errorMessage": "Arduino timeout waiting for DONE"
}
```

No free position response:

```json
{
  "status": "error",
  "errorMessage": "No free position"
}
```

Allowed `status` values:

```text
pending
sent_to_arduino
done
error
executed
```

Recommended additional fields for failures:

```js
{
  errorMessage: "Arduino timeout"
}
```

## ESP32 Query

ESP32 should read commands with:

```text
status == "pending"
deviceId == "esp-main-01"
type == "GO"
```

It should read:

```js
position
```

It should send to Arduino Mega:

```cpp
Serial2.println("GO " + String(position));
```

After sending:

```js
status = "sent_to_arduino"
```

If Arduino replies `DONE` or `DONE:X`:

```js
status = "done"
```

If Arduino times out or replies with an error:

```js
status = "error"
errorMessage = "..."
```

## Arduino Serial Protocol

Incoming command:

```text
GO X
```

Where `X` is an integer from `1` to `18`.

Successful response:

```text
DONE
```

or:

```text
DONE:X
```

Failure response:

```text
ERROR
```

or a more specific error string.

## Physical Location Documents

Collection:

```text
locations
```

Documents:

```text
locations/1
locations/2
...
locations/9
```

Document shape:

```js
{
  status: "empty",
  position: 1,
  brand: "",
  model: "",
  color: "",
  size: "",
  updatedAt: timestamp
}
```

Allowed `status` values:

```text
empty
full
```

ESP32 should update `locations/<position>` to `full` only after Arduino confirms completion.

For IN movement commands with product label data, ESP32 marks the matching physical location `full`.
For OUT movement commands with product label data, ESP32 marks the matching physical location `empty`.
Manual GO commands without product label data should not change physical location contents.

## Settings Document

Document:

```text
settings/system
```

Default shape:

```js
{
  sortingMode: "brand",
  priority: ["brand"],
  totalLocations: 9,
  totalPositions: 18,
  commandType: "GO"
}
```

## Placement Verification

Prototype IR verification exists only for physical locations 7, 8, and 9. When placing into those locations, verification can be added through the Arduino location IR mux if the channel mapping is confirmed. Physical locations 1 through 6 should be treated as successful when Arduino returns `DONE:X`.

## Belt Behavior

The current Arduino `BELT` command toggles the relay. `BELT_START` and `BELT_STOP` may be used as website labels, but they are not deterministic hardware commands until extra relay state logic is designed and tested.

## Sensor Readings

Collection:

```text
sensorReadings
```

Current observed/read fields:

```js
{
  deviceId: "esp-main-01",
  deviceName: "ESP Main Controller",
  temperature: 20.6,
  humidity: 49.4,
  mq3: 144,
  mq135: 156,
  waterValue: 9,
  waterDetected: false,
  waterStatus: "dry",
  motion: 0,
  motionStatus: "no_motion",
  gasStatus: "normal",
  environmentStatus: "safe",
  dhtOk: true,
  createdAt: timestamp
}
```

## Device State

Collection:

```text
devices
```

Expected device document:

```text
devices/esp-main-01
```

Current observed/read fields:

```js
{
  deviceId: "esp-main-01",
  deviceName: "ESP Main Controller",
  deviceType: "ESP32",
  status: "online",
  currentTask: "waiting",
  lastSeen: timestamp,
  x: 0,
  y: 0,
  z: 0,
  belt: 0
}
```

## Activity Streams

The website currently uses:

```text
systemActivity
```

Previous requirements also referenced:

```text
activityLog
```

This is inconsistent. Pick one canonical activity collection before firmware/Raspberry implementation is finalized.

Recommendation:

```text
systemActivity
```

because it is already used by the website dashboard and live activity page.
