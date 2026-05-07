# start_all.ps1 - Script to start the entire OC4 Digital Twin System

Write-Host "Starting OC4 Digital Twin System..." -ForegroundColor Cyan

# 1. Check and Start Docker Desktop
Write-Host "Checking Docker status..."
$dockerRunning = $false
try {
    docker info > $null 2>&1
    if ($LASTEXITCODE -eq 0) {
        $dockerRunning = $true
    }
} catch {
    $dockerRunning = $false
}

if (-not $dockerRunning) {
    Write-Host "Docker is not running. Attempting to start Docker Desktop..." -ForegroundColor Yellow
    
    $dockerPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerPath) {
        Start-Process -FilePath $dockerPath
        Write-Host "Docker Desktop launching... waiting for it to be ready (this may take a minute)..."
        
        # Wait loop
        $retries = 0
        while ($retries -lt 60) {
            Start-Sleep -Seconds 2
            try {
                docker info > $null 2>&1
                if ($LASTEXITCODE -eq 0) {
                    $dockerRunning = $true
                    Write-Host "Docker is ready!" -ForegroundColor Green
                    break
                }
            } catch {}
            Write-Host "." -NoNewline
            $retries++
        }
        Write-Host ""
    } else {
        Write-Host "Error: Could not find Docker Desktop at default location. Please start it manually." -ForegroundColor Red
        exit 1
    }
}

if (-not $dockerRunning) {
    Write-Host "Failed to connect to Docker daemon. Please ensure Docker Desktop is running." -ForegroundColor Red
    exit 1
}

# 2. Start Infrastructure (Backend, Frontend, MQTT, DBs)
Write-Host "Starting Infrastructure (Web, Backend, MQTT, InfluxDB)..." -ForegroundColor Cyan
Write-Host "Building Docker images to ensure latest code is running..." -ForegroundColor Yellow
docker compose up -d --build

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error starting Docker services." -ForegroundColor Red
    exit 1
}

Write-Host "Infrastructure is UP." -ForegroundColor Green
Write-Host " - Web Dashboard: http://localhost:5173"
Write-Host " - Grafana: http://localhost:3000"
Write-Host " - Backend API: http://localhost:8080"
Write-Host " - Video Feed: http://localhost:8001/video_feed"

# Ensure we are in the right directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# Check for venv and activate
if (Test-Path ".venv\Scripts\Activate.ps1") {
    Write-Host "Activating virtual environment..."
    & .\.venv\Scripts\Activate.ps1
}

$env:PYTHONPATH = $PWD

# 3. Start FEM Modal Analysis script in a separate window (background)
Write-Host "Starting FEM Modal Analysis Script..." -ForegroundColor Cyan
$femDir = Join-Path $ScriptDir "utils\scripts\postprocess\FEM_Modal_Analysis"
$pythonExe = if (Test-Path ".venv\Scripts\python.exe") { Join-Path $ScriptDir ".venv\Scripts\python.exe" } else { "python" }
Start-Process -FilePath "powershell.exe" -ArgumentList `
    "-NoExit", "-Command",
    "`$env:PYTHONPATH='$ScriptDir'; Set-Location '$femDir'; & '$pythonExe' signal_processing.py" `
    -WindowStyle Normal
Write-Host "FEM Modal Analysis started in a separate window." -ForegroundColor Green

# 4. Start Detection Script (Runs locally to access Webcam)
Write-Host "Starting Pose Detection Script (Press Ctrl+C to stop)..." -ForegroundColor Cyan
Write-Host "NOTE: This script runs locally to access your Webcam." -ForegroundColor Gray

python utils/scripts/detection/pose_detection.py
