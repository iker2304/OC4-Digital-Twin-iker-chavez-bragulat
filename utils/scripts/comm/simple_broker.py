import asyncio
import os
from amqtt.broker import Broker

config = {
    'listeners': {
        'default': {
            'type': 'tcp',
            'bind': '0.0.0.0:1883',
        },
        'ws': {
            'type': 'ws',
            'bind': '0.0.0.0:9001',
        }
    },
    'sys_interval': 10,
    'auth': {
        'allow-anonymous': True,
        'password-file': '',
        'plugins': ['auth.anonymous'],
    }
}

async def start_broker():
    broker = Broker(config)
    await broker.start()
    print("Python MQTT Broker started on ports 1883 (TCP) and 9001 (WS)")
    while True:
        await asyncio.sleep(1)

if __name__ == '__main__':
    # Fix for Windows loop policy
    if os.name == 'nt':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    
    try:
        loop = asyncio.get_event_loop()
        loop.run_until_complete(start_broker())
    except KeyboardInterrupt:
        print("Broker stopped")
