import os
import sys
import psutil
import socket
import time
import requests
from datetime import datetime

def check_backend_process():
    print("--- Checking Backend Process ---")
    backend_pids = []
    for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
        try:
            cmdline = proc.info.get('cmdline') or []
            if any('uvicorn' in arg for arg in cmdline) or any('main:app' in arg for arg in cmdline):
                backend_pids.append(proc.info['pid'])
                print(f"Found Backend Process: PID {proc.info['pid']} - {proc.info['name']}")
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    
    if not backend_pids:
        print("ERROR: No backend process (uvicorn/main:app) found.")
    return backend_pids

def check_ports():
    print("\n--- Checking Port 8000 ---")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    result = sock.connect_ex(('127.0.0.1', 8000))
    if result == 0:
        print("Port 8000 is OPEN and reachable.")
    else:
        print(f"ERROR: Port 8000 is CLOSED (Error code: {result}).")
    sock.close()

def check_shm_memory():
    # On Windows, shared memory is typically handled via paging file / memory mapping
    # This check is more generic for resource usage
    print("\n--- Checking System Memory Usage ---")
    mem = psutil.virtual_memory()
    print(f"Total: {mem.total / (1024**3):.2f} GB")
    print(f"Available: {mem.available / (1024**3):.2f} GB")
    print(f"Percent: {mem.percent}%")

def check_python_dependencies():
    print("\n--- Checking Key Dependencies ---")
    dependencies = ['fastapi', 'uvicorn', 'numpy', 'websockets', 'paho.mqtt']
    for dep in dependencies:
        try:
            __import__(dep.replace('.mqtt', '.mqtt.client'))
            print(f"Dependency '{dep}': OK")
        except ImportError:
            print(f"ERROR: Dependency '{dep}' is MISSING.")

def trace_errors():
    # Simple check for any error logs in current directory
    print("\n--- Searching for Error Logs ---")
    found = False
    for root, dirs, files in os.walk('.'):
        for file in files:
            if 'error' in file.lower() or 'log' in file.lower():
                print(f"Found potential log file: {os.path.join(root, file)}")
                found = True
    if not found:
        print("No specific log files found in current directory.")

if __name__ == "__main__":
    print(f"SHM Diagnostic Tool - {datetime.now()}")
    print("="*40)
    check_backend_process()
    check_ports()
    check_shm_memory()
    check_python_dependencies()
    trace_errors()
    print("="*40)
    print("Diagnostic complete.")
