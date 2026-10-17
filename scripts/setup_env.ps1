# PowerShell Environment Setup Script for Windows
$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $PSScriptRoot

Write-Host "=== [Mizaj Studio] Setting up Windows Environment in: $RootDir ===" -ForegroundColor Cyan

if (Test-Path "$RootDir\backend") {
    Write-Host "-> Configuring Python backend virtual environment..."
    Push-Location "$RootDir\backend"
    try {
        python -m venv .venv
        & "$RootDir\backend\.venv\Scripts\pip.exe" install --upgrade pip
        if (Test-Path "requirements.txt") {
            & "$RootDir\backend\.venv\Scripts\pip.exe" install -r requirements.txt
        }
        & "$RootDir\backend\.venv\Scripts\python.exe" "$RootDir\scripts\download_models.py" --verify-or-mock
    } finally {
        Pop-Location
    }
}

if (Test-Path "$RootDir\desktop") {
    Write-Host "-> Installing Desktop frontend dependencies..."
    Push-Location "$RootDir\desktop"
    try {
        npm install
    } finally {
        Pop-Location
    }
}

Write-Host "=== [Mizaj Studio] Windows Setup Complete Successfully ===" -ForegroundColor Green
