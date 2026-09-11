
void setup() {
  Serial.begin(9600);
  pinMode(3, OUTPUT);
  pinMode(6, OUTPUT);
  pinMode(9, OUTPUT);

}

void loop() {
  digitalWrite(3, HIGH);
  delay(100);
  digitalWrite(3, LOW);
  delay(100);
  digitalWrite(6, HIGH);
  delay(100);
  digitalWrite(6, LOW);
  delay(100);
  digitalWrite(9, HIGH);
  delay(100);
  digitalWrite(9, LOW);
  delay(100);

}