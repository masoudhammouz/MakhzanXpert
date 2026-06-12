#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <WebServer.h>
#include <time.h>

// ================= UART TO ARDUINO MEGA =================
#define RXD2 4
#define TXD2 17

// ================= WIFI / FIREBASE =================
const char* ssid = "GP";
const char* password = "123456789";

const String API_KEY = "AIzaSyBVgBcp5ouNM_ycz0A5dxHlySN_IuZ2CJo";
const String PROJECT_ID = "makhzanxpert";
const String DEVICE_ID = "esp-main-01";

// ================= TIMING =================
#define DEVICE_UPDATE_INTERVAL 30000
#define COMMAND_CHECK_INTERVAL 2000
#define ARDUINO_DONE_TIMEOUT 90000

unsigned long lastDeviceUpdate = 0;
unsigned long lastCommandCheck = 0;
WebServer server(80);

// ================= DEVICE STATE =================
String lastArduinoStatus = "waiting";
long lastX = 0;
long lastY = 0;
long lastZ = 0;
int lastBelt = 0;
String serialLine = "";

struct PendingCommand {
  String docName;
  int position;
  String arduinoCommand;
  String brand;
  String model;
  String color;
  String size;
  String source;
};

struct SystemSettings {
  String sortingMode;
  String priority[6];
  int priorityCount;
};

struct WarehouseLocation {
  bool exists;
  int position;
  String status;
  String brand;
  String model;
  String color;
  String size;
};

void setupRaspberryServer();
void handleRaspberryLabel();
void sendJsonResponse(int code, String body);
SystemSettings fetchSystemSettings();
void fetchLocations(WarehouseLocation locations[9]);
int choosePhysicalLocation(PendingCommand label, SystemSettings settings, WarehouseLocation locations[9]);
bool isLocationFree(WarehouseLocation location);
int getPhysicalLocationNeighbors(int locationId, int neighbors[4]);
int scoreLocationMatch(PendingCommand label, WarehouseLocation location, SystemSettings settings);
bool sameField(String a, String b);
String createRaspberryCommand(PendingCommand command);
int physicalLocationToInMovement(int locationId);
int movementToPhysicalLocation(int movementPosition);
bool hasProductLabel(PendingCommand command);
void updateLocationAfterMovement(PendingCommand command);
void patchLocationState(int physicalLocation, String status, PendingCommand command, bool clearProductFields);
void updateInventoryAfterSuccessfulMovement(PendingCommand command);
void incrementProductStockForPlacement(PendingCommand command);
void decrementProductStockForRetrieval(PendingCommand command);
bool findMatchingProduct(PendingCommand command, String &productDocName, int &currentQuantity);
void patchProductStock(String productDocName, int nextQuantity);

void setup() {
  Serial.begin(115200);
  Serial2.begin(9600, SERIAL_8N1, RXD2, TXD2);

  connectWiFi();
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  updateDeviceStatus("online", "ready");
  setupRaspberryServer();

  Serial.println("ESP32 Firebase bridge ready");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  readArduinoData();
  server.handleClient();

  if (millis() - lastCommandCheck >= COMMAND_CHECK_INTERVAL) {
    checkCommands();
    lastCommandCheck = millis();
  }

  if (millis() - lastDeviceUpdate >= DEVICE_UPDATE_INTERVAL) {
    updateDeviceStatus("online", lastArduinoStatus);
    lastDeviceUpdate = millis();
  }
}

// ================= RASPBERRY DIRECT HTTP =================

void setupRaspberryServer() {
  server.on("/raspberry-label", HTTP_OPTIONS, []() {
    sendJsonResponse(204, "");
  });

  server.on("/raspberry-label", HTTP_POST, handleRaspberryLabel);

  server.onNotFound([]() {
    sendJsonResponse(404, "{\"status\":\"error\",\"errorMessage\":\"Not found\"}");
  });

  server.begin();
  Serial.println("Raspberry HTTP endpoint ready: POST /raspberry-label");
}

void handleRaspberryLabel() {
  if (!server.hasArg("plain")) {
    sendJsonResponse(400, "{\"status\":\"error\",\"errorMessage\":\"Missing JSON body\"}");
    return;
  }

  DynamicJsonDocument doc(1024);
  DeserializationError error = deserializeJson(doc, server.arg("plain"));

  if (error) {
    sendJsonResponse(400, "{\"status\":\"error\",\"errorMessage\":\"Invalid JSON\"}");
    return;
  }

  PendingCommand command;
  command.docName = "";
  command.brand = doc["brand"] | "";
  command.model = doc["model"] | "";
  command.color = doc["color"] | "";
  command.size = doc["size"] | "";
  command.source = doc["source"] | "raspberry";

  if (command.brand.length() == 0 && command.model.length() == 0 &&
      command.color.length() == 0 && command.size.length() == 0) {
    sendJsonResponse(400, "{\"status\":\"error\",\"errorMessage\":\"Missing label fields\"}");
    return;
  }

  SystemSettings settings = fetchSystemSettings();
  WarehouseLocation locations[9];
  fetchLocations(locations);

  int physicalLocation = choosePhysicalLocation(command, settings, locations);

  if (physicalLocation == 0) {
    addSystemActivity("raspberry_no_free_position", "No free position", "error");
    sendJsonResponse(409, "{\"status\":\"error\",\"errorMessage\":\"No free position\"}");
    return;
  }

  command.position = physicalLocationToInMovement(physicalLocation);
  command.arduinoCommand = "GO " + String(command.position);
  command.docName = createRaspberryCommand(command);

  Serial.print("Label from Raspberry selected command: ");
  Serial.println(command.arduinoCommand);

  sendCommandToArduino(command.arduinoCommand);
  if (command.docName.length() > 0) {
    markCommandSent(command.docName, command.arduinoCommand);
  }
  updateDeviceStatus("online", "raspberry_sent_" + command.arduinoCommand);
  addSystemActivity("raspberry_command_sent", command.arduinoCommand, "sent_to_arduino");

  String errorMessage = "";
  bool done = waitForArduinoDone(command.position, errorMessage);

  if (done) {
    if (command.docName.length() > 0) {
      markCommandDone(command.docName);
    }
    updateLocationAfterMovement(command);
    updateInventoryAfterSuccessfulMovement(command);
    updateDeviceStatus("online", "raspberry_done_" + command.arduinoCommand);
    addSystemActivity("raspberry_command_done", command.arduinoCommand, "done");

    String body =
      String("{") +
        "\"status\":\"done\"," +
        "\"position\":" + String(command.position) + "," +
        "\"arduinoCommand\":\"" + command.arduinoCommand + "\"" +
      "}";
    sendJsonResponse(200, body);
  } else {
    if (command.docName.length() > 0) {
      markCommandError(command.docName, errorMessage);
    }
    updateDeviceStatus("online", "raspberry_error_" + command.arduinoCommand);
    addSystemActivity("raspberry_command_error", errorMessage, "error");

    String body =
      String("{") +
        "\"status\":\"error\"," +
        "\"position\":" + String(command.position) + "," +
        "\"arduinoCommand\":\"" + command.arduinoCommand + "\"," +
        "\"errorMessage\":\"" + escapeJson(errorMessage) + "\"" +
      "}";
    sendJsonResponse(500, body);
  }
}

void sendJsonResponse(int code, String body) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(code, "application/json", body);
}

SystemSettings fetchSystemSettings() {
  SystemSettings settings;
  settings.sortingMode = "brand";
  settings.priority[0] = "brand";
  settings.priorityCount = 1;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
               "/databases/(default)/documents/settings/system?key=" + API_KEY;

  http.begin(client, url);
  http.setTimeout(15000);

  int httpCode = http.GET();

  if (httpCode != 200) {
    Serial.print("Settings fetch failed, using defaults: ");
    Serial.println(httpCode);
    http.end();
    return settings;
  }

  String res = http.getString();
  http.end();

  DynamicJsonDocument doc(4096);
  DeserializationError error = deserializeJson(doc, res);

  if (error) {
    Serial.println("Settings JSON parse error, using defaults");
    return settings;
  }

  JsonObject fields = doc["fields"];
  String sortingMode = getStringField(fields, "sortingMode");
  if (sortingMode.length() > 0) {
    settings.sortingMode = sortingMode;
  }

  settings.priorityCount = 0;
  if (fields.containsKey("priority") && fields["priority"].containsKey("arrayValue")) {
    JsonArray values = fields["priority"]["arrayValue"]["values"];
    for (JsonObject item : values) {
      if (settings.priorityCount >= 6) break;
      if (item.containsKey("stringValue")) {
        settings.priority[settings.priorityCount] = item["stringValue"].as<String>();
        settings.priorityCount++;
      }
    }
  }

  if (settings.priorityCount == 0) {
    settings.priority[0] = "brand";
    settings.priorityCount = 1;
  }

  return settings;
}

void fetchLocations(WarehouseLocation locations[9]) {
  for (int i = 0; i < 9; i++) {
    int position = i + 1;
    locations[i].exists = false;
    locations[i].position = position;
    locations[i].status = "empty";
    locations[i].brand = "";
    locations[i].model = "";
    locations[i].color = "";
    locations[i].size = "";

    WiFiClientSecure client;
    client.setInsecure();

    HTTPClient http;
    String url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
                 "/databases/(default)/documents/locations/" + String(position) +
                 "?key=" + API_KEY;

    http.begin(client, url);
    http.setTimeout(15000);

    int httpCode = http.GET();

    if (httpCode == 200) {
      String res = http.getString();
      DynamicJsonDocument doc(4096);
      DeserializationError error = deserializeJson(doc, res);

      if (!error) {
        JsonObject fields = doc["fields"];
        locations[i].exists = true;
        locations[i].status = getStringField(fields, "status");
        locations[i].brand = getStringField(fields, "brand");
        locations[i].model = getStringField(fields, "model");
        locations[i].color = getStringField(fields, "color");
        locations[i].size = getStringField(fields, "size");

        int storedPosition = getIntField(fields, "position");
        if (storedPosition > 0) {
          locations[i].position = storedPosition;
        }

        if (locations[i].status.length() == 0) {
          locations[i].status = "empty";
        }
      }
    } else {
      Serial.print("Location fetch default empty for ");
      Serial.print(position);
      Serial.print(": ");
      Serial.println(httpCode);
    }

    http.end();
  }
}

int choosePhysicalLocation(PendingCommand label, SystemSettings settings, WarehouseLocation locations[9]) {
  int firstEmpty = 0;
  int bestLocation = 0;
  int bestScore = -1;

  for (int i = 0; i < 9; i++) {
    if (!isLocationFree(locations[i])) continue;

    int physicalLocation = i + 1;
    if (firstEmpty == 0) {
      firstEmpty = physicalLocation;
    }

    int totalScore = 0;
    int neighbors[4] = {0, 0, 0, 0};
    int neighborCount = getPhysicalLocationNeighbors(physicalLocation, neighbors);

    for (int n = 0; n < neighborCount; n++) {
      int neighborLocation = neighbors[n];
      WarehouseLocation neighbor = locations[neighborLocation - 1];

      if (neighbor.status == "full") {
        totalScore += scoreLocationMatch(label, neighbor, settings);
      }
    }

    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestLocation = physicalLocation;
    }
  }

  if (firstEmpty == 0) return 0;
  if (bestScore <= 0) return firstEmpty;
  return bestLocation;
}

bool isLocationFree(WarehouseLocation location) {
  return location.status.length() == 0 || location.status == "empty";
}

int getPhysicalLocationNeighbors(int locationId, int neighbors[4]) {
  int count = 0;

  switch (locationId) {
    case 1: neighbors[count++] = 2; neighbors[count++] = 4; break;
    case 2: neighbors[count++] = 1; neighbors[count++] = 3; neighbors[count++] = 5; break;
    case 3: neighbors[count++] = 2; neighbors[count++] = 6; break;
    case 4: neighbors[count++] = 1; neighbors[count++] = 5; neighbors[count++] = 7; break;
    case 5: neighbors[count++] = 2; neighbors[count++] = 4; neighbors[count++] = 6; neighbors[count++] = 8; break;
    case 6: neighbors[count++] = 3; neighbors[count++] = 5; neighbors[count++] = 9; break;
    case 7: neighbors[count++] = 4; neighbors[count++] = 8; break;
    case 8: neighbors[count++] = 5; neighbors[count++] = 7; neighbors[count++] = 9; break;
    case 9: neighbors[count++] = 6; neighbors[count++] = 8; break;
  }

  return count;
}

int scoreLocationMatch(PendingCommand label, WarehouseLocation location, SystemSettings settings) {
  String mode = settings.sortingMode;
  int score = 0;

  if (mode == "brand") {
    if (sameField(label.brand, location.brand)) score += 10;
  } else if (mode == "model") {
    if (sameField(label.model, location.model)) score += 10;
  } else if (mode == "size") {
    if (sameField(label.size, location.size)) score += 10;
  } else if (mode == "color") {
    if (sameField(label.color, location.color)) score += 10;
  } else if (mode == "brand_size") {
    if (sameField(label.brand, location.brand)) score += 10;
    if (sameField(label.size, location.size)) score += 7;
  } else if (mode == "model_size") {
    if (sameField(label.model, location.model)) score += 10;
    if (sameField(label.size, location.size)) score += 7;
  } else if (mode == "custom") {
    int weight = settings.priorityCount * 5;

    for (int i = 0; i < settings.priorityCount; i++) {
      String field = settings.priority[i];

      if (field == "brand" && sameField(label.brand, location.brand)) score += weight;
      if (field == "model" && sameField(label.model, location.model)) score += weight;
      if (field == "color" && sameField(label.color, location.color)) score += weight;
      if (field == "size" && sameField(label.size, location.size)) score += weight;

      weight -= 5;
      if (weight < 1) weight = 1;
    }
  }

  return score;
}

bool sameField(String a, String b) {
  a.trim();
  b.trim();

  if (a.length() == 0 || b.length() == 0) return false;

  a.toUpperCase();
  b.toUpperCase();

  return a == b;
}

String createRaspberryCommand(PendingCommand command) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;

  String url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
               "/databases/(default)/documents/commands?key=" + API_KEY;

  http.begin(client, url);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");

  String body =
    String("{") +
      "\"fields\":{" +
        "\"type\":{\"stringValue\":\"GO\"}," +
        "\"position\":{\"integerValue\":\"" + String(command.position) + "\"}," +
        "\"arduinoCommand\":{\"stringValue\":\"" + escapeJson(command.arduinoCommand) + "\"}," +
        "\"status\":{\"stringValue\":\"pending\"}," +
        "\"source\":{\"stringValue\":\"" + escapeJson(command.source) + "\"}," +
        "\"deviceId\":{\"stringValue\":\"" + DEVICE_ID + "\"}," +
        "\"brand\":{\"stringValue\":\"" + escapeJson(command.brand) + "\"}," +
        "\"model\":{\"stringValue\":\"" + escapeJson(command.model) + "\"}," +
        "\"color\":{\"stringValue\":\"" + escapeJson(command.color) + "\"}," +
        "\"size\":{\"stringValue\":\"" + escapeJson(command.size) + "\"}," +
        "\"createdAt\":{\"timestampValue\":\"" + getTimestamp() + "\"}" +
      "}" +
    "}";

  int httpCode = http.POST(body);

  Serial.print("Raspberry command create: ");
  Serial.println(httpCode);

  if (httpCode <= 0) {
    http.end();
    return "";
  }

  String res = http.getString();
  http.end();

  DynamicJsonDocument doc(4096);
  DeserializationError error = deserializeJson(doc, res);

  if (error || !doc.containsKey("name")) {
    return "";
  }

  return doc["name"].as<String>();
}

// ================= ARDUINO SERIAL =================

void readArduinoData() {
  while (Serial2.available()) {
    char c = Serial2.read();

    if (c == '\n') {
      processArduinoLine(serialLine);
      serialLine = "";
      continue;
    }

    if (c != '\r') {
      serialLine += c;
    }

    if (serialLine.length() > 900) {
      serialLine = "";
    }
  }
}

void processArduinoLine(String line) {
  line.trim();
  if (line.length() == 0) return;

  Serial.print("From Arduino: ");
  Serial.println(line);

  if (line.startsWith("{")) {
    DynamicJsonDocument doc(1024);
    DeserializationError error = deserializeJson(doc, line);

    if (error) {
      Serial.println("Arduino JSON parse error");
      Serial.println(line);
      return;
    }

    sendSensorReading(doc);
    return;
  }

  lastArduinoStatus = line;
}

bool waitForArduinoDone(int position, String &errorMessage) {
  unsigned long startedAt = millis();
  String expectedDone = "DONE:" + String(position);

  while (millis() - startedAt < ARDUINO_DONE_TIMEOUT) {
    if (WiFi.status() != WL_CONNECTED) {
      connectWiFi();
    }

    while (Serial2.available()) {
      String line = Serial2.readStringUntil('\n');
      line.trim();
      if (line.length() == 0) continue;

      Serial.print("Arduino reply: ");
      Serial.println(line);

      if (line.startsWith("{")) {
        DynamicJsonDocument sensorDoc(1024);
        DeserializationError parseError = deserializeJson(sensorDoc, line);
        if (!parseError) {
          sendSensorReading(sensorDoc);
        }
        continue;
      }

      lastArduinoStatus = line;

      if (line == "DONE" || line == expectedDone || line.startsWith("DONE:")) {
        return true;
      }

      if (line.startsWith("ERROR")) {
        errorMessage = line;
        return false;
      }
    }

    delay(10);
  }

  errorMessage = "Arduino timeout waiting for DONE";
  return false;
}

// ================= COMMANDS FROM FIRESTORE =================

void checkCommands() {
  PendingCommand command;
  if (!fetchNextPendingCommand(command)) return;

  if (command.position < 1 || command.position > 18) {
    markCommandError(command.docName, "Invalid position " + String(command.position));
    return;
  }

  command.arduinoCommand = "GO " + String(command.position);

  Serial.print("Command from Firestore: ");
  Serial.println(command.arduinoCommand);

  sendCommandToArduino(command.arduinoCommand);
  markCommandSent(command.docName, command.arduinoCommand);
  updateDeviceStatus("online", "sent_to_arduino_" + command.arduinoCommand);
  addSystemActivity("command_sent", command.arduinoCommand, "sent_to_arduino");

  String errorMessage = "";
  bool done = waitForArduinoDone(command.position, errorMessage);

  if (done) {
    markCommandDone(command.docName);
    updateLocationAfterMovement(command);
    updateInventoryAfterSuccessfulMovement(command);
    updateDeviceStatus("online", "done_" + command.arduinoCommand);
    addSystemActivity("command_done", command.arduinoCommand, "done");
  } else {
    markCommandError(command.docName, errorMessage);
    updateDeviceStatus("online", "error_" + command.arduinoCommand);
    addSystemActivity("command_error", errorMessage, "error");
  }
}

bool fetchNextPendingCommand(PendingCommand &command) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;

  String url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
               "/databases/(default)/documents:runQuery?key=" + API_KEY;

  http.begin(client, url);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");

  String body =
    "{"
      "\"structuredQuery\":{"
        "\"from\":[{\"collectionId\":\"commands\"}],"
        "\"where\":{"
          "\"compositeFilter\":{"
            "\"op\":\"AND\","
            "\"filters\":["
              "{"
                "\"fieldFilter\":{"
                  "\"field\":{\"fieldPath\":\"deviceId\"},"
                  "\"op\":\"EQUAL\","
                  "\"value\":{\"stringValue\":\"" + DEVICE_ID + "\"}"
                "}"
              "},"
              "{"
                "\"fieldFilter\":{"
                  "\"field\":{\"fieldPath\":\"status\"},"
                  "\"op\":\"EQUAL\","
                  "\"value\":{\"stringValue\":\"pending\"}"
                "}"
              "},"
              "{"
                "\"fieldFilter\":{"
                  "\"field\":{\"fieldPath\":\"type\"},"
                  "\"op\":\"EQUAL\","
                  "\"value\":{\"stringValue\":\"GO\"}"
                "}"
              "}"
            "]"
          "}"
        "},"
        "\"orderBy\":["
          "{"
            "\"field\":{\"fieldPath\":\"createdAt\"},"
            "\"direction\":\"ASCENDING\""
          "}"
        "],"
        "\"limit\":1"
      "}"
    "}";

  int httpCode = http.POST(body);

  if (httpCode <= 0) {
    Serial.print("Command check failed: ");
    Serial.println(httpCode);
    http.end();
    return false;
  }

  String res = http.getString();
  http.end();

  DynamicJsonDocument doc(4096);
  DeserializationError error = deserializeJson(doc, res);

  if (error) {
    Serial.println("Command JSON parse error");
    return false;
  }

  JsonArray arr = doc.as<JsonArray>();

  for (JsonObject item : arr) {
    if (!item.containsKey("document")) continue;

    JsonObject document = item["document"];
    JsonObject fields = document["fields"];

    command.docName = document["name"].as<String>();
    command.position = getIntField(fields, "position");
    command.arduinoCommand = getStringField(fields, "arduinoCommand");
    command.brand = getStringField(fields, "brand");
    command.model = getStringField(fields, "model");
    command.color = getStringField(fields, "color");
    command.size = getStringField(fields, "size");
    command.source = getStringField(fields, "source");

    return command.docName.length() > 0;
  }

  return false;
}

void sendCommandToArduino(String command) {
  Serial2.println(command);

  Serial.print("Sent to Arduino: ");
  Serial.println(command);
}

// ================= SENSOR UPLOAD =================

void sendSensorReading(DynamicJsonDocument& doc) {
  int motion = doc["motion"] | 0;
  int waterValue = doc["waterValue"] | 0;
  bool waterDetected = doc["waterDetected"] | false;
  int mq3 = doc["mq3"] | 0;
  int mq135 = doc["mq135"] | 0;

  float temperature = doc["temperature"] | -1;
  float humidity = doc["humidity"] | -1;

  bool dhtOk = doc["dhtOk"] | false;

  lastBelt = doc["belt"] | lastBelt;
  lastX = doc["x"] | lastX;
  lastY = doc["y"] | lastY;
  lastZ = doc["z"] | lastZ;

  String gasStatus = "normal";
  String environmentStatus = "safe";
  String waterStatus = waterDetected ? "water_detected" : "dry";
  String motionStatus = motion == 1 ? "motion_detected" : "no_motion";

  if (mq3 > 2500 || mq135 > 2500) {
    gasStatus = "warning";
    environmentStatus = "check_required";
  }

  if (waterDetected) {
    environmentStatus = "water_alert";
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;

  String url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
               "/databases/(default)/documents/sensorReadings?key=" + API_KEY;

  http.begin(client, url);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");

  String body =
    "{"
      "\"fields\":{"
        "\"deviceId\":{\"stringValue\":\"" + DEVICE_ID + "\"},"
        "\"deviceName\":{\"stringValue\":\"ESP Main Controller\"},"

        "\"motion\":{\"integerValue\":\"" + String(motion) + "\"},"
        "\"motionStatus\":{\"stringValue\":\"" + motionStatus + "\"},"

        "\"waterValue\":{\"integerValue\":\"" + String(waterValue) + "\"},"
        "\"waterDetected\":{\"booleanValue\":" + String(waterDetected ? "true" : "false") + "},"
        "\"waterStatus\":{\"stringValue\":\"" + waterStatus + "\"},"

        "\"temperature\":{\"doubleValue\":" + String(temperature, 2) + "},"
        "\"humidity\":{\"doubleValue\":" + String(humidity, 2) + "},"
        "\"dhtOk\":{\"booleanValue\":" + String(dhtOk ? "true" : "false") + "},"

        "\"mq3\":{\"integerValue\":\"" + String(mq3) + "\"},"
        "\"mq135\":{\"integerValue\":\"" + String(mq135) + "\"},"

        "\"gasStatus\":{\"stringValue\":\"" + gasStatus + "\"},"
        "\"environmentStatus\":{\"stringValue\":\"" + environmentStatus + "\"},"

        "\"belt\":{\"integerValue\":\"" + String(lastBelt) + "\"},"
        "\"x\":{\"integerValue\":\"" + String(lastX) + "\"},"
        "\"y\":{\"integerValue\":\"" + String(lastY) + "\"},"
        "\"z\":{\"integerValue\":\"" + String(lastZ) + "\"},"

        "\"createdAt\":{\"timestampValue\":\"" + getTimestamp() + "\"}"
      "}"
    "}";

  int httpCode = http.POST(body);

  Serial.print("Firestore sensor: ");
  Serial.println(httpCode);

  http.end();
}

// ================= COMMAND STATUS =================

void markCommandSent(String docName, String sentCommand) {
  patchCommandStatus(docName, "sent_to_arduino", sentCommand, "", "sentAt");
}

void markCommandDone(String docName) {
  patchCommandStatus(docName, "done", "", "", "doneAt");
}

void markCommandError(String docName, String errorMessage) {
  patchCommandStatus(docName, "error", "", errorMessage, "errorAt");
}

void patchCommandStatus(String docName, String status, String sentCommand, String errorMessage, String timestampField) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;

  String url = "https://firestore.googleapis.com/v1/" + docName +
               "?key=" + API_KEY +
               "&updateMask.fieldPaths=status"
               "&updateMask.fieldPaths=" + timestampField;

  String fields =
    "\"status\":{\"stringValue\":\"" + status + "\"},"
    "\"" + timestampField + "\":{\"timestampValue\":\"" + getTimestamp() + "\"}";

  if (sentCommand.length() > 0) {
    url += "&updateMask.fieldPaths=sentCommand";
    fields += ",\"sentCommand\":{\"stringValue\":\"" + escapeJson(sentCommand) + "\"}";
  }

  if (errorMessage.length() > 0) {
    url += "&updateMask.fieldPaths=errorMessage";
    fields += ",\"errorMessage\":{\"stringValue\":\"" + escapeJson(errorMessage) + "\"}";
  }

  http.begin(client, url);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");

  String body = "{\"fields\":{" + fields + "}}";

  int httpCode = http.PATCH(body);

  Serial.print("Command status update: ");
  Serial.println(httpCode);

  http.end();
}

// ================= LOCATION UPDATE =================

int physicalLocationToInMovement(int locationId) {
  return (locationId * 2) - 1;
}

int movementToPhysicalLocation(int movementPosition) {
  if (movementPosition < 1 || movementPosition > 18) return 0;
  return (movementPosition + 1) / 2;
}

bool hasProductLabel(PendingCommand command) {
  return command.brand.length() > 0 ||
         command.model.length() > 0 ||
         command.color.length() > 0 ||
         command.size.length() > 0;
}

void updateLocationAfterMovement(PendingCommand command) {
  if (!hasProductLabel(command)) {
    Serial.println("Skipping location update for manual movement without product label");
    return;
  }

  int physicalLocation = movementToPhysicalLocation(command.position);

  if (physicalLocation < 1 || physicalLocation > 9) {
    Serial.println("Skipping location update for invalid physical location");
    return;
  }

  if (command.position % 2 == 1) {
    patchLocationState(physicalLocation, "full", command, false);
  } else {
    patchLocationState(physicalLocation, "empty", command, true);
  }
}

void patchLocationState(int physicalLocation, String status, PendingCommand command, bool clearProductFields) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;

  String brandValue = clearProductFields ? "" : command.brand;
  String modelValue = clearProductFields ? "" : command.model;
  String colorValue = clearProductFields ? "" : command.color;
  String sizeValue = clearProductFields ? "" : command.size;

  String url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
               "/databases/(default)/documents/locations/" + String(physicalLocation) +
               "?key=" + API_KEY +
               "&updateMask.fieldPaths=status"
               "&updateMask.fieldPaths=position"
               "&updateMask.fieldPaths=brand"
               "&updateMask.fieldPaths=model"
               "&updateMask.fieldPaths=color"
               "&updateMask.fieldPaths=size"
               "&updateMask.fieldPaths=updatedAt";

  http.begin(client, url);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");

  String body =
    "{"
      "\"fields\":{"
        "\"status\":{\"stringValue\":\"" + status + "\"},"
        "\"position\":{\"integerValue\":\"" + String(physicalLocation) + "\"},"
        "\"brand\":{\"stringValue\":\"" + escapeJson(brandValue) + "\"},"
        "\"model\":{\"stringValue\":\"" + escapeJson(modelValue) + "\"},"
        "\"color\":{\"stringValue\":\"" + escapeJson(colorValue) + "\"},"
        "\"size\":{\"stringValue\":\"" + escapeJson(sizeValue) + "\"},"
        "\"updatedAt\":{\"timestampValue\":\"" + getTimestamp() + "\"}"
      "}"
    "}";

  int httpCode = http.PATCH(body);

  Serial.print("Location update: ");
  Serial.println(httpCode);

  http.end();
}

// ================= INVENTORY UPDATE =================

void updateInventoryAfterSuccessfulMovement(PendingCommand command) {
  if (!hasProductLabel(command)) {
    Serial.println("Skipping inventory update for movement without product label");
    return;
  }

  if (command.position % 2 == 1) {
    if (command.source != "raspberry") {
      Serial.println("Skipping product increment for non-OCR IN movement");
      return;
    }

    incrementProductStockForPlacement(command);
  } else {
    decrementProductStockForRetrieval(command);
  }
}

void incrementProductStockForPlacement(PendingCommand command) {
  String productDocName = "";
  int currentQuantity = 0;

  if (!findMatchingProduct(command, productDocName, currentQuantity)) {
    String message =
      "PRODUCT_NOT_FOUND_FOR_STOCK_INCREMENT " +
      command.brand + " / " +
      command.model + " / " +
      command.color + " / " +
      command.size;

    Serial.println(message);
    addSystemActivity("PRODUCT_NOT_FOUND_FOR_STOCK_INCREMENT", message, "error");
    return;
  }

  int nextQuantity = currentQuantity + 1;
  patchProductStock(productDocName, nextQuantity);
  addSystemActivity("product_stock_incremented", command.brand + " " + command.model, "done");
}

void decrementProductStockForRetrieval(PendingCommand command) {
  Serial.println("Skipping product decrement for OUT movement; not implemented yet");
}

bool findMatchingProduct(PendingCommand command, String &productDocName, int &currentQuantity) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;

  String url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
               "/databases/(default)/documents:runQuery?key=" + API_KEY;

  http.begin(client, url);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");

  String body =
    String("{") +
      "\"structuredQuery\":{" +
        "\"from\":[{\"collectionId\":\"products\"}]," +
        "\"where\":{" +
          "\"compositeFilter\":{" +
            "\"op\":\"AND\"," +
            "\"filters\":[" +
              "{\"fieldFilter\":{\"field\":{\"fieldPath\":\"brand\"},\"op\":\"EQUAL\",\"value\":{\"stringValue\":\"" + escapeJson(command.brand) + "\"}}}," +
              "{\"fieldFilter\":{\"field\":{\"fieldPath\":\"model\"},\"op\":\"EQUAL\",\"value\":{\"stringValue\":\"" + escapeJson(command.model) + "\"}}}," +
              "{\"fieldFilter\":{\"field\":{\"fieldPath\":\"color\"},\"op\":\"EQUAL\",\"value\":{\"stringValue\":\"" + escapeJson(command.color) + "\"}}}," +
              "{\"fieldFilter\":{\"field\":{\"fieldPath\":\"size\"},\"op\":\"EQUAL\",\"value\":{\"stringValue\":\"" + escapeJson(command.size) + "\"}}}" +
            "]" +
          "}" +
        "}," +
        "\"limit\":1" +
      "}" +
    "}";

  int httpCode = http.POST(body);

  if (httpCode <= 0) {
    Serial.print("Product lookup failed: ");
    Serial.println(httpCode);
    http.end();
    return false;
  }

  String res = http.getString();
  http.end();

  DynamicJsonDocument doc(4096);
  DeserializationError error = deserializeJson(doc, res);

  if (error) {
    Serial.println("Product lookup JSON parse error");
    return false;
  }

  JsonArray arr = doc.as<JsonArray>();

  for (JsonObject item : arr) {
    if (!item.containsKey("document")) continue;

    JsonObject document = item["document"];
    JsonObject fields = document["fields"];

    productDocName = document["name"].as<String>();
    currentQuantity = getIntField(fields, "quantity");

    return productDocName.length() > 0;
  }

  return false;
}

void patchProductStock(String productDocName, int nextQuantity) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;

  String url = "https://firestore.googleapis.com/v1/" + productDocName +
               "?key=" + API_KEY +
               "&updateMask.fieldPaths=quantity"
               "&updateMask.fieldPaths=isAvailable"
               "&updateMask.fieldPaths=updatedAt";

  http.begin(client, url);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");

  String body =
    "{"
      "\"fields\":{"
        "\"quantity\":{\"integerValue\":\"" + String(nextQuantity) + "\"},"
        "\"isAvailable\":{\"booleanValue\":true},"
        "\"updatedAt\":{\"timestampValue\":\"" + getTimestamp() + "\"}"
      "}"
    "}";

  int httpCode = http.PATCH(body);

  Serial.print("Product stock update: ");
  Serial.println(httpCode);

  http.end();
}

// ================= DEVICE STATUS =================

void updateDeviceStatus(String status, String task) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;

  String url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
               "/databases/(default)/documents/devices/" + DEVICE_ID +
               "?key=" + API_KEY;

  http.begin(client, url);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");

  String body =
    "{"
      "\"fields\":{"
        "\"deviceId\":{\"stringValue\":\"" + DEVICE_ID + "\"},"
        "\"deviceName\":{\"stringValue\":\"ESP Main Controller\"},"
        "\"deviceType\":{\"stringValue\":\"ESP32\"},"
        "\"status\":{\"stringValue\":\"" + status + "\"},"
        "\"currentTask\":{\"stringValue\":\"" + escapeJson(task) + "\"},"

        "\"belt\":{\"integerValue\":\"" + String(lastBelt) + "\"},"
        "\"x\":{\"integerValue\":\"" + String(lastX) + "\"},"
        "\"y\":{\"integerValue\":\"" + String(lastY) + "\"},"
        "\"z\":{\"integerValue\":\"" + String(lastZ) + "\"},"

        "\"lastSeen\":{\"timestampValue\":\"" + getTimestamp() + "\"}"
      "}"
    "}";

  int httpCode = http.PATCH(body);

  Serial.print("Device update: ");
  Serial.println(httpCode);

  http.end();
}

// ================= ACTIVITY LOG =================

void addSystemActivity(String activityType, String message, String status) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;

  String url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
               "/databases/(default)/documents/systemActivity?key=" + API_KEY;

  http.begin(client, url);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");

  String body =
    "{"
      "\"fields\":{"
        "\"sourceDevice\":{\"stringValue\":\"" + DEVICE_ID + "\"},"
        "\"activityType\":{\"stringValue\":\"" + escapeJson(activityType) + "\"},"
        "\"message\":{\"stringValue\":\"" + escapeJson(message) + "\"},"
        "\"status\":{\"stringValue\":\"" + escapeJson(status) + "\"},"
        "\"createdAt\":{\"timestampValue\":\"" + getTimestamp() + "\"}"
      "}"
    "}";

  int httpCode = http.POST(body);

  Serial.print("System activity add: ");
  Serial.println(httpCode);

  http.end();
}

// ================= HELPERS =================

void connectWiFi() {
  Serial.print("Connecting to WiFi");

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  int attempts = 0;

  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi failed. Restarting...");
    ESP.restart();
  }
}

String getTimestamp() {
  struct tm timeinfo;

  if (!getLocalTime(&timeinfo, 5000)) {
    return "2026-06-12T12:00:00Z";
  }

  char buffer[30];
  strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &timeinfo);
  return String(buffer);
}

String getStringField(JsonObject fields, String key) {
  if (!fields.containsKey(key)) return "";

  JsonObject f = fields[key];

  if (f.containsKey("stringValue")) {
    return f["stringValue"].as<String>();
  }

  return "";
}

int getIntField(JsonObject fields, String key) {
  if (!fields.containsKey(key)) return 0;

  JsonObject f = fields[key];

  if (f.containsKey("integerValue")) {
    return String(f["integerValue"].as<String>()).toInt();
  }

  if (f.containsKey("doubleValue")) {
    return int(f["doubleValue"].as<float>());
  }

  return 0;
}

String escapeJson(String value) {
  value.replace("\\", "\\\\");
  value.replace("\"", "\\\"");
  value.replace("\n", "\\n");
  value.replace("\r", "\\r");
  return value;
}
