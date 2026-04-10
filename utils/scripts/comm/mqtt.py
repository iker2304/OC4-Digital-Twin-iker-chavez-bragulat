import paho.mqtt.client as mqtt
import json 

class MqttClient:
    def __init__(self, broker, port, topic, on_message_callback=None):
        self.broker = broker 
        self.port = port
        self.topic = topic
        self.on_message_callback = on_message_callback
        
        self.client = mqtt.Client()
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message
        
        print(f"Connecting to MQTT broker at {self.broker}:{self.port}...")
        self.client.connect(self.broker, self.port, 60)
        self.client.loop_start()

    def on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            print(f"Connected successfully to {self.broker}")
            self.client.subscribe(self.topic)
            print(f"Subscribed to topic: {self.topic}")
        else:
            print(f"Connection failed with code {rc}")

    def on_message(self, client, userdata, msg):
        payload = msg.payload.decode()
        if self.on_message_callback:
            try:
                data = json.loads(payload)
                self.on_message_callback(data)
            except Exception as e:
                print(f"Error in MQTT callback: {e}")
        else:
            print(f"Message received on {msg.topic}: {payload}")

    def publish(self, payload, topic=None):
        target_topic = topic if topic else self.topic
        self.client.publish(target_topic, json.dumps(payload))

    def disconnect(self):
        self.client.loop_stop()
        self.client.disconnect()

if __name__ == "__main__":
    mqtt_client = MqttClient("localhost", 1883, "test")
    mqtt_client.publish({"message": "Hello from MqttClient"})
    import time
    time.sleep(1)
    mqtt_client.disconnect()