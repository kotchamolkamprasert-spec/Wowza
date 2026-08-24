void setup() { 
  pinMode(3 ,OUTPUT) ;
  pinMode(6 ,OUTPUT);
  pinMode(9 ,OUTPUT);

}

void loop() {
  digitalWrite(3,HIGH) ;
  delay(500) ;
  digitalWrite(3,LOW) ; 
  delay(500) ;
  
  digitalWrite(6,HIGH) ;
  delay(500) ;
  digitalWrite(6,LOW) ;
  delay(500);
  
  digitalWrite(9,HIGH); 
  delay(500) ;
  digitalWrite(9,LOW); 
  delay(500);
 

}

