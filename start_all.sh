#!/bin/bash

echo "Starting OC4 Digital Twin System..."

# 1. Check Docker
if ! docker info > /dev/null 2>&1; then
    echo "Docker is not running. Attempting to start Docker..."
    open -a Docker
    echo "Waiting for Docker to start..."
    while ! docker info > /dev/null 2>&1; do
        sleep 2
        echo -n "."
    done
    echo ""
    echo "Docker is ready!"
fi

# 2. Start Infrastructure
echo "Starting Infrastructure (Web, Backend, MQTT, InfluxDB)..."
echo "Building Docker images..."
docker compose up -d --build

if [ $? -ne 0 ]; then
    echo "Error starting Docker services."
    exit 1
fi

echo "Infrastructure is UP."
echo " - Web Dashboard: http://localhost:5173"
echo " - Grafana: http://localhost:3000"
echo " - Backend API: http://localhost:8080"
echo " - Video Feed: http://localhost:8001/video_feed"

# 3. Start Detection Script
echo "Starting Pose Detection Script (Press Ctrl+C to stop)..."
echo "NOTE: This script runs locally to access your Webcam."

# Activate venv
if [ -f ".venv/bin/activate" ]; then
    echo "Activating virtual environment (.venv)..."
    source .venv/bin/activate
elif [ -f "backend/venv/bin/activate" ]; then
    echo "Activating virtual environment (backend/venv)..."
    source backend/venv/bin/activate
else
    echo "Warning: Virtual environment not found."
fi

export PYTHONPATH=$(pwd)
python utils/scripts/detection/pose_detection.py
