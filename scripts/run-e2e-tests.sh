#!/bin/bash

# E2E Test Runner for SyncSpeaker Prototype
# This script runs the comprehensive E2E test suite and generates a report

set -e

echo "=========================================="
echo "SyncSpeaker E2E Test Suite"
echo "=========================================="
echo ""

# Check if Playwright is installed
if ! command -v npx &> /dev/null; then
    echo "❌ Error: npx not found. Please install Node.js and npm."
    exit 1
fi

# Check if dependencies are installed
if [ ! -d "node_modules/@playwright" ]; then
    echo "⚠️  Playwright not found. Installing dependencies..."
    npm install
fi

# Check if Playwright browsers are installed
if [ ! -d "$HOME/.cache/ms-playwright/chromium"* ]; then
    echo "⚠️  Playwright browsers not found. Installing Chromium..."
    npx playwright install chromium
fi

echo "✓ Prerequisites check passed"
echo ""

# Run the tests
echo "=========================================="
echo "Running E2E Tests"
echo "=========================================="
echo ""

# Set test mode
export NODE_ENV=test

# Run tests
if [ "$1" == "--headed" ]; then
    echo "Running in headed mode (visible browser)..."
    npm run test:e2e:headed
elif [ "$1" == "--ui" ]; then
    echo "Running in UI mode (interactive)..."
    npm run test:e2e:ui
else
    echo "Running in headless mode..."
    npm run test:e2e
fi

# Check exit code
EXIT_CODE=$?

echo ""
echo "=========================================="
echo "Test Results"
echo "=========================================="
echo ""

if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ All tests passed!"
else
    echo "❌ Some tests failed (exit code: $EXIT_CODE)"
    echo ""
    echo "To view detailed results:"
    echo "  npm run test:e2e:report"
    echo ""
    echo "To debug failures:"
    echo "  npm run test:e2e:headed    # Run with visible browser"
    echo "  npm run test:e2e:ui        # Run with interactive UI"
fi

echo ""
echo "Test artifacts:"
echo "  - HTML Report: playwright-report/"
echo "  - Screenshots: test-results/"
echo "  - Videos: test-results/"
echo ""

exit $EXIT_CODE
