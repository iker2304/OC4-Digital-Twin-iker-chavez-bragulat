# OC4 Digital Twin Backend

This is the backend service for the OC4 Digital Twin project. It uses FastAPI to provide a REST API and WebSocket connection for real-time data streaming.

## Features
- **Video Streaming**: `/video` endpoint streams live video from the connected camera.
- **Real-time Telemetry**: `/ws/realtime` WebSocket endpoint provides simulated (or real) telemetry data (roll, pitch, yaw, position, forces, etc.).
- **Detection Integration**: Uses Hydra for configuration and OpenCV for video processing.

## Installation

1. Create a virtual environment:
   ```bash
   python -m venv .venv
   .venv\Scripts\activate
   ```
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## Running the Server

Run the following command from the `backend` directory:

```bash
uvicorn app.main:app --reload
```

The server will start at `http://localhost:8000`.

- API Documentation: `http://localhost:8000/docs`
- Video Stream: `http://localhost:8000/video`
- WebSocket: `ws://localhost:8000/ws/realtime`

## Configuration
Configuration files are located in `../utils/scripts/detection/config`.
