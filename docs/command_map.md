# Command Map

## Movement Positions

`GO 1` through `GO 18` are Arduino movement positions.

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

## Conversion Formula

For storing a box:

```text
go_position = location_id * 2 - 1
```

For picking a box:

```text
go_position = location_id * 2
```

Examples:

```text
Location 5 store -> GO 9
Location 5 pick  -> GO 10
```

## Command Producers

### OCR Store

Raspberry confirms:

```js
{ brand, model, color, size }
```

Then it:

- Creates `box_id`.
- Inserts `boxes`.
- Selects an empty physical location 1-9.
- Reserves that location immediately.
- Inserts a `store_queue` waiting task.
- Syncs `scans`, `locations`, and `storeQueue` to Firebase.

### Pick Requests

The website creates:

```js
{
  requestType: "single" | "size" | "model" | "brand",
  queryValue,
  status: "waiting"
}
```

Raspberry finds matching stored boxes in SQLite and inserts `pick_queue` tasks with OUT movement positions.

### Manual GO Testing

The Commands page creates:

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

Raspberry polls pending GO commands and executes them with ESP32 `/go`.

## Deprecated Names

Do not use:

```text
P X
SITE X
P1 IN
P1 OUT
location as movement command
```
