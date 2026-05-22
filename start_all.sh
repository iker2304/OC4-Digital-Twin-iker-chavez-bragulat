#!/bin/bash

# Color codes for output
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color

echo -e "${CYAN}Starting OC4 Digital Twin System...${NC}"

# 1. Check and Start Docker
echo -e "${CYAN}Checking Docker status...${NC}"
if ! docker info > /dev/null 2>&1; then
    echo -e "${YELLOW}Docker is not running. Attempting to start Docker Desktop...${NC}"
    open -a Docker
    echo -e "${YELLOW}Docker Desktop launching... waiting for it to be ready (this may take a minute)...${NC}"
    
    # Wait loop with timeout
    retries=0
    while [ $retries -lt 60 ]; do
        sleep 2
        if docker info > /dev/null 2>&1; then
            echo ""
            echo -e "${GREEN}Docker is ready!${NC}"
            break
        fi
        echo -n "."
        retries=$((retries + 1))
    done
    
    if [ $retries -ge 60 ]; then
        echo ""
        echo -e "${RED}Failed to connect to Docker daemon. Please ensure Docker Desktop is running.${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}Docker is ready!${NC}"
fi

# 2. Start Infrastructure (Backend, Frontend, MQTT, DBs)
echo -e "${CYAN}Starting Infrastructure (Web, Backend, MQTT, InfluxDB)...${NC}"
echo -e "${YELLOW}Building Docker images to ensure latest code is running...${NC}"
docker compose up -d --build

if [ $? -ne 0 ]; then
    echo -e "${RED}Error starting Docker services.${NC}"
    exit 1
fi

echo -e "${GREEN}Infrastructure is UP.${NC}"
echo " - Web Dashboard: http://localhost:5173"
echo " - Grafana: http://localhost:3000"
echo " - Backend API: http://localhost:8080"
echo " - Video Feed: http://localhost:8001/video_feed"

# Ensure we are in the right directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Check for venv and activate
if [ -f ".venv/bin/activate" ]; then
    echo -e "${CYAN}Activating virtual environment...${NC}"
    source .venv/bin/activate
elif [ -f "backend/venv/bin/activate" ]; then
    echo -e "${CYAN}Activating virtual environment (backend/venv)...${NC}"
    source backend/venv/bin/activate
else
    echo -e "${YELLOW}Warning: Virtual environment not found.${NC}"
fi

export PYTHONPATH="$SCRIPT_DIR"

# 3. Start FEM Modal Analysis script in the background
echo -e "${CYAN}Starting FEM Modal Analysis Script...${NC}"
FEM_DIR="$SCRIPT_DIR/utils/scripts/postprocess/FEM_Modal_Analysis"
if [ -f "$FEM_DIR/signal_processing.py" ]; then
    (cd "$FEM_DIR" && PYTHONPATH="$SCRIPT_DIR" python signal_processing.py) &
    FEM_PID=$!
    echo -e "${GREEN}FEM Modal Analysis started in a separate window.${NC}"
else
    echo -e "${YELLOW}Warning: FEM Modal Analysis script not found.${NC}"
    FEM_PID=""
fi

# Trap Ctrl+C to also kill the background FEM process
cleanup() {
    echo -e "${CYAN}Stopping...${NC}"
    if [ -n "$FEM_PID" ]; then
        kill $FEM_PID 2>/dev/null
    fi
    exit 0
}

trap cleanup INT TERM

# 4. Start Detection Script
echo -e "${CYAN}Starting Pose Detection Script (Press Ctrl+C to stop)...${NC}"
echo -e "${GRAY}NOTE: This script runs locally to access your Webcam.${NC}"

python utils/scripts/detection/pose_detection.py

# Clean up FEM process when detection exits
if [ -n "$FEM_PID" ]; then
    kill $FEM_PID 2>/dev/null
fi
