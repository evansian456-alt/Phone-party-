#!/bin/bash
#
# Automated PR Conflict Resolution Script
# This script resolves conflicts in PR #28 and PR #26 by merging main into them
#

set -e  # Exit on error

echo "========================================="
echo "PR Conflict Resolution Script"
echo "========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to resolve PR #28
resolve_pr28() {
  echo -e "${BLUE}Resolving PR #28: Add real-time playback timers and consistent event naming${NC}"
  
  # Fetch and checkout PR #28 branch
  git fetch origin copilot/add-timers-and-event-names
  git checkout copilot/add-timers-and-event-names
  
  # Fetch main branch
  git fetch origin main
  
  # Merge main into PR branch with theirs strategy (prefer main for conflicts)
  echo "Merging main into PR #28 branch..."
  git merge origin/main -X theirs --allow-unrelated-histories -m "Merge main into PR #28 to resolve conflicts"
  
  # Add EVENT constants from PR #28 (critical integration point)
  echo "Adding EVENT constants from PR #28..."
  sed -i '3 a\\n// Event name constants matching server (from PR #28)\nconst EVENT = {\n  // Party lifecycle\n  PARTY_CREATED: "PARTY_CREATED",\n  GUEST_JOINED: "GUEST_JOINED",\n  GUEST_LEFT: "GUEST_LEFT",\n  PARTY_ENDED: "PARTY_ENDED",\n  // Track management\n  TRACK_CURRENT_SELECTED: "TRACK_CURRENT_SELECTED",\n  TRACK_NEXT_QUEUED: "TRACK_NEXT_QUEUED",\n  TRACK_NEXT_CLEARED: "TRACK_NEXT_CLEARED",\n  TRACK_SWITCHED: "TRACK_SWITCHED",\n  TRACK_ENDED: "TRACK_ENDED",\n  // Playback control\n  PLAYBACK_PLAY: "PLAYBACK_PLAY",\n  PLAYBACK_PAUSE: "PLAYBACK_PAUSE",\n  PLAYBACK_TICK: "PLAYBACK_TICK",\n  // Visuals\n  VISUALS_MODE: "VISUALS_MODE",\n  VISUALS_FLASH: "VISUALS_FLASH"\n};\n' app.js
  
  git add app.js
  git commit -m "Add EVENT constants from PR #28 for event naming consistency"
  
  # Push resolved branch
  echo "Pushing resolved PR #28 branch..."
  git push origin copilot/add-timers-and-event-names
  
  echo -e "${GREEN}✓ PR #28 conflicts resolved and pushed${NC}"
  echo ""
}

# Function to resolve PR #26
resolve_pr26() {
  echo -e "${BLUE}Resolving PR #26: Add upgrade flows: Party Pass + Pro Monthly${NC}"
  
  # Fetch and checkout PR #26 branch
  git fetch origin copilot/implement-upgrade-ux-flows
  git checkout copilot/implement-upgrade-ux-flows
  
  # Fetch main branch
  git fetch origin main
  
  # Merge main into PR branch with theirs strategy
  echo "Merging main into PR #26 branch..."
  git merge origin/main -X theirs --allow-unrelated-histories -m "Merge main into PR #26 to resolve conflicts"
  
  # Push resolved branch
  echo "Pushing resolved PR #26 branch..."
  git push origin copilot/implement-upgrade-ux-flows
  
  echo -e "${GREEN}✓ PR #26 conflicts resolved and pushed${NC}"
  echo ""
}

# Main execution
echo "This script will resolve conflicts in PR #28 and PR #26"
echo "by merging the main branch into them."
echo ""

# Resolve PR #28
resolve_pr28

# Resolve PR #26  
resolve_pr26

echo -e "${GREEN}========================================="
echo "All PR conflicts resolved successfully!"
echo "=========================================${NC}"
echo ""
echo "Next steps:"
echo "1. Go to GitHub and verify PR #28 and PR #26 are now mergeable"
echo "2. Review the changes in each PR"
echo "3. Merge the PRs if everything looks good"
