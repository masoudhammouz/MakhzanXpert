#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <WebServer.h>
#include <Keypad.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
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
#define ARDUINO_DONE_TIMEOUT 90000

unsigned long lastDeviceUpdate = 0;
WebServer server(80);

// ================= LCD / KEYPAD =================
#define LCD_SDA 18
#define LCD_SCL 19

LiquidCrystal_I2C lcd(0x27, 16, 2);

const byte ROWS = 4;
const byte COLS = 4;

char keys[ROWS][COLS] = {
  {'C', 'D', 'B', 'A'},
  {'9', '#', '6', '3'},
  {'8', '0', '5', '2'},
  {'7', '*', '4', '1'}
};

byte rowPins[ROWS] = {32, 33, 25, 26};
byte colPins[COLS] = {27, 14, 12, 13};

Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);

// ================= DEVICE STATE =================
String lastArduinoStatus = "waiting";
String serialLine = "";
String lastArduinoJson = "{}";
String lastUltraJson = "{}";
String lastVerifyJson = "{}";
long lastX = 0;
long lastY = 0;
long lastZ = 0;
int lastBelt = 0;
bool lastIrCamera = false;
bool lastIrLifter = false;
bool lastUltrasonicReady = false;
bool lastLoc8Detected = false;
bool lastLoc9Detected = false;
bool lastAtStartingPoint = false;
bool lastArduinoBusy = false;
float lastUltrasonicCm = -1;
bool commandRunning = false;
String keypadInput = "";
bool keypadAwaitingResponse = false;
unsigned long keypadCommandStartedAt = 0;
unsigned long lastKeypadActivityAt = 0;
const unsigned long LCD_MESSAGE_HOLD = 3000;

void setupGoServer();
void handleGoRequest();
void handleStatusRequest();
void handleBeltStartRequest();
void handleBeltStopRequest();
void handleBeltRunRequest();
void handleDropRequest();
void handleStartRequest();
void handleVerifyLocationRequest();
void handleUltraRequest();
void handleCommandRequest();
void sendCommandToArduino(String command);
bool waitForArduinoDone(int position, String &errorMessage);
bool runArduinoCommand(String command, String source, String activityType, String &errorMessage);
bool automationAllowsMotion(String &errorMessage);
void setupKeypadLcd();
void handleKeypad();
void handleNumericKey(char key);
void handleSendKey();
void handleClearKey();
void handleAutomationKey(bool enabled);
void handleBeltKey();
void handleHomeKey();
void showBootScreen();
void showIdleScreen();
void showTypingScreen();
void showSentCommand(String command);
void showInvalidPosition();
void showBusyScreen();
void showAutomationScreen(bool enabled);
void showTwoLineMessage(String line1, String line2);
void updateLcdFromArduinoLine(String line);
void checkKeypadCommandTimeout();
void patchAutomationEnabled(bool enabled);
void readArduinoData();
void processArduinoLine(String line);
void sendSensorReading(DynamicJsonDocument& doc);
void cacheArduinoJson(DynamicJsonDocument& doc, String line);
void updateDeviceStatus(String status, String task);
void addActivityLog(String activityType, String message, String source);
void postActivityDocument(WiFiClientSecure &client, String collectionName, String body);
void sendJsonResponse(int code, String body);
void connectWiFi();
String getTimestamp();
String escapeJson(String value);

void setup() {
  Serial.begin(115200);
  Serial2.begin(9600, SERIAL_8N1, RXD2, TXD2);

  setupKeypadLcd();

  connectWiFi();
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  updateDeviceStatus("online", "ready");
  setupGoServer();

  Serial.println("ESP32 HTTP GO bridge ready");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  readArduinoData();
  handleKeypad();
  checkKeypadCommandTimeout();
  server.handleClient();

  if (millis() - lastDeviceUpdate >= DEVICE_UPDATE_INTERVAL) {
    updateDeviceStatus("online", lastArduinoStatus);
    lastDeviceUpdate = millis();
  }
}

// ================= HTTP GO ENDPOINT =================

void setupGoServer() {
  server.on("/go", HTTP_OPTIONS, []() {
    sendJsonResponse(204, "");
  });
  server.on("/start", HTTP_OPTIONS, []() {
    sendJsonResponse(204, "");
  });
  server.on("/command", HTTP_OPTIONS, []() {
    sendJsonResponse(204, "");
  });
  server.on("/status", HTTP_OPTIONS, []() {
    sendJsonResponse(204, "");
  });
  server.on("/belt/start", HTTP_OPTIONS, []() {
    sendJsonResponse(204, "");
  });
  server.on("/belt/stop", HTTP_OPTIONS, []() {
    sendJsonResponse(204, "");
  });
  server.on("/belt/run", HTTP_OPTIONS, []() {
    sendJsonResponse(204, "");
  });
  server.on("/drop", HTTP_OPTIONS, []() {
    sendJsonResponse(204, "");
  });
  server.on("/verify-location", HTTP_OPTIONS, []() {
    sendJsonResponse(204, "");
  });
  server.on("/ultra", HTTP_OPTIONS, []() {
    sendJsonResponse(204, "");
  });

  server.on("/go", HTTP_GET, handleGoRequest);
  server.on("/status", HTTP_GET, handleStatusRequest);
  server.on("/belt/start", HTTP_GET, handleBeltStartRequest);
  server.on("/belt/stop", HTTP_GET, handleBeltStopRequest);
  server.on("/belt/run", HTTP_GET, handleBeltRunRequest);
  server.on("/drop", HTTP_GET, handleDropRequest);
  server.on("/start", HTTP_GET, handleStartRequest);
  server.on("/verify-location", HTTP_GET, handleVerifyLocationRequest);
  server.on("/ultra", HTTP_GET, handleUltraRequest);
  server.on("/command", HTTP_GET, handleCommandRequest);

  server.onNotFound([]() {
    sendJsonResponse(404, "{\"ok\":false,\"error\":\"Not found\"}");
  });

  server.begin();
  Serial.println("Raspberry endpoint ready: GET /go?position=X&source=raspberry&queueId=Y");
  Serial.println("Raspberry endpoint ready: GET /status");
  Serial.println("Raspberry endpoint ready: GET /belt/start|stop|run?ms=1200");
  Serial.println("Raspberry endpoint ready: GET /drop");
  Serial.println("Raspberry endpoint ready: GET /start?source=raspberry&queueId=Y");
  Serial.println("Raspberry endpoint ready: GET /verify-location?id=8|9");
  Serial.println("Raspberry endpoint ready: GET /ultra");
  Serial.println("Raspberry endpoint ready: GET /command?command=BELT|STOP|STATUS|TESTIR|ULTRA|CAMERA|DISPENSE");
}

void handleGoRequest() {
  String automationError = "";
  if (!automationAllowsMotion(automationError)) {
    sendJsonResponse(409, "{\"ok\":false,\"error\":\"" + escapeJson(automationError) + "\"}");
    return;
  }

  if (commandRunning) {
    sendJsonResponse(409, "{\"ok\":false,\"error\":\"Lifter is busy\"}");
    return;
  }

  if (!server.hasArg("position")) {
    sendJsonResponse(400, "{\"ok\":false,\"error\":\"Missing position\"}");
    return;
  }

  int position = server.arg("position").toInt();
  String source = server.hasArg("source") ? server.arg("source") : "raspberry";
  String queueId = server.hasArg("queueId") ? server.arg("queueId") : "";

  if (position < 1 || position > 18) {
    sendJsonResponse(400, "{\"ok\":false,\"error\":\"Position must be 1-18\"}");
    return;
  }

  commandRunning = true;
  String arduinoCommand = "GO " + String(position);

  Serial.print("HTTP GO request: ");
  Serial.print(arduinoCommand);
  Serial.print(" source=");
  Serial.print(source);
  Serial.print(" queueId=");
  Serial.println(queueId);

  addActivityLog("go_received", arduinoCommand + " from " + source, source);
  updateDeviceStatus("online", "running_" + arduinoCommand);
  sendCommandToArduino(arduinoCommand);

  String errorMessage = "";
  bool done = waitForArduinoDone(position, errorMessage);

  commandRunning = false;

  if (done) {
    updateDeviceStatus("online", "done_" + arduinoCommand);
    addActivityLog("go_done", arduinoCommand + " done", source);
    sendJsonResponse(200, "{\"ok\":true,\"position\":" + String(position) + "}");
  } else {
    updateDeviceStatus("online", "error_" + arduinoCommand);
    addActivityLog("go_error", errorMessage, source);
    sendJsonResponse(500, "{\"ok\":false,\"error\":\"" + escapeJson(errorMessage) + "\"}");
  }
}

void handleStartRequest() {
  String automationError = "";
  if (!automationAllowsMotion(automationError)) {
    sendJsonResponse(409, "{\"ok\":false,\"error\":\"" + escapeJson(automationError) + "\"}");
    return;
  }

  if (commandRunning) {
    sendJsonResponse(409, "{\"ok\":false,\"error\":\"Lifter is busy\"}");
    return;
  }

  String source = server.hasArg("source") ? server.arg("source") : "raspberry";
  String queueId = server.hasArg("queueId") ? server.arg("queueId") : "";

  commandRunning = true;
  String arduinoCommand = "START";

  Serial.print("HTTP START request source=");
  Serial.print(source);
  Serial.print(" queueId=");
  Serial.println(queueId);

  addActivityLog("start_received", arduinoCommand + " from " + source, source);
  updateDeviceStatus("online", "running_START");
  sendCommandToArduino(arduinoCommand);

  String errorMessage = "";
  bool done = waitForArduinoDone(0, errorMessage);

  commandRunning = false;

  if (done) {
    updateDeviceStatus("online", "done_START");
    addActivityLog("returned_to_start", "START done", source);
    sendJsonResponse(200, "{\"ok\":true,\"command\":\"START\"}");
  } else {
    updateDeviceStatus("online", "error_START");
    addActivityLog("start_error", errorMessage, source);
    sendJsonResponse(500, "{\"ok\":false,\"error\":\"" + escapeJson(errorMessage) + "\"}");
  }
}

void handleStatusRequest() {
  sendCommandToArduino("STATUS");
  delay(60);
  readArduinoData();
  sendJsonResponse(200, "{\"ok\":true,\"status\":" + lastArduinoJson + "}");
}

void handleBeltStartRequest() {
  String automationError = "";
  if (!automationAllowsMotion(automationError)) {
    sendJsonResponse(409, "{\"ok\":false,\"error\":\"" + escapeJson(automationError) + "\"}");
    return;
  }
  String errorMessage = "";
  if (runArduinoCommand("BELT_START", "raspberry", "belt_start", errorMessage)) {
    sendJsonResponse(200, "{\"ok\":true,\"command\":\"BELT_START\"}");
  } else {
    sendJsonResponse(500, "{\"ok\":false,\"error\":\"" + escapeJson(errorMessage) + "\"}");
  }
}

void handleBeltStopRequest() {
  String errorMessage = "";
  if (runArduinoCommand("BELT_STOP", "raspberry", "belt_stop", errorMessage)) {
    sendJsonResponse(200, "{\"ok\":true,\"command\":\"BELT_STOP\"}");
  } else {
    sendJsonResponse(500, "{\"ok\":false,\"error\":\"" + escapeJson(errorMessage) + "\"}");
  }
}

void handleBeltRunRequest() {
  String automationError = "";
  if (!automationAllowsMotion(automationError)) {
    sendJsonResponse(409, "{\"ok\":false,\"error\":\"" + escapeJson(automationError) + "\"}");
    return;
  }
  int durationMs = server.hasArg("ms") ? server.arg("ms").toInt() : 1200;
  if (durationMs <= 0 || durationMs > 10000) {
    sendJsonResponse(400, "{\"ok\":false,\"error\":\"Invalid ms\"}");
    return;
  }
  String errorMessage = "";
  String command = "BELT_RUN_MS " + String(durationMs);
  if (runArduinoCommand(command, "raspberry", "belt_run_ms", errorMessage)) {
    sendJsonResponse(200, "{\"ok\":true,\"command\":\"" + escapeJson(command) + "\"}");
  } else {
    sendJsonResponse(500, "{\"ok\":false,\"error\":\"" + escapeJson(errorMessage) + "\"}");
  }
}

void handleDropRequest() {
  String automationError = "";
  if (!automationAllowsMotion(automationError)) {
    sendJsonResponse(409, "{\"ok\":false,\"error\":\"" + escapeJson(automationError) + "\"}");
    return;
  }
  String errorMessage = "";
  if (runArduinoCommand("DROP_TO_LIFTER", "raspberry", "drop_to_lifter", errorMessage)) {
    sendJsonResponse(200, "{\"ok\":true,\"command\":\"DROP_TO_LIFTER\"}");
  } else {
    sendJsonResponse(500, "{\"ok\":false,\"error\":\"" + escapeJson(errorMessage) + "\"}");
  }
}

void handleVerifyLocationRequest() {
  int locationId = server.hasArg("id") ? server.arg("id").toInt() : 0;
  if (locationId != 8 && locationId != 9) {
    sendJsonResponse(400, "{\"ok\":false,\"error\":\"id must be 8 or 9\"}");
    return;
  }
  String errorMessage = "";
  String command = "VERIFY_LOCATION " + String(locationId);
  if (runArduinoCommand(command, "raspberry", "verify_location", errorMessage)) {
    sendJsonResponse(200, "{\"ok\":true,\"verification\":" + lastVerifyJson + "}");
  } else {
    sendJsonResponse(500, "{\"ok\":false,\"error\":\"" + escapeJson(errorMessage) + "\"}");
  }
}

void handleUltraRequest() {
  String errorMessage = "";
  if (runArduinoCommand("ULTRA", "raspberry", "ultra_check", errorMessage)) {
    sendJsonResponse(200, "{\"ok\":true,\"ultra\":" + lastUltraJson + "}");
  } else {
    sendJsonResponse(500, "{\"ok\":false,\"error\":\"" + escapeJson(errorMessage) + "\"}");
  }
}

bool isAllowedHttpCommand(String command) {
  command.toUpperCase();
  return command == "BELT" ||
         command == "STOP" ||
         command == "STATUS" ||
         command == "TESTIR" ||
         command == "ULTRA" ||
         command == "CAMERA" ||
         command == "SCAN" ||
         command == "DISPENSE" ||
         command == "D" ||
         command == "HOME" ||
         command == "START" ||
         command == "BELT_START" ||
         command == "BELT_STOP" ||
         command.startsWith("BELT_RUN_MS ") ||
         command == "DROP_TO_LIFTER" ||
         command.startsWith("VERIFY_LOCATION ");
}

void handleCommandRequest() {
  if (commandRunning) {
    sendJsonResponse(409, "{\"ok\":false,\"error\":\"Lifter is busy\"}");
    return;
  }

  if (!server.hasArg("command")) {
    sendJsonResponse(400, "{\"ok\":false,\"error\":\"Missing command\"}");
    return;
  }

  String command = server.arg("command");
  command.trim();
  command.toUpperCase();
  String source = server.hasArg("source") ? server.arg("source") : "raspberry";

  if (!isAllowedHttpCommand(command)) {
    sendJsonResponse(400, "{\"ok\":false,\"error\":\"Command not allowed\"}");
    return;
  }

  commandRunning = true;
  addActivityLog("command_received", command + " from " + source, source);
  updateDeviceStatus("online", "running_" + command);
  sendCommandToArduino(command);

  String errorMessage = "";
  bool done = waitForArduinoDone(0, errorMessage);
  commandRunning = false;

  if (done) {
    updateDeviceStatus("online", "done_" + command);
    addActivityLog("command_done", command + " done", source);
    sendJsonResponse(200, "{\"ok\":true,\"command\":\"" + escapeJson(command) + "\"}");
  } else {
    updateDeviceStatus("online", "error_" + command);
    addActivityLog("command_error", errorMessage, source);
    sendJsonResponse(500, "{\"ok\":false,\"error\":\"" + escapeJson(errorMessage) + "\"}");
  }
}

void sendJsonResponse(int code, String body) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(code, "application/json", body);
}

// ================= KEYPAD / LCD =================

void setupKeypadLcd() {
  Wire.begin(LCD_SDA, LCD_SCL);
  lcd.init();
  lcd.backlight();
  showBootScreen();
}

void handleKeypad() {
  char key = keypad.getKey();

  if (!key) {
    if (keypadInput.length() == 0 && !keypadAwaitingResponse &&
        lastKeypadActivityAt > 0 && millis() - lastKeypadActivityAt > LCD_MESSAGE_HOLD) {
      showIdleScreen();
      lastKeypadActivityAt = 0;
    }
    return;
  }

  Serial.print("Keypad key: ");
  Serial.println(key);

  if (key >= '0' && key <= '9') {
    handleNumericKey(key);
    return;
  }

  if (key == '#') {
    handleSendKey();
    return;
  }

  if (key == '*') {
    handleClearKey();
    return;
  }

  if (key == 'A') {
    handleAutomationKey(true);
    return;
  }

  if (key == 'B') {
    handleAutomationKey(false);
    return;
  }

  if (key == 'C') {
    handleBeltKey();
    return;
  }

  if (key == 'D') {
    handleHomeKey();
  }
}

void handleNumericKey(char key) {
  if (keypadInput.length() >= 2) {
    showInvalidPosition();
    keypadInput = "";
    return;
  }

  keypadInput += key;
  showTypingScreen();
}

void handleSendKey() {
  if (commandRunning || keypadAwaitingResponse) {
    showBusyScreen();
    return;
  }

  int position = keypadInput.toInt();
  keypadInput = "";

  if (position < 1 || position > 18) {
    showInvalidPosition();
    return;
  }

  String command = "GO " + String(position);
  commandRunning = true;
  keypadAwaitingResponse = true;
  keypadCommandStartedAt = millis();
  sendCommandToArduino(command);
  updateDeviceStatus("online", "keypad_" + command);
  addActivityLog("keypad_go_sent", command, "keypad");
  showSentCommand(command);
}

void handleClearKey() {
  keypadInput = "";
  showIdleScreen();
}

void handleAutomationKey(bool enabled) {
  keypadInput = "";
  patchAutomationEnabled(enabled);
  addActivityLog(enabled ? "keypad_automation_start" : "keypad_automation_stop",
                 enabled ? "Automation START" : "Automation STOP",
                 "keypad");
  showAutomationScreen(enabled);
}

void handleBeltKey() {
  if (commandRunning || keypadAwaitingResponse) {
    showBusyScreen();
    return;
  }

  keypadInput = "";
  commandRunning = true;
  keypadAwaitingResponse = true;
  keypadCommandStartedAt = millis();
  sendCommandToArduino("B");
  updateDeviceStatus("online", "keypad_B");
  addActivityLog("keypad_belt_toggle", "B", "keypad");
  showTwoLineMessage("Belt", "Toggle");
}

void handleHomeKey() {
  if (commandRunning || keypadAwaitingResponse) {
    showBusyScreen();
    return;
  }

  keypadInput = "";
  commandRunning = true;
  keypadAwaitingResponse = true;
  keypadCommandStartedAt = millis();
  sendCommandToArduino("HOME");
  updateDeviceStatus("online", "keypad_HOME");
  addActivityLog("keypad_home", "HOME", "keypad");
  showTwoLineMessage("Command", "HOME");
}

void showBootScreen() {
  showTwoLineMessage("MakhzanXpert", "ESP Ready");
}

void showIdleScreen() {
  showTwoLineMessage("Enter GO 1-18", "*Clr  #Send");
}

void showTypingScreen() {
  showTwoLineMessage("GO Position", keypadInput);
}

void showSentCommand(String command) {
  showTwoLineMessage("Sent Command", command);
}

void showInvalidPosition() {
  showTwoLineMessage("Invalid", "Use 1-18");
}

void showBusyScreen() {
  showTwoLineMessage("Busy", "Wait DONE");
}

void showAutomationScreen(bool enabled) {
  showTwoLineMessage("Automation", enabled ? "START" : "STOP");
}

void showTwoLineMessage(String line1, String line2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(line2.substring(0, 16));
  lastKeypadActivityAt = millis();
}

void updateLcdFromArduinoLine(String line) {
  if (line == "DONE" || line.startsWith("DONE:")) {
    showTwoLineMessage("Success", "DONE");
    keypadAwaitingResponse = false;
    commandRunning = false;
    return;
  }

  if (line.startsWith("ERROR")) {
    String message = line;
    message.replace("ERROR:", "");
    message.replace("ERROR", "");
    message.trim();
    if (message.length() == 0) {
      message = "ERROR";
    }
    showTwoLineMessage("Error", message);
    keypadAwaitingResponse = false;
    commandRunning = false;
  }
}

void checkKeypadCommandTimeout() {
  if (!keypadAwaitingResponse) return;

  if (millis() - keypadCommandStartedAt > ARDUINO_DONE_TIMEOUT) {
    keypadAwaitingResponse = false;
    commandRunning = false;
    showTwoLineMessage("Error", "Timeout");
    updateDeviceStatus("online", "keypad_timeout");
    addActivityLog("keypad_command_timeout", "Arduino timeout waiting for DONE", "keypad");
  }
}

void patchAutomationEnabled(bool enabled) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
               "/databases/(default)/documents/settings/system" +
               "?key=" + API_KEY +
               "&updateMask.fieldPaths=automationEnabled" +
               "&updateMask.fieldPaths=updatedAt";

  http.begin(client, url);
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");

  String body =
    "{"
      "\"fields\":{"
        "\"automationEnabled\":{\"booleanValue\":" + String(enabled ? "true" : "false") + "},"
        "\"updatedAt\":{\"timestampValue\":\"" + getTimestamp() + "\"}"
      "}"
    "}";

  int httpCode = http.PATCH(body);
  Serial.print("Automation setting update: ");
  Serial.println(httpCode);
  http.end();
}

// ================= ARDUINO SERIAL =================

void sendCommandToArduino(String command) {
  Serial2.println(command);
  Serial.print("Sent to Arduino: ");
  Serial.println(command);
}

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
    if (!error) {
      cacheArduinoJson(doc, line);
      sendSensorReading(doc);
    }
    return;
  }

  lastArduinoStatus = line;
  updateLcdFromArduinoLine(line);
}

bool waitForArduinoDone(int position, String &errorMessage) {
  unsigned long startedAt = millis();
  String expectedDone = "DONE:" + String(position);

  while (millis() - startedAt < ARDUINO_DONE_TIMEOUT) {
    if (WiFi.status() != WL_CONNECTED) {
      connectWiFi();
    }

    server.handleClient();

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
          cacheArduinoJson(sensorDoc, line);
          sendSensorReading(sensorDoc);
        }
        continue;
      }

      lastArduinoStatus = line;

      if (line == "DONE" || line == expectedDone || line.startsWith("DONE:") || line.startsWith("OK ")) {
        updateLcdFromArduinoLine(line);
        return true;
      }

      if (line.startsWith("ERROR")) {
        errorMessage = line;
        updateLcdFromArduinoLine(line);
        return false;
      }
    }

    handleKeypad();
    checkKeypadCommandTimeout();
    delay(10);
  }

  errorMessage = "Arduino timeout waiting for DONE";
  return false;
}

bool runArduinoCommand(String command, String source, String activityType, String &errorMessage) {
  if (commandRunning) {
    errorMessage = "Lifter is busy";
    return false;
  }

  commandRunning = true;
  addActivityLog(activityType, command + " from " + source, source);
  updateDeviceStatus("online", "running_" + command);
  sendCommandToArduino(command);
  bool done = waitForArduinoDone(0, errorMessage);
  commandRunning = false;

  if (done) {
    updateDeviceStatus("online", "done_" + command);
    addActivityLog(activityType + "_done", command + " done", source);
  } else {
    updateDeviceStatus("online", "error_" + command);
    addActivityLog(activityType + "_error", errorMessage, source);
  }
  return done;
}

bool automationAllowsMotion(String &errorMessage) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
               "/databases/(default)/documents/automation/status?key=" + API_KEY;

  http.begin(client, url);
  http.setTimeout(6000);
  int httpCode = http.GET();

  if (httpCode == 404) {
    http.end();
    errorMessage = "Waiting for Start Automation";
    return false;
  }

  if (httpCode < 200 || httpCode >= 300) {
    http.end();
    errorMessage = "Unable to read automation/status";
    return false;
  }

  String payload = http.getString();
  http.end();

  DynamicJsonDocument doc(4096);
  DeserializationError parseError = deserializeJson(doc, payload);
  if (parseError) {
    errorMessage = "Invalid automation/status payload";
    return false;
  }

  JsonObject fields = doc["fields"];
  bool automationStarted = fields["automationStarted"]["booleanValue"] | false;
  String sortingStrategy = fields["sortingStrategy"]["stringValue"] | "";
  String currentState = fields["currentState"]["stringValue"] | "";

  bool strategyValid =
    sortingStrategy == "brand" ||
    sortingStrategy == "size" ||
    sortingStrategy == "color" ||
    sortingStrategy == "model" ||
    sortingStrategy == "brand_size" ||
    sortingStrategy == "color_size" ||
    sortingStrategy == "model_size";

  if (!strategyValid) {
    errorMessage = "Waiting for sorting strategy";
    return false;
  }

  if (!automationStarted) {
    errorMessage = "Waiting for Start Automation";
    return false;
  }

  if (currentState == "STOPPED" || currentState == "ERROR") {
    errorMessage = "Automation is " + currentState;
    return false;
  }

  return true;
}

// ================= SENSOR UPLOAD =================

void cacheArduinoJson(DynamicJsonDocument& doc, String line) {
  lastArduinoJson = line;
  lastBelt = doc["belt"] | lastBelt;
  lastX = doc["x"] | lastX;
  lastY = doc["y"] | lastY;
  lastZ = doc["z"] | lastZ;
  lastIrCamera = doc["irCamera"] | lastIrCamera;
  lastIrLifter = doc["irLifter"] | lastIrLifter;
  lastUltrasonicCm = doc["ultrasonicCm"] | lastUltrasonicCm;
  lastUltrasonicReady = doc["ultrasonicReady"] | lastUltrasonicReady;
  lastLoc8Detected = doc["loc8Detected"] | lastLoc8Detected;
  lastLoc9Detected = doc["loc9Detected"] | lastLoc9Detected;
  lastAtStartingPoint = doc["atStartingPoint"] | lastAtStartingPoint;
  lastArduinoBusy = doc["busy"] | lastArduinoBusy;

  if (doc.containsKey("ultrasonicCm") || doc.containsKey("ultrasonicReady")) {
    lastUltraJson = "{";
    lastUltraJson += "\"ultrasonicCm\":" + String(lastUltrasonicCm, 2) + ",";
    lastUltraJson += "\"ultrasonicReady\":" + String(lastUltrasonicReady ? "true" : "false");
    lastUltraJson += "}";
  }

  if (doc.containsKey("locationId") && doc.containsKey("detected")) {
    lastVerifyJson = line;
  }
}

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
        "\"irCamera\":{\"booleanValue\":" + String(lastIrCamera ? "true" : "false") + "},"
        "\"irLifter\":{\"booleanValue\":" + String(lastIrLifter ? "true" : "false") + "},"
        "\"ultrasonicCm\":{\"doubleValue\":" + String(lastUltrasonicCm, 2) + "},"
        "\"ultrasonicReady\":{\"booleanValue\":" + String(lastUltrasonicReady ? "true" : "false") + "},"
        "\"loc8Detected\":{\"booleanValue\":" + String(lastLoc8Detected ? "true" : "false") + "},"
        "\"loc9Detected\":{\"booleanValue\":" + String(lastLoc9Detected ? "true" : "false") + "},"
        "\"atStartingPoint\":{\"booleanValue\":" + String(lastAtStartingPoint ? "true" : "false") + "},"
        "\"busy\":{\"booleanValue\":" + String(lastArduinoBusy ? "true" : "false") + "},"
        "\"createdAt\":{\"timestampValue\":\"" + getTimestamp() + "\"}"
      "}"
    "}";

  int httpCode = http.POST(body);
  Serial.print("Firestore sensor: ");
  Serial.println(httpCode);
  http.end();
}

// ================= FIREBASE STATUS / ACTIVITY =================

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
        "\"irCamera\":{\"booleanValue\":" + String(lastIrCamera ? "true" : "false") + "},"
        "\"irLifter\":{\"booleanValue\":" + String(lastIrLifter ? "true" : "false") + "},"
        "\"ultrasonicCm\":{\"doubleValue\":" + String(lastUltrasonicCm, 2) + "},"
        "\"ultrasonicReady\":{\"booleanValue\":" + String(lastUltrasonicReady ? "true" : "false") + "},"
        "\"loc8Detected\":{\"booleanValue\":" + String(lastLoc8Detected ? "true" : "false") + "},"
        "\"loc9Detected\":{\"booleanValue\":" + String(lastLoc9Detected ? "true" : "false") + "},"
        "\"atStartingPoint\":{\"booleanValue\":" + String(lastAtStartingPoint ? "true" : "false") + "},"
        "\"busy\":{\"booleanValue\":" + String(lastArduinoBusy ? "true" : "false") + "},"
        "\"lastSeen\":{\"timestampValue\":\"" + getTimestamp() + "\"}"
      "}"
    "}";

  int httpCode = http.PATCH(body);
  Serial.print("Device update: ");
  Serial.println(httpCode);
  http.end();
}

void addActivityLog(String activityType, String message, String source) {
  WiFiClientSecure client;
  client.setInsecure();

  String body =
    "{"
      "\"fields\":{"
        "\"type\":{\"stringValue\":\"" + escapeJson(activityType) + "\"},"
        "\"activityType\":{\"stringValue\":\"" + escapeJson(activityType) + "\"},"
        "\"message\":{\"stringValue\":\"" + escapeJson(message) + "\"},"
        "\"source\":{\"stringValue\":\"" + escapeJson(source) + "\"},"
        "\"sourceDevice\":{\"stringValue\":\"" + DEVICE_ID + "\"},"
        "\"status\":{\"stringValue\":\"info\"},"
        "\"createdAt\":{\"timestampValue\":\"" + getTimestamp() + "\"}"
      "}"
    "}";

  postActivityDocument(client, "activityLog", body);
  postActivityDocument(client, "systemActivity", body);
}

void postActivityDocument(WiFiClientSecure &client, String collectionName, String body) {
  HTTPClient http;
  String url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
               "/databases/(default)/documents/" + collectionName + "?key=" + API_KEY;

  http.begin(client, url);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");

  int httpCode = http.POST(body);
  Serial.print("Activity add ");
  Serial.print(collectionName);
  Serial.print(": ");
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

String escapeJson(String value) {
  value.replace("\\", "\\\\");
  value.replace("\"", "\\\"");
  value.replace("\n", "\\n");
  value.replace("\r", "\\r");
  return value;
}
